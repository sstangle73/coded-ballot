// Public routes: election information, the ballot tracker, counts, the public log, results, and online voting.
// These allow CORS from the project's own voting page and member checker.
import { Hono } from 'hono';
import { describeStyle, fingerprint, fromBase64, SpendList } from '@coded-ballot/core';
import { body, deps, fail, HEX64, randomToken, str, STYLE, tokenHash, type C, type Env } from '../context.ts';
import { getElection, lockedVotes, SqlSpendStore, type Election } from '../store.ts';

export const pub = new Hono<Env>();

const LINK_HOURS = 72;
const LINKS_PER_HOUR = 3;
const MAX_SEALED_BYTES = 64 * 1024;

function info(e: Election) {
  const r = e.rules;
  return {
    id: e.row.id,
    title: r.election.title,
    organisation: r.election.organisation,
    status: e.row.status,
    dates: r.dates,
    channels: r.channels,
    timeLock: r.time_lock.enabled,
    rulesSha256: e.row.rules_sha256,
    rules: r,
    countKey: e.row.count_key_public
      ? { publicKey: e.row.count_key_public, fingerprint: fingerprint(fromBase64(e.row.count_key_public)) }
      : null,
    issuerKey: e.row.issuer_public_key
      ? { publicKey: e.row.issuer_public_key, fingerprint: fingerprint(fromBase64(e.row.issuer_public_key)) }
      : null,
    closeFallback: !!e.row.close_fallback,
    certifiedAt: e.row.certified_at,
    clonedFrom: e.row.cloned_from,
  };
}

pub.get('/e/:id', async (c) => c.json(info(await getElection(deps(c).db, c.req.param('id')))));

/** The tracker. The page hashes the code in the browser, so the code itself never reaches the server here. */
pub.get('/e/:id/track/:hash', async (c) => {
  const { db } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  const list = new SpendList(new SqlSpendStore(db, e.row.id), e.row.id);
  return c.json(await list.track(str(c.req.param('hash'), 'code hash', HEX64)));
});

pub.get('/e/:id/counts', async (c) => {
  const { db } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  const list = new SpendList(new SqlSpendStore(db, e.row.id), e.row.id);
  const counts = await list.counts();
  const lv = await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM locked_votes WHERE election_id = ?', [e.row.id]);
  const reissues = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM public_log WHERE election_id = ? AND kind = 'reissue'", [e.row.id]);
  const rejected = await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM rejected_uses WHERE election_id = ?', [e.row.id]);
  return c.json({ ...counts, reissued: reissues!.n, rejectedUses: rejected!.n, lockedVotes: lv!.n });
});

pub.get('/e/:id/log', async (c) => {
  const { db } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  const rows = await db.all<{ seq: number; at: string; kind: string; detail: string }>(
    'SELECT seq, at, kind, detail FROM public_log WHERE election_id = ? ORDER BY seq',
    [e.row.id],
  );
  return c.json({ log: rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) })) });
});

/** After certification: results, the teller report, the close, and everything needed to recount online votes. */
pub.get('/e/:id/results', async (c) => {
  const { db } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  if (e.row.status !== 'certified' && e.row.status !== 'purged') fail(409, 'Results are published when the tellers certify them.');
  return c.json({
    results: JSON.parse(e.row.results_json ?? 'null'),
    report: JSON.parse(e.row.report_json ?? 'null'),
    close: { statement: JSON.parse(e.row.close_json ?? 'null'), signature: e.row.close_signature, fallback: !!e.row.close_fallback },
    issuerPublicKey: e.row.issuer_public_key,
    countKeyPrivate: e.row.count_key_private,
    lockedVotes: e.row.status === 'certified' ? await lockedVotes(db, e.row.id) : null,
  });
});

// ---- online voting --------------------------------------------------------------------------------------------

function votingOpen(e: Election, now: Date) {
  if (!e.rules.channels.online) fail(409, 'This election has no online voting.');
  if (e.row.status !== 'open') fail(409, e.row.status === 'setup' ? 'Voting has not opened yet.' : 'Voting has closed.');
  if (now < new Date(e.rules.dates.voting_opens)) fail(409, 'Voting has not opened yet.');
  if (now >= new Date(e.rules.dates.voting_closes)) fail(409, 'Online voting has closed.');
}

/** Always the same answer, so this can't be used to find out who is on the roll. */
pub.post('/e/:id/online/request-link', async (c) => {
  const { db, now, mailer, config } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  votingOpen(e, now());
  const b = await body<{ email?: string }>(c);
  const email = str(b.email, 'email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 200).toLowerCase();
  const answer = { ok: true, message: 'If that address is on the roll for online voting, a link is on its way. It works once.' };
  const v = await db.first<{ member_id: string; used: string | null; link_window_start: string | null; link_window_count: number }>(
    'SELECT member_id, used, link_window_start, link_window_count FROM voters WHERE election_id = ? AND email = ?',
    [e.row.id, email],
  );
  if (!v || v.used) return c.json(answer);
  const hourAgo = new Date(now().getTime() - 3600_000).toISOString();
  const fresh = !v.link_window_start || v.link_window_start < hourAgo;
  if (!fresh && v.link_window_count >= LINKS_PER_HOUR) return c.json(answer);
  const token = randomToken();
  const expires = new Date(Math.min(now().getTime() + LINK_HOURS * 3600_000, Date.parse(e.rules.dates.voting_closes))).toISOString();
  await db.batch([
    {
      sql: 'UPDATE voters SET link_window_start = ?, link_window_count = ? WHERE election_id = ? AND member_id = ?',
      params: [fresh ? now().toISOString() : v.link_window_start, fresh ? 1 : v.link_window_count + 1, e.row.id, v.member_id],
    },
    { sql: 'DELETE FROM voter_links WHERE election_id = ? AND expires_at <= ?', params: [e.row.id, now().toISOString()] },
    {
      sql: 'INSERT INTO voter_links (token_hash, election_id, member_id, expires_at) VALUES (?, ?, ?, ?)',
      params: [tokenHash(token), e.row.id, v.member_id, expires],
    },
  ]);
  const link = `${config.votingPageUrl}#s=${encodeURIComponent(config.publicOrigin)}&e=${encodeURIComponent(e.row.id)}&t=${token}`;
  await mailer.send({
    to: email,
    subject: `Your voting link: ${e.rules.election.title}`,
    text:
      `${e.rules.election.organisation}: ${e.rules.election.title}\n\n` +
      `Open this link, then type the code printed on your ballot:\n\n${link}\n\n` +
      `The link expires ${expires.slice(0, 16).replace('T', ' ')} UTC, or as soon as you have voted.\n` +
      `Before you vote, check that the count key fingerprint on the page matches the one printed on your ballot.\n\n` +
      `${e.rules.notice_wording.report_misuse}\n\nIf you didn't ask for this link, you can ignore this email.`,
  });
  return c.json(answer);
});

async function voterForToken(c: C, e: Election, token: string) {
  const { db, now } = deps(c);
  const v = await db.first<{ member_id: string; used: string | null; expires_at: string }>(
    `SELECT v.member_id, v.used, l.expires_at FROM voter_links l
     JOIN voters v ON v.election_id = l.election_id AND v.member_id = l.member_id
     WHERE l.election_id = ? AND l.token_hash = ?`,
    [e.row.id, tokenHash(token)],
  );
  if (!v || v.used) fail(410, 'This voting link has already been used: you have voted online.');
  if (v.expires_at <= now().toISOString()) fail(410, 'This voting link has expired. Ask for a new one.');
  return v;
}

/** Which ballot this code is for, without using it. */
pub.post('/e/:id/online/check', async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  votingOpen(e, now());
  const b = await body<{ token?: string; codeHash?: string }>(c);
  await voterForToken(c, e, str(b.token, 'link'));
  const row = await new SqlSpendStore(db, e.row.id).get(str(b.codeHash, 'code', HEX64));
  if (!row || row.state !== 'issued') fail(409, 'That code can’t be used: it was mistyped, already used, or replaced by a newer ballot.');
  const style = describeStyle(e.rules, row.styleId);
  if (style.provisional) fail(409, 'Provisional ballots can only be returned on paper, in their envelope.');
  return c.json({ style });
});

/**
 * Cast an online vote. In one transaction: use up the link (one per member), spend the code, and store the locked
 * choice with no code, no member and no time. The nonce that ties the three steps together is cleared before the
 * transaction ends, so nothing links them afterwards.
 */
pub.post('/e/:id/online/vote', async (c) => {
  const { db, now } = deps(c);
  const e = await getElection(db, c.req.param('id'));
  votingOpen(e, now());
  const b = await body<{ token?: string; codeHash?: string; styleId?: string; sealed?: string }>(c);
  const token = str(b.token, 'link');
  const hash = str(b.codeHash, 'code', HEX64);
  const styleId = str(b.styleId, 'style', STYLE);
  const sealed = str(b.sealed, 'locked vote', /^[A-Za-z0-9+/]+=*$/, Math.ceil((MAX_SEALED_BYTES * 4) / 3) + 4);
  await voterForToken(c, e, token);
  if (styleId.endsWith('_prov')) fail(409, 'Provisional ballots can only be returned on paper.');
  const nonce = randomToken(16);
  const voteId = randomToken(16);
  const at = now().toISOString();
  const th = tokenHash(token);
  const res = await db.batch([
    {
      sql: `UPDATE voters SET used = ? WHERE election_id = ? AND used IS NULL
            AND member_id = (SELECT member_id FROM voter_links WHERE election_id = ? AND token_hash = ? AND expires_at > ?)
            AND EXISTS (SELECT 1 FROM codes WHERE election_id = ? AND hash = ? AND state = 'issued' AND style_id = ?)`,
      params: [nonce, e.row.id, e.row.id, th, at, e.row.id, hash, styleId],
    },
    {
      sql: `UPDATE codes SET state = 'spent', channel = 'online', at = ?, spend_nonce = ?
            WHERE election_id = ? AND hash = ? AND state = 'issued'
            AND EXISTS (SELECT 1 FROM voters WHERE election_id = ? AND used = ?)`,
      params: [at, nonce, e.row.id, hash, e.row.id, nonce],
    },
    {
      sql: `INSERT INTO locked_votes (election_id, id, sealed)
            SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM codes WHERE election_id = ? AND spend_nonce = ?)`,
      params: [e.row.id, voteId, sealed, e.row.id, nonce],
    },
    { sql: 'UPDATE codes SET spend_nonce = NULL WHERE election_id = ? AND spend_nonce = ?', params: [e.row.id, nonce] },
    {
      sql: 'DELETE FROM voter_links WHERE election_id = ? AND member_id = (SELECT member_id FROM voters WHERE election_id = ? AND used = ?)',
      params: [e.row.id, e.row.id, nonce],
    },
    { sql: "UPDATE voters SET used = 'used' WHERE election_id = ? AND used = ?", params: [e.row.id, nonce] },
  ]);
  if (res[2]!.changes === 1) return c.json({ ok: true, message: 'Your vote is locked and stored. Thank you for voting.' });
  // Nothing was stored. Log why, for the tellers, without spending anything.
  const store = new SqlSpendStore(db, e.row.id);
  const row = await store.get(hash);
  const reason = !row ? 'unknown' : row.state === 'revoked' ? 'revoked' : row.state === 'spent' ? 'already_spent' : row.styleId !== styleId ? 'wrong_style' : null;
  if (reason) await store.logRejected({ at, channel: 'online', reason, hashPrefix: hash.slice(0, 8) });
  fail(409, 'That code can’t be used: it was mistyped, already used, or replaced by a newer ballot. Nothing was recorded.');
});

