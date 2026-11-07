import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function jsonStore(path) {
  return {
    load() { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}; },
    save(value) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    },
  };
}
