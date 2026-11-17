import { describe, expect, it } from 'vitest';
import { Contest } from '../src/rules/schema.ts';
import { count, rankGridToRanking, smallGroups, quorumMet, recordsFor, contextFor, type CastVoteRecord } from '../src/count/index.ts';
import type { BallotRecord, CountContext } from '../src/count/types.ts';
import { ONE, votes } from '../src/decimal.ts';
import { loadRules } from '../src/rules/load.ts';
import { readFileSync } from 'node:fs';

const LOT = { round: 34027746, randomness: '09394c780066d491bfc1b1589a140316a47bccab94614f65a91ce64918d37fa1' };
const ctx: CountContext = { tieBreak: ['previous_rounds', 'lot'] };
const withLot: CountContext = { ...ctx, lot: LOT };

const cands = (...ids: string[]) => ids.map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }));
const contest = (x: object) => Contest.parse({ id: 'c', title: 'C', ...x });
/** n ballots with the same selection, weight 1. */
const b = (n: number, ...selection: string[]): BallotRecord[] => Array.from({ length: n }, () => ({ weight: ONE, selection }));

describe('plurality', () => {
  const c1 = contest({ method: 'plurality', candidates: cands('ana', 'ben', 'cai') });
  it('elects the most votes and explains it', () => {
    const r = count([...b(5, 'ana'), ...b(3, 'ben'), ...b(2), ...b(1, 'ana', 'ben')], c1, ctx);
    expect(r.winners).toEqual(['ana']);
    expect(r.ballots).toMatchObject({ total: 11, valid: 8, blank: 2, invalid: 1 });
    expect(r.stages[0]!.totals).toEqual({ ana: '5', ben: '3', cai: '0' });
    expect(r.explanation.join(' ')).toMatch(/more than 1 marked/);
  });
  it('fills several seats and settles a boundary tie by lot', () => {
    const c2 = contest({ method: 'plurality', seats: 2, candidates: cands('ana', 'ben', 'cai') });
    const recs = [...b(4, 'ana', 'ben'), ...b(2, 'ana', 'cai'), ...b(2, 'cai')];
    const pending = count(recs, c2, ctx);
    expect(pending.status).toBe('needs_lot');
    expect(pending.winners).toEqual(['ana']);
    expect(pending.pendingTie!.items.sort()).toEqual(['ben', 'cai']);
    const done = count(recs, c2, withLot);
    expect(done.status).toBe('complete');
    expect(done.winners).toHaveLength(2);
    expect(done.lots).toHaveLength(1);
  });
  it('counts weights and write-ins', () => {
    const c3 = contest({ method: 'plurality', candidates: cands('ana'), write_ins: true });
    const r = count([{ weight: votes('12.5'), selection: ['write-in:Zed'] }, { weight: votes(3), selection: ['ana'] }], c3, ctx);
    expect(r.winners).toEqual(['write-in:Zed']);
    expect(r.ballots.validWeight).toBe('15.5');
  });
});

describe('approval', () => {
  it('lets a ballot mark many and elects the most approved', () => {
    const c = contest({ method: 'approval', candidates: cands('ana', 'ben', 'cai') });
    const r = count([...b(3, 'ana', 'ben', 'cai'), ...b(2, 'ben'), ...b(1, 'cai', 'ana')], c, ctx);
    expect(r.stages[0]!.totals).toEqual({ ana: '4', ben: '5', cai: '4' });
    expect(r.winners).toEqual(['ben']);
  });
});

describe('yes/no', () => {
  const twoThirds = contest({ method: 'yes_no', threshold: { fraction: '2/3', rule: 'at_least' } });
  it('passes at exactly two-thirds with at_least', () => {
    const r = count([...b(20, 'yes'), ...b(10, 'no'), ...b(5, 'abstain')], twoThirds, ctx);
    expect(r.outcome).toBe('passed');
    expect(r.explanation.join(' ')).toMatch(/2\/3 of 30 is 20/);
  });
  it('fails one short, and with abstentions counted', () => {
    expect(count([...b(19, 'yes'), ...b(10, 'no')], twoThirds, ctx).outcome).toBe('failed');
    const withAbst = contest({ method: 'yes_no', threshold: { fraction: '2/3', rule: 'at_least', abstain_counts: true } });
    expect(count([...b(20, 'yes'), ...b(10, 'no'), ...b(5, 'abstain')], withAbst, ctx).outcome).toBe('failed');
  });
  it('a simple majority fails on a tie', () => {
    const maj = contest({ method: 'yes_no' });
    expect(count([...b(5, 'yes'), ...b(5, 'no')], maj, ctx).outcome).toBe('failed');
    expect(count([...b(6, 'yes'), ...b(5, 'no')], maj, ctx).outcome).toBe('passed');
  });
  it('can need a share of all members, weighted', () => {
    const ofMembers = contest({ method: 'yes_no', weighted: true, threshold: { fraction: '1/2', of: 'members' } });
    const recs = [{ weight: votes('12.5'), selection: ['yes'] }, { weight: votes(3), selection: ['no'] }];
    expect(count(recs, ofMembers, { ...ctx, electorateWeight: votes(26) }).outcome).toBe('failed');
    expect(count(recs, ofMembers, { ...ctx, electorateWeight: votes(24) }).outcome).toBe('passed');
  });
  it('rejects two answers', () => {
    const r = count(b(1, 'yes', 'no'), contest({ method: 'yes_no' }), ctx);
    expect(r.ballots.invalid).toBe(1);
  });
});

describe('IRV', () => {
  // The textbook Tennessee example: Memphis leads on first choices but Knoxville wins.
  const tn = contest({ method: 'irv', candidates: cands('memphis', 'nashville', 'chattanooga', 'knoxville') });
  const recs = [
    ...b(42, 'memphis', 'nashville', 'chattanooga', 'knoxville'),
    ...b(26, 'nashville', 'chattanooga', 'knoxville', 'memphis'),
    ...b(15, 'chattanooga', 'knoxville', 'nashville', 'memphis'),
    ...b(17, 'knoxville', 'chattanooga', 'nashville', 'memphis'),
  ];
  it('runs rounds until someone has more than half', () => {
    const r = count(recs, tn, ctx);
    expect(r.winners).toEqual(['knoxville']);
    expect(r.stages.map((s) => s.excluded?.[0] ?? null)).toEqual(['chattanooga', 'nashville', null]);
    expect(r.stages[2]!.totals).toEqual({ memphis: '42', knoxville: '58' });
    expect(r.explanation[r.explanation.length - 1]).toMatch(/Knoxville has more than half/);
  });
  it('breaks a tie for last by an earlier round, then by lot', () => {
    const c = contest({ method: 'irv', candidates: cands('ana', 'ben', 'cai', 'dee') });
    // round 1: ana 5, ben 3, cai 2, dee 2 -> cai/dee tied with no earlier round: lot
    const tie = [...b(5, 'ana'), ...b(3, 'ben'), ...b(2, 'cai', 'ben'), ...b(2, 'dee', 'ben')];
    expect(count(tie, c, ctx).status).toBe('needs_lot');
    const r = count(tie, c, withLot);
    expect(r.status).toBe('complete');
    expect(r.winners).toEqual(['ben']);
    // round 2 tie broken by round 1: ana 4 ben 3 cai 3 (cai had 2 earlier? no) - build one that needs history
    const hist = [...b(6, 'ana'), ...b(4, 'ben'), ...b(3, 'cai'), ...b(1, 'dee', 'ben')];
    // round 1: ana 6, ben 4, cai 3, dee 1 -> dee out; round 2: ana 6, ben 5, cai 3 -> cai out; round 3 ana 6, ben 5
    const h = count(hist, c, ctx);
    expect(h.winners).toEqual(['ana']);
    const hist2 = [...b(5, 'ana'), ...b(3, 'ben', 'ana'), ...b(4, 'cai', 'ana'), ...b(1, 'dee', 'ben'), ...b(4, 'eve')];
    const c5 = contest({ method: 'irv', candidates: cands('ana', 'ben', 'cai', 'dee', 'eve') });
    // r1: ana5 ben3 cai4 dee1 eve4 -> dee out; r2: ana5 ben4 cai4 eve4 -> 3-way tie; r1 had ben3 < cai4 = eve4 -> ben out
    const r2 = count(hist2, c5, ctx);
    expect(r2.stages[1]!.excluded).toEqual(['ben']);
    expect(r2.explanation.join(' ')).toMatch(/At stage 1, the most recent earlier stage where they differed/);
  });
});

describe('STV (Scottish rules)', () => {
  // The worked example from Wikipedia's "Single transferable vote" article (20 voters, 3 seats), checked by hand
  // against SSI 2007/42 rules 45-52.
  const food = contest({ method: 'stv', seats: 3, candidates: cands('orange', 'pear', 'chocolate', 'strawberry', 'bonbon') });
  const recs = [
    ...b(4, 'orange'),
    ...b(2, 'pear', 'orange'),
    ...b(8, 'chocolate', 'strawberry'),
    ...b(4, 'chocolate', 'bonbon'),
    ...b(1, 'strawberry'),
    ...b(1, 'bonbon'),
  ];
  it('elects chocolate, orange and strawberry, stage by stage', () => {
    const r = count(recs, food, ctx);
    expect(r.quota).toBe('6');
    expect(r.winners).toEqual(['chocolate', 'orange', 'strawberry']);
    expect(r.stages[0]!.totals).toMatchObject({ chocolate: '12', orange: '4', pear: '2', strawberry: '1', bonbon: '1' });
    expect(r.stages[1]!.totals).toMatchObject({ chocolate: '6', strawberry: '5', bonbon: '3' });
    expect(r.stages[2]!.excluded).toEqual(['pear']);
    expect(r.stages[2]!.elected).toEqual(['orange']);
    expect(r.stages[3]!.excluded).toEqual(['bonbon']);
    expect(r.stages[3]!.elected).toEqual(['strawberry']);
  });
  it('gives the same result when identical ballots are grouped by weight', () => {
    const grouped: BallotRecord[] = [
      { weight: votes(4), selection: ['orange'] },
      { weight: votes(2), selection: ['pear', 'orange'] },
      { weight: votes(8), selection: ['chocolate', 'strawberry'] },
      { weight: votes(4), selection: ['chocolate', 'bonbon'] },
      { weight: votes(1), selection: ['strawberry'] },
      { weight: votes(1), selection: ['bonbon'] },
    ];
    const a = count(recs, food, ctx);
    const g = count(grouped, food, ctx);
    expect(g.stages.map((s) => s.totals)).toEqual(a.stages.map((s) => s.totals));
    expect(g.winners).toEqual(a.winners);
  });
  it('truncates transfer values to five places and records what is lost', () => {
    const c = contest({ method: 'stv', seats: 2, candidates: cands('ana', 'ben', 'cai', 'dee') });
    const r = count([...b(7, 'ana', 'ben'), ...b(2, 'cai'), ...b(2, 'dee')], c, withLot);
    expect(r.quota).toBe('4'); // 11 / 3 = 3.67, ignore the fraction, plus 1
    // surplus 3 over 7 votes: 3/7 = 0.428571... -> 0.42857 per ballot; 7 x 0.42857 = 2.99999
    expect(r.stages[1]!.totals).toMatchObject({ ana: '4', ben: '2.99999' });
    expect(r.stages[1]!.exhausted).toBe('0.00001');
    // cai and dee are tied at every stage, so one is excluded by lot; then ben wins the last seat under rule 52
    expect(r.lots).toHaveLength(1);
    expect(r.winners).toEqual(['ana', 'ben']);
    expect(count([...b(7, 'ana', 'ben'), ...b(2, 'cai'), ...b(2, 'dee')], c, ctx).status).toBe('needs_lot');
  });
  it('elects everyone left when candidates equal seats', () => {
    const c = contest({ method: 'stv', seats: 2, candidates: cands('ana', 'ben') });
    expect(count(b(3, 'ana'), c, ctx).winners).toEqual(['ana', 'ben']);
  });
  it('transfers the largest surplus first', () => {
    const c = contest({ method: 'stv', seats: 3, candidates: cands('ana', 'ben', 'cai', 'dee') });
    // 20 ballots, quota 6: ana 9, ben 7 both elected at stage 1; ana's surplus (3) goes first
    const r = count([...b(9, 'ana', 'cai'), ...b(7, 'ben', 'dee'), ...b(2, 'cai'), ...b(2, 'dee')], c, ctx);
    expect(r.stages[1]!.action).toBe('surplus of ana');
    expect(r.stages[2]!.action).toBe('surplus of ben');
  });
});

describe('rank grid, quorum, small groups and records', () => {
  it('normalises a rank grid and lists its issues', () => {
    expect(rankGridToRanking({ ana: [1], ben: [3], cai: [] }, 3)).toEqual({ ranking: ['ana', 'ben'], issues: [{ kind: 'skipped', rank: 2 }] });
    expect(rankGridToRanking({ ana: [1], ben: [2], cai: [2] }, 3)).toEqual({
      ranking: ['ana'],
      issues: [{ kind: 'overvote', rank: 2, candidates: ['ben', 'cai'] }],
    });
    expect(rankGridToRanking({ ana: [1, 2], ben: [3] }, 3)).toEqual({
      ranking: ['ana', 'ben'],
      issues: [{ kind: 'repeated', candidate: 'ana', rank: 2 }],
    });
  });
  const { rules } = loadRules(readFileSync(new URL('../../../examples/rules.example.yaml', import.meta.url), 'utf8'));
  it('checks quorum', () => {
    expect(quorumMet(rules, 10, 100).met).toBe(true);
    expect(quorumMet(rules, 9, 100).met).toBe(false);
  });
  it('flags styles with fewer than the threshold of ballots', () => {
    const cvrs = [
      ...Array.from({ length: 6 }, () => ({ styleId: 'full', selections: {} })),
      ...Array.from({ length: 2 }, () => ({ styleId: 'owner_w3', selections: {} })),
    ];
    expect(smallGroups(cvrs, rules.small_group_threshold)).toEqual([{ styleId: 'owner_w3', ballots: 2 }]);
  });
  it('builds weighted records per contest from cast vote records', () => {
    const roof = rules.contests.find((c) => c.id === 'boathouse')!;
    const cvrs: CastVoteRecord[] = [
      { styleId: 'owner_w12.5', selections: { boathouse: ['yes'] } },
      { styleId: 'owner_w3', selections: { boathouse: ['no'] } },
      { styleId: 'full', selections: { chair: ['ana'] } },
    ];
    const recs = recordsFor(rules, roof, cvrs);
    expect(recs).toHaveLength(2);
    expect(count(recs, roof, contextFor(rules)).outcome).toBe('passed');
  });
});
