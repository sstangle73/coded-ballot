// Plurality (one or more seats) and approval: each valid ballot gives its weight to every name it marks, and the
// names with the most votes take the seats. They differ only in how many names a ballot may mark.
import type { Contest } from '../rules/schema.ts';
import { fmt, sum, ZERO, type Votes } from '../decimal.ts';
import { candidateCheck, listNames, namesFor, plural, sortRecords, TieBreaker, totalsRecord } from './common.ts';
import { NeedsLot, type BallotRecord, type CountContext, type CountResult } from './types.ts';

type MarkContest = Extract<Contest, { method: 'plurality' | 'approval' }>;

export function countPlurality(records: BallotRecord[], contest: MarkContest, ctx: CountContext): CountResult {
  const names = namesFor(contest, records);
  const seats = contest.seats;
  const maxMarks = contest.method === 'plurality' ? seats : (contest.max_approvals ?? null);
  const sorted = sortRecords(records, candidateCheck(names, maxMarks));
  const explanation: string[] = [];
  const say = (s: string) => explanation.push(s);
  const tb = new TieBreaker(ctx, names, say);

  const totals = new Map<string, Votes>([...names.keys()].map((k) => [k, ZERO]));
  for (const r of sorted.valid) for (const s of r.selection) totals.set(s, totals.get(s)! + r.weight);

  const validWeight = sum(sorted.valid.map((r) => r.weight));
  const how =
    contest.method === 'plurality'
      ? seats === 1
        ? 'Each ballot could mark one name.'
        : `Each ballot could mark up to ${seats} names.`
      : maxMarks === null
        ? 'Each ballot could mark as many names as the voter approved of.'
        : `Each ballot could mark up to ${maxMarks} names.`;
  say(
    `${how} ${plural(sorted.valid.length, 'valid ballot was', 'valid ballots were')} counted` +
      (records.some((r) => r.weight !== 10n ** 9n) ? ` with a total weight of ${fmt(validWeight)}` : '') +
      `; ${plural(sorted.blank, 'ballot')} left this blank and ${plural(sorted.invalid, 'ballot was', 'ballots were')} not valid` +
      (sorted.invalid ? ` (${[...sorted.invalidReasons].map(([k, v]) => `${v}: ${k}`).join('; ')})` : '') +
      '.',
  );
  const ranked = [...totals.entries()].sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1));
  say('Votes for each name: ' + ranked.map(([id, v]) => `${names.get(id)} ${fmt(v)}`).join(', ') + '.');

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
    stages: [{ number: 1, action: 'count', totals: totalsRecord(totals) }],
    lots: tb.lots,
    explanation,
  };

  const winners: string[] = [];
  let i = 0;
  while (winners.length < seats && i < ranked.length) {
    const v = ranked[i]![1];
    const group = ranked.filter(([, x]) => x === v).map(([id]) => id);
    const room = seats - winners.length;
    if (v === ZERO) break;
    if (group.length <= room) winners.push(...group);
    else {
      try {
        winners.push(...tb.draw(`${contest.id}: seat ${winners.length + 1}`, group).slice(0, room));
      } catch (e) {
        if (!(e instanceof NeedsLot)) throw e;
        say(`${listNames(group, names)} are tied for the last ${plural(room, 'seat')}. That is settled by lot, from the first drand round after close.`);
        result.winners = winners;
        result.status = 'needs_lot';
        result.pendingTie = { label: e.label, items: e.items };
        return result;
      }
    }
    i += group.length;
  }
  result.winners = winners;
  if (winners.length < seats) say(`Only ${plural(winners.length, 'name')} received any votes, so ${seats - winners.length} seat(s) stay empty.`);
  say(winners.length ? `Elected: ${listNames(winners, names)}.` : 'Nobody was elected.');
  return result;
}
