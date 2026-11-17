// A local demo for trying the pages by hand: the Node target on http://localhost:8787 with a throwaway SQLite
// database, the example election open for voting now, and every code printed. Email goes to /api/dev/outbox.
//
//   npm run build -w @coded-ballot/web && node packages/server/scripts/demo.ts
//
// Never use this for a real election: it prints codes and keeps the count key's private half on disk.
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeHash, countKeyToText, deriveCode, deriveIssuerKeys, formatCode, newCountKey, toBase64 } from '@coded-ballot/core';
import { createApp } from '../src/app.ts';
import { DiskBlobs, SqliteDb } from '../src/db/sqlite.ts';
import { MemoryMailer } from '../src/mail/types.ts';
import { SoftAuthenticator } from '../test/soft-authenticator.ts';

const PORT = Number(process.env.PORT ?? 8787);
const ORIGIN = `http://localhost:${PORT}`;
const PASS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const E = 'agm-2027';
const dir = mkdtempSync(join(tmpdir(), 'coded-ballot-demo-'));
const iso = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const rules = readFileSync(new URL('../../../examples/rules.example.yaml', import.meta.url), 'utf8')
  .replace(/notice: .*/, `notice: ${iso(-48)}`)
  .replace(/ballots_out: .*/, `ballots_out: ${iso(-24)}`)
  .replace(/voting_opens: .*/, `voting_opens: ${iso(-1)}`)
  .replace(/voting_closes: .*/, `voting_closes: ${iso(Number(process.env.DEMO_HOURS ?? 72))}`)
  .replace(/meeting: .*/, `meeting: ${iso(Number(process.env.DEMO_HOURS ?? 72))}`);

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
app.use('/*', serveStatic({ root: fileURLToPath(new URL('../../web/dist', import.meta.url)) }));
const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return { json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
const enroll = async (invite: string) => {
  const auth = new SoftAuthenticator();
  const o = await call('POST', '/api/auth/register/options', { invite });
  const v = await call('POST', '/api/auth/register/verify', { invite, challengeId: o.json.challengeId, response: auth.register(o.json.options, ORIGIN) });
  return v.cookie!;
};

const b = await call('POST', '/api/auth/bootstrap', { setupToken: 'demo', name: 'Demo Issuer', email: 'issuer@example.org' });
const issuer = await enroll(b.json.invite);
await call('POST', '/api/auth/invite', { name: 'Demo Teller', email: 'teller@example.org', roles: ['teller'] }, issuer);
const teller = await enroll(mailer.sent.at(-1)!.text.match(/#invite=([\w-]+)/)![1]!);
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

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
  console.log(`coded-ballot demo on ${ORIGIN} (data in ${dir})`);
  console.log(`Voting page:  ${ORIGIN}/vote/#s=${encodeURIComponent(ORIGIN)}&e=${E}`);
  console.log(`Public page:  ${ORIGIN}/public/#s=${encodeURIComponent(ORIGIN)}&e=${E}`);
  console.log(`Email outbox: ${ORIGIN}/api/dev/outbox`);
  console.log(`Count key fingerprint: ${fp.json.fingerprint}; private half in ${join(dir, 'count-key.txt')}`);
  for (const [i, m] of members.entries()) console.log(`  ${m}  ${m.toLowerCase()}@example.org  ${formatCode(codes[i]!)}`);
});
