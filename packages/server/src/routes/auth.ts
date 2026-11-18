// Staff sign-in with passkeys (WebAuthn), on both targets. Staff are enrolled by a one-time email link; the first
// person uses the server's setup token instead. Sessions are an HttpOnly, SameSite=Strict cookie.
import { Hono, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { fromBase64, toBase64, utf8ToBytes } from '@coded-ballot/core';
import { EMAIL, body, deps, fail, randomToken, str, tokenHash, type C, type Env, type Role, type Staff } from '../context.ts';

const SESSION_COOKIE = 'cb_session';
const SESSION_HOURS = 12;
const INVITE_DAYS = 7;
const TOKEN_HOURS = 12;
/** A hand-off code is not a token: it only buys one, within two minutes. */
const HANDOFF = 'hand-off';
const HANDOFF_HOURS = 2 / 60;

interface StaffRow {
  id: string;
  name: string;
  email: string;
  roles: string;
}

function toStaff(r: StaffRow): Staff {
  return { id: r.id, name: r.name, email: r.email, roles: r.roles.split(',').filter(Boolean) as Role[] };
}

function addHours(d: Date, h: number) {
  return new Date(d.getTime() + h * 3600_000).toISOString();
}

/** Loads the signed-in staff member, if any. */
export const loadStaff: MiddlewareHandler<Env> = async (c, next) => {
  const bearer = /^Bearer ([\w-]{20,100})$/.exec(c.req.header('authorization') ?? '')?.[1];
  if (bearer) {
    const { db, now } = deps(c);
    const r = await db.first<StaffRow>(
      'SELECT s.id, s.name, s.email, s.roles FROM api_tokens x JOIN staff s ON s.id = x.staff_id WHERE x.token_hash = ? AND x.expires_at > ? AND x.label <> ?',
      [tokenHash(bearer), now().toISOString(), HANDOFF],
    );
    if (!r) fail(401, 'This sign-in has ended (it lasts 12 hours, and signing out ends it). Open the issuer page again from the tellers’ app.');
    c.set('staff', toStaff(r));
    c.set('bearer', tokenHash(bearer));
    return next();
  }
  const t = getCookie(c, SESSION_COOKIE);
  if (t) {
    const { db, now } = deps(c);
    const r = await db.first<StaffRow>(
      'SELECT s.id, s.name, s.email, s.roles FROM sessions x JOIN staff s ON s.id = x.staff_id WHERE x.token_hash = ? AND x.expires_at > ?',
      [tokenHash(t), now().toISOString()],
    );
    if (r) c.set('staff', toStaff(r));
  }
  await next();
};

/** Only signed-in staff with one of these roles, from this server's own origin. Tool tokens are refused. */
export function requireRole(...roles: Role[]): MiddlewareHandler<Env> {
  return gate(roles, false);
}

/** The issuer tool's routes: an issuer's passkey session, or a tool token made by an issuer. */
export const issuerTool: MiddlewareHandler<Env> = gate(['issuer'], true);

function gate(roles: Role[], allowToken: boolean): MiddlewareHandler<Env> {
  return async (c, next) => {
    const s = c.get('staff');
    if (!s) fail(401, 'Sign in with your passkey first.');
    if (c.get('bearer') && !allowToken) fail(403, 'This sign-in only works for the issuer page. Sign in with your passkey.');
    if (!roles.some((r) => s.roles.includes(r))) fail(403, `This needs the ${roles.join(' or ')} role.`);
    if (c.req.method !== 'GET' && !c.get('bearer')) {
      const origin = c.req.header('origin');
      if (origin && origin !== deps(c).config.publicOrigin) fail(403, 'Staff actions must come from this server’s own pages.');
    }
    await next();
  };
}

async function newInvite(c: C, staffId: string): Promise<string> {
  const { db, now } = deps(c);
  const token = randomToken();
  await db.run('INSERT INTO invites (token_hash, staff_id, expires_at) VALUES (?, ?, ?)', [
    tokenHash(token),
    staffId,
    addHours(now(), INVITE_DAYS * 24),
  ]);
  return token;
}

async function inviteStaff(c: C, invite: string): Promise<Staff> {
  const { db, now } = deps(c);
  const r = await db.first<StaffRow>(
    'SELECT s.id, s.name, s.email, s.roles FROM invites i JOIN staff s ON s.id = i.staff_id WHERE i.token_hash = ? AND i.used = 0 AND i.expires_at > ?',
    [tokenHash(invite), now().toISOString()],
  );
  if (!r) fail(410, 'That sign-up link has expired or was already used. Ask for a new one.');
  return toStaff(r);
}

async function saveChallenge(c: C, challenge: string, staffId: string | null): Promise<string> {
  const { db, now } = deps(c);
  const id = randomToken(16);
  await db.run('DELETE FROM challenges WHERE expires_at < ?', [now().toISOString()]);
  await db.run('INSERT INTO challenges (id, challenge, staff_id, expires_at) VALUES (?, ?, ?, ?)', [
    id,
    challenge,
    staffId,
    addHours(now(), 0.1),
  ]);
  return id;
}

async function takeChallenge(c: C, id: string): Promise<{ challenge: string; staff_id: string | null }> {
  const { db, now } = deps(c);
  const r = await db.first<{ challenge: string; staff_id: string | null }>(
    'SELECT challenge, staff_id FROM challenges WHERE id = ? AND expires_at > ?',
    [id, now().toISOString()],
  );
  await db.run('DELETE FROM challenges WHERE id = ?', [id]);
  if (!r) fail(410, 'That sign-in attempt timed out. Try again.');
  return r;
}

async function startSession(c: C, staffId: string) {
  const { db, now, config } = deps(c);
  const token = randomToken();
  await db.run('INSERT INTO sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)', [
    tokenHash(token),
    staffId,
    addHours(now(), SESSION_HOURS),
  ]);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.publicOrigin.startsWith('https://'),
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_HOURS * 3600,
  });
}

export const auth = new Hono<Env>();

/** First person on a new server: needs the setup token, and only works while there are no staff. */
auth.post('/bootstrap', async (c) => {
  const { db, config, now } = deps(c);
  const b = await body<{ setupToken?: string; name?: string; email?: string }>(c);
  if (!config.setupToken || b.setupToken !== config.setupToken) fail(403, 'Wrong setup token.');
  if ((await db.first('SELECT id FROM staff LIMIT 1')) !== null) fail(409, 'This server already has staff. Ask one of them for an invitation.');
  const id = randomToken(12);
  await db.run('INSERT INTO staff (id, name, email, roles, created_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    str(b.name, 'name', undefined, 120),
    str(b.email, 'email', EMAIL, 200).toLowerCase(),
    'issuer,teller',
    now().toISOString(),
  ]);
  return c.json({ invite: await newInvite(c, id) });
});

/** Invite a teller or issuer: they get an email link to make their passkey. */
auth.post('/invite', requireRole('issuer', 'teller'), async (c) => {
  const { db, mailer, config, now } = deps(c);
  const b = await body<{ name?: string; email?: string; roles?: string[] }>(c);
  const roles = (b.roles ?? []).filter((r): r is Role => r === 'issuer' || r === 'teller');
  if (!roles.length) fail(400, 'Choose issuer, teller or both.');
  const mine = c.get('staff')!.roles;
  const extra = roles.filter((r) => !mine.includes(r));
  if (extra.length) fail(403, `You can only give roles you hold yourself (not ${extra.join(', ')}).`);
  const email = str(b.email, 'email', EMAIL, 200).toLowerCase();
  const existing = await db.first<{ id: string }>('SELECT id FROM staff WHERE email = ?', [email]);
  const id = existing?.id ?? randomToken(12);
  if (!existing) {
    await db.run('INSERT INTO staff (id, name, email, roles, created_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      str(b.name, 'name', undefined, 120),
      email,
      roles.join(','),
      now().toISOString(),
    ]);
  }
  const token = await newInvite(c, id);
  await mailer.send({
    to: email,
    subject: 'Set up your coded-ballot passkey',
    text:
      `${c.get('staff')!.name} has asked you to help run elections on ${config.publicOrigin}.\n\n` +
      `Open this link on the phone or computer you will use, and make a passkey when asked (it uses your fingerprint, face or screen lock):\n\n` +
      `${config.publicOrigin}/teller/#invite=${token}\n\nThe link works once and expires in ${INVITE_DAYS} days.`,
  });
  return c.json({ ok: true });
});

auth.post('/register/options', async (c) => {
  const { config } = deps(c);
  const b = await body<{ invite?: string }>(c);
  const staff = await inviteStaff(c, str(b.invite, 'invite'));
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: staff.email,
    userDisplayName: staff.name,
    userID: utf8ToBytes(staff.id) as Uint8Array<ArrayBuffer>,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  return c.json({ challengeId: await saveChallenge(c, options.challenge, staff.id), options });
});

auth.post('/register/verify', async (c) => {
  const { db, config, now } = deps(c);
  const b = await body<{ invite?: string; challengeId?: string; response?: unknown }>(c);
  const staff = await inviteStaff(c, str(b.invite, 'invite'));
  const ch = await takeChallenge(c, str(b.challengeId, 'challengeId'));
  if (ch.staff_id !== staff.id) fail(400, 'That sign-up attempt belongs to someone else.');
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: b.response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
      expectedChallenge: ch.challenge,
      expectedOrigin: config.publicOrigin,
      expectedRPID: config.rpId,
      requireUserVerification: true,
    });
  } catch (e) {
    fail(400, `The passkey could not be checked: ${(e as Error).message}`);
  }
  if (!v.verified) fail(400, 'The passkey could not be checked.');
  const cred = v.registrationInfo.credential;
  await db.batch([
    {
      sql: 'INSERT INTO passkeys (credential_id, staff_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      params: [cred.id, staff.id, toBase64(cred.publicKey), cred.counter, (cred.transports ?? []).join(','), now().toISOString()],
    },
    { sql: 'UPDATE invites SET used = 1 WHERE token_hash = ?', params: [tokenHash(b.invite!)] },
  ]);
  await startSession(c, staff.id);
  return c.json({ staff });
});

auth.post('/login/options', async (c) => {
  const { config } = deps(c);
  const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required' });
  return c.json({ challengeId: await saveChallenge(c, options.challenge, null), options });
});

auth.post('/login/verify', async (c) => {
  const { db, config } = deps(c);
  const b = await body<{ challengeId?: string; response?: { id?: string } }>(c);
  const ch = await takeChallenge(c, str(b.challengeId, 'challengeId'));
  const credId = str(b.response?.id, 'credential');
  const pk = await db.first<{ staff_id: string; public_key: string; counter: number; transports: string | null }>(
    'SELECT staff_id, public_key, counter, transports FROM passkeys WHERE credential_id = ?',
    [credId],
  );
  if (!pk) fail(401, 'That passkey isn’t registered here.');
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: b.response as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
      expectedChallenge: ch.challenge,
      expectedOrigin: config.publicOrigin,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      credential: {
        id: credId,
        publicKey: fromBase64(pk.public_key) as Uint8Array<ArrayBuffer>,
        counter: pk.counter,
        transports: (pk.transports ? pk.transports.split(',') : []) as never,
      },
    });
  } catch (e) {
    fail(401, `The passkey could not be checked: ${(e as Error).message}`);
  }
  if (!v.verified) fail(401, 'The passkey could not be checked.');
  await db.run('UPDATE passkeys SET counter = ? WHERE credential_id = ?', [v.authenticationInfo.newCounter, credId]);
  await startSession(c, pk.staff_id);
  const s = await db.first<StaffRow>('SELECT id, name, email, roles FROM staff WHERE id = ?', [pk.staff_id]);
  return c.json({ staff: toStaff(s!) });
});

auth.post('/logout', async (c) => {
  // the issuer page signs out only its own token, never the passkey session in the tellers' app
  const bearer = c.get('bearer');
  if (bearer) {
    await deps(c).db.run('DELETE FROM api_tokens WHERE token_hash = ?', [bearer]);
    return c.json({ ok: true });
  }
  const t = getCookie(c, SESSION_COOKIE);
  if (t) await deps(c).db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash(t)]);
  // signing out of the tellers' app also ends every token this person made
  const s = c.get('staff');
  if (s) await deps(c).db.run('DELETE FROM api_tokens WHERE staff_id = ?', [s.id]);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

auth.get('/me', (c) => c.json({ staff: c.get('staff') ?? null }));

async function newToken(c: C, staffId: string, label: string, hours: number): Promise<string> {
  const token = randomToken();
  await deps(c).db.run('INSERT INTO api_tokens (token_hash, staff_id, label, expires_at) VALUES (?, ?, ?, ?)', [
    tokenHash(token),
    staffId,
    label,
    addHours(deps(c).now(), hours),
  ]);
  return token;
}

/** A token for the command-line issuer tool, valid for 12 hours. Only from a passkey session, never from another token. */
auth.post('/tokens', requireRole('issuer'), async (c) => {
  const b = await body<{ label?: string }>(c);
  const label = (b.label ?? 'issuer tool').slice(0, 80);
  if (label === HANDOFF) fail(400, 'That label is reserved.');
  return c.json({ token: await newToken(c, c.get('staff')!.id, label, TOKEN_HOURS), expiresInHours: TOKEN_HOURS });
});

/**
 * The issuer page on the project's site: the tellers' app puts a one-time code, good for two minutes, after the # of
 * the page's address, and the page trades it here for a 12-hour token it keeps in memory. So the token itself is never
 * in an address, where browser history would keep it.
 */
auth.post('/handoff', requireRole('issuer'), async (c) => c.json({ code: await newToken(c, c.get('staff')!.id, HANDOFF, HANDOFF_HOURS) }));

auth.post('/handoff/redeem', async (c) => {
  const { db, now } = deps(c);
  const code = str((await body<{ code?: string }>(c)).code, 'hand-off code', /^[\w-]{20,100}$/);
  const h = tokenHash(code);
  const r = await db.first<{ staff_id: string }>('SELECT staff_id FROM api_tokens WHERE token_hash = ? AND label = ? AND expires_at > ?', [h, HANDOFF, now().toISOString()]);
  // deleted before the token is made, so a code is only ever spent once
  if (!r || (await db.run('DELETE FROM api_tokens WHERE token_hash = ? AND label = ?', [h, HANDOFF])).changes !== 1) {
    fail(410, 'This link to the issuer page has expired or was already used. Open the issuer page again from the tellers’ app.');
  }
  return c.json({ token: await newToken(c, r.staff_id, 'issuer page', TOKEN_HOURS), expiresInHours: TOKEN_HOURS });
});

auth.get('/staff', requireRole('issuer', 'teller'), async (c) => {
  const rows = await deps(c).db.all<StaffRow>('SELECT id, name, email, roles FROM staff ORDER BY name');
  return c.json({ staff: rows.map(toStaff) });
});
