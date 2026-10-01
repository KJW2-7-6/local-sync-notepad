import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, X509Certificate } from 'node:crypto';
import { hostname, platform } from 'node:os';
import selfsigned from 'selfsigned';

export interface Identity { id: string; name: string; os: string; publicKey: string; privateKey: string }
export function makeIdentity(): Identity {
  const keys = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { id: randomBytes(16).toString('hex'), name: hostname().slice(0, 60), os: platform(), ...keys };
}
export function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function fingerprint(cert: string | Buffer): string { return new X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase(); }
export function makeCertificate(): { cert: string; key: string; fingerprint: string } {
  const pem = selfsigned.generate([{ name: 'commonName', value: 'Local Sync Notepad' }], {
    keySize: 2048, days: 3650, algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true }, { name: 'extKeyUsage', serverAuth: true }],
  });
  return { cert: pem.cert, key: pem.private, fingerprint: fingerprint(pem.cert) };
}
export function roomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const s = Array.from(randomBytes(6), b => alphabet[b % alphabet.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
export function normalizeCode(code: string): string { return code.toUpperCase().replace(/[^A-Z0-9]/g, ''); }
export function proofPayload(nonce: string, roomId: string, id: string, publicKey: string): string {
  return JSON.stringify(['localsync-v1', nonce, roomId, id, publicKey]);
}
export function prove(identity: Identity, nonce: string, roomId: string): string {
  return sign(null, Buffer.from(proofPayload(nonce, roomId, identity.id, identity.publicKey)), identity.privateKey).toString('base64');
}
export function checkProof(publicKey: string, id: string, nonce: string, roomId: string, signature: string): boolean {
  try {
    const key = createPublicKey(publicKey);
    return key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(proofPayload(nonce, roomId, id, publicKey)), key, Buffer.from(signature, 'base64'));
  } catch { return false; }
}
export function safetyCode(nonce: string, publicKey: string, fp: string): string {
  return String(parseInt(digest(`${nonce}|${publicKey}|${fp}`).slice(0, 8), 16) % 1000000).padStart(6, '0');
}
