import { beforeAll, describe, expect, it } from 'vitest';
import { closeStatement, signClose, verifyClose } from '../src/close.ts';
import { deriveIssuerKeys, type IssuerKeys } from '../src/codes.ts';
import { toBase64 } from '../src/bytes.ts';

const PASS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
let keys: IssuerKeys;
const locked = [toBase64(new Uint8Array([1, 2, 3])), toBase64(new Uint8Array([4, 5])), toBase64(new Uint8Array([6]))];
beforeAll(async () => {
  keys = await deriveIssuerKeys(PASS, 'agm-2027');
});

describe('signed close', () => {
  it('verifies with the issuer key and the same locked votes', async () => {
    const signed = await signClose(keys, closeStatement('agm-2027', new Date('2027-03-29T23:00:00Z'), locked));
    expect(await verifyClose(signed, keys.signPublicKey, locked)).toEqual({ ok: true, fallback: false });
  });
  it('fails if a vote was added, removed or reordered after close', async () => {
    const signed = await signClose(keys, closeStatement('agm-2027', new Date(), locked));
    expect((await verifyClose(signed, keys.signPublicKey, [...locked, locked[0]!])).ok).toBe(false);
    expect((await verifyClose(signed, keys.signPublicKey, locked.slice(1))).ok).toBe(false);
    expect((await verifyClose(signed, keys.signPublicKey, [...locked].reverse())).ok).toBe(false);
  });
  it('fails if the statement was edited or signed by another key', async () => {
    const signed = await signClose(keys, closeStatement('agm-2027', new Date(), locked));
    const edited = { ...signed, statement: { ...signed.statement, closedAt: '2030-01-01T00:00:00.000Z' } };
    expect((await verifyClose(edited, keys.signPublicKey)).ok).toBe(false);
    const other = await deriveIssuerKeys(PASS, 'agm-2028');
    expect((await verifyClose(signed, other.signPublicKey)).ok).toBe(false);
  });
  it('length-prefixes votes so they cannot be merged', async () => {
    const merged = [toBase64(new Uint8Array([1, 2, 3, 4, 5])), locked[2]!];
    const signed = await signClose(keys, closeStatement('agm-2027', new Date(), locked));
    expect((await verifyClose(signed, keys.signPublicKey, merged)).ok).toBe(false);
  });
  it('marks a fallback close and refuses to sign one', async () => {
    const st = closeStatement('agm-2027', new Date(), locked, true);
    await expect(signClose(keys, st)).rejects.toThrow(/fallback/);
    expect(await verifyClose({ statement: st, signature: null }, keys.signPublicKey, locked)).toEqual({ ok: true, fallback: true });
  });
});
