// The tellers' and issuers' app. It always runs from the organisation's own server, because passkeys belong to that
// address. Keys the tellers hold (the count key) never leave this device until certification publishes it.
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { Rules } from '@coded-ballot/core';
import { Api } from '../shared/api.ts';
import { $, fragmentParams, fragmentWithout, h, restartOnNewFragment, show, status } from '../shared/ui.ts';
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

// A setup or invitation link opened in this tab changes only the fragment: start again from it.
restartOnNewFragment();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});

async function start() {
  const invite = fragmentParams().get('invite');
  if (invite) return enrol(invite);
  const setup = fragmentParams().get('setup');
  if (setup) return setUpFromLink(setup);
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

/** The first person's sign-up, with the setup token from the link or typed in; then on to their passkey. */
async function bootstrap(token: string, name: string, email: string, msg: HTMLElement) {
  msg.replaceChildren(status('info', 'Setting up…'));
  try {
    const r = await api.post<{ invite: string }>('/api/auth/bootstrap', { setupToken: token.trim(), name, email });
    history.replaceState(null, '', fragmentWithout('setup'));
    enrol(r.invite, true);
  } catch (err) {
    const m = (err as Error).message;
    msg.replaceChildren(
      status(
        'bad',
        /setup token/i.test(m)
          ? 'This setup link or token doesn’t work. It may be mistyped, or a newer one has replaced it. Ask whoever installed the server for the current setup link.'
          : /already has staff/i.test(m)
            ? 'This server is already set up. Ask someone who runs elections here to invite you: the invitation comes by email.'
            : m,
      ),
    );
  }
}

function nameAndEmail(prefix: string) {
  const name = h('input', { id: `${prefix}-name`, type: 'text', autocomplete: 'name', required: true });
  const email = h('input', { id: `${prefix}-email`, type: 'email', autocomplete: 'email', required: true });
  return {
    name,
    email,
    fields: [h('label', { for: `${prefix}-name` }, 'Your name'), name, h('label', { for: `${prefix}-email` }, 'Your email address'), email],
  };
}

/** Opened from the setup link that the server printed for whoever installed it. */
function setUpFromLink(token: string) {
  const f = nameAndEmail('sl');
  const msg = h('div', {});
  show(
    app,
    h('h2', {}, 'Set up this server'),
    h('p', {}, 'You’re the first person here, so you’ll run it: you can set up elections, invite the other tellers and helpers, and count the votes.'),
    h('p', {}, 'Enter your name and email address. Next you’ll make a passkey, so you sign in with your fingerprint, face or screen lock instead of a password. Do this on the phone or computer you’ll use for elections.'),
    h(
      'form',
      { onsubmit: (e: Event) => (e.preventDefault(), bootstrap(token, f.name.value, f.email.value, msg)) },
      ...f.fields,
      h('p', {}, h('button', { type: 'submit' }, 'Continue')),
      msg,
    ),
  );
}

/** The very first person on a new server, with a setup token but no link: it makes them issuer and teller. */
function setUpServer(): HTMLElement {
  const token = h('input', { id: 'su-token', type: 'password', autocomplete: 'off', required: true });
  const f = nameAndEmail('su');
  const msg = h('div', {});
  return h(
    'details',
    {},
    h('summary', {}, 'First time on this server? Set it up'),
    h(
      'form',
      { onsubmit: (e: Event) => (e.preventDefault(), bootstrap(token.value, f.name.value, f.email.value, msg)) },
      h('p', { class: 'small' }, 'Only the first person needs this. The easiest way is the setup link from whoever installed this server: just open it. If you have the setup token instead, paste it here. You become the issuer and a teller, then invite everyone else.'),
      h('label', { for: 'su-token' }, 'Setup token'),
      token,
      ...f.fields,
      h('p', {}, h('button', { type: 'submit' }, 'Set up and make my passkey')),
      msg,
    ),
  );
}

function enrol(invite: string, first = false) {
  const msg = h('div', {});
  show(
    app,
    h('h2', {}, 'Make your passkey'),
    h(
      'p',
      {},
      first
        ? 'Almost done. Your phone or computer will ask for your fingerprint, face or screen lock: that’s your passkey, and it’s how you’ll sign in here from now on.'
        : 'You have been invited to help run elections here. A passkey lets you sign in with your fingerprint, face or screen lock, with no password. Make it on the phone or computer you will use.',
    ),
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
      : h('p', {}, staff.roles.includes('issuer') ? 'No elections yet. Create one from its rules file below.' : 'No elections yet.'),
    staff.roles.includes('issuer') ? newElection(ctx) : null,
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

/** A new election from its rules file (YAML). */
function newElection(ctx: Ctx): HTMLElement {
  const file = h('input', { id: 'rules-file', type: 'file', accept: '.yaml,.yml,text/yaml' });
  const msg = h('div', {});
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const r = await api.post<{ id: string }>('/api/staff/elections', { rulesYaml: await f.text() });
      election(ctx, r.id);
    } catch (e) {
      msg.replaceChildren(status('bad', (e as Error).message));
    }
  });
  return h(
    'details',
    {},
    h('summary', {}, 'Create an election'),
    h('p', { class: 'small' }, 'Choose the election’s rules file. It says who may vote, what’s on the ballot, how it’s counted and the dates. Start from examples/rules.example.yaml in the project.'),
    h('label', { for: 'rules-file' }, 'Rules file'),
    file,
    msg,
  );
}

/** The issuer page lives on the project's own site; this server's copy refuses to run. Local test servers use their own. */
export function issuerPageUrl(): string {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  return local ? `${location.origin}/issue/` : new URL('issue/', __PROJECT_SITE__).href;
}

/** Opens the issuer page on the project's site, signed in with a 12-hour token handed over after the #. */
function issueButton(ctx: Ctx, info: ElectionInfo): HTMLElement {
  const msg = h('div', {});
  const page = new URL(issuerPageUrl());
  return h(
    'div',
    { class: 'panel' },
    h('h3', {}, 'Ballots'),
    h('p', {}, 'Make and print ballots, replace a lost one, and sign the close on the issuer page. It comes from the coded-ballot project’s own site, not this server, so this server never sees your passphrase or the codes.'),
    h(
      'p',
      {},
      h(
        'button',
        {
          onclick: async () => {
            try {
              const r = await ctx.api.post<{ token: string }>('/api/auth/tokens', { label: 'issuer page' });
              // the same tab, so no pop-up blocker gets in the way; the issuer page links back here
              location.assign(`${page.href}#${new URLSearchParams({ s: location.origin, e: info.id, t: r.token })}`);
            } catch (e) {
              msg.replaceChildren(status('bad', (e as Error).message));
            }
          },
        },
        'Issue ballots',
      ),
    ),
    h('p', { class: 'small' }, `Its address starts ${page.origin}${page.pathname}. If it doesn’t, don’t type your passphrase there.`),
    msg,
  );
}

/** A 12-hour token for the command-line issuer tool, for emailing everyone or posting through Lob. */
function toolToken(): HTMLElement {
  const out = h('div', {});
  return h(
    'details',
    {},
    h('summary', {}, 'Make a token for the command-line issuer tool'),
    h('p', { class: 'small' }, 'Most issuers never need this: the Issue ballots button on each election does the work in the browser. The command-line tool on your own computer is for emailing every member their ballot, or posting through Lob. The token lasts 12 hours, and signing out here ends it.'),
    h(
      'button',
      {
        class: 'secondary',
        onclick: async () => {
          try {
            const r = await api.post<{ token: string }>('/api/auth/tokens', { label: 'issuer tool' });
            const file = new Blob([`${r.token}\n`], { type: 'text/plain' });
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
  const head: HTMLElement[] = [signedInBar(ctx), back, h('h2', {}, info.title), h('p', { class: 'sub' }, `${info.organisation}. ${STATUS_LABEL[info.status]}.`)];
  if (ctx.staff.roles.includes('issuer') && ['setup', 'open', 'closed'].includes(info.status)) head.push(issueButton(c, info));
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
