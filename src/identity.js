import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { createEncryptionKeyPair } from './crypto.js';

export function createIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    id: `rly_${randomUUID()}`,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    ...createEncryptionKeyPair(),
  };
}

export function signChallenge(privateKey, challenge) {
  return sign(null, Buffer.from(`relay-auth-v1:${challenge}`), privateKey).toString('base64');
}

export function verifyChallenge(publicKey, challenge, signature) {
  try {
    return verify(null, Buffer.from(`relay-auth-v1:${challenge}`), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
