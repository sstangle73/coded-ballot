// The signed close: the issuer key's last act. The signing key (from the same passphrase as the codes) signs the
// close time and the SHA-256 of the full list of locked online votes. The tellers' app checks the list it downloads
// against this before unlocking anything, so a vote added after close shows up as a mismatch.
//
// If every copy of the passphrase is lost, the tellers record a fallback close instead. It carries no issuer
// signature and is marked as a fallback everywhere it appears.
import { canonicalJson, concatBytes, fromBase64, lengthPrefixed, sha256Hex, toBase64, utf8ToBytes } from './bytes.ts';
import { sodium } from './sodium.ts';
import type { IssuerKeys } from './codes.ts';

export interface CloseStatement {
  type: 'coded-ballot/close';
  version: 1;
  electionId: string;
  closedAt: string;
  lockedVotes: { count: number; sha256: string };
  fallback: boolean;
}

export interface SignedClose {
  statement: CloseStatement;
  /** Base64 Ed25519 signature over the canonical JSON of the statement; null for a fallback close. */
  signature: string | null;
}

/**
 * Fingerprint of the locked-vote list, in the order the server publishes it. Each entry is the base64 text of one
 * locked vote; the digest covers their bytes, length-prefixed, so entries can't be merged or split.
 */
export function lockedVotesDigest(lockedVotes: string[]): { count: number; sha256: string } {
  const parts = lockedVotes.map((v) => lengthPrefixed(fromBase64(v)));
  return { count: lockedVotes.length, sha256: sha256Hex(concatBytes(lengthPrefixed('coded-ballot/v1/locked-votes'), ...parts)) };
}

export function closeStatement(electionId: string, closedAt: Date, lockedVotes: string[], fallback = false): CloseStatement {
  return {
    type: 'coded-ballot/close',
    version: 1,
    electionId,
    closedAt: closedAt.toISOString(),
    lockedVotes: lockedVotesDigest(lockedVotes),
    fallback,
  };
}

function signedBytes(s: CloseStatement): Uint8Array {
  return utf8ToBytes(canonicalJson(s));
}

export async function signClose(keys: IssuerKeys, statement: CloseStatement): Promise<SignedClose> {
  if (statement.fallback) throw new Error('a fallback close is not signed with the issuer key');
  if (statement.electionId !== keys.electionId) throw new Error('statement is for a different election');
  const s = await sodium();
  return { statement, signature: toBase64(s.crypto_sign_detached(signedBytes(statement), keys.signSecretKey)) };
}

export type CloseCheck =
  | { ok: true; fallback: false }
  | { ok: true; fallback: true }
  | { ok: false; reason: string };

/**
 * Check a close against the issuer's published signing key and, when given, the locked votes actually downloaded.
 */
export async function verifyClose(
  signed: SignedClose,
  issuerPublicKey: Uint8Array,
  downloadedLockedVotes?: string[],
): Promise<CloseCheck> {
  const st = signed.statement;
  if (st.type !== 'coded-ballot/close' || st.version !== 1) return { ok: false, reason: 'not a close statement' };
  if (downloadedLockedVotes) {
    const d = lockedVotesDigest(downloadedLockedVotes);
    if (d.count !== st.lockedVotes.count || d.sha256 !== st.lockedVotes.sha256) {
      return {
        ok: false,
        reason: `the locked votes don't match the close: ${d.count} downloaded, ${st.lockedVotes.count} at close, or their fingerprint differs`,
      };
    }
  }
  if (st.fallback) {
    return signed.signature === null ? { ok: true, fallback: true } : { ok: false, reason: 'a fallback close must not carry a signature' };
  }
  if (!signed.signature) return { ok: false, reason: 'no signature' };
  const s = await sodium();
  let good = false;
  try {
    good = s.crypto_sign_verify_detached(fromBase64(signed.signature), signedBytes(st), issuerPublicKey);
  } catch {
    good = false;
  }
  return good ? { ok: true, fallback: false } : { ok: false, reason: 'the signature is not the issuer key’s' };
}
