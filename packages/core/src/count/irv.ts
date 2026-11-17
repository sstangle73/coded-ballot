// Ranked choice, one winner (instant runoff). Each round, every ballot counts for its highest-ranked name still in
// the race. A name with more than half of those votes wins; otherwise the name with the fewest is eliminated and
// its ballots move to their next choice.
import type { Contest } from '../rules/schema.ts';
import { fmt, sum, ZERO, type Votes } from '../decimal.ts';
import { candidateCheck, listNames, namesFor, plural, sortRecords, TieBreaker, totalsRecord } from './common.ts';
import { NeedsLot, type BallotRecord, type CountContext, type CountResult, type Stage } from './types.ts';

type Irv = Extract<Contest, { method: 'irv' }>;

export function countIrv(records: BallotRecord[], contest: Irv, ctx: CountContext): CountResult {
  const names = namesFor(contest, records);
  const sorted = sortRecords(records, candidateCheck(names, null));
  const explanation: string[] = [];
  const say = (s: string) => explanation.push(s);
  const tb = new TieBreaker(ctx, names, say);
  const continuing = new Set(names.keys());
  const stages: Stage[] = [];
  const history: Map<string, Votes>[] = [];
  const validWeight = sum(sorted.valid.map((r) => r.weight));

  say(
    `Voters ranked the names in order. ${plural(sorted.valid.length, 'valid ballot was', 'valid ballots were')} counted; ` +
      `${plural(sorted.blank, 'ballot')} left this blank and ${plural(sorted.invalid, 'ballot was', 'ballots were')} not valid.`,
  );

  const result: CountResult = {
    contestId: contest.id,
    method: contest.method,
    status: 'complete',
    winners: [],
    ballots: {
      total: records.length,
      valid: sorted.valid.length,
      blank: sorted.blank,
      invalid: sorted.invalid,
      validWeight: fmt(validWeight),
    },
    stages,
    lots: tb.lots,
    explanation,
  };

  for (let round = 1; continuing.size > 0; round++) {
    const totals = new Map<string, Votes>([...continuing].map((c) => [c, ZERO]));
    let exhausted = ZERO;
    for (const r of sorted.valid) {
      const top = r.selection.find((c) => continuing.has(c));
      if (top) totals.set(top, totals.get(top)! + r.weight);
      else exhausted += r.weight;
    }
    const active = sum(totals.values());
    const ordered = [...totals.entries()].sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1));
    say(
      `Round ${round}: ` +
        ordered.map(([id, v]) => `${names.get(id)} ${fmt(v)}`).join(', ') +
        (exhausted > ZERO ? `; ${fmt(exhausted)} on ballots with no names left in the race` : '') +
        `. More than half of ${fmt(active)} is needed to win.`,
    );
    const stage: Stage = { number: round, action: 'count', totals: totalsRecord(totals), exhausted: fmt(exhausted) };
    stages.push(stage);

    const [leader, lead] = ordered[0]!;
    if (lead * 2n > active || continuing.size === 1) {
      if (active === ZERO) {
        say('No ballot has any name left, so nobody is elected.');
        return result;
      }
      stage.elected = [leader];
      result.winners = [leader];
      say(`${names.get(leader)} has ${continuing.size === 1 ? 'the only votes left' : 'more than half'} and is elected.`);
      return result;
    }

    const low = ordered[ordered.length - 1]![1];
    const lowest = ordered.filter(([, v]) => v === low).map(([id]) => id);
    let out: string;
    try {
      out = lowest.length === 1 ? lowest[0]! : tb.pick(`${contest.id}: round ${round} elimination`, lowest, history, 'lowest');
    } catch (e) {
      if (!(e instanceof NeedsLot)) throw e;
      say(`${listNames(lowest, names)} are tied for fewest votes. That is settled by lot, from the first drand round after close.`);
      result.status = 'needs_lot';
      result.pendingTie = { label: e.label, items: e.items };
      return result;
    }
    continuing.delete(out);
    stage.excluded = [out];
    say(`${names.get(out)} has the fewest votes and is eliminated; their ballots move to each voter's next choice.`);
    history.push(totals);
  }
  return result;
}
