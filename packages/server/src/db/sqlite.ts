// node:sqlite (built into Node 22.13+), so the Docker image needs no native modules.
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { splitSql, type BlobStore, type Db, type Param, type Stmt } from './types.ts';

export class SqliteDb implements Db {
  readonly raw: DatabaseSync;
  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }
  async all<T>(sql: string, params: Param[] = []): Promise<T[]> {
    return this.raw.prepare(sql).all(...params) as T[];
  }
  async first<T>(sql: string, params: Param[] = []): Promise<T | null> {
    return (this.raw.prepare(sql).get(...params) as T | undefined) ?? null;
  }
  async run(sql: string, params: Param[] = []) {
    return { changes: Number(this.raw.prepare(sql).run(...params).changes) };
  }
  async batch(stmts: Stmt[]) {
    // Synchronous from BEGIN to COMMIT, so no other request can interleave.
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = stmts.map((s) => ({ changes: Number(this.raw.prepare(s.sql).run(...(s.params ?? [])).changes) }));
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }
  /** Apply migrations/*.sql not yet applied, in name order. */
  async migrate(dir: string): Promise<string[]> {
    this.raw.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const done = new Set((await this.all<{ name: string }>('SELECT name FROM _migrations')).map((r) => r.name));
    const applied: string[] = [];
    for (const f of (await readdir(dir)).filter((x) => x.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      const stmts = splitSql(await readFile(join(dir, f), 'utf8')).map((sql) => ({ sql }));
      stmts.push({ sql: 'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)', params: [f, new Date().toISOString()] } as Stmt);
      await this.batch(stmts);
      applied.push(f);
    }
    return applied;
  }
}

export class DiskBlobs implements BlobStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string) {
    if (!/^[A-Za-z0-9/_.-]+$/.test(key) || key.includes('..')) throw new Error('bad blob key');
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('bad blob key');
    return p;
  }
  async put(key: string, data: Uint8Array, contentType: string) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
    await writeFile(p + '.type', contentType);
  }
  async get(key: string) {
    try {
      const p = this.path(key);
      return { data: new Uint8Array(await readFile(p)), contentType: await readFile(p + '.type', 'utf8') };
    } catch {
      return null;
    }
  }
  async deletePrefix(prefix: string) {
    const dir = this.path(prefix.replace(/\/$/, ''));
    let n = 0;
    try {
      n = (await readdir(dir, { recursive: true })).filter((f) => !String(f).endsWith('.type')).length;
    } catch {
      return 0;
    }
    await rm(dir, { recursive: true, force: true });
    return n;
  }
}
