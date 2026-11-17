// libsodium, loaded once. The standard build covers sealed boxes and Ed25519; Argon2id (crypto_pwhash) is only in
// the sumo build, which only the issuer's key derivation needs. It is imported dynamically, so a voting page that
// bundles this package never loads it.
import _sodium from 'libsodium-wrappers';

export type Sodium = typeof _sodium;

export async function sodium(): Promise<Sodium> {
  await _sodium.ready;
  return _sodium;
}

export async function sodiumSumo() {
  const mod = await import('libsodium-wrappers-sumo');
  const s = mod.default;
  await s.ready;
  return s;
}
