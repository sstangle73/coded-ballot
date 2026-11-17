import { describe, expect, it } from 'vitest';
import { decodeVote, encodeVote, newCountKey, sealedBody, sealVote, unlockVote, TLOCK_PREFIX } from '../src/vote.ts';

const p = { v: 1 as const, styleId: 'full', selections: { chair: ['ana'], 'motion-1': ['yes'] } };

describe('online vote envelope', () => {
  it('pads every vote to the same size whatever was chosen', () => {
    expect(encodeVote(p).length).toBe(512);
    expect(encodeVote({ ...p, selections: {} }).length).toBe(512);
    expect(decodeVote(encodeVote(p))).toEqual(p);
  });
  it('seals to the count key and unlocks on the tellers’ laptop', async () => {
    const k = await newCountKey();
    const stored = `full:${sealedBody(await sealVote(p, k.publicKey))}`;
    expect(await unlockVote(stored, k)).toEqual({ styleId: 'full', selections: p.selections });
  });
  it('refuses a vote whose inner style differs from the one the server recorded', async () => {
    const k = await newCountKey();
    const stored = `owner_w12.5:${sealedBody(await sealVote(p, k.publicKey))}`;
    await expect(unlockVote(stored, k)).rejects.toThrow(/style full inside but owner_w12.5 outside/);
  });
  it('refuses the wrong count key, and needs drand for a time-locked vote', async () => {
    const k = await newCountKey();
    const other = await newCountKey();
    await expect(unlockVote(`full:${sealedBody(await sealVote(p, k.publicKey))}`, other)).rejects.toThrow(/could not be opened/);
    await expect(unlockVote(`full:${TLOCK_PREFIX}xyz`, k)).rejects.toThrow(/time-locked/);
    const sealed = await sealVote(p, k.publicKey);
    expect(await unlockVote(`full:${TLOCK_PREFIX}armored`, k, async () => sealed)).toEqual({ styleId: 'full', selections: p.selections });
  });
});
