import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { signChallenge } from './identity.js';

export class RelayClient extends EventEmitter {
  constructor({ identity, url }) {
    super();
    if (!identity?.id || !identity?.publicKey || !identity?.privateKey) throw new Error('Identity with private key required');
    this.identity = identity;
    this.url = url;
    this.contacts = new Map();
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
            signature: signChallenge(this.identity.privateKey, event.challenge) }));
        } else if (event.type === 'auth.ok' && !settled) {
          settled = true;
          resolve();
        } else {
          // EventEmitter reserves "error" for thrown exceptions; protocol failures are data.
          this.emit(event.type === 'error' ? 'protocol.error' : event.type, event);
          this.emit('event', event);
        }
      });
      socket.on('error', (error) => { if (!settled) { settled = true; reject(error); } else this.emit('connection.error', error); });
      socket.on('close', (code, reason) => {
        if (!settled) { settled = true; reject(new Error(`Connection closed: ${code} ${reason}`)); }
        this.emit('connection.closed', { code, reason: reason.toString() });
      });
    });
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

  dial(alias, { intent, task, ownerInitiated = false }) {
    const to = this.contacts.get(alias);
    if (!to) throw new Error(`Unknown contact: ${alias}`);
    const callId = randomUUID();
    this.send({ type: 'call.request', callId, to, intent, task, ownerInitiated });
    return callId;
  }

  setDnd(dnd) { this.send({ type: 'presence.set', dnd }); }
  setBlocked(ids) { this.send({ type: 'blocklist.set', blocked: ids }); }
  accept(callId) { this.send({ type: 'call.accept', callId }); }
  reject(callId) { this.send({ type: 'call.reject', callId }); }
  say(callId, text) { this.send({ type: 'call.message', callId, text }); }
  end(callId, result) { this.send({ type: 'call.end', callId, result }); }
  fail(callId) { this.send({ type: 'call.fail', callId }); }

  close() {
    return new Promise((resolve) => {
      if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return resolve();
      this.socket.once('close', resolve);
      this.socket.close();
    });
  }
}
