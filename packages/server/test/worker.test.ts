// The Workers target, run by `wrangler dev` with local D1 and R2: the same app, the D1 transaction semantics the
// online vote depends on, and R2 for images.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeHash, deriveCode, deriveIssuerKeys, fromBase64, sha256Hex, signClose, sodium, toBase64, utf8ToBytes, verifyClose, type IssuerKeys } from '@coded-ballot/core';
import { SoftAuthenticator } from './soft-authenticator.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const cfg = join(here, 'wrangler.test.jsonc');
const PORT = 18000 + Math.floor(Math.random() * 2000);
const ORIGIN = `http://localhost:${PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const E = 'worker-test';
const persist = mkdtempSync(join(tmpdir(), 'cb-wrangler-'));
const wranglerBin = fileURLToPath(new URL('../../../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
let proc: ChildProcess;
let out = '';
let cookie = '';
let keys: IssuerKeys;

function rules() {
  const iso = (h: number) => new Date(Date.now() + h * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
  return `schema_version: 1
election: { id: ${E}, title: Worker test, organisation: Test club }
dates: { notice: ${iso(-48)}, ballots_out: ${iso(-47)}, voting_opens: ${iso(-1)}, voting_closes: ${iso(1)} }
roles: { mode: one_person }
classes: [{ id: full, label: Full }]
contests:
  - { id: chair, title: Chair, method: plurality, candidates: [{ id: ana, name: Ana }, { id: ben, name: Ben }] }
`;
}

async function call(method: string, path: string, body?: unknown, raw?: { data: Uint8Array; type: string }) {
  const headers: Record<string, string> = { origin: ORIGIN, cookie };
  if (!raw) headers['content-type'] = 'application/json';
  else headers['content-type'] = raw.type;
  const res = await fetch(BASE + path, { method, headers, body: raw ? (raw.data as Uint8Array<ArrayBuffer>) : body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

beforeAll(async () => {
  keys = await deriveIssuerKeys(PASS, E);
  execFileSync(process.execPath, [wranglerBin, 'd1', 'migrations', 'apply', 'coded-ballot-test', '--local', '--persist-to', persist, '-c', cfg], { env, stdio: 'pipe' });
  proc = spawn(
    process.execPath,
    [wranglerBin, 'dev', '-c', cfg, '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist,
      '--var', `PUBLIC_ORIGIN:${ORIGIN}`, '--var', 'SETUP_TOKEN:worker-setup', '--var', 'DEV_OUTBOX:1', '--var', 'RP_ID:localhost'],
    { env, stdio: 'pipe' },
  );
  proc.stdout!.on('data', (b) => (out += b));
  proc.stderr!.on('data', (b) => (out += b));
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start:\n' + out.slice(-3000));
}, 120_000);

afterAll(() => {
  proc?.kill();
  try {
    rmSync(persist, { recursive: true, force: true });
  } catch {}
});

describe('Workers target (wrangler dev, D1, R2)', () => {
  const hash = (m: string) => codeHash(E, deriveCode(keys, m, 1));
  let countKey: { publicKey: Uint8Array; privateKey: Uint8Array };

  it('answers health and signs up the first person with a passkey', async () => {
    expect((await call('GET', '/api/health')).json.ok).toBe(true);
    const b = await call('POST', '/api/auth/bootstrap', { setupToken: 'worker-setup', name: 'One Person', email: 'one@example.org' });
    expect(b.status, JSON.stringify(b.json)).toBe(200);
    const auth = new SoftAuthenticator();
    const o = await call('POST', '/api/auth/register/options', { invite: b.json.invite });
    const v = await call('POST', '/api/auth/register/verify', { invite: b.json.invite, challengeId: o.json.challengeId, response: auth.register(o.json.options, ORIGIN) });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
  });

  it('sets up and opens an election', async () => {
    expect((await call('POST', '/api/staff/elections', { rulesYaml: rules() })).status).toBe(200);
    await call('POST', `/api/staff/e/${E}/roll`, { members: ['A', 'B', 'C'].map((m) => ({ memberId: m, email: `${m.toLowerCase()}@example.org` })), rollSha256: 'b'.repeat(64), frozenAt: new Date().toISOString() });
    const up = await call('POST', `/api/staff/e/${E}/codes`, { issuerPublicKey: toBase64(keys.signPublicKey), codes: ['A', 'B', 'C'].map((m) => ({ hash: hash(m), styleId: 'full' })) });
    expect(up.json).toEqual({ issued: 3 });
    await call('POST', `/api/staff/e/${E}/passphrase-backup`);
    countKey = (await sodium()).crypto_box_keypair();
    expect((await call('POST', `/api/staff/e/${E}/count-key`, { publicKey: toBase64(countKey.publicKey) })).status).toBe(200); // one-person mode allows it
    await call('POST', `/api/staff/e/${E}/count-key/confirm`);
    expect((await call('POST', `/api/staff/e/${E}/open`)).status).toBe(200);
  });

  it('spends a code once (D1 compare-and-set)', async () => {
    const results = await Promise.all(
      ['mail', 'in_person', 'mail'].map((channel) => call('POST', `/api/staff/e/${E}/receipts`, { hash: hash('A'), styleId: 'full', channel })),
    );
    expect(results.filter((r) => r.json.ok)).toHaveLength(1);
  });

  it('stores an online vote in one D1 transaction, and refuses a used code without burning the link', async () => {
    const s = await sodium();
    await call('POST', `/api/public/e/${E}/online/request-link`, { email: 'b@example.org' });
    const outbox = (await call('GET', '/api/dev/outbox')).json.sent;
    const token = outbox.at(-1).text.match(/&t=([\w-]+)/)[1];
    const sealed = toBase64(s.crypto_box_seal(utf8ToBytes(JSON.stringify({ chair: ['ben'] })), countKey.publicKey));
    const bad = await call('POST', `/api/public/e/${E}/online/vote`, { token, codeHash: hash('A'), styleId: 'full', sealed });
    expect(bad.status).toBe(409);
    const ok = await call('POST', `/api/public/e/${E}/online/vote`, { token, codeHash: hash('B'), styleId: 'full', sealed });
    expect(ok.json.ok, JSON.stringify(ok.json)).toBe(true);
    expect((await call('POST', `/api/public/e/${E}/online/vote`, { token, codeHash: hash('C'), styleId: 'full', sealed })).status).toBe(410);
    expect((await call('GET', `/api/public/e/${E}/counts`)).json).toMatchObject({ lockedVotes: 1, spent: { mail: 1, online: 1 } });
  });

  it('closes with the issuer signature and releases the locked votes', async () => {
    const prep = await call('GET', `/api/staff/e/${E}/close/prepare`);
    const st = { type: 'coded-ballot/close', version: 1, electionId: E, closedAt: new Date().toISOString(), lockedVotes: prep.json, fallback: false } as const;
    const signed = await signClose(keys, st);
    const closed = await call('POST', `/api/staff/e/${E}/close`, signed);
    expect(closed.status, out.slice(-2000)).toBe(200);
    const lv = await call('GET', `/api/staff/e/${E}/locked-votes`);
    expect(await verifyClose(lv.json.close, fromBase64(lv.json.issuerPublicKey), lv.json.lockedVotes)).toEqual({ ok: true, fallback: false });
  });

  it('stores ballot images in R2 by their fingerprint', async () => {
    const img = utf8ToBytes('pretend this is a JPEG');
    const sha = sha256Hex(img);
    expect((await call('PUT', `/api/staff/e/${E}/images/${'0'.repeat(64)}`, undefined, { data: img, type: 'image/jpeg' })).status).toBe(400);
    expect((await call('PUT', `/api/staff/e/${E}/images/${sha}`, undefined, { data: img, type: 'image/jpeg' })).status).toBe(200);
    const res = await fetch(`${BASE}/api/staff/e/${E}/images/${sha}`, { headers: { cookie, origin: ORIGIN } });
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('pretend this is a JPEG');
  });
});
