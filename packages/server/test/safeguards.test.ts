// The safeguards for when things go wrong: the tellers' fallback close when the issuer passphrase is lost, which
// only tellers set up before opening can approve and which needs two of them; and the provisional ruling.
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { codeHash, deriveCode, deriveIssuerKeys, fromBase64, toBase64, verifyClose, type IssuerKeys } from '@coded-ballot/core';
import { createApp } from '../src/app.ts';
import { DiskBlobs, SqliteDb } from '../src/db/sqlite.ts';
import { MemoryMailer } from '../src/mail/types.ts';
import { SoftAuthenticator } from './soft-authenticator.ts';

const ORIGIN = 'https://ballot.test';
const E = 'fallback-test';
const PASS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RULES = `schema_version: 1
election: { id: ${E}, title: Fallback test, organisation: Test club }
dates: { notice: 2027-03-01T09:00:00Z, ballots_out: 2027-03-02T09:00:00Z, voting_opens: 2027-03-02T09:00:00Z, voting_closes: 2027-03-20T18:00:00Z }
roles: { mode: one_person }
channels: { mail: true, online: false, in_person: true }
classes: [{ id: full, label: Full }]
contests:
  - { id: chair, title: Chair, method: plurality, candidates: [{ id: ana, name: Ana }, { id: ben, name: Ben }] }
`;

let clock = new Date('2027-03-01T10:00:00Z');
const mailer = new MemoryMailer();
let app: ReturnType<typeof createApp>;
let keys: IssuerKeys;

async function call(method: string, path: string, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => null)) as any, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

async function enroll(invite: string) {
  const auth = new SoftAuthenticator();
  const o = await call('POST', '/api/auth/register/options', undefined, { invite });
  const v = await call('POST', '/api/auth/register/verify', undefined, { invite, challengeId: o.json.challengeId, response: auth.register(o.json.options, ORIGIN) });
  expect(v.status).toBe(200);
  return { auth, cookie: v.cookie! };
}

async function login(auth: SoftAuthenticator) {
  const o = await call('POST', '/api/auth/login/options', undefined, {});
  return (await call('POST', '/api/auth/login/verify', undefined, { challengeId: o.json.challengeId, response: auth.login(o.json.options, ORIGIN) })).cookie!;
}

async function invite(by: string, name: string) {
  await call('POST', '/api/auth/invite', by, { name, email: `${name.toLowerCase()}@example.org`, roles: ['teller'] });
  return enroll(mailer.sent.at(-1)!.text.match(/#invite=([\w-]+)/)![1]!);
}

const people = {} as Record<'ivy' | 'tom' | 'late', { auth: SoftAuthenticator; cookie: string }>;

beforeAll(async () => {
  const db = new SqliteDb(':memory:');
  await db.migrate(fileURLToPath(new URL('../migrations', import.meta.url)));
  app = createApp({
    db,
    blobs: new DiskBlobs(mkdtempSync(join(tmpdir(), 'cb-safe-'))),
    mailer,
    config: { publicOrigin: ORIGIN, rpId: 'ballot.test', rpName: 'Test', projectOrigins: [], votingPageUrl: `${ORIGIN}/vote/`, setupToken: 'setup' },
    now: () => clock,
  });
  keys = await deriveIssuerKeys(PASS, E);
});

describe('fallback close', () => {
  it('sets up an election with two tellers before opening', async () => {
    const b = await call('POST', '/api/auth/bootstrap', undefined, { setupToken: 'setup', name: 'Ivy', email: 'ivy@example.org' });
    people.ivy = await enroll(b.json.invite); // issuer and teller
    people.tom = await invite(people.ivy.cookie, 'Tom');
    expect((await call('POST', '/api/staff/elections', people.ivy.cookie, { rulesYaml: RULES })).status).toBe(200);
    await call('POST', `/api/staff/e/${E}/roll`, people.ivy.cookie, { members: [{ memberId: 'M1', email: null }, { memberId: 'M2', email: null }], rollSha256: 'b'.repeat(64), frozenAt: '2027-03-01T09:00:00Z' });
    const codes = ['M1', 'M2'].map((m) => ({ hash: codeHash(E, deriveCode(keys, m, 1)), styleId: 'full' }));
    await call('POST', `/api/staff/e/${E}/codes`, people.ivy.cookie, { issuerPublicKey: toBase64(keys.signPublicKey), codes });
    await call('POST', `/api/staff/e/${E}/passphrase-backup`, people.ivy.cookie);
    clock = new Date('2027-03-02T10:00:00Z');
    for (const p of Object.values(people)) p.cookie = await login(p.auth); // sessions last 12 hours
    expect((await call('POST', `/api/staff/e/${E}/open`, people.ivy.cookie)).status).toBe(200);
    clock = new Date('2027-03-02T10:05:00Z');
    people.late = await invite(people.ivy.cookie, 'Late'); // joins after opening
    const r = await call('POST', `/api/staff/e/${E}/receipts`, people.tom.cookie, { hash: codes[0]!.hash, styleId: 'full', channel: 'mail' });
    expect(r.json.ok).toBe(true);
  });

  it('refuses before the closing time', async () => {
    expect((await call('POST', `/api/staff/e/${E}/close/fallback`, people.tom.cookie)).status).toBe(409);
  });

  it('needs two tellers who were staff before voting opened', async () => {
    clock = new Date('2027-03-20T18:30:00Z');
    for (const p of Object.values(people)) p.cookie = await login(p.auth);
    expect((await call('POST', `/api/staff/e/${E}/close/fallback`, people.late.cookie)).status).toBe(403);
    expect((await call('POST', `/api/staff/e/${E}/close/fallback`, people.tom.cookie)).json).toEqual({ closed: false, approvals: 1, needed: 2 });
    // approving twice doesn't count twice
    expect((await call('POST', `/api/staff/e/${E}/close/fallback`, people.tom.cookie)).json).toEqual({ closed: false, approvals: 1, needed: 2 });
    expect((await call('POST', `/api/staff/e/${E}/close/fallback`, people.ivy.cookie)).json).toEqual({ closed: true });
  });

  it('is marked as a fallback everywhere, and checks out as one', async () => {
    const r = await call('GET', `/api/staff/e/${E}/locked-votes`, people.tom.cookie);
    expect(r.status).toBe(200);
    expect(r.json.close.signature).toBeNull();
    expect(await verifyClose(r.json.close, fromBase64(r.json.issuerPublicKey), r.json.lockedVotes)).toEqual({ ok: true, fallback: true });
    expect((await call('GET', `/api/public/e/${E}`)).json.closeFallback).toBe(true);
    const kinds = (await call('GET', `/api/public/e/${E}/log`)).json.log.map((l: { kind: string }) => l.kind);
    expect(kinds).toContain('fallback_close_requested');
    expect(kinds).toContain('closed_fallback');
    // a signed close can't follow
    expect((await call('POST', `/api/staff/e/${E}/close`, people.ivy.cookie, {})).status).toBe(409);
  });

  it('records the provisional ruling in the public log', async () => {
    expect((await call('POST', `/api/staff/e/${E}/provisional`, people.tom.cookie, { upheld: 1, rejected: -1 })).status).toBe(400);
    expect((await call('POST', `/api/staff/e/${E}/provisional`, people.tom.cookie, { upheld: 1, rejected: 2 })).status).toBe(200);
    const log = (await call('GET', `/api/public/e/${E}/log`)).json.log;
    expect(log.at(-1)).toMatchObject({ kind: 'provisional_ruled', detail: { upheld: 1, rejectedDestroyedUnread: 2 } });
  });
});
