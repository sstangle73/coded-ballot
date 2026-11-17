// A whole election through the Node target's storage (SQLite in memory): set-up with passkeys, codes, the roll,
// the count key, opening, mail and online voting, close, the count, certification, runoff and purge.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  closeStatement,
  codeHash,
  deriveCode,
  deriveIssuerKeys,
  fromBase64,
  signClose,
  sodium,
  toBase64,
  utf8ToBytes,
  verifyClose,
  sealVote,
  sealedBody,
  unlockVote,
  type IssuerKeys,
} from '@coded-ballot/core';
import { createApp } from '../src/app.ts';
import { SqliteDb, DiskBlobs } from '../src/db/sqlite.ts';
import { MemoryMailer } from '../src/mail/types.ts';
import type { Deps } from '../src/context.ts';
import { purgeDue } from '../src/purge.ts';
import { SoftAuthenticator } from './soft-authenticator.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = 'https://ballot.test';
const PASS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RULES = readFileSync(new URL('../../../examples/rules.example.yaml', import.meta.url), 'utf8');
const E = 'agm-2027';

let clock = new Date('2027-03-10T12:00:00Z');
const mailer = new MemoryMailer();
let d: Deps;
let app: ReturnType<typeof createApp>;
let keys: IssuerKeys;

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; origin?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: opts.origin ?? ORIGIN };
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const json = (await res.json().catch(() => null)) as Record<string, any>;
  return { status: res.status, json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

async function enroll(invite: string, auth: SoftAuthenticator) {
  const o = await call('POST', '/api/auth/register/options', { body: { invite } });
  expect(o.status).toBe(200);
  const v = await call('POST', '/api/auth/register/verify', {
    body: { invite, challengeId: o.json.challengeId, response: auth.register(o.json.options, ORIGIN) },
  });
  expect(v.status, JSON.stringify(v.json)).toBe(200);
  return v.cookie!;
}

async function login(auth: SoftAuthenticator) {
  const o = await call('POST', '/api/auth/login/options', {});
  const v = await call('POST', '/api/auth/login/verify', { body: { challengeId: o.json.challengeId, response: auth.login(o.json.options, ORIGIN) } });
  expect(v.status, JSON.stringify(v.json)).toBe(200);
  return v.cookie!;
}

const members = Array.from({ length: 8 }, (_, i) => `M00${i + 1}`);
const code = (m: string, n = 1) => deriveCode(keys, m, n);
const hash = (m: string, n = 1) => codeHash(E, code(m, n));

let issuerCookie: string;
let issuerKey: SoftAuthenticator;
let tellerKey: SoftAuthenticator;
let tellerCookie: string;
let countKey: { publicKey: Uint8Array; privateKey: Uint8Array };

beforeAll(async () => {
  const db = new SqliteDb(':memory:');
  await db.migrate(fileURLToPath(new URL('../migrations', import.meta.url)));
  d = {
    db,
    blobs: new DiskBlobs(mkdtempSync(join(tmpdir(), 'cb-blobs-'))),
    mailer,
    config: { publicOrigin: ORIGIN, rpId: 'ballot.test', rpName: 'Test', projectOrigins: ['https://project.test'], votingPageUrl: 'https://project.test/vote/', setupToken: 'setup-secret' },
    now: () => clock,
  };
  app = createApp(d);
  keys = await deriveIssuerKeys(PASS, E);
  const s = await sodium();
  countKey = s.crypto_box_keypair();
});

describe('a whole election', () => {
  it('sets up staff with passkeys', async () => {
    expect((await call('POST', '/api/auth/bootstrap', { body: { setupToken: 'wrong', name: 'A', email: 'a@x.org' } })).status).toBe(403);
    const b = await call('POST', '/api/auth/bootstrap', { body: { setupToken: 'setup-secret', name: 'Issa Issuer', email: 'issuer@example.org' } });
    expect(b.status).toBe(200);
    issuerKey = new SoftAuthenticator();
    issuerCookie = await enroll(b.json.invite, issuerKey);
    expect((await call('POST', '/api/auth/bootstrap', { body: { setupToken: 'setup-secret', name: 'B', email: 'b@x.org' } })).status).toBe(409);
    // the bootstrap person is issuer and teller; make them issuer only by inviting a separate teller
    const inv = await call('POST', '/api/auth/invite', { cookie: issuerCookie, body: { name: 'Tess Teller', email: 'teller@example.org', roles: ['teller'] } });
    expect(inv.status).toBe(200);
    const link = mailer.sent.at(-1)!.text.match(/#invite=([\w-]+)/)![1]!;
    tellerKey = new SoftAuthenticator();
    await enroll(link, tellerKey);
    tellerCookie = await login(tellerKey); // sign in again with the passkey
    expect((await call('GET', '/api/auth/me', { cookie: tellerCookie })).json.staff.roles).toEqual(['teller']);
    expect((await call('POST', '/api/auth/register/options', { body: { invite: link } })).status).toBe(410); // used
  });

  it('gives the local tool a bearer token, made only from a passkey session', async () => {
    const t = await call('POST', '/api/auth/tokens', { cookie: issuerCookie, body: { label: 'test' } });
    expect(t.status).toBe(200);
    const res = await app.request('/api/auth/me', { headers: { authorization: `Bearer ${t.json.token}` } });
    expect(((await res.json()) as any).staff.name).toBe('Issa Issuer');
    const again = await app.request('/api/auth/tokens', { method: 'POST', headers: { authorization: `Bearer ${t.json.token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(again.status).toBe(403);
    // a tool token can't invite people or act as a teller
    const inv = await app.request('/api/auth/invite', { method: 'POST', headers: { authorization: `Bearer ${t.json.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Y', email: 'y@example.org', roles: ['issuer'] }) });
    expect(inv.status).toBe(403);
    // only issuers make tool tokens
    expect((await call('POST', '/api/auth/tokens', { cookie: tellerCookie, body: {} })).status).toBe(403);
    const bad = await app.request('/api/auth/me', { headers: { authorization: 'Bearer ' + 'x'.repeat(43) } });
    expect(bad.status).toBe(401);
  });

  it('refuses staff actions from another origin', async () => {
    const r = await call('POST', '/api/staff/elections', { cookie: issuerCookie, origin: 'https://evil.test', body: { rulesYaml: RULES } });
    expect(r.status).toBe(403);
  });

  it('creates the election and refuses to open it until everything is ready', async () => {
    const r = await call('POST', '/api/staff/elections', { cookie: issuerCookie, body: { rulesYaml: RULES } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // a teller can't hand out the issuer role
    expect((await call('POST', '/api/auth/invite', { cookie: tellerCookie, body: { name: 'X', email: 'x@example.org', roles: ['issuer'] } })).status).toBe(403);
    const o = await call('POST', `/api/staff/e/${E}/open`, { cookie: issuerCookie });
    expect(o.status).toBe(409);
    expect(o.json.error).toMatch(/codes have not been uploaded.*passphrase.*roll.*count key/);
  });

  it('takes the roll, the codes and the count key', async () => {
    const roll = members.map((m, i) => ({ memberId: m, email: i < 6 ? `${m.toLowerCase()}@example.org` : null }));
    expect((await call('POST', `/api/staff/e/${E}/roll`, { cookie: issuerCookie, body: { members: roll, rollSha256: 'a'.repeat(64), frozenAt: '2027-03-01T14:00:00Z' } })).json).toEqual({
      members: 8,
      withEmail: 6,
    });
    const codes = members.map((m) => ({ hash: hash(m), styleId: 'full' }));
    const up = await call('POST', `/api/staff/e/${E}/codes`, { cookie: issuerCookie, body: { issuerPublicKey: toBase64(keys.signPublicKey), codes } });
    expect(up.json).toEqual({ issued: 8 });
    expect((await call('POST', `/api/staff/e/${E}/passphrase-backup`, { cookie: issuerCookie })).status).toBe(200);
    // separated mode: the issuer can't hold the count key
    expect((await call('POST', `/api/staff/e/${E}/count-key`, { cookie: issuerCookie, body: { publicKey: toBase64(countKey.publicKey) } })).status).toBe(403);
    const ck = await call('POST', `/api/staff/e/${E}/count-key`, { cookie: tellerCookie, body: { publicKey: toBase64(countKey.publicKey) } });
    expect(ck.json.fingerprint).toMatch(/^(\w{4} ){3}\w{4}$/);
    expect((await call('POST', `/api/staff/e/${E}/open`, { cookie: tellerCookie })).json.error).toMatch(/second copy of the count key/);
    await call('POST', `/api/staff/e/${E}/count-key/confirm`, { cookie: tellerCookie });
    expect((await call('POST', `/api/staff/e/${E}/open`, { cookie: tellerCookie })).status).toBe(200);
  });

  it('reissues: the old code is revoked and the new one works', async () => {
    const r = await call('POST', `/api/staff/e/${E}/codes/reissue`, {
      cookie: issuerCookie,
      body: { revoke: hash('M008'), issue: { hash: hash('M008', 2), styleId: 'full' } },
    });
    expect(r.status).toBe(200);
    expect((await call('GET', `/api/public/e/${E}/track/${hash('M008')}`)).json).toEqual({ status: 'replaced' });
  });

  it('spends mailed codes once; a photocopy is turned away', async () => {
    const first = await call('POST', `/api/staff/e/${E}/receipts`, { cookie: tellerCookie, body: { hash: hash('M007'), styleId: 'full', channel: 'mail' } });
    expect(first.json).toEqual({ ok: true, styleId: 'full' });
    const copy = await call('POST', `/api/staff/e/${E}/receipts`, { cookie: tellerCookie, body: { hash: hash('M007'), styleId: 'full', channel: 'in_person' } });
    expect(copy.json).toEqual({ ok: false, reason: 'already_spent', spentBy: 'mail' });
    expect((await call('GET', `/api/public/e/${E}/track/${hash('M007')}`)).json).toEqual({ status: 'received', channel: 'mail', date: '2027-03-10' });
  });

  it('takes an online vote with the email link and the code, once', async () => {
    const s = await sodium();
    const ask = await call('POST', `/api/public/e/${E}/online/request-link`, { body: { email: 'M001@example.org' }, origin: 'https://project.test' });
    expect(ask.json.ok).toBe(true);
    await call('POST', `/api/public/e/${E}/online/request-link`, { body: { email: 'm001@example.org' } }); // asks again: the first link must still work
    const nobody = await call('POST', `/api/public/e/${E}/online/request-link`, { body: { email: 'nobody@example.org' } });
    expect(nobody.json).toEqual(ask.json); // same answer either way
    const mail = mailer.sent.at(-2)!; // the first link M001 got
    expect(mail.to).toBe('m001@example.org');
    const token = mail.text.match(/&t=([\w-]+)/)![1]!;
    expect(mail.text).toContain('https://project.test/vote/#s=https%3A%2F%2Fballot.test&e=agm-2027&t=');

    const chk = await call('POST', `/api/public/e/${E}/online/check`, { body: { token, codeHash: hash('M001') } });
    expect(chk.json.style.contests).toEqual(['chair', 'committee', 'motion-1']);
    const sealed = sealedBody(await sealVote({ v: 1, styleId: 'full', selections: { chair: ['ana'], committee: ['dee', 'eli'], 'motion-1': ['yes'] } }, countKey.publicKey));
    void s;
    const v = await call('POST', `/api/public/e/${E}/online/vote`, { body: { token, codeHash: hash('M001'), styleId: 'full', sealed } });
    expect(v.json.ok, JSON.stringify(v.json)).toBe(true);
    // the link is used up, and so is the code
    expect((await call('POST', `/api/public/e/${E}/online/vote`, { body: { token, codeHash: hash('M002'), styleId: 'full', sealed } })).status).toBe(410);
    expect((await call('POST', `/api/staff/e/${E}/receipts`, { cookie: tellerCookie, body: { hash: hash('M001'), styleId: 'full', channel: 'mail' } })).json.reason).toBe(
      'already_spent',
    );
    expect((await call('GET', `/api/public/e/${E}/track/${hash('M001')}`)).json).toEqual({ status: 'cast_online' });
    // nothing in the database links the member, the code and the vote
    const voter = await d.db.first<Record<string, unknown>>('SELECT * FROM voters WHERE member_id = ?', ['M001']);
    expect(voter).toMatchObject({ used: 'used' });
    expect(await d.db.first('SELECT * FROM voter_links WHERE member_id = ?', ['M001'])).toBeNull();
    expect(await d.db.first('SELECT * FROM codes WHERE spend_nonce IS NOT NULL')).toBeNull();
    const lv = await d.db.all<Record<string, unknown>>('SELECT * FROM locked_votes');
    expect(Object.keys(lv[0]!).sort()).toEqual(['election_id', 'id', 'sealed']);
  });

  it('a second member votes online; a member with a mailed code cannot also vote online', async () => {
    const s = await sodium();
    await call('POST', `/api/public/e/${E}/online/request-link`, { body: { email: 'm002@example.org' } });
    const t2 = mailer.sent.at(-1)!.text.match(/&t=([\w-]+)/)![1]!;
    const sealed = async (x: Record<string, string[]>) => sealedBody(await sealVote({ v: 1, styleId: 'full', selections: x }, countKey.publicKey));
    void s;
    expect((await call('POST', `/api/public/e/${E}/online/vote`, { body: { token: t2, codeHash: hash('M002'), styleId: 'full', sealed: await sealed({ chair: ['ben'] }) } })).json.ok).toBe(true);
    await call('POST', `/api/public/e/${E}/online/request-link`, { body: { email: 'm003@example.org' } });
    const t3 = mailer.sent.at(-1)!.text.match(/&t=([\w-]+)/)![1]!;
    // M003 tries M007's already-mailed code: refused, nothing stored, link still usable
    const bad = await call('POST', `/api/public/e/${E}/online/vote`, { body: { token: t3, codeHash: hash('M007'), styleId: 'full', sealed: await sealed({}) } });
    expect(bad.status).toBe(409);
    expect((await d.db.all('SELECT id FROM locked_votes')).length).toBe(2);
    expect((await call('POST', `/api/public/e/${E}/online/check`, { body: { token: t3, codeHash: hash('M003') } })).status).toBe(200);
  });

  it('keeps locked votes back until close, and logs the attempt', async () => {
    const r = await call('GET', `/api/staff/e/${E}/locked-votes`, { cookie: tellerCookie });
    expect(r.status).toBe(409);
    const log = await call('GET', `/api/public/e/${E}/log`);
    expect(log.json.log.map((l: { kind: string }) => l.kind)).toContain('locked_votes_refused');
  });

  it('closes with the issuer signature over every locked vote', async () => {
    clock = new Date('2027-03-29T23:05:00Z');
    expect((await call('GET', `/api/staff/e/${E}/close/prepare`, { cookie: issuerCookie })).status).toBe(401); // session expired
    issuerCookie = await login(issuerKey);
    tellerCookie = await login(tellerKey);
    expect((await call('POST', `/api/public/e/${E}/online/request-link`, { body: { email: 'm003@example.org' } })).status).toBe(409);
    const prep = await call('GET', `/api/staff/e/${E}/close/prepare`, { cookie: issuerCookie });
    expect(prep.json.count).toBe(2);
    // the issuer tool signs a statement it builds from the digest the server reports
    const st = { ...closeStatement(E, clock, []), lockedVotes: prep.json };
    const signed = await signClose(keys, st as never);
    const bad = await call('POST', `/api/staff/e/${E}/close`, { cookie: issuerCookie, body: { ...signed, signature: toBase64(new Uint8Array(64)) } });
    expect(bad.status).toBe(409);
    expect((await call('POST', `/api/staff/e/${E}/close`, { cookie: issuerCookie, body: signed })).status).toBe(200);
  });

  it('lets a teller download, check and unlock the online votes', async () => {
    const s = await sodium();
    const r = await call('GET', `/api/staff/e/${E}/locked-votes`, { cookie: tellerCookie });
    expect(r.status).toBe(200);
    expect(await verifyClose(r.json.close, fromBase64(r.json.issuerPublicKey), r.json.lockedVotes)).toEqual({ ok: true, fallback: false });
    const opened = await Promise.all((r.json.lockedVotes as string[]).map((x) => unlockVote(x, countKey)));
    expect(opened.map((o) => o.selections.chair![0]).sort()).toEqual(['ana', 'ben']);
    expect(opened.every((o) => o.styleId === 'full')).toBe(true);
    void s;
  });

  it('gives tellers the electorate by style for the count, and when the key was destroyed', async () => {
    const r = await call('GET', `/api/staff/e/${E}/report-data`, { cookie: tellerCookie });
    expect(r.json.styles).toEqual([{ styleId: 'full', n: 8 }]); // M008's first code was replaced, so 8, not 9
    expect(r.json.closedAt).toBe('2027-03-29T23:05:00.000Z');
    expect(r.json).toHaveProperty('keyDestroyedAt');
  });

  it('blocks certification until the hand count matches', async () => {
    await call('POST', `/api/staff/e/${E}/paper`, {
      cookie: tellerCookie,
      body: { records: [{ id: 'rec-00000001', styleId: 'full', cvr: { chair: ['cai'] }, status: 'ok' }] },
    });
    const paperTotals = { chair: { cai: '1' }, committee: {}, 'motion-1': {}, boathouse: {} };
    for (const contestId of Object.keys(paperTotals))
      await call('POST', `/api/staff/e/${E}/hand-count`, { cookie: tellerCookie, body: { contestId, totals: contestId === 'chair' ? { cai: '2' } : {} } });
    const body = { results: { ok: 1 }, report: { r: 1 }, countKeyPrivate: toBase64(countKey.privateKey), paperTotals };
    const no = await call('POST', `/api/staff/e/${E}/certify`, { cookie: tellerCookie, body });
    expect(no.status).toBe(409);
    expect(no.json.error).toMatch(/hand count for Chair doesn't match/);
    await call('POST', `/api/staff/e/${E}/hand-count`, { cookie: tellerCookie, body: { contestId: 'chair', totals: { cai: '1' } } });
    expect((await call('POST', `/api/staff/e/${E}/certify`, { cookie: tellerCookie, body: { ...body, countKeyPrivate: toBase64(new Uint8Array(32)) } })).status).toBe(400);
    expect((await call('POST', `/api/staff/e/${E}/certify`, { cookie: tellerCookie, body })).status).toBe(200);
    const pub = await call('GET', `/api/public/e/${E}/results`);
    expect(pub.json.countKeyPrivate).toBe(toBase64(countKey.privateKey));
    expect(pub.json.lockedVotes).toHaveLength(2);
  });

  it('publishes counts and a log with no member IDs or codes', async () => {
    const counts = await call('GET', `/api/public/e/${E}/counts`);
    expect(counts.json).toMatchObject({ issued: 9, revoked: 1, reissued: 1, spent: { mail: 1, online: 2, in_person: 0 }, lockedVotes: 2 });
    const log = JSON.stringify((await call('GET', `/api/public/e/${E}/log`)).json);
    for (const m of members) expect(log).not.toContain(m);
    expect(log).not.toContain(code('M001'));
    expect(log).not.toContain(hash('M001'));
  });

  it('clones as a runoff with the same roll and fresh codes', async () => {
    const r = await call('POST', `/api/staff/e/${E}/clone`, { cookie: issuerCookie, body: { newId: 'agm-2027-runoff' } });
    expect(r.status).toBe(200);
    const info = await call('GET', '/api/public/e/agm-2027-runoff');
    expect(info.json.status).toBe('setup');
    expect(info.json.clonedFrom).toBe(E);
    expect((await d.db.all("SELECT member_id FROM voters WHERE election_id = 'agm-2027-runoff'")).length).toBe(6);
  });

  it('purges after the retention period and logs what was destroyed', async () => {
    expect(await purgeDue(d)).toEqual([]);
    clock = new Date(Date.parse('2027-03-29T23:05:00Z') + 91 * 86_400_000);
    expect(await purgeDue(d)).toEqual([E]);
    const log = (await call('GET', `/api/public/e/${E}/log`)).json.log;
    expect(log.at(-1).kind).toBe('purged');
    expect(log.at(-1).detail.destroyed).toMatchObject({ codes: 9, locked_votes: 2, voters: 6 });
    expect((await call('GET', `/api/public/e/${E}/track/${hash('M001')}`)).json).toEqual({ status: 'unknown' });
    expect((await call('GET', `/api/public/e/${E}/results`)).json.results).toEqual({ ok: 1 });
  });
});
