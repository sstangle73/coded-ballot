// Before voting opens: the count key (made on a teller's device; only its public half goes to the server) and
// opening the election.
import QRCode from 'qrcode';
import { countKeyToText, fingerprint, newCountKey, toBase64 } from '@coded-ballot/core';
import { h, status } from '../shared/ui.ts';
import type { Ctx, ElectionInfo } from './teller.ts';

const grouped = (s: string) => s.match(/.{1,4}/g)!.join(' ');

export function setupView(ctx: Ctx, info: ElectionInfo): HTMLElement {
  const isTeller = ctx.staff.roles.includes('teller');
  const parts: (Node | null)[] = [];
  if (ctx.staff.roles.includes('issuer')) parts.push(rulesFile(ctx, info));
  if (info.channels.online) {
    parts.push(h('h3', {}, 'The count key'));
    if (!info.countKey) parts.push(isTeller ? makeKey(ctx, info) : status('info', 'A teller must make the count key before voting can open.'));
    else {
      parts.push(
        h('p', {}, 'Count key fingerprint, to print on every ballot: ', h('span', { class: 'fingerprint' }, info.countKey.fingerprint)),
        h('p', { class: 'small' }, 'If you made this key, read this fingerprint to the issuer from your own copy. The issuer page asks them to check it with you before printing ballots.'),
      );
      if (isTeller) parts.push(confirmCopy(ctx, info));
    }
  }
  parts.push(h('h3', {}, 'Open voting'), openButton(ctx, info));
  return h('div', {}, ...parts);
}

/** Until voting opens, the issuer may replace the rules file (same election ID). */
function rulesFile(ctx: Ctx, info: ElectionInfo): HTMLElement {
  const file = h('input', { id: 'rules-replace', type: 'file', accept: '.yaml,.yml,text/yaml' });
  const msg = h('div', {});
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      await ctx.api.req('PUT', `/api/staff/e/${encodeURIComponent(info.id)}/rules`, { rulesYaml: await f.text() });
      ctx.reload();
    } catch (e) {
      msg.replaceChildren(status('bad', (e as Error).message));
    }
  });
  return h(
    'details',
    {},
    h('summary', {}, 'The rules file'),
    h('p', { class: 'small' }, `Rules SHA-256 ${info.rulesSha256}. Until voting opens you can replace it with a corrected file for the same election. Do it before printing ballots: printed ballots keep the old wording.`),
    h('label', { for: 'rules-replace' }, 'Replace the rules file'),
    file,
    msg,
  );
}

function makeKey(ctx: Ctx, info: ElectionInfo): HTMLElement {
  const box = h('div', {});
  const start = h(
    'button',
    {
      onclick: async () => {
        const key = await newCountKey();
        const text = countKeyToText(key.privateKey);
        const fp = fingerprint(key.publicKey);
        const qr = await QRCode.toDataURL(`CBKEY1|${info.id}|${text}`, { errorCorrectionLevel: 'M', margin: 4, width: 240 });
        const check = h('input', { id: 'ck-check', type: 'text', autocomplete: 'off', spellcheck: false, class: 'code' });
        const msg = h('div', {});
        const file = new Blob([`coded-ballot count key\nElection: ${info.id}\nFingerprint: ${fp}\nPrivate half (keep secret until certification):\n${text}\n`], { type: 'text/plain' });
        box.replaceChildren(
          status('warn', 'This is the private half of the count key. Only the tellers may see it. Save two copies now, kept apart: this page will not show it again.'),
          h(
            'div',
            { class: 'panel printable' },
            h('p', {}, `Election ${info.id}: count key, private half`),
            h('p', { class: 'fingerprint', style: 'word-break:break-all' }, grouped(text)),
            h('img', { src: qr, alt: 'The same key as a QR code, for scanning at the count', width: '240', height: '240' }),
            h('p', {}, `Fingerprint: ${fp}`),
          ),
          h('p', {}, h('button', { onclick: () => print() }, 'Print it'), ' ', h('a', { href: URL.createObjectURL(file), download: `count-key-${info.id}.txt`, class: 'button secondary' }, 'Save it as a file')),
          h('label', { for: 'ck-check' }, 'To show you have saved it, type its last 8 characters'),
          check,
          h(
            'button',
            {
              onclick: async () => {
                if (check.value.replace(/\s/g, '') !== text.slice(-8)) return msg.replaceChildren(status('bad', 'Those aren’t the last 8 characters. Check the copy you saved.'));
                try {
                  const r = await ctx.api.post<{ fingerprint: string }>(`/api/staff/e/${info.id}/count-key`, { publicKey: toBase64(key.publicKey) });
                  if (r.fingerprint !== fp) throw new Error('The server stored a different key. Stop and tell the other tellers.');
                  key.privateKey.fill(0);
                  ctx.reload();
                } catch (e) {
                  msg.replaceChildren(status('bad', (e as Error).message));
                }
              },
            },
            'Send the public half to the server',
          ),
          msg,
        );
      },
    },
    'Make the count key on this device',
  );
  box.append(
    h('p', {}, 'Online votes are locked with the count key. Its private half stays with the tellers until the count, and is published after certification so anyone can recount. Make it on a device you trust; the server only ever gets the public half.'),
    start,
  );
  return box;
}

function confirmCopy(ctx: Ctx, info: ElectionInfo): HTMLElement {
  const msg = h('div', {});
  const id = info.id;
  return h(
    'div',
    {},
    h('p', {}, 'Before voting opens, a second teller must hold a second copy of the private half, kept apart from the first.'),
    h(
      'button',
      {
        class: 'secondary',
        onclick: async () => {
          try {
            await ctx.api.post(`/api/staff/e/${id}/count-key/confirm`, {});
            msg.replaceChildren(status('ok', 'Second copy confirmed.'));
          } catch (e) {
            msg.replaceChildren(status('bad', (e as Error).message));
          }
        },
      },
      'A second copy is stored separately',
    ),
    msg,
  );
}

function openButton(ctx: Ctx, info: ElectionInfo): HTMLElement {
  const msg = h('div', {});
  return h(
    'div',
    {},
    h('p', {}, `Voting is set to open ${new Date(info.dates.voting_opens).toLocaleString()} and close ${new Date(info.dates.voting_closes).toLocaleString()}. Opening checks that the codes, the roll, the passphrase backup and the count key are all in place.`),
    h(
      'button',
      {
        onclick: async () => {
          try {
            await ctx.api.post(`/api/staff/e/${info.id}/open`, {});
            ctx.reload();
          } catch (e) {
            msg.replaceChildren(status('bad', (e as Error).message));
          }
        },
      },
      'Open voting',
    ),
    msg,
  );
}
