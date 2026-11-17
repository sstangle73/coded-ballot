// An online vote, from the voter's browser to the tellers' laptop.
//
//   payload  {v:1, styleId, selections}, JSON, length-prefixed and padded to a multiple of 512 bytes so its size
//            says nothing about what was chosen
//   sealed   libsodium sealed box to the count key (crypto_box_seal)
//   body     base64(sealed), or with the time-lock on, "tlock1:" + tlock-js's armored ciphertext of the sealed bytes
//   stored   "<styleId>:<body>": the server writes the style from the code's own row, never from the voter, and the
//            tellers check it matches the style inside the seal
import { fromBase64, toBase64, utf8ToBytes } from './bytes.ts';
import { sodium } from './sodium.ts';
import type { CastVoteRecord } from './count/index.ts';

export interface VotePayload {
  v: 1;
  styleId: string;
  selections: Record<string, string[]>;
}

const PAD = 512;
export const TLOCK_PREFIX = 'tlock1:';

export function encodeVote(p: VotePayload): Uint8Array {
  const json = utf8ToBytes(JSON.stringify(p));
  const total = Math.ceil((json.length + 4) / PAD) * PAD;
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, json.length, false);
  out.set(json, 4);
  return out;
}

export function decodeVote(b: Uint8Array): VotePayload {
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, false);
  if (n + 4 > b.length) throw new Error('not a vote');
  const p = JSON.parse(new TextDecoder().decode(b.subarray(4, 4 + n))) as VotePayload;
  if (p.v !== 1 || typeof p.styleId !== 'string' || typeof p.selections !== 'object' || !p.selections) throw new Error('not a vote');
  for (const v of Object.values(p.selections)) if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error('not a vote');
  return p;
}

/** Seal in the browser. Returns the bytes to send (time-lock them first if the election uses it). */
export async function sealVote(p: VotePayload, countKeyPublic: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  return s.crypto_box_seal(encodeVote(p), countKeyPublic);
}

export function sealedBody(sealed: Uint8Array): string {
  return toBase64(sealed);
}

export function parseLockedVote(stored: string): { styleId: string; body: string } {
  const i = stored.indexOf(':');
  if (i < 1) throw new Error('not a locked vote');
  return { styleId: stored.slice(0, i), body: stored.slice(i + 1) };
}

export type TlockDecrypt = (armored: string) => Promise<Uint8Array>;

/**
 * Unlock one stored vote on the tellers' laptop: remove the time-lock layer if there is one, open the seal with the
 * count key, and check the style. Returns a cast vote record (style and choices, no code).
 */
export async function unlockVote(
  stored: string,
  countKey: { publicKey: Uint8Array; privateKey: Uint8Array },
  tlockDecrypt?: TlockDecrypt,
): Promise<CastVoteRecord> {
  const { styleId, body } = parseLockedVote(stored);
  let sealed: Uint8Array;
  if (body.startsWith(TLOCK_PREFIX)) {
    if (!tlockDecrypt) throw new Error('This vote is time-locked: the drand round is needed to open it.');
    sealed = await tlockDecrypt(body.slice(TLOCK_PREFIX.length));
  } else sealed = fromBase64(body);
  const s = await sodium();
  let plain: Uint8Array;
  try {
    plain = s.crypto_box_seal_open(sealed, countKey.publicKey, countKey.privateKey);
  } catch {
    throw new Error('A locked vote could not be opened with this count key.');
  }
  const p = decodeVote(plain);
  if (p.styleId !== styleId) throw new Error(`A locked vote says style ${p.styleId} inside but ${styleId} outside.`);
  return { styleId, selections: p.selections };
}

/** Count key: made in a teller's browser. The private half is shown once, to print and copy. */
export async function newCountKey(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
  const s = await sodium();
  const kp = s.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export function countKeyToText(privateKey: Uint8Array): string {
  return toBase64(privateKey);
}
