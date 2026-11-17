// Shared reads and writes: elections, the public log, and the spend list over SQL.
import { loadRules, type Rules, type Channel, type CodeRow, type RejectedUse, type SpendStore } from '@coded-ballot/core';
import type { Db, Stmt } from './db/types.ts';
import { fail } from './context.ts';

export type Status = 'setup' | 'open' | 'closed' | 'certified' | 'purged';

export interface ElectionRow {
  id: string;
  rules_yaml: string;
  rules_sha256: string;
  status: Status;
  issuer_public_key: string | null;
  passphrase_backup_confirmed: number;
  count_key_public: string | null;
  count_key_confirmed: number;
  roll_sha256: string | null;
  roll_frozen_at: string | null;
  close_json: string | null;
  close_signature: string | null;
  close_fallback: number;
  results_json: string | null;
  report_json: string | null;
  count_key_private: string | null;
  certified_at: string | null;
  purged_at: string | null;
  cloned_from: string | null;
  created_at: string;
}

export interface Election {
  row: ElectionRow;
  rules: Rules;
}

export async function getElection(db: Db, id: string): Promise<Election> {
  const row = await db.first<ElectionRow>('SELECT * FROM elections WHERE id = ?', [id]);
  if (!row) fail(404, 'No election with that ID.');
  return { row, rules: loadRules(row.rules_yaml).rules };
}

export function requireStatus(e: Election, ...ok: Status[]) {
  if (!ok.includes(e.row.status)) fail(409, `Not allowed while the election is ${e.row.status}.`);
}

/** A statement that appends to the public log, numbered per election, safe inside a batch. */
export function logStmt(electionId: string, at: Date, kind: string, detail: Record<string, unknown> = {}): Stmt {
  return {
    sql: `INSERT INTO public_log (election_id, seq, at, kind, detail)
          SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ? FROM public_log WHERE election_id = ?`,
    params: [electionId, at.toISOString(), kind, JSON.stringify(detail), electionId],
  };
}

export async function log(db: Db, electionId: string, at: Date, kind: string, detail: Record<string, unknown> = {}) {
  const s = logStmt(electionId, at, kind, detail);
  await db.run(s.sql, s.params);
}

/** The spend list (packages/core) over the codes table. transition() is the compare-and-set. */
export class SqlSpendStore implements SpendStore {
  private readonly db: Db;
  private readonly electionId: string;
  constructor(db: Db, electionId: string) {
    this.db = db;
    this.electionId = electionId;
  }
  async insert(rows: { hash: string; styleId: string }[]) {
    const stmts: Stmt[] = rows.map((r) => ({
      sql: 'INSERT INTO codes (election_id, hash, style_id) VALUES (?, ?, ?)',
      params: [this.electionId, r.hash, r.styleId],
    }));
    for (let i = 0; i < stmts.length; i += 500) await this.db.batch(stmts.slice(i, i + 500));
  }
  async get(hash: string): Promise<CodeRow | null> {
    const r = await this.db.first<{ hash: string; style_id: string; state: CodeRow['state']; channel: Channel | null; at: string | null }>(
      'SELECT hash, style_id, state, channel, at FROM codes WHERE election_id = ? AND hash = ?',
      [this.electionId, hash],
    );
    return r ? { hash: r.hash, styleId: r.style_id, state: r.state, channel: r.channel, at: r.at } : null;
  }
  async transition(hash: string, to: 'spent' | 'revoked', channel: Channel | null, at: string) {
    const r = await this.db.run(
      "UPDATE codes SET state = ?, channel = ?, at = ? WHERE election_id = ? AND hash = ? AND state = 'issued'",
      [to, channel, at, this.electionId, hash],
    );
    return r.changes === 1;
  }
  async logRejected(r: RejectedUse) {
    await this.db.run('INSERT INTO rejected_uses (election_id, at, channel, reason, hash_prefix) VALUES (?, ?, ?, ?, ?)', [
      this.electionId,
      r.at,
      r.channel,
      r.reason,
      r.hashPrefix,
    ]);
  }
  async rejected(): Promise<RejectedUse[]> {
    const rows = await this.db.all<{ at: string; channel: Channel; reason: RejectedUse['reason']; hash_prefix: string }>(
      'SELECT at, channel, reason, hash_prefix FROM rejected_uses WHERE election_id = ? ORDER BY at',
      [this.electionId],
    );
    return rows.map((r) => ({ at: r.at, channel: r.channel, reason: r.reason, hashPrefix: r.hash_prefix }));
  }
  async all(): Promise<CodeRow[]> {
    const rows = await this.db.all<{ hash: string; style_id: string; state: CodeRow['state']; channel: Channel | null; at: string | null }>(
      'SELECT hash, style_id, state, channel, at FROM codes WHERE election_id = ?',
      [this.electionId],
    );
    return rows.map((r) => ({ hash: r.hash, styleId: r.style_id, state: r.state, channel: r.channel, at: r.at }));
  }
}

export async function lockedVotes(db: Db, electionId: string): Promise<string[]> {
  return (await db.all<{ sealed: string }>('SELECT sealed FROM locked_votes WHERE election_id = ? ORDER BY id', [electionId])).map(
    (r) => r.sealed,
  );
}
