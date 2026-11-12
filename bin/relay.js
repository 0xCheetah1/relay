#!/usr/bin/env node
import { homedir, networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, watchFile, unwatchFile, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createConnection } from 'node:net';
import { extractReport, invokeHarness, stripDone } from '../src/adapters.js';
import { createIdentity } from '../src/identity.js';
import { RelayClient } from '../src/client.js';
import { jsonStore } from '../src/store.js';
import { formatTranscript } from '../src/transcript.js';
import { ensureEncryptionKeys } from '../src/crypto.js';
import { accountHasKey, attestationMessage, nep413Payload, verifyAttestation, verifyNearSignature } from '../src/near.js';
import { approvalCode, editTelegramText, sameCode, sendControl, sendDecision, sendDial, sendInlineNotice, sendInlineResolve, sendInlineRing, sendOpenClawNotice, sendOpenClawRing, sendTelegramRing, startApprovalSocket, startAttachServer } from '../src/notifications.js';

const profileDir = process.env.RELAY_HOME ?? join(homedir(), '.config', 'relay');
const profile = process.env.RELAY_PROFILE ?? (profiles().length === 1 ? profiles()[0] : 'default');
if (!/^[a-zA-Z0-9_-]{1,40}$/.test(profile)) throw new Error('Invalid RELAY_PROFILE');
const store = jsonStore(join(profileDir, `${profile}.json`));
const [command, ...args] = process.argv.slice(2);

function openclawTelegramToken() {
  if (process.env.RELAY_OPENCLAW_TELEGRAM_TOKEN) return process.env.RELAY_OPENCLAW_TELEGRAM_TOKEN;
  const configPath = process.env.RELAY_OPENCLAW_MAIN_CONFIG ?? join(homedir(), '.openclaw', 'openclaw.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const telegram = config.channels?.telegram;
    return telegram?.botToken ?? telegram?.token
      ?? telegram?.accounts?.default?.botToken ?? telegram?.accounts?.default?.token ?? null;
  } catch { return null; }
}
const openclawToken = openclawTelegramToken();

function profiles() {
  return existsSync(profileDir)
    ? readdirSync(profileDir).filter((name) => {
      if (!/^[a-zA-Z0-9_-]{1,40}\.json$/.test(name)) return false;
      try { return typeof JSON.parse(readFileSync(join(profileDir, name), 'utf8')).identity?.id === 'string'; }
      catch { return false; }
    }).map((name) => name.slice(0, -5))
    : [];
}

function state() {
  const value = store.load();
  if (!value.identity) {
    const available = profiles().filter((name) => name !== profile);
    console.error(`No RELAY identity for profile "${profile}" on this machine.${available.length ? ` Available profiles: ${available.join(', ')}.` : ''} Use RELAY_PROFILE=<profile> or run relay init to create a new identity.`);
    process.exit(1);
  }
  if (!value.identity.encryptionPublicKey || !value.identity.encryptionPrivateKey) {
    value.identity = ensureEncryptionKeys(value.identity);
    store.save(value);
  }
  return value;
}

function validateUrl(url) {
  if (!/^wss?:\/\//.test(url)) throw new Error('RELAY URL must be ws:// or wss://');
  if (url.startsWith('ws://') && !/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\]|100\.[0-9.]+)(:|\/|$)/.test(url)) {
    throw new Error('Plain WebSocket is allowed only on loopback or a Tailscale IPv4 address; use wss:// elsewhere');
  }
}

async function publishNearAttestation(attestation) {
  const controlPath = join(profileDir, `${profile}.sock`);
  if (existsSync(controlPath)) {
    try {
      const result = await sendControl(controlPath, { action: 'nearPublish', attestation });
      if (result.ok) return;
    } catch { /* fall through to a direct connection */ }
  }
  const value = state();
  const url = process.env.RELAY_URL ?? value.url;
  if (!url) return;
  validateUrl(url);
  const client = new RelayClient({ identity: value.identity, url });
  await client.connect();
  try {
    client.publishNear(attestation);
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    await client.close();
  }
}

function describeReason(reason) {
  return {
    recipient_dnd: 'recipient is on Do Not Disturb',
    peer_offline: 'recipient is offline or not connected',
    caller_blocked: 'caller is blocked by the recipient',
    self_call: 'cannot call your own relay ID',
    ring_timeout: 'recipient did not answer in time',
    call_timeout: 'call ended before an answer arrived',
    wait_timeout: 'timed out waiting for the next turn',
    recipient_rejected: 'recipient rejected the call',
    ended_by_recipient: 'call ended by the recipient',
  }[reason] ?? reason;
}

const historyStore = jsonStore(join(profileDir, `${profile}-history.json`));
const NEAR_PAGE = readFileSync(new URL('../src/near-page.html', import.meta.url), 'utf8');

function safeName(value) {
  return String(value ?? 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'unknown';
}

function parseDuration(input) {
  if (/^(forever|off|never|0)$/i.test(input ?? '')) return 0;
  const match = /^(\d+)\s*(s|m|h|d|w)?$/i.exec(input ?? '');
  if (!match) throw new Error('Duration must look like 30m, 12h, 7d, or forever');
  return Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[(match[2] ?? 's').toLowerCase()]);
}

function retentionSeconds(peerId) {
  const value = store.load();
  const configured = value.retention?.[peerId];
  return Number.isFinite(configured) ? Math.max(0, configured) : 86400;
}

function prunePeer(peerId) {
  const seconds = retentionSeconds(peerId);
  if (seconds === 0) return;
  const cutoff = Date.now() - seconds * 1000;
  const history = historyStore.load();
  const records = Array.isArray(history.records) ? history.records : [];
  const kept = records.filter((record) => record.peer !== peerId
    || Date.parse(record.endedAt ?? record.startedAt ?? 0) >= cutoff);
  if (kept.length !== records.length) {
    history.records = kept;
    historyStore.save(history);
  }
  const dir = join(profileDir, 'transcripts', safeName(peerId));
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    try { if (statSync(file).mtimeMs < cutoff) unlinkSync(file); } catch {}
  }
}

function pruneAll() {
  let value;
  try { value = store.load(); } catch { return; }
  if (!value.identity) return;
  const history = historyStore.load();
  const records = Array.isArray(history.records) ? history.records : [];
  const peers = new Set(records.map((record) => record.peer).filter(Boolean));
  for (const peerId of peers) prunePeer(peerId);
}

function persistRecord(record) {
  const history = historyStore.load();
  const list = Array.isArray(history.records) ? history.records : [];
  list.unshift(record);
  history.records = list.slice(0, 200);
  historyStore.save(history);
  try {
    const dir = join(profileDir, 'transcripts', safeName(record.peer ?? 'unknown'));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${record.callId}.md`), formatTranscript(record), { mode: 0o600 });
  } catch (error) {
    console.error(`Could not save transcript: ${error.message}`);
  }
  if (record.peer) prunePeer(record.peer);
}

if (command === 'profiles') {
  for (const name of profiles()) console.log(name);
} else if (command === 'init') {
  const current = store.load();
  if (current.identity) throw new Error(`Profile ${profile} already exists: ${current.identity.id}`);
  const identity = createIdentity();
  store.save({ identity, contacts: {} });
  console.log(`Created ${profile}: ${identity.id}`);
} else if (command === 'id') {
  console.log(state().identity.id);
} else if (command === 'config' && args[0] === 'set-url' && args.length === 2) {
  validateUrl(args[1]);
  const value = state();
  value.url = args[1];
  store.save(value);
  console.log(`Server saved for ${profile}: ${value.url}`);
} else if (command === 'dnd' && ['on', 'off'].includes(args[0]) && args.length === 1) {
  const value = state();
  value.dnd = args[0] === 'on';
  store.save(value);
  console.log(`DND ${args[0]} for ${profile}`);
} else if (command === 'block' && args.length === 1) {
  const value = state();
  const id = args[0].startsWith('rly_') ? args[0] : value.contacts?.[args[0]];
  if (!id || !/^rly_[0-9a-f-]{36}$/.test(id)) throw new Error('Unknown alias or invalid relay ID');
  value.blocked = [...new Set([...(value.blocked ?? []), id])];
  store.save(value);
  console.log(`Blocked ${args[0] === id ? id : `${args[0]} (${id})`}`);
} else if (command === 'unblock' && args.length === 1) {
  const value = state();
  const id = args[0].startsWith('rly_') ? args[0] : value.contacts?.[args[0]];
  if (!id) throw new Error('Unknown alias or invalid relay ID');
  value.blocked = (value.blocked ?? []).filter((blocked) => blocked !== id);
  store.save(value);
  console.log(`Unblocked ${args[0] === id ? id : `${args[0]} (${id})`}`);
} else if (command === 'blocked' && args.length === 0) {
  const value = state();
  const list = value.blocked ?? [];
  if (list.length === 0) console.log('Blocklist is empty.');
  else {
    const byId = new Map(Object.entries(value.contacts ?? {}).map(([alias, id]) => [id, alias]));
    for (const id of list) console.log(`${byId.get(id) ?? '?'}\t${id}`);
  }
} else if (['accept', 'reject'].includes(command) && args.length === 2) {
  state();
  const response = await sendDecision(join(profileDir, `${profile}.sock`), { action: command, callId: args[0], code: args[1] });
  if (!response.ok) { console.error(`Call ${command} failed: ${response.error}`); process.exitCode = 1; }
  else console.log(`Call ${args[0]} ${command === 'accept' ? 'accepted' : 'rejected'}`);
} else if (command === 'contacts' && args[0] === 'add' && args.length === 3) {
  const value = state();
  const client = new RelayClient({ identity: value.identity, url: 'ws://127.0.0.1' });
  client.addContact(args[1], args[2]);
  value.contacts[args[1]] = args[2];
  store.save(value);
  console.log(`${args[1]} → ${args[2]}`);
} else if (command === 'contacts' && args[0] === 'list' && args.length === 1) {
  for (const [alias, id] of Object.entries(state().contacts ?? {})) console.log(`${alias}\t${id}`);
} else if (command === 'near') {
  const value = state();
  const nearPath = join(profileDir, `${profile}-near.json`);
  if (args.length === 0 || args[0] === 'show') {
    if (!existsSync(nearPath)) console.log('No NEAR attestation saved. Run: relay near link');
    else {
      const data = JSON.parse(readFileSync(nearPath, 'utf8'));
      console.log(JSON.stringify({ account: data.account, relayId: data.relayId, publicKey: data.publicKey }, null, 2));
    }
  } else if (args[0] === 'verify' && args[1]) {
    const data = JSON.parse(readFileSync(resolve(args[1]), 'utf8'));
    const result = await verifyAttestation(data);
    console.log(result.ok ? `Valid: ${result.account} -> ${result.relayId}` : `Invalid: ${result.error}`);
    if (!result.ok) process.exitCode = 1;
  } else if (args[0] === 'lookup' && args[1]) {
    const relayId = args[1];
    if (!/^rly_[0-9a-f-]{36}$/.test(relayId)) throw new Error('Usage: relay near lookup <relay-id>');
    const controlPath = join(profileDir, `${profile}.sock`);
    let attestation;
    if (existsSync(controlPath)) {
      const result = await sendControl(controlPath, { action: 'nearLookup', relayId });
      if (!result.ok) throw new Error(result.error ?? 'NEAR lookup failed');
      attestation = result.attestation;
    } else {
      const url = process.env.RELAY_URL ?? value.url ?? 'ws://127.0.0.1:8901';
      validateUrl(url);
      const client = new RelayClient({ identity: value.identity, url });
      try {
        await client.connect();
        attestation = await client.lookupNear(relayId);
      } finally {
        await client.close();
      }
    }
    if (!attestation) {
      console.log(JSON.stringify({ ok: false, error: 'not_found', relayId }));
      process.exitCode = 1;
    } else {
      const verified = await verifyAttestation(attestation);
      if (!verified.ok || verified.relayId !== relayId) {
        console.log(JSON.stringify({ ok: false, error: verified.error ?? 'relay_mismatch', relayId }));
        process.exitCode = 1;
      } else {
        console.log(JSON.stringify({ ok: true, relayId, account: verified.account }));
      }
    }
  } else if (args[0] === 'publish') {
    if (!existsSync(nearPath)) throw new Error('No NEAR attestation saved. Run: relay near link');
    const data = JSON.parse(readFileSync(nearPath, 'utf8'));
    await publishNearAttestation(data);
    console.log(JSON.stringify({ ok: true, relayId: data.relayId, account: data.account }));
  } else if (args[0] === 'link') {
    const nonce = randomBytes(32);
    const issuedAt = new Date().toISOString();
    const timeoutMs = Number(process.env.RELAY_NEAR_TIMEOUT_MS ?? String(10 * 60 * 1000));
    let linkExpiresAt = timeoutMs > 0 ? new Date(Date.now() + timeoutMs).toISOString() : null;
    const template = {
      version: 1,
      relayId: value.identity.id,
      signingKey: value.identity.publicKey,
      encryptionKey: value.identity.encryptionPublicKey,
      capabilities: ['text', 'multi-turn'],
      issuedAt,
      linkExpiresAt,
      recipient: process.env.RELAY_NEAR_RECIPIENT ?? 'relay.near',
      nonce: nonce.toString('base64'),
    };
    const token = randomBytes(16).toString('hex');
    const port = Number(process.env.RELAY_NEAR_PORT ?? '8787');
    const nearDebug = process.env.RELAY_NEAR_DEBUG === '1';
    const publicBase = process.env.RELAY_NEAR_PUBLIC_URL
      ?? (() => {
        try {
          const relay = new URL(process.env.RELAY_URL ?? value.url);
          return relay.protocol === 'wss:' ? `https://${relay.host}/near/` : null;
        } catch { return null; }
      })();
    let used = false;
    let timeoutTimer = null;
    let timeoutResolve = null;
    let settle;
    const signed = new Promise((resolveSigned) => { settle = resolveSigned; });
    const timeout = timeoutMs > 0
      ? new Promise((resolveTimeout) => { timeoutResolve = resolveTimeout; })
      : new Promise(() => {});
    const armTimeout = () => {
      if (!timeoutMs || !timeoutResolve) return;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      linkExpiresAt = new Date(Date.now() + timeoutMs).toISOString();
      timeoutTimer = setTimeout(() => timeoutResolve(null), timeoutMs);
    };
    armTimeout();
    const server = createHttpServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        if (nearDebug) console.log(`[near] ${req.method} ${url.pathname}${url.searchParams.get('token') === token ? '' : ' (bad token)'}`);
        if (used || url.searchParams.get('token') !== token) { res.writeHead(403); res.end('forbidden'); return; }
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(NEAR_PAGE); return;
        }
        if (req.method === 'GET' && url.pathname === '/template') {
          const linkTtlMs = linkExpiresAt ? Math.max(0, Date.parse(linkExpiresAt) - Date.now()) : null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...template, linkExpiresAt, linkTtlMs })); return;
        }
        if (req.method === 'POST' && (url.pathname === '/debug' || url.pathname === '/error')) {
          let body = '';
          for await (const chunk of req) { body += chunk; if (body.length > 16384) { res.writeHead(413); res.end(); return; } }
          if (nearDebug) console.log(`[near] ${url.pathname.slice(1)}: ${body.slice(0, 2000)}`);
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
        }
        if (req.method === 'POST' && url.pathname === '/sign') {
          let body = '';
          for await (const chunk of req) { body += chunk; if (body.length > 65536) { res.writeHead(413); res.end(); return; } }
          let payload;
          try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'invalid_json' })); return; }
          let parsed;
          try { parsed = JSON.parse(payload.message); } catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'invalid_message' })); return; }
          if ((parsed.account && parsed.account !== payload.account) || !payload.account
            || parsed.relayId !== template.relayId
            || parsed.signingKey !== template.signingKey || parsed.encryptionKey !== template.encryptionKey
            || parsed.nonce !== payload.nonce || payload.recipient !== template.recipient) {
            res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'mismatch' })); return;
          }
          const nepPayload = nep413Payload({ message: payload.message, recipient: payload.recipient, nonce: Buffer.from(parsed.nonce, 'base64') });
          if (!verifyNearSignature({ publicKey: payload.publicKey, signature: payload.signature, payload: nepPayload })) {
            res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'invalid_signature' })); return;
          }
          if (!await accountHasKey(payload.account, payload.publicKey)) {
            res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'key_not_on_account' })); return;
          }
          const attestation = { ...parsed, account: payload.account, recipient: payload.recipient, message: payload.message, publicKey: payload.publicKey, signature: payload.signature };
          writeFileSync(nearPath, JSON.stringify(attestation, null, 2), { mode: 0o600 });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, account: payload.account }));
          used = true;
          settle(attestation);
          return;
        }
        res.writeHead(404); res.end();
      } catch (error) {
        res.writeHead(500); res.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
    await new Promise((resolveListen, rejectListen) => { server.once('error', rejectListen); server.listen(port, '0.0.0.0', resolveListen); });
    const addresses = Object.values(networkInterfaces()).flat().filter((item) => item && item.family === 'IPv4' && !item.internal).map((item) => item.address);
    if (publicBase) {
      try {
        const publicUrl = new URL(publicBase);
        publicUrl.searchParams.set('token', token);
        console.log(`Open on your phone: ${publicUrl.toString()}`);
      } catch {
        console.log(`Public NEAR link base is invalid: ${publicBase}`);
      }
    } else {
      console.log(`Open locally: http://127.0.0.1:${port}/?token=${token}`);
      for (const address of addresses) console.log(`Open on your network: http://${address}:${port}/?token=${token}`);
    }
    console.log(`Waiting for the wallet signature (${timeoutMs > 0 ? `${Math.round(timeoutMs / 60000)} min` : 'no timeout'})...`);
    const result = await Promise.race([signed, timeout]);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    await new Promise((resolveClose) => {
      server.close(() => resolveClose());
      setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      }, 1000);
    });
    if (result) {
      console.log(`Linked NEAR account ${result.account} to ${result.relayId}`);
      try {
        await publishNearAttestation(result);
      } catch (error) {
        console.error(`NEAR lookup publish failed: ${error.message}`);
      }
    } else { console.error('Failed: timed out waiting for the wallet signature'); process.exitCode = 1; }
  } else {
    throw new Error('Usage: relay near [link | show | verify <attestation.json> | lookup <relay-id> | publish]');
  }
} else if (command === 'history' && args.length === 0) {
  state();
  pruneAll();
  const list = Array.isArray(historyStore.load().records) ? historyStore.load().records : [];
  if (list.length === 0) { console.log('No calls recorded yet.'); }
  else for (const r of list) {
    const dir = r.direction === 'incoming' ? '\u2190' : '\u2192';
    const when = r.startedAt ? r.startedAt.slice(0, 19).replace('T', ' ') : '?';
    const who = r.peerAlias ?? r.peer ?? '?';
    console.log(`${when}  ${dir} ${who}  ${r.status}${r.result ? `  ${String(r.result).slice(0, 60)}` : ''}  (${r.callId.slice(0, 8)})`);
  }
} else if (command === 'retention') {
  const value = state();
  if (args.length === 0 || args[0] === 'list') {
    const byId = new Map(Object.entries(value.contacts ?? {}).map(([alias, id]) => [id, alias]));
    const entries = Object.entries(value.retention ?? {});
    if (entries.length === 0) console.log('Default retention: 24h. Use relay retention <alias|id> <30m|12h|7d|forever>.');
    else for (const [id, seconds] of entries) console.log(`${byId.get(id) ?? id}\t${seconds === 0 ? 'forever' : `${seconds}s`}`);
  } else if (args.length === 2) {
    const id = args[0].startsWith('rly_') ? args[0] : value.contacts?.[args[0]];
    if (!id) throw new Error('Unknown alias or invalid relay ID');
    const seconds = parseDuration(args[1]);
    value.retention = { ...(value.retention ?? {}), [id]: seconds };
    store.save(value);
    console.log(`Retention for ${args[0] === id ? id : `${args[0]} (${id})`}: ${seconds === 0 ? 'forever' : `${seconds}s`}`);
  } else {
    throw new Error('Usage: relay retention [list | <alias|id> <30m|12h|7d|forever>]');
  }
} else if (command === 'export' && args.length >= 1) {
  state();
  pruneAll();
  const list = Array.isArray(historyStore.load().records) ? historyStore.load().records : [];
  const record = list.find((item) => item.callId === args[0] || item.callId.startsWith(args[0]));
  if (!record) throw new Error(`No call matching ${args[0]}`);
  const text = formatTranscript(record);
  const outIndex = args.indexOf('--out');
  if (outIndex !== -1 && args[outIndex + 1]) {
    const out = resolve(args[outIndex + 1]);
    writeFileSync(out, text);
    chmodSync(out, 0o600);
    console.log(`Wrote ${out}`);
  } else {
    process.stdout.write(text);
  }
} else if (command === 'transcripts' && args.length === 0) {
  state();
  pruneAll();
  const root = join(profileDir, 'transcripts');
  if (!existsSync(root)) console.log('No transcripts saved yet.');
  else {
    let found = false;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const files = readdirSync(join(root, entry.name)).filter((name) => name.endsWith('.md')).sort().reverse();
        if (files.length) { found = true; console.log(`${entry.name}/ (${files.length})`); }
      } else if (entry.name.endsWith('.md')) {
        found = true;
        console.log(`${entry.name.slice(0, -3)} (legacy)`);
      }
    }
    if (!found) console.log('No transcripts saved yet.');
  }
} else if (command === 'history' && args[0] === 'show' && args.length === 2) {
  state();
  const list = Array.isArray(historyStore.load().records) ? historyStore.load().records : [];
  const record = list.find((x) => x.callId === args[1] || x.callId.startsWith(args[1]));
  if (!record) throw new Error(`No call matching ${args[1]}`);
  console.log(JSON.stringify(record, null, 2));
} else if (command === 'attach' && args.length === 1) {
  const me = state().identity.id;
  const attachPath = join(profileDir, `${profile}.attach.sock`);
  if (!existsSync(attachPath)) throw new Error('No running bridge on this machine; start `relay bridge <harness>` first');
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const socket = createConnection(attachPath);
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    try { socket.end(); } catch {}
    input.close();
  };
  socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'attach', callId: args[0] })}\n`));
  socket.on('error', (error) => { console.error(`Attach failed: ${error.message}`); process.exitCode = 1; done(); });
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'attached') console.log(`Attached to ${event.callId}. Type a message, /end [result], or /quit.`);
      else if (event.type === 'message') console.log(`\n${event.from === me ? 'you' : 'peer'}: ${event.text}`);
      else if (event.type === 'ended') {
        console.log(`\nCall ended: ${event.status}${event.reason ? ` (${event.reason})` : ''}${event.result ? ` - ${event.result}` : ''}`);
        done();
      } else if (event.type === 'error') console.error(`Attach error: ${event.error}`);
    }
  });
  socket.on('close', () => { closed = true; input.close(); });
  for await (const line of input) {
    if (closed) break;
    if (line === '/quit') { socket.write('{"type":"close"}\n'); break; }
    if (line.startsWith('/end')) {
      const result = line.slice(4).trim() || null;
      socket.write(`${JSON.stringify({ type: 'end', result })}\n`);
      break;
    }
    if (line.trim()) socket.write(`${JSON.stringify({ type: 'say', text: line })}\n`);
  }
  if (!closed) { socket.write('{"type":"close"}\n'); socket.end(); }
  await new Promise((resolve) => { if (closed) resolve(); else socket.once('close', resolve); });
} else if (['wait', 'reply', 'end'].includes(command)) {
  state();
  const controlPath = join(profileDir, `${profile}.sock`);
  if (!existsSync(controlPath)) throw new Error('No running bridge on this machine; start `relay bridge <harness>` first');
  if (command === 'wait' && args.length !== 1) throw new Error('Usage: relay wait <callId>');
  if (command === 'reply' && args.length !== 2) throw new Error('Usage: relay reply <callId> <text>');
  if (command === 'end' && (args.length < 1 || args.length > 2)) throw new Error('Usage: relay end <callId> [result]');
  const request = command === 'wait' ? { action: 'wait', callId: args[0] }
    : command === 'reply' ? { action: 'reply', callId: args[0], text: args[1] }
      : { action: 'end', callId: args[0], result: args[1] ?? null };
  const result = await sendControl(controlPath, request);
  if (command === 'end') {
    if (!result.ok) { console.error(`End failed: ${result.error}`); process.exitCode = 1; }
    else console.log('Call ended');
  } else {
    console.log(JSON.stringify({ callId: args[0], status: result.status, reason: result.reason ?? null,
      message: result.reason ? describeReason(result.reason) : null, result: result.result ?? null }));
    if (!result.ok) process.exitCode = 1;
  }
} else if (command === 'connect' || command === 'dial' || command === 'bridge' || command === 'call' || command === 'ask') {
  let multi = false;
  let turns = 1;
  if (command === 'call') {
    while (args.length > 0 && args[0].startsWith('--')) {
      if (args[0] === '--multi') { multi = true; args.shift(); }
      else if (args[0] === '--turns') { turns = Number(args[1]); args.splice(0, 2); }
      else break;
    }
    if (!Number.isInteger(turns) || turns < 1 || turns > 20) throw new Error('--turns must be an integer from 1 to 20');
  }
  if ((command === 'dial' || command === 'call') && args.length !== 3) throw new Error(`Usage: relay ${command}${multi ? ' --multi' : ''}${turns > 1 ? ` --turns ${turns}` : ''} <alias> <intent> <task>`);
  if (command === 'ask' && args.length !== 2) throw new Error('Usage: relay ask <alias> <question>');
  if (command === 'ask' && !process.stdin.isTTY) throw new Error('relay ask requires your interactive terminal; agent-initiated calls use relay call');
  if (command === 'bridge' && (args.length !== 1 || !['hermes-gateway', 'openclaw'].includes(args[0]))) throw new Error('Usage: relay bridge hermes-gateway|openclaw');
  const harness = command === 'bridge' ? args[0] : null;
  const value = state();
  const controlPath = join(profileDir, `${profile}.sock`);
  if (multi && !existsSync(controlPath)) throw new Error('relay call --multi requires a running bridge on this machine');
  if ((command === 'call' || command === 'ask') && existsSync(controlPath)) {
    const task = command === 'ask' ? args[1] : args[2];
    const intent = command === 'ask' ? task.slice(0, 160) : args[1];
    const result = await sendDial(controlPath, { action: 'dial', alias: args[0], intent, task, multi, minTurns: turns, ownerInitiated: command === 'ask' });
    if (multi) {
      console.log(JSON.stringify({ callId: result.callId, status: result.status ?? 'dialing' }));
      process.exit(result.ok ? 0 : 1);
    }
    if (!result.ok) {
      console.error(JSON.stringify({
        ok: false,
        error: result.error ?? result.reason ?? 'dial_failed',
        callId: result.callId ?? null,
        status: result.status ?? null,
        reason: result.reason ?? null,
        message: result.error ? `Call failed: ${result.error}` : (result.reason ? describeReason(result.reason) : null),
        result: result.result ?? null,
      }));
      process.exit(1);
    }
    if (command === 'ask') console.log(result.result);
    else console.log(JSON.stringify({ callId: result.callId, status: result.status, reason: result.reason, message: result.reason ? describeReason(result.reason) : null, result: result.result }));
    process.exit();
  }
  const url = process.env.RELAY_URL ?? value.url ?? 'ws://127.0.0.1:8901';
  if (command === 'ask' && !process.env.RELAY_URL && !value.url) throw new Error('No server saved; run relay config set-url <url> first');
  validateUrl(url);
  const client = new RelayClient({ identity: value.identity, url });
  for (const [alias, id] of Object.entries(value.contacts ?? {})) client.addContact(alias, id);
  const aliases = new Map([...client.contacts].map(([alias, id]) => [id, alias]));
  await client.connect();
  const localNearPath = join(profileDir, `${profile}-near.json`);
  if (existsSync(localNearPath)) {
    try { client.publishNear(JSON.parse(readFileSync(localNearPath, 'utf8'))); } catch (error) { console.error(`NEAR registry publish failed: ${error.message}`); }
  }
  if (command === 'call' || command === 'ask') {
    const task = command === 'ask' ? args[1] : args[2];
    const intent = command === 'ask' ? task.slice(0, 160) : args[1];
    const startedAt = new Date().toISOString();
    const callTurns = [{ from: 'me', text: task, at: startedAt }];
    const callId = await client.dial(args[0], { intent, task, ownerInitiated: command === 'ask', minTurns: turns });
    const onMessage = (event) => { if (event.callId === callId) callTurns.push({ from: 'peer', text: event.text, at: new Date().toISOString() }); };
    client.on('call.message', onMessage);
    try {
      const outcome = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Call outcome not received')); }, 260_000);
        const onEnd = (event) => { if (event.callId === callId) { cleanup(); resolve(event); } };
        const onUnavailable = (event) => { if (event.callId === callId) { cleanup(); resolve({ callId, status: 'unavailable', reason: event.reason ?? 'peer_unavailable', result: null }); } };
        const onClose = () => { cleanup(); reject(new Error('RELAY disconnected during call')); };
        const cleanup = () => {
          clearTimeout(timer);
          client.off('call.ended', onEnd);
          client.off('call.unavailable', onUnavailable);
          client.off('connection.closed', onClose);
        };
        client.on('call.ended', onEnd);
        client.on('call.unavailable', onUnavailable);
        client.on('connection.closed', onClose);
      });
      if (command === 'ask') {
        if (outcome.status === 'completed') console.log(outcome.result);
        else console.error(`Call ${outcome.status}: ${describeReason(outcome.reason)}`);
      } else console.log(JSON.stringify({ callId, status: outcome.status, reason: outcome.reason, message: outcome.reason ? describeReason(outcome.reason) : null, result: outcome.result }));
      if (outcome.status !== 'completed') process.exitCode = 1;
      if (outcome.result && !callTurns.some((turn) => turn.from === 'peer' && turn.text === outcome.result)) {
        callTurns.push({ from: 'peer', text: outcome.result, at: new Date().toISOString() });
      }
      persistRecord({
        callId, direction: 'outgoing', peer: client.contacts.get(args[0]), peerAlias: args[0],
        intent, task, startedAt, endedAt: new Date().toISOString(),
        status: outcome.status, reason: outcome.reason ?? null, result: outcome.result ?? null, turns: callTurns,
      });
    } finally { client.off('call.message', onMessage); await client.close(); }
    process.exit();
  }
  console.log(`Connected as ${profile} (${value.identity.id}). Type /help for commands.`);
  const pending = new Map();
  const notificationCodes = new Map();
  const ringMessages = new Map();
  const approved = new Map();
  const active = new Map();
  const callRecords = new Map();
  const callSessions = new Map();
  const acceptedCalls = new Set();
  const missed = [];
  const callReports = new Map();
  const attachers = new Map();
  const ownerIds = new Set((process.env.RELAY_OWNER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean));
  function reloadContacts() {
    const latest = store.load();
    for (const [alias, id] of Object.entries(latest.contacts ?? {})) {
      client.addContact(alias, id);
      aliases.set(id, alias);
    }
  }

  function startCallRecord(callId, { direction, peer, peerAlias, intent, task }) {
    callRecords.set(callId, {
      callId, direction, peer, peerAlias: peerAlias ?? null,
      intent: intent ?? null, task: task ?? null,
      startedAt: new Date().toISOString(), endedAt: null,
      status: null, reason: null, result: null,
      turns: task ? [{ from: direction === 'outgoing' ? 'me' : 'peer', text: task, at: new Date().toISOString() }] : [],
    });
  }

  function finishCallRecord(callId, { status, reason = null, result = null }) {
    const record = callRecords.get(callId);
    if (!record) return;
    record.status = status;
    record.reason = reason;
    record.result = result;
    record.endedAt = new Date().toISOString();
    callRecords.delete(callId);
    persistRecord(record);
  }
  function acceptCall(callId) {
    const call = pending.get(callId);
    if (harness && !call) throw new Error('No pending call with that ID');
    if (harness) approved.set(callId, call);
    client.accept(callId);
    pending.delete(callId);
    notificationCodes.delete(callId);
  }
  function waitForCallOutcome(client, callId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { cleanup(); resolve({ status: 'ignored', reason: 'no_outcome', result: null }); }, 260_000);
      const onEnd = (event) => { if (event.callId === callId) { cleanup(); resolve({ status: event.status, reason: event.reason, result: event.result }); } };
      const onUnavailable = (event) => { if (event.callId === callId) { cleanup(); resolve({ status: 'unavailable', reason: event.reason ?? 'peer_unavailable', result: null }); } };
      const cleanup = () => { clearTimeout(timer); client.off('call.ended', onEnd); client.off('call.unavailable', onUnavailable); };
      client.on('call.ended', onEnd);
      client.on('call.unavailable', onUnavailable);
    });
  }
  const callWaiters = new Map();
  function waitForCallEvent(callId, timeoutMs = 300_000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ status: 'timeout', reason: 'wait_timeout', result: null }), timeoutMs);
      function finish(event) {
        clearTimeout(timer);
        const rest = (callWaiters.get(callId) ?? []).filter((waiter) => waiter !== finish);
        if (rest.length) callWaiters.set(callId, rest); else callWaiters.delete(callId);
        resolve(event);
      }
      callWaiters.set(callId, [...(callWaiters.get(callId) ?? []), finish]);
    });
  }
  function resolveCallWaiters(callId, event) {
    const waiters = callWaiters.get(callId) ?? [];
    callWaiters.delete(callId);
    for (const waiter of waiters) waiter(event);
  }
  const closeControl = harness ? await startApprovalSocket(controlPath, async (request) => {
    if (request.action === 'ping') return { ok: true };
    if (request.action === 'pending') {
      const list = [...pending.entries()].map(([callId, call]) => ({
        callId,
        from: call.from,
        alias: aliases.get(call.from) ?? null,
        intent: call.intent,
        task: call.task,
        deadline: call.deadline ?? null,
        code: notificationCodes.get(callId)?.code ?? null,
      }));
      return { ok: true, dnd, pending: list };
    }
    if (request.action === 'dnd') {
      if (typeof request.dnd !== 'boolean') return { ok: false, error: 'invalid_dnd' };
      dnd = request.dnd;
      client.setDnd(dnd);
      const value = state();
      value.dnd = dnd;
      store.save(value);
      return { ok: true, dnd };
    }
    if (request.action === 'status') {
      const telegramSocket = process.env.RELAY_HERMES_TELEGRAM_SOCKET;
      const telegramSocketReady = Boolean(telegramSocket && existsSync(telegramSocket));
      const webhookConfigured = Boolean(process.env.RELAY_HERMES_WEBHOOK_URL);
      return {
        ok: true,
        dnd,
        pending: pending.size,
        notifications: harness === 'hermes-gateway'
          ? {
            enabled: telegramSocketReady || webhookConfigured,
            channel: telegramSocketReady ? 'telegram' : (webhookConfigured ? 'webhook' : null),
            message: telegramSocketReady
              ? null
              : webhookConfigured
                ? 'Telegram unavailable; approve incoming calls here.'
                : 'Telegram not configured; approve incoming calls here.',
          }
          : null,
      };
    }
    if (request.action === 'nearPublish') {
      if (!request.attestation || typeof request.attestation !== 'object') return { ok: false, error: 'invalid_attestation' };
      client.publishNear(request.attestation);
      return { ok: true };
    }
    if (request.action === 'nearLookup') {
      if (typeof request.relayId !== 'string') return { ok: false, error: 'invalid_relay_id' };
      const attestation = await client.lookupNear(request.relayId);
      return { ok: true, relayId: request.relayId, attestation };
    }
    if (request.action === 'callStatus') {
      if (typeof request.callId !== 'string') return { ok: false, error: 'invalid_call_id' };
      const record = callRecords.get(request.callId);
      if (record) return { ok: true, callId: request.callId, status: record.status ?? 'dialing', reason: record.reason ?? null, result: record.result ?? null };
      const saved = (historyStore.load().records ?? []).find((item) => item.callId === request.callId);
      if (saved) return { ok: true, callId: request.callId, status: saved.status, reason: saved.reason ?? null, result: saved.result ?? null };
      return { ok: true, callId: request.callId, status: 'unknown' };
    }
    if (request.action === 'accept' || request.action === 'reject') {
      console.log(`Approval ${request.action} for ${request.callId}`);
      const pendingCall = pending.get(request.callId);
      const entry = notificationCodes.get(request.callId);
      if (!pendingCall || !entry) { console.log(`Approval rejected: no pending call ${request.callId}`); return { ok: false, error: 'no_pending_call' }; }
      if (entry.attempts++ >= 3 || !sameCode(entry.code, request.code)) { console.log(`Approval rejected: invalid code for ${request.callId}`); return { ok: false, error: 'invalid_code' }; }
      if (request.action === 'accept' && !dnd) { acceptCall(request.callId); return { ok: true }; }
      if (request.action === 'reject') { client.reject(request.callId); pending.delete(request.callId); notificationCodes.delete(request.callId); return { ok: true }; }
      return { ok: false, error: 'invalid_decision' };
    }
    if (request.action === 'dial') {
      reloadContacts();
      const { alias, intent, task } = request;
      const isId = /^rly_[0-9a-f-]{36}$/.test(alias);
      if (!client.contacts.has(alias) && !isId) return { ok: false, error: 'unknown_alias' };
      if (typeof intent !== 'string' || !intent.trim() || typeof task !== 'string' || !task.trim()) return { ok: false, error: 'invalid_dial' };
      const callId = await client.dial(alias, { intent: intent.slice(0, 160), task: task.slice(0, 2000), minTurns: request.minTurns, ownerInitiated: request.ownerInitiated === true });
      startCallRecord(callId, { direction: 'outgoing', peer: client.contacts.get(alias) ?? (isId ? alias : undefined), peerAlias: isId ? null : alias, intent, task });
      if (request.multi) return { ok: true, callId, status: 'dialing' };
      const outcome = await waitForCallOutcome(client, callId);
      return { ok: outcome.status === 'completed', callId, status: outcome.status, reason: outcome.reason, result: outcome.result };
    }
    if (request.action === 'wait') {
      if (typeof request.callId !== 'string') return { ok: false, error: 'invalid_call_id' };
      const event = await waitForCallEvent(request.callId);
      return { ok: event.status === 'active' || event.status === 'completed', callId: request.callId, ...event };
    }
    if (request.action === 'reply') {
      if (typeof request.callId !== 'string' || typeof request.text !== 'string' || !request.text.trim()) return { ok: false, error: 'invalid_reply' };
      if (!acceptedCalls.has(request.callId)) return { ok: false, error: 'call_not_active' };
      client.say(request.callId, request.text.slice(0, 4000));
      const record = callRecords.get(request.callId);
      if (record) record.turns.push({ from: 'me', text: request.text.slice(0, 4000), at: new Date().toISOString() });
      const event = await waitForCallEvent(request.callId);
      return { ok: event.status === 'active' || event.status === 'completed', callId: request.callId, ...event };
    }
    if (request.action === 'end') {
      if (typeof request.callId !== 'string') return { ok: false, error: 'invalid_call_id' };
      client.end(request.callId, request.result ?? null);
      return { ok: true };
    }
    if (request.action === 'details') {
      const info = callReports.get(request.callId);
      if (!info) return { ok: false, error: 'no_details' };
      return { ok: true, callId: request.callId, details: formatDetails(info) };
    }
    return { ok: false, error: 'invalid_request' };
  }) : null;
  function broadcastAttach(callId, event) {
    const set = attachers.get(callId);
    if (!set) return;
    const line = `${JSON.stringify(event)}\n`;
    for (const socket of set) socket.write(line);
    if (event.type === 'ended') {
      for (const socket of set) socket.end();
      attachers.delete(callId);
    }
  }
  const closeAttach = harness ? await startAttachServer(join(profileDir, `${profile}.attach.sock`), {
    onOpen: (callId, socket) => {
      if (!acceptedCalls.has(callId) && !callSessions.has(callId) && !callRecords.has(callId)) return false;
      const set = attachers.get(callId) ?? new Set();
      set.add(socket);
      attachers.set(callId, set);
      socket.on('close', () => {
        set.delete(socket);
        if (set.size === 0) attachers.delete(callId);
      });
      return true;
    },
    onSay: (callId, text) => client.say(callId, text),
    onEnd: (callId, result) => client.end(callId, result),
  }) : null;
  let dnd = Boolean(value.dnd);
  if (dnd) client.setDnd(true);
  let blocked = new Set(value.blocked ?? []);
  client.setBlocked([...blocked]);
  const statePath = join(profileDir, `${profile}.json`);
  async function flushMissed() {
    if (missed.length === 0) return;
    const items = missed.splice(0, missed.length);
    const lines = items.slice(0, 10).map((record) => {
      const when = record.startedAt ? record.startedAt.slice(0, 16).replace('T', ' ') : '?';
      return `• ${record.peerAlias ?? record.peer}: ${record.intent ?? '(no intent)'} (${when})`;
    });
    const text = `📬 While on DND: ${items.length} missed call${items.length === 1 ? '' : 's'}\n\n${lines.join('\n')}${items.length > 10 ? `\n…and ${items.length - 10} more` : ''}\n\nRun "relay history" for details.`;
    console.log(text);
    try {
      if (harness === 'openclaw') {
        await sendOpenClawNotice({ bin: process.env.RELAY_OPENCLAW_BIN,
          ownerId: process.env.RELAY_OPENCLAW_TELEGRAM_OWNER, text, token: openclawToken });
      } else if (harness === 'hermes-gateway' && process.env.RELAY_HERMES_TELEGRAM_SOCKET) {
        await sendInlineNotice(process.env.RELAY_HERMES_TELEGRAM_SOCKET, text);
      }
    } catch (error) {
      console.error(`Missed-call summary not sent: ${error.message}`);
    }
  }
  const sameSet = (a, b) => a.size === b.size && [...a].every((item) => b.has(item));
  const refreshState = () => {
    const next = store.load();
    const nextDnd = Boolean(next.dnd);
    if (nextDnd !== dnd) {
      dnd = nextDnd;
      client.setDnd(dnd);
      if (!dnd) flushMissed();
    }
    const nextBlocked = new Set(next.blocked ?? []);
    if (!sameSet(nextBlocked, blocked)) {
      blocked = nextBlocked;
      client.setBlocked([...blocked]);
      console.log(`Blocklist updated (${blocked.size} caller${blocked.size === 1 ? '' : 's'})`);
    }
  };
  watchFile(statePath, { interval: 500 }, refreshState);
  client.on('call.missed', (event) => {
    const at = new Date(event.at ?? Date.now()).toISOString();
    const record = { callId: event.callId, direction: 'incoming', peer: event.from, peerAlias: aliases.get(event.from) ?? null,
      intent: event.intent ?? null, task: event.task ?? null, startedAt: at, endedAt: at,
      status: 'missed', reason: event.reason ?? 'recipient_dnd', result: null, turns: [] };
    persistRecord(record);
    missed.push(record);
    console.log(`Missed call ${event.callId} from ${aliases.get(event.from) ?? event.from} while on DND`);
  });
  client.on('missed.list', ({ calls }) => {
    if (!Array.isArray(calls) || calls.length === 0) return;
    for (const call of calls) {
      const at = new Date(call.at ?? Date.now()).toISOString();
      const record = { callId: call.callId, direction: 'incoming', peer: call.from, peerAlias: aliases.get(call.from) ?? null,
        intent: call.intent ?? null, task: call.task ?? null, startedAt: at, endedAt: at,
        status: 'missed', reason: call.reason ?? 'peer_offline', result: null, turns: [] };
      persistRecord(record);
      missed.push(record);
    }
    console.log(`Queued missed calls while offline: ${calls.length}`);
    if (!dnd) flushMissed();
  });
  client.on('call.ringing', (event) => {
    reloadContacts();
    const { callId, from, intent, task, ownerInitiated } = event;
    const trusted = ownerIds.has(from) || aliases.has(from);
    if (blocked.has(from)) {
      const at = new Date().toISOString();
      persistRecord({ callId, direction: 'incoming', peer: from, peerAlias: aliases.get(from) ?? null,
        intent, task, startedAt: at, endedAt: at, status: 'blocked', reason: 'caller_blocked', result: null, turns: [] });
      console.log(`Blocked call ${callId} from ${from}`);
      client.reject(callId);
      return;
    }
    pending.set(callId, event);
    startCallRecord(callId, { direction: 'incoming', peer: from, peerAlias: aliases.get(from) ?? null, intent, task });
    const ringSeconds = event.deadline ? Math.max(0, Math.round((event.deadline - Date.now()) / 1000)) : 30;
    console.log(`\nINCOMING ${callId} from ${aliases.get(from) ?? from}${trusted ? '' : ' (unknown caller)'}\nIntent: ${intent}\nTask: ${task}\n/accept ${callId} or /reject ${callId} (expires in ${ringSeconds}s)`);
    if (harness && ownerIds.has(from) && ownerInitiated && !dnd) {
      console.log(`Owner initiated call ${callId}; connecting`);
      acceptCall(callId);
    } else if (harness === 'hermes-gateway' && !dnd) {
      const code = approvalCode();
      notificationCodes.set(callId, { code, attempts: 0 });
      const ring = { call: event, alias: aliases.get(from) ?? from, code, trusted };
      (async () => {
        try {
          if (!process.env.RELAY_HERMES_TELEGRAM_SOCKET) throw new Error('No Telegram button handler configured');
          const result = await sendInlineRing(process.env.RELAY_HERMES_TELEGRAM_SOCKET, ring);
          if (result?.messageId) ringMessages.set(callId, {
            kind: 'hermes', chatId: result.chatId, messageId: result.messageId,
          });
        } catch (buttonError) {
          try {
            await sendTelegramRing({ url: process.env.RELAY_HERMES_WEBHOOK_URL,
              secretFile: process.env.RELAY_HERMES_WEBHOOK_SECRET_FILE, ...ring });
            console.warn(`Call ${callId}: Telegram buttons unavailable; sent text notification`);
          } catch (fallbackError) {
            console.error(`Call ${callId} could not notify Telegram: ${buttonError.message}; ${fallbackError.message}`);
          }
        }
      })();
    } else if (harness === 'openclaw' && !dnd) {
      const code = approvalCode();
      notificationCodes.set(callId, { code, attempts: 0 });
      sendOpenClawRing({ bin: process.env.RELAY_OPENCLAW_BIN,
        ownerId: process.env.RELAY_OPENCLAW_TELEGRAM_OWNER,
        call: event, alias: aliases.get(from) ?? from, code, trusted, token: openclawToken }).then((result) => {
        if (openclawToken && result?.message_id) {
          ringMessages.set(callId, {
            kind: 'openclaw',
            chatId: result.chat?.id ?? process.env.RELAY_OPENCLAW_TELEGRAM_OWNER,
            messageId: result.message_id,
            token: openclawToken,
          });
        }
      }).catch((error) => {
        console.error(`Call ${callId} could not notify Telegram: ${error.message}`);
      });
    }
  });
  client.on('call.dialing', ({ callId }) => console.log(`Ringing ${callId}`));
  client.on('call.accepted', ({ callId }) => {
    acceptedCalls.add(callId);
    console.log(`Call connected ${callId}; /say ${callId} <message>`);
    const call = approved.get(callId);
    if (!call) return;
    approved.delete(callId);
    const trusted = ownerIds.has(call.from) || aliases.has(call.from);
    console.log(`Call ${callId}: ${trusted ? 'known contact - full context' : 'unknown caller - minimal context'}`);
    const controller = new AbortController();
    active.set(callId, controller);
    const session = { call, controller, transcript: [], turns: 0, idle: null, queue: Promise.resolve() };
    callSessions.set(callId, session);
    enqueueTurn(callId, session);
  });

  function enqueueTurn(callId, session) {
    session.queue = session.queue
      .then(() => answerTurn(callId, session))
      .catch((error) => {
        if (active.get(callId) !== session.controller) return;
        console.error(`${harness} call failed: ${error.message}`);
        client.fail(callId);
      });
  }

  async function answerTurn(callId, session) {
    if (active.get(callId) !== session.controller) return;
    clearTimeout(session.idle);
    const answer = await invokeHarness(harness, { ...session.call, transcript: session.transcript }, {
      signal: session.controller.signal,
      timeoutMs: Number(process.env.RELAY_HARNESS_TIMEOUT_MS ?? '110000'),
      policy: ownerIds.has(session.call.from) || aliases.has(session.call.from) ? 'full' : 'limited',
      command: harness === 'openclaw' ? process.env.RELAY_OPENCLAW_BIN : process.env.RELAY_HERMES_BIN,
      config: process.env.RELAY_OPENCLAW_CONFIG, cwd: process.env.RELAY_OPENCLAW_CWD,
      stateDir: process.env.RELAY_OPENCLAW_STATE_DIR,
      limitedConfig: process.env.RELAY_OPENCLAW_UNKNOWN_CONFIG,
      limitedCwd: process.env.RELAY_OPENCLAW_UNKNOWN_CWD,
      identity: {
        agentName: process.env.RELAY_AGENT_NAME,
        ownerName: process.env.RELAY_OWNER_NAME,
        role: process.env.RELAY_AGENT_ROLE,
      },
    });
    if (active.get(callId) !== session.controller) return;
    const { text: withoutReport, report } = extractReport(answer);
    const { text, done } = stripDone(withoutReport);
    session.transcript.push({ from: 'me', text });
    session.turns += 1;
    const record = callRecords.get(callId);
    if (record) {
      record.turns.push({ from: 'me', text, at: new Date().toISOString() });
      if (report) record.report = report.slice(0, 300);
    }
    const maxTurns = Math.max(1, Number(process.env.RELAY_MAX_TURNS ?? '8'));
    const minTurns = Math.max(1, Number(session.call.minTurns ?? process.env.RELAY_MIN_TURNS ?? '1'));
    const idleMs = Math.max(1000, Number(process.env.RELAY_TURN_IDLE_MS ?? '30000'));
    if ((done && session.turns >= minTurns) || session.turns >= maxTurns) {
      client.end(callId, text.slice(0, 4000));
    } else {
      client.say(callId, text.slice(0, 4000));
      if (!(attachers.get(callId)?.size)) {
        session.idle = setTimeout(() => {
          if (active.get(callId) === session.controller) client.end(callId, text.slice(0, 4000));
        }, idleMs);
        session.idle.unref?.();
      }
    }
  }

  function rememberReport(callId, info) {
    callReports.set(callId, { ...info, at: Date.now() });
    if (callReports.size > 100) {
      const oldest = [...callReports.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) callReports.delete(oldest[0]);
    }
  }
  function formatDetails(info) {
    const lines = [`📞 ${info.peer ?? 'An agent'} called — ${info.intent ?? 'no intent'}`,
      `Status: ${info.status}${info.reason ? ` (${describeReason(info.reason)})` : ''}`];
    if (info.task) lines.push('', `Asked: ${String(info.task).slice(0, 500)}`);
    if (info.report) lines.push('', info.report);
    if (info.result) lines.push('', `Answer: ${String(info.result).slice(0, 1200)}`);
    return lines.join('\n');
  }
  async function sendCallEndedNotice({ callId, peer, status, reason, result, direction, intent }) {
    const text = direction === 'incoming'
      ? `📞 ${peer ?? 'An agent'} called — ${intent ?? 'no intent'}\n📴 Call ended (${status})`
      : `📴 Call ended${peer ? ` — ${peer}` : ''}\nStatus: ${status}${reason ? ` (${describeReason(reason)})` : ''}`;
    try {
      if (harness === 'openclaw') {
        await sendOpenClawNotice({ bin: process.env.RELAY_OPENCLAW_BIN,
          ownerId: process.env.RELAY_OPENCLAW_TELEGRAM_OWNER, text, silent: true, token: openclawToken });
      } else if (harness === 'hermes-gateway' && process.env.RELAY_HERMES_TELEGRAM_SOCKET) {
        const buttons = direction === 'incoming'
          ? [{ text: 'Details', data: `rc:d:${callId}` }, { text: 'OK', data: `rc:o:${callId}` }]
          : null;
        await sendInlineNotice(process.env.RELAY_HERMES_TELEGRAM_SOCKET, text, { silent: true, buttons });
      }
    } catch (error) {
      console.error(`Call-ended notice not sent: ${error.message}`);
    }
  }
  client.on('call.message', ({ callId, from, text }) => {
    const record = callRecords.get(callId);
    if (record) record.turns.push({ from: from === value.identity.id ? 'me' : 'peer', text, at: new Date().toISOString() });
    console.log(`\n${aliases.get(from) ?? from} [${callId}]: ${text}`);
    const session = callSessions.get(callId);
    if (session && from !== value.identity.id) {
      clearTimeout(session.idle);
      session.transcript.push({ from: 'peer', text });
      enqueueTurn(callId, session);
    }
    resolveCallWaiters(callId, { status: 'active', result: text });
    broadcastAttach(callId, { type: 'message', from, text });
  });
  client.on('call.ended', ({ callId, status, reason, result }) => {
    const record = callRecords.get(callId);
    const ringMessage = ringMessages.get(callId);
    ringMessages.delete(callId);
    const wasActive = acceptedCalls.has(callId);
    acceptedCalls.delete(callId);
    const session = callSessions.get(callId);
    if (session) clearTimeout(session.idle);
    callSessions.delete(callId);
    pending.delete(callId);
    notificationCodes.delete(callId);
    approved.delete(callId);
    active.get(callId)?.abort();
    active.delete(callId);
    if (ringMessage && reason === 'ring_timeout') {
      const alias = record?.peerAlias ?? record?.peer ?? 'An agent';
      const text = `📴 Missed RELAY call\n\nFrom: ${alias}\nIntent: ${record?.intent ?? 'no intent'}`;
      if (ringMessage.kind === 'openclaw') {
        editTelegramText({ token: ringMessage.token, chatId: ringMessage.chatId,
          messageId: ringMessage.messageId, text }).catch((error) => {
          console.error(`Could not mark call ${callId} as missed: ${error.message}`);
        });
      } else if (ringMessage.kind === 'hermes' && process.env.RELAY_HERMES_TELEGRAM_SOCKET) {
        sendInlineResolve(process.env.RELAY_HERMES_TELEGRAM_SOCKET, { callId, text }).catch((error) => {
          console.error(`Could not mark call ${callId} as missed: ${error.message}`);
        });
      }
    }
    if (record) rememberReport(callId, { peer: record.peerAlias ?? record.peer, direction: record.direction,
      intent: record.intent, task: record.task, result, report: record.report, status, reason });
    broadcastAttach(callId, { type: 'ended', status, reason, result });
    finishCallRecord(callId, { status, reason, result });
    resolveCallWaiters(callId, { status, reason, result });
    console.log(`Call ${callId} ${status}${result ? `; result: ${result}` : ''}`);
    if (wasActive) sendCallEndedNotice({ callId, peer: record?.peerAlias ?? record?.peer, status, reason, result,
      direction: record?.direction, intent: record?.intent });
  });
  client.on('call.unavailable', ({ callId, reason = 'peer_unavailable' }) => {
    finishCallRecord(callId, { status: 'unavailable', reason });
    resolveCallWaiters(callId, { status: 'unavailable', reason, result: null });
    console.log(`Call ${callId}: unavailable (${describeReason(reason)})`);
  });
  client.on('presence.updated', ({ dnd }) => console.log(`DND ${dnd ? 'on' : 'off'}`));
  client.on('protocol.error', ({ code, callId }) => {
    console.log(`RELAY error: ${code}${callId ? ` (${callId})` : ''}`);
    if (callId) resolveCallWaiters(callId, { status: 'error', reason: code, result: null });
  });
  client.on('connection.closed', () => console.log('Disconnected from RELAY'));
  if (command === 'dial') {
    const callId = await client.dial(args[0], { intent: args[1], task: args[2] });
    startCallRecord(callId, { direction: 'outgoing', peer: client.contacts.get(args[0]), peerAlias: args[0], intent: args[1], task: args[2] });
  }
  const help = '/dial <alias> <intent> :: <task> | /accept <callId> | /reject <callId> | /say <callId> <text> | /end <callId> [result] | /dnd on|off | /quit';
  if (harness) console.log(`Bridge: accepted calls invoke ${harness} once and return its answer.`);
  if (process.env.RELAY_HEADLESS === '1' && !harness) throw new Error('Headless mode requires a harness bridge');
  if (process.env.RELAY_HEADLESS === '1' && harness === 'hermes-gateway' &&
      !((process.env.RELAY_HERMES_TELEGRAM_SOCKET && existsSync(process.env.RELAY_HERMES_TELEGRAM_SOCKET)) || process.env.RELAY_HERMES_WEBHOOK_URL)) {
    console.warn('Telegram gateway not detected; Telegram notifications are disabled. Use the web UI to approve incoming calls.');
  }
  if (process.env.RELAY_HEADLESS === '1') {
    await new Promise((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
      client.once('connection.closed', resolve);
    });
  } else {
    const input = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    for await (const line of input) {
    try {
      if (line === '/help') console.log(help);
      else if (line === '/quit') break;
      else if (line.startsWith('/dial ')) {
        const match = /^\/dial (\S+) (.+?) :: (.+)$/.exec(line);
        if (!match) throw new Error('Usage: /dial <alias> <intent> :: <task>');
        const callId = await client.dial(match[1], { intent: match[2], task: match[3] });
        startCallRecord(callId, { direction: 'outgoing', peer: client.contacts.get(match[1]), peerAlias: match[1], intent: match[2], task: match[3] });
      } else if (line.startsWith('/accept ')) acceptCall(line.slice(8).trim());
      else if (line.startsWith('/reject ')) { pending.delete(line.slice(8).trim()); client.reject(line.slice(8).trim()); }
      else if (line.startsWith('/say ')) {
        const match = /^\/say (\S+) (.+)$/.exec(line);
        if (!match) throw new Error('Usage: /say <callId> <text>');
        client.say(match[1], match[2]);
      } else if (line.startsWith('/end ')) {
        const match = /^\/end (\S+)(?: (.+))?$/.exec(line);
        client.end(match[1], match[2] ?? null);
      } else if (line === '/dnd on' || line === '/dnd off') client.setDnd(line === '/dnd on');
      else console.log(help);
    } catch (error) { console.error(error.message); }
    }
  }
  unwatchFile(statePath, refreshState);
  await closeControl?.();
  await closeAttach?.();
  const unfinished = [...active.values()];
  active.clear();
  for (const controller of unfinished) controller.abort();
  await client.close();
} else if (command === 'web') {
  const port = Number(process.env.RELAY_WEB_PORT ?? '8788');
  const host = process.env.RELAY_WEB_HOST ?? '127.0.0.1';
  const { startWeb } = await import('../src/web.js');
  const { url } = await startWeb({ profileDir, profile, port, host });
  console.log(`RELAY phonebook: ${url}`);
} else {
  console.log('relay profiles | init | id | config set-url <url> | dnd on|off | block <alias|id> | unblock <alias|id> | blocked | contacts add <alias> <relay-id> | contacts list | history [show <call-id>] | ask <alias> <question> | call [--multi] <alias> <intent> <task> | attach <call-id> | export <call-id> [--out <file>] | transcripts | near link|show|verify <file>|lookup <relay-id>|publish | web | retention [list | <alias|id> <30m|12h|7d|forever>] | wait <call-id> | reply <call-id> <text> | end <call-id> [result] | accept|reject <call-id> <code> | bridge hermes-gateway|openclaw');
  if (command) process.exitCode = 1;
}
