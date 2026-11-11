import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { signChallenge } from './identity.js';
import { decryptPayload, deriveCallKey, encryptPayload, isEnvelope, signEnvelope, verifyEnvelope } from './crypto.js';

export class RelayClient extends EventEmitter {
  constructor({ identity, url }) {
    super();
    if (!identity?.id || !identity?.publicKey || !identity?.privateKey) throw new Error('Identity with private key required');
    if (!identity?.encryptionPublicKey || !identity?.encryptionPrivateKey) throw new Error('Identity with encryption keys required');
    this.identity = identity;
    this.url = url;
    this.contacts = new Map();
    this.callKeys = new Map();
    this.socket = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      let settled = false;
      socket.on('message', (raw) => {
        let event;
        try { event = JSON.parse(raw.toString()); } catch { return; }
        if (event.type === 'auth.challenge') {
          socket.send(JSON.stringify({ type: 'auth.response', id: this.identity.id, publicKey: this.identity.publicKey,
            encryptionPublicKey: this.identity.encryptionPublicKey, signature: signChallenge(this.identity.privateKey, event.challenge) }));
        } else if (event.type === 'auth.ok' && !settled) {
          settled = true;
          resolve();
        } else {
          const normalized = this.decryptEvent(event);
          if (!normalized) return;
          // EventEmitter reserves "error" for thrown exceptions; protocol failures are data.
          this.emit(normalized.type === 'error' ? 'protocol.error' : normalized.type, normalized);
          this.emit('event', normalized);
        }
      });
      socket.on('error', (error) => { if (!settled) { settled = true; reject(error); } else this.emit('connection.error', error); });
      socket.on('close', (code, reason) => {
        if (!settled) { settled = true; reject(new Error(`Connection closed: ${code} ${reason}`)); }
        this.emit('connection.closed', { code, reason: reason.toString() });
      });
    });
  }

  decryptEvent(event) {
    try {
      if (event.type === 'call.ringing') {
        if (!isEnvelope(event.payload) || !event.fromKeys?.encryption || !event.fromKeys?.signing) return null;
        if (!verifyEnvelope(event.fromKeys.signing, event.callId, 'call.request', event.payload, event.sig)) {
          this.emit('protocol.error', { code: 'invalid_signature', callId: event.callId });
          return null;
        }
        const key = deriveCallKey(this.identity.encryptionPrivateKey, event.fromKeys.encryption, event.callId);
        const data = decryptPayload(key, event.payload);
        this.callKeys.set(event.callId, { key, peerSigning: event.fromKeys.signing, peerEncryption: event.fromKeys.encryption });
        const { payload, sig, ...rest } = event;
        return { ...rest, intent: data.intent, task: data.task };
      }
      if (event.type === 'call.message') {
        const session = this.callKeys.get(event.callId);
        if (!session || !isEnvelope(event.payload)) return null;
        if (!verifyEnvelope(session.peerSigning, event.callId, 'call.message', event.payload, event.sig)) {
          this.emit('protocol.error', { code: 'invalid_signature', callId: event.callId });
          return null;
        }
        const data = decryptPayload(session.key, event.payload);
        return { type: 'call.message', callId: event.callId, from: event.from, text: data.text };
      }
      if (event.type === 'call.ended') {
        const session = this.callKeys.get(event.callId);
        let result = event.result ?? null;
        if (session && isEnvelope(event.payload)) {
          const valid = verifyEnvelope(session.peerSigning, event.callId, 'call.end', event.payload, event.sig)
            || verifyEnvelope(this.identity.publicKey, event.callId, 'call.end', event.payload, event.sig);
          if (valid) {
            try { result = decryptPayload(session.key, event.payload).result ?? null; } catch { /* keep null */ }
          }
        }
        this.callKeys.delete(event.callId);
        return { type: 'call.ended', callId: event.callId, status: event.status, reason: event.reason, result };
      }
      if (event.type === 'call.missed') {
        if (!isEnvelope(event.payload) || !event.fromKeys?.encryption || !event.fromKeys?.signing) return null;
        if (!verifyEnvelope(event.fromKeys.signing, event.callId, 'call.request', event.payload, event.sig)) return null;
        const key = deriveCallKey(this.identity.encryptionPrivateKey, event.fromKeys.encryption, event.callId);
        const data = decryptPayload(key, event.payload);
        const { payload, sig, ...rest } = event;
        return { ...rest, intent: data.intent, task: data.task };
      }
      if (event.type === 'missed.list') {
        return { ...event, calls: (event.calls ?? []).map((call) => {
          if (!isEnvelope(call.payload) || !call.fromKeys?.encryption || !call.fromKeys?.signing) return { ...call, intent: null, task: null };
          if (!verifyEnvelope(call.fromKeys.signing, call.callId, 'call.request', call.payload, call.sig)) return { ...call, intent: null, task: null };
          const key = deriveCallKey(this.identity.encryptionPrivateKey, call.fromKeys.encryption, call.callId);
          const data = decryptPayload(key, call.payload);
          return { callId: call.callId, from: call.from, at: call.at, reason: call.reason, intent: data.intent, task: data.task };
        }) };
      }
      return event;
    } catch {
      this.emit('protocol.error', { code: 'decrypt_failed', callId: event.callId });
      return null;
    }
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Not connected to RELAY');
    this.socket.send(JSON.stringify(message));
  }

  addContact(alias, id) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(alias)) throw new Error('Alias must start with a letter and contain only lowercase letters, digits, _ or -');
    if (!/^rly_[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid relay ID');
    this.contacts.set(alias, id);
  }

  getKeys(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.off('keys.result', onResult); reject(new Error('Key lookup timed out')); }, 5000);
      const onResult = (event) => {
        if (event.id !== id) return;
        clearTimeout(timer);
        this.off('keys.result', onResult);
        resolve(event);
      };
      this.on('keys.result', onResult);
      this.send({ type: 'keys.get', id });
    });
  }

  async dial(alias, { intent, task, ownerInitiated = false, minTurns = 1 } = {}) {
    const to = this.contacts.get(alias) ?? (/^rly_[0-9a-f-]{36}$/.test(alias) ? alias : null);
    if (!to) throw new Error(`Unknown contact: ${alias}`);
    const peer = await this.getKeys(to);
    if (!peer.encryption) throw new Error('Peer has no encryption key (not an E2E build)');
    const callId = randomUUID();
    const key = deriveCallKey(this.identity.encryptionPrivateKey, peer.encryption, callId);
    const payload = encryptPayload(key, { intent, task });
    const sig = signEnvelope(this.identity.privateKey, callId, 'call.request', payload);
    this.callKeys.set(callId, { key, peerSigning: peer.signing, peerEncryption: peer.encryption });
    this.send({ type: 'call.request', callId, to, payload, sig, ownerInitiated, minTurns });
    return callId;
  }

  setDnd(dnd) { this.send({ type: 'presence.set', dnd }); }
  setBlocked(ids) { this.send({ type: 'blocklist.set', blocked: ids }); }
  accept(callId) { this.send({ type: 'call.accept', callId }); }
  reject(callId) { this.send({ type: 'call.reject', callId }); }
  say(callId, text) {
    const session = this.callKeys.get(callId);
    if (!session) throw new Error('No encryption key for this call');
    const payload = encryptPayload(session.key, { text });
    const signature = signEnvelope(this.identity.privateKey, callId, 'call.message', payload);
    this.send({ type: 'call.message', callId, payload, sig: signature });
  }
  end(callId, result) {
    const session = this.callKeys.get(callId);
    const payload = session ? encryptPayload(session.key, { result: result ?? null }) : null;
    const signature = payload ? signEnvelope(this.identity.privateKey, callId, 'call.end', payload) : null;
    this.send({ type: 'call.end', callId, payload, sig: signature });
  }
  fail(callId) { this.send({ type: 'call.fail', callId }); }

  close() {
    return new Promise((resolve) => {
      if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return resolve();
      this.socket.once('close', resolve);
      this.socket.close();
    });
  }
}
