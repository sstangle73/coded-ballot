// The public page: the ballot tracker, counts by channel, and after certification the results, the teller report and
// everything needed to recount the online votes.
import { codeHash, countKeyPublicFromPrivate, fromBase64, paperTotals, parseTypedCode, toBase64, unlockVote, verifyClose, type CastVoteRecord, type Rules } from '@coded-ballot/core';
import { Api, serverFromFragment } from '../shared/api.ts';
import { $, fragmentParams, h, restartOnNewFragment, show, status } from '../shared/ui.ts';

const params = fragmentParams();
const app = $('#app');
let api: Api;
let id = params.get('e') ?? '';

const LABEL: Record<string, string> = { mail: 'By post', online: 'Online', in_person: 'In person' };

async function start() {
  try {
    api = new Api(serverFromFragment(params));
  } catch (e) {
    return show(app, status('bad', (e as Error).message));
  }
  if (!id) return show(app, status('info', 'Open this page from the link on your ballot or in your email.'));
  let info: any;
  try {
    info = await api.get(`/api/public/e/${encodeURIComponent(id)}`);
  } catch (e) {
    return show(app, status('bad', (e as Error).message));
  }
  id = info.id;
  document.title = info.title;
  $('#title').textContent = info.title;
  $('#org').textContent = info.organisation;
  const counts = await api.get(`/api/public/e/${id}/counts`);
  const parts: (Node | string)[] = [
    h('h2', {}, 'Ballots received'),
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, 'How'), h('th', { class: 'num' }, 'Ballots'))),
      h(
        'tbody',
        {},
        ...(['mail', 'online', 'in_person'] as const).map((c) => h('tr', {}, h('td', {}, LABEL[c]!), h('td', { class: 'num' }, String(counts.spent[c])))),
        h('tr', {}, h('td', {}, 'Not used yet'), h('td', { class: 'num' }, String(counts.unused))),
        h('tr', {}, h('td', {}, 'Ballots issued (including replacements)'), h('td', { class: 'num' }, String(counts.issued))),
        h('tr', {}, h('td', {}, 'Replaced (lost or spoilt)'), h('td', { class: 'num' }, String(counts.reissued))),
        h('tr', {}, h('td', {}, 'Second uses turned away'), h('td', { class: 'num' }, String(counts.rejectedUses))),
      ),
    ),
    info.countKey ? h('p', {}, 'Count key fingerprint: ', h('span', { class: 'fingerprint', style: 'font-size:1.1rem' }, info.countKey.fingerprint)) : null,
    h('p', { class: 'small' }, `Rules file SHA-256: ${info.rulesSha256}`),
  ].filter(Boolean) as (Node | string)[];
  if (info.status === 'certified' || info.status === 'purged') parts.push(...(await results(info)));
  else parts.push(status('info', `Results are published when the tellers certify them. The election is ${info.status}.`));
  parts.push(...(await logTable()));
  show(app, ...parts);
}

async function results(info: { rules: Rules; countKey: { publicKey: string } | null }): Promise<Node[]> {
  const r = await api.get(`/api/public/e/${id}/results`);
  const out: Node[] = [h('h2', {}, 'Results')];
  if (r.close?.fallback) out.push(status('warn', 'This election was closed by the tellers’ fallback close, not the issuer’s signed close.'));
  for (const c of (r.results?.contests ?? []) as any[]) {
    out.push(
      h(
        'section',
        { class: 'panel' },
        h('h3', { style: 'margin-top:0' }, c.title),
        c.smallGroupNote ? status('info', c.smallGroupNote) : null,
        c.status === 'needs_lot' ? status('warn', 'Waiting for a tie to be drawn by lot.') : null,
        c.outcome ? h('p', {}, h('strong', {}, c.outcome === 'passed' ? '✓ Passed' : '✗ Did not pass')) : null,
        c.winners?.length && !c.outcome ? h('p', {}, h('strong', {}, `Elected: ${c.winnerNames.join(', ')}`)) : null,
        h('details', {}, h('summary', {}, 'How it was counted, step by step'), h('ol', {}, ...(c.explanation as string[]).map((s) => h('li', {}, s)))),
      ),
    );
  }
  const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
  out.push(h('p', {}, h('a', { href: URL.createObjectURL(blob), download: `${id}-recount.json` }, 'Download everything needed to recount the online votes'), ' (the locked votes, the signed close and the published count key).'));
  if (r.lockedVotes && r.countKeyPrivate) {
    const box = h('div', { 'aria-live': 'polite' });
    out.push(h('p', {}, h('button', { class: 'secondary', onclick: () => recount(r, info, box) }, 'Recount the online votes in this browser')), box);
  }
  if (r.report) out.push(h('details', {}, h('summary', {}, 'Teller report'), h('pre', { style: 'white-space:pre-wrap' }, JSON.stringify(r.report, null, 2))));
  return out;
}

/**
 * Anyone's recount of the online votes: check the close covers exactly these locked votes, check the published count
 * key is the one the votes were locked with, open every vote, and total the choices. Paper ballots aren't published,
 * so this checks the online part; the teller report says how many of each there were.
 */
async function recount(r: any, info: { rules: Rules; countKey: { publicKey: string } | null }, box: HTMLElement) {
  try {
    show(box, status('info', 'Recounting…'));
    const check = await verifyClose(r.close, fromBase64(r.issuerPublicKey), r.lockedVotes);
    if (!check.ok) return show(box, status('bad', `The close doesn’t match: ${check.reason}.`));
    const priv = fromBase64(r.countKeyPrivate);
    const pub = countKeyPublicFromPrivate(priv);
    if (!info.countKey || toBase64(pub) !== info.countKey.publicKey) return show(box, status('bad', 'The published count key isn’t the one the votes were locked with.'));
    const tlock = (r.lockedVotes as string[]).some((v) => v.includes(':tlock1:')) ? (await import('../shared/tlock.ts')).tlockDecrypt : undefined;
    const votes: CastVoteRecord[] = [];
    let failed = 0;
    for (const v of r.lockedVotes as string[]) {
      try {
        votes.push(await unlockVote(v, { publicKey: pub, privateKey: priv }, tlock));
      } catch {
        failed++;
      }
    }
    const totals = paperTotals(info.rules, votes); // the same mark totals, for the online votes
    const reported = r.report?.ballots?.online;
    show(
      box,
      status(check.fallback ? 'warn' : 'ok', `${check.fallback ? 'Fallback close (no issuer signature). ' : 'The issuer’s signed close covers exactly these votes. '}${votes.length} online ${votes.length === 1 ? 'vote' : 'votes'} opened${failed ? `, ${failed} couldn’t be` : ''}.`),
      reported !== undefined ? status(reported === votes.length ? 'ok' : 'bad', reported === votes.length ? `That matches the teller report (${reported} online).` : `The teller report says ${reported} online.`) : null,
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Contest'), h('th', {}, 'Online votes (first choices for ranked contests)'))),
        h(
          'tbody',
          {},
          ...info.rules.contests.map((c) =>
            h('tr', {}, h('td', {}, c.title), h('td', {}, Object.entries(totals[c.id] ?? {}).map(([k, n]) => `${'candidates' in c ? (c.candidates.find((x) => x.id === k)?.name ?? k) : k[0]!.toUpperCase() + k.slice(1)}: ${n}`).join(', ') || 'none')),
          ),
        ),
      ),
    );
  } catch (e) {
    show(box, status('bad', (e as Error).message));
  }
}

async function logTable(): Promise<Node[]> {
  const { log } = await api.get<{ log: { seq: number; at: string; kind: string; detail: object }[] }>(`/api/public/e/${id}/log`);
  return [
    h(
      'details',
      {},
      h('summary', {}, `Public log (${log.length} entries)`),
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'When (UTC)'), h('th', {}, 'What'), h('th', {}, 'Detail'))),
        h('tbody', {}, ...log.map((l) => h('tr', {}, h('td', {}, l.at.slice(0, 19).replace('T', ' ')), h('td', {}, l.kind.replace(/_/g, ' ')), h('td', { class: 'small' }, JSON.stringify(l.detail))))),
      ),
    ),
  ];
}

$('#track').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('#track-result');
  const p = parseTypedCode(($('#code') as HTMLInputElement).value);
  if (!p.ok) return show(out, status('bad', p.reason === 'check' ? 'That code has a typing mistake.' : 'That isn’t a whole code: 17 characters.'));
  try {
    const t = await api.get(`/api/public/e/${id}/track/${codeHash(id, p.code)}`);
    const msg: Record<string, [kind: 'ok' | 'warn' | 'bad' | 'info', text: string]> = {
      not_used: ['info', 'Not used yet. If you have voted, it may not have been scanned in yet.'],
      received: ['ok', `Received ${t.channel === 'mail' ? 'by post' : 'in person'} on ${t.date}.`],
      cast_online: ['ok', 'Cast online.'],
      replaced: ['warn', 'This ballot was replaced by a newer one, so it can’t be used.'],
      unknown: ['bad', 'That isn’t a code for this election.'],
    };
    const [kind, text] = msg[t.status]!;
    show(out, status(kind, text));
  } catch (err) {
    show(out, status('bad', (err as Error).message));
  }
});

restartOnNewFragment();
start();
