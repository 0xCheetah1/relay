import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonStore } from './store.js';
import { sendControl } from './notifications.js';

const MAX_BODY = 64 * 1024;

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { status: 413 })); request.destroy(); }
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    request.on('error', reject);
  });
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

export function startWeb({ profileDir, profile, port = 8788, host = '127.0.0.1' } = {}) {
  const store = jsonStore(join(profileDir, `${profile}.json`));
  const historyStore = jsonStore(join(profileDir, `${profile}-history.json`));
  const controlPath = join(profileDir, `${profile}.sock`);
  const control = (request) => sendControl(controlPath, request);
  const bridgeOffline = (error) => error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT';

  function state() {
    const value = store.load();
    if (!value.identity?.id) throw fail(500, `No RELAY identity for profile ${profile}`);
    return value;
  }

  function summary() {
    const value = state();
    const contacts = Object.entries(value.contacts ?? {}).map(([alias, id]) => ({
      alias,
      id,
      blocked: (value.blocked ?? []).includes(id),
      retention: value.retention?.[id] ?? 86400,
    })).sort((left, right) => left.alias.localeCompare(right.alias));
    const history = (historyStore.load().records ?? []).slice(0, 50).map((record) => ({
      callId: record.callId,
      direction: record.direction,
      peer: record.peerAlias ?? record.peer,
      status: record.status,
      reason: record.reason ?? null,
      result: record.result ? String(record.result).slice(0, 140) : null,
      startedAt: record.startedAt,
    }));
    const nearPath = join(profileDir, `${profile}-near.json`);
    const near = existsSync(nearPath) ? JSON.parse(readFileSync(nearPath, 'utf8')) : null;
    return {
      profile,
      id: value.identity.id,
      dnd: Boolean(value.dnd),
      contacts,
      blocked: value.blocked ?? [],
      history,
      near: near ? { account: near.account, expiresAt: near.expiresAt } : null,
    };
  }

  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && files[url.pathname]) {
        const [name, type] = files[url.pathname];
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        response.end(readFileSync(new URL(`./web/${name}`, import.meta.url)));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') return sendJson(response, summary());
      if (request.method === 'GET' && url.pathname === '/api/bridge') {
        try {
          const result = await control({ action: 'status' });
          return sendJson(response, result);
        } catch (error) {
          if (bridgeOffline(error)) return sendJson(response, { ok: false, error: 'bridge_offline' });
          throw error;
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/pending') {
        try {
          const result = await control({ action: 'pending' });
          return sendJson(response, result);
        } catch (error) {
          if (bridgeOffline(error)) return sendJson(response, { ok: false, error: 'bridge_offline', pending: [] });
          throw error;
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/dnd') {
        const body = await readJson(request);
        const dnd = Boolean(body.dnd);
        try {
          return sendJson(response, await control({ action: 'dnd', dnd }));
        } catch (error) {
          if (!bridgeOffline(error)) throw error;
          const value = state();
          value.dnd = dnd;
          store.save(value);
          return sendJson(response, { ok: true, dnd, bridge: false });
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/call') {
        const body = await readJson(request);
        const target = String(body.target ?? '').trim();
        const intent = String(body.intent ?? '').trim();
        const task = String(body.task ?? '').trim();
        if (!target || !intent || !task) throw fail(400, 'Target, intent and task are required');
        try {
          const result = await control({ action: 'dial', alias: target, intent, task, multi: true, ownerInitiated: true });
          if (!result.ok) throw fail(400, result.error ?? 'dial_failed');
          return sendJson(response, { ok: true, callId: result.callId, status: result.status ?? 'dialing' });
        } catch (error) {
          if (bridgeOffline(error)) throw fail(503, 'bridge_offline');
          throw error;
        }
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/call/')) {
        const callId = decodeURIComponent(url.pathname.slice('/api/call/'.length));
        if (!/^[0-9a-f-]{36}$/.test(callId)) throw fail(400, 'Invalid call ID');
        try {
          return sendJson(response, await control({ action: 'callStatus', callId }));
        } catch (error) {
          if (bridgeOffline(error)) throw fail(503, 'bridge_offline');
          throw error;
        }
      }
      if (request.method === 'POST' && (url.pathname === '/api/accept' || url.pathname === '/api/reject')) {
        const body = await readJson(request);
        const callId = String(body.callId ?? '');
        const code = String(body.code ?? '');
        if (!/^[0-9a-f-]{36}$/.test(callId)) throw fail(400, 'Invalid call ID');
        try {
          const action = url.pathname === '/api/accept' ? 'accept' : 'reject';
          return sendJson(response, await control({ action, callId, code }));
        } catch (error) {
          if (bridgeOffline(error)) throw fail(503, 'bridge_offline');
          throw error;
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/contacts') {
        const body = await readJson(request);
        const value = state();
        const alias = String(body.alias ?? '').trim();
        const id = String(body.id ?? '').trim();
        if (!/^[a-z][a-z0-9_-]{0,31}$/.test(alias)) throw fail(400, 'Invalid alias');
        if (!/^rly_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw fail(400, 'Invalid relay ID');
        value.contacts = { ...(value.contacts ?? {}), [alias]: id };
        store.save(value);
        return sendJson(response, { ok: true });
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/api/contacts/')) {
        const alias = decodeURIComponent(url.pathname.slice('/api/contacts/'.length));
        const value = state();
        delete (value.contacts ?? {})[alias];
        store.save(value);
        return sendJson(response, { ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/block') {
        const body = await readJson(request);
        const value = state();
        const id = String(body.id ?? '');
        if (!/^rly_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw fail(400, 'Invalid relay ID');
        value.blocked = [...new Set([...(value.blocked ?? []), id])];
        store.save(value);
        return sendJson(response, { ok: true });
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/api/block/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/block/'.length));
        const value = state();
        value.blocked = (value.blocked ?? []).filter((item) => item !== id);
        store.save(value);
        return sendJson(response, { ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/retention') {
        const body = await readJson(request);
        const value = state();
        const id = String(body.id ?? '');
        const seconds = Number(body.seconds);
        if (!/^rly_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) || !Number.isFinite(seconds) || seconds < 0) throw fail(400, 'Invalid retention');
        value.retention = { ...(value.retention ?? {}), [id]: seconds };
        store.save(value);
        return sendJson(response, { ok: true });
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/history/')) {
        const callId = decodeURIComponent(url.pathname.slice('/api/history/'.length));
        const records = historyStore.load().records ?? [];
        const record = records.find((item) => item.callId === callId || item.callId.startsWith(callId));
        if (!record) throw fail(404, 'No such call');
        return sendJson(response, record);
      }
      throw fail(404, 'Not found');
    } catch (error) {
      sendJson(response, { error: error.message }, error.status ?? 500);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${port}` }));
  });
}
