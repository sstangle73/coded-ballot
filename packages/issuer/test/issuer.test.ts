import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { codeHash, deriveCode, deriveIssuerKeys, loadRules, type IssuerKeys } from '@coded-ballot/core';
import { freezeRollCsv, makeBallots, reissue, type PacketInfo } from '../src/issuer.ts';
import { sendLobLetter } from '../src/lob.ts';

const { rules } = loadRules(readFileSync(new URL('../../../examples/rules.example.yaml', import.meta.url), 'utf8'));
const PASS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const csv = readFileSync(new URL('../../../examples/roll.example.csv', import.meta.url), 'utf8');
const info: PacketInfo = { votingPage: 'https://vote.test/vote/', tracker: 'https://vote.test/public/#e=agm-2027', countKeyFingerprint: 'ABCD EFGH JKMN PQRS', returnAddress: ['1 River Road', 'Exampleton NY 10001'] };
let keys: IssuerKeys;
beforeAll(async () => {
  keys = await deriveIssuerKeys(PASS, rules.election.id);
});

describe('issuer', () => {
  it('freezes the example roll', () => {
    const { frozen, problems } = freezeRollCsv(rules, csv);
    expect(problems).toEqual([]);
    expect(frozen.members.length).toBeGreaterThan(3);
  });

  it('makes a packet per member, uploads only hashes, and keeps no codes', async () => {
    const { frozen } = freezeRollCsv(rules, csv);
    const out = await makeBallots({ rules, frozen, keys, info });
    expect(out.packets).toHaveLength(frozen.members.length);
    expect(out.codes).toHaveLength(frozen.members.length);
    expect([...out.codes].map((c) => c.hash)).toEqual([...out.codes].map((c) => c.hash).sort());
    const stateText = JSON.stringify(out.state);
    for (const m of frozen.members) expect(stateText).not.toContain(deriveCode(keys, m.memberId, 1));
    const first = await PDFDocument.load(out.packets[0]!.pdf);
    expect(first.getPageCount()).toBeGreaterThanOrEqual(2); // cover letter + ballot sheet(s)
    expect((await PDFDocument.load(out.combined)).getPageCount()).toBe(
      (await Promise.all(out.packets.map(async (p) => (await PDFDocument.load(p.pdf)).getPageCount()))).reduce((a, b) => a + b),
    );
    const owner = frozen.members.find((m) => m.classId === 'owner')!;
    expect(out.state.members[owner.memberId]!.styleId).toMatch(/^owner_w/);
    // running again issues nobody twice
    expect((await makeBallots({ rules, frozen, keys, info, state: out.state })).packets).toHaveLength(0);
  });

  it('reissues copy 2 and revokes copy 1', async () => {
    const { frozen } = freezeRollCsv(rules, csv);
    const out = await makeBallots({ rules, frozen, keys, info });
    const id = frozen.members[0]!.memberId;
    const r = await reissue({ rules, frozen, keys, info, state: out.state, memberId: id });
    expect(r.revoke).toBe(codeHash(rules.election.id, deriveCode(keys, id, 1)));
    expect(r.issue.hash).toBe(codeHash(rules.election.id, deriveCode(keys, id, 2)));
    expect(r.state.members[id]!.copy).toBe(2);
  });

  it('refuses names the PDF font cannot print', async () => {
    const { frozen } = freezeRollCsv(rules, csv);
    const m = { ...frozen.members[0]!, name: '王小明' };
    await expect(makeBallots({ rules, frozen: { ...frozen, members: [m] }, keys, info })).rejects.toThrow(/built-in PDF font/);
  });

  it('sends a Lob letter in the shape Lob expects', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ id: 'ltr_test123', url: 'https://lob.test/preview' }), { status: 200 });
    }) as unknown as typeof fetch;
    const addr = { name: 'A', address_line1: '1 Main St', address_city: 'Town', address_state: 'NY', address_zip: '10001' };
    const r = await sendLobLetter({ apiKey: 'test_abc', to: addr, from: addr, pdf: new Uint8Array([1]), description: 'd', idempotencyKey: 'k', fetchImpl: fake });
    expect(r.id).toBe('ltr_test123');
    expect(seen!.url).toBe('https://api.lob.com/v1/letters');
    const form = seen!.init.body as FormData;
    expect(form.get('return_envelope')).toBe('true');
    expect(form.get('mail_type')).toBe('usps_first_class');
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Basic ' + btoa('test_abc:'));
    await expect(sendLobLetter({ apiKey: 'nope', to: addr, from: addr, pdf: new Uint8Array(), description: '', idempotencyKey: '', fetchImpl: fake })).rejects.toThrow();
  });
});
