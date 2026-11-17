// The spend list: one row per issued code, keyed by codeHash(S). A code moves issued -> spent(channel, time) or
// issued -> revoked, and never back. Spending is a compare-and-set
//
//   UPDATE codes SET state = 'spent', channel = ?, at = ? WHERE hash = ? AND state = 'issued'
//
// so two channels racing for the same code can't both win. First use wins; every later use is rejected and logged
// for the tellers. Votes are stored elsewhere with no code, which is why a vote can't be changed once cast.
import { codeHash } from './codes.ts';

export type Channel = 'mail' | 'online' | 'in_person';
export const CHANNELS: readonly Channel[] = ['mail', 'online', 'in_person'];

export type CodeState = 'issued' | 'spent' | 'revoked';

export interface CodeRow {
  hash: string;
  styleId: string;
  state: CodeState;
  channel: Channel | null;
  at: string | null;
}

export type RejectReason = 'unknown' | 'already_spent' | 'revoked' | 'wrong_style';

export interface RejectedUse {
  at: string;
  channel: Channel;
  reason: RejectReason;
  /** First 8 hex characters of the hash: enough for tellers to match reports, not enough to look a code up. */
  hashPrefix: string;
}

/** The storage a server provides (D1, SQLite, or memory in tests). transition() must be atomic. */
export interface SpendStore {
  insert(rows: { hash: string; styleId: string }[]): Promise<void>;
  get(hash: string): Promise<CodeRow | null>;
  /** Move a code out of 'issued'. True only if this call made the change. */
  transition(hash: string, to: 'spent' | 'revoked', channel: Channel | null, at: string): Promise<boolean>;
  logRejected(r: RejectedUse): Promise<void>;
  rejected(): Promise<RejectedUse[]>;
  all(): Promise<CodeRow[]>;
}

export type SpendResult =
  | { ok: true; styleId: string }
  | { ok: false; reason: RejectReason; spentBy?: Channel | null };

export type TrackerView =
  | { status: 'not_used' }
  | { status: 'received'; channel: 'mail' | 'in_person'; date: string }
  | { status: 'cast_online' }
  | { status: 'replaced' }
  | { status: 'unknown' };

export interface SpendCounts {
  issued: number;
  unused: number;
  revoked: number;
  spent: Record<Channel, number>;
}

export class SpendList {
  private readonly store: SpendStore;
  readonly electionId: string;

  constructor(store: SpendStore, electionId: string) {
    this.store = store;
    this.electionId = electionId;
  }

  hashOf(code: string): string {
    return codeHash(this.electionId, code);
  }

  /** Load the hashes the issuer uploads. Duplicates are refused by the store. */
  async issue(rows: { hash: string; styleId: string }[]): Promise<void> {
    await this.store.insert(rows);
  }

  /**
   * Use a code. `expectStyle` is the style read from the QR code (paper) or chosen on the voting page: a mismatch
   * means a doctored sheet and is refused without spending.
   */
  async spend(hash: string, channel: Channel, at: Date, expectStyle?: string): Promise<SpendResult> {
    const atIso = at.toISOString();
    const row = await this.store.get(hash);
    if (!row) return this.reject(hash, channel, atIso, 'unknown');
    if (expectStyle !== undefined && row.styleId !== expectStyle) return this.reject(hash, channel, atIso, 'wrong_style');
    if (row.state === 'issued' && (await this.store.transition(hash, 'spent', channel, atIso))) {
      return { ok: true, styleId: row.styleId };
    }
    const now = (await this.store.get(hash))!;
    return now.state === 'revoked'
      ? this.reject(hash, channel, atIso, 'revoked')
      : this.reject(hash, channel, atIso, 'already_spent', now.channel);
  }

  /** Revoke copy n before issuing copy n + 1. Refused if the code was already used. */
  async revoke(hash: string, at: Date): Promise<{ ok: true } | { ok: false; reason: 'unknown' | 'already_spent' | 'revoked' }> {
    const row = await this.store.get(hash);
    if (!row) return { ok: false, reason: 'unknown' };
    if (await this.store.transition(hash, 'revoked', null, at.toISOString())) return { ok: true };
    const now = (await this.store.get(hash))!;
    return { ok: false, reason: now.state === 'revoked' ? 'revoked' : 'already_spent' };
  }

  /** What the public tracker shows for a code. Online uses show no date. */
  async track(hash: string): Promise<TrackerView> {
    const row = await this.store.get(hash);
    if (!row) return { status: 'unknown' };
    if (row.state === 'issued') return { status: 'not_used' };
    if (row.state === 'revoked') return { status: 'replaced' };
    if (row.channel === 'online') return { status: 'cast_online' };
    return { status: 'received', channel: row.channel as 'mail' | 'in_person', date: row.at!.slice(0, 10) };
  }

  async counts(): Promise<SpendCounts> {
    const c: SpendCounts = { issued: 0, unused: 0, revoked: 0, spent: { mail: 0, online: 0, in_person: 0 } };
    for (const r of await this.store.all()) {
      c.issued++;
      if (r.state === 'issued') c.unused++;
      else if (r.state === 'revoked') c.revoked++;
      else c.spent[r.channel!]++;
    }
    return c;
  }

  async rejectedUses(): Promise<RejectedUse[]> {
    return this.store.rejected();
  }

  private async reject(
    hash: string,
    channel: Channel,
    at: string,
    reason: RejectReason,
    spentBy?: Channel | null,
  ): Promise<SpendResult> {
    await this.store.logRejected({ at, channel, reason, hashPrefix: hash.slice(0, 8) });
    return spentBy === undefined ? { ok: false, reason } : { ok: false, reason, spentBy };
  }
}

/** An in-memory store for tests and the local tools. JavaScript is single-threaded, so transition() is atomic. */
export class MemorySpendStore implements SpendStore {
  private rows = new Map<string, CodeRow>();
  private log: RejectedUse[] = [];

  async insert(rows: { hash: string; styleId: string }[]): Promise<void> {
    for (const r of rows) if (this.rows.has(r.hash)) throw new Error(`hash ${r.hash.slice(0, 8)} already issued`);
    for (const r of rows) this.rows.set(r.hash, { hash: r.hash, styleId: r.styleId, state: 'issued', channel: null, at: null });
  }
  async get(hash: string): Promise<CodeRow | null> {
    const r = this.rows.get(hash);
    return r ? { ...r } : null;
  }
  async transition(hash: string, to: 'spent' | 'revoked', channel: Channel | null, at: string): Promise<boolean> {
    const r = this.rows.get(hash);
    if (!r || r.state !== 'issued') return false;
    r.state = to;
    r.channel = channel;
    r.at = at;
    return true;
  }
  async logRejected(r: RejectedUse): Promise<void> {
    this.log.push(r);
  }
  async rejected(): Promise<RejectedUse[]> {
    return [...this.log];
  }
  async all(): Promise<CodeRow[]> {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
}
