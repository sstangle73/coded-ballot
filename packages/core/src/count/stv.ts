// Single transferable vote, following the Scottish rules (The Scottish Local Government Elections Order 2007,
// SSI 2007/42, Schedule 1, rules 45 to 52, read at legislation.gov.uk on 2026-11-16):
//
//  45  First stage: each valid paper goes to its first preference, at a value of one.
//  46  Quota = valid papers / (seats + 1), ignoring decimals, plus one.
//  47  A candidate whose votes equal or exceed the quota is elected.
//  48  A surplus is transferred using every paper the elected candidate holds. Each paper's new value is
//      surplus x (its value when received) / (the candidate's total votes), to five decimal places, any remainder
//      ignored. Papers with no next preference for a continuing candidate are non-transferable.
//  49  The largest surplus goes first; equal surpluses go by who had more votes at the most recent earlier stage
//      where they differed, then by lot.
//  50  With no surplus to transfer, the candidate with the fewest votes is excluded and all their papers move at
//      the value they carry.
//  51  A tie for fewest goes by who had fewer votes at the most recent earlier stage where they differed, then lot.
//  52  When the continuing candidates equal the vacancies left, they are all elected and nothing more is moved.
//
// Weighted ballots: a ballot of weight w counts as w papers, so its value is w x its per-paper value, and the
// five-decimal truncation applies to the per-paper value exactly as it would to w separate papers.
import type { Contest } from '../rules/schema.ts';
import { div, floor, fmt, mul, mulDiv, ONE, sum, truncate, ZERO, type Votes } from '../decimal.ts';
import { candidateCheck, listNames, namesFor, plural, sortRecords, TieBreaker, totalsRecord } from './common.ts';
import { NeedsLot, type BallotRecord, type CountContext, type CountResult, type Stage } from './types.ts';

type Stv = Extract<Contest, { method: 'stv' }>;

interface Paper {
  weight: Votes;
  prefs: string[];
  /** Value of one paper, five decimal places at most. */
  unit: Votes;
  holder: string | null;
}

const DP = 5;

function value(p: Paper): Votes {
  return mul(p.weight, p.unit);
}

export function countStv(records: BallotRecord[], contest: Stv, ctx: CountContext): CountResult {
  const names = namesFor(contest, records);
  const sorted = sortRecords(records, candidateCheck(names, null));
  const explanation: string[] = [];
  const say = (s: string) => explanation.push(s);
  const tb = new TieBreaker(ctx, names, say);
  const seats = contest.seats;

  const continuing = new Set(names.keys());
  const elected: string[] = [];
  const excluded: string[] = [];
  const credited = new Map<string, Votes>([...names.keys()].map((c) => [c, ZERO]));
  const pending: string[] = []; // elected with a surplus not yet transferred
  let nonTransferable = ZERO;
  const stages: Stage[] = [];
  const history: Map<string, Votes>[] = [];

  const papers: Paper[] = sorted.valid.map((r) => ({ weight: r.weight, prefs: r.selection, unit: ONE, holder: null }));
  const validWeight = sum(papers.map((p) => p.weight));
  const quota = floor(div(validWeight, BigInt(seats + 1) * ONE)) + ONE;

  const result: CountResult = {
    contestId: contest.id,
    method: contest.method,
    status: 'complete',
    winners: elected,
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
    quota: fmt(quota),
  };

  say(
    `${seats} seats. Voters ranked the names in order. ${plural(sorted.valid.length, 'valid ballot was', 'valid ballots were')} counted` +
      `; ${plural(sorted.blank, 'ballot')} left this blank and ${plural(sorted.invalid, 'ballot was', 'ballots were')} not valid.`,
  );
  say(
    `The quota is ${fmt(validWeight)} ÷ (${seats} + 1), ignoring any fraction, plus 1 = ${fmt(quota)}. ` +
      `Anyone who reaches the quota is elected.`,
  );

  const nextFor = (p: Paper): string | null => p.prefs.find((c) => continuing.has(c)) ?? null;

  const snapshot = (): Map<string, Votes> => {
    const m = new Map<string, Votes>();
    for (const c of names.keys()) if (!excluded.includes(c)) m.set(c, credited.get(c)!);
    return m;
  };

  const endStage = (action: string, extra: Partial<Stage> = {}) => {
    // rule 47: anyone at or over quota is elected, most votes first
    const newly = [...continuing]
      .filter((c) => credited.get(c)! >= quota)
      .sort((a, b) => (credited.get(b)! > credited.get(a)! ? 1 : credited.get(b)! < credited.get(a)! ? -1 : 0));
    for (const c of newly) {
      if (elected.length >= seats) break;
      continuing.delete(c);
      elected.push(c);
      if (credited.get(c)! > quota) pending.push(c);
    }
    const snap = snapshot();
    stages.push({
      number: stages.length + 1,
      action,
      totals: totalsRecord(snap),
      exhausted: fmt(nonTransferable),
      ...extra,
      ...(newly.length ? { elected: newly.filter((c) => elected.includes(c)) } : {}),
    });
    history.push(snap);
    const ordered = [...snap.entries()].sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1));
    say(
      `After stage ${stages.length}: ` +
        ordered.map(([id, v]) => `${names.get(id)} ${fmt(v)}`).join(', ') +
        (nonTransferable > ZERO ? `; non-transferable ${fmt(nonTransferable)}` : '') +
        '.',
    );
    for (const c of newly) if (elected.includes(c)) say(`${names.get(c)} reached the quota and is elected.`);
  };

  // rule 45: first preferences
  for (const p of papers) {
    const c = nextFor(p);
    if (c) {
      p.holder = c;
      credited.set(c, credited.get(c)! + value(p));
    } else nonTransferable += value(p);
  }
  say('Stage 1: every ballot counts for its first choice, at a value of 1.');
  endStage('first preferences');

  try {
    while (elected.length < seats) {
      const vacancies = seats - elected.length;
      // rule 52
      if (continuing.size <= vacancies) {
        const rest = [...continuing].sort((a, b) =>
          credited.get(b)! > credited.get(a)! ? 1 : credited.get(b)! < credited.get(a)! ? -1 : 0,
        );
        for (const c of rest) {
          continuing.delete(c);
          elected.push(c);
        }
        if (rest.length) {
          say(
            `${plural(rest.length, 'candidate is', 'candidates are')} left for ${plural(vacancies, 'seat')}, so ` +
              `${listNames(rest, names)} ${rest.length === 1 ? 'is' : 'are'} elected without further transfers.`,
          );
          stages[stages.length - 1]!.elected = [...(stages[stages.length - 1]!.elected ?? []), ...rest];
        }
        break;
      }

      if (pending.length) {
        // rules 48 and 49
        const top = pending.reduce((a, b) => (credited.get(b)! > credited.get(a)! ? b : a));
        const tied = pending.filter((c) => credited.get(c) === credited.get(top));
        const from = tied.length === 1 ? top : tb.pick(`${contest.id}: stage ${stages.length + 1} surplus`, tied, history, 'highest');
        pending.splice(pending.indexOf(from), 1);
        const total = credited.get(from)!;
        const surplus = total - quota;
        const moved = new Map<string, Votes>();
        let movedTotal = ZERO;
        for (const p of papers) {
          if (p.holder !== from) continue;
          const to = nextFor(p);
          if (!to) continue; // non-transferable: its share of the surplus is lost
          p.unit = truncate(mulDiv(surplus, p.unit, total), DP);
          p.holder = to;
          const v = value(p);
          moved.set(to, (moved.get(to) ?? ZERO) + v);
          movedTotal += v;
        }
        for (const [c, v] of moved) credited.set(c, credited.get(c)! + v);
        credited.set(from, quota);
        nonTransferable += surplus - movedTotal;
        say(
          `Stage ${stages.length + 1}: ${names.get(from)}'s surplus of ${fmt(surplus)} (votes ${fmt(total)} less the quota) is transferred. ` +
            `Every ballot ${names.get(from)} holds moves to its next choice still in the race, at a value of ` +
            `surplus × its current value ÷ ${fmt(total)}, to five decimal places. ` +
            ([...moved].length
              ? 'Received: ' + [...moved].map(([c, v]) => `${names.get(c)} +${fmt(v)}`).join(', ') + '.'
              : 'No ballot had a next choice, so the surplus is not transferable.') +
            (surplus - movedTotal > ZERO ? ` ${fmt(surplus - movedTotal)} could not be transferred.` : ''),
        );
        endStage(`surplus of ${from}`, { action: `surplus of ${from}` });
        continue;
      }

      // rules 50 and 51
      const cont = [...continuing];
      const low = cont.reduce((a, b) => (credited.get(b)! < credited.get(a)! ? b : a));
      const lowest = cont.filter((c) => credited.get(c) === credited.get(low));
      const out = lowest.length === 1 ? low : tb.pick(`${contest.id}: stage ${stages.length + 1} exclusion`, lowest, history, 'lowest');
      continuing.delete(out);
      excluded.push(out);
      const moved = new Map<string, Votes>();
      let lost = ZERO;
      for (const p of papers) {
        if (p.holder !== out) continue;
        const to = nextFor(p);
        if (!to) {
          lost += value(p);
          p.holder = null;
          continue;
        }
        p.holder = to;
        moved.set(to, (moved.get(to) ?? ZERO) + value(p));
      }
      for (const [c, v] of moved) credited.set(c, credited.get(c)! + v);
      nonTransferable += lost;
      say(
        `Stage ${stages.length + 1}: no surplus is waiting, so ${names.get(out)}, with the fewest votes (${fmt(credited.get(out)!)}), is excluded. ` +
          `Their ballots move to each one's next choice still in the race, at the value each carries. ` +
          ([...moved].length ? 'Received: ' + [...moved].map(([c, v]) => `${names.get(c)} +${fmt(v)}`).join(', ') + '.' : '') +
          (lost > ZERO ? ` ${fmt(lost)} had no further choice.` : ''),
      );
      credited.set(out, ZERO);
      endStage(`exclusion of ${out}`, { excluded: [out] });
    }
  } catch (e) {
    if (!(e instanceof NeedsLot)) throw e;
    say(`${listNames(e.items, names)} are tied and earlier stages don't separate them. That is settled by lot, from the first drand round after close.`);
    result.status = 'needs_lot';
    result.pendingTie = { label: e.label, items: e.items };
    return result;
  }

  say(`Elected, in order: ${listNames(elected, names)}.`);
  return result;
}
