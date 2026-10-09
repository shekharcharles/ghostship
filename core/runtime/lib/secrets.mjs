// Reads ~/.ghostship/secrets (KEY=value lines). Values are handed to child processes as env vars only; never written to a project.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function secretsPath(home = process.env.GHOSTSHIP_HOME || homedir()) {
  return join(home, '.ghostship', 'secrets');
}

export function readSecrets(home) {
  const out = {};
  let text = '';
  try { text = readFileSync(secretsPath(home), 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function secret(name, home) {
  const v = readSecrets(home)[name];
  if (!v) throw new Error(`secret ${name} is not set in ~/.ghostship/secrets`);
  return v;
}
