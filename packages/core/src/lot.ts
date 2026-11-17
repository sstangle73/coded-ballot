// Ties by lot, drawn from public randomness nobody controls: the first drand round published after close. Anyone
// can repeat a draw with the round's randomness and this file: each tied name gets the key
//   HMAC-SHA256(randomness, "coded-ballot/v1/lot" ‖ label ‖ name)
// and names are taken in ascending order of key.
import { bytesToHex, hexToBytes, hmacSha256, lengthPrefixed, sha256Hex } from './bytes.ts';

export interface LotSource {
  /** drand round number. */
  round: number;
  /** The round's randomness, hex (SHA-256 of its signature). */
  randomness: string;
}

export interface LotDraw {
  round: number;
  label: string;
  items: string[];
  keys: Record<string, string>;
  order: string[];
}

/** drand quicknet: the chain tlock uses. Checked against api.drand.sh and drand.cloudflare.com on 2026-11-16. */
export const DRAND_QUICKNET = {
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  genesisTime: 1692803367,
  period: 3,
  relays: ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh', 'https://drand.cloudflare.com'],
} as const;

export interface ChainTiming {
  genesisTime: number;
  period: number;
}

/** When round r is published (Unix seconds). Round 1 is at genesis. */
export function roundTime(round: number, chain: ChainTiming = DRAND_QUICKNET): number {
  return chain.genesisTime + (round - 1) * chain.period;
}

/** The last round published at or before time t (Unix seconds). */
export function roundAt(t: number, chain: ChainTiming = DRAND_QUICKNET): number {
  if (t < chain.genesisTime) throw new RangeError('before the chain started');
  return Math.floor((t - chain.genesisTime) / chain.period) + 1;
}

/** The first round published strictly after time t: the round used for ties. */
export function firstRoundAfter(t: number, chain: ChainTiming = DRAND_QUICKNET): number {
  return roundAt(t, chain) + 1;
}

/** drand randomness is the SHA-256 of the round's signature. (The BLS signature itself is checked by drand-client.) */
export function randomnessMatchesSignature(randomnessHex: string, signatureHex: string): boolean {
  return sha256Hex(hexToBytes(signatureHex)) === randomnessHex.toLowerCase();
}

export function drawLot(src: LotSource, label: string, items: string[]): LotDraw {
  if (!/^[0-9a-f]{64}$/i.test(src.randomness)) throw new Error('randomness must be 32 bytes of hex');
  const key = hexToBytes(src.randomness.toLowerCase());
  const keys: Record<string, string> = {};
  for (const it of items) keys[it] = bytesToHex(hmacSha256(key, lengthPrefixed('coded-ballot/v1/lot', label, it)));
  const order = [...items].sort((a, b) => (keys[a]! < keys[b]! ? -1 : keys[a]! > keys[b]! ? 1 : 0));
  return { round: src.round, label, items: [...items], keys, order };
}
