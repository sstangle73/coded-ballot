// What every route needs: storage, mail, settings, a clock and randomness. Each target (Workers, Node) builds one.
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { sha256Hex, toBase64 } from '@coded-ballot/core';
import type { BlobStore, Db } from './db/types.ts';
import type { Mailer } from './mail/types.ts';

export interface Config {
  /** This server's own origin, e.g. https://ballot.example.org (no trailing slash). */
  publicOrigin: string;
  /** WebAuthn relying party ID: the server's host name. */
  rpId: string;
  rpName: string;
  /** Other origins allowed to call the public and voting APIs: the project's own voting page and checker. */
  projectOrigins: string[];
  /** Where emailed voting links point: this server's /vote/ page, or the project's copy. */
  votingPageUrl: string;
  /** Lets the first person set up the server. Unset it once staff exist. */
  setupToken?: string;
  /** Show the dev outbox at /api/dev/outbox (MemoryMailer only). Never in production. */
  devOutbox?: boolean;
}

export interface Deps {
  db: Db;
  blobs: BlobStore;
  mailer: Mailer;
  config: Config;
  now: () => Date;
}

export type Role = 'issuer' | 'teller';

export interface Staff {
  id: string;
  name: string;
  email: string;
  roles: Role[];
}

export type Env = { Variables: { deps: Deps; staff?: Staff; bearer?: boolean } };
export type C = Context<Env>;

export function deps(c: C): Deps {
  return c.get('deps');
}

/** A refusal with a plain message the pages show as-is. */
export function fail(status: 400 | 401 | 403 | 404 | 409 | 410 | 429, message: string): never {
  throw new HTTPException(status, { message });
}

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function tokenHash(token: string): string {
  return sha256Hex('coded-ballot/v1/token\u0000' + token);
}

export async function body<T>(c: C): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    fail(400, 'The request was not valid JSON.');
  }
}

export function str(v: unknown, name: string, re?: RegExp, max = 2000): string {
  if (typeof v !== 'string' || !v || v.length > max || (re && !re.test(v))) fail(400, `Missing or invalid ${name}.`);
  return v;
}

export const HEX64 = /^[0-9a-f]{64}$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const STYLE = /^[a-z0-9][a-z0-9-]{0,39}(?:_w\d+(?:\.\d{1,4})?)?(?:_lp)?(?:_prov)?$/;
export const ELECTION = /^[a-z0-9][a-z0-9-]{0,39}$/;
