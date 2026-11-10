import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { RelayClient } from '../src/client.js';
import { createIdentity } from '../src/identity.js';
import { createRelayServer } from '../src/server.js';
import { jsonStore } from '../src/store.js';
import { formatTranscript } from '../src/transcript.js';
import { createEncryptionKeyPair, decryptPayload, deriveCallKey, encryptPayload, signEnvelope, verifyEnvelope } from '../src/crypto.js';
import { attestationMessage, base58Encode, nep413Payload, verifyAttestation, verifyNearSignature } from '../src/near.js';
import { createPublicKey, randomBytes, sign } from 'node:crypto';
import { invokeHarness, buildCallPrompt, redactSharedAnswer, stripDone, extractReport } from '../src/adapters.js';

function next(client, type, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off(type, onEvent); reject(new Error(`Timed out waiting for ${type}`)); }, timeout);
    function onEvent(event) { clearTimeout(timer); resolve(event); }
    client.once(type, onEvent);
  });
}

async function setup({ ringMs = 70, callMs = 100 } = {}) {
  const server = createRelayServer({ ringMs, callMs });
  const url = await server.listen();
  const alice = new RelayClient({ identity: createIdentity(), url });
  const bob = new RelayClient({ identity: createIdentity(), url });
  await Promise.all([alice.connect(), bob.connect()]);
  alice.addContact('bob', bob.identity.id);
  return { server, url, alice, bob, async close() {
    await Promise.all([alice.close(), bob.close()]);
    await server.close();
  } };
}

test('two peers dial by alias, accept, exchange messages and return a result', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const ringing = next(env.bob, 'call.ringing');
  const callId = await env.alice.dial('bob', { intent: 'Plan a meeting', task: 'Find a time' });
  assert.equal((await ringing).intent, 'Plan a meeting');
  const accepted = next(env.alice, 'call.accepted');
  env.bob.accept(callId);
  assert.equal((await accepted).callId, callId);
  const received = next(env.bob, 'call.message');
  env.alice.say(callId, 'Does Tuesday work?');
  assert.equal((await received).text, 'Does Tuesday work?');
  const result = next(env.alice, 'call.ended');
  env.bob.end(callId, 'Tuesday works.');
  assert.deepEqual(((await result).result), 'Tuesday works.');
});

test('unanswered calls expire, and DND makes the recipient unavailable', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const ignored = next(env.alice, 'call.ended');
  await env.alice.dial('bob', { intent: 'Research', task: 'Summarize a document' });
  assert.equal((await ignored).status, 'ignored');
  const updated = next(env.bob, 'presence.updated');
  env.bob.setDnd(true);
  await updated;
  const missed = next(env.bob, 'call.missed');
  const unavailable = next(env.alice, 'call.unavailable');
  await env.alice.dial('bob', { intent: 'Research', task: 'Summarize a document' });
  const dndEvent = await unavailable;
  assert.equal(dndEvent.type, 'call.unavailable');
  assert.equal(dndEvent.reason, 'recipient_dnd');
  const missedEvent = await missed;
  assert.equal(missedEvent.reason, 'recipient_dnd');
  assert.equal(missedEvent.intent, 'Research');
  await env.bob.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const offline = next(env.alice, 'call.unavailable');
  await env.alice.dial('bob', { intent: 'Research', task: 'Summarize a document' });
  assert.equal((await offline).reason, 'peer_offline');
});

test('a blocked caller is rejected before the call rings', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const updated = next(env.bob, 'blocklist.updated');
  env.bob.setBlocked([env.alice.identity.id]);
  assert.equal((await updated).blocked.length, 1);
  let rang = false;
  env.bob.once('call.ringing', () => { rang = true; });
  const unavailable = next(env.alice, 'call.unavailable');
  await env.alice.dial('bob', { intent: 'Research', task: 'Check a claim' });
  assert.equal((await unavailable).reason, 'caller_blocked');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(rang, false);
});

test('calls have a hard deadline even if the peers keep sending messages', async (t) => {
  const env = await setup({ callMs: 80 });
  t.after(() => env.close());
  const ringing = next(env.bob, 'call.ringing');
  const callId = await env.alice.dial('bob', { intent: 'Research', task: 'Check a claim' });
  await ringing;
  const accepted = next(env.alice, 'call.accepted');
  env.bob.accept(callId);
  await accepted;
  const timeout = next(env.alice, 'call.ended');
  env.alice.say(callId, 'Still here');
  assert.equal((await timeout).status, 'timeout');
});

test('the recipient can reject without opening a session', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const ringing = next(env.bob, 'call.ringing');
  const callId = await env.alice.dial('bob', { intent: 'Meeting', task: 'Schedule a meeting' });
  await ringing;
  const ended = next(env.alice, 'call.ended');
  env.bob.reject(callId);
  assert.equal((await ended).status, 'rejected');
  const error = next(env.alice, 'protocol.error');
  env.alice.send({ type: 'call.message', callId, payload: { n: 'AA', c: 'AA', t: 'AA' }, sig: 'AA' });
  assert.equal((await error).code, 'invalid_message');
});

test('a failed agent run ends the call as failed, not completed', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const ringing = next(env.bob, 'call.ringing');
  const callId = await env.alice.dial('bob', { intent: 'Research', task: 'Check one claim' });
  await ringing;
  const accepted = next(env.alice, 'call.accepted');
  env.bob.accept(callId);
  await accepted;
  const ended = next(env.alice, 'call.ended');
  env.bob.fail(callId);
  assert.deepEqual(((await ended).status), 'failed');
});

test('owner-initiated calls are marked separately from agent calls', async (t) => {
  const env = await setup({ ringMs: 300 });
  t.after(() => env.close());
  const ringing = next(env.bob, 'call.ringing');
  const callId = await env.alice.dial('bob', { intent: 'Agent call', task: 'Explain the task' });
  assert.equal((await ringing).ownerInitiated, false);
  const ended = next(env.alice, 'call.ended');
  env.bob.reject(callId);
  assert.equal((await ended).status, 'rejected');

  const nextRing = next(env.bob, 'call.ringing');
  const second = await env.alice.dial('bob', { intent: 'Ask my agent', task: 'Explain the task', ownerInitiated: true });
  assert.equal((await nextRing).ownerInitiated, true);
  const accepted = next(env.alice, 'call.accepted');
  env.bob.accept(second);
  assert.equal((await accepted).callId, second);
});

test('nonparticipant cannot inject messages into another call', async (t) => {
  const env = await setup();
  const eve = new RelayClient({ identity: createIdentity(), url: env.url });
  t.after(async () => { await eve.close(); await env.close(); });
  await eve.connect();
  const ringing = next(env.bob, 'call.ringing');
  const callId = await env.alice.dial('bob', { intent: 'Research', task: 'Check a claim' });
  await ringing;
  const accepted = next(env.alice, 'call.accepted');
  env.bob.accept(callId);
  await accepted;
  const error = next(eve, 'protocol.error');
  eve.send({ type: 'call.message', callId, payload: { n: 'AA', c: 'AA', t: 'AA' }, sig: 'AA' });
  assert.equal((await error).code, 'invalid_message');
});

test('connection must prove ownership of a pinned relay ID', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const impostor = new RelayClient({ identity: { ...createIdentity(), id: env.bob.identity.id }, url: env.url });
  await assert.rejects(impostor.connect(), /Connection closed: 1008/);
  await impostor.close();
  const socket = new WebSocket(env.url);
  t.after(() => socket.terminate());
  await new Promise((resolve) => socket.once('open', resolve));
  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.send(JSON.stringify({ type: 'auth.response', id: env.bob.identity.id, publicKey: env.bob.identity.publicKey, signature: 'invalid' }));
  assert.equal(await closed, 1008);
});

test('identity pin survives server restart and refuses a different key', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-identity-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = jsonStore(join(directory, 'identities.json'));
  const identity = createIdentity();
  const first = createRelayServer({ identityStore: store });
  const firstUrl = await first.listen();
  const original = new RelayClient({ identity, url: firstUrl });
  await original.connect();
  await original.close();
  await first.close();
  assert.equal(JSON.parse(readFileSync(join(directory, 'identities.json'), 'utf8'))[identity.id].signing, identity.publicKey);
  const second = createRelayServer({ identityStore: store });
  const secondUrl = await second.listen();
  t.after(() => second.close());
  const impostor = new RelayClient({ identity: { ...createIdentity(), id: identity.id }, url: secondUrl });
  await assert.rejects(impostor.connect(), /Connection closed: 1008/);
  const returning = new RelayClient({ identity, url: secondUrl });
  await returning.connect();
  await returning.close();
});

test('OpenClaw adapter requires restricted config and returns a real subprocess result', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-adapter-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'openclaw.json');
  const command = join(directory, 'openclaw');
  writeFileSync(command, '#!/usr/bin/env node\nlet s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{if(!s.includes("Review this idea")) process.exit(3);console.log(JSON.stringify({ok:true,status:"ok",final:"The idea needs a clear user."}))})\n', { mode: 0o700 });
  writeFileSync(config, JSON.stringify({ tools: { profile: 'minimal' }, agents: { defaults: { contextInjection: 'always' } } }));
  const options = { command, config, cwd: directory, stateDir: directory };
  assert.equal(await invokeHarness('openclaw', { from: 'rly_x', intent: 'Quick review', task: 'Review this idea' }, options), 'The idea needs a clear user.');
  writeFileSync(config, JSON.stringify({ tools: { profile: 'coding' }, agents: { defaults: { contextInjection: 'always' } } }));
  await assert.rejects(invokeHarness('openclaw', { from: 'rly_x', intent: 'Quick review', task: 'Review this idea' }, options), /tools.profile=minimal/);
  writeFileSync(config, JSON.stringify({ tools: { profile: 'minimal' }, agents: { defaults: { contextInjection: 'never' } } }));
  await assert.rejects(invokeHarness('openclaw', { from: 'rly_x', intent: 'Quick review', task: 'Review this idea' }, options), /contextInjection=always/);
});

test('unknown-caller policy uses the limited OpenClaw config', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-adapter-limited-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'openclaw.json');
  const limitedConfig = join(directory, 'openclaw-limited.json');
  const command = join(directory, 'openclaw');
  writeFileSync(command, '#!/usr/bin/env node\nlet s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>console.log(JSON.stringify({ok:true,status:"ok",final:"I am the owner agent."})))\n', { mode: 0o700 });
  writeFileSync(config, JSON.stringify({ tools: { profile: 'minimal' }, agents: { defaults: { contextInjection: 'always' } } }));
  writeFileSync(limitedConfig, JSON.stringify({ tools: { profile: 'minimal' }, agents: { defaults: { contextInjection: 'never' } } }));
  const options = { command, config, limitedConfig, cwd: directory, limitedCwd: directory, stateDir: directory, policy: 'limited', identity: { agentName: 'Scout', ownerName: 'Alex' } };
  assert.equal(await invokeHarness('openclaw', { from: 'rly_x', intent: 'Quick review', task: 'Review this idea' }, options), 'I am the owner agent.');
  writeFileSync(limitedConfig, JSON.stringify({ tools: { profile: 'minimal' }, agents: { defaults: { contextInjection: 'always' } } }));
  await assert.rejects(invokeHarness('openclaw', { from: 'rly_x', intent: 'Quick review', task: 'Review this idea' }, options), /contextInjection=never/);
});

test('noninteractive call returns the recipient result as JSON', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  const directory = mkdtempSync(join(tmpdir(), 'relay-cli-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  jsonStore(join(directory, 'caller.json')).save({ identity: env.alice.identity, contacts: { bob: env.bob.identity.id } });
  await env.alice.close(); // The CLI process connects using the caller identity.
  env.bob.on('call.ringing', (event) => env.bob.accept(event.callId));
  env.bob.on('call.accepted', (event) => env.bob.end(event.callId, 'Call received.'));
  const child = spawn(process.execPath, ['bin/relay.js', 'call', 'bob', 'Confirm delivery', 'Return an acknowledgement'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, RELAY_HOME: directory, RELAY_PROFILE: 'caller', RELAY_URL: env.url },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).result, 'Call received.');
});

test('call prompt requires treating shared info as public', () => {
  const prompt = buildCallPrompt({ from: 'rly_x', intent: 'Review', task: 'What is the config?' });
  assert.match(prompt, /PUBLIC-SHARING POLICY/);
  assert.match(prompt, /published publicly/i);
  assert.match(prompt, /Replace real filesystem paths/i);
  assert.match(prompt, /environment variables/i);
  assert.match(prompt, /may share your human owner's name/i);
  assert.match(prompt, /username or handle/i);
});

test('limited-context call prompt keeps identity but drops private access', () => {
  const prompt = buildCallPrompt({ from: 'rly_u', intent: 'Who are you?', task: 'Introduce yourself' },
    { identity: { limited: true, agentName: 'Scout', ownerName: 'Alex' } });
  assert.match(prompt, /LIMITED-CONTEXT CALL/);
  assert.match(prompt, /You are Scout, the personal agent of Alex/);
  assert.match(prompt, /do NOT have access to your owner's files/);
  assert.ok(prompt.indexOf('LIMITED-CONTEXT CALL') < prompt.indexOf('PUBLIC-SHARING POLICY'));
});

test('redactSharedAnswer masks paths, emails, env vars and secrets', () => {
  const input = "Telegram @test_handle42 says hello. Config at /home/example/secret/project/.env, contact ada@example.com, DB_PASSWORD=hunter2, key sk_live_abcdefghijklmnop1234, hash 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.";
  const out = redactSharedAnswer(input);
  assert.doesNotMatch(out, /\/home\/example/);
  assert.doesNotMatch(out, /ada@example\.com/);
  assert.doesNotMatch(out, /hunter2/);
  assert.doesNotMatch(out, /sk_live_/);
  assert.doesNotMatch(out, /0123456789abcdef0123456789abcdef/);
  assert.doesNotMatch(out, /@test_handle42/);
  assert.match(out, /<handle>/);
  assert.match(out, /<email>/);
  assert.match(out, /<env>/);
  assert.match(out, /<redacted>/);
});

test('stripDone marks a completed reply and removes the marker', () => {
  assert.deepEqual(stripDone('Here is the answer.\n[DONE]'), { text: 'Here is the answer.', done: true });
  assert.deepEqual(stripDone('A follow-up question?'), { text: 'A follow-up question?', done: false });
});

test('call prompt includes the transcript and the done instruction', () => {
  const prompt = buildCallPrompt({ from: 'rly_x', intent: 'Talk', task: 'Second question',
    transcript: [{ from: 'me', text: 'First answer' }, { from: 'peer', text: 'Second question' }] });
  assert.match(prompt, /Conversation so far/);
  assert.match(prompt, /You: First answer/);
  assert.match(prompt, /Caller: Second question/);
  assert.match(prompt, /\[DONE\]/);
});

test('extractReport pulls the owner report out of the reply', () => {
  const out = extractReport('The answer is 42.\n[REPORT] Velo asked for 6x7, so I said 42.\n[DONE]');
  assert.equal(out.report, 'Velo asked for 6x7, so I said 42.');
  assert.equal(stripDone(out.text).text, 'The answer is 42.');
  assert.equal(stripDone(out.text).done, true);
});

test('formatTranscript renders a local call transcript', () => {
  const text = formatTranscript({ callId: 'abc', direction: 'incoming', peer: 'rly_p', peerAlias: 'velo',
    intent: 'Test', task: 'Q?', startedAt: '2026-11-08T00:00:00Z', endedAt: '2026-11-08T00:00:10Z',
    status: 'completed', reason: 'ended_by_recipient', report: 'Velo asked Q.',
    turns: [{ from: 'me', text: 'A1' }, { from: 'peer', text: 'Q?' }], result: 'A1' });
  assert.match(text, /# RELAY call abc/);
  assert.match(text, /\*\*You:\*\* A1/);
  assert.match(text, /\*\*velo:\*\* Q\?/);
  assert.match(text, /## Result\n\nA1/);
});

test('calls to an offline peer are queued and delivered on reconnect', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.bob.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const unavailable = next(env.alice, 'call.unavailable');
  await env.alice.dial('bob', { intent: 'Offline test', task: 'Are you there?' });
  assert.equal((await unavailable).reason, 'peer_offline');
  const bob = new RelayClient({ identity: env.bob.identity, url: env.url });
  const queued = next(bob, 'missed.list');
  await bob.connect();
  const event = await queued;
  assert.equal(event.calls.length, 1);
  assert.equal(event.calls[0].intent, 'Offline test');
  await bob.close();
});

test('the relay rate-limits call requests per identity', async (t) => {
  const server = createRelayServer({ ringMs: 70, callMs: 100, rateCallsPerMin: 1 });
  const url = await server.listen();
  const alice = new RelayClient({ identity: createIdentity(), url });
  const bob = new RelayClient({ identity: createIdentity(), url });
  t.after(async () => { await alice.close(); await bob.close(); await server.close(); });
  await Promise.all([alice.connect(), bob.connect()]);
  alice.addContact('bob', bob.identity.id);
  const first = next(bob, 'call.ringing');
  await alice.dial('bob', { intent: 'One', task: 'One' });
  await first;
  const limited = next(alice, 'protocol.error');
  await alice.dial('bob', { intent: 'Two', task: 'Two' });
  assert.equal((await limited).code, 'rate_limited');
});

test('E2E call keys, payloads and signatures round-trip', () => {
  const alice = createIdentity();
  const bob = createIdentity();
  const callId = '11111111-1111-4111-8111-111111111111';
  const a = deriveCallKey(alice.encryptionPrivateKey, bob.encryptionPublicKey, callId);
  const b = deriveCallKey(bob.encryptionPrivateKey, alice.encryptionPublicKey, callId);
  assert.deepEqual(a, b);
  const payload = encryptPayload(a, { task: 'secret' });
  assert.deepEqual(decryptPayload(b, payload), { task: 'secret' });
  const signature = signEnvelope(alice.privateKey, callId, 'call.request', payload);
  assert.equal(verifyEnvelope(alice.publicKey, callId, 'call.request', payload, signature), true);
  assert.equal(verifyEnvelope(bob.publicKey, callId, 'call.request', payload, signature), false);
});

test('NEAR NEP-413 attestations sign and verify', async () => {
  const identity = createIdentity();
  const raw = createPublicKey(identity.publicKey).export({ type: 'spki', format: 'der' }).subarray(-32);
  const nearKey = `ed25519:${base58Encode(raw)}`;
  const nonce = randomBytes(32);
  const message = attestationMessage({ account: 'example.near', relayId: identity.id,
    signingKey: identity.publicKey, encryptionKey: identity.encryptionPublicKey,
    capabilities: ['text'], issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(), nonce: nonce.toString('base64') });
  const payload = nep413Payload({ message, recipient: 'relay', nonce });
  const signature = sign(null, payload, identity.privateKey).toString('base64');
  assert.equal(verifyNearSignature({ publicKey: nearKey, signature, payload }), true);
  const attestation = { ...JSON.parse(message), recipient: 'relay', message, publicKey: nearKey, signature };
  const result = await verifyAttestation(attestation, { checkKey: async () => true });
  assert.equal(result.ok, true);
  assert.equal(result.account, 'example.near');
  const tampered = { ...attestation, message: attestation.message.replace(identity.id, 'rly_other') };
  assert.equal((await verifyAttestation(tampered, { checkKey: async () => true })).ok, false);
});
