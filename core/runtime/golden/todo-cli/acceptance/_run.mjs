// Runs the todo CLI once against a temp file and returns its output.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const todoFile = () => join(mkdtempSync(join(tmpdir(), 'todo-')), 'items.json');
export function todo(file, ...args) {
  const r = spawnSync(process.execPath, ['bin/todo.mjs', ...args], { encoding: 'utf8', env: { ...process.env, TODO_FILE: file } });
  if (r.status !== 0) throw new Error(`todo ${args.join(' ')} exited ${r.status}: ${r.stderr || r.stdout}`);
  return r.stdout;
}
