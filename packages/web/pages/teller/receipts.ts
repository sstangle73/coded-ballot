// While voting is open: receiving paper ballots (the QR code on the outside of the folded sheet spends the code),
// checking the live voting page against the release, and the tellers' fallback close if the issuer can't sign.
import { codeHash, decodeQr, parseTypedCode } from '@coded-ballot/core';
import { compareRelease, type Manifest } from '../shared/release.ts';
import { h, status } from '../shared/ui.ts';
import { startCamera, stopCamera, watchQr } from './images.ts';
import type { Ctx, ElectionInfo } from './teller.ts';

type SpendAnswer = { ok: true; styleId: string } | { ok: false; reason: 'unknown' | 'wrong_style' | 'revoked' | 'already_spent'; spentBy?: string };

const CHANNEL = { mail: 'by post', in_person: 'in person', online: 'online' } as Record<string, string>;

function describe(r: SpendAnswer): HTMLElement {
  if (r.ok) return status('ok', 'Accepted. Put the ballot in the box unopened.');
  switch (r.reason) {
    case 'already_spent':
      return status('bad', `Turned away: this code was already used ${CHANNEL[r.spentBy ?? ''] ?? ''}. Set the ballot aside unopened and record it.`);
    case 'revoked':
      return status('bad', 'Turned away: this ballot was replaced by a newer one. Set it aside unopened.');
    case 'wrong_style':
      return status('bad', 'Turned away: the QR code doesn’t match this code’s ballot. Set it aside unopened and tell the other tellers.');
    default:
      return status('bad', 'Turned away: that isn’t a code for this election.');
  }
}

export function openView(ctx: Ctx, info: ElectionInfo): HTMLElement {
  const parts: Node[] = [];
  if (ctx.staff.roles.includes('teller')) parts.push(receipts(ctx, info));
  parts.push(tamperCheck(ctx, info));
  if (ctx.staff.roles.includes('teller') && Date.now() >= Date.parse(info.dates.voting_closes)) parts.push(fallbackClose(ctx, info));
  else parts.push(h('p', { class: 'small' }, `Voting closes ${new Date(info.dates.voting_closes).toLocaleString()}. The issuer then signs the close with the issuer tool.`));
  return h('div', {}, ...parts);
}

function receipts(ctx: Ctx, info: ElectionInfo): HTMLElement {
  const channels = (['mail', 'in_person'] as const).filter((c) => info.channels[c]);
  const choice = h('select', { id: 'rc-channel' }, ...channels.map((c) => h('option', { value: c }, c === 'mail' ? 'Arrived by post' : 'Handed in at the meeting')));
  const result = h('div', { 'aria-live': 'assertive' });
  const log = h('ol', { reversed: true, class: 'small' });
  let accepted = 0;
  const spend = async (hash: string, styleId: string | undefined, label: string) => {
    const r = await ctx.api.post<SpendAnswer>(`/api/staff/e/${info.id}/receipts`, { hash, styleId, channel: choice.value });
    if (r.ok) accepted++;
    result.replaceChildren(describe(r), h('p', {}, `${accepted} accepted on this device so far.`));
    log.prepend(h('li', {}, `${new Date().toLocaleTimeString()} ${label}: ${r.ok ? '✓ accepted' : `✗ turned away (${r.reason.replace('_', ' ')})`}`));
    if (navigator.vibrate) navigator.vibrate(r.ok ? 60 : [60, 80, 60, 80, 200]);
  };
  const video = h('video', { style: 'width:100%;max-width:480px;display:none;border-radius:8px', 'aria-label': 'Camera view' });
  let stream: MediaStream | null = null;
  let stopWatch: (() => void) | null = null;
  const camBtn = h('button', {}, 'Start the camera');
  camBtn.addEventListener('click', async () => {
    if (stream) {
      stopWatch?.();
      stopCamera(stream);
      stream = null;
      video.style.display = 'none';
      camBtn.textContent = 'Start the camera';
      return;
    }
    try {
      stream = await startCamera(video);
      video.style.display = 'block';
      camBtn.textContent = 'Stop the camera';
      stopWatch = watchQr(video, async (text) => {
        const q = decodeQr(text);
        if (!q) return void result.replaceChildren(status('warn', 'That QR code isn’t a coded-ballot ballot.'));
        if (q.electionId !== info.id) return void result.replaceChildren(status('bad', `Turned away: that ballot is for a different election (${q.electionId}).`));
        if (q.page !== 1) return void result.replaceChildren(status('warn', `That is sheet ${q.page} of ${q.pages}. Scan sheet 1, on the outside of the fold.`));
        await spend(codeHash(info.id, q.code), q.styleId, `ballot …${q.code.slice(-4)}`);
      });
    } catch (e) {
      result.replaceChildren(status('bad', (e as Error).message));
    }
  });
  const typed = h('input', { id: 'rc-code', type: 'text', class: 'code', autocomplete: 'off', spellcheck: false });
  const typedForm = h(
    'form',
    {
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const p = parseTypedCode(typed.value);
        if (!p.ok) return result.replaceChildren(status('bad', p.reason === 'check' ? 'That code has a typing mistake.' : 'That isn’t a whole code.'));
        await spend(codeHash(info.id, p.code), undefined, `typed …${p.code.slice(-4)}`);
        typed.value = '';
      },
    },
    h('label', { for: 'rc-code' }, 'Or type the code printed under the QR code'),
    typed,
    h('button', { type: 'submit', class: 'secondary' }, 'Receive it'),
  );
  return h(
    'section',
    {},
    h('h3', {}, 'Receive paper ballots'),
    h('p', {}, 'Scan the QR code on the outside of each folded ballot as it arrives. Don’t unfold it: the marks stay inside until the count.'),
    h('label', { for: 'rc-channel' }, 'These ballots'),
    choice,
    h('p', {}, camBtn),
    video,
    result,
    typedForm,
    h('details', {}, h('summary', {}, 'Received on this device'), log),
  );
}

const SITE_KEY = 'coded-ballot.project-site';

function tamperCheck(ctx: Ctx, info: ElectionInfo): HTMLElement {
  let saved = '';
  try {
    saved = localStorage.getItem(SITE_KEY) ?? '';
  } catch {}
  const site = h('input', { id: 'tc-site', type: 'url', value: saved, placeholder: 'https://…/coded-ballot/' });
  const out = h('div', { 'aria-live': 'polite' });
  let timer: number | undefined;
  const run = async () => {
    const base = site.value.trim().replace(/\/?$/, '/');
    try {
      localStorage.setItem(SITE_KEY, base);
    } catch {}
    try {
      const manifest = (await (await fetch(new URL('release-hashes.json', base), { cache: 'no-store' })).json()) as Manifest;
      const r = await compareRelease(location.origin, manifest);
      await ctx.api.post(`/api/staff/e/${info.id}/tamper-checks`, { ok: r.ok, detail: { release: manifest.version, files: r.files.filter((f) => !f.ok).map((f) => f.path) } });
      out.replaceChildren(
        r.ok ? status('ok', `${new Date().toLocaleTimeString()}: the voting page matches release ${manifest.version}.`) : status('bad', `${new Date().toLocaleTimeString()}: the voting page does NOT match the release. Tell the other tellers now; it is logged.`),
      );
    } catch (e) {
      out.replaceChildren(status('warn', `Couldn’t check: ${(e as Error).message}`));
    }
  };
  return h(
    'section',
    {},
    h('h3', {}, 'Check the voting page'),
    h('p', {}, 'Compares the voting page this server is giving members with the published release, from this device. Each check goes in the teller report. Leave this page open to check every 15 minutes.'),
    h('label', { for: 'tc-site' }, 'The project’s own site (where releases are published)'),
    site,
    h(
      'button',
      {
        onclick: () => {
          run();
          clearInterval(timer);
          timer = window.setInterval(run, 15 * 60_000);
        },
      },
      'Check now, then every 15 minutes',
    ),
    out,
  );
}

function fallbackClose(ctx: Ctx, info: ElectionInfo): HTMLElement {
  const msg = h('div', {});
  return h(
    'section',
    {},
    h('h3', {}, 'If the issuer can’t sign the close'),
    h('p', {}, 'Normally the issuer signs the close with the issuer tool. If every copy of the issuer passphrase is lost, two tellers who were set up before voting opened can close it instead. The public log and the results say it was a fallback close.'),
    h(
      'button',
      {
        class: 'secondary',
        onclick: async () => {
          if (!confirm('Approve a fallback close? This is recorded publicly.')) return;
          try {
            const r = await ctx.api.post<{ closed: boolean; approvals?: number; needed?: number }>(`/api/staff/e/${info.id}/close/fallback`, {});
            if (r.closed) ctx.reload();
            else msg.replaceChildren(status('info', `Your approval is recorded: ${r.approvals} of ${r.needed} needed.`));
          } catch (e) {
            msg.replaceChildren(status('bad', (e as Error).message));
          }
        },
      },
      'Approve a fallback close',
    ),
    msg,
  );
}
