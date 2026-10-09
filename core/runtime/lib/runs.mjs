// The one agent run in flight per project (.ghostship/runs/active.json) and the run history (.ghostship/usage/runs.jsonl).
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { RUNS_DIR } from './paths.mjs';

export const ACTIVE_FILE = `${RUNS_DIR}/active.json`;
export const HISTORY_FILE = '.ghostship/usage/runs.jsonl';

export function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function readActive(root) {
  try { return JSON.parse(readFileSync(join(root, ACTIVE_FILE), 'utf8')); } catch { return null; }
}

export function writeActive(root, run) {
  const p = join(root, ACTIVE_FILE);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(run, null, 2) + '\n');
  renameSync(tmp, p);
  return run;
}

export function updateActive(root, patch) {
  const cur = readActive(root);
  if (!cur || (patch.runId && patch.runId !== cur.runId)) return null;
  return writeActive(root, { ...cur, ...patch });
}

/** A run counts as live while its supervisor process exists and it has not reported an end state. */
export function liveRun(root) {
  const r = readActive(root);
  if (!r || r.status !== 'running') return null;
  return alive(r.supervisorPid) ? r : { ...r, status: 'lost' };
}

export function finishRun(root, run) {
  const p = join(root, HISTORY_FILE);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(run) + '\n');
}

export function clearActive(root) {
  rmSync(join(root, ACTIVE_FILE), { force: true });
}

export function history(root) {
  const p = join(root, HISTORY_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
