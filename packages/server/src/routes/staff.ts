// Routes for the issuer and the tellers: set-up, opening, receipts, close, the count and certification.
import { Hono } from 'hono';
import { parseDocument } from 'yaml';
import {
  closeStatement,
  countKeyPublicFromPrivate,
  toBase64,
  sha256Hex,
  fingerprint,
  fromBase64,
  loadRules,
  lockedVotesDigest,
  RulesError,
  SpendList,
  verifyClose,
  type Channel,
  type CloseStatement,
} from '@coded-ballot/core';
import { body, deps, ELECTION, EMAIL, fail, HEX64, str, STYLE, type C, type Env } from '../context.ts';
import { issuerTool, requireRole } from './auth.ts';
import { getElection, lockedVotes, log, logStmt, requireStatus, SqlSpendStore } from '../store.ts';
import type { Stmt } from '../db/types.ts';

export const staff = new Hono<Env>();
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const issuer = requireRole('issuer');
const teller = requireRole('teller');
const anyStaff = requireRole('issuer', 'teller');

function parseRules(yaml: string) {
  try {
    return loadRules(yaml);
  } catch (e) {
    if (e instanceof RulesError) fail(400, e.message);
    throw e;
  }
}

/** In separated mode the issuer never holds the count key. */
function separatedCheck(c: C, rules: { roles: { mode: string } }) {
  if (rules.roles.mode === 'separated' && c.get('staff')!.roles.includes('issuer')) {
    fail(403, 'In separated mode the count key belongs to a teller who is not also the issuer.');
  }
}

staff.post('/elections', issuer, async (c) => {
  const { db, now } = deps(c);
  const b = await body<{ rulesYaml?: string }>(c);
  const { rules, sha256 } = parseRules(str(b.rulesYaml, 'rules file', undefined, 200_000));
  if (await db.first('SELECT id FROM elections WHERE id = ?', [rules.election.id])) fail(409, 'An election with that ID already exists.');
  await db.batch([
    {
      sql: 'INSERT INTO elections (id, rules_yaml, rules_sha256, created_at) VALUES (?, ?, ?, ?)',
      params: [rules.election.id, b.rulesYaml!, sha256, now().toISOString()],
    },
    logStmt(rules.election.id, now(), 'created', { rulesSha256: sha256 }),
  ]);
  return c.json({ id: rules.election.id, rulesSha256: sha256 });
});

staff.get('/elections', anyStaff, async (c) => {
  const rows = await deps(c).db.all('SELECT id, status, rules_sha256, created_at FROM elections ORDER BY created_at DESC');
  return c.json({ elections: rows });
});

staff.put('/e/:id/rules', issuer, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'setup');
  const b = await body<{ rulesYaml?: string }>(c);
  const { rules, sha256 } = parseRules(str(b.rulesYaml, 'rules file', undefined, 200_000));
  if (rules.election.id !== e.row.id) fail(400, 'The rules file is for a different election ID.');
  await db.batch([
    { sql: 'UPDATE elections SET rules_yaml = ?, rules_sha256 = ? WHERE id = ?', params: [b.rulesYaml!, sha256, e.row.id] },
    logStmt(e.row.id, now(), 'rules_changed', { rulesSha256: sha256 }),
  ]);
  return c.json({ rulesSha256: sha256 });
});

/** The roll frozen at notice: member IDs and emails only, for online links. Names and addresses stay with the issuer. */
staff.post('/e/:id/roll', issuerTool, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'setup');
  const b = await body<{ members?: { memberId: string; email: string | null }[]; rollSha256?: string; frozenAt?: string }>(c);
  const members = b.members ?? [];
  const stmts: Stmt[] = [
    { sql: 'DELETE FROM voter_links WHERE election_id = ?', params: [e.row.id] },
    { sql: 'DELETE FROM voters WHERE election_id = ?', params: [e.row.id] },
  ];
  let withEmail = 0;
  for (const m of members) {
    str(m.memberId, 'member ID', /^[^|\s]{1,100}$/);
    if (!m.email) continue;
    withEmail++;
    stmts.push({
      sql: 'INSERT INTO voters (election_id, member_id, email) VALUES (?, ?, ?)',
      params: [e.row.id, m.memberId, String(m.email).toLowerCase()],
    });
  }
  stmts.push({
    sql: 'UPDATE elections SET roll_sha256 = ?, roll_frozen_at = ? WHERE id = ?',
    params: [str(b.rollSha256, 'roll fingerprint', HEX64), str(b.frozenAt, 'freeze time'), e.row.id],
  });
  stmts.push(logStmt(e.row.id, now(), 'roll_frozen', { members: members.length, withEmail, rollSha256: b.rollSha256 }));
  await db.batch(stmts);
  return c.json({ members: members.length, withEmail });
});

/** A change after the freeze: listed for the tellers, and a changed email is reported to the old address. */
staff.post('/e/:id/roll/changes', issuerTool, async (c) => {
  const { db, now, mailer } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'setup', 'open');
  const b = await body<{ changes?: { memberId: string; kind: string; oldEmail?: string | null; newEmail?: string | null }[] }>(c);
  for (const ch of b.changes ?? []) {
    const memberId = str(ch.memberId, 'member ID', /^[^|\s]{1,100}$/);
    const kind = str(ch.kind, 'kind', /^[a-z_]{1,30}$/);
    // the old address is the one the server holds, never one the caller supplies
    const prev = await db.first<{ email: string | null; used: string | null }>('SELECT email, used FROM voters WHERE election_id = ? AND member_id = ?', [
      e.row.id,
      memberId,
    ]);
    const newEmail = ch.newEmail ? str(ch.newEmail, 'new email', EMAIL, 200).toLowerCase() : null;
    if (kind === 'email_changed' && prev?.used) fail(409, `${memberId} has already voted online; their email can't change now.`);
    await db.run('INSERT INTO roll_changes (election_id, member_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)', [
      e.row.id,
      memberId,
      kind,
      JSON.stringify(kind === 'email_changed' ? { oldEmail: prev?.email ?? null, newEmail } : {}),
      now().toISOString(),
    ]);
    if (kind === 'email_changed') {
      // the new address and the end of links already sent to the old one happen together
      await db.batch([
        newEmail
          ? {
              sql: `INSERT INTO voters (election_id, member_id, email) VALUES (?, ?, ?)
                    ON CONFLICT (election_id, member_id) DO UPDATE SET email = excluded.email`,
              params: [e.row.id, memberId, newEmail],
            }
          : { sql: 'DELETE FROM voters WHERE election_id = ? AND member_id = ? AND used IS NULL', params: [e.row.id, memberId] },
        { sql: 'DELETE FROM voter_links WHERE election_id = ? AND member_id = ?', params: [e.row.id, memberId] },
      ]);
      if (prev?.email && prev.email !== newEmail) {
        await mailer.send({
          to: prev.email,
          subject: `${e.rules.election.organisation}: your email for ${e.rules.election.title} was changed`,
          text:
            `The email address the ${e.rules.election.organisation} tellers will use for your online voting link in ` +
            `"${e.rules.election.title}" was changed from this address.\n\nIf you did not ask for this, tell the tellers at once.`,
        });
      }
    }
  }
  await log(db, e.row.id, now(), 'roll_changed', { changes: (b.changes ?? []).length });
  return c.json({ ok: true });
});

/** The issuer uploads hash(S) and style for each code, and the public half of the signing key. */
staff.post('/e/:id/codes', issuerTool, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'setup');
  const b = await body<{ issuerPublicKey?: string; codes?: { hash: string; styleId: string }[] }>(c);
  const pk = str(b.issuerPublicKey, 'issuer public key', /^[A-Za-z0-9+/]{43}=$/);
  if (e.row.issuer_public_key && e.row.issuer_public_key !== pk) fail(409, 'These codes were made from a different passphrase.');
  const codes = b.codes ?? [];
  for (const k of codes) {
    str(k.hash, 'code hash', HEX64);
    str(k.styleId, 'style', STYLE);
  }
  await db.run('UPDATE elections SET issuer_public_key = ? WHERE id = ?', [pk, e.row.id]);
  try {
    await new SqlSpendStore(db, e.row.id).insert(codes);
  } catch {
    fail(409, 'Some of these codes were already uploaded.');
  }
  await log(db, e.row.id, now(), 'codes_issued', { count: codes.length, issuerKey: fingerprint(fromBase64(pk)) });
  return c.json({ issued: codes.length });
});

/** Reissue: revoke copy n and issue copy n + 1, together. The public log shows only that a reissue happened. */
staff.post('/e/:id/codes/reissue', issuerTool, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'setup', 'open');
  const b = await body<{ revoke?: string; issue?: { hash: string; styleId: string } }>(c);
  const old = str(b.revoke, 'old code hash', HEX64);
  const neu = str(b.issue?.hash, 'new code hash', HEX64);
  const style = str(b.issue?.styleId, 'style', STYLE);
  const at = now().toISOString();
  const res = await db.batch([
    {
      sql: "UPDATE codes SET state = 'revoked', at = ? WHERE election_id = ? AND hash = ? AND state = 'issued'",
      params: [at, e.row.id, old],
    },
    {
      sql: `INSERT INTO codes (election_id, hash, style_id) SELECT ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM codes WHERE election_id = ? AND hash = ? AND state = 'revoked' AND at = ?)`,
      params: [e.row.id, neu, style, e.row.id, old, at],
    },
  ]);
  if (res[0]!.changes !== 1) {
    const r = await db.first<{ state: string }>('SELECT state FROM codes WHERE election_id = ? AND hash = ?', [e.row.id, old]);
    fail(409, !r ? 'The old code isn’t known.' : r.state === 'spent' ? 'The old code was already used: that member has voted.' : 'The old code was already replaced.');
  }
  await log(db, e.row.id, now(), 'reissue');
  return c.json({ ok: true });
});

/** The issuer records destroying every copy of the passphrase (after close, before the box is opened). */
staff.post('/e/:id/key-destroyed', issuerTool, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'closed');
  await log(db, e.row.id, now(), 'issuer_key_destroyed', { by: c.get('staff')!.name });
  return c.json({ ok: true });
});

staff.post('/e/:id/passphrase-backup', issuerTool, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'setup');
  await db.batch([
    { sql: 'UPDATE elections SET passphrase_backup_confirmed = 1 WHERE id = ?', params: [e.row.id] },
    logStmt(e.row.id, now(), 'passphrase_backup_confirmed'),
  ]);
  return c.json({ ok: true });
});

/** A teller's browser makes the count key; only its public half comes here. */
staff.post('/e/:id/count-key', teller, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'setup');
  separatedCheck(c, e.rules);
  const b = await body<{ publicKey?: string }>(c);
  const pk = str(b.publicKey, 'public key', /^[A-Za-z0-9+/]{43}=$/);
  await db.batch([
    { sql: 'UPDATE elections SET count_key_public = ?, count_key_confirmed = 0 WHERE id = ?', params: [pk, e.row.id] },
    logStmt(e.row.id, now(), 'count_key_created', { fingerprint: fingerprint(fromBase64(pk)) }),
  ]);
  return c.json({ fingerprint: fingerprint(fromBase64(pk)) });
});

staff.post('/e/:id/count-key/confirm', teller, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'setup');
  separatedCheck(c, e.rules);
  if (!e.row.count_key_public) fail(409, 'Create the count key first.');
  await db.batch([
    { sql: 'UPDATE elections SET count_key_confirmed = 1 WHERE id = ?', params: [e.row.id] },
    logStmt(e.row.id, now(), 'count_key_second_copy_confirmed'),
  ]);
  return c.json({ ok: true });
});

staff.post('/e/:id/open', anyStaff, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'setup');
  const missing: string[] = [];
  const issued = await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM codes WHERE election_id = ?', [e.row.id]);
  if (!issued?.n) missing.push('the codes have not been uploaded');
  if (!e.row.passphrase_backup_confirmed) missing.push('a second copy of the issuer passphrase has not been confirmed');
  if (!e.row.roll_sha256) missing.push('the roll has not been frozen');
  if (e.rules.channels.online) {
    if (!e.row.count_key_public) missing.push('the count key has not been created');
    else if (!e.row.count_key_confirmed) missing.push('a second copy of the count key has not been confirmed');
  }
  if (missing.length) fail(409, `Voting can't open yet: ${missing.join('; ')}.`);
  await db.batch([
    { sql: "UPDATE elections SET status = 'open' WHERE id = ?", params: [e.row.id] },
    logStmt(e.row.id, now(), 'opened', { codes: issued!.n }),
  ]);
  return c.json({ ok: true });
});

/** A mailed envelope or an in-person drop: the QR code on the outside of the folded sheet spends the code. */
staff.post('/e/:id/receipts', teller, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'open');
  const b = await body<{ hash?: string; styleId?: string; channel?: string }>(c);
  const channel = b.channel as Channel;
  if (channel !== 'mail' && channel !== 'in_person') fail(400, 'channel must be mail or in_person');
  if (!e.rules.channels[channel]) fail(409, `This election doesn't allow ${channel === 'mail' ? 'mail' : 'in-person'} voting.`);
  const list = new SpendList(new SqlSpendStore(db, e.row.id), e.row.id);
  // the style from the QR code must match the code's; a code typed by hand from a damaged sheet has none
  const r = await list.spend(str(b.hash, 'code hash', HEX64), channel, now(), b.styleId === undefined ? undefined : str(b.styleId, 'style', STYLE));
  return c.json(r);
});

/** What the issuer signs at close: the fingerprint of every locked vote. The votes themselves stay gated. */
staff.get('/e/:id/close/prepare', issuerTool, async (c) => {
  const { db } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'open');
  return c.json(lockedVotesDigest(await lockedVotes(db, e.row.id)));
});

staff.post('/e/:id/close', issuerTool, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'open');
  if (now() < new Date(e.rules.dates.voting_closes)) fail(409, 'Voting can only be closed after the closing time in the rules file.');
  const b = await body<{ statement?: CloseStatement; signature?: string }>(c);
  if (!b.statement || b.statement.electionId !== e.row.id || b.statement.fallback) fail(400, 'Not a close statement for this election.');
  if (Math.abs(Date.parse(b.statement.closedAt) - now().getTime()) > 15 * 60_000) fail(400, 'The close time must be within 15 minutes of now.');
  const check = await verifyClose(
    { statement: b.statement, signature: str(b.signature, 'signature') },
    fromBase64(e.row.issuer_public_key!),
    await lockedVotes(db, e.row.id),
  );
  if (!check.ok) fail(409, `Close refused: ${check.reason}. If votes arrived meanwhile, prepare and sign again.`);
  await db.batch([
    {
      sql: "UPDATE elections SET status = 'closed', close_json = ?, close_signature = ?, close_fallback = 0 WHERE id = ? AND status = 'open'",
      params: [JSON.stringify(b.statement), b.signature!, e.row.id],
    },
    logStmt(e.row.id, now(), 'closed', { closedAt: b.statement.closedAt, lockedVotes: b.statement.lockedVotes }),
  ]);
  return c.json({ ok: true });
});

/** Every copy of the passphrase is lost: tellers close instead (two of them, if there are two), marked as a fallback. */
staff.post('/e/:id/close/fallback', teller, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'open');
  if (now() < new Date(e.rules.dates.voting_closes)) fail(409, 'Voting can only be closed after the closing time in the rules file.');
  const me = c.get('staff')!;
  // Only tellers who were already staff when voting opened count, so nobody can invite helpers to force a close.
  const opened = (await db.first<{ at: string }>("SELECT at FROM public_log WHERE election_id = ? AND kind = 'opened'", [e.row.id]))!.at;
  const eligible = (await db.all<{ id: string; roles: string }>('SELECT id, roles FROM staff WHERE created_at < ?', [opened])).filter((s) =>
    s.roles.split(',').includes('teller'),
  );
  if (!eligible.some((s) => s.id === me.id)) fail(403, 'Only tellers who were already staff when voting opened can approve a fallback close.');
  await db.run('INSERT OR IGNORE INTO fallback_close_approvals (election_id, staff_id, at) VALUES (?, ?, ?)', [
    e.row.id,
    me.id,
    now().toISOString(),
  ]);
  const need = Math.min(2, eligible.length);
  const ids = new Set(eligible.map((s) => s.id));
  const have = (await db.all<{ staff_id: string }>('SELECT staff_id FROM fallback_close_approvals WHERE election_id = ?', [e.row.id])).filter((a) =>
    ids.has(a.staff_id),
  ).length;
  if (have < need) {
    await log(db, e.row.id, now(), 'fallback_close_requested', { approvals: have, needed: need });
    return c.json({ closed: false, approvals: have, needed: need });
  }
  const st = closeStatement(e.row.id, now(), await lockedVotes(db, e.row.id), true);
  await db.batch([
    {
      sql: "UPDATE elections SET status = 'closed', close_json = ?, close_signature = NULL, close_fallback = 1 WHERE id = ? AND status = 'open'",
      params: [JSON.stringify(st), e.row.id],
    },
    logStmt(e.row.id, now(), 'closed_fallback', { closedAt: st.closedAt, lockedVotes: st.lockedVotes, approvals: have }),
  ]);
  return c.json({ closed: true });
});

/** The locked votes, only after a valid close. Every attempt goes in the public log. */
staff.get('/e/:id/locked-votes', teller, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  const me = c.get('staff')!;
  if (e.row.status !== 'closed' && e.row.status !== 'certified') {
    await log(db, e.row.id, now(), 'locked_votes_refused', { by: me.name, status: e.row.status });
    fail(409, 'Locked votes are only released after the close.');
  }
  await log(db, e.row.id, now(), 'locked_votes_downloaded', { by: me.name });
  return c.json({
    lockedVotes: await lockedVotes(db, e.row.id),
    close: { statement: JSON.parse(e.row.close_json!), signature: e.row.close_signature },
    issuerPublicKey: e.row.issuer_public_key,
  });
});

/**
 * Every code received on paper (by post or in person) with its ballot style, fetched once by the tellers' app before
 * reading the paper. Each sheet's code and style are checked against this list on the teller's device, so a sheet
 * that was never received, voted online, or carries the wrong style can't be counted, and the server never sees
 * which code a cast vote record came from.
 */
staff.get('/e/:id/paper-codes', teller, async (c) => {
  const { db } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'closed');
  const rows = await db.all<{ hash: string; style_id: string }>(
    "SELECT hash, style_id FROM codes WHERE election_id = ? AND state = 'spent' AND channel IN ('mail', 'in_person') ORDER BY hash",
    [e.row.id],
  );
  return c.json({ codes: rows.map((r) => ({ hash: r.hash, styleId: r.style_id })) });
});

/** Paper read at the count: cast vote records (no codes) and the image fingerprints. */
staff.post('/e/:id/paper', teller, async (c) => {
  const { db } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'closed');
  const b = await body<{
    records?: { id: string; styleId: string; batch?: string; cvr: unknown; imageSha256?: string; status: string; issues?: unknown }[];
  }>(c);
  const stmts: Stmt[] = (b.records ?? []).map((r) => ({
    sql: `INSERT INTO paper_records (election_id, id, style_id, batch, cvr, image_sha256, image_key, status, issues)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      e.row.id,
      str(r.id, 'record ID', /^[A-Za-z0-9_-]{8,64}$/),
      str(r.styleId, 'style', STYLE),
      r.batch === 'provisional' ? 'provisional' : 'main',
      JSON.stringify(r.cvr),
      r.imageSha256 ? str(r.imageSha256, 'image hash', HEX64) : null,
      r.imageSha256 ? `${e.row.id}/images/${r.imageSha256}` : null,
      r.status === 'adjudicate' ? 'adjudicate' : 'ok',
      r.issues ? JSON.stringify(r.issues) : null,
    ],
  }));
  if (stmts.length) await db.batch(stmts);
  return c.json({ stored: stmts.length });
});

staff.put('/e/:id/images/:sha', teller, async (c) => {
  const { db, blobs } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'closed');
  const sha = str(c.req.param('sha'), 'image hash', HEX64);
  const data = new Uint8Array(await c.req.arrayBuffer());
  if (data.length > 15 * 1024 * 1024) fail(400, 'Image too large.');
  if (sha256Hex(data) !== sha) fail(400, 'The image doesn’t match its fingerprint.');
  const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim();
  if (!IMAGE_TYPES.includes(type)) fail(400, 'Images must be JPEG, PNG or WebP.');
  await blobs.put(`${e.row.id}/images/${sha}`, data, type);
  return c.json({ ok: true });
});

staff.get('/e/:id/paper', teller, async (c) => {
  const { db } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  const rows = await db.all('SELECT id, style_id, batch, cvr, image_sha256, status, issues, ruling, ruled_by FROM paper_records WHERE election_id = ?', [
    e.row.id,
  ]);
  return c.json({ records: rows });
});

staff.get('/e/:id/images/:sha', teller, async (c) => {
  const { db, blobs } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  const o = await blobs.get(`${e.row.id}/images/${str(c.req.param('sha'), 'image hash', HEX64)}`);
  if (!o) fail(404, 'No such image.');
  return new Response(o.data as Uint8Array<ArrayBuffer>, {
    headers: {
      'content-type': IMAGE_TYPES.includes(o.contentType) ? o.contentType : 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, no-store',
    },
  });
});

/** A teller rules on an unclear ballot: the cast vote record to count, or rejected. */
staff.post('/e/:id/paper/:rid/ruling', teller, async (c) => {
  const { db } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'closed');
  const b = await body<{ cvr?: unknown; reject?: boolean; note?: string }>(c);
  const r = await db.run(
    "UPDATE paper_records SET status = ?, cvr = COALESCE(?, cvr), ruling = ?, ruled_by = ? WHERE election_id = ? AND id = ? AND status = 'adjudicate'",
    [
      b.reject ? 'rejected' : 'resolved',
      b.reject ? null : JSON.stringify(b.cvr),
      JSON.stringify({ reject: !!b.reject, note: (b.note ?? '').slice(0, 500) }),
      c.get('staff')!.name,
      e.row.id,
      c.req.param('rid'),
    ],
  );
  if (r.changes !== 1) fail(409, 'That ballot isn’t waiting for a ruling.');
  return c.json({ ok: true });
});

staff.post('/e/:id/hand-count', teller, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'closed');
  const b = await body<{ contestId?: string; totals?: Record<string, string> }>(c);
  const contestId = str(b.contestId, 'contest', ELECTION);
  if (!e.rules.contests.some((x) => x.id === contestId)) fail(400, 'No such contest.');
  await db.run(
    `INSERT INTO hand_counts (election_id, contest_id, staff_id, totals, at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (election_id, contest_id, staff_id) DO UPDATE SET totals = excluded.totals, at = excluded.at`,
    [e.row.id, contestId, c.get('staff')!.id, JSON.stringify(b.totals ?? {}), now().toISOString()],
  );
  return c.json({ ok: true });
});

staff.post('/e/:id/provisional', teller, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'closed');
  const b = await body<{ upheld?: number; rejected?: number }>(c);
  const up = Number(b.upheld ?? 0);
  const rej = Number(b.rejected ?? 0);
  if (!Number.isInteger(up) || !Number.isInteger(rej) || up < 0 || rej < 0) fail(400, 'Counts must be whole numbers.');
  await db.batch([
    {
      sql: `INSERT INTO provisional_tally (election_id, upheld, rejected, staff_id, at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (election_id) DO UPDATE SET upheld = excluded.upheld, rejected = excluded.rejected, staff_id = excluded.staff_id, at = excluded.at`,
      params: [e.row.id, up, rej, c.get('staff')!.id, now().toISOString()],
    },
    logStmt(e.row.id, now(), 'provisional_ruled', { upheld: up, rejectedDestroyedUnread: rej }),
  ]);
  return c.json({ ok: true });
});

staff.post('/e/:id/tamper-checks', teller, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  const b = await body<{ ok?: boolean; detail?: unknown }>(c);
  await db.run('INSERT INTO tamper_checks (election_id, at, ok, detail, staff_id) VALUES (?, ?, ?, ?, ?)', [
    e.row.id,
    now().toISOString(),
    b.ok ? 1 : 0,
    JSON.stringify(b.detail ?? {}).slice(0, 20_000),
    c.get('staff')!.id,
  ]);
  if (!b.ok) await log(db, e.row.id, now(), 'tamper_check_failed', {});
  return c.json({ ok: true });
});

/** The data the teller report is built from (staff only: roll changes name members). */
staff.get('/e/:id/report-data', teller, async (c) => {
  const { db } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  const id = e.row.id;
  const list = new SpendList(new SqlSpendStore(db, id), id);
  return c.json({
    rulesSha256: e.row.rules_sha256,
    counts: await list.counts(),
    rejectedUses: await list.rejectedUses(),
    // the electorate by ballot style (codes not replaced): for thresholds "of members", quorum and small groups
    styles: (
      await db.all<{ style_id: string; n: number }>("SELECT style_id, COUNT(*) AS n FROM codes WHERE election_id = ? AND state != 'revoked' GROUP BY style_id ORDER BY style_id", [id])
    ).map((r) => ({ styleId: r.style_id, n: r.n })),
    keyDestroyedAt: (await db.first<{ at: string }>("SELECT at FROM public_log WHERE election_id = ? AND kind = 'issuer_key_destroyed' ORDER BY seq DESC LIMIT 1", [id]))?.at ?? null,
    closedAt: e.row.close_json ? (JSON.parse(e.row.close_json) as { closedAt: string }).closedAt : null,
    rollChanges: await db.all('SELECT member_id, kind, detail, at FROM roll_changes WHERE election_id = ? ORDER BY at', [id]),
    tamperChecks: await db.all('SELECT at, ok, detail FROM tamper_checks WHERE election_id = ? ORDER BY at', [id]),
    handCounts: await db.all(
      'SELECT h.contest_id, s.name AS teller, h.totals, h.at FROM hand_counts h JOIN staff s ON s.id = h.staff_id WHERE election_id = ?',
      [id],
    ),
    provisional: await db.first('SELECT upheld, rejected FROM provisional_tally WHERE election_id = ?', [id]),
    log: await db.all('SELECT seq, at, kind, detail FROM public_log WHERE election_id = ? ORDER BY seq', [id]),
  });
});

/**
 * Certify. The tellers' app sends the results, the teller report, the count key's private half (published so anyone
 * can recount the online votes) and its paper-only totals; every teller's hand count must match those exactly.
 */
staff.post('/e/:id/certify', teller, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  requireStatus(e, 'closed');
  const b = await body<{ results?: unknown; report?: unknown; countKeyPrivate?: string; paperTotals?: Record<string, Record<string, string>> }>(c);
  if (e.row.count_key_public) {
    const priv = str(b.countKeyPrivate, 'count key', /^[A-Za-z0-9+/]{43}=$/);
    if (toBase64(countKeyPublicFromPrivate(fromBase64(priv))) !== e.row.count_key_public) fail(400, 'That is not the count key for this election.');
  }
  const pending = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM paper_records WHERE election_id = ? AND status = 'adjudicate'", [e.row.id]);
  if (pending!.n) fail(409, `${pending!.n} ballot(s) still need a ruling.`);
  const hand = await db.all<{ contest_id: string; totals: string }>('SELECT contest_id, totals FROM hand_counts WHERE election_id = ?', [e.row.id]);
  const paperTotals = b.paperTotals ?? {};
  const problems: string[] = [];
  for (const contest of e.rules.contests) {
    const mine = hand.filter((h) => h.contest_id === contest.id);
    if (!mine.length) problems.push(`no hand count entered for ${contest.title}`);
    for (const h of mine) {
      if (!sameTotals(JSON.parse(h.totals), paperTotals[contest.id] ?? {}))
        problems.push(`the hand count for ${contest.title} doesn't match the app's paper count`);
    }
  }
  if (problems.length) fail(409, `Can't certify: ${[...new Set(problems)].join('; ')}.`);
  const at = now().toISOString();
  await db.batch([
    {
      sql: "UPDATE elections SET status = 'certified', results_json = ?, report_json = ?, count_key_private = ?, certified_at = ? WHERE id = ? AND status = 'closed'",
      params: [JSON.stringify(b.results ?? null), JSON.stringify(b.report ?? null), b.countKeyPrivate ?? null, at, e.row.id],
    },
    logStmt(e.row.id, now(), 'certified', { by: c.get('staff')!.name }),
  ]);
  return c.json({ ok: true });
});

function sameTotals(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (Number(a[k] ?? 0) !== Number(b[k] ?? 0)) return false;
  return true;
}

/** Clone as runoff: the same roll and rules in a new election. The issuer then makes fresh codes for it. */
staff.post('/e/:id/clone', issuer, async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  const b = await body<{ newId?: string; title?: string }>(c);
  const newId = str(b.newId, 'new election ID', ELECTION);
  if (await db.first('SELECT id FROM elections WHERE id = ?', [newId])) fail(409, 'An election with that ID already exists.');
  const doc = parseDocument(e.row.rules_yaml);
  doc.setIn(['election', 'id'], newId);
  doc.setIn(['election', 'title'], b.title ?? `${e.rules.election.title} - runoff`);
  const yaml = doc.toString();
  const { sha256 } = parseRules(yaml);
  await db.batch([
    {
      sql: 'INSERT INTO elections (id, rules_yaml, rules_sha256, roll_sha256, roll_frozen_at, cloned_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [newId, yaml, sha256, e.row.roll_sha256, e.row.roll_frozen_at, e.row.id, now().toISOString()],
    },
    {
      sql: 'INSERT INTO voters (election_id, member_id, email) SELECT ?, member_id, email FROM voters WHERE election_id = ?',
      params: [newId, e.row.id],
    },
    logStmt(newId, now(), 'created', { rulesSha256: sha256, runoffOf: e.row.id }),
    logStmt(e.row.id, now(), 'runoff_created', { runoff: newId }),
  ]);
  return c.json({ id: newId, rulesSha256: sha256, note: 'Edit the dates and contests in the rules file before making codes.' });
});
