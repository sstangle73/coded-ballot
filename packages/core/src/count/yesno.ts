// Yes/no with any threshold: a share (1/2, 2/3, ...) of votes cast or of all eligible members, needed "more than"
// or "at least". Compared exactly, with weights.
import type { Contest } from '../rules/schema.ts';
import { cmpFraction, fmt, fraction, ZERO, type Votes } from '../decimal.ts';
import { plural, sortRecords } from './common.ts';
import type { BallotRecord, CountContext, CountResult } from './types.ts';

type YesNo = Extract<Contest, { method: 'yes_no' }>;

export function countYesNo(records: BallotRecord[], contest: YesNo, ctx: CountContext): CountResult {
  const allowed = new Set(['yes', 'no', ...(contest.allow_abstain ? ['abstain'] : [])]);
  const sorted = sortRecords(records, (r) =>
    r.selection.length > 1 ? 'more than one answer marked' : allowed.has(r.selection[0]!) ? null : 'not a valid answer',
  );
  const t = new Map<string, Votes>([
    ['yes', ZERO],
    ['no', ZERO],
    ['abstain', ZERO],
  ]);
  for (const r of sorted.valid) t.set(r.selection[0]!, t.get(r.selection[0]!)! + r.weight);
  const yes = t.get('yes')!;
  const no = t.get('no')!;
  const abstain = t.get('abstain')!;
  const th = contest.threshold;
  const frac = fraction(th.fraction);
  const explanation: string[] = [];
  const say = (s: string) => explanation.push(s);

  let base: Votes;
  let baseText: string;
  if (th.of === 'members') {
    if (ctx.electorateWeight === undefined) throw new Error('a threshold of members needs the electorate weight');
    base = ctx.electorateWeight;
    baseText = `all ${fmt(base)} eligible votes, whether cast or not`;
  } else {
    base = yes + no + (th.abstain_counts ? abstain : ZERO);
    baseText = th.abstain_counts ? `votes cast including abstentions (${fmt(base)})` : `yes and no votes cast (${fmt(base)})`;
  }
  const c = cmpFraction(yes, frac, base);
  const passed = base > ZERO && (th.rule === 'at_least' ? c >= 0 : c > 0);

  say(
    `Yes ${fmt(yes)}, no ${fmt(no)}` +
      (contest.allow_abstain ? `, abstain ${fmt(abstain)}` : '') +
      `. ${plural(sorted.blank, 'ballot')} left this blank and ${plural(sorted.invalid, 'ballot was', 'ballots were')} not valid.`,
  );
  say(
    `To pass, yes needed ${th.rule === 'at_least' ? 'at least' : 'more than'} ${th.fraction} of ${baseText}. ` +
      `${th.fraction} of ${fmt(base)} is ${fmtRatio(frac.num * base, frac.den)}; yes had ${fmt(yes)}, so it ${passed ? 'PASSED' : 'FAILED'}.`,
  );

  return {
    contestId: contest.id,
    method: contest.method,
    status: 'complete',
    winners: passed ? ['yes'] : [],
    outcome: passed ? 'passed' : 'failed',
    ballots: {
      total: records.length,
      valid: sorted.valid.length,
      blank: sorted.blank,
      invalid: sorted.invalid,
      validWeight: fmt(yes + no + abstain),
    },
    stages: [{ number: 1, action: 'count', totals: { yes: fmt(yes), no: fmt(no), abstain: fmt(abstain) } }],
    lots: [],
    explanation,
  };
}

/** num / den shown to five decimal places, truncated, with an ellipsis when it doesn't end. */
function fmtRatio(numScaled: bigint, den: bigint): string {
  const q = numScaled / den;
  const exact = q * den === numScaled;
  const shown = fmt((q / 10_000n) * 10_000n);
  return exact && (q / 10_000n) * 10_000n === q ? shown : `${shown}…`;
}
