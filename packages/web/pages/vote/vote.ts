// The online voting page. It runs from the organisation's server or from the project's own copy; the election link
// carries the server address, election ID and one-time token after the #, which browsers never send to a server.
import { codeHash, fingerprint, fromBase64, parseTypedCode, sealVote, sealedBody, TLOCK_PREFIX, type BallotStyle, type Contest } from '@coded-ballot/core';
import { Api, serverFromFragment } from '../shared/api.ts';
import { contestFields } from '../shared/ballot-form.ts';
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
/** The key votes are sealed to, decoded once. Its fingerprint is worked out here, never taken from the server. */
let countKeyPublic: Uint8Array;
let countKeyFingerprint: string;
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
  try {
    countKeyPublic = fromBase64(info.countKey.publicKey);
  } catch {
    return fail('The server sent a count key this page can’t read. Don’t vote online: tell the tellers.');
  }
  if (countKeyPublic.length !== 32) return fail('The server sent a count key of the wrong length. Don’t vote online: tell the tellers.');
  countKeyFingerprint = fingerprint(countKeyPublic);
  if (countKeyFingerprint !== info.countKey.fingerprint) return fail('The server’s count key and its fingerprint don’t agree. Don’t vote online: tell the tellers.');
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
  const fp = countKeyFingerprint; // from the key itself, so the server can't show one fingerprint and lock with another key
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

function ballot(hash: string, style: BallotStyle) {
  const contests = style.contests.map((id) => info.rules.contests.find((c) => c.id === id)!);
  const fields = contests.map((c) => contestFields(c));
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
      const sealed = await sealVote({ v: 1, styleId: style.id, selections }, countKeyPublic);
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
