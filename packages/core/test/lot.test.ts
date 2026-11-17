import { describe, expect, it } from 'vitest';
import { drawLot, firstRoundAfter, lotForClose, randomnessMatchesSignature, roundAt, roundTime } from '../src/lot.ts';

// Round 34027746 of drand quicknet, fetched from api.drand.sh on 2026-11-16.
const ROUND = {
  round: 34027746,
  randomness: '09394c780066d491bfc1b1589a140316a47bccab94614f65a91ce64918d37fa1',
  signature:
    '8b3bfd0d5ba741de12293e5c248e1996e8732ac361c12cc83686a2f8617085cc2590b146d13d1aace633f891020e2366',
};

describe('drand lot', () => {
  it('checks randomness against a real round', () => {
    expect(randomnessMatchesSignature(ROUND.randomness, ROUND.signature)).toBe(true);
    expect(randomnessMatchesSignature(ROUND.randomness.replace(/^0/, '1'), ROUND.signature)).toBe(false);
  });
  it('maps times to rounds', () => {
    const t = roundTime(ROUND.round);
    expect(roundAt(t)).toBe(ROUND.round);
    expect(roundAt(t + 2)).toBe(ROUND.round);
    expect(firstRoundAfter(t)).toBe(ROUND.round + 1);
    expect(firstRoundAfter(t - 1)).toBe(ROUND.round);
  });
  it('draws the same order every time, independent of input order', () => {
    const a = drawLot(ROUND, 'committee: seat 3', ['ana', 'ben', 'cai']);
    const b = drawLot(ROUND, 'committee: seat 3', ['cai', 'ana', 'ben']);
    expect(a.order).toEqual(b.order);
    expect(a.order).toMatchInlineSnapshot(`
      [
        "ana",
        "cai",
        "ben",
      ]
    `);
    expect(drawLot({ ...ROUND, randomness: 'ab'.repeat(32) }, 'x', ['p', 'q']).keys).not.toEqual(drawLot(ROUND, 'x', ['p', 'q']).keys);
  });
  it('accepts only the first round after close, with matching randomness', () => {
    const closedAt = new Date((roundTime(ROUND.round) - 1) * 1000);
    expect(lotForClose(ROUND, closedAt)).toEqual({ round: ROUND.round, randomness: ROUND.randomness });
    expect(() => lotForClose(ROUND, new Date(roundTime(ROUND.round) * 1000))).toThrow(/first after close/);
    expect(() => lotForClose({ ...ROUND, randomness: 'ab'.repeat(32) }, closedAt)).toThrow(/does not match/);
  });
});
