// The storage the app needs, implemented by Cloudflare D1 (Workers) and node:sqlite (Docker). Both are SQLite, so
// the SQL is the same; only how a transaction is started differs.
export type Param = string | number | null;

export interface Stmt {
  sql: string;
  params?: Param[];
}

export interface Db {
  all<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T | null>;
  run(sql: string, params?: Param[]): Promise<{ changes: number }>;
  /** Run the statements as one transaction: all of them or none. Returns rows changed by each. */
  batch(stmts: Stmt[]): Promise<{ changes: number }[]>;
}

/** Files: ballot images and exports. R2 on Workers, a directory on Docker. */
export interface BlobStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ data: Uint8Array; contentType: string } | null>;
  /** Delete every object whose key starts with prefix; returns how many. */
  deletePrefix(prefix: string): Promise<number>;
}

/** Split a migration file into statements (no semicolons inside strings in our migrations). */
export function splitSql(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}
