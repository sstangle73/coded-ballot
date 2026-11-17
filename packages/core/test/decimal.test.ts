import { describe, expect, it } from 'vitest';
import { cmpFraction, div, floor, fmt, fraction, mul, mulDiv, truncate, votes } from '../src/decimal.ts';

describe('decimal votes', () => {
  it('parses and formats exactly', () => {
    expect(fmt(votes('12.5'))).toBe('12.5');
    expect(fmt(votes(3))).toBe('3');
    expect(fmt(votes('0.000000001'))).toBe('0.000000001');
    expect(fmt(votes('0.1') + votes('0.2'))).toBe('0.3');
  });
  it('refuses negatives, junk and too many places', () => {
    expect(() => votes('-1')).toThrow();
    expect(() => votes('1e3')).toThrow();
    expect(() => votes('1.23456', 4)).toThrow();
  });
  it('multiplies, divides and truncates without rounding up', () => {
    expect(fmt(mul(votes(3), votes('0.33333')))).toBe('0.99999');
    expect(fmt(truncate(div(votes(1), votes(3)), 5))).toBe('0.33333');
    expect(fmt(truncate(mulDiv(votes(6), votes(1), votes(7)), 5))).toBe('0.85714');
    expect(fmt(floor(votes('6.99999')))).toBe('6');
  });
  it('compares against fractions exactly', () => {
    const twoThirds = fraction('2/3');
    expect(cmpFraction(votes(2), twoThirds, votes(3))).toBe(0);
    expect(cmpFraction(votes('1.99999'), twoThirds, votes(3))).toBe(-1);
    expect(() => fraction('3/2')).toThrow();
  });
});
