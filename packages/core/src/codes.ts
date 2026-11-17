// Ballot codes. Each code is derived from the issuer's passphrase, so no member-to-code list is ever stored:
//
//   master  = Argon2id(passphrase, salt = H("coded-ballot/v1/argon2-salt", election))   (libsodium)
//   K_code  = HKDF-SHA256(master, info "coded-ballot/v1/code-key")
//   K_sign  = HKDF-SHA256(master, info "coded-ballot/v1/sign-key") -> Ed25519 seed      (libsodium)
//   S       = first 80 bits of HMAC-SHA256(K_code, "coded-ballot/v1/code" ‖ election ‖ member_id ‖ n)
//
// The passphrase is 12 BIP39 words the issuer tool generates (128 bits plus a checksum that catches typos), and
// Argon2id makes guessing it slow as well. The server only ever sees codeHash(S).
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { hmacSha256, lengthPrefixed, sha256Bytes, sha256Hex, u32be, utf8ToBytes, bytesToHex } from './bytes.ts';
import { sodiumSumo } from './sodium.ts';

export const CODE_BITS = 80;
export const CODE_CHARS = 16;
const CODE_BYTES = CODE_BITS / 8;

/** Argon2id cost, recorded with the election so a later release derives the same keys. */
export const ARGON2_PARAMS = { opslimit: 3, memlimitBytes: 64 * 1024 * 1024 } as const;

export interface IssuerKeys {
  electionId: string;
  codeKey: Uint8Array;
  signPublicKey: Uint8Array;
  signSecretKey: Uint8Array;
}

// ---- passphrase ----------------------------------------------------------------------------------------------

/** A fresh 12-word passphrase (128 bits of entropy from the platform's CSPRNG, plus a 4-bit checksum). */
export function generatePassphrase(): string {
  return generateMnemonic(wordlist, 128);
}

export function normalizePassphrase(p: string): string {
  return p.normalize('NFKD').toLowerCase().trim().split(/\s+/).join(' ');
}

/** True if the words are all on the list and the checksum matches: a mistyped word is caught here. */
export function isValidPassphrase(p: string): boolean {
  return validateMnemonic(normalizePassphrase(p), wordlist);
}

export async function deriveIssuerKeys(passphrase: string, electionId: string): Promise<IssuerKeys> {
  const norm = normalizePassphrase(passphrase);
  if (!validateMnemonic(norm, wordlist)) {
    throw new Error('That passphrase is not right: a word is misspelt, missing or out of order.');
  }
  const sodium = await sodiumSumo();
  const salt = sha256Bytes(lengthPrefixed('coded-ballot/v1/argon2-salt', electionId)).slice(0, sodium.crypto_pwhash_SALTBYTES);
  const master = sodium.crypto_pwhash(
    32,
    utf8ToBytes(norm),
    salt,
    ARGON2_PARAMS.opslimit,
    ARGON2_PARAMS.memlimitBytes,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  const codeKey = hkdf(sha256, master, undefined, utf8ToBytes('coded-ballot/v1/code-key'), 32);
  const signSeed = hkdf(sha256, master, undefined, utf8ToBytes('coded-ballot/v1/sign-key'), 32);
  const kp = sodium.crypto_sign_seed_keypair(signSeed);
  sodium.memzero(master);
  sodium.memzero(signSeed);
  return { electionId, codeKey, signPublicKey: kp.publicKey, signSecretKey: kp.privateKey };
}

// ---- codes ---------------------------------------------------------------------------------------------------

/** S for member m, copy n (n starts at 1; a reissue is n + 1). Returned as the 16-character code. */
export function deriveCode(keys: IssuerKeys, memberId: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('copy number starts at 1');
  const mac = hmacSha256(keys.codeKey, lengthPrefixed('coded-ballot/v1/code', keys.electionId, memberId, u32be(n)));
  return base32Encode(mac.slice(0, CODE_BYTES));
}

/** What the server stores: never the code itself. */
export function codeHash(electionId: string, code: string): string {
  return sha256Hex(lengthPrefixed('coded-ballot/v1/code-hash', electionId, code));
}

// ---- Crockford base32 with a Luhn mod 32 check character -----------------------------------------------------

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function base32Encode(b: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of b) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Luhn mod N over base 32: catches every single wrong character and most swaps of neighbours. */
export function checkChar(code: string): string {
  let factor = 2;
  let sum = 0;
  for (let i = code.length - 1; i >= 0; i--) {
    const v = ALPHABET.indexOf(code[i]!);
    if (v < 0) throw new Error(`not a code character: ${code[i]}`);
    let addend = factor * v;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / 32) + (addend % 32);
    sum += addend;
  }
  return ALPHABET[(32 - (sum % 32)) % 32]!;
}

/** "7KQ2M9XD4TPHB3RW" -> "7KQ2-M9XD-4TPH-B3RW-C" (the last group is the check character). */
export function formatCode(code: string): string {
  return code.match(/.{1,4}/g)!.join('-') + '-' + checkChar(code);
}

export type ParsedCode = { ok: true; code: string } | { ok: false; reason: 'length' | 'character' | 'check' };

/**
 * Read a typed code. Forgiving where Crockford base32 is: case, spaces and hyphens are ignored, O reads as 0 and
 * I or L as 1. The check character must match.
 */
export function parseTypedCode(input: string): ParsedCode {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== CODE_CHARS + 1) return { ok: false, reason: 'length' };
  for (const c of s) if (!ALPHABET.includes(c)) return { ok: false, reason: 'character' };
  const code = s.slice(0, CODE_CHARS);
  if (checkChar(code) !== s[CODE_CHARS]) return { ok: false, reason: 'check' };
  return { ok: true, code };
}

// ---- QR payload ----------------------------------------------------------------------------------------------

export interface QrPayload {
  electionId: string;
  styleId: string;
  code: string;
  page: number;
  pages: number;
}

/** "CB1|election|style|code|page/pages". Never the member's name or ID. */
export function encodeQr(p: QrPayload): string {
  for (const v of [p.electionId, p.styleId, p.code]) if (v.includes('|')) throw new Error('| not allowed');
  return `CB1|${p.electionId}|${p.styleId}|${p.code}|${p.page}/${p.pages}`;
}

export function decodeQr(s: string): QrPayload | null {
  const m = /^CB1\|([a-z0-9-]+)\|([a-z0-9_.-]+)\|([0-9A-Z]{16})\|(\d+)\/(\d+)$/.exec(s.trim());
  if (!m) return null;
  const page = Number(m[4]);
  const pages = Number(m[5]);
  if (page < 1 || page > pages) return null;
  return { electionId: m[1]!, styleId: m[2]!, code: m[3]!, page, pages };
}

/** Short, human-checkable fingerprint of a public key: "AB12 CD34 EF56 GH78" style, from SHA-256. */
export function fingerprint(publicKey: Uint8Array): string {
  return base32Encode(sha256(publicKey).slice(0, 10)).match(/.{4}/g)!.join(' ');
}

export function hex(b: Uint8Array): string {
  return bytesToHex(b);
}
