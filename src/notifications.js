import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { spawn } from 'node:child_process';

export const approvalCode = () => randomBytes(4).toString('hex');

export function sameCode(expected, actual) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export async function sendTelegramRing({ url, secretFile, call, alias, code, trusted = true }) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
    throw new Error('Hermes webhook must use loopback HTTP');
  }
  const secret = readFileSync(secretFile, 'utf8').trim();
  if (!secret) throw new Error('Missing Hermes webhook secret');
  const body = JSON.stringify({ callId: call.callId, from: call.from, alias, intent: call.intent, task: call.task, code, trusted });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const response = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Timestamp': timestamp,
      'X-Webhook-Signature-V2': signature, 'X-Request-ID': call.callId },
    body,
    signal: AbortSignal.timeout(4000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.status !== 'delivered') throw new Error(`Hermes Telegram delivery failed (${response.status}, ${result.status ?? 'unknown'})`);
}

function socketRequest(path, request, { timeoutMs = 2000, maxBytes = 65536 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let output = '';
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Bridge socket timed out')));
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => { output += chunk; if (output.length > maxBytes) socket.destroy(new Error('Oversized bridge reply')); });
    socket.on('end', () => { try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid bridge reply')); } });
    socket.on('error', reject);
  });
}

export const sendDecision = (path, request) => socketRequest(path, request);

export const sendDial = (path, request) => socketRequest(path, request, { timeoutMs: 270_000 });

export function sendOpenClawRing({ bin, ownerId, call, alias, code, trusted = true }) {
  const text = `📞 Incoming RELAY call\n\nFrom: ${alias}${trusted ? '' : '\n⚠️ Unknown caller — not in your phonebook'}\nIntent: ${call.intent}\n\n📋 Task\n${call.task}\n\n${trusted ? 'Answers use full context.' : 'Accepting answers with minimal context only.'}\n⏳ Answer within 2 minutes.`;
  const presentation = {
    blocks: [{
      type: 'buttons',
      buttons: [
        { label: '✅ Accept', action: { type: 'callback', value: `rc:a:${call.callId}:${code}` } },
        { label: '❌ Reject', action: { type: 'callback', value: `rc:r:${call.callId}:${code}` } },
      ],
    }],
  };
  return new Promise((resolve, reject) => {
    const args = ['message', 'send', '--channel', 'telegram', '--target', String(ownerId),
      '--message', text, '--presentation', JSON.stringify(presentation), '--json'];
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`openclaw message send exited ${code}: ${err.slice(-300)}`));
    });
  });
}

export function sendOpenClawNotice({ bin, ownerId, text }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['message', 'send', '--channel', 'telegram', '--target', String(ownerId), '--message', text, '--json'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`openclaw message send exited ${code}: ${err.slice(-300)}`));
    });
  });
}

export async function sendInlineRing(path, { call, alias, code, trusted = true }) {
  const result = await socketRequest(path, { callId: call.callId, from: call.from,
    alias, intent: call.intent, task: call.task, code, trusted });
  if (result.status !== 'delivered') throw new Error('Hermes Telegram button delivery failed');
}

export async function sendInlineNotice(path, text) {
  const result = await socketRequest(path, { action: 'notice', text });
  if (result.status !== 'delivered') throw new Error('Hermes Telegram notice delivery failed');
}

export async function startApprovalSocket(path, decide) {
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket()) throw new Error('Approval path exists and is not a socket');
    try { await socketRequest(path, { action: 'ping' }); throw new Error('Approval socket already in use'); }
    catch (error) {
      if (!['ECONNREFUSED', 'ENOENT'].includes(error.code)) throw error;
      unlinkSync(path);
    }
  }
  const server = createServer((socket) => {
    let text = '';
    let handled = false;
    socket.on('data', (chunk) => {
      text += chunk;
      if (text.length > 16384) return socket.destroy();
      if (!text.includes('\n') || handled) return;
      handled = true;
      let request;
      try { request = JSON.parse(text.split('\n')[0]); } catch { socket.end('{"ok":false,"error":"invalid_request"}\n'); return; }
      Promise.resolve(decide(request)).then(
        (result) => socket.end(`${JSON.stringify(result)}\n`),
        (error) => socket.end(`${JSON.stringify({ ok: false, error: error?.message ?? 'control_error' })}\n`),
      );
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  chmodSync(path, 0o600);
  return async () => {
    await new Promise((resolve) => server.close(resolve));
    if (existsSync(path)) unlinkSync(path);
  };
}
