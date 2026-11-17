// Draws ballot sheets from the core layout, and the cover letter for print-at-home packets. The cover letter carries
// the member's name and address for the envelope window; the ballot sheet carries the code and never the name.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import { encodeQr, formatCode, PAGE, type PageLayout, type Rules } from '@coded-ballot/core';

const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.35, 0.35, 0.35);

export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

export async function newDoc(): Promise<{ doc: PDFDocument; fonts: Fonts }> {
  const doc = await PDFDocument.create();
  doc.setProducer('coded-ballot');
  doc.setCreator('coded-ballot issuer tool');
  return { doc, fonts: { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) } };
}

/** The standard PDF fonts only cover Western European text. Say so plainly rather than print a broken ballot. */
export function checkPrintable(text: string, font: PDFFont): void {
  try {
    font.encodeText(text);
  } catch {
    const bad = [...new Set([...text].filter((ch) => { try { font.encodeText(ch); return false; } catch { return true; } }))];
    throw new Error(`Can't print "${text}": the characters ${bad.join(' ')} aren't in the built-in PDF font yet.`);
  }
}

function drawText(page: PDFPage, fonts: Fonts, t: { x: number; y: number; size: number; bold?: boolean; text: string; maxWidth?: number }, color = BLACK) {
  const font = t.bold ? fonts.bold : fonts.regular;
  checkPrintable(t.text, font);
  let size = t.size;
  let text = t.text;
  if (t.maxWidth) {
    while (size > t.size * 0.7 && font.widthOfTextAtSize(text, size) > t.maxWidth) size -= 0.25;
    while (font.widthOfTextAtSize(text, size) > t.maxWidth && text.length > 4) text = text.slice(0, -2) + '…';
  }
  page.drawText(text, { x: t.x, y: PAGE.height - t.y, size, font, color });
}

/** Wrap a paragraph to a width; returns the y after it. */
function paragraph(page: PDFPage, font: PDFFont, text: string, x: number, y: number, size: number, width: number, gap = 1.35): number {
  checkPrintable(text, font);
  const words = text.split(/\s+/);
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      page.drawText(line, { x, y: PAGE.height - y, size, font });
      y += size * gap;
      line = w;
    } else line = next;
  }
  if (line) {
    page.drawText(line, { x, y: PAGE.height - y, size, font });
    y += size * gap;
  }
  return y;
}

/** One ballot sheet: fiducials, QR code, typed code, fold lines, contests and ovals. */
export function drawBallotPage(doc: PDFDocument, fonts: Fonts, layout: PageLayout, electionId: string, code: string): void {
  const page = doc.addPage([PAGE.width, PAGE.height]);
  const H = PAGE.height;
  for (const f of layout.fiducials) page.drawRectangle({ x: f.x, y: H - f.y - f.h, width: f.w, height: f.h, color: BLACK });

  // QR code with a 4-module quiet zone inside its box
  const qr = QRCode.create(encodeQr({ electionId, styleId: layout.styleId, code, page: layout.page, pages: layout.pages }), { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const mod = layout.qr.w / (n + 8);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      if (!qr.modules.get(r, c)) continue;
      page.drawRectangle({ x: layout.qr.x + (c + 4) * mod, y: H - (layout.qr.y + (r + 4) * mod) - mod, width: mod + 0.02, height: mod + 0.02, color: BLACK });
    }

  drawText(page, fonts, { x: layout.codeText.x, y: layout.codeText.y - layout.codeText.size - 2, size: 8, text: 'Your code (to vote online, or to check it arrived):' }, GREY);
  drawText(page, fonts, { x: layout.codeText.x, y: layout.codeText.y + 4, size: layout.codeText.size, bold: true, text: formatCode(code) });
  for (const t of layout.texts) drawText(page, fonts, t);
  for (const l of layout.lines) {
    page.drawLine({
      start: { x: l.x1, y: H - l.y1 },
      end: { x: l.x2, y: H - l.y2 },
      thickness: l.dash ? 0.6 : 0.8,
      color: l.dash ? GREY : BLACK,
      dashArray: l.dash ? [5, 4] : undefined,
    });
  }
  for (const y of layout.foldLines) drawText(page, fonts, { x: 8, y: y - 3, size: 6, text: 'fold' }, GREY);
  for (const t of layout.targets) {
    page.drawEllipse({ x: t.box.x + t.box.w / 2, y: H - (t.box.y + t.box.h / 2), xScale: t.box.w / 2, yScale: t.box.h / 2, borderWidth: 1.2, borderColor: BLACK });
  }
}

export interface Address {
  name: string;
  lines: string[];
}

/** The cover letter: the address sits where a #10 window envelope shows it when the letter is folded in three. */
export function drawCoverLetter(
  doc: PDFDocument,
  fonts: Fonts,
  rules: Rules,
  to: Address,
  info: { votingPage: string; tracker: string; countKeyFingerprint: string | null; returnAddress: string[] },
): void {
  const page = doc.addPage([PAGE.width, PAGE.height]);
  let y = 54;
  for (const [i, l] of [rules.election.organisation, ...info.returnAddress].entries()) {
    drawText(page, fonts, { x: 54, y, size: i === 0 ? 10 : 9, bold: i === 0, text: l });
    y += 12;
  }
  // #10 window: about 7/8 in from the left, 2 to 3 in from the top of the folded letter
  let ay = 160;
  for (const l of [to.name, ...to.lines]) {
    drawText(page, fonts, { x: 63, y: ay, size: 11, text: l });
    ay += 14;
  }
  const W = PAGE.width - 108;
  const closes = new Date(rules.dates.voting_closes);
  const when = closes.toLocaleString('en-US', { timeZone: rules.election.timezone, dateStyle: 'full', timeStyle: 'short' });
  y = 290;
  drawText(page, fonts, { x: 54, y, size: 14, bold: true, text: `Your ballot: ${rules.election.title}` });
  y += 24;
  const p = (t: string, bold = false) => (y = paragraph(page, bold ? fonts.bold : fonts.regular, t, 54, y, 10.5, W) + 6);
  if (rules.notice_wording.intro) p(rules.notice_wording.intro);
  p(`Your ballot is enclosed. It has a code on it but not your name, so nobody can tell how you voted. Vote once, in any one of these ways. Voting closes ${when}.`);
  if (rules.channels.mail) p('By post: fill in the ovals, fold the ballot on its dashed lines so the panel with the QR code stays outside, and post it in the return envelope. Do not write your name or address on the envelope.');
  if (rules.channels.online) p(`Online: go to ${info.votingPage}, ask for a voting link at the email address the organisation has for you, then type the code printed on your ballot.`);
  if (rules.channels.in_person) p('In person: bring this ballot to the meeting and put it in the box. If you forget it, the tellers can give you a new one.');
  p('Only the first use of your code counts. Copies are turned away, and so is a second vote.', true);
  p(`Check your ballot arrived: ${info.tracker}`);
  if (info.countKeyFingerprint) p(`Online votes are locked with the tellers' count key. Its fingerprint is ${info.countKeyFingerprint}: the voting page must show the same one.`);
  p(rules.notice_wording.report_misuse, true);
}
