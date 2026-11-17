// The online voting page. It runs from the organisation's server or from the project's own copy; the election link
// carries the server address, election ID and one-time token after the #, which browsers never send to a server.
import { codeHash, fromBase64, parseTypedCode, sealVote, sealedBody, TLOCK_PREFIX, type BallotStyle, type Contest } from '@coded-ballot/core';
import { Api, serverFromFragment } from '../shared/api.ts';
import { $, fragmentParams, fragmentWithout, h, restartOnNewFragment, show, status } from '../shared/ui.ts';

interface Info {
  id: string;
  title: string;
  organisation: string;
  status: string;
  dates: { voting_opens: string; voting_closes: string };
  channels: { online: boolean };
  timeLock: boolean;
  rules: { contests: Contest[] };
  countKey: { publicKey: string; fingerprint: string } | null;
}

const app = $('#app');
const params = fragmentParams();
let api: Api;
let info: Info;
const token = params.get('t');
const electionId = params.get('e');

function fail(text: string) {
  show(app, status('bad', text));
}

async function start() {
  try {
    api = new Api(serverFromFragment(params));
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!electionId) return fail('This link is missing the election. Use the link from your email or ballot.');
  try {
    info = await api.get<Info>(`/api/public/e/${encodeURIComponent(electionId)}`);
  } catch (e) {
    return fail((e as Error).message);
  }
  document.title = `Vote: ${info.title}`;
  $('#title').textContent = info.title;
  $('#org').textContent = info.organisation;
  if (!info.channels.online) return fail('This election has no online voting. Vote by post or in person.');
  if (info.status !== 'open') return fail(info.status === 'setup' ? 'Voting has not opened yet.' : 'Voting has closed.');
  if (!info.countKey) return fail('The tellers have not set up the count key, so online votes cannot be locked yet.');
  if (!token) return askForLink();
  checkFingerprint();
}

function askForLink() {
  const email = h('input', { type: 'email', id: 'email', autocomplete: 'email', required: true });
  const form = h(
    'form',
    {
      onsubmit: async (e: Event) => {
        e.preventDefault();
        try {
          const r = await api.post<{ message: string }>(`/api/public/e/${info.id}/online/request-link`, { email: email.value });
          show(app, h('h2', {}, 'Check your email'), status('ok', r.message), h('p', {}, 'Open the link on this device or another, then come back with your ballot.'));
        } catch (err) {
          app.append(status('bad', (err as Error).message));
        }
      },
    },
    h('h2', {}, 'Ask for your voting link'),
    h('p', {}, 'To vote online you need two things: a link sent to the email address the organisation has for you, and the code printed on your ballot.'),
    h('label', { for: 'email' }, 'Your email address'),
    email,
    h('button', { type: 'submit' }, 'Send my link'),
  );
  show(app, form);
}

/** The count key check. On the project's own copy the voter must type the fingerprint from their ballot. */
function checkFingerprint() {
  const fp = info.countKey!.fingerprint;
  const projectCopy = api.base !== location.origin;
  const input = h('input', { type: 'text', id: 'fp', class: 'code', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'fp-help' });
  const msg = h('div', {});
  const next = () => askCode();
  const body = projectCopy
    ? [
        h('p', {}, 'Type the count key fingerprint printed on your ballot (4 groups of 4). This page will only lock your vote with that key.'),
        h('label', { for: 'fp' }, 'Fingerprint from your ballot'),
        input,
        h('p', { id: 'fp-help', class: 'small' }, 'Spaces and capitals don’t matter.'),
        h(
          'button',
          {
            onclick: () => {
              const norm = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, '');
              if (norm(input.value) === norm(fp)) next();
              else msg.replaceChildren(status('bad', 'That doesn’t match the key the server gave. Don’t vote here: tell the tellers.'));
            },
          },
          'Check',
        ),
        msg,
      ]
    : [
        h('p', {}, 'Your vote will be locked with the tellers’ count key. Its fingerprint is:'),
        h('p', { class: 'fingerprint' }, fp),
        h('p', {}, 'Is that the same as the fingerprint printed on your ballot?'),
        h('button', { onclick: next }, 'Yes, it matches'),
        h('button', { class: 'secondary', onclick: () => show(app, status('bad', 'Don’t vote online. Tell the tellers that the count key fingerprint doesn’t match, and vote by post or in person.')) }, 'No'),
      ];
  show(app, h('h2', {}, 'Step 1 of 3: check the lock'), ...body);
}

function askCode() {
  const input = h('input', { type: 'text', id: 'code', class: 'code', autocomplete: 'off', spellcheck: 'false', inputmode: 'text', 'aria-describedby': 'code-help' });
  const msg = h('div', {});
  const go = async (e: Event) => {
    e.preventDefault();
    const p = parseTypedCode(input.value);
    if (!p.ok) {
      const why = { length: 'A code has 17 characters, in groups of 4 and one at the end.', character: 'That code has a character that can’t be in a code.', check: 'That code has a typing mistake: check each character.' }[p.reason];
      return msg.replaceChildren(status('bad', why));
    }
    const hash = codeHash(info.id, p.code);
    try {
      const r = await api.post<{ style: BallotStyle }>(`/api/public/e/${info.id}/online/check`, { token, codeHash: hash });
      ballot(hash, r.style);
    } catch (err) {
      msg.replaceChildren(status('bad', (err as Error).message));
    }
  };
  show(
    app,
    h(
      'form',
      { onsubmit: go },
      h('h2', {}, 'Step 2 of 3: your code'),
      h('label', { for: 'code' }, 'The code printed on your ballot'),
      input,
      h('p', { id: 'code-help', class: 'small' }, 'For example 7KQ2-M9XD-4TPH-B3RW-C. Dashes and capitals don’t matter.'),
      h('button', { type: 'submit' }, 'Next'),
      msg,
    ),
  );
}

type Getter = () => { ok: true; selection: string[] } | { ok: false; message: string };

function contestFields(c: Contest): { node: HTMLElement; get: Getter } {
  const name = `c-${c.id}`;
  const legend = h('legend', {}, c.title);
  if (c.method === 'yes_no') {
    const opts = ['yes', 'no', ...(c.allow_abstain ? ['abstain'] : [])];
    const inputs = opts.map((o) => h('input', { type: 'radio', name, value: o }));
    const node = h('fieldset', {}, legend, ...opts.map((o, i) => h('label', { class: 'choice' }, inputs[i]!, o[0]!.toUpperCase() + o.slice(1))));
    return { node, get: () => ({ ok: true, selection: inputs.filter((x) => x.checked).map((x) => x.value) }) };
  }
  const cands = c.candidates;
  if (c.method === 'irv' || c.method === 'stv') {
    const n = cands.length;
    const selects = cands.map((cd) => {
      const s = h('select', { id: `${name}-${cd.id}` }, h('option', { value: '' }, '—'), ...Array.from({ length: n }, (_, i) => h('option', { value: String(i + 1) }, String(i + 1))));
      return s;
    });
    const node = h(
      'fieldset',
      {},
      legend,
      h('p', { class: 'small' }, `Give 1 to your first choice, 2 to your next, and so on. Rank as many as you like.${c.method === 'stv' ? ` ${c.seats} seats.` : ''}`),
      ...cands.map((cd, i) => h('div', { class: 'rank-row' }, h('label', { for: `${name}-${cd.id}`, style: 'margin:0;font-weight:400' }, cd.name), selects[i]!)),
    );
    return {
      node,
      get: () => {
        const ranks = selects.map((s, i) => ({ id: cands[i]!.id, r: Number(s.value) })).filter((x) => x.r > 0);
        const used = new Set<number>();
        for (const x of ranks) {
          if (used.has(x.r)) return { ok: false, message: `${c.title}: two names have rank ${x.r}. Give each name a different number.` };
          used.add(x.r);
        }
        return { ok: true, selection: ranks.sort((a, b) => a.r - b.r).map((x) => x.id) };
      },
    };
  }
  const max = c.method === 'plurality' ? c.seats : (c.max_approvals ?? cands.length);
  const single = max === 1;
  const inputs = cands.map((cd) => h('input', { type: single ? 'radio' : 'checkbox', name, value: cd.id }));
  const writeIn = c.write_ins ? h('input', { type: 'text', id: `${name}-wi`, maxlength: '80', autocomplete: 'off' }) : null;
  const node = h(
    'fieldset',
    {},
    legend,
    h('p', { class: 'small' }, max === 1 ? 'Choose one.' : c.method === 'approval' && !c.max_approvals ? 'Choose as many as you approve of.' : `Choose up to ${max}.`),
    ...cands.map((cd, i) => h('label', { class: 'choice' }, inputs[i]!, cd.name)),
    writeIn && h('label', { for: `${name}-wi` }, 'Write-in (optional)'),
    writeIn,
  );
  return {
    node,
    get: () => {
      const sel = inputs.filter((x) => x.checked).map((x) => x.value);
      const wi = writeIn?.value.trim();
      if (wi) sel.push(`write-in:${wi}`);
      if (sel.length > max) return { ok: false, message: `${c.title}: choose at most ${max}.` };
      return { ok: true, selection: sel };
    },
  };
}

function ballot(hash: string, style: BallotStyle) {
  const contests = style.contests.map((id) => info.rules.contests.find((c) => c.id === id)!);
  const fields = contests.map(contestFields);
  const msg = h('div', {});
  const review = (e: Event) => {
    e.preventDefault();
    const selections: Record<string, string[]> = {};
    for (const [i, f] of fields.entries()) {
      const r = f.get();
      if (!r.ok) return msg.replaceChildren(status('bad', r.message));
      selections[contests[i]!.id] = r.selection;
    }
    confirm(hash, style, contests, selections);
  };
  show(app, h('form', { onsubmit: review }, h('h2', {}, 'Step 3 of 3: your choices'), ...fields.map((f) => f.node), msg, h('button', { type: 'submit' }, 'Review my choices')));
}

function confirm(hash: string, style: BallotStyle, contests: Contest[], selections: Record<string, string[]>) {
  const nameOf = (c: Contest, id: string) => (c.method === 'yes_no' ? id[0]!.toUpperCase() + id.slice(1) : id.startsWith('write-in:') ? `${id.slice(9)} (write-in)` : c.candidates.find((x) => x.id === id)?.name ?? id);
  const rows = contests.map((c) => {
    const s = selections[c.id]!;
    const text = s.length === 0 ? 'Left blank' : c.method === 'irv' || c.method === 'stv' ? s.map((x, i) => `${i + 1}. ${nameOf(c, x)}`).join(', ') : s.map((x) => nameOf(c, x)).join(', ');
    return h('tr', {}, h('th', { scope: 'row' }, c.title), h('td', {}, text));
  });
  const msg = h('div', {});
  const send = h('button', {}, 'Lock and send my vote');
  send.addEventListener('click', async () => {
    send.disabled = true;
    try {
      msg.replaceChildren(status('info', 'Locking your vote in this browser…'));
      const sealed = await sealVote({ v: 1, styleId: style.id, selections }, fromBase64(info.countKey!.publicKey));
      let body = sealedBody(sealed);
      if (info.timeLock) {
        const { closeRound, tlockEncrypt } = await import('../shared/tlock.ts');
        body = TLOCK_PREFIX + (await tlockEncrypt(closeRound(info.dates.voting_closes), sealed));
      }
      const r = await api.post<{ message: string }>(`/api/public/e/${info.id}/online/vote`, { token, codeHash: hash, styleId: style.id, sealed: body });
      history.replaceState(null, '', fragmentWithout('t')); // drop the used token from the address bar
      show(
        app,
        h('h2', {}, 'Your vote is in'),
        status('ok', r.message),
        h('p', {}, 'You can check it arrived on the public page: it will say "cast online". Your choices can’t be seen there, or changed.'),
      );
    } catch (e) {
      send.disabled = false;
      msg.replaceChildren(status('bad', (e as Error).message));
    }
  });
  show(
    app,
    h('h2', {}, 'Check your choices'),
    h('table', {}, h('tbody', {}, ...rows)),
    status('warn', 'Once you send it, your vote can’t be changed, and your code can’t be used again.'),
    send,
    h('button', { class: 'secondary', onclick: () => ballot(hash, style) }, 'Go back and change'),
    msg,
  );
}

restartOnNewFragment();
start();
