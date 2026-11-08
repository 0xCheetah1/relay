import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, sign, verify,
} from 'node:crypto';

export function createEncryptionKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    encryptionPublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    encryptionPrivateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

export function ensureEncryptionKeys(identity) {
  if (identity?.encryptionPublicKey && identity?.encryptionPrivateKey) return identity;
  return { ...identity, ...createEncryptionKeyPair() };
}

function publicKeyObject(value) {
  return typeof value === 'string' && value.includes('BEGIN')
    ? createPublicKey(value)
    : createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
}

function privateKeyObject(value) {
  return typeof value === 'string' && value.includes('BEGIN')
    ? createPrivateKey(value)
    : createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
}

export function deriveCallKey(encryptionPrivateKey, peerEncryptionPublicKey, callId) {
  const shared = diffieHellman({
    privateKey: privateKeyObject(encryptionPrivateKey),
    publicKey: publicKeyObject(peerEncryptionPublicKey),
  });
  return Buffer.from(hkdfSync('sha256', shared, Buffer.from(callId), Buffer.from('relay-call-v1'), 32));
}

export function encryptPayload(key, value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { n: nonce.toString('base64'), c: ciphertext.toString('base64'), t: cipher.getAuthTag().toString('base64') };
}

export function decryptPayload(key, payload) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.n, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.t, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.c, 'base64')), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

export function isEnvelope(value) {
  return Boolean(value && typeof value.n === 'string' && typeof value.c === 'string' && typeof value.t === 'string'
    && value.n.length <= 64 && value.c.length <= 16384 && value.t.length <= 64);
}

function envelopeData(callId, type, payload) {
  return `${callId}|${type}|${payload.n}|${payload.c}|${payload.t}`;
}

export function signEnvelope(privateKey, callId, type, payload) {
  return sign(null, Buffer.from(envelopeData(callId, type, payload)), privateKey).toString('base64');
}

export function verifyEnvelope(publicKey, callId, type, payload, signature) {
  try {
    return verify(null, Buffer.from(envelopeData(callId, type, payload)), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
