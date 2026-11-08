#!/usr/bin/env node
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync, watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { extractReport, invokeHarness, stripDone } from '../src/adapters.js';
import { createIdentity } from '../src/identity.js';
import { RelayClient } from '../src/client.js';
import { jsonStore } from '../src/store.js';
import { approvalCode, sameCode, sendControl, sendDecision, sendDial, sendInlineNotice, sendInlineRing, sendOpenClawNotice, sendOpenClawRing, sendTelegramRing, startApprovalSocket } from '../src/notifications.js';

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
  return value;
}

function validateUrl(url) {
  if (!/^wss?:\/\//.test(url)) throw new Error('RELAY URL must be ws:// or wss://');
  if (url.startsWith('ws://') && !/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\]|100\.[0-9.]+)(:|\/|$)/.test(url)) {
    throw new Error('Plain WebSocket is allowed only on loopback or a Tailscale IPv4 address; use wss:// elsewhere');
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

function persistRecord(record) {
  const history = historyStore.load();
  const list = Array.isArray(history.records) ? history.records : [];
  list.unshift(record);
  history.records = list.slice(0, 200);
  historyStore.save(history);
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
} else if (command === 'history' && args.length === 0) {
  state();
  const list = Array.isArray(historyStore.load().records) ? historyStore.load().records : [];
  if (list.length === 0) { console.log('No calls recorded yet.'); }
  else for (const r of list) {
    const dir = r.direction === 'incoming' ? '\u2190' : '\u2192';
    const when = r.startedAt ? r.startedAt.slice(0, 19).replace('T', ' ') : '?';
    const who = r.peerAlias ?? r.peer ?? '?';
    console.log(`${when}  ${dir} ${who}  ${r.status}${r.result ? `  ${String(r.result).slice(0, 60)}` : ''}  (${r.callId.slice(0, 8)})`);
  }
} else if (command === 'history' && args[0] === 'show' && args.length === 2) {
  state();
  const list = Array.isArray(historyStore.load().records) ? historyStore.load().records : [];
  const record = list.find((x) => x.callId === args[1] || x.callId.startsWith(args[1]));
  if (!record) throw new Error(`No call matching ${args[1]}`);
  console.log(JSON.stringify(record, null, 2));
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
  const multi = command === 'call' && args[0] === '--multi';
  if (multi) args.shift();
  if ((command === 'dial' || command === 'call') && args.length !== 3) throw new Error(`Usage: relay ${command}${multi ? ' --multi' : ''} <alias> <intent> <task>`);
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
    const result = await sendDial(controlPath, { action: 'dial', alias: args[0], intent, task, multi });
    if (multi) {
      console.log(JSON.stringify({ callId: result.callId, status: result.status ?? 'dialing' }));
      process.exit(result.ok ? 0 : 1);
    }
    if (command === 'ask') {
      if (result.ok) console.log(result.result);
      else console.error(`Call ${result.status ?? 'failed'}: ${describeReason(result.reason ?? result.error)}`);
    } else console.log(JSON.stringify({ callId: result.callId, status: result.status, reason: result.reason, message: result.reason ? describeReason(result.reason) : null, result: result.result }));
    if (!result.ok) process.exitCode = 1;
    process.exit();
  }
  const url = process.env.RELAY_URL ?? value.url ?? 'ws://127.0.0.1:8901';
  if (command === 'ask' && !process.env.RELAY_URL && !value.url) throw new Error('No server saved; run relay config set-url <url> first');
  validateUrl(url);
  const client = new RelayClient({ identity: value.identity, url });
  for (const [alias, id] of Object.entries(value.contacts ?? {})) client.addContact(alias, id);
  const aliases = new Map([...client.contacts].map(([alias, id]) => [id, alias]));
  await client.connect();
  if (command === 'call' || command === 'ask') {
    const task = command === 'ask' ? args[1] : args[2];
    const intent = command === 'ask' ? task.slice(0, 160) : args[1];
    const startedAt = new Date().toISOString();
    const callId = client.dial(args[0], { intent, task, ownerInitiated: command === 'ask' });
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
      persistRecord({
        callId, direction: 'outgoing', peer: client.contacts.get(args[0]), peerAlias: args[0],
        intent, task, startedAt, endedAt: new Date().toISOString(),
        status: outcome.status, reason: outcome.reason ?? null, result: outcome.result ?? null, turns: [],
      });
    } finally { await client.close(); }
    process.exit();
  }
  console.log(`Connected as ${profile} (${value.identity.id}). Type /help for commands.`);
  const pending = new Map();
  const notificationCodes = new Map();
  const approved = new Map();
  const active = new Map();
  const callRecords = new Map();
  const callSessions = new Map();
  const acceptedCalls = new Set();
  const missed = [];
  const callReports = new Map();
  const ownerIds = new Set((process.env.RELAY_OWNER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean));

  function startCallRecord(callId, { direction, peer, peerAlias, intent, task }) {
    callRecords.set(callId, {
      callId, direction, peer, peerAlias: peerAlias ?? null,
      intent: intent ?? null, task: task ?? null,
      startedAt: new Date().toISOString(), endedAt: null,
      status: null, reason: null, result: null, turns: [],
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
      const { alias, intent, task } = request;
      if (!client.contacts.has(alias)) return { ok: false, error: 'unknown_alias' };
      if (typeof intent !== 'string' || !intent.trim() || typeof task !== 'string' || !task.trim()) return { ok: false, error: 'invalid_dial' };
      const callId = client.dial(alias, { intent: intent.slice(0, 160), task: task.slice(0, 2000) });
      startCallRecord(callId, { direction: 'outgoing', peer: client.contacts.get(alias), peerAlias: alias, intent, task });
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
  client.on('call.ringing', (event) => {
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
          await sendInlineRing(process.env.RELAY_HERMES_TELEGRAM_SOCKET, ring);
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
        call: event, alias: aliases.get(from) ?? from, code, trusted, token: openclawToken }).catch((error) => {
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
    const idleMs = Math.max(1000, Number(process.env.RELAY_TURN_IDLE_MS ?? '20000'));
    if (done || session.turns >= maxTurns) {
      client.end(callId, text.slice(0, 4000));
    } else {
      client.say(callId, text.slice(0, 4000));
      session.idle = setTimeout(() => {
        if (active.get(callId) === session.controller) client.end(callId, text.slice(0, 4000));
      }, idleMs);
      session.idle.unref?.();
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
  });
  client.on('call.ended', ({ callId, status, reason, result }) => {
    const record = callRecords.get(callId);
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
    if (record) rememberReport(callId, { peer: record.peerAlias ?? record.peer, direction: record.direction,
      intent: record.intent, task: record.task, result, report: record.report, status, reason });
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
    const callId = client.dial(args[0], { intent: args[1], task: args[2] });
    startCallRecord(callId, { direction: 'outgoing', peer: client.contacts.get(args[0]), peerAlias: args[0], intent: args[1], task: args[2] });
  }
  const help = '/dial <alias> <intent> :: <task> | /accept <callId> | /reject <callId> | /say <callId> <text> | /end <callId> [result] | /dnd on|off | /quit';
  if (harness) console.log(`Bridge: accepted calls invoke ${harness} once and return its answer.`);
  if (process.env.RELAY_HEADLESS === '1' && !harness) throw new Error('Headless mode requires a harness bridge');
  if (process.env.RELAY_HEADLESS === '1' && harness === 'hermes-gateway' &&
      (!process.env.RELAY_HERMES_TELEGRAM_SOCKET || !process.env.RELAY_HERMES_WEBHOOK_URL || !process.env.RELAY_HERMES_WEBHOOK_SECRET_FILE)) {
    throw new Error('Headless Hermes Gateway bridge requires Telegram button and fallback webhook settings');
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
        const callId = client.dial(match[1], { intent: match[2], task: match[3] });
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
  const unfinished = [...active.values()];
  active.clear();
  for (const controller of unfinished) controller.abort();
  await client.close();
} else {
  console.log('relay profiles | init | id | config set-url <url> | dnd on|off | block <alias|id> | unblock <alias|id> | blocked | contacts add <alias> <relay-id> | contacts list | history [show <call-id>] | ask <alias> <question> | call [--multi] <alias> <intent> <task> | wait <call-id> | reply <call-id> <text> | end <call-id> [result] | accept|reject <call-id> <code> | bridge hermes-gateway|openclaw');
  if (command) process.exitCode = 1;
}
