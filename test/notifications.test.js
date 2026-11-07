import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { approvalCode, sameCode, sendDecision, sendTelegramRing, startApprovalSocket } from '../src/notifications.js';

test('Telegram ring uses Hermes webhook signature and sends an approval code', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-notify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const secretFile = join(dir, 'secret');
  writeFileSync(secretFile, 'local-test-secret');
  let delivered;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const expected = createHmac('sha256', 'local-test-secret').update(`${request.headers['x-webhook-timestamp']}.${body}`).digest('hex');
    delivered = { signatureValid: request.headers['x-webhook-signature-v2'] === expected, body: JSON.parse(body) };
    response.setHeader('Content-Type', 'application/json');
    response.end('{"status":"delivered"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const code = approvalCode();
  assert.equal(code.length, 8);
  await sendTelegramRing({ url: `http://127.0.0.1:${server.address().port}/`, secretFile,
    call: { callId: 'call-one', from: 'rly_sender', intent: 'Research', task: 'Check a claim' }, alias: 'researcher', code });
  assert.equal(delivered.signatureValid, true);
  assert.deepEqual(delivered.body, { callId: 'call-one', from: 'rly_sender', alias: 'researcher', intent: 'Research', task: 'Check a claim', code });
});

test('local approval socket requires the active call and its code', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-approval-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'bridge.sock');
  const code = approvalCode();
  const stop = await startApprovalSocket(path, ({ callId, code: supplied }) => ({ ok: callId === 'pending' && sameCode(code, supplied) }));
  t.after(stop);
  assert.equal((await sendDecision(path, { action: 'accept', callId: 'pending', code: 'wrong' })).ok, false);
  assert.equal((await sendDecision(path, { action: 'accept', callId: 'expired', code })).ok, false);
  assert.equal((await sendDecision(path, { action: 'accept', callId: 'pending', code })).ok, true);
});
