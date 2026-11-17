// The tellers' and issuers' app. It always runs from the organisation's own server, because passkeys belong to that
// address. Keys the tellers hold (the count key) never leave this device until certification publishes it.
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { Rules } from '@coded-ballot/core';
import { Api } from '../shared/api.ts';
import { $, fragmentParams, fragmentWithout, h, show, status } from '../shared/ui.ts';
import { setupView } from './setup.ts';
import { openView } from './receipts.ts';
import { countView } from './count.ts';

export interface Staff {
  id: string;
  name: string;
  email: string;
  roles: string[];
}

export interface ElectionInfo {
  id: string;
  title: string;
  organisation: string;
  status: 'setup' | 'open' | 'closed' | 'certified' | 'purged';
  dates: Rules['dates'];
  channels: Rules['channels'];
  timeLock: boolean;
  rulesSha256: string;
  rules: Rules;
  countKey: { publicKey: string; fingerprint: string } | null;
  issuerKey: { publicKey: string; fingerprint: string } | null;
  closeFallback: boolean;
}

export interface Ctx {
  api: Api;
  staff: Staff;
  app: HTMLElement;
  /** Show an election again, fetched fresh. */
  reload: () => void;
  home: () => void;
}

const app = $('#app');
const api = new Api(location.origin);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});

async function start() {
  const invite = fragmentParams().get('invite');
  if (invite) return enrol(invite);
  let me: { staff: Staff | null };
  try {
    me = await api.get('/api/auth/me');
  } catch (e) {
    return show(app, status('bad', (e as Error).message));
  }
  if (!me.staff) return signIn();
  home(me.staff);
}

function signIn() {
  const msg = h('div', {});
  show(
    app,
    h('h2', {}, 'Sign in'),
    h('p', {}, 'Use the passkey you made when you were invited: your fingerprint, face or screen lock.'),
    h(
      'button',
      {
        onclick: async () => {
          msg.replaceChildren(status('info', 'Waiting for your passkey…'));
          try {
            const o = await api.post<{ challengeId: string; options: never }>('/api/auth/login/options', {});
            const response = await startAuthentication({ optionsJSON: o.options });
            const r = await api.post<{ staff: Staff }>('/api/auth/login/verify', { challengeId: o.challengeId, response });
            home(r.staff);
          } catch (e) {
            msg.replaceChildren(status('bad', (e as Error).message));
          }
        },
      },
      'Sign in with my passkey',
    ),
    msg,
    setUpServer(),
  );
}

/** The very first person on a new server: the setup token from the server's settings makes them issuer and teller. */
function setUpServer(): HTMLElement {
  const token = h('input', { id: 'su-token', type: 'password', autocomplete: 'off' });
  const name = h('input', { id: 'su-name', type: 'text', autocomplete: 'name' });
  const email = h('input', { id: 'su-email', type: 'email', autocomplete: 'email' });
  const msg = h('div', {});
  return h(
    'details',
    {},
    h('summary', {}, 'First time on this server? Set it up'),
    h(
      'form',
      {
        onsubmit: async (e: Event) => {
          e.preventDefault();
          try {
            const r = await api.post<{ invite: string }>('/api/auth/bootstrap', { setupToken: token.value, name: name.value, email: email.value });
            enrol(r.invite);
          } catch (err) {
            msg.replaceChildren(status('bad', (err as Error).message));
          }
        },
      },
      h('p', { class: 'small' }, 'Only the first person needs this: the setup token is in the server’s settings. You become the issuer and a teller, then invite everyone else.'),
      h('label', { for: 'su-token' }, 'Setup token'),
      token,
      h('label', { for: 'su-name' }, 'Your name'),
      name,
      h('label', { for: 'su-email' }, 'Your email address'),
      email,
      h('button', { type: 'submit' }, 'Set up and make my passkey'),
      msg,
    ),
  );
}

function enrol(invite: string) {
  const msg = h('div', {});
  show(
    app,
    h('h2', {}, 'Make your passkey'),
    h('p', {}, 'You have been invited to help run elections here. A passkey lets you sign in with your fingerprint, face or screen lock, with no password. Make it on the phone or computer you will use.'),
    h(
      'button',
      {
        onclick: async () => {
          msg.replaceChildren(status('info', 'Follow your device’s prompts…'));
          try {
            const o = await api.post<{ challengeId: string; options: never }>('/api/auth/register/options', { invite });
            const response = await startRegistration({ optionsJSON: o.options });
            await api.post('/api/auth/register/verify', { invite, challengeId: o.challengeId, response });
            history.replaceState(null, '', fragmentWithout('invite'));
            const me = await api.get<{ staff: Staff }>('/api/auth/me');
            home(me.staff);
          } catch (e) {
            msg.replaceChildren(status('bad', (e as Error).message));
          }
        },
      },
      'Make my passkey',
    ),
    msg,
  );
}

const STATUS_LABEL: Record<ElectionInfo['status'], string> = {
  setup: 'Setting up',
  open: 'Voting open',
  closed: 'Closed: counting',
  certified: 'Certified',
  purged: 'Purged',
};

async function home(staff: Staff) {
  const ctx: Ctx = { api, staff, app, reload: () => {}, home: () => home(staff) };
  let list: { elections: { id: string; status: ElectionInfo['status']; created_at: string }[] };
  try {
    list = await api.get('/api/staff/elections');
  } catch (e) {
    return show(app, status('bad', (e as Error).message));
  }
  show(
    app,
    signedInBar(ctx),
    h('h2', {}, 'Elections'),
    list.elections.length
      ? h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Election'), h('th', {}, 'Stage'))),
          h(
            'tbody',
            {},
            ...list.elections.map((e) =>
              h('tr', {}, h('td', {}, h('a', { href: `#e=${encodeURIComponent(e.id)}`, onclick: (ev: Event) => (ev.preventDefault(), election(ctx, e.id)) }, e.id)), h('td', {}, STATUS_LABEL[e.status])),
            ),
          ),
        )
      : h('p', {}, staff.roles.includes('issuer') ? 'No elections yet. Create one with the issuer tool: coded-ballot check-rules, then upload.' : 'No elections yet.'),
    staff.roles.includes('issuer') ? toolToken() : null,
    inviteForm(ctx),
  );
  const id = fragmentParams().get('e');
  if (id) election(ctx, id);
}

function signedInBar(ctx: Ctx) {
  return h(
    'p',
    { class: 'small' },
    `Signed in as ${ctx.staff.name} (${ctx.staff.roles.join(' and ')}). `,
    h(
      'button',
      {
        class: 'secondary',
        onclick: async () => {
          await api.post('/api/auth/logout', {});
          location.hash = '';
          signIn();
        },
      },
      'Sign out',
    ),
  );
}

/** A 12-hour token for the issuer tool on the issuer's own computer. Shown once; signing out ends it. */
function toolToken(): HTMLElement {
  const out = h('div', {});
  return h(
    'details',
    {},
    h('summary', {}, 'Make a token for the issuer tool'),
    h('p', { class: 'small' }, 'The issuer tool on your own computer uses it to upload the roll and code hashes and to sign the close. It lasts 12 hours, and signing out here ends it.'),
    h(
      'button',
      {
        class: 'secondary',
        onclick: async () => {
          try {
            const r = await api.post<{ token: string }>('/api/auth/tokens', { label: 'issuer tool' });
            const file = new Blob([`${r.token}
`], { type: 'text/plain' });
            out.replaceChildren(
              status('warn', 'Save it now: it isn’t shown again. Anyone with it can act as the issuer tool until it expires.'),
              h('p', {}, h('a', { href: URL.createObjectURL(file), download: 'coded-ballot-token.txt', class: 'button' }, 'Save coded-ballot-token.txt')),
              h('p', { class: 'small' }, 'Then run the issuer tool with --token-file coded-ballot-token.txt --server ', location.origin),
            );
          } catch (e) {
            out.replaceChildren(status('bad', (e as Error).message));
          }
        },
      },
      'Make a token',
    ),
    out,
  );
}

function inviteForm(ctx: Ctx) {
  const name = h('input', { id: 'inv-name', type: 'text', autocomplete: 'off' });
  const email = h('input', { id: 'inv-email', type: 'email', autocomplete: 'off' });
  const boxes = ctx.staff.roles.map((r) => ({ role: r, box: h('input', { type: 'checkbox', value: r }) }));
  const msg = h('div', {});
  return h(
    'details',
    {},
    h('summary', {}, 'Invite another teller or issuer'),
    h(
      'form',
      {
        onsubmit: async (e: Event) => {
          e.preventDefault();
          try {
            const roles = boxes.filter((b) => b.box.checked).map((b) => b.role);
            if (!roles.length) throw new Error('Choose at least one role.');
            await api.post('/api/auth/invite', { name: name.value, email: email.value, roles });
            msg.replaceChildren(status('ok', `Invitation sent to ${email.value}. The link works once, for 7 days.`));
          } catch (err) {
            msg.replaceChildren(status('bad', (err as Error).message));
          }
        },
      },
      h('label', { for: 'inv-name' }, 'Their name'),
      name,
      h('label', { for: 'inv-email' }, 'Their email address'),
      email,
      h('fieldset', {}, h('legend', {}, 'Roles'), ...boxes.map((b) => h('label', { class: 'choice' }, b.box, b.role === 'issuer' ? 'Issuer (makes and mails ballots)' : 'Teller (receives and counts ballots)'))),
      h('button', { type: 'submit' }, 'Send the invitation'),
      msg,
    ),
  );
}

export async function election(ctx: Ctx, id: string) {
  history.replaceState(null, '', `${location.pathname}#e=${encodeURIComponent(id)}`);
  const c: Ctx = { ...ctx, reload: () => election(ctx, id) };
  let info: ElectionInfo;
  try {
    info = await api.get(`/api/public/e/${encodeURIComponent(id)}`);
  } catch (e) {
    return show(app, status('bad', (e as Error).message));
  }
  const back = h('p', {}, h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), history.replaceState(null, '', location.pathname), ctx.home()) }, '← All elections'));
  const head = [signedInBar(ctx), back, h('h2', {}, info.title), h('p', { class: 'sub' }, `${info.organisation}. ${STATUS_LABEL[info.status]}.`)];
  const body =
    info.status === 'setup'
      ? setupView(c, info)
      : info.status === 'open'
        ? openView(c, info)
        : info.status === 'closed'
          ? countView(c, info)
          : h('div', {}, status('ok', 'This election is certified. The results, the teller report and the count key are on the public page.'), h('p', {}, h('a', { href: `../public/#e=${encodeURIComponent(info.id)}` }, 'Open the public page')));
  show(app, ...head, body);
}

start();
