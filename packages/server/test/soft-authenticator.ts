// A software passkey for tests: ES256, "none" attestation, user verified. It produces the same JSON a browser's
// navigator.credentials returns, so the server's real WebAuthn checks run unchanged.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

function b64url(b: Uint8Array | Buffer): string {
  return Buffer.from(b).toString('base64url');
}

// Minimal CBOR encoder: unsigned/negative ints, byte strings, text strings, maps.
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) {
    const parts = [head(5, v.size)];
    for (const [k, x] of v) parts.push(cbor(k), cbor(x));
    return Buffer.concat(parts);
  }
  throw new Error('cbor: unsupported value');
}

export class SoftAuthenticator {
  readonly credId = randomBytes(16);
  private readonly key: KeyObject;
  private readonly pub: { x: Buffer; y: Buffer };
  private counter = 0;
  private userHandle = '';

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.pub = { x: Buffer.from(jwk.x!, 'base64url'), y: Buffer.from(jwk.y!, 'base64url') };
  }

  private clientData(type: string, challenge: string, origin: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  register(options: { challenge: string; rp: { id: string }; user: { id: string } }, origin: string) {
    this.userHandle = options.user.id;
    const cose = new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, this.pub.x],
      [-3, this.pub.y],
    ]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([
      createHash('sha256').update(options.rp.id).digest(),
      Buffer.from([0x45]), // user present, user verified, attested credential data
      Buffer.alloc(4),
      Buffer.alloc(16), // aaguid
      len,
      this.credId,
      cbor(cose),
    ]);
    const att = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: b64url(this.credId),
      rawId: b64url(this.credId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge, origin)),
        attestationObject: b64url(att),
        transports: ['internal'],
      },
    };
  }

  login(options: { challenge: string; rpId: string }, origin: string) {
    this.counter++;
    const c = Buffer.alloc(4);
    c.writeUInt32BE(this.counter);
    const authData = Buffer.concat([createHash('sha256').update(options.rpId).digest(), Buffer.from([0x05]), c]);
    const cd = this.clientData('webauthn.get', options.challenge, origin);
    const sig = sign('sha256', Buffer.concat([authData, createHash('sha256').update(cd).digest()]), { key: this.key, dsaEncoding: 'der' });
    return {
      id: b64url(this.credId),
      rawId: b64url(this.credId),
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: b64url(cd), authenticatorData: b64url(authData), signature: b64url(sig), userHandle: this.userHandle },
    };
  }
}
