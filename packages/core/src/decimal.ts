// Exact vote arithmetic. Every quantity of votes is a bigint count of billionths (10^-9), so weights such as 12.5
// shares and STV transfer values to five decimal places add up exactly, with no floating-point drift. Counts never
// use JavaScript numbers for votes.

export type Votes = bigint;

export const SCALE = 1_000_000_000n;
const SCALE_DP = 9;

export const ZERO: Votes = 0n;
export const ONE: Votes = SCALE;

/** Parse "3", "12.5" or 2 into votes. Rejects negatives and more than `maxDp` decimal places. */
export function votes(x: string | number | bigint, maxDp = SCALE_DP): Votes {
  if (typeof x === 'bigint') return x * SCALE;
  const s = typeof x === 'number' ? numberToPlain(x) : x.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`not a non-negative decimal: ${JSON.stringify(x)}`);
  const frac = m[2] ?? '';
  if (frac.length > maxDp) throw new RangeError(`more than ${maxDp} decimal places: ${s}`);
  return BigInt(m[1]!) * SCALE + BigInt((frac + '0'.repeat(SCALE_DP)).slice(0, SCALE_DP));
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`not a non-negative number: ${n}`);
  const s = String(n);
  if (/e/i.test(s)) throw new RangeError(`write ${n} as a decimal string`);
  return s;
}

/** "12.5", "3", "0.33333": trailing zeros dropped. */
export function fmt(v: Votes): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / SCALE;
  const frac = (a % SCALE).toString().padStart(SCALE_DP, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}

/** a × b, truncated toward zero. */
export function mul(a: Votes, b: Votes): Votes {
  return (a * b) / SCALE;
}

/** a ÷ b, truncated toward zero. */
export function div(a: Votes, b: Votes): Votes {
  if (b === 0n) throw new RangeError('division by zero');
  return (a * SCALE) / b;
}

/** a × b ÷ c in one step (no intermediate rounding), truncated toward zero. */
export function mulDiv(a: Votes, b: Votes, c: Votes): Votes {
  if (c === 0n) throw new RangeError('division by zero');
  return (a * b) / c;
}

/** Drop everything after `dp` decimal places ("any remainder being ignored"). Non-negative values only. */
export function truncate(v: Votes, dp: number): Votes {
  if (v < 0n) throw new RangeError('truncate expects a non-negative value');
  const unit = 10n ** BigInt(SCALE_DP - dp);
  return (v / unit) * unit;
}

/** Whole-number part (floor for non-negative values). */
export function floor(v: Votes): Votes {
  return truncate(v, 0);
}

export function sum(xs: Iterable<Votes>): Votes {
  let t = 0n;
  for (const x of xs) t += x;
  return t;
}

export function cmp(a: Votes, b: Votes): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function max(a: Votes, b: Votes): Votes {
  return a > b ? a : b;
}

/** A fraction such as "2/3" or "1/2", checked and reduced to integers. */
export interface Fraction {
  num: bigint;
  den: bigint;
}

export function fraction(s: string): Fraction {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(s);
  if (!m) throw new RangeError(`not a fraction like 2/3: ${JSON.stringify(s)}`);
  const num = BigInt(m[1]!);
  const den = BigInt(m[2]!);
  if (den === 0n || num > den) throw new RangeError(`fraction must be between 0 and 1: ${s}`);
  return { num, den };
}

/** Compare a with frac × b exactly: -1, 0 or 1. */
export function cmpFraction(a: Votes, frac: Fraction, b: Votes): -1 | 0 | 1 {
  const l = a * frac.den;
  const r = frac.num * b;
  return l < r ? -1 : l > r ? 1 : 0;
}
