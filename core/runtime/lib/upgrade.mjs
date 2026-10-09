// Core upgrades at a safe point, with verification and rollback. The project's pinned core (.ghostship/core)
// moves to the installed one (~/.ghostship/core) only when nothing is in flight; the new core must read this
// project's state and pass the audit before it replaces the old one, which is kept in .ghostship/core.prev.
import { existsSync, readFileSync, rmSync, cpSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { load } from './store.mjs';
import { activeTask } from './engine.mjs';
import { liveRun } from './runs.mjs';
import { dirtyPaths, hasIdentity, tryGit } from './git.mjs';
import { initProject } from './init.mjs';
import { add as remember } from './memory.mjs';
import { TREE_EXCLUDES } from './paths.mjs';

export const globalCore = (home) => join(home || process.env.GHOSTSHIP_HOME || homedir(), '.ghostship', 'core');
const ver = (dir) => { try { return readFileSync(join(dir, 'VERSION'), 'utf8').trim(); } catch { return null; } };

export function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map(Number), pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

export function check(root, { from } = {}) {
  const src = from || globalCore();
  const project = ver(join(root, '.ghostship/core'));
  const available = ver(src);
  return { project, available, from: src, newer: !!available && cmpVersion(available, project) > 0, rollback: ver(join(root, '.ghostship/core.prev')) };
}

export function safePoint(root) {
  const reasons = [];
  const state = load(root);
  const act = activeTask(state);
  if (act) reasons.push(`${act.id} is ${act.status}`);
  const run = liveRun(root);
  if (run && run.status === 'running') reasons.push(`outside run ${run.runId} is running`);
  if (state.release) reasons.push('a release candidate waits for STOP 2');
  const dirty = dirtyPaths(root, TREE_EXCLUDES);
  if (dirty.length) reasons.push(`uncommitted changes (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ' …' : ''})`);
  return { ok: reasons.length === 0, reasons };
}

function verify(root, coreDir) {
  const gs = join(coreDir, 'runtime', 'gs.mjs');
  const env = { ...process.env, CLAUDE_PROJECT_DIR: '', GHOSTSHIP_ROLE: '' };
  const audit = spawnSync(process.execPath, [gs, 'audit', '--json', '--root', root], { encoding: 'utf8', env, timeout: 60000 });
  const status = spawnSync(process.execPath, [gs, 'status', '--json', '--root', root], { encoding: 'utf8', env, timeout: 60000 });
  const errors = [];
  if (audit.status !== 0) errors.push(`audit with the new core failed: ${(audit.stderr || audit.stdout).trim().slice(0, 300)}`);
  if (status.status !== 0) errors.push(`status with the new core failed: ${(status.stderr || status.stdout).trim().slice(0, 300)}`);
  return errors;
}

const MANAGED = ['.ghostship/core', '.ghostship/VERSION', '.claude/agents', '.claude/settings.json', '.claude/skills/ghostship-bridge', 'AGENTS.md', '.gitignore', '.gitattributes', 'docs/11-memory'];

function commitManaged(root, message) {
  if (!hasIdentity(root)) return false;
  tryGit(root, ['add', '-A', '--', ...MANAGED.filter((p) => existsSync(join(root, p)))]);
  if (tryGit(root, ['diff', '--cached', '--quiet']).ok) return false;
  return tryGit(root, ['commit', '-q', '--no-verify', '-m', message]).ok;
}

export function apply(root, { from, force = false } = {}) {
  const c = check(root, { from });
  if (!c.available) return { ok: false, reason: `No core found at ${c.from}` };
  if (!c.newer && !force) return { ok: false, reason: `Already on ${c.project}` };
  const safe = safePoint(root);
  if (!safe.ok) return { ok: false, reason: `Not a safe point: ${safe.reasons.join('; ')}` };
  const core = join(root, '.ghostship/core'), next = join(root, '.ghostship/core.next'), prev = join(root, '.ghostship/core.prev');
  rmSync(next, { recursive: true, force: true });
  cpSync(c.from, next, { recursive: true, filter: (p) => !/[\\/](\.prev|vendor|node_modules)([\\/]|$)|[\\/]mod[\\/][^\\/]+[\\/]tests/.test(p) });
  const errors = verify(root, next);
  if (errors.length) { rmSync(next, { recursive: true, force: true }); return { ok: false, reason: 'The new core did not pass on this project; nothing changed.', errors }; }
  rmSync(prev, { recursive: true, force: true });
  renameSync(core, prev);
  renameSync(next, core);
  const msg = `chore(ghostship): upgrade core ${c.project} → ${c.available}`;
  initProject(root, { coreSrc: core, which: () => null, commitMessage: msg });
  try { remember(root, 'memory', `Ghostship core upgraded ${c.project} → ${c.available}`); } catch { /* best effort */ }
  return { ok: true, from: c.project, to: c.available, committed: commitManaged(root, msg) };
}

export function rollback(root) {
  const core = join(root, '.ghostship/core'), prev = join(root, '.ghostship/core.prev'), tmp = join(root, '.ghostship/core.rollback');
  if (!existsSync(prev)) return { ok: false, reason: 'No previous core kept.' };
  const safe = safePoint(root);
  if (!safe.ok) return { ok: false, reason: `Not a safe point: ${safe.reasons.join('; ')}` };
  const from = ver(core), to = ver(prev);
  rmSync(tmp, { recursive: true, force: true });
  renameSync(core, tmp);
  renameSync(prev, core);
  renameSync(tmp, prev);
  const msg = `chore(ghostship): roll core back ${from} → ${to}`;
  initProject(root, { coreSrc: core, which: () => null, commitMessage: msg });
  commitManaged(root, msg);
  return { ok: true, from, to };
}
