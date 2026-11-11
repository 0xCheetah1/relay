import { createHash, createPublicKey, verify } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(buffer) {
  const bytes = Buffer.from(buffer);
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let output = '';
  for (const byte of bytes) { if (byte === 0) output += '1'; else break; }
  for (let index = digits.length - 1; index >= 0; index -= 1) output += ALPHABET[digits[index]];
  return output;
}

export function base58Decode(value) {
  const bytes = [0];
  for (const character of value) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) throw new Error('Invalid base58');
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      const next = bytes[index] * 58 + carry;
      bytes[index] = next % 256;
      carry = Math.floor(next / 256);
    }
    while (carry > 0) { bytes.push(carry % 256); carry = Math.floor(carry / 256); }
  }
  for (const character of value) { if (character === '1') bytes.push(0); else break; }
  return Buffer.from(bytes.reverse());
}

const NEP413_TAG = 2147484061;

function borshString(value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function borshU32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value, 0);
  return bytes;
}

export function nep413Payload({ message, recipient, nonce, callbackUrl = null }) {
  const nonceBytes = Buffer.from(nonce);
  if (nonceBytes.length !== 32) throw new Error('NEP-413 nonce must be 32 bytes');
  const parts = [borshU32(NEP413_TAG), borshString(message), nonceBytes, borshString(recipient)];
  if (callbackUrl) parts.push(Buffer.from([1]), borshString(callbackUrl));
  else parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

export function nearPublicKeyObject(publicKey) {
  const value = publicKey.startsWith('ed25519:') ? publicKey.slice('ed25519:'.length) : publicKey;
  const raw = base58Decode(value);
  if (raw.length !== 32) throw new Error('Only ed25519 keys are supported');
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function verifyNearSignature({ publicKey, signature, payload }) {
  try {
    const digest = createHash('sha256').update(Buffer.from(payload)).digest();
    return verify(null, digest, nearPublicKeyObject(publicKey), Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export async function accountHasKey(accountId, publicKey, rpcUrl = 'https://rpc.mainnet.near.org') {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'relay', method: 'query',
      params: { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey } }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json().catch(() => ({}));
  return Boolean(response.ok && data.result && !data.error);
}

export function attestationMessage({ account, relayId, signingKey, encryptionKey, capabilities, issuedAt, expiresAt, nonce }) {
  return JSON.stringify({ version: 1, account, relayId, signingKey, encryptionKey, capabilities, issuedAt, expiresAt, nonce });
}

export async function verifyAttestation(attestation, { checkKey = accountHasKey, rpcUrl } = {}) {
  if (!attestation?.message || !attestation?.signature || !attestation?.publicKey || !attestation?.account) {
    return { ok: false, error: 'incomplete' };
  }
  let parsed;
  try { parsed = JSON.parse(attestation.message); } catch { return { ok: false, error: 'invalid_message' }; }
  if (parsed.account && parsed.account !== attestation.account) return { ok: false, error: 'account_mismatch' };
  if (attestation.expiresAt && Date.parse(attestation.expiresAt) < Date.now()) return { ok: false, error: 'expired' };
  const nonce = Buffer.from(parsed.nonce ?? attestation.nonce ?? '', 'base64');
  if (nonce.length !== 32) return { ok: false, error: 'invalid_nonce' };
  const payload = nep413Payload({ message: attestation.message, recipient: attestation.recipient ?? 'relay', nonce });
  if (!verifyNearSignature({ publicKey: attestation.publicKey, signature: attestation.signature, payload })) {
    return { ok: false, error: 'invalid_signature' };
  }
  const hasKey = await checkKey(attestation.account, attestation.publicKey, rpcUrl);
  if (!hasKey) return { ok: false, error: 'key_not_on_account' };
  return { ok: true, account: attestation.account, relayId: parsed.relayId };
}
