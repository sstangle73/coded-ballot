import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadRules } from '../src/rules/load.ts';
import { describeStyle } from '../src/eligibility.ts';
import { layoutBallot, PAGE, PANEL, rankColumns } from '../src/layout.ts';

const { rules } = loadRules(readFileSync(new URL('../../../examples/rules.example.yaml', import.meta.url), 'utf8'));

describe('ballot layout', () => {
  it('keeps the QR code on the outside top panel and every mark inside', () => {
    for (const lp of [false, true]) {
      const pages = layoutBallot(rules, describeStyle(rules, lp ? 'full_lp' : 'full'), { countKeyFingerprint: 'ABCD EFGH JKMN PQRS' });
      for (const p of pages) {
        expect(p.qr.y + p.qr.h).toBeLessThan(PANEL);
        for (const t of p.targets) {
          expect(t.box.y).toBeGreaterThan(PANEL);
          // no oval on or near the second fold
          expect(t.box.y > 2 * PANEL + 4 || t.box.y + t.box.h < 2 * PANEL - 4).toBe(true);
          expect(t.box.y + t.box.h).toBeLessThan(PAGE.height - 44);
          expect(t.box.x).toBeGreaterThan(44);
          expect(t.box.x + t.box.w).toBeLessThan(PAGE.width - 44);
        }
      }
    }
  });
  it('gives every option and rank its own oval, with no overlaps', () => {
    const pages = layoutBallot(rules, describeStyle(rules, 'full'), { countKeyFingerprint: null });
    const all = pages.flatMap((p) => p.targets.map((t) => ({ ...t, page: p.page })));
    const committee = rules.contests.find((c) => c.id === 'committee')!;
    expect(all.filter((t) => t.contestId === 'committee')).toHaveLength(5 * rankColumns(committee));
    expect(all.filter((t) => t.contestId === 'motion-1').map((t) => t.optionId)).toEqual(['yes', 'no', 'abstain']);
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!;
        const b = all[j]!;
        if (a.page !== b.page) continue;
        const overlap = a.box.x < b.box.x + b.box.w && b.box.x < a.box.x + a.box.w && a.box.y < b.box.y + b.box.h && b.box.y < a.box.y + a.box.h;
        expect(overlap).toBe(false);
      }
  });
  it('spreads large print over more sheets, each knowing its page number', () => {
    const lp = layoutBallot(rules, describeStyle(rules, 'full_lp'), { countKeyFingerprint: null });
    expect(lp.length).toBeGreaterThanOrEqual(layoutBallot(rules, describeStyle(rules, 'full'), { countKeyFingerprint: null }).length);
    lp.forEach((p, i) => expect([p.page, p.pages]).toEqual([i + 1, lp.length]));
  });
});
