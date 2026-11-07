import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyChallenge } from './identity.js';

const ID_PATTERN = /^rly_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const send = (socket, message) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};
const cleanText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export function createRelayServer({ ringMs = 30_000, callMs = 60_000, host = '127.0.0.1', port = 0, identityStore } = {}) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, maxPayload: 32 * 1024 });
  const keys = new Map(Object.entries(identityStore?.load() ?? {}));
  const peers = new Map();
  const calls = new Map();

  function finish(call, status, reason, result = null) {
    if (!calls.has(call.id)) return;
    calls.delete(call.id);
    clearTimeout(call.timer);
    const event = { type: 'call.ended', callId: call.id, status, reason, result };
    send(peers.get(call.from)?.socket, event);
    send(peers.get(call.to)?.socket, event);
  }

  function handle(peer, message) {
    const { id, socket } = peer;
    if (message.type === 'presence.set') {
      if (typeof message.dnd !== 'boolean') return send(socket, { type: 'error', code: 'invalid_presence' });
      peer.dnd = message.dnd;
      return send(socket, { type: 'presence.updated', dnd: peer.dnd });
    }
    if (message.type === 'call.request') {
      const { callId, to, intent, task } = message;
      if (typeof callId !== 'string' || !/^[0-9a-f-]{36}$/.test(callId) || !ID_PATTERN.test(to ?? '') || !cleanText(intent, 160) || !cleanText(task, 2000)) {
        return send(socket, { type: 'error', code: 'invalid_call_request', callId });
      }
      if (calls.has(callId)) return send(socket, { type: 'error', code: 'duplicate_call', callId });
      const recipient = peers.get(to);
      if (!recipient || recipient.dnd || to === id) return send(socket, { type: 'call.unavailable', callId });
      const call = { id: callId, from: id, to, state: 'ringing', timer: null };
      calls.set(callId, call);
      call.timer = setTimeout(() => finish(call, 'ignored', 'ring_timeout'), ringMs);
      send(recipient.socket, { type: 'call.ringing', callId, from: id, intent, task, ownerInitiated: message.ownerInitiated === true, deadline: Date.now() + ringMs });
      return send(socket, { type: 'call.dialing', callId, to });
    }
    if (message.type === 'call.accept' || message.type === 'call.reject') {
      const call = calls.get(message.callId);
      if (!call || call.to !== id || call.state !== 'ringing') return send(socket, { type: 'error', code: 'invalid_decision', callId: message.callId });
      if (message.type === 'call.reject') return finish(call, 'rejected', 'recipient_rejected');
      clearTimeout(call.timer);
      call.state = 'active';
      call.timer = setTimeout(() => finish(call, 'timeout', 'call_timeout'), callMs);
      const event = { type: 'call.accepted', callId: call.id, from: call.from, to: call.to, deadline: Date.now() + callMs };
      send(peers.get(call.from)?.socket, event);
      return send(socket, event);
    }
    if (message.type === 'call.message') {
      const call = calls.get(message.callId);
      if (!call || call.state !== 'active' || (id !== call.from && id !== call.to) || !cleanText(message.text, 4000)) {
        return send(socket, { type: 'error', code: 'invalid_message', callId: message.callId });
      }
      return send(peers.get(id === call.from ? call.to : call.from)?.socket,
        { type: 'call.message', callId: call.id, from: id, text: message.text });
    }
    if (message.type === 'call.end') {
      const call = calls.get(message.callId);
      if (!call || (id !== call.from && id !== call.to) || (message.result != null && !cleanText(message.result, 4000))) {
        return send(socket, { type: 'error', code: 'invalid_end', callId: message.callId });
      }
      return finish(call, 'completed', `ended_by_${id === call.from ? 'caller' : 'recipient'}`, message.result ?? null);
    }
    if (message.type === 'call.fail') {
      const call = calls.get(message.callId);
      if (!call || call.state !== 'active' || call.to !== id) {
        return send(socket, { type: 'error', code: 'invalid_failure', callId: message.callId });
      }
      return finish(call, 'failed', 'agent_run_failed');
    }
    send(socket, { type: 'error', code: 'unknown_type' });
  }

  wss.on('connection', (socket) => {
    const challenge = randomBytes(32).toString('hex');
    let peer = null;
    const authTimer = setTimeout(() => socket.close(1008, 'auth_timeout'), 5000);
    send(socket, { type: 'auth.challenge', challenge });
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return send(socket, { type: 'error', code: 'invalid_json' }); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return send(socket, { type: 'error', code: 'invalid_json' });
      if (!peer) {
        const { id, publicKey, signature } = message;
        if (message.type !== 'auth.response' || !ID_PATTERN.test(id ?? '') || !cleanText(publicKey, 300) || !cleanText(signature, 200) || !verifyChallenge(publicKey, challenge, signature) || (keys.has(id) && keys.get(id) !== publicKey) || peers.has(id)) {
          return socket.close(1008, 'invalid_identity');
        }
        clearTimeout(authTimer);
        if (!keys.has(id)) {
          try { identityStore?.save({ ...Object.fromEntries(keys), [id]: publicKey }); }
          catch { return socket.close(1011, 'identity_store_error'); }
          keys.set(id, publicKey);
        }
        peer = { id, socket, dnd: false };
        peers.set(id, peer);
        return send(socket, { type: 'auth.ok', id });
      }
      handle(peer, message);
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      if (!peer || peers.get(peer.id) !== peer) return;
      peers.delete(peer.id);
      for (const call of [...calls.values()]) {
        if (call.from === peer.id || call.to === peer.id) finish(call, 'disconnected', 'peer_disconnected');
      }
    });
  });

  return {
    async listen() {
      await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, host, resolve); });
      return `ws://${host}:${http.address().port}`;
    },
    async close() {
      for (const call of calls.values()) clearTimeout(call.timer);
      calls.clear();
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => http.close(resolve));
    },
  };
}
