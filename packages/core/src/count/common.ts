import type { Contest } from '../rules/schema.ts';
import { fmt, ZERO, type Votes } from '../decimal.ts';
import { drawLot, type LotDraw } from '../lot.ts';
import { NeedsLot, type BallotRecord, type CountContext } from './types.ts';

export const WRITE_IN = 'write-in:';

export type CandidateContest = Extract<Contest, { candidates: unknown }>;

/** Display names, including any write-ins that appear in the records. */
export function namesFor(contest: Contest, records: BallotRecord[]): Map<string, string> {
  const names = new Map<string, string>();
  if ('candidates' in contest) for (const c of contest.candidates) names.set(c.id, c.name);
  if ('write_ins' in contest && contest.write_ins) {
    for (const r of records)
      for (const s of r.selection) if (s.startsWith(WRITE_IN) && !names.has(s)) names.set(s, `${s.slice(WRITE_IN.length)} (write-in)`);
  }
  return names;
}

export interface Sorted {
  valid: BallotRecord[];
  blank: number;
  invalid: number;
  invalidReasons: Map<string, number>;
}

/** Split records into valid, blank and invalid, using a per-method check. */
export function sortRecords(records: BallotRecord[], check: (r: BallotRecord) => string | null): Sorted {
  const out: Sorted = { valid: [], blank: 0, invalid: 0, invalidReasons: new Map() };
  for (const r of records) {
    if (r.weight <= ZERO) continue;
    if (r.selection.length === 0) {
      out.blank++;
      continue;
    }
    const why = check(r);
    if (why) {
      out.invalid++;
      out.invalidReasons.set(why, (out.invalidReasons.get(why) ?? 0) + 1);
    } else out.valid.push(r);
  }
  return out;
}

export function candidateCheck(names: Map<string, string>, maxSelections: number | null) {
  return (r: BallotRecord): string | null => {
    if (new Set(r.selection).size !== r.selection.length) return 'the same name marked twice';
    for (const s of r.selection) if (!names.has(s)) return 'a name not on the ballot';
    if (maxSelections !== null && r.selection.length > maxSelections) return `more than ${maxSelections} marked`;
    return null;
  };
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function listNames(ids: string[], names: Map<string, string>): string {
  const ns = ids.map((i) => names.get(i) ?? i);
  if (ns.length <= 1) return ns.join('');
  return ns.slice(0, -1).join(', ') + ' and ' + ns[ns.length - 1];
}

export function totalsRecord(m: Map<string, Votes>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of m) out[k] = fmt(v);
  return out;
}

/**
 * Settles ties by the rules file's tie_break order. previous_rounds looks back from the most recent earlier stage
 * to the first one where the tied candidates' votes differed; lot draws from the drand round after close.
 */
export class TieBreaker {
  readonly lots: LotDraw[] = [];

  private readonly ctx: CountContext;
  private readonly names: Map<string, string>;
  private readonly explain: (line: string) => void;

  constructor(ctx: CountContext, names: Map<string, string>, explain: (line: string) => void) {
    this.ctx = ctx;
    this.names = names;
    this.explain = explain;
  }

  /**
   * Choose one of `tied`. prefer 'lowest' (who is excluded) or 'highest' (whose surplus goes first, who wins).
   * history: totals at the end of each earlier stage, oldest first.
   */
  pick(label: string, tied: string[], history: Map<string, Votes>[], prefer: 'lowest' | 'highest'): string {
    let left = [...tied];
    for (const step of this.ctx.tieBreak) {
      if (left.length === 1) break;
      if (step === 'previous_rounds') {
        for (let i = history.length - 1; i >= 0 && left.length > 1; i--) {
          const h = history[i]!;
          const vals = left.map((c) => h.get(c) ?? ZERO);
          const target = vals.reduce((a, b) => (prefer === 'lowest' ? (b < a ? b : a) : b > a ? b : a));
          const narrowed = left.filter((_, j) => vals[j] === target);
          if (narrowed.length < left.length) {
            this.explain(
              `${listNames(left, this.names)} were tied. At stage ${i + 1}, the most recent earlier stage where they differed, ` +
                `${listNames(narrowed, this.names)} had the ${prefer} number of votes (${fmt(target)}).`,
            );
            left = narrowed;
            break;
          }
        }
      } else {
        left = [this.draw(label, left)[0]!];
      }
    }
    if (left.length > 1) throw new NeedsLot(label, left);
    return left[0]!;
  }

  /** Put tied candidates in lot order (for a seat boundary in plurality and approval). */
  draw(label: string, tied: string[]): string[] {
    if (!this.ctx.tieBreak.includes('lot')) throw new NeedsLot(label, tied);
    if (!this.ctx.lot) throw new NeedsLot(label, tied);
    const d = drawLot(this.ctx.lot, label, tied);
    this.lots.push(d);
    this.explain(
      `${listNames(tied, this.names)} were tied, so they were put in order by lot using drand round ${d.round}: ` +
        `${listNames(d.order, this.names)}. Anyone can repeat this draw.`,
    );
    return d.order;
  }
}
