import type { Votes } from '../decimal.ts';
import type { LotDraw, LotSource } from '../lot.ts';

/** One ballot's marks in one contest, after adjudication. */
export interface BallotRecord {
  /** 1 unless the contest is weighted. */
  weight: Votes;
  /**
   * Plurality and approval: the chosen candidate IDs. Yes/no: ["yes"], ["no"] or ["abstain"]. Ranked: candidate IDs
   * in order of preference. Empty is a blank ballot. Write-ins are "write-in:<name>".
   */
  selection: string[];
}

export type TieBreakStep = 'previous_rounds' | 'lot';

export interface CountContext {
  tieBreak: TieBreakStep[];
  /** The first drand round after close. Without it, a tie that needs a lot leaves the count at needs_lot. */
  lot?: LotSource;
  /** Total eligible weight, for yes/no thresholds "of members". */
  electorateWeight?: Votes;
}

export interface Stage {
  number: number;
  /** What happened at this stage, in a few words. */
  action: string;
  /** Each continuing or elected candidate's votes at the end of the stage. */
  totals: Record<string, string>;
  exhausted?: string;
  elected?: string[];
  excluded?: string[];
}

export interface CountResult {
  contestId: string;
  method: string;
  status: 'complete' | 'needs_lot';
  /** Winners in the order they were elected; for yes/no, ["yes"] if it passed. */
  winners: string[];
  outcome?: 'passed' | 'failed';
  ballots: { total: number; valid: number; blank: number; invalid: number; validWeight: string };
  stages: Stage[];
  lots: LotDraw[];
  /** Plain-language, step-by-step explanation a member can follow. */
  explanation: string[];
  /** When status is needs_lot: the names that are tied, waiting for the draw. */
  pendingTie?: { label: string; items: string[] };
  quota?: string;
}

export class NeedsLot extends Error {
  readonly label: string;
  readonly items: string[];
  constructor(label: string, items: string[]) {
    super(`tie needs a lot: ${label}`);
    this.label = label;
    this.items = items;
  }
}
