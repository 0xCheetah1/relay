#!/usr/bin/env node
import { resolve } from 'node:path';
import { createRelayServer } from '../src/server.js';
import { jsonStore } from '../src/store.js';

const host = process.env.RELAY_HOST ?? '127.0.0.1';
const port = Number(process.env.RELAY_PORT ?? '8901');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RELAY_PORT must be 1-65535');
const ringMs = Number(process.env.RELAY_RING_MS ?? '30000');
const callMs = Number(process.env.RELAY_CALL_MS ?? '60000');
if (!Number.isInteger(ringMs) || ringMs < 1000) throw new Error('RELAY_RING_MS must be an integer >= 1000');
if (!Number.isInteger(callMs) || callMs < 0) throw new Error('RELAY_CALL_MS must be an integer >= 0 (0 disables the call timeout)');
const path = resolve(process.env.RELAY_IDENTITY_DB ?? './relay-identities.json');
const server = createRelayServer({ host, port, identityStore: jsonStore(path), ringMs, callMs });
console.log(`RELAY listening on ${await server.listen()}; identity pins: ${path}`);
const shutdown = async () => { await server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
