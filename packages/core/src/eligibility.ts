// eligible(member, contest) -> weight, and ballot styles. A style is one membership class at one weight, optionally
// large print or provisional. Weight travels with the style (votes carry no codes), which is why small weight
// groups get the anonymity warning.
import type { Contest, MemberClass, Rules } from './rules/schema.ts';
import type { Member } from './roll.ts';
import { fmt, ONE, votes, type Votes } from './decimal.ts';

export interface BallotStyle {
  id: string;
  classId: string;
  /** The class weight for this style, as a decimal string ("1", "12.5"). */
  weight: string;
  largePrint: boolean;
  provisional: boolean;
  contests: string[];
}

export function classOf(rules: Rules, classId: string): MemberClass {
  const c = rules.classes.find((x) => x.id === classId);
  if (!c) throw new Error(`unknown class ${classId}`);
  return c;
}

/** A member's class weight: the class's fixed weight, or their value in the roll column the class names. */
export function memberWeight(rules: Rules, member: Member): Votes {
  const c = classOf(rules, member.classId);
  if (typeof c.weight === 'object') {
    const v = member.fields[c.weight.column.toLowerCase()];
    if (v === undefined || v === '') throw new Error(`member ${member.memberId} has no ${c.weight.column} value`);
    return votes(v, 4);
  }
  return votes(c.weight, 4);
}

export function contestOpenTo(contest: Contest, classId: string): boolean {
  return !contest.eligible_classes || contest.eligible_classes.includes(classId);
}

/**
 * eligible(member, contest) -> weight. 0 means not eligible. A contest that isn't weighted gives every eligible
 * member a weight of 1.
 */
export function eligible(rules: Rules, member: Member, contest: Contest): Votes {
  if (!contestOpenTo(contest, member.classId)) return 0n;
  return contest.weighted ? memberWeight(rules, member) : ONE;
}

export function styleId(classId: string, weight: string, opts: { largePrint?: boolean; provisional?: boolean } = {}) {
  let s = classId;
  if (weight !== '1') s += `_w${weight}`;
  if (opts.largePrint) s += '_lp';
  if (opts.provisional) s += '_prov';
  return s;
}

export function parseStyleId(id: string): { classId: string; weight: string; largePrint: boolean; provisional: boolean } {
  const m = /^([a-z0-9][a-z0-9-]{0,39})(?:_w(\d+(?:\.\d{1,4})?))?(_lp)?(_prov)?$/.exec(id);
  if (!m) throw new Error(`not a ballot style id: ${id}`);
  return { classId: m[1]!, weight: m[2] ?? '1', largePrint: !!m[3], provisional: !!m[4] };
}

export function styleFor(
  rules: Rules,
  member: Member,
  opts: { largePrint?: boolean; provisional?: boolean } = {},
): BallotStyle {
  const anyWeighted = rules.contests.some((c) => c.weighted && contestOpenTo(c, member.classId));
  const weight = anyWeighted ? fmt(memberWeight(rules, member)) : '1';
  return describeStyle(rules, styleId(member.classId, weight, opts));
}

export function describeStyle(rules: Rules, id: string): BallotStyle {
  const p = parseStyleId(id);
  classOf(rules, p.classId);
  return {
    id,
    ...p,
    contests: rules.contests.filter((c) => contestOpenTo(c, p.classId)).map((c) => c.id),
  };
}

/** The weight a ballot of this style carries in this contest (0 if the style doesn't vote on it). */
export function styleWeightFor(rules: Rules, styleIdValue: string, contest: Contest): Votes {
  const p = parseStyleId(styleIdValue);
  if (!contestOpenTo(contest, p.classId)) return 0n;
  return contest.weighted ? votes(p.weight, 4) : ONE;
}

/** Total eligible weight per contest, for thresholds "of members" and quorum. */
export function electorate(rules: Rules, members: Member[], contest: Contest): { members: number; weight: Votes } {
  let n = 0;
  let w = 0n;
  for (const m of members) {
    const e = eligible(rules, m, contest);
    if (e > 0n) {
      n++;
      w += e;
    }
  }
  return { members: n, weight: w };
}
