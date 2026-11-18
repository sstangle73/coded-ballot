// The issuer page. It runs from the project's own site, never from an organisation's server: the passphrase, the
// codes, and members' names and addresses stay in this browser. The server gets what the command-line issuer tool
// sends it: the frozen roll's member IDs and emails, the SHA-256 of each code with its ballot style, the public half
// of the signing key, and the signed close.
//
// The tellers' app opens it as #s=<server>&e=<election>&c=<code>. The # part never reaches the project's site. The
// code works once, for two minutes: the page trades it for a 12-hour token that works only for the issuer's routes
// and lives in this tab's memory, never in an address that browser history would keep. Signing out here ends it.
// Because anyone can send a link naming any server, the issuer confirms the server before typing the passphrase.
import { PDFDocument } from 'pdf-lib';
import {
  closeStatement,
  codeHash,
  deriveCode,
  deriveIssuerKeys,
  fingerprint,
  fromBase64,
  generatePassphrase,
  isValidPassphrase,
  signClose,
  toBase64,
  type FrozenRoll,
  type IssuerKeys,
  type Member,
} from '@coded-ballot/core';
import { freezeRollCsv, makePacket, reissue, styleOf, type IssuedState, type PacketInfo } from '@coded-ballot/issuer';
import { Api, serverFromFragment } from '../shared/api.ts';
import { $, fragmentParams, h, show, status } from '../shared/ui.ts';
import type { ElectionInfo, Staff } from '../teller/teller.ts';

interface State {
  api: Api;
  server: string;
  host: string;
  info: ElectionInfo;
  me: Staff;
  keys: IssuerKeys | null;
  /** The passphrase was made on this page and its second copy checked. */
  madeHere: boolean;
  frozen: FrozenRoll | null;
  rollFileName: string;
  /** Every code hash the server holds for this election, and the roll it froze. */
  hashes: Set<string>;
  rollSha256: string | null;
  fingerprintChecked: boolean;
  returnAddress: string;
  keyDestroyed: boolean;
  /** The issuer has said this is their organisation's server. */
  serverConfirmed: boolean;
  /** What the last action in each section left to show: a result, a download link. */
  notes: Record<string, Node[]>;
  urls: string[];
}

const app = $('#app');
const STEPS = ['roll', 'passphrase', 'countKey', 'ballots', 'member', 'close', 'destroyed'] as const;
type Step = (typeof STEPS)[number];

async function start() {
  const p = fragmentParams();
  const code = p.get('c');
  const id = p.get('e');
  // a reload or a copied address carries nothing: the code is spent, and the token is in memory only
  history.replaceState(null, '', location.pathname);
  if (!code || !id || !p.get('s')) return show(app, ...notOpenedRight());
  let server: string;
  try {
    server = serverFromFragment(p);
  } catch (e) {
    return show(app, status('bad', (e as Error).message));
  }
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (server === location.origin && !local) {
    return show(
      app,
      status('bad', 'This copy of the issuer page comes from your organisation’s own server, so it won’t run. The passphrase must never be typed into a page that server could change.'),
      h('p', {}, 'Use the Issue ballots button in the tellers’ app: it opens the project’s own copy.'),
    );
  }
  try {
    const { token } = await new Api(server).post<{ token: string }>('/api/auth/handoff/redeem', { code });
    const api = new Api(server, token);
    const [me, info, codes, log] = await Promise.all([
      api.get<{ staff: Staff | null }>('/api/auth/me'),
      api.get<ElectionInfo>(`/api/public/e/${encodeURIComponent(id)}`),
      api.get<{ hashes: string[]; rollSha256: string | null }>(`/api/staff/e/${encodeURIComponent(id)}/codes/hashes`),
      api.get<{ log: { kind: string }[] }>(`/api/public/e/${encodeURIComponent(id)}/log`),
    ]);
    if (!me.staff?.roles.includes('issuer')) throw new Error('This sign-in isn’t an issuer’s.');
    const s: State = {
      api,
      server,
      host: new URL(server).host,
      info,
      me: me.staff,
      keys: null,
      madeHere: false,
      frozen: null,
      rollFileName: '',
      hashes: new Set(codes.hashes),
      rollSha256: codes.rollSha256,
      fingerprintChecked: false,
      returnAddress: '',
      keyDestroyed: log.log.some((l) => l.kind === 'issuer_key_destroyed'),
      serverConfirmed: false,
      notes: {},
      urls: [],
    };
    render(s);
  } catch (e) {
    const m = (e as Error).message;
    show(app, status('bad', m), ...(/sign-in has ended|expired or was already used|401|410/.test(m) ? notOpenedRight() : []));
  }
}

function notOpenedRight(): Node[] {
  return [
    h('h2', {}, 'Open this page from the tellers’ app'),
    h(
      'ol',
      {},
      h('li', {}, 'Go to your organisation’s ballot server and sign in to the tellers’ app with your passkey.'),
      h('li', {}, 'Open the election and choose Issue ballots.'),
    ),
    h('p', { class: 'small' }, 'That opens this page already signed in, for 12 hours. Reloading this page or leaving it forgets that, so open it from the tellers’ app each time.'),
  ];
}

/** Before anything else: is this the issuer's own server? A link can name any server, and a fake one could ask for a signed close. */
function confirmServer(s: State) {
  show(
    app,
    h('h2', {}, 'Is this your organisation’s ballot server?'),
    h('p', { class: 'fingerprint', style: 'word-break: break-all' }, s.host),
    h('p', {}, `It says it is running “${s.info.title}” for ${s.info.organisation}, and that you are ${s.me.name}.`),
    h('p', {}, 'Carry on only if that is the address of the tellers’ app you just signed in to, the one your organisation always uses.'),
    h(
      'p',
      {},
      h('button', { onclick: () => ((s.serverConfirmed = true), render(s)) }, 'Yes, that’s our server'),
      ' ',
      h(
        'button',
        {
          class: 'secondary',
          onclick: () =>
            show(app, status('bad', 'Don’t use this page. Close it, and don’t type your passphrase into it. Open the tellers’ app yourself, from the address your organisation always uses, and choose Issue ballots there. If someone sent you this link, tell the tellers.')),
        },
        'No',
      ),
    ),
  );
}

// ---------- the page ----------

function render(s: State) {
  if (!s.serverConfirmed) return confirmServer(s);
  const { info } = s;
  const shown: Step[] =
    info.status === 'setup'
      ? ['roll', 'passphrase', 'countKey', 'ballots', 'member']
      : info.status === 'open'
        ? ['roll', 'passphrase', 'member', 'close']
        : info.status === 'closed'
          ? ['destroyed']
          : [];
  const sections: Record<Step, () => HTMLElement | null> = {
    roll: () => rollSection(s),
    passphrase: () => passphraseSection(s),
    countKey: () => countKeySection(s),
    ballots: () => ballotsSection(s),
    member: () => memberSection(s),
    close: () => closeSection(s),
    destroyed: () => destroyedSection(s),
  };
  let n = 0;
  const parts = shown.flatMap((k) => {
    const el = sections[k]();
    if (!el) return [];
    el.querySelector('h2')?.prepend(`${++n}. `);
    return [el];
  });
  app.replaceChildren(
    h('p', { class: 'sub' }, `${info.title}. ${info.organisation}.`),
    h('p', { class: 'small' }, `Signed in to ${s.host} as ${s.me.name}, the issuer. `, signOutButton(s), ' ', h('a', { href: `${s.server}/teller/#e=${encodeURIComponent(info.id)}` }, 'Back to the tellers’ app')),
    status(
      'info',
      `This page comes from the coded-ballot project’s own site (${location.host}), not from ${s.host}. Your passphrase, the codes, and members’ names and addresses stay in this browser. ${s.host} gets only member IDs and emails, and a fingerprint of each code that can’t be turned back into the code.`,
    ),
    ...(parts.length
      ? parts
      : [status('ok', info.status === 'closed' ? 'Nothing is left for the issuer to do.' : 'This election is finished. Nothing is left for the issuer to do.')]),
  );
}

function section(s: State, step: Step, title: string, ...body: (Node | string | null | false)[]) {
  return h('section', { class: 'panel', 'aria-labelledby': `h-${step}` }, h('h2', { id: `h-${step}` }, title), ...body, h('div', {}, ...(s.notes[step] ?? [])));
}

function note(s: State, step: Step, ...nodes: Node[]) {
  s.notes[step] = nodes;
  render(s);
}

/** Runs an action with its button disabled, and shows any error in that section. */
function action(s: State, step: Step, label: string, fn: (progress: (t: string) => void) => Promise<void>, cls = '') {
  const b: HTMLButtonElement = h('button', {
    class: cls,
    onclick: async () => {
      b.disabled = true;
      const p = h('p', { class: 'small', role: 'status' });
      b.after(p);
      try {
        await fn((t) => (p.textContent = t));
      } catch (e) {
        note(s, step, status('bad', (e as Error).message));
      } finally {
        b.disabled = false;
        p.remove();
      }
    },
  }, label);
  return b;
}

function download(s: State, bytes: Uint8Array, name: string, label: string): HTMLElement {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
  s.urls.push(url);
  const a = h('a', { href: url, download: name, class: 'button' }, label);
  setTimeout(() => a.click(), 0);
  return h('p', {}, a);
}

function signOutButton(s: State) {
  return h(
    'button',
    {
      class: 'secondary',
      onclick: async () => {
        await s.api.post('/api/auth/logout', {}).catch(() => {});
        for (const u of s.urls) URL.revokeObjectURL(u);
        s.keys = null;
        show(app, status('ok', 'Signed out, and the passphrase is gone from this page. You can close this tab.'));
      },
    },
    'Sign out',
  );
}

// ---------- 1. the roll ----------

function rollSection(s: State) {
  const input = h('input', { id: 'roll-file', type: 'file', accept: '.csv,text/csv' });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    const { frozen, problems } = freezeRollCsv(s.info.rules, await f.text());
    if (problems.length) {
      s.frozen = null;
      return note(
        s,
        'roll',
        status('bad', `${problems.length} row${problems.length === 1 ? '' : 's'} in ${f.name} need fixing. Fix them in the file, then choose it again.`),
        h('ul', {}, ...problems.slice(0, 50).map((p) => h('li', {}, p))),
      );
    }
    if (s.rollSha256 && frozen.sha256 !== s.rollSha256) {
      s.frozen = null;
      return note(s, 'roll', status('bad', `${f.name} isn’t the roll that was frozen for this election: its fingerprint is different. Choose the same file you used before, unchanged.`));
    }
    s.frozen = frozen;
    s.rollFileName = f.name;
    s.notes.roll = [];
    render(s);
  });
  return section(
    s,
    'roll',
    'The membership roll',
    s.frozen
      ? status('ok', `${s.rollFileName}: ${s.frozen.members.length} members${s.rollSha256 ? ', the same roll as before' : ''}. Roll fingerprint ${s.frozen.sha256.slice(0, 16)}…`)
      : h(
          'p',
          {},
          s.rollSha256
            ? 'Choose the roll file you froze for this election. It stays on this computer; it’s needed for members’ names and addresses.'
            : 'Choose the membership roll, as a CSV file with member_id and class columns (and name, email and address columns). It stays on this computer: the server gets only member IDs and emails.',
        ),
    h('label', { for: 'roll-file' }, s.frozen ? 'Choose a different file' : 'Roll file'),
    input,
  );
}

// ---------- 2. the passphrase ----------

function passphraseSection(s: State) {
  if (s.keys) {
    return section(
      s,
      'passphrase',
      'Your passphrase',
      status('ok', `Passphrase entered. Signing key fingerprint ${fingerprint(s.keys.signPublicKey)}.`),
      h('p', { class: 'small' }, 'It is held in this tab only, and gone when you sign out or close the tab.'),
    );
  }
  const body = h('div', {});
  const enter = () => body.replaceChildren(...typePassphrase(s));
  if (s.info.issuerKey) enter();
  else
    body.replaceChildren(
      h('p', {}, 'The passphrase is 12 words that make every code and sign the close. Only you hold it: nobody, not the server and not this page, keeps a copy.'),
      h('p', {}, h('button', { onclick: () => body.replaceChildren(...makePassphrase(s)) }, 'Make my passphrase'), ' ', h('button', { class: 'secondary', onclick: enter }, 'I already have one')),
    );
  return section(s, 'passphrase', 'Your passphrase', body);
}

function makePassphrase(s: State): Node[] {
  const p = generatePassphrase();
  const words = p.split(' ');
  const box = h('div', {});
  const list = h('ol', { class: 'fingerprint', style: 'columns: 3; font-size: 1.15rem' }, ...words.map((w) => h('li', {}, w)));
  const check = () => {
    const inputs = [2, 8, 11].map((i) => ({ i, el: h('input', { id: `w${i}`, type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' }) }));
    const msg = h('div', {});
    box.replaceChildren(
      h('p', {}, 'Now check your second copy. Look only at the second copy, not this screen (the words are hidden).'),
      ...inputs.flatMap(({ i, el }) => [h('label', { for: `w${i}` }, `Word ${i + 1} from your second copy`), el]),
      h(
        'p',
        {},
        h(
          'button',
          {
            onclick: async () => {
              if (inputs.some(({ i, el }) => el.value.trim().toLowerCase() !== words[i])) {
                return msg.replaceChildren(status('bad', 'A word doesn’t match. Cross out both copies and start again with a new passphrase.'), h('p', {}, h('button', { onclick: () => box.replaceWith(...makePassphrase(s)) }, 'Start again')));
              }
              msg.replaceChildren(status('info', 'Working: this takes a few seconds on purpose.'));
              s.keys = await deriveIssuerKeys(p, s.info.id);
              s.madeHere = true;
              render(s);
            },
          },
          'Check',
        ),
      ),
      msg,
    );
  };
  box.replaceChildren(
    status('warn', 'Write these 12 words down twice, on paper, in order, and keep the two copies in different safe places. Don’t photograph them or save them on a computer. Without them there are no replacement ballots and no signed close.'),
    list,
    h('p', {}, h('button', { onclick: check }, 'Both copies are written down')),
  );
  return [box];
}

function typePassphrase(s: State): Node[] {
  const input = h('input', { id: 'pass', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', class: 'code' });
  const msg = h('div', {});
  return [
    h('label', { for: 'pass' }, 'Type your 12-word passphrase, with a space between words'),
    input,
    h(
      'p',
      {},
      h(
        'button',
        {
          onclick: async () => {
            const p = input.value.trim().toLowerCase().split(/\s+/).join(' ');
            if (!isValidPassphrase(p)) return msg.replaceChildren(status('bad', 'That passphrase isn’t right: a word is misspelt, missing or out of order.'));
            msg.replaceChildren(status('info', 'Working: this takes a few seconds on purpose.'));
            const keys = await deriveIssuerKeys(p, s.info.id);
            if (s.info.issuerKey && toBase64(keys.signPublicKey) !== s.info.issuerKey.publicKey) {
              return msg.replaceChildren(status('bad', 'That’s a valid passphrase, but not the one this election’s ballots were made with.'));
            }
            input.value = '';
            s.keys = keys;
            render(s);
          },
        },
        'Use this passphrase',
      ),
    ),
    msg,
  ];
}

// ---------- 3. the count key ----------

function countKeyFingerprint(s: State): string | null {
  const ck = s.info.countKey;
  if (!s.info.channels.online || !ck) return null;
  // worked out from the key itself: the server alone can't be trusted to say what it is
  return fingerprint(fromBase64(ck.publicKey));
}

function countKeySection(s: State) {
  if (!s.info.channels.online) return null;
  const ck = s.info.countKey;
  if (!ck) return section(s, 'countKey', 'The count key', status('warn', 'A teller must make the count key in the tellers’ app before you print ballots: its fingerprint goes on every ballot. Come back once they have.'));
  const fp = countKeyFingerprint(s)!;
  if (fp !== ck.fingerprint) return section(s, 'countKey', 'The count key', status('bad', 'The server’s count key and its fingerprint don’t agree. Don’t print anything: tell the tellers.'));
  if (s.fingerprintChecked) return section(s, 'countKey', 'The count key', status('ok', `Fingerprint ${fp}, checked with the teller who made it.`));
  return section(
    s,
    'countKey',
    'The count key',
    h('p', {}, 'Online votes are locked to the count key. Its fingerprint goes on every ballot so members can check they’re voting to the right key.'),
    h('p', { class: 'fingerprint' }, fp),
    h('p', {}, 'Ask the teller who made the count key to read you its fingerprint from their own copy, not from this server. Does it match?'),
    h(
      'p',
      {},
      h('button', { onclick: () => ((s.fingerprintChecked = true), render(s)) }, 'Yes, it matches'),
      ' ',
      h('button', { class: 'secondary', onclick: () => note(s, 'countKey', status('bad', 'Don’t print ballots. Tell the tellers: the server may be showing a different key from the one they made.')) }, 'No'),
    ),
  );
}

// ---------- 4. ballots ----------

/** Each member's current copy, found by deriving their codes and looking for the hashes on the server. */
function issuedState(s: State): IssuedState {
  const members: IssuedState['members'] = {};
  for (const m of s.frozen!.members) {
    let copy = 0;
    while (s.hashes.has(codeHash(s.info.id, deriveCode(s.keys!, m.memberId, copy + 1)))) copy++;
    if (copy) members[m.memberId] = { copy, styleId: styleOf(s.info.rules, m).id };
  }
  return { electionId: s.info.id, members };
}

function packetInfo(s: State): PacketInfo {
  return {
    votingPage: `${s.server}/vote/`,
    tracker: `${s.server}/public/#e=${s.info.id}`,
    countKeyFingerprint: countKeyFingerprint(s),
    returnAddress: s.returnAddress.split('\n').map((l) => l.trim()).filter(Boolean),
  };
}

async function packets(s: State, list: { m: Member; copy: number }[], progress: (t: string) => void) {
  const combined = await PDFDocument.create();
  const codes: { hash: string; styleId: string }[] = [];
  const info = packetInfo(s);
  for (const [n, { m, copy }] of list.entries()) {
    progress(`Making ballot ${n + 1} of ${list.length}…`);
    const r = await makePacket(s.info.rules, s.keys!, m, copy, info, s.frozen!.members.indexOf(m) + 1);
    codes.push({ hash: r.hash, styleId: r.styleId });
    const src = await PDFDocument.load(r.packet.pdf);
    for (const p of await combined.copyPages(src, src.getPageIndices())) combined.addPage(p);
  }
  progress('Putting the file together…');
  // sorted by hash, so the upload order says nothing about the roll
  codes.sort((a, b) => (a.hash < b.hash ? -1 : 1));
  return { pdf: await combined.save(), codes };
}

function ballotsSection(s: State) {
  const missing: string[] = [];
  if (!s.frozen) missing.push('choose the roll');
  if (!s.keys) missing.push('enter the passphrase');
  if (s.info.channels.online && !(s.info.countKey && s.fingerprintChecked)) missing.push('check the count key');
  if (missing.length) return section(s, 'ballots', 'Ballots', h('p', {}, `First ${missing.join(', then ')}.`));
  const state = issuedState(s);
  const all = s.frozen!.members;
  const todo = all.filter((m) => !state.members[m.memberId]);
  const done = all.filter((m) => state.members[m.memberId]);
  const date = new Date().toISOString().slice(0, 10);
  const backup = h('input', { type: 'checkbox', id: 'backup' });
  const firstUpload = !s.info.issuerKey;
  const ret = h('textarea', { id: 'ret', rows: '3', autocomplete: 'off' });
  ret.value = s.returnAddress;
  ret.addEventListener('input', () => (s.returnAddress = ret.value));
  return section(
    s,
    'ballots',
    'Ballots',
    h('p', {}, `${done.length} of ${all.length} members have a ballot.`),
    h('label', { for: 'ret' }, 'Your organisation’s return address, for the cover letter (optional, one line each)'),
    ret,
    todo.length
      ? h(
          'div',
          {},
          firstUpload && !s.madeHere ? h('label', { class: 'choice' }, backup, 'A second copy of the passphrase is written down and checked') : null,
          h(
            'p',
            {},
            action(s, 'ballots', `Make ${todo.length} ballot${todo.length === 1 ? '' : 's'}`, async (progress) => {
              if (firstUpload && !s.madeHere && !backup.checked) throw new Error('Write down and check a second copy of the passphrase first, then tick the box.');
              const out = await packets(s, todo.map((m) => ({ m, copy: 1 })), progress);
              progress('Sending the code fingerprints to the server…');
              const id = encodeURIComponent(s.info.id);
              if (!s.rollSha256) {
                await s.api.post(`/api/staff/e/${id}/roll`, {
                  members: s.frozen!.members.map((m) => ({ memberId: m.memberId, email: m.email })),
                  rollSha256: s.frozen!.sha256,
                  frozenAt: s.frozen!.frozenAt,
                });
                s.rollSha256 = s.frozen!.sha256;
              }
              await s.api.post(`/api/staff/e/${id}/codes`, { issuerPublicKey: toBase64(s.keys!.signPublicKey), codes: out.codes });
              if (firstUpload) await s.api.post(`/api/staff/e/${id}/passphrase-backup`);
              for (const c of out.codes) s.hashes.add(c.hash);
              s.info.issuerKey = { publicKey: toBase64(s.keys!.signPublicKey), fingerprint: fingerprint(s.keys!.signPublicKey) };
              note(
                s,
                'ballots',
                status('ok', `${todo.length} ballots made, and the server has their fingerprints. Print the file: each member’s packet is a cover letter with their address, then their ballot sheets, in roll order.`),
                download(s, out.pdf, `ballots-${s.info.id}-${date}.pdf`, 'Save the ballots (PDF)'),
              );
            }),
          ),
        )
      : status('ok', 'Every member on the roll has a ballot.'),
    done.length
      ? h(
          'p',
          {},
          action(
            s,
            'ballots',
            'Make the file again',
            async (progress) => {
              const out = await packets(s, done.map((m) => ({ m, copy: state.members[m.memberId]!.copy })), progress);
              note(s, 'ballots', status('info', `The same ${done.length} ballots again (each member’s current copy). Nothing changed on the server.`), download(s, out.pdf, `ballots-${s.info.id}-${date}.pdf`, 'Save the ballots (PDF)'));
            },
            'secondary',
          ),
        )
      : null,
    h(
      'details',
      {},
      h('summary', {}, 'Sending ballots by post or email'),
      h('p', { class: 'small' }, 'Print the file and post the packets in window envelopes, or have a mail house print them. For a single member, the next step saves just their ballot, to print or email. Sending everyone’s by email, or through Lob, still needs the issuer tool on your own computer (see the project’s README). A ballot sent by email puts the code and the voting link in the same inbox.'),
    ),
  );
}

// ---------- 5. one member ----------

function memberSection(s: State) {
  if (!s.frozen || !s.keys) return section(s, 'member', 'One member’s ballot', h('p', {}, 'First choose the roll and enter the passphrase. Then you can replace a lost or spoilt ballot, or save one member’s ballot to print or email.'));
  const list = h('datalist', { id: 'members' }, ...s.frozen.members.map((m) => h('option', { value: m.memberId }, m.name || m.memberId)));
  const input = h('input', { id: 'member', type: 'text', list: 'members', autocomplete: 'off', spellcheck: 'false' });
  const out = h('div', {});
  const find = () => {
    const q = input.value.trim().toLowerCase();
    const m = s.frozen!.members.find((x) => x.memberId.toLowerCase() === q) ?? s.frozen!.members.find((x) => x.name?.toLowerCase() === q);
    if (!m) return out.replaceChildren(q ? status('warn', 'Nobody on the roll has that member ID or name.') : '');
    const cur = issuedState(s).members[m.memberId];
    const id = encodeURIComponent(s.info.id);
    const safe = m.memberId.replace(/[^\w-]/g, '_');
    out.replaceChildren(
      h('p', {}, `${m.name || m.memberId} (${m.memberId}): `, cur ? `ballot copy ${cur.copy} is the current one.` : 'no ballot yet.'),
      cur
        ? h(
            'p',
            {},
            action(s, 'member', 'Save their packet', async () => {
              const { packet } = await makePacket(s.info.rules, s.keys!, m, cur.copy, packetInfo(s), s.frozen!.members.indexOf(m) + 1);
              note(s, 'member', download(s, packet.pdf, `ballot-${safe}-copy${cur.copy}.pdf`, `Save ${m.memberId}’s packet (PDF)`));
            }, 'secondary'),
            ' ',
            action(s, 'member', 'Save just the ballot sheets, to email', async () => {
              const { packet } = await makePacket(s.info.rules, s.keys!, m, cur.copy, packetInfo(s), s.frozen!.members.indexOf(m) + 1);
              note(s, 'member', status('warn', 'Email it only to the address the organisation has for this member.'), download(s, packet.ballotOnly, `ballot-${safe}.pdf`, `Save ${m.memberId}’s ballot (PDF)`));
            }, 'secondary'),
            ' ',
            action(s, 'member', 'Replace their ballot', async () => {
              if (!confirm(`Replace ${m.memberId}’s ballot? Their current ballot stops working at once, by post, online and in person.`)) return;
              const r = await reissue({ rules: s.info.rules, frozen: s.frozen!, keys: s.keys!, info: packetInfo(s), state: issuedState(s), memberId: m.memberId });
              await s.api.post(`/api/staff/e/${id}/codes/reissue`, { revoke: r.revoke, issue: r.issue });
              s.hashes.add(r.issue.hash);
              const copy = r.state.members[m.memberId]!.copy;
              note(s, 'member', status('ok', `${m.memberId}’s old ballot is cancelled. This is copy ${copy}.`), download(s, r.packet.pdf, `ballot-${safe}-copy${copy}.pdf`, `Save ${m.memberId}’s new packet (PDF)`));
            }),
          )
        : '',
    );
  };
  input.addEventListener('change', find);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && find());
  return section(
    s,
    'member',
    'One member’s ballot',
    h('p', {}, 'Replace a lost or spoilt ballot, or save one member’s ballot to print or email.'),
    h('label', { for: 'member' }, 'Member ID or name'),
    input,
    list,
    out,
  );
}

// ---------- 6. close ----------

function closeSection(s: State) {
  const closes = new Date(s.info.dates.voting_closes);
  return section(
    s,
    'close',
    'Sign the close',
    h('p', {}, `Voting ends ${closes.toLocaleString()}. After that, sign the close: it fixes the list of online votes, so nobody can add, drop or change one afterwards.`),
    s.keys
      ? h(
          'p',
          {},
          action(s, 'close', 'Sign the close', async () => {
            const id = encodeURIComponent(s.info.id);
            const digest = await s.api.get<{ count: number; sha256: string }>(`/api/staff/e/${id}/close/prepare`);
            const st = { ...closeStatement(s.info.id, new Date(), []), lockedVotes: digest };
            await s.api.post(`/api/staff/e/${id}/close`, await signClose(s.keys!, st));
            s.info.status = 'closed';
            s.notes = {};
            note(s, 'destroyed', status('ok', `Closed, with ${digest.count} online vote${digest.count === 1 ? '' : 's'} locked in.`));
          }),
        )
      : h('p', {}, 'Enter the passphrase first.'),
  );
}

// ---------- 7. destroying the passphrase ----------

function destroyedSection(s: State) {
  if (s.keyDestroyed) return section(s, 'destroyed', 'Destroy the passphrase', status('ok', 'The public log records that every copy of the passphrase is destroyed. Nothing is left for the issuer to do.'));
  const box = h('input', { type: 'checkbox', id: 'gone' });
  return section(
    s,
    'destroyed',
    'Destroy the passphrase',
    h('p', {}, 'Voting is closed. Now destroy every copy of the passphrase, paper and digital, before the tellers open the ballot box. Then nobody can make a ballot for this election again.'),
    h('label', { class: 'choice' }, box, 'I have destroyed every copy'),
    h(
      'p',
      {},
      action(s, 'destroyed', 'Record it in the public log', async () => {
        if (!box.checked) throw new Error('Destroy every copy first, then tick the box.');
        await s.api.post(`/api/staff/e/${encodeURIComponent(s.info.id)}/key-destroyed`);
        s.keyDestroyed = true;
        s.keys = null;
        note(s, 'destroyed');
      }),
    ),
  );
}

start();
