// Reading marks from a photo or scan of a ballot sheet. The four black corner squares give a perspective map from
// the sheet's layout (PDF points) to the image, so a phone photo taken at an angle reads the same as a flat scan.
// Each oval is judged by how much of its inside is dark, compared with the paper just around it: clearly filled,
// clearly empty, or unclear. Unclear marks and write-ins always go to a teller; the app never guesses.
import type { Box, MarkTarget, PageLayout, WriteInArea } from './layout.ts';
import type { Contest, Rules } from './rules/schema.ts';
import { rankGridToRanking, type RankIssue } from './count/index.ts';

export interface GrayImage {
  width: number;
  height: number;
  /** Luminance, 0 black to 255 white, row by row. */
  data: Uint8Array;
}

export interface Point {
  x: number;
  y: number;
}

/** RGBA pixels (as from a canvas) to luminance. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = (rgba[j]! * 77 + rgba[j + 1]! * 150 + rgba[j + 2]! * 29) >> 8;
  return { width, height, data };
}

/** Otsu's threshold: the grey level that best splits the image into ink and paper. */
export function otsu(img: GrayImage): number {
  const hist = new Float64Array(256);
  for (const v of img.data) hist[v]!++;
  const total = img.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

interface Blob {
  cx: number;
  cy: number;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Connected dark regions (4-connected), without recursion so large images don't overflow the stack. */
function darkBlobs(img: GrayImage, threshold: number, maxArea: number): Blob[] {
  const { width: w, height: h, data } = img;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const blobs: Blob[] = [];
  for (let start = 0; start < data.length; start++) {
    if (seen[start] || data[start]! > threshold) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let area = 0;
    let sx = 0;
    let sy = 0;
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    while (sp) {
      const p = stack[--sp]!;
      const x = p % w;
      const y = (p - x) / w;
      area++;
      sx += x;
      sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const push = (q: number) => {
        if (!seen[q] && data[q]! <= threshold) {
          seen[q] = 1;
          stack[sp++] = q;
        }
      };
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
    if (area >= 16 && area <= maxArea) blobs.push({ cx: sx / area, cy: sy / area, area, minX, minY, maxX, maxY });
  }
  return blobs;
}

/**
 * The centres of the four corner squares, in image pixels, as they appear in the image: top left, top right,
 * bottom right, bottom left. Null if four can't be found.
 */
export function findFiducials(img: GrayImage): [Point, Point, Point, Point] | null {
  const minDim = Math.min(img.width, img.height);
  const lo = (minDim * 0.012) ** 2;
  const hi = (minDim * 0.09) ** 2;
  const t = Math.min(otsu(img), 140);
  const squares = darkBlobs(img, t, hi * 1.5).filter((b) => {
    const bw = b.maxX - b.minX + 1;
    const bh = b.maxY - b.minY + 1;
    const aspect = bw / bh;
    return b.area >= lo && b.area <= hi && aspect > 0.6 && aspect < 1.6 && b.area / (bw * bh) > 0.8;
  });
  if (squares.length < 4) return null;
  const pick = (score: (b: Blob) => number) => squares.reduce((a, b) => (score(b) > score(a) ? b : a));
  const corners = [pick((b) => -(b.cx + b.cy)), pick((b) => b.cx - b.cy), pick((b) => b.cx + b.cy), pick((b) => b.cy - b.cx)];
  if (new Set(corners).size !== 4) return null;
  const areas = corners.map((b) => b.area).sort((a, b) => a - b);
  if (areas[3]! > areas[0]! * 3) return null; // not the same size: not the corner squares
  return corners.map((b) => ({ x: b.cx, y: b.cy })) as [Point, Point, Point, Point];
}

/** A 3x3 perspective map, row by row. */
export type Homography = number[];

/** The perspective map that takes each src point to the matching dst point. */
export function homography(src: Point[], dst: Point[]): Homography {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]!;
    const { x: u, y: v } = dst[i]!;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8x9 augmented matrix
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
    if (Math.abs(A[p]![c]!) < 1e-12) throw new Error('The corner squares are in a line: can’t map the sheet.');
    [A[c], A[p]] = [A[p]!, A[c]!];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let k = c; k < 9; k++) A[r]![k]! -= f * A[c]![k]!;
    }
  }
  const h = A.map((row, i) => row[8]! / row[i]!);
  return [...h, 1];
}

export function project(H: Homography, p: Point): Point {
  const d = H[6]! * p.x + H[7]! * p.y + H[8]!;
  return { x: (H[0]! * p.x + H[1]! * p.y + H[2]!) / d, y: (H[3]! * p.x + H[4]! * p.y + H[5]!) / d };
}

function sample(img: GrayImage, p: Point): number {
  const x = Math.min(Math.max(p.x, 0), img.width - 1.001);
  const y = Math.min(Math.max(p.y, 0), img.height - 1.001);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * img.width + x0;
  const d = img.data;
  return (d[i]! * (1 - fx) + d[i + 1]! * fx) * (1 - fy) + (d[i + img.width]! * (1 - fx) + d[i + img.width + 1]! * fx) * fy;
}

export type MarkState = 'filled' | 'empty' | 'unclear';

export interface MarkReading {
  target: MarkTarget;
  /** How much of the inside of the oval is dark, 0 to 1. */
  fill: number;
  state: MarkState;
}

export interface WriteInReading {
  area: WriteInArea;
  /** How much of the line is inked: a hint for the teller, who reads the name. */
  ink: number;
}

export interface SheetRead {
  marks: MarkReading[];
  writeIns: WriteInReading[];
  /** Where the corner squares were found, for drawing on the photo. */
  fiducials: Point[];
  /** Layout points to image pixels. */
  map: Homography;
}

/**
 * A filled oval is mostly dark everywhere inside. A cross, a tick or a circled oval is dark in places: unclear, so a
 * teller decides. Thresholds were set on synthetic sheets and should be checked with real ones (docs/scanning-tests.md).
 */
export const MARK = { filled: 0.7, filledEveryQuarter: 0.45, empty: 0.12 } as const;

const centreOf = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** The local paper brightness around a box: the bright end of a ring of samples just outside it. */
function paperAround(img: GrayImage, H: Homography, b: Box, pad: number): number {
  const c = centreOf(b);
  const vals: number[] = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    vals.push(sample(img, project(H, { x: c.x + Math.cos(a) * (b.w / 2 + pad), y: c.y + Math.sin(a) * (b.h / 2 + pad) })));
  }
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.8)]!;
}

/** The dark share of the inside of a box, overall and in its least-inked quarter. */
function darkFraction(img: GrayImage, H: Homography, b: Box, inner: number, paper: number): { all: number; leastQuarter: number } {
  const c = centreOf(b);
  const rx = (b.w / 2) * inner;
  const ry = (b.h / 2) * inner;
  const cut = paper * 0.62;
  const n = [0, 0, 0, 0];
  const dark = [0, 0, 0, 0];
  const steps = 13;
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < steps; j++) {
      const u = (i / (steps - 1)) * 2 - 1;
      const v = (j / (steps - 1)) * 2 - 1;
      if (u * u + v * v > 1) continue;
      const q = (u < 0 ? 0 : 1) + (v < 0 ? 0 : 2);
      n[q]!++;
      if (sample(img, project(H, { x: c.x + u * rx, y: c.y + v * ry })) < cut) dark[q]!++;
    }
  const total = n.reduce((a, b) => a + b, 0);
  return { all: dark.reduce((a, b) => a + b, 0) / total, leastQuarter: Math.min(...dark.map((d, i) => d / n[i]!)) };
}

/**
 * Read one sheet. qrCentre is where the QR code was found in the image: it settles which way up the sheet is. Without
 * it the sheet is taken to be upright.
 */
export function readSheet(img: GrayImage, layout: PageLayout, qrCentre?: Point): SheetRead | { error: string } {
  const found = findFiducials(img);
  if (!found) return { error: 'Couldn’t find the four black corner squares. Lay the sheet flat on a plain, darker background, with all four corners in view.' };
  const layoutPts = layout.fiducials.map(centreOf);
  let best: { H: Homography; d: number } | null = null;
  for (let k = 0; k < 4; k++) {
    const rotated = [0, 1, 2, 3].map((i) => found[(i + k) % 4]!);
    let H: Homography;
    try {
      H = homography(layoutPts, rotated);
    } catch {
      continue;
    }
    const q = project(H, centreOf(layout.qr));
    const d = qrCentre ? Math.hypot(q.x - qrCentre.x, q.y - qrCentre.y) : k;
    if (!best || d < best.d) best = { H, d };
  }
  if (!best) return { error: 'The corner squares are in a line: can’t map the sheet.' };
  const H = best.H;
  if (qrCentre) {
    const scale = Math.hypot(project(H, { x: 100, y: 0 }).x - project(H, { x: 0, y: 0 }).x, project(H, { x: 100, y: 0 }).y - project(H, { x: 0, y: 0 }).y) / 100;
    if (best.d > 40 * scale) return { error: 'The QR code isn’t where this ballot style puts it: wrong sheet, or a corner square is hidden.' };
  }
  const marks = layout.targets.map((target): MarkReading => {
    const paper = paperAround(img, H, target.box, 4);
    const d = darkFraction(img, H, target.box, 0.62, paper);
    const filled = d.all >= MARK.filled && d.leastQuarter >= MARK.filledEveryQuarter;
    return { target, fill: d.all, state: filled ? 'filled' : d.all <= MARK.empty ? 'empty' : 'unclear' };
  });
  const writeIns = layout.writeIns.map((area): WriteInReading => {
    const paper = paperAround(img, H, area.box, 3);
    return { area, ink: darkFraction(img, H, { ...area.box, y: area.box.y + 1, h: area.box.h - 3 }, 0.95, paper).all };
  });
  return { marks, writeIns, fiducials: found, map: H };
}

// ---- turning marks into a cast vote record -----------------------------------------------------------------

export type SheetIssue =
  | { contestId: string; kind: 'unclear'; optionId: string; rank?: number }
  | { contestId: string; kind: 'write_in'; optionId: string }
  | { contestId: string; kind: 'too_many'; marked: string[] }
  | ({ contestId: string } & RankIssue);

export interface SheetVotes {
  selections: Record<string, string[]>;
  /**
   * Everything a teller must look at before the ballot is counted: unclear marks, write-ins, overvotes and rank-grid
   * mistakes. The selections already apply the published rules (skipped ranks closed up, and so on), so for most
   * issues the teller only confirms.
   */
  needsRuling: SheetIssue[];
}

/** The selections on one sheet, and what a teller must rule on. */
export function sheetVotes(rules: Rules, layout: PageLayout, read: Pick<SheetRead, 'marks'>): SheetVotes {
  const selections: Record<string, string[]> = {};
  const needsRuling: SheetIssue[] = [];
  const contestIds = [...new Set(layout.targets.map((t) => t.contestId))];
  for (const id of contestIds) {
    const contest = rules.contests.find((c) => c.id === id) as Contest;
    const marks = read.marks.filter((m) => m.target.contestId === id);
    for (const m of marks) if (m.state === 'unclear') needsRuling.push({ contestId: id, kind: 'unclear', optionId: m.target.optionId, rank: m.target.rank });
    const filled = marks.filter((m) => m.state === 'filled');
    for (const o of new Set(filled.map((m) => m.target.optionId))) if (o.startsWith('write-in-')) needsRuling.push({ contestId: id, kind: 'write_in', optionId: o });
    if (contest.method === 'irv' || contest.method === 'stv') {
      const grid: Record<string, number[]> = {};
      for (const m of filled) (grid[m.target.optionId] ??= []).push(m.target.rank!);
      const cols = Math.max(0, ...marks.map((m) => m.target.rank ?? 0));
      const r = rankGridToRanking(grid, cols);
      selections[id] = r.ranking;
      for (const issue of r.issues) needsRuling.push({ contestId: id, ...issue });
    } else {
      selections[id] = filled.map((m) => m.target.optionId);
      const max = contest.method === 'yes_no' ? 1 : contest.method === 'plurality' ? contest.seats : (contest.max_approvals ?? Infinity);
      if (filled.length > max) needsRuling.push({ contestId: id, kind: 'too_many', marked: selections[id]! });
    }
  }
  return { selections, needsRuling };
}

/** A sentence for each issue, for the adjudication screen. */
export function describeIssue(rules: Rules, i: SheetIssue): string {
  const c = rules.contests.find((x) => x.id === i.contestId);
  const title = c?.title ?? i.contestId;
  const name = (id: string) => (c && 'candidates' in c ? (c.candidates.find((x) => x.id === id)?.name ?? id) : id[0]!.toUpperCase() + id.slice(1));
  switch (i.kind) {
    case 'unclear':
      return `${title}: the mark for ${name(i.optionId)}${i.rank ? ` at rank ${i.rank}` : ''} is unclear.`;
    case 'write_in':
      return `${title}: a write-in is marked. Read the name.`;
    case 'too_many':
      return `${title}: more choices marked than allowed (${i.marked.map(name).join(', ')}).`;
    case 'skipped':
      return `${title}: rank ${i.rank} is skipped; the later ranks move up.`;
    case 'repeated':
      return `${title}: ${name(i.candidate)} is marked again at rank ${i.rank}; their highest rank counts.`;
    case 'overvote':
      return `${title}: ${i.candidates.map(name).join(' and ')} are both marked at rank ${i.rank}; the ballot counts only up to rank ${i.rank - 1}.`;
  }
}
