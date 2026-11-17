import type { Db, Param, Stmt, BlobStore } from './types.ts';

export class D1Db implements Db {
  private readonly d1: D1Database;
  constructor(d1: D1Database) {
    this.d1 = d1;
  }
  private prep(sql: string, params: Param[] = []) {
    return this.d1.prepare(sql).bind(...params);
  }
  async all<T>(sql: string, params?: Param[]): Promise<T[]> {
    return (await this.prep(sql, params).all<T>()).results;
  }
  async first<T>(sql: string, params?: Param[]): Promise<T | null> {
    return (await this.prep(sql, params).first<T>()) ?? null;
  }
  async run(sql: string, params?: Param[]) {
    return { changes: (await this.prep(sql, params).run()).meta.changes };
  }
  async batch(stmts: Stmt[]) {
    // D1 runs a batch as one transaction: if any statement fails, none take effect.
    const res = await this.d1.batch(stmts.map((s) => this.prep(s.sql, s.params)));
    return res.map((r) => ({ changes: r.meta.changes }));
  }
}

export class R2Blobs implements BlobStore {
  private readonly r2: R2Bucket;
  constructor(r2: R2Bucket) {
    this.r2 = r2;
  }
  async put(key: string, data: Uint8Array, contentType: string) {
    await this.r2.put(key, data, { httpMetadata: { contentType } });
  }
  async get(key: string) {
    const o = await this.r2.get(key);
    if (!o) return null;
    return { data: new Uint8Array(await o.arrayBuffer()), contentType: o.httpMetadata?.contentType ?? 'application/octet-stream' };
  }
  async deletePrefix(prefix: string) {
    let n = 0;
    let cursor: string | undefined;
    do {
      const page = await this.r2.list({ prefix, cursor });
      if (page.objects.length) await this.r2.delete(page.objects.map((o) => o.key));
      n += page.objects.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return n;
  }
}
