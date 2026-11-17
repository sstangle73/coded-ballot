// The whole count for an election: every contest from the online and paper cast vote records, the paper-only totals
// the tellers' hand count must match, small-group warnings and quorum. The tellers' app runs this on the teller's
// own device; anyone can run it again from the published data to check the online part.
import type { Contest, Rules } from './rules/schema.ts';
import { styleWeightFor, parseStyleId } from './eligibility.ts';
import { count, contextFor, quorumMet, recordsFor, smallGroups, type CastVoteRecord, type CountResult, type SmallGroup } from './count/index.ts';
import type { LotSource } from './lot.ts';
import type { Votes } from './decimal.ts';

export interface ContestOutcome extends CountResult {
  title: string;
  winnerNames: string[];
  /** Set when a ballot group too small to publish on its own voted in this contest. */
  smallGroupNote?: string;
}

export interface TallyInput {
  rules: Rules;
  online: CastVoteRecord[];
  /** Paper records after adjudication (rejected ones left out). */
  paper: CastVoteRecord[];
  /** Ballot styles of every code still valid (not replaced), with how many: the electorate. */
  styles: { styleId: string; n: number }[];
  /** Every ballot received on any channel, for quorum. */
  ballotsReceived: number;
  lot?: LotSource;
}

export interface Tally {
  contests: ContestOutcome[];
  /** contest ID -> option ID -> count of paper ballots marking it (first preferences for ranked contests). */
  paperTotals: Record<string, Record<string, string>>;
  smallGroups: SmallGroup[];
  quorum: { met: boolean; text: string };
  /** A tie needs the drand round after close: fetch it and count again with `lot`. */
  needsLot: boolean;
}

/** What a hand count of the paper finds: unweighted marks per option, first preferences for ranked contests. */
export function paperTotals(rules: Rules, paper: CastVoteRecord[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const c of rules.contests) {
    const t: Record<string, number> = {};
    for (const r of paper) {
      if (styleWeightFor(rules, r.styleId, c) === 0n) continue;
      const s = r.selections[c.id] ?? [];
      const counted = c.method === 'irv' || c.method === 'stv' ? s.slice(0, 1) : s;
      for (const o of counted) t[o] = (t[o] ?? 0) + 1;
    }
    out[c.id] = Object.fromEntries(Object.entries(t).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, String(v)]));
  }
  return out;
}

function nameOf(c: Contest, id: string): string {
  if (c.method === 'yes_no') return id[0]!.toUpperCase() + id.slice(1);
  if (id.startsWith('write-in:')) return `${id.slice(9)} (write-in)`;
  return c.candidates.find((x) => x.id === id)?.name ?? id;
}

export function tally(input: TallyInput): Tally {
  const { rules } = input;
  const all = [...input.online, ...input.paper];
  const small = smallGroups(all, rules.small_group_threshold);
  const smallIds = new Set(small.map((g) => g.styleId));
  const contests = rules.contests.map((contest): ContestOutcome => {
    let weight: Votes = 0n;
    for (const s of input.styles) weight += styleWeightFor(rules, s.styleId, contest) * BigInt(s.n);
    const result = count(recordsFor(rules, contest, all), contest, contextFor(rules, { lot: input.lot, electorateWeight: weight }));
    const smallHere = [...smallIds].filter((id) => styleWeightFor(rules, id, contest) > 0n);
    return {
      ...result,
      title: contest.title,
      winnerNames: result.winners.map((w) => nameOf(contest, w)),
      smallGroupNote: smallHere.length
        ? `${smallHere.length === 1 ? 'One ballot group' : `${smallHere.length} ballot groups`} in this contest had fewer than ${rules.small_group_threshold} ballots. Only these combined totals are published.`
        : undefined,
    };
  });
  const members = input.styles.filter((s) => !parseStyleId(s.styleId).provisional).reduce((a, s) => a + s.n, 0);
  return {
    contests,
    paperTotals: paperTotals(rules, input.paper),
    smallGroups: small,
    quorum: quorumMet(rules, input.ballotsReceived, members),
    needsLot: contests.some((c) => c.status === 'needs_lot'),
  };
}

/** A plain summary line per contest, for the teller report. */
export function summarise(t: Tally): string[] {
  return t.contests.map((c) => {
    if (c.status === 'needs_lot') return `${c.title}: waiting for the drand round to break a tie.`;
    if (c.outcome) return `${c.title}: ${c.outcome === 'passed' ? 'passed' : 'did not pass'} (${c.ballots.valid} valid ballots, weight ${c.ballots.validWeight}).`;
    return `${c.title}: elected ${c.winnerNames.join(', ') || 'nobody'} (${c.ballots.valid} valid ballots).`;
  });
}

