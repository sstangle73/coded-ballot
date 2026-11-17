import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadRules } from '../src/rules/load.ts';
import { paperTotals, summarise, tally } from '../src/tally.ts';
import type { CastVoteRecord } from '../src/count/index.ts';

const { rules } = loadRules(readFileSync(new URL('../../../examples/rules.example.yaml', import.meta.url), 'utf8'));
const full = (chair: string[], committee: string[], motion: string[]): CastVoteRecord => ({ styleId: 'full', selections: { chair, committee, 'motion-1': motion } });

const online = [
  full(['ana'], ['dee', 'eli'], ['yes']),
  full(['ana'], ['dee', 'fay'], ['yes']),
  full(['ana'], ['eli', 'dee'], ['yes']),
  { styleId: 'owner_w3', selections: { boathouse: ['yes'] } },
];
const paper = [full(['ben'], ['fay'], ['yes']), full(['ben'], ['gus', 'dee'], ['no']), full(['cai', 'ana'], ['dee'], ['yes'])];
const styles = [
  { styleId: 'full', n: 10 },
  { styleId: 'owner_w3', n: 1 },
];

describe('tally', () => {
  it('counts every contest from online and paper votes together', () => {
    const t = tally({ rules, online, paper, styles, ballotsReceived: 7 });
    const by = Object.fromEntries(t.contests.map((c) => [c.contestId, c]));
    expect(by.chair!.winnerNames).toEqual(['Ana Example']);
    expect(by['motion-1']!.outcome).toBe('passed'); // 5 of 6 is at least 2/3
    expect(by.boathouse!.outcome).toBe('passed');
    expect(by.committee!.winners).toHaveLength(3);
    expect(t.needsLot).toBe(false);
    expect(t.quorum.met).toBe(true);
    expect(summarise(t)[0]).toBe('Chair: elected Ana Example (6 valid ballots).');
  });

  it('gives the hand count totals from paper only, first preferences for ranked contests', () => {
    expect(paperTotals(rules, paper)).toEqual({
      chair: { ben: '2', cai: '1' },
      committee: { dee: '1', fay: '1', gus: '1' },
      'motion-1': { no: '1', yes: '2' },
      boathouse: {},
    });
  });

  it('flags contests where a ballot group is too small to publish alone', () => {
    const t = tally({ rules, online, paper, styles, ballotsReceived: 7 });
    expect(t.smallGroups).toEqual([{ styleId: 'owner_w3', ballots: 1 }]);
    expect(t.contests.find((c) => c.contestId === 'boathouse')!.smallGroupNote).toMatch(/fewer than 5 ballots/);
    expect(t.contests.find((c) => c.contestId === 'chair')!.smallGroupNote).toBeUndefined();
  });

  it('waits for the drand round when a tie needs a lot, then finishes with it', () => {
    const tied = [full(['ana'], [], []), full(['ben'], [], [])];
    const t = tally({ rules, online: tied, paper: [], styles, ballotsReceived: 2 });
    expect(t.needsLot).toBe(true);
    const lot = { round: 12345, randomness: 'ab'.repeat(32) };
    const done = tally({ rules, online: tied, paper: [], styles, ballotsReceived: 2, lot });
    const chair = done.contests.find((c) => c.contestId === 'chair')!;
    expect(chair.status).toBe('complete');
    expect(chair.lots[0]!.round).toBe(12345);
    expect(done.quorum.met).toBe(true); // 2 of 10 members is at least 1/10
  });
});
