import { beforeAll, describe, expect, it } from 'vitest';
import {
  base32Encode, checkChar, codeHash, decodeQr, deriveCode, deriveIssuerKeys, encodeQr, fingerprint, formatCode,
  generatePassphrase, isValidPassphrase, parseTypedCode, type IssuerKeys,
} from '../src/codes.ts';

// A fixed test passphrase (valid BIP39 words and checksum). Never use it for a real election.
const PASS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let keys: IssuerKeys;
beforeAll(async () => {
  keys = await deriveIssuerKeys(PASS, 'agm-2027');
});

describe('passphrase', () => {
  it('generates 12 words that pass their own checksum', () => {
    const p = generatePassphrase();
    expect(p.split(' ')).toHaveLength(12);
    expect(isValidPassphrase(p)).toBe(true);
    expect(generatePassphrase()).not.toBe(p);
  });
  it('catches a mistyped word', async () => {
    const bad = PASS.replace(/about$/, 'abandon');
    expect(isValidPassphrase(bad)).toBe(false);
    await expect(deriveIssuerKeys(bad, 'agm-2027')).rejects.toThrow(/passphrase/);
  });
  it('ignores case and spacing', async () => {
    const k2 = await deriveIssuerKeys('  ' + PASS.toUpperCase().replace(/ /g, '   ') + '\n', 'agm-2027');
    expect(Buffer.from(k2.codeKey).equals(Buffer.from(keys.codeKey))).toBe(true);
  });
});

describe('code derivation', () => {
  it('is deterministic and pinned (a change here breaks every reissue)', async () => {
    const c = deriveCode(keys, 'M001', 1);
    expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(deriveCode(keys, 'M001', 1)).toBe(c);
    expect(c).toMatchInlineSnapshot(`"Y6VYPMD5R82ZEKPW"`);
    expect(fingerprint(keys.signPublicKey)).toMatchInlineSnapshot(`"NEEP PA3A ZNWH 84RH"`);
  });
  it('differs by member, copy number and election', async () => {
    const a = deriveCode(keys, 'M001', 1);
    expect(deriveCode(keys, 'M001', 2)).not.toBe(a);
    expect(deriveCode(keys, 'M002', 1)).not.toBe(a);
    const other = await deriveIssuerKeys(PASS, 'agm-2028');
    expect(deriveCode(other, 'M001', 1)).not.toBe(a);
  });
  it('length-prefixes fields so ids cannot run together', () => {
    expect(deriveCode(keys, 'M00', 11)).not.toBe(deriveCode(keys, 'M001', 1));
  });
  it('hashes per election', () => {
    const c = deriveCode(keys, 'M001', 1);
    expect(codeHash('agm-2027', c)).toMatch(/^[0-9a-f]{64}$/);
    expect(codeHash('agm-2027', c)).not.toBe(codeHash('agm-2028', c));
  });
});

describe('typed codes', () => {
  it('formats in groups with a check character and parses back', () => {
    const c = deriveCode(keys, 'M001', 1);
    const typed = formatCode(c);
    expect(typed).toMatch(/^(.{4}-){4}.$/);
    expect(parseTypedCode(typed)).toEqual({ ok: true, code: c });
    expect(parseTypedCode(typed.toLowerCase().replace(/-/g, ' '))).toEqual({ ok: true, code: c });
  });
  it('reads O as 0 and I or L as 1', () => {
    const code = '0000111100001111';
    const typed = 'OOOO-IIII-oooo-llll-' + checkChar(code);
    expect(parseTypedCode(typed)).toEqual({ ok: true, code });
  });
  it('catches every single wrong character', () => {
    const c = deriveCode(keys, 'M042', 1);
    const full = c + checkChar(c);
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    for (let i = 0; i < full.length; i++) {
      for (const x of alphabet) {
        if (x === full[i]) continue;
        const typo = full.slice(0, i) + x + full.slice(i + 1);
        expect(parseTypedCode(typo).ok).toBe(false);
      }
    }
  });
  it('rejects wrong lengths and characters', () => {
    expect(parseTypedCode('ABC')).toEqual({ ok: false, reason: 'length' });
    expect(parseTypedCode('UUUU-UUUU-UUUU-UUUU-U')).toEqual({ ok: false, reason: 'character' });
  });
  it('encodes base32 like Crockford', () => {
    expect(base32Encode(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]))).toBe('ZZZZZZZZ');
    expect(base32Encode(new Uint8Array([0, 0, 0, 0, 0]))).toBe('00000000');
  });
});

describe('QR payload', () => {
  it('round-trips and never carries a name', () => {
    const p = { electionId: 'agm-2027', styleId: 'owner_w12.5_lp', code: deriveCode(keys, 'M001', 1), page: 1, pages: 2 };
    const s = encodeQr(p);
    expect(s.startsWith('CB1|agm-2027|owner_w12.5_lp|')).toBe(true);
    expect(decodeQr(s)).toEqual(p);
    expect(decodeQr('CB1|agm-2027|full|SHORT|1/1')).toBeNull();
    expect(decodeQr(s.replace('1/2', '3/2'))).toBeNull();
  });
});
