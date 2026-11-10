#!/usr/bin/env node
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startWeb } from '../src/web.js';

const profileDir = process.env.RELAY_HOME ?? join(homedir(), '.config', 'relay');

function profiles() {
  return existsSync(profileDir)
    ? readdirSync(profileDir).filter((name) => {
      if (!/^[a-zA-Z0-9_-]{1,40}\.json$/.test(name)) return false;
      try { return typeof JSON.parse(readFileSync(join(profileDir, name), 'utf8')).identity?.id === 'string'; }
      catch { return false; }
    }).map((name) => name.slice(0, -5))
    : [];
}

const profile = process.env.RELAY_PROFILE ?? (profiles().length === 1 ? profiles()[0] : 'default');
if (!/^[a-zA-Z0-9_-]{1,40}$/.test(profile)) throw new Error('Invalid RELAY_PROFILE');
if (!existsSync(join(profileDir, `${profile}.json`))) throw new Error(`No RELAY profile "${profile}" on this machine`);

const port = Number(process.env.RELAY_WEB_PORT ?? '8788');
const host = process.env.RELAY_WEB_HOST ?? '127.0.0.1';
const { url } = await startWeb({ profileDir, profile, port, host });
console.log(`RELAY phonebook: ${url}`);
