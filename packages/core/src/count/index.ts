// count(records, contest) -> result + plain-language explanation. One reviewed module per method; organisations
// choose a method in the rules file and never write counting code.
import type { Contest, Rules } from '../rules/schema.ts';
import { cmpFraction, fraction, ONE, votes, type Votes } from '../decimal.ts';
import { styleWeightFor, parseStyleId } from '../eligibility.ts';
import { countPlurality } from './plurality.ts';
import { countYesNo } from './yesno.ts';
import { countIrv } from './irv.ts';
import { countStv } from './stv.ts';
import type { BallotRecord, CountContext, CountResult } from './types.ts';

export * from './types.ts';

export function count(records: BallotRecord[], contest: Contest, ctx: CountContext): CountResult {
  switch (contest.method) {
    case 'plurality':
    case 'approval':
      return countPlurality(records, contest, ctx);
    case 'yes_no':
      return countYesNo(records, contest, ctx);
    case 'irv':
      return countIrv(records, contest, ctx);
    case 'stv':
      return countStv(records, contest, ctx);
  }
}

/** A cast vote record: one ballot, every contest on it. Carries a style, never a code or a time. */
export interface CastVoteRecord {
  styleId: string;
  /** contest ID -> selection (see BallotRecord.selection). A contest left off the record is blank. */
  selections: Record<string, string[]>;
}

/** The records for one contest, each weighted by its style. Ballots whose style doesn't include it are skipped. */
export function recordsFor(rules: Rules, contest: Contest, cvrs: CastVoteRecord[]): BallotRecord[] {
  const out: BallotRecord[] = [];
  for (const cvr of cvrs) {
    const w = styleWeightFor(rules, cvr.styleId, contest);
    if (w === 0n) continue;
    out.push({ weight: w, selection: cvr.selections[contest.id] ?? [] });
  }
  return out;
}

export function contextFor(rules: Rules, extra: Partial<CountContext> = {}): CountContext {
  return { tieBreak: rules.tie_break, ...extra };
}

/** Whether turnout meets the rules file's quorum. ballots: every ballot received, any channel. */
export function quorumMet(rules: Rules, ballots: number, eligibleMembers: number): { met: boolean; text: string } {
  const q = rules.quorum;
  if (!q) return { met: true, text: 'The rules set no quorum.' };
  if ('ballots' in q) {
    const met = ballots >= q.ballots;
    return { met, text: `Quorum: at least ${q.ballots} ballots needed; ${ballots} received, so it was ${met ? '' : 'not '}met.` };
  }
  const f = fraction(q.fraction_of_members);
  const met = cmpFraction(votes(ballots), f, votes(eligibleMembers)) >= 0;
  return {
    met,
    text: `Quorum: at least ${q.fraction_of_members} of ${eligibleMembers} members needed; ${ballots} ballots received, so it was ${met ? '' : 'not '}met.`,
  };
}

// ---- rank grid ------------------------------------------------------------------------------------------------

export type RankIssue =
  | { kind: 'skipped'; rank: number }
  | { kind: 'overvote'; rank: number; candidates: string[] }
  | { kind: 'repeated'; candidate: string; rank: number };

/**
 * Turn a rank grid (candidate -> ranks marked) into a ranking. Skipped ranks are closed up, a candidate marked at
 * more than one rank keeps their highest, and two names at the same rank end the ballot there. Every issue is
 * returned so the tellers' queue can show it; the ranking is what is counted if they accept it.
 */
export function rankGridToRanking(grid: Record<string, number[]>, ranks: number): { ranking: string[]; issues: RankIssue[] } {
  const issues: RankIssue[] = [];
  const ranking: string[] = [];
  const at = new Map<number, string[]>();
  for (const [cand, rs] of Object.entries(grid)) for (const r of rs) at.set(r, [...(at.get(r) ?? []), cand]);
  for (let r = 1; r <= ranks; r++) {
    const c = (at.get(r) ?? []).sort();
    if (c.length === 0) {
      if ([...at.keys()].some((k) => k > r)) issues.push({ kind: 'skipped', rank: r });
      continue;
    }
    if (c.length > 1) {
      issues.push({ kind: 'overvote', rank: r, candidates: c });
      break;
    }
    if (ranking.includes(c[0]!)) {
      issues.push({ kind: 'repeated', candidate: c[0]!, rank: r });
      continue;
    }
    ranking.push(c[0]!);
  }
  return { ranking, issues };
}

// ---- small groups -------------------------------------------------------------------------------------------

export interface SmallGroup {
  styleId: string;
  ballots: number;
}

/**
 * Styles (and so weight groups) with fewer ballots than the threshold. Their results must be published only as
 * combined totals for the questions they share with other styles.
 */
export function smallGroups(cvrs: CastVoteRecord[], threshold: number): SmallGroup[] {
  const n = new Map<string, number>();
  for (const c of cvrs) n.set(c.styleId, (n.get(c.styleId) ?? 0) + 1);
  return [...n]
    .filter(([, k]) => k < threshold)
    .map(([styleId, ballots]) => ({ styleId, ballots }))
    .sort((a, b) => a.styleId.localeCompare(b.styleId));
}

export function weightOfStyle(styleId: string): Votes {
  return votes(parseStyleId(styleId).weight, 4) || ONE;
}
