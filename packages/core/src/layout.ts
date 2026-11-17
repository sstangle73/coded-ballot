// layout(contest) -> ballot regions. One description of every sheet, in PDF points (1/72 inch) with the origin at the
// top left and y growing down, used both to print ballots and to read marks from a photo or scan of them.
//
// The sheet is US Letter, folded in three like a Z (accordion). The top third holds the QR code, the typed code and
// the count key fingerprint and stays on the outside; the marks are on the middle and bottom thirds, which fold
// inside. So a sheet can be scanned on arrival without unfolding it.
import type { Contest, Rules } from './rules/schema.ts';
import type { BallotStyle } from './eligibility.ts';

export const PAGE = { width: 612, height: 792 } as const;
export const PANEL = PAGE.height / 3; // 264 pt
export const FIDUCIAL = 20;
const INSET = 24;
const MARGIN = 54;
/** Rows never sit on a fold: a crease through an oval reads as a mark. */
const FOLD_GAP = 8;

function clearOfFold(y: number, h: number): number {
  const fold = 2 * PANEL;
  return y < fold + FOLD_GAP && y + h > fold - FOLD_GAP ? fold + FOLD_GAP : y;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextItem {
  x: number;
  y: number; // baseline
  size: number;
  bold?: boolean;
  text: string;
  maxWidth?: number;
}

export interface MarkTarget {
  contestId: string;
  optionId: string;
  /** For ranked contests: the rank column (1 = first choice). */
  rank?: number;
  box: Box;
}

export interface WriteInArea {
  contestId: string;
  optionId: string;
  box: Box;
}

export interface PageLayout {
  page: number;
  pages: number;
  styleId: string;
  /** Centres of the four corner squares: top left, top right, bottom right, bottom left. */
  fiducials: [Box, Box, Box, Box];
  qr: Box;
  /** Where the typed code and its label go. */
  codeText: { x: number; y: number; size: number };
  foldLines: number[];
  texts: TextItem[];
  targets: MarkTarget[];
  writeIns: WriteInArea[];
  lines: { x1: number; y1: number; x2: number; y2: number; dash?: boolean }[];
}

export interface LayoutOptions {
  countKeyFingerprint: string | null;
  trackerUrl?: string;
}

interface Metrics {
  title: number;
  body: number;
  row: number;
  oval: { w: number; h: number };
  rankCol: number;
}

const NORMAL: Metrics = { title: 12, body: 10, row: 22, oval: { w: 22, h: 13 }, rankCol: 34 };
const LARGE: Metrics = { title: 18, body: 15, row: 34, oval: { w: 32, h: 19 }, rankCol: 46 };

/** How many rank columns a ranked contest gets: every candidate, up to 8. */
export function rankColumns(contest: Contest): number {
  return 'candidates' in contest ? Math.min(contest.candidates.length + (contest.write_ins ? 1 : 0), 8) : 0;
}

function optionsOf(contest: Contest): { id: string; label: string; writeIn: boolean }[] {
  if (contest.method === 'yes_no') {
    return [
      { id: 'yes', label: 'Yes', writeIn: false },
      { id: 'no', label: 'No', writeIn: false },
      ...(contest.allow_abstain ? [{ id: 'abstain', label: 'Abstain', writeIn: false }] : []),
    ];
  }
  const opts = contest.candidates.map((c) => ({ id: c.id, label: c.name, writeIn: false }));
  if (contest.write_ins) {
    const n = contest.method === 'irv' || contest.method === 'stv' ? 1 : contest.seats;
    for (let i = 1; i <= n; i++) opts.push({ id: `write-in-${i}`, label: 'Write-in:', writeIn: true });
  }
  return opts;
}

function instruction(contest: Contest): string {
  switch (contest.method) {
    case 'plurality':
      return contest.seats === 1 ? 'Vote for one.' : `Vote for up to ${contest.seats}.`;
    case 'approval':
      return contest.max_approvals ? `Vote for up to ${contest.max_approvals}.` : 'Vote for as many as you approve of.';
    case 'yes_no':
      return 'Vote yes or no.';
    case 'irv':
    case 'stv':
      return `Rank in order: fill one oval per row and per column, 1 for your first choice.${contest.method === 'stv' ? ` ${contest.seats} seats.` : ''}`;
  }
}

function contestHeight(contest: Contest, m: Metrics): number {
  const header = m.title + 6 + m.body + 10;
  const ranked = contest.method === 'irv' || contest.method === 'stv';
  return header + (ranked ? m.row : 0) + optionsOf(contest).length * m.row + 14 + FOLD_GAP * 2;
}

/** Lay out every sheet of a ballot style. Throws if one contest is too long for a sheet. */
export function layoutBallot(rules: Rules, style: BallotStyle, opts: LayoutOptions): PageLayout[] {
  const m = style.largePrint ? LARGE : NORMAL;
  const contests = style.contests.map((id) => rules.contests.find((c) => c.id === id)!);
  const top = PANEL + 18;
  const bottom = PAGE.height - INSET - FIDUCIAL - 10;
  const groups: Contest[][] = [[]];
  let y = top;
  for (const c of contests) {
    const h = contestHeight(c, m);
    if (h > bottom - top) throw new Error(`"${c.title}" is too long to fit on one sheet${style.largePrint ? ' in large print' : ''}.`);
    if (y + h > bottom) {
      groups.push([]);
      y = top;
    }
    groups[groups.length - 1]!.push(c);
    y += h;
  }
  const pages = groups.length;
  return groups.map((group, i) => layoutPage(rules, style, opts, m, group, i + 1, pages, top));
}

function layoutPage(
  rules: Rules,
  style: BallotStyle,
  opts: LayoutOptions,
  m: Metrics,
  contests: Contest[],
  page: number,
  pages: number,
  top: number,
): PageLayout {
  const W = PAGE.width;
  const H = PAGE.height;
  const f = (x: number, y: number): Box => ({ x, y, w: FIDUCIAL, h: FIDUCIAL });
  const fiducials: [Box, Box, Box, Box] = [
    f(INSET, INSET),
    f(W - INSET - FIDUCIAL, INSET),
    f(W - INSET - FIDUCIAL, H - INSET - FIDUCIAL),
    f(INSET, H - INSET - FIDUCIAL),
  ];
  const qrSize = 150;
  const qr: Box = { x: W - MARGIN - qrSize + 10, y: 50, w: qrSize, h: qrSize };
  const texts: TextItem[] = [];
  const lines: PageLayout['lines'] = [
    { x1: 0, y1: PANEL, x2: W, y2: PANEL, dash: true },
    { x1: 0, y1: 2 * PANEL, x2: W, y2: 2 * PANEL, dash: true },
  ];
  const hs = style.largePrint ? 1.3 : 1;
  let ty = 62;
  const left = MARGIN;
  const textW = qr.x - left - 12;
  texts.push({ x: left, y: ty, size: 14 * hs, bold: true, text: rules.election.organisation, maxWidth: textW });
  ty += 18 * hs;
  texts.push({ x: left, y: ty, size: 12 * hs, bold: true, text: rules.election.title, maxWidth: textW });
  ty += 16 * hs;
  texts.push({ x: left, y: ty, size: 9 * hs, text: `Ballot ${style.id}${pages > 1 ? `, sheet ${page} of ${pages}` : ''}${style.provisional ? ' (PROVISIONAL)' : ''}`, maxWidth: textW });
  ty += 14 * hs;
  const codeText = { x: left, y: ty + 14 * hs, size: 13 * hs };
  ty += 30 * hs;
  if (opts.countKeyFingerprint) {
    texts.push({ x: left, y: ty, size: 8.5 * hs, text: `Count key fingerprint: ${opts.countKeyFingerprint}`, maxWidth: textW });
    ty += 12 * hs;
  }
  const notes = [
    'Fill each oval completely with a dark pen. Do not write your name anywhere.',
    'Fold on the dashed lines like a Z, so this panel with the QR code stays outside.',
    opts.trackerUrl ? `Check your ballot arrived: ${opts.trackerUrl}` : '',
    rules.notice_wording.report_misuse,
  ].filter(Boolean);
  for (const n of notes) {
    texts.push({ x: left, y: ty, size: 8 * hs, text: n, maxWidth: textW });
    ty += 11 * hs;
  }

  const targets: MarkTarget[] = [];
  const writeIns: WriteInArea[] = [];
  let y = top;
  for (const c of contests) {
    y = clearOfFold(y, m.title + 6 + m.body + 10 + (c.method === 'irv' || c.method === 'stv' ? m.row : 0));
    y += m.title;
    texts.push({ x: left, y, size: m.title, bold: true, text: c.title, maxWidth: W - 2 * MARGIN });
    y += 6 + m.body;
    texts.push({ x: left, y, size: m.body, text: instruction(c), maxWidth: W - 2 * MARGIN });
    y += 10;
    const ranked = c.method === 'irv' || c.method === 'stv';
    const options = optionsOf(c);
    if (ranked) {
      const cols = rankColumns(c);
      const gridX = W - MARGIN - cols * m.rankCol;
      for (let r = 1; r <= cols; r++) {
        texts.push({ x: gridX + (r - 1) * m.rankCol + m.rankCol / 2 - m.body / 3, y: y + m.row - 8, size: m.body, bold: true, text: String(r) });
      }
      y += m.row;
      for (const o of options) {
        y = clearOfFold(y, m.row);
        const midY = y + m.row / 2;
        texts.push({ x: left, y: midY + m.body / 3, size: m.body, text: o.label, maxWidth: gridX - left - 8 });
        if (o.writeIn) {
          const box = { x: left + 60 * hs, y: y + 2, w: gridX - left - 70 * hs, h: m.row - 4 };
          writeIns.push({ contestId: c.id, optionId: o.id, box });
          lines.push({ x1: box.x, y1: box.y + box.h, x2: box.x + box.w, y2: box.y + box.h });
        }
        for (let r = 1; r <= rankColumns(c); r++) {
          targets.push({
            contestId: c.id,
            optionId: o.id,
            rank: r,
            box: { x: gridX + (r - 1) * m.rankCol + (m.rankCol - m.oval.w) / 2, y: midY - m.oval.h / 2, w: m.oval.w, h: m.oval.h },
          });
        }
        y += m.row;
      }
    } else {
      for (const o of options) {
        y = clearOfFold(y, m.row);
        const midY = y + m.row / 2;
        targets.push({ contestId: c.id, optionId: o.id, box: { x: left, y: midY - m.oval.h / 2, w: m.oval.w, h: m.oval.h } });
        texts.push({ x: left + m.oval.w + 10, y: midY + m.body / 3, size: m.body, text: o.label, maxWidth: W - 2 * MARGIN - m.oval.w - 10 });
        if (o.writeIn) {
          const box = { x: left + m.oval.w + 70 * hs, y: y + 2, w: 260, h: m.row - 4 };
          writeIns.push({ contestId: c.id, optionId: o.id, box });
          lines.push({ x1: box.x, y1: box.y + box.h, x2: box.x + box.w, y2: box.y + box.h });
        }
        y += m.row;
      }
    }
    y += 14;
  }
  return { page, pages, styleId: style.id, fiducials, qr, codeText, foldLines: [PANEL, 2 * PANEL], texts, targets, writeIns, lines };
}

/** Centre of a box. */
export function centre(b: Box): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}
