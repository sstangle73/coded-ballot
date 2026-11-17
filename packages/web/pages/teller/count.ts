// After the close: unlock the online votes, read the paper, rule on unclear ballots, enter the hand count, then count
// and certify. Everything is counted here, on the teller's device; the server only stores what the tellers send.
import {
  codeHash,
  countKeyPublicFromPrivate,
  decodeQr,
  describeIssue,
  describeStyle,
  firstRoundAfter,
  fromBase64,
  layoutBallot,
  lotForClose,
  project,
  readSheet,
  sheetVotes,
  summarise,
  tally,
  toBase64,
  unlockVote,
  verifyClose,
  type CastVoteRecord,
  type LotSource,
  type PageLayout,
  type SheetIssue,
  type SheetRead,
  type SheetVotes,
  type Tally,
} from '@coded-ballot/core';
import { contestFields } from '../shared/ballot-form.ts';
import { h, show, status } from '../shared/ui.ts';
import { findQr, fromFile, fromVideo, startCamera, stopCamera, type Picture } from './images.ts';
import type { Ctx, ElectionInfo } from './teller.ts';

interface ReportData {
  rulesSha256: string;
  counts: { issued: number; unused: number; revoked: number; spent: { mail: number; online: number; in_person: number } };
  rejectedUses: { channel: string; reason: string; at: string }[];
  styles: { styleId: string; n: number }[];
  keyDestroyedAt: string | null;
  closedAt: string | null;
  rollChanges: { kind: string; at: string }[];
  tamperChecks: { at: string; ok: number }[];
  handCounts: { contest_id: string; teller: string; totals: string; at: string }[];
  provisional: { upheld: number; rejected: number } | null;
}

interface PaperRow {
  id: string;
  style_id: string;
  batch: string;
  cvr: string;
  image_sha256: string | null;
  status: 'ok' | 'adjudicate' | 'resolved' | 'rejected';
  issues: string | null;
  ruling: string | null;
}

/** Kept in memory on this device only, for this page visit. */
const state: {
  electionId?: string;
  countKey?: string;
  online?: CastVoteRecord[];
  unopened?: string[];
  close?: { fallback: boolean; lockedVotes: number };
  lot?: LotSource;
} = {};

const section = (title: string, ...body: (Node | string | null | false)[]) => h('section', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, title), ...body);

export function countView(ctx: Ctx, info: ElectionInfo): HTMLElement {
  if (state.electionId !== info.id) for (const k of Object.keys(state)) delete (state as Record<string, unknown>)[k];
  state.electionId = info.id;
  if (!ctx.staff.roles.includes('teller')) return status('info', 'Voting is closed. The tellers are counting.');
  return h(
    'div',
    {},
    h('p', {}, 'Work through these in order. Steps 1 and 2 can run at the same time on different devices.'),
    info.channels.online ? unlockSection(ctx, info) : null,
    paperSection(ctx, info),
    rulingSection(ctx, info),
    handCountSection(ctx, info),
    provisionalSection(ctx, info),
    certifySection(ctx, info),
  );
}

// ---- 1. online votes ---------------------------------------------------------------------------------------

function unlockSection(ctx: Ctx, info: ElectionInfo): HTMLElement {
  const key = h('input', { id: 'ul-key', type: 'password', autocomplete: 'off', spellcheck: false, class: 'code' });
  const out = h('div', { 'aria-live': 'polite' });
  const run = async (e: Event) => {
    e.preventDefault();
    try {
      const text = key.value.replace(/^CBKEY1\|[^|]+\|/, '').replace(/\s/g, '');
      const priv = fromBase64(text);
      if (priv.length !== 32) throw new Error('That isn’t a count key: it should be 44 characters.');
      const pub = countKeyPublicFromPrivate(priv);
      if (toBase64(pub) !== info.countKey?.publicKey) throw new Error('That is not this election’s count key.');
      out.replaceChildren(status('info', 'Downloading the locked votes…'));
      const r = await ctx.api.get<{ lockedVotes: string[]; close: { statement: never; signature: string | null }; issuerPublicKey: string }>(`/api/staff/e/${info.id}/locked-votes`);
      const check = await verifyClose(r.close, fromBase64(r.issuerPublicKey), r.lockedVotes);
      if (!check.ok) throw new Error(`The close doesn’t check out: ${check.reason}. Stop and tell the other tellers.`);
      let tlockDecrypt: ((a: string) => Promise<Uint8Array>) | undefined;
      if (r.lockedVotes.some((v) => v.includes(':tlock1:'))) tlockDecrypt = (await import('../shared/tlock.ts')).tlockDecrypt;
      const online: CastVoteRecord[] = [];
      const unopened: string[] = [];
      for (const [i, v] of r.lockedVotes.entries()) {
        try {
          online.push(await unlockVote(v, { publicKey: pub, privateKey: priv }, tlockDecrypt));
        } catch (err) {
          unopened.push(`vote ${i + 1}: ${(err as Error).message}`);
        }
        if (i % 25 === 24) out.replaceChildren(status('info', `Unlocking: ${i + 1} of ${r.lockedVotes.length}…`));
      }
      Object.assign(state, { countKey: text, online, unopened, close: { fallback: check.fallback, lockedVotes: r.lockedVotes.length } });
      key.value = '';
      show(out, 
        status('ok', `${check.fallback ? 'Fallback close (no issuer signature).' : 'The issuer’s signed close checks out.'} ${r.lockedVotes.length} locked ${r.lockedVotes.length === 1 ? 'vote matches' : 'votes match'} it; ${online.length} unlocked.`),
        unopened.length ? status('warn', `${unopened.length} couldn’t be opened and will be listed in the report: ${unopened.join('; ')}`) : null,
      );
    } catch (err) {
      out.replaceChildren(status('bad', (err as Error).message));
    }
  };
  return section(
    '1. Unlock the online votes',
    h('p', {}, 'Type or paste the private half of the count key (or scan its QR code into the box with a scanner app). It stays on this device until you certify, when it is published so anyone can recount.'),
    h('form', { onsubmit: run }, h('label', { for: 'ul-key' }, 'Count key, private half'), key, h('button', { type: 'submit' }, 'Check the close and unlock')),
    out,
    state.online ? status('ok', `Already unlocked on this page: ${state.online.length} votes.`) : null,
  );
}

// ---- 2. paper ------------------------------------------------------------------------------------------------

interface Pending {
  styleId: string;
  pages: number;
  sheets: Map<number, { votes: SheetVotes; pic: Picture }>;
}

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The photo with what was read drawn on it: ✓ in a blue box for a mark, ▲ in an amber box for an unclear one. */
function overlay(pic: Picture, read: SheetRead): HTMLCanvasElement {
  const k = Math.min(1, 520 / pic.rgba.width);
  const c = document.createElement('canvas');
  c.width = Math.round(pic.rgba.width * k);
  c.height = Math.round(pic.rgba.height * k);
  c.setAttribute('role', 'img');
  c.setAttribute('aria-label', 'The ballot as read: marks are boxed in blue with a tick, unclear marks in amber with a triangle');
  const ctx = c.getContext('2d')!;
  const full = document.createElement('canvas');
  full.width = pic.rgba.width;
  full.height = pic.rgba.height;
  full.getContext('2d')!.putImageData(pic.rgba, 0, 0);
  ctx.drawImage(full, 0, 0, c.width, c.height);
  ctx.font = `bold ${Math.max(12, 16 * k * 2)}px system-ui, sans-serif`;
  for (const m of read.marks) {
    if (m.state === 'empty') continue;
    const b = m.target.box;
    const p1 = project(read.map, { x: b.x - 2, y: b.y - 2 });
    const p2 = project(read.map, { x: b.x + b.w + 2, y: b.y + b.h + 2 });
    const colour = m.state === 'filled' ? '#1f5fbf' : '#c77700';
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = 3;
    ctx.strokeRect(p1.x * k, p1.y * k, (p2.x - p1.x) * k, (p2.y - p1.y) * k);
    ctx.fillText(m.state === 'filled' ? '✓' : '▲', p2.x * k + 3, p2.y * k);
  }
  return c;
}

function paperSection(ctx: Ctx, info: ElectionInfo): HTMLElement {
  const rules = info.rules;
  const pending = new Map<string, Pending>();
  const done = new Set<string>();
  const batch = h('select', { id: 'pp-batch' }, h('option', { value: 'main' }, 'Ordinary ballots'), h('option', { value: 'provisional' }, 'Provisional ballots the tellers upheld'));
  const out = h('div', { 'aria-live': 'polite' });
  const preview = h('div', {});
  const log = h('ol', { class: 'small' });
  let stored = 0;

  const store = async (code: string, p: Pending) => {
    const sheets = [...p.sheets.entries()].sort(([a], [b]) => a - b).map(([, s]) => s);
    const selections: Record<string, string[]> = {};
    const needsRuling: SheetIssue[] = [];
    for (const s of sheets) {
      Object.assign(selections, s.votes.selections);
      needsRuling.push(...s.votes.needsRuling);
    }
    for (const s of sheets) await ctx.api.req('PUT', `/api/staff/e/${info.id}/images/${s.pic.sha256}`, undefined, { data: s.pic.jpeg, type: 'image/jpeg' });
    const images = sheets.map((s) => s.pic.sha256);
    await ctx.api.post(`/api/staff/e/${info.id}/paper`, {
      records: [{ id: randomId(), styleId: p.styleId, batch: batch.value, cvr: selections, imageSha256: images[0], status: needsRuling.length ? 'adjudicate' : 'ok', issues: { needsRuling, images } }],
    });
    done.add(code);
    pending.delete(code);
    stored++;
    log.prepend(h('li', {}, needsRuling.length ? `▲ Ballot ${stored}: stored, needs a ruling (${needsRuling.length} ${needsRuling.length === 1 ? 'issue' : 'issues'})` : `✓ Ballot ${stored}: stored`));
  };

  // Every code received on paper, with its style: loaded once, then each sheet is checked here, on this device.
  let received: Map<string, string> | null = null;
  const receivedCodes = async () =>
    (received ??= new Map((await ctx.api.get<{ codes: { hash: string; styleId: string }[] }>(`/api/staff/e/${info.id}/paper-codes`)).codes.map((c) => [c.hash, c.styleId])));

  const add = async (pic: Picture) => {
    const known = await receivedCodes();
    const qr = findQr(pic.rgba);
    if (!qr) throw new Error('No QR code found. Make sure the whole sheet is in the picture, sharp and well lit.');
    const q = decodeQr(qr.text);
    if (!q) throw new Error('That QR code isn’t a coded-ballot ballot.');
    if (q.electionId !== info.id) throw new Error(`That ballot is for a different election (${q.electionId}).`);
    if (done.has(q.code)) throw new Error('This ballot was already read on this device. Set it aside.');
    const registered = known.get(codeHash(info.id, q.code));
    if (registered === undefined) throw new Error('This ballot’s code was never received by post or in person (or it voted online). Set it aside: it can’t be counted.');
    if (registered !== q.styleId) throw new Error('The QR code’s ballot style doesn’t match the one issued with this code. Set it aside and tell the other tellers.');
    const style = describeStyle(rules, q.styleId);
    if (style.provisional && batch.value !== 'provisional') throw new Error('This is a provisional ballot. Count provisional ballots only after the tellers uphold them, in the provisional batch.');
    if (!style.provisional && batch.value === 'provisional') throw new Error('This isn’t a provisional ballot. Switch back to ordinary ballots.');
    const layouts: PageLayout[] = layoutBallot(rules, style, { countKeyFingerprint: null });
    const layout = layouts[q.page - 1];
    if (!layout || layouts.length !== q.pages) throw new Error('This sheet doesn’t match this release’s ballot layout. Was it printed by another version?');
    const read = readSheet(pic.gray, layout, qr.centre);
    if ('error' in read) throw new Error(read.error);
    const votes = sheetVotes(rules, layout, read);
    preview.replaceChildren(overlay(pic, read));
    const p = pending.get(q.code) ?? { styleId: q.styleId, pages: q.pages, sheets: new Map() };
    p.sheets.set(q.page, { votes, pic });
    pending.set(q.code, p);
    if (p.sheets.size === p.pages) await store(q.code, p);
    else out.replaceChildren(status('info', `Read sheet ${q.page} of ${q.pages}. Now the other sheet${q.pages > 2 ? 's' : ''} of this ballot.`));
    return p.sheets.size === p.pages;
  };

  const files = h('input', { id: 'pp-files', type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true });
  files.addEventListener('change', async () => {
    const list = [...(files.files ?? [])];
    let ok = 0;
    const problems: string[] = [];
    for (const [i, f] of list.entries()) {
      out.replaceChildren(status('info', `Reading ${i + 1} of ${list.length}: ${f.name}`));
      try {
        if (await add(await fromFile(f))) ok++;
      } catch (e) {
        problems.push(`${f.name}: ${(e as Error).message}`);
      }
    }
    files.value = '';
    show(out, 
      status(problems.length ? 'warn' : 'ok', `${ok} ballot${ok === 1 ? '' : 's'} stored from ${list.length} image${list.length === 1 ? '' : 's'}.`),
      problems.length ? h('ul', {}, ...problems.map((p) => h('li', {}, p))) : null,
      pending.size ? status('warn', `${pending.size} ballot${pending.size === 1 ? ' is' : 's are'} still missing a sheet.`) : null,
    );
  });

  const video = h('video', { style: 'width:100%;max-width:520px;display:none;border-radius:8px', 'aria-label': 'Camera view' });
  let stream: MediaStream | null = null;
  const snap = h('button', { disabled: true }, 'Take the picture');
  const cam = h('button', { class: 'secondary' }, 'Use the camera');
  cam.addEventListener('click', async () => {
    if (stream) {
      stopCamera(stream);
      stream = null;
      video.style.display = 'none';
      snap.disabled = true;
      cam.textContent = 'Use the camera';
      return;
    }
    try {
      stream = await startCamera(video);
      video.style.display = 'block';
      snap.disabled = false;
      cam.textContent = 'Stop the camera';
    } catch (e) {
      out.replaceChildren(status('bad', (e as Error).message));
    }
  });
  snap.addEventListener('click', async () => {
    try {
      const whole = await add(await fromVideo(video));
      if (whole) out.replaceChildren(status('ok', 'Stored. Next ballot.'));
    } catch (e) {
      out.replaceChildren(status('bad', (e as Error).message));
    }
  });

  return section(
    '2. Read the paper ballots',
    h('p', {}, 'Open the box, unfold each ballot and read it: scanner images (about 200 dpi, colour or greyscale) or the camera, with the sheet flat on a darker surface and all four black corner squares in view. Each ballot is stored with its image, without its code.'),
    h('label', { for: 'pp-batch' }, 'Batch'),
    batch,
    h('label', { for: 'pp-files' }, 'Scanner images'),
    files,
    h('p', {}, cam, ' ', snap),
    video,
    out,
    preview,
    h('details', {}, h('summary', {}, 'Stored from this device'), log),
  );
}

// ---- 3. rulings ----------------------------------------------------------------------------------------------

async function paperRows(ctx: Ctx, info: ElectionInfo): Promise<PaperRow[]> {
  return (await ctx.api.get<{ records: PaperRow[] }>(`/api/staff/e/${info.id}/paper`)).records;
}

async function imageUrl(ctx: Ctx, info: ElectionInfo, sha: string): Promise<string> {
  const res = await fetch(`${ctx.api.base}/api/staff/e/${info.id}/images/${sha}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`image ${sha.slice(0, 8)}: HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

function rulingSection(ctx: Ctx, info: ElectionInfo): HTMLElement {
  const list = h('div', {});
  const load = async () => {
    try {
      const rows = (await paperRows(ctx, info)).filter((r) => r.status === 'adjudicate');
      if (!rows.length) return list.replaceChildren(status('ok', 'No ballots are waiting for a ruling.'));
      list.replaceChildren(h('p', {}, `${rows.length} waiting. Look at the image, decide what the voter meant, and count it or reject it.`));
      for (const [n, r] of rows.entries()) list.append(await rulingCard(ctx, info, r, n, load));
    } catch (e) {
      list.replaceChildren(status('bad', (e as Error).message));
    }
  };
  return section('3. Rule on unclear ballots', h('button', { class: 'secondary', onclick: load }, 'Show ballots waiting for a ruling'), list);
}

async function rulingCard(ctx: Ctx, info: ElectionInfo, r: PaperRow, n: number, reload: () => void): Promise<HTMLElement> {
  const rules = info.rules;
  const issues = (r.issues ? JSON.parse(r.issues) : {}) as { needsRuling?: SheetIssue[]; images?: string[] };
  const cvr = JSON.parse(r.cvr) as Record<string, string[]>;
  const style = describeStyle(rules, r.style_id);
  const contests = style.contests.map((id) => rules.contests.find((c) => c.id === id)!);
  const fields = contests.map((c) => contestFields(c, cvr[c.id] ?? [], `r${n}-`));
  const note = h('input', { id: `r${n}-note`, type: 'text', maxlength: '500' });
  const msg = h('div', {});
  const imgs = await Promise.all((issues.images ?? (r.image_sha256 ? [r.image_sha256] : [])).map(async (sha, i) => h('img', { src: await imageUrl(ctx, info, sha), alt: `Ballot image, sheet ${i + 1}`, style: 'max-width:100%;border:1px solid var(--line)' })));
  const send = async (reject: boolean) => {
    const selections: Record<string, string[]> = {};
    if (!reject) {
      for (const [i, f] of fields.entries()) {
        const g = f.get();
        if (!g.ok) return msg.replaceChildren(status('bad', g.message));
        selections[contests[i]!.id] = g.selection;
      }
    } else if (!note.value.trim()) return msg.replaceChildren(status('bad', 'Say why the ballot is rejected.'));
    try {
      await ctx.api.post(`/api/staff/e/${info.id}/paper/${r.id}/ruling`, reject ? { reject: true, note: note.value } : { cvr: selections, note: note.value });
      reload();
    } catch (e) {
      msg.replaceChildren(status('bad', (e as Error).message));
    }
  };
  return h(
    'div',
    { class: 'panel' },
    h('ul', {}, ...(issues.needsRuling ?? []).map((i) => h('li', {}, `▲ ${describeIssue(rules, i)}`))),
    ...imgs,
    h('p', { class: 'small' }, 'What the app read is filled in below. Change it to what the voter meant.'),
    ...fields.map((f) => f.node),
    h('label', { for: `r${n}-note` }, 'Note for the report (required to reject)'),
    note,
    h('p', {}, h('button', { onclick: () => send(false) }, 'Count it like this'), ' ', h('button', { class: 'secondary', onclick: () => send(true) }, 'Reject this ballot')),
    msg,
  );
}

// ---- 4. hand count -------------------------------------------------------------------------------------------

function handCountSection(ctx: Ctx, info: ElectionInfo): HTMLElement {
  const forms = info.rules.contests.map((c, ci) => {
    const options = c.method === 'yes_no' ? ['yes', 'no', ...(c.allow_abstain ? ['abstain'] : [])].map((o) => ({ id: o, name: o[0]!.toUpperCase() + o.slice(1) })) : c.candidates;
    const inputs = options.map((o) => ({ id: o.id, input: h('input', { id: `hc${ci}-${o.id}`, type: 'number', min: '0', step: '1', inputmode: 'numeric', value: '0' }) }));
    const wiRows = h('div', {});
    const addWi = () => {
      const name = h('input', { type: 'text', 'aria-label': 'Write-in name' });
      const n = h('input', { type: 'number', min: '0', step: '1', value: '0', 'aria-label': 'Ballots for this write-in' });
      wiRows.append(h('div', { class: 'rank-row' }, name, n));
      return { name, n };
    };
    const wis: { name: HTMLInputElement; n: HTMLInputElement }[] = [];
    const msg = h('div', {});
    const ranked = c.method === 'irv' || c.method === 'stv';
    return h(
      'form',
      {
        class: 'panel',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const totals: Record<string, string> = {};
          for (const i of inputs) totals[i.id] = String(Math.max(0, Math.floor(Number(i.input.value) || 0)));
          for (const w of wis) if (w.name.value.trim()) totals[`write-in:${w.name.value.trim()}`] = String(Math.floor(Number(w.n.value) || 0));
          try {
            await ctx.api.post(`/api/staff/e/${info.id}/hand-count`, { contestId: c.id, totals });
            msg.replaceChildren(status('ok', 'Your hand count is saved. It is compared with the app’s count when you certify.'));
          } catch (err) {
            msg.replaceChildren(status('bad', (err as Error).message));
          }
        },
      },
      h('h4', { style: 'margin-top:0' }, c.title),
      h('p', { class: 'small' }, ranked ? 'Count first choices only, on paper ballots only.' : 'Count every mark, on paper ballots only (not weighted).'),
      ...inputs.map((i, k) => h('div', { class: 'rank-row' }, h('label', { for: i.input.id, style: 'margin:0;font-weight:400' }, options[k]!.name), i.input)),
      'write_ins' in c && c.write_ins ? h('div', {}, wiRows, h('button', { type: 'button', class: 'secondary', onclick: () => wis.push(addWi()) }, 'Add a write-in name')) : null,
      h('button', { type: 'submit' }, 'Save my hand count'),
      msg,
    );
  });
  return section('4. Hand count', h('p', {}, 'Each teller counts the paper by hand and enters their own totals without looking at the app’s. A mismatch blocks certification.'), ...forms);
}

// ---- 5. provisional ------------------------------------------------------------------------------------------

function provisionalSection(ctx: Ctx, info: ElectionInfo): HTMLElement {
  const up = h('input', { id: 'pv-up', type: 'number', min: '0', step: '1', value: '0' });
  const rej = h('input', { id: 'pv-rej', type: 'number', min: '0', step: '1', value: '0' });
  const msg = h('div', {});
  return section(
    '5. Provisional ballots',
    h('p', {}, 'Ballots from members whose eligibility was disputed are kept sealed. Rule on each: upheld ones are read in the provisional batch (step 2); rejected ones are destroyed unread.'),
    h(
      'form',
      {
        onsubmit: async (e: Event) => {
          e.preventDefault();
          try {
            await ctx.api.post(`/api/staff/e/${info.id}/provisional`, { upheld: Number(up.value), rejected: Number(rej.value) });
            msg.replaceChildren(status('ok', 'Recorded in the public log.'));
          } catch (err) {
            msg.replaceChildren(status('bad', (err as Error).message));
          }
        },
      },
      h('label', { for: 'pv-up' }, 'Upheld'),
      up,
      h('label', { for: 'pv-rej' }, 'Rejected and destroyed unread'),
      rej,
      h('button', { type: 'submit', class: 'secondary' }, 'Record the provisional ruling'),
    ),
    msg,
  );
}

// ---- 6. count and certify ------------------------------------------------------------------------------------

function certifySection(ctx: Ctx, info: ElectionInfo): HTMLElement {
  const out = h('div', { 'aria-live': 'polite' });
  const run = async () => {
    try {
      out.replaceChildren(status('info', 'Counting…'));
      const counts = await ctx.api.get<{ lockedVotes: number }>(`/api/public/e/${info.id}/counts`);
      if (info.channels.online && counts.lockedVotes > 0 && !state.online) throw new Error('Unlock the online votes first (step 1).');
      const rows = await paperRows(ctx, info);
      const waiting = rows.filter((r) => r.status === 'adjudicate').length;
      if (waiting) throw new Error(`${waiting} ballot${waiting === 1 ? ' is' : 's are'} still waiting for a ruling (step 3).`);
      const paper: CastVoteRecord[] = rows.filter((r) => r.status === 'ok' || r.status === 'resolved').map((r) => ({ styleId: r.style_id, selections: JSON.parse(r.cvr) }));
      const data = await ctx.api.get<ReportData>(`/api/staff/e/${info.id}/report-data`);
      const spent = data.counts.spent;
      const input = { rules: info.rules, online: state.online ?? [], paper, styles: data.styles, ballotsReceived: spent.mail + spent.online + spent.in_person, lot: state.lot };
      let t = tally(input);
      if (t.needsLot) {
        if (!data.closedAt) throw new Error('No close time recorded.');
        const round = firstRoundAfter(Math.floor(Date.parse(data.closedAt) / 1000));
        out.replaceChildren(status('info', `A tie needs a lot: fetching drand round ${round}…`));
        const { drandRound } = await import('../shared/tlock.ts');
        state.lot = lotForClose(await drandRound(round), new Date(data.closedAt));
        t = tally({ ...input, lot: state.lot });
      }
      out.replaceChildren(...resultsView(ctx, info, t, data, rows, paper));
    } catch (e) {
      out.replaceChildren(status('bad', (e as Error).message));
    }
  };
  return section('6. Count and certify', h('p', {}, 'Counts everything on this device, shows the results, then certifies: the results, the teller report and the count key are published.'), h('button', { onclick: run }, 'Count'), out);
}

function resultsView(ctx: Ctx, info: ElectionInfo, t: Tally, data: ReportData, rows: PaperRow[], paper: CastVoteRecord[]): Node[] {
  const nodes: Node[] = [
    status(t.quorum.met ? 'ok' : 'warn', t.quorum.text),
    ...t.contests.map((c) =>
      h(
        'div',
        { class: 'panel' },
        h('h4', { style: 'margin-top:0' }, c.title),
        h('p', {}, h('strong', {}, c.outcome ? (c.outcome === 'passed' ? '✓ Passed' : '✗ Did not pass') : `Elected: ${c.winnerNames.join(', ') || 'nobody'}`)),
        c.smallGroupNote ? status('warn', c.smallGroupNote) : null,
        h('details', {}, h('summary', {}, 'How it was counted'), h('ol', {}, ...c.explanation.map((s) => h('li', {}, s)))),
      ),
    ),
  ];
  const ack = h('input', { type: 'checkbox', id: 'cf-ack' });
  if (t.smallGroups.length) {
    nodes.push(
      status(
        'warn',
        `Small groups: ${t.smallGroups.map((g) => `${g.styleId} (${g.ballots})`).join(', ')}. Publishing the count key lets anyone open each online vote with its ballot style, so members in these groups may be identifiable.`,
      ),
      h('label', { class: 'choice' }, ack, 'We have considered this and will publish anyway'),
    );
  } else ack.checked = true;
  const msg = h('div', {});
  const lots = t.contests.flatMap((c) => c.lots);
  const report = {
    software: `coded-ballot ${__VERSION__}`,
    rulesSha256: data.rulesSha256,
    close: { at: data.closedAt, fallback: state.close?.fallback ?? info.closeFallback, lockedVotes: state.close?.lockedVotes ?? 0 },
    issuerKeyDestroyedAt: data.keyDestroyedAt,
    ballots: { online: state.online?.length ?? 0, onlineNotOpened: state.unopened ?? [], paperCounted: paper.length, paperRejected: rows.filter((r) => r.status === 'rejected').length, paperRuledOn: rows.filter((r) => r.status === 'resolved').length },
    codes: data.counts,
    rejectedUses: data.rejectedUses.map((u) => ({ at: u.at, channel: u.channel, reason: u.reason })),
    rollChanges: data.rollChanges.map((r) => ({ kind: r.kind, at: r.at })),
    tamperChecks: data.tamperChecks.map((x) => ({ at: x.at, ok: !!x.ok })),
    handCounts: data.handCounts.map((x) => ({ contest: x.contest_id, teller: x.teller, at: x.at })),
    provisional: data.provisional,
    smallGroups: t.smallGroups,
    quorum: t.quorum.text,
    lots,
    summary: summarise(t),
  };
  nodes.push(
    h('details', {}, h('summary', {}, 'The teller report'), h('pre', { style: 'white-space:pre-wrap' }, JSON.stringify(report, null, 2))),
    h(
      'button',
      {
        onclick: async () => {
          if (!ack.checked) return msg.replaceChildren(status('bad', 'Tick the small-group box first.'));
          if (info.countKey && !state.countKey) return msg.replaceChildren(status('bad', 'Enter the count key in step 1 first: it is published when you certify, even if there were no online votes.'));
          if (!confirm('Certify and publish the results, the teller report and the count key? This can’t be undone.')) return;
          try {
            await ctx.api.post(`/api/staff/e/${info.id}/certify`, {
              results: { contests: t.contests, quorum: t.quorum, ballots: report.ballots },
              report,
              countKeyPrivate: state.countKey,
              paperTotals: t.paperTotals,
            });
            ctx.reload();
          } catch (e) {
            msg.replaceChildren(status('bad', (e as Error).message));
          }
        },
      },
      'Certify and publish',
    ),
    msg,
  );
  return nodes;
}
