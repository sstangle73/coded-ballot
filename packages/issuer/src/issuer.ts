// The issuer's work, kept apart from the command line so it can be tested: freeze the roll, make codes and printable
// packets, reissue, and sign the close. Codes exist only in memory and in the PDFs; the state file keeps each
// member's copy number and ballot style, never a code.
import {
  codeHash,
  deriveCode,
  freezeRoll,
  importRoll,
  layoutBallot,
  styleFor,
  type FrozenRoll,
  type IssuerKeys,
  type Member,
  type Rules,
} from '@coded-ballot/core';
import { PDFDocument } from 'pdf-lib';
import { drawBallotPage, drawCoverLetter, newDoc, type Address } from './pdf.ts';

export interface IssuedState {
  electionId: string;
  members: Record<string, { copy: number; styleId: string }>;
}

export interface PacketInfo {
  votingPage: string;
  tracker: string;
  countKeyFingerprint: string | null;
  returnAddress: string[];
}

export interface Packet {
  memberId: string;
  filename: string;
  pdf: Uint8Array;
  /** Just the ballot sheets, for emailing. */
  ballotOnly: Uint8Array;
}

const yes = (v: string | undefined) => /^(1|y|yes|true)$/i.test((v ?? '').trim());

export function freezeRollCsv(rules: Rules, csv: string, frozenAt = rules.dates.notice): { frozen: FrozenRoll; problems: string[] } {
  const { members, problems } = importRoll(csv, rules.classes.map((c) => c.id));
  return { frozen: freezeRoll(members, frozenAt), problems };
}

export function addressOf(m: Member): Address {
  const f = m.fields;
  const cityLine = [f.city, f.state, f.zip ?? f.postcode].filter(Boolean).join(' ');
  return { name: m.name || m.memberId, lines: [f.address_line1, f.address_line2, cityLine, f.country].filter((x): x is string => !!x) };
}

export function styleOf(rules: Rules, m: Member) {
  return styleFor(rules, m, { largePrint: rules.large_print && yes(m.fields.large_print), provisional: yes(m.fields.provisional) });
}

async function ballotPages(doc: PDFDocument, rules: Rules, keys: IssuerKeys, m: Member, copy: number, info: PacketInfo, fonts: Awaited<ReturnType<typeof newDoc>>['fonts']) {
  const style = styleOf(rules, m);
  const code = deriveCode(keys, m.memberId, copy);
  for (const page of layoutBallot(rules, style, { countKeyFingerprint: info.countKeyFingerprint, trackerUrl: info.tracker })) {
    drawBallotPage(doc, fonts, page, rules.election.id, code);
  }
  return { styleId: style.id, hash: codeHash(rules.election.id, code) };
}

/** One packet: the cover letter (name and address for the window) then the ballot sheets (code, no name). */
export async function makePacket(rules: Rules, keys: IssuerKeys, m: Member, copy: number, info: PacketInfo, index: number) {
  const { doc, fonts } = await newDoc();
  drawCoverLetter(doc, fonts, rules, addressOf(m), info);
  const b = await ballotPages(doc, rules, keys, m, copy, info, fonts);
  const ballot = await newDoc();
  await ballotPages(ballot.doc, rules, keys, m, copy, info, ballot.fonts);
  const packet: Packet = {
    memberId: m.memberId,
    filename: `${String(index).padStart(4, '0')}-${m.memberId.replace(/[^\w-]/g, '_')}.pdf`,
    pdf: await doc.save(),
    ballotOnly: await ballot.doc.save(),
  };
  return { packet, ...b };
}

/**
 * Codes and packets for every member on the frozen roll (or the listed ones), in roll order. Returns what to upload:
 * hashes and styles, sorted by hash so the upload order says nothing about the roll.
 */
export async function makeBallots(opts: { rules: Rules; frozen: FrozenRoll; keys: IssuerKeys; info: PacketInfo; state?: IssuedState }) {
  const { rules, frozen, keys, info } = opts;
  const state: IssuedState = opts.state ?? { electionId: rules.election.id, members: {} };
  if (state.electionId !== rules.election.id) throw new Error('The state file is for a different election.');
  const packets: Packet[] = [];
  const codes: { hash: string; styleId: string }[] = [];
  const combined = await PDFDocument.create();
  let i = 0;
  for (const m of frozen.members) {
    i++;
    if (state.members[m.memberId]) continue; // already issued
    const r = await makePacket(rules, keys, m, 1, info, i);
    state.members[m.memberId] = { copy: 1, styleId: r.styleId };
    packets.push(r.packet);
    codes.push({ hash: r.hash, styleId: r.styleId });
    const src = await PDFDocument.load(r.packet.pdf);
    for (const p of await combined.copyPages(src, src.getPageIndices())) combined.addPage(p);
  }
  codes.sort((a, b) => (a.hash < b.hash ? -1 : 1));
  return { packets, combined: await combined.save(), codes, state };
}

/** Reissue: copy n is revoked and copy n + 1 printed. */
export async function reissue(opts: { rules: Rules; frozen: FrozenRoll; keys: IssuerKeys; info: PacketInfo; state: IssuedState; memberId: string }) {
  const m = opts.frozen.members.find((x) => x.memberId === opts.memberId);
  if (!m) throw new Error(`${opts.memberId} isn't on the frozen roll.`);
  const cur = opts.state.members[m.memberId];
  if (!cur) throw new Error(`${opts.memberId} hasn't been issued a ballot yet.`);
  const revoke = codeHash(opts.rules.election.id, deriveCode(opts.keys, m.memberId, cur.copy));
  const index = opts.frozen.members.indexOf(m) + 1;
  const r = await makePacket(opts.rules, opts.keys, m, cur.copy + 1, opts.info, index);
  opts.state.members[m.memberId] = { copy: cur.copy + 1, styleId: r.styleId };
  return { revoke, issue: { hash: r.hash, styleId: r.styleId }, packet: r.packet, state: opts.state };
}
