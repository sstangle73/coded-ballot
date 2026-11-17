// A local demo for trying the pages by hand: the Node target on http://localhost:8787 with a throwaway SQLite
// database, the example election open for voting now, and every code printed. Email goes to /api/dev/outbox.
//
//   npm run demo                         (from the repository root: builds the pages, then runs this)
//   DEMO_CLOSE_MINUTES=5 npm run demo    (voting closes after 5 minutes, to try the count)
//
// Demo-only routes, which a real server doesn't have:
//   /demo/sign-in/issuer, /demo/sign-in/teller   sign in as that person (a software passkey on the server)
//   POST /demo/close                             the issuer's signed close, once the closing time has passed
//   /demo/files/...                              the demo folder: ballot PDFs and their layout
//
// Never use this for a real election: it prints codes and keeps the count key's private half on disk.
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeStatement, codeHash, countKeyToText, deriveCode, deriveIssuerKeys, describeStyle, formatCode, layoutBallot, loadRules, newCountKey, signClose, toBase64, type Member } from '@coded-ballot/core';
import { makePacket } from '../../issuer/src/issuer.ts';
import { createApp } from '../src/app.ts';
import { DiskBlobs, SqliteDb } from '../src/db/sqlite.ts';
import { MemoryMailer } from '../src/mail/types.ts';
import { SoftAuthenticator } from '../test/soft-authenticator.ts';
import { parseHeadersFile } from '../src/static-headers.ts';

const PORT = Number(process.env.PORT ?? 8787);
const ORIGIN = `http://localhost:${PORT}`;
const PASS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const E = 'agm-2027';
const dir = mkdtempSync(join(tmpdir(), 'coded-ballot-demo-'));
const CLOSE_HOURS = process.env.DEMO_CLOSE_MINUTES ? Number(process.env.DEMO_CLOSE_MINUTES) / 60 : 72;
const iso = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const rules = readFileSync(new URL('../../../examples/rules.example.yaml', import.meta.url), 'utf8')
  .replace(/notice: .*/, `notice: ${iso(-48)}`)
  .replace(/ballots_out: .*/, `ballots_out: ${iso(-24)}`)
  .replace(/voting_opens: .*/, `voting_opens: ${iso(-1)}`)
  .replace(/voting_closes: .*/, `voting_closes: ${iso(CLOSE_HOURS)}`)
  .replace(/meeting: .*/, `meeting: ${iso(CLOSE_HOURS)}`);

const db = new SqliteDb(join(dir, 'demo.sqlite'));
await db.migrate(fileURLToPath(new URL('../migrations', import.meta.url)));
const mailer = new MemoryMailer();
const deps = {
  db,
  blobs: new DiskBlobs(join(dir, 'blobs')),
  mailer,
  config: { publicOrigin: ORIGIN, rpId: 'localhost', rpName: 'coded-ballot demo', projectOrigins: [], votingPageUrl: `${ORIGIN}/vote/`, setupToken: 'demo', devOutbox: true },
  now: () => new Date(),
};
const app = createApp(deps);
const people: Record<string, SoftAuthenticator> = {};
app.get('/demo/sign-in/:who', async (c) => {
  const auth = people[c.req.param('who')];
  if (!auth) return c.text('issuer or teller', 404);
  const o = await call('POST', '/api/auth/login/options', {});
  const v = await call('POST', '/api/auth/login/verify', { challengeId: o.json.challengeId, response: auth.login(o.json.options, ORIGIN) });
  c.header('set-cookie', `${v.cookie}; Path=/; HttpOnly; SameSite=Strict`);
  return c.redirect('/teller/');
});
app.post('/demo/close', async (c) => {
  const prep = await call('GET', `/api/staff/e/${E}/close/prepare`, undefined, issuerCookie);
  const signed = await signClose(keys, { ...closeStatement(E, new Date(), []), lockedVotes: prep.json });
  await call('POST', `/api/staff/e/${E}/close`, signed, issuerCookie);
  return c.json({ closed: true, lockedVotes: prep.json.count });
});
app.use('/demo/files/*', serveStatic({ root: dir, rewriteRequestPath: (p) => p.replace(/^\/demo\/files/, '') }));
const pageHeaders = parseHeadersFile(readFileSync(new URL('../../web/dist/_headers', import.meta.url), 'utf8'));
app.use('/*', async (c, next) => {
  await next();
  if (!c.req.path.startsWith('/api/') && !c.req.path.startsWith('/demo/')) for (const [k, v] of Object.entries(pageHeaders)) c.res.headers.set(k, v);
});
app.use('/*', serveStatic({ root: fileURLToPath(new URL('../../web/dist', import.meta.url)) }));
const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return { json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
const enroll = async (invite: string, who: string) => {
  const auth = new SoftAuthenticator();
  people[who] = auth;
  const o = await call('POST', '/api/auth/register/options', { invite });
  const v = await call('POST', '/api/auth/register/verify', { invite, challengeId: o.json.challengeId, response: auth.register(o.json.options, ORIGIN) });
  return v.cookie!;
};

const b = await call('POST', '/api/auth/bootstrap', { setupToken: 'demo', name: 'Demo Issuer', email: 'issuer@example.org' });
const issuer = await enroll(b.json.invite, 'issuer');
const issuerCookie = issuer;
await call('POST', '/api/auth/invite', { name: 'Demo Teller', email: 'teller@example.org', roles: ['teller'] }, issuer);
const teller = await enroll(mailer.sent.at(-1)!.text.match(/#invite=([\w-]+)/)![1]!, 'teller');
await call('POST', '/api/staff/elections', { rulesYaml: rules }, issuer);
const members = ['M001', 'M002', 'M003', 'M004', 'M005', 'M006'];
await call('POST', `/api/staff/e/${E}/roll`, { members: members.map((m) => ({ memberId: m, email: `${m.toLowerCase()}@example.org` })), rollSha256: 'a'.repeat(64), frozenAt: iso(-48) }, issuer);
const keys = await deriveIssuerKeys(PASS, E);
const codes = members.map((m) => deriveCode(keys, m, 1));
await call('POST', `/api/staff/e/${E}/codes`, { issuerPublicKey: toBase64(keys.signPublicKey), codes: codes.map((c) => ({ hash: codeHash(E, c), styleId: 'full' })) }, issuer);
await call('POST', `/api/staff/e/${E}/passphrase-backup`, undefined, issuer);
const ck = await newCountKey();
writeFileSync(join(dir, 'count-key.txt'), countKeyToText(ck.privateKey) + '\n');
const fp = await call('POST', `/api/staff/e/${E}/count-key`, { publicKey: toBase64(ck.publicKey) }, teller);
await call('POST', `/api/staff/e/${E}/count-key/confirm`, undefined, teller);
await call('POST', `/api/staff/e/${E}/open`, undefined, teller);

// Printable ballots for M002-M005, made by the issuer tool's own code, and the layout of each sheet for marking them.
mkdirSync(join(dir, 'ballots'), { recursive: true });
const { rules: parsed } = loadRules(rules);
const info = { votingPage: `${ORIGIN}/vote/`, tracker: `${ORIGIN}/public/`, countKeyFingerprint: fp.json.fingerprint, returnAddress: [] };
for (const [i, m] of members.entries()) {
  if (i === 0 || i > 4) continue;
  const member: Member = { memberId: m, classId: 'full', name: '', email: null, fields: {} };
  const { packet } = await makePacket(parsed, keys, member, 1, info, i + 1);
  writeFileSync(join(dir, 'ballots', `${m}.pdf`), packet.ballotOnly);
}
writeFileSync(join(dir, 'ballots', 'layout-full.json'), JSON.stringify(layoutBallot(parsed, describeStyle(parsed, 'full'), { countKeyFingerprint: null })));

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
  console.log(`coded-ballot demo on ${ORIGIN} (data in ${dir})`);
  console.log(`Voting page:  ${ORIGIN}/vote/#s=${encodeURIComponent(ORIGIN)}&e=${E}`);
  console.log(`Public page:  ${ORIGIN}/public/#s=${encodeURIComponent(ORIGIN)}&e=${E}`);
  console.log(`Email outbox: ${ORIGIN}/api/dev/outbox`);
  console.log(`Count key fingerprint: ${fp.json.fingerprint}; private half in ${join(dir, 'count-key.txt')}`);
  console.log(`Tellers' app: ${ORIGIN}/demo/sign-in/teller (or /demo/sign-in/issuer)`);
  console.log(`Voting closes ${iso(CLOSE_HOURS)}; then POST ${ORIGIN}/demo/close for the issuer's signed close.`);
  console.log(`Ballot PDFs for M002-M005: ${join(dir, 'ballots')}`);
  for (const [i, m] of members.entries()) console.log(`  ${m}  ${m.toLowerCase()}@example.org  ${formatCode(codes[i]!)}`);
});
