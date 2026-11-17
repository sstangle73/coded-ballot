// The mark reader on synthetic images: a sheet drawn from its layout, then photographed at an angle, upside down,
// unevenly lit and noisy. Real-world tests with a phone, a home printer and a flatbed are in docs/scanning-tests.md.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadRules } from '../src/rules/load.ts';
import { describeStyle } from '../src/eligibility.ts';
import { layoutBallot, PAGE, type Box, type PageLayout } from '../src/layout.ts';
import { describeIssue, findFiducials, homography, project, readSheet, sheetVotes, type GrayImage, type Point } from '../src/scan.ts';

const yaml = readFileSync(new URL('../../../examples/rules.example.yaml', import.meta.url), 'utf8').replace(
  '\nquorum:',
  `  - id: treasurer
    title: Treasurer
    method: plurality
    seats: 1
    write_ins: true
    candidates:
      - { id: ida, name: Ida Example }
      - { id: jo, name: Jo Example }
    eligible_classes: [full]

quorum:`,
);
const { rules } = loadRules(yaml);
const [layout, sheet2] = layoutBallot(rules, describeStyle(rules, 'full'), { countKeyFingerprint: 'ABCD EFGH JKMN PQRS' }) as [PageLayout, PageLayout];

type Fill = 'full' | 'x' | 'tick';
const key = (c: string, o: string, r?: number) => `${c}/${o}${r ? `/${r}` : ''}`;

/** Draw the sheet flat at `s` pixels per point. */
function drawSheet(l: PageLayout, fills: Record<string, Fill>, s: number, seed = 1): GrayImage {
  const width = Math.round(PAGE.width * s);
  const height = Math.round(PAGE.height * s);
  const data = new Uint8Array(width * height).fill(242);
  let r = seed;
  const rand = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rect = (b: Box, v = 25) => {
    for (let y = Math.round(b.y * s); y < Math.round((b.y + b.h) * s); y++)
      for (let x = Math.round(b.x * s); x < Math.round((b.x + b.w) * s); x++) data[y * width + x] = v;
  };
  const ellipse = (b: Box, ring: boolean) => {
    const cx = (b.x + b.w / 2) * s;
    const cy = (b.y + b.h / 2) * s;
    const rx = (b.w / 2) * s;
    const ry = (b.h / 2) * s;
    const t = 1.2 * s;
    for (let y = Math.floor(cy - ry - t); y <= cy + ry + t; y++)
      for (let x = Math.floor(cx - rx - t); x <= cx + rx + t; x++) {
        const outer = ((x - cx) / (rx + t / 2)) ** 2 + ((y - cy) / (ry + t / 2)) ** 2;
        const inner = ((x - cx) / (rx - t / 2)) ** 2 + ((y - cy) / (ry - t / 2)) ** 2;
        if (ring ? outer <= 1 && inner >= 1 : outer <= 1) data[y * width + x] = 30;
      }
  };
  const line = (a: Point, b: Point, w: number) => {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * s);
    for (let i = 0; i <= n; i++) {
      const x = (a.x + ((b.x - a.x) * i) / n) * s;
      const y = (a.y + ((b.y - a.y) * i) / n) * s;
      for (let dy = -w * s; dy <= w * s; dy++) for (let dx = -w * s; dx <= w * s; dx++) data[Math.round(y + dy) * width + Math.round(x + dx)] = 35;
    }
  };
  for (const f of l.fiducials) rect(f, 15);
  // the QR code: three finder patterns and random modules
  const m = l.qr.w / 37;
  for (let i = 0; i < 29; i++)
    for (let j = 0; j < 29; j++) if (rand() < 0.5) rect({ x: l.qr.x + (4 + i) * m, y: l.qr.y + (4 + j) * m, w: m, h: m });
  for (const [fx, fy] of [[4, 4], [26, 4], [4, 26]] as const) {
    rect({ x: l.qr.x + fx * m, y: l.qr.y + fy * m, w: 7 * m, h: 7 * m });
    rect({ x: l.qr.x + (fx + 1) * m, y: l.qr.y + (fy + 1) * m, w: 5 * m, h: 5 * m }, 242);
    rect({ x: l.qr.x + (fx + 2) * m, y: l.qr.y + (fy + 2) * m, w: 3 * m, h: 3 * m });
  }
  // text as dark bars, as a scanner sees it
  for (const t of l.texts) rect({ x: t.x, y: t.y - t.size * 0.7, w: Math.min(t.text.length * t.size * 0.5, t.maxWidth ?? 400), h: t.size * 0.7 }, 60);
  for (const ln of l.lines) if (!ln.dash) line({ x: ln.x1, y: ln.y1 }, { x: ln.x2, y: ln.y2 }, 0.4);
  for (const t of l.targets) {
    ellipse(t.box, true);
    const f = fills[key(t.contestId, t.optionId, t.rank)];
    const b = t.box;
    if (f === 'full') ellipse(b, false);
    if (f === 'x') {
      line({ x: b.x + 3, y: b.y + 2 }, { x: b.x + b.w - 3, y: b.y + b.h - 2 }, 0.9);
      line({ x: b.x + b.w - 3, y: b.y + 2 }, { x: b.x + 3, y: b.y + b.h - 2 }, 0.9);
    }
    if (f === 'tick') {
      line({ x: b.x + 4, y: b.y + b.h / 2 }, { x: b.x + b.w * 0.4, y: b.y + b.h - 2 }, 0.8);
      line({ x: b.x + b.w * 0.4, y: b.y + b.h - 2 }, { x: b.x + b.w - 2, y: b.y + 1 }, 0.8);
    }
  }
  return { width, height, data };
}

/**
 * Photograph the sheet: the page corners land at `corners` (top left, top right, bottom right, bottom left of the
 * sheet) in a W x H image on a darker table, with light falling off across the frame and some sensor noise.
 */
function photograph(sheet: GrayImage, s: number, W: number, H: number, corners: Point[], opts: { noise?: number; falloff?: number } = {}) {
  const page = [
    { x: 0, y: 0 },
    { x: PAGE.width, y: 0 },
    { x: PAGE.width, y: PAGE.height },
    { x: 0, y: PAGE.height },
  ];
  const back = homography(corners, page);
  const data = new Uint8Array(W * H);
  let r = 7;
  const rand = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = project(back, { x: x + 0.5, y: y + 0.5 });
      let v = 110; // the table
      if (p.x >= 0 && p.y >= 0 && p.x < PAGE.width && p.y < PAGE.height) v = sheet.data[Math.floor(p.y * s) * sheet.width + Math.floor(p.x * s)]!;
      v *= 1 - (opts.falloff ?? 0) * (x / W);
      v += ((rand() - 0.5) * 2 * (opts.noise ?? 0));
      data[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  const forward = homography(page, corners);
  return { img: { width: W, height: H, data } satisfies GrayImage, qrCentre: project(forward, { x: layout.qr.x + layout.qr.w / 2, y: layout.qr.y + layout.qr.h / 2 }) };
}

const FILLS: Record<string, Fill> = {
  [key('chair', 'ben', 1)]: 'full',
  [key('chair', 'ana', 2)]: 'full',
  [key('committee', 'eli', 1)]: 'full',
  [key('committee', 'dee', 2)]: 'full',
  [key('committee', 'hal', 3)]: 'full',
};

const states = (read: Exclude<ReturnType<typeof readSheet>, { error: string }>) =>
  Object.fromEntries(read.marks.filter((m) => m.state !== 'empty').map((m) => [key(m.target.contestId, m.target.optionId, m.target.rank), m.state]));

describe('reading marks', () => {
  const s = 2.5;
  const sheet = drawSheet(layout, FILLS, s);

  it('reads a flat scan', () => {
    const W = Math.round(PAGE.width * 2);
    const H = Math.round(PAGE.height * 2);
    const { img, qrCentre } = photograph(sheet, s, W, H, [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]);
    const read = readSheet(img, layout, qrCentre);
    if ('error' in read) throw new Error(read.error);
    expect(states(read)).toEqual(Object.fromEntries(Object.keys(FILLS).map((k) => [k, 'filled'])));
    const v = sheetVotes(rules, layout, read);
    expect(v.selections).toEqual({ chair: ['ben', 'ana'], committee: ['eli', 'dee', 'hal'] });
    expect(v.needsRuling).toEqual([]);
  });

  it('reads a phone photo taken at an angle, unevenly lit and noisy', () => {
    const { img, qrCentre } = photograph(sheet, s, 1200, 1500, [{ x: 160, y: 90 }, { x: 1080, y: 150 }, { x: 1120, y: 1420 }, { x: 70, y: 1330 }], { noise: 18, falloff: 0.35 });
    const read = readSheet(img, layout, qrCentre);
    if ('error' in read) throw new Error(read.error);
    expect(states(read)).toEqual(Object.fromEntries(Object.keys(FILLS).map((k) => [k, 'filled'])));
  });

  it('reads a sheet fed in upside down, using where the QR code is', () => {
    const W = 1000;
    const H = 1300;
    const { img, qrCentre } = photograph(sheet, s, W, H, [{ x: W - 20, y: H - 20 }, { x: 20, y: H - 20 }, { x: 20, y: 20 }, { x: W - 20, y: 20 }]);
    const read = readSheet(img, layout, qrCentre);
    if ('error' in read) throw new Error(read.error);
    expect(states(read)).toEqual(Object.fromEntries(Object.keys(FILLS).map((k) => [k, 'filled'])));
  });

  it('sends crosses, ticks and write-ins to a teller instead of guessing', () => {
    expect([...new Set(sheet2.targets.map((t) => t.contestId))]).toEqual(['motion-1', 'treasurer']);
    const odd = drawSheet(sheet2, { [key('treasurer', 'write-in-1')]: 'full', [key('motion-1', 'no')]: 'x', [key('treasurer', 'ida')]: 'tick' }, s, 3);
    const W = 1100;
    const H = 1420;
    const { img, qrCentre } = photograph(odd, s, W, H, [{ x: 10, y: 10 }, { x: W - 10, y: 10 }, { x: W - 10, y: H - 10 }, { x: 10, y: H - 10 }], { noise: 8 });
    const read = readSheet(img, sheet2, qrCentre);
    if ('error' in read) throw new Error(read.error);
    const v = sheetVotes(rules, sheet2, read);
    const kinds = v.needsRuling.map((i) => `${i.contestId}:${i.kind}:${'optionId' in i ? i.optionId : ''}`).sort();
    expect(kinds).toEqual(['motion-1:unclear:no', 'treasurer:unclear:ida', 'treasurer:write_in:write-in-1']);
    expect(read.writeIns[0]!.ink).toBeLessThan(0.05); // nothing written on the line in this test
  });

  it('sends ranking mistakes and overvotes to a teller, with the published rule already applied', () => {
    const marked = (l: PageLayout, on: (t: PageLayout['targets'][number]) => boolean) => ({
      marks: l.targets.map((target) => ({ target, fill: 0, state: on(target) ? ('filled' as const) : ('empty' as const) })),
    });
    const a = sheetVotes(rules, layout, marked(layout, (t) => t.contestId === 'chair' && ((t.optionId === 'ana' && t.rank === 1) || (t.optionId === 'ben' && t.rank === 3))));
    expect(a.selections.chair).toEqual(['ana', 'ben']);
    expect(a.needsRuling).toEqual([{ contestId: 'chair', kind: 'skipped', rank: 2 }]);
    const b = sheetVotes(rules, sheet2, marked(sheet2, (t) => t.contestId === 'treasurer' && t.optionId !== 'write-in-1'));
    expect(b.needsRuling).toEqual([{ contestId: 'treasurer', kind: 'too_many', marked: ['ida', 'jo'] }]);
    expect(describeIssue(rules, b.needsRuling[0]!)).toBe('Treasurer: more choices marked than allowed (Ida Example, Jo Example).');
  });

  it('says so when it can’t find the corner squares', () => {
    const blank = { width: 600, height: 800, data: new Uint8Array(600 * 800).fill(240) };
    expect(findFiducials(blank)).toBeNull();
    expect(readSheet(blank, layout)).toHaveProperty('error');
  });
});
