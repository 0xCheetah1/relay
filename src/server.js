import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyChallenge } from './identity.js';
import { isEnvelope } from './crypto.js';
import { verifyAttestation, verifyAttestationSignature } from './near.js';

const ID_PATTERN = /^rly_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const send = (socket, message) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};
const cleanText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const keyRecord = (value) => (value ? (typeof value === 'string' ? { signing: value, encryption: null } : value) : null);

export function createRelayServer({ ringMs = 120_000, callMs = 60_000, host = '127.0.0.1', port = 0, identityStore, nearStore,
  nearVerify = verifyAttestation, rateCallsPerMin = 10, rateMessagesPerMin = 60 } = {}) {
  const attestations = new Map(Object.entries(nearStore?.load() ?? {}));
  const http = createServer((request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const match = url.pathname.match(/^\/near-lookup\/(rly_[0-9a-f-]{36})$/);
      if (request.method === 'GET' && match) {
        const attestation = attestations.get(match[1]);
        const body = attestation
          ? { ok: true, relayId: match[1], account: attestation.account, attestation }
          : { ok: false, error: 'not_found', relayId: match[1] };
        response.writeHead(attestation ? 200 : 404, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify(body));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: 'not_found' }));
    } catch {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: 'lookup_failed' }));
    }
  });
  const wss = new WebSocketServer({ server: http, maxPayload: 32 * 1024 });
  const keys = new Map(Object.entries(identityStore?.load() ?? {}));
  const peers = new Map();
  const calls = new Map();
  const missedQueues = new Map();

  function finish(call, status, reason, payload = null, sig = null) {
    if (!calls.has(call.id)) return;
    calls.delete(call.id);
    clearTimeout(call.timer);
    const event = { type: 'call.ended', callId: call.id, status, reason, payload, sig };
    send(peers.get(call.from)?.socket, event);
    send(peers.get(call.to)?.socket, event);
  }

  function allow(peer, bucket, limit) {
    const now = Date.now();
    const state = peer.rate?.[bucket] ?? { tokens: limit, last: now };
    state.tokens = Math.min(limit, state.tokens + ((now - state.last) / 60000) * limit);
    state.last = now;
    peer.rate = { ...(peer.rate ?? {}), [bucket]: state };
    if (state.tokens < 1) return false;
    state.tokens -= 1;
    return true;
  }

  function peerKeys(id) {
    const record = keyRecord(keys.get(id));
    return record ? { signing: record.signing, encryption: record.encryption ?? null } : null;
  }

  async function handle(peer, message) {
    const { id, socket } = peer;
    if (message.type === 'presence.set') {
      if (typeof message.dnd !== 'boolean') return send(socket, { type: 'error', code: 'invalid_presence' });
      peer.dnd = message.dnd;
      return send(socket, { type: 'presence.updated', dnd: peer.dnd });
    }
    if (message.type === 'blocklist.set') {
      if (!Array.isArray(message.blocked) || message.blocked.length > 500
        || message.blocked.some((blocked) => typeof blocked !== 'string' || !ID_PATTERN.test(blocked))) {
        return send(socket, { type: 'error', code: 'invalid_blocklist' });
      }
      peer.blocked = new Set(message.blocked);
      return send(socket, { type: 'blocklist.updated', blocked: [...peer.blocked] });
    }
    if (message.type === 'near.publish') {
      if (!allow(peer, 'near_publish', 5)) return send(socket, { type: 'error', code: 'rate_limited' });
      const signed = verifyAttestationSignature(message.attestation);
      if (!signed.ok) return send(socket, { type: 'error', code: 'invalid_attestation', reason: signed.error });
      if (signed.parsed.relayId !== id) return send(socket, { type: 'error', code: 'attestation_relay_mismatch' });
      const verified = await nearVerify(message.attestation).catch((error) => ({ ok: false, error: error.message }));
      if (!verified.ok || verified.account !== message.attestation.account || verified.relayId !== id) {
        return send(socket, { type: 'error', code: 'invalid_attestation', reason: verified.error ?? 'verification_failed' });
      }
      attestations.set(id, message.attestation);
      nearStore?.save(Object.fromEntries(attestations));
      return send(socket, { type: 'near.published', relayId: id, account: message.attestation.account });
    }
    if (message.type === 'near.lookup') {
      if (!ID_PATTERN.test(message.relayId ?? '')) return send(socket, { type: 'error', code: 'invalid_id' });
      if (!allow(peer, 'near', 60)) return send(socket, { type: 'error', code: 'rate_limited' });
      return send(socket, { type: 'near.result', relayId: message.relayId, attestation: attestations.get(message.relayId) ?? null });
    }
    if (message.type === 'keys.get') {
      if (!ID_PATTERN.test(message.id ?? '')) return send(socket, { type: 'error', code: 'invalid_id' });
      const record = peerKeys(message.id);
      return send(socket, { type: 'keys.result', id: message.id, signing: record?.signing ?? null, encryption: record?.encryption ?? null });
    }
    if (message.type === 'call.request') {
      const { callId, to } = message;
      const minTurns = Number.isInteger(message.minTurns) ? message.minTurns : 1;
      if (typeof callId !== 'string' || !/^[0-9a-f-]{36}$/.test(callId) || !ID_PATTERN.test(to ?? '')
        || !isEnvelope(message.payload) || !cleanText(message.sig, 200) || minTurns < 1 || minTurns > 20) {
        return send(socket, { type: 'error', code: 'invalid_call_request', callId });
      }
      if (calls.has(callId)) return send(socket, { type: 'error', code: 'duplicate_call', callId });
      if (!allow(peer, 'calls', rateCallsPerMin)) return send(socket, { type: 'error', code: 'rate_limited', callId });
      const fromKeys = peerKeys(id);
      if (!fromKeys?.encryption) return send(socket, { type: 'error', code: 'encryption_key_missing', callId });
      const recipient = peers.get(to);
      if (!recipient) {
        const cutoff = Date.now() - 7 * 86400000;
        const queue = (missedQueues.get(to) ?? []).filter((item) => item.at >= cutoff);
        queue.push({ callId, from: id, payload: message.payload, sig: message.sig, fromKeys, at: Date.now(), reason: 'peer_offline' });
        missedQueues.set(to, queue.slice(-50));
        return send(socket, { type: 'call.unavailable', callId, reason: 'peer_offline' });
      }
      if (recipient.blocked?.has(id)) return send(socket, { type: 'call.unavailable', callId, reason: 'caller_blocked' });
      if (recipient.dnd) {
        send(recipient.socket, { type: 'call.missed', callId, from: id, payload: message.payload, sig: message.sig, fromKeys, at: Date.now(), reason: 'recipient_dnd' });
        return send(socket, { type: 'call.unavailable', callId, reason: 'recipient_dnd' });
      }
      if (to === id) return send(socket, { type: 'call.unavailable', callId, reason: 'self_call' });
      const call = { id: callId, from: id, to, state: 'ringing', timer: null };
      calls.set(callId, call);
      call.timer = setTimeout(() => finish(call, 'ignored', 'ring_timeout'), ringMs);
      send(recipient.socket, { type: 'call.ringing', callId, from: id, payload: message.payload, sig: message.sig, fromKeys,
        ownerInitiated: message.ownerInitiated === true, minTurns, deadline: Date.now() + ringMs });
      return send(socket, { type: 'call.dialing', callId, to });
    }
    if (message.type === 'call.accept' || message.type === 'call.reject') {
      const call = calls.get(message.callId);
      if (!call || call.to !== id || call.state !== 'ringing') return send(socket, { type: 'error', code: 'invalid_decision', callId: message.callId });
      if (message.type === 'call.reject') return finish(call, 'rejected', 'recipient_rejected');
      clearTimeout(call.timer);
      call.state = 'active';
      if (callMs > 0) call.timer = setTimeout(() => finish(call, 'timeout', 'call_timeout'), callMs);
      const event = { type: 'call.accepted', callId: call.id, from: call.from, to: call.to, deadline: Date.now() + callMs };
      send(peers.get(call.from)?.socket, event);
      return send(socket, event);
    }
    if (message.type === 'call.message') {
      const call = calls.get(message.callId);
      if (!call || call.state !== 'active' || (id !== call.from && id !== call.to)
        || !isEnvelope(message.payload) || !cleanText(message.sig, 200)) {
        return send(socket, { type: 'error', code: 'invalid_message', callId: message.callId });
      }
      if (!allow(peer, 'messages', rateMessagesPerMin)) return send(socket, { type: 'error', code: 'rate_limited', callId: message.callId });
      return send(peers.get(id === call.from ? call.to : call.from)?.socket,
        { type: 'call.message', callId: call.id, from: id, payload: message.payload, sig: message.sig });
    }
    if (message.type === 'call.end') {
      const call = calls.get(message.callId);
      const validPayload = message.payload == null || isEnvelope(message.payload);
      if (!call || (id !== call.from && id !== call.to) || !validPayload
        || (message.sig != null && !cleanText(message.sig, 200))) {
        return send(socket, { type: 'error', code: 'invalid_end', callId: message.callId });
      }
      return finish(call, 'completed', `ended_by_${id === call.from ? 'caller' : 'recipient'}`,
        message.payload ?? null, message.sig ?? null);
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
        const { id, publicKey, signature, encryptionPublicKey } = message;
        const pinned = keyRecord(keys.get(id));
        if (message.type !== 'auth.response' || !ID_PATTERN.test(id ?? '') || !cleanText(publicKey, 300) || !cleanText(signature, 200)
          || (encryptionPublicKey != null && !cleanText(encryptionPublicKey, 300))
          || !verifyChallenge(publicKey, challenge, signature)
          || (pinned && pinned.signing !== publicKey) || peers.has(id)) {
          return socket.close(1008, 'invalid_identity');
        }
        clearTimeout(authTimer);
        const nextEncryption = encryptionPublicKey ?? pinned?.encryption ?? null;
        if (!pinned || pinned.encryption !== nextEncryption) {
          try { identityStore?.save({ ...Object.fromEntries(keys), [id]: { signing: publicKey, encryption: nextEncryption } }); }
          catch { return socket.close(1011, 'identity_store_error'); }
          keys.set(id, { signing: publicKey, encryption: nextEncryption });
        }
        peer = { id, socket, dnd: false, blocked: new Set() };
        peers.set(id, peer);
        send(socket, { type: 'auth.ok', id });
        const queued = missedQueues.get(id);
        if (queued?.length) {
          missedQueues.delete(id);
          send(socket, { type: 'missed.list', calls: queued });
        }
        return;
      }
      handle(peer, message).catch(() => send(socket, { type: 'error', code: 'server_error' }));
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
