// The headless autopilot runner: a loop over `next()` that does each step itself, dispatches builders, judges and
// planners as headless runs (claude -p and the like), and stops to wait for the owner at the gates that are theirs.
// State: .ghostship/runs/autopilot.json (one runner per project); log: .ghostship/runs/autopilot.jsonl, one line per step.
// The judge token lives only in this process's memory: never on argv, never in a file.
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, rmSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { next } from './next.mjs';
import * as E from './engine.mjs';
import * as D from './dispatch.mjs';
import * as DOC from './docs.mjs';
import { load, exists as stateExists } from './store.mjs';
import { loadConfig } from './config.mjs';
import { readActive, alive, clearActive } from './runs.mjs';
import { raise, paused } from './bridge.mjs';
import { CATALOG } from './harness.mjs';
import { RUNS_DIR } from './paths.mjs';
import { FactoryError } from './util.mjs';

export const FILE = `${RUNS_DIR}/autopilot.json`;
export const LOG = `${RUNS_DIR}/autopilot.jsonl`;
/** Held only while `start` checks, spawns and records, so two starts at once cannot both pass the check. */
export const LOCK = `${RUNS_DIR}/autopilot.lock`;
/** Held for each read-change-write of the record, so the runner and `stop` never overwrite each other's change. */
export const STATE_LOCK = `${RUNS_DIR}/autopilot.json.lock`;
/** How long a write of the record waits for another process's write before it gives up. */
export const STATE_LOCK_WAIT_MS = 3000;
/** An empty lock (its holder died between creating and filling it) is taken over once it is this old. */
const EMPTY_LOCK_STALE_MS = 5000;
/** Statuses only a new `start` moves the record out of: a late write from the runner never undoes a stop. */
export const TERMINAL = ['stopped', 'failed', 'done'];
const RUNNER = join(dirname(fileURLToPath(import.meta.url)), '..', 'autopilot-runner.mjs');
/** A step that fails this many times in a row stops the runner: a loop that cannot move is a decision, not a retry. */
export const SAME_FAIL_LIMIT = 3;
/** While the owner is being waited on, the runner asks `next()` again this often. */
export const OWNER_POLL_MS = 20000;

const readJson = (p, dflt) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return dflt; } };
// Written beside the record and renamed over it, so a crash mid-write never leaves a half record behind.
const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  renameSync(tmp, p);
};
const nowIso = () => new Date().toISOString();
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const eventSeq = (root) => { try { return load(root).eventSeq ?? 0; } catch { return 0; } };

// ---------------------------------------------------------------- the runner's record

export function readState(root) { return readJson(join(root, FILE), null); }

/**
 * Runs `fn` holding the lock file `rel`; the lock holds the holder's pid. A lock whose holder is gone, or that was never
 * filled in and is old, is taken over. A live holder is waited on for `waitMs`, then `busy(holder)` is thrown.
 */
function withLock(root, rel, fn, { waitMs = 0, busy }) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try { writeFileSync(p, String(process.pid), { flag: 'wx' }); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = 0, age = 0;
      try { holder = parseInt(readFileSync(p, 'utf8'), 10) || 0; age = Date.now() - statSync(p).mtimeMs; } catch { continue; /* released meanwhile */ }
      if (!(holder ? alive(holder) : age < EMPTY_LOCK_STALE_MS)) { rmSync(p, { force: true }); continue; }
      if (Date.now() >= until) throw busy(holder);
      nap(10);
      continue;
    }
    try { return fn(); } finally { rmSync(p, { force: true }); }
  }
}

/**
 * Merges `patch` into the record, under the record's lock. Returns the new record, or null when the write is dropped:
 * - `owner`: a runner's write; dropped once the record names another runner (a newer start replaced it);
 * - unless `force` (a new start), dropped once the record is TERMINAL, so a stop is never undone by a late write.
 */
export function writeState(root, patch, { owner = null, force = false } = {}) {
  return withLock(root, STATE_LOCK, () => {
    const cur = readState(root) || {};
    if (owner !== null && cur.pid && cur.pid !== owner) return null;
    if (!force && TERMINAL.includes(cur.status)) return null;
    const v = force ? { ...patch } : { ...cur, ...patch };
    writeJson(join(root, FILE), v);
    return v;
  }, { waitMs: STATE_LOCK_WAIT_MS, busy: (holder) => new FactoryError('AUTOPILOT_BUSY', `The autopilot record is held by pid ${holder || '?'} for over ${STATE_LOCK_WAIT_MS} ms. Try again.`) });
}
/** The runner as it stands: `running`, `waiting-owner`, `paused`, `stopped`, `failed`, or `lost` when its process is gone. */
export function statusOf(root) {
  const r = readState(root);
  if (!r) return null;
  const live = ['running', 'waiting-owner', 'paused'].includes(r.status);
  if (live && !alive(r.pid)) return { ...r, status: 'lost' };
  return r;
}
export function log(root, entry) {
  const p = join(root, LOG);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify({ at: nowIso(), ...entry }) + '\n');
}
export function readLog(root, tail = 20) {
  const p = join(root, LOG);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-tail).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ---------------------------------------------------------------- doing a step in-process

/**
 * Runs a `do` step through the engine, as gs.mjs would, without a shell. Returns what to log. Throws a FactoryError
 * when the engine refuses. A `do` step with no engine mapping (writing a document) is not the runner's to do: it is
 * handed to the planner agent, so `null` comes back and the caller dispatches it.
 */
export function doStep(root, step, mem) {
  const id = step.task;
  switch (step.id) {
    case 'interview.init': return E.interviewInit(root);
    case 'design.done': return E.designDone(root);
    case 'acceptance.lint': { const r = E.acceptanceLint(root); if (!r.ok) throw new FactoryError('LINT', (r.errors || []).join('; ')); return r; }
    case 'acceptance.approve': return E.acceptanceApprove(root, {}, { auto: true });
    case 'acceptance.lock': return E.acceptanceLock(root);
    case 'task.import': return E.taskImport(root);
    case 'task.start': return E.taskStart(root, id);
    case 'submit': { const r = E.taskSubmit(root, id); mem.tokens[id] = r.token; return { tree: r.tree, changed: r.changed }; }
    case 'merge': { const r = E.taskMerge(root, id); if (!r.merged) throw new FactoryError('NOT_MERGED', r.reason); return r; }
    case 'docs.check': { const r = DOC.check(root); if (!r.ok) return null; return r; }
    case 'release.candidate': return E.releaseCandidate(root);
    case 'run.lost': clearActive(root); return { cleared: true };
    default: return null;
  }
}

// ---------------------------------------------------------------- dispatching an agent headless

/** The first configured agent whose harness has a headless mode, for a role whose routed agent has none. */
export function headlessAgent(cfg) {
  for (const [id, a] of Object.entries(cfg.agents || {})) {
    const own = cfg.harnesses?.[a.harness] || {};
    if (own.headless || CATALOG[a.harness]?.headless) return id;
  }
  return null;
}

/** Dispatch one agent step as a headless run and wait for it; the judge token travels in dispatch's environment only. */
export async function dispatchHeadless(root, step, mem, { sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), timeoutMs } = {}) {
  const cfg = loadConfig(root);
  const token = step.role === 'judge' ? mem.tokens[step.task] : undefined;
  if (step.role === 'judge' && !token) {
    const r = E.taskReissue(root, step.task);
    mem.tokens[step.task] = r.token;
  }
  const want = { task: step.task || undefined, role: step.role, token: step.role === 'judge' ? mem.tokens[step.task] : undefined, depth: step.depth, env: { ...process.env } };
  // The runner has no session: Claude-login agents configured in-session must run headless here.
  const headlessCfg = { ...cfg, dispatch: { ...(cfg.dispatch || {}), claude: 'headless', mode: 'headless' } };
  let p = D.plan(root, { ...want, cfg: headlessCfg });
  if (!p.agentId || p.mode !== 'headless') {
    const forced = headlessAgent(cfg);
    if (!forced) throw new FactoryError('NO_HEADLESS_AGENT', `No configured agent has a headless mode (${(p.skipped || []).map((s) => `${s.agent}: ${s.reason}`).join('; ') || 'none routed'}). Add one under agents, or set harnesses.<id>.headless.`);
    p = D.plan(root, { ...want, agent: forced, cfg: headlessCfg });
    if (!p.agentId || p.mode !== 'headless') throw new FactoryError('NO_HEADLESS_AGENT', `${forced} cannot run headless: ${(p.skipped || []).map((s) => s.reason).join('; ') || p.note || 'unknown'}`);
  }
  const started = D.start(root, p);
  const limit = timeoutMs ?? ((cfg.dispatch?.['timeout-min'] || 45) * 60000 + 60000);
  const until = Date.now() + limit;
  let r = readActive(root);
  while (r && r.runId === started.runId && r.status === 'running' && Date.now() < until) {
    if (!alive(r.supervisorPid)) { r = { ...r, status: 'lost' }; break; }
    await sleep(5000);
    r = readActive(root);
  }
  const report = r?.report && existsSync(join(root, r.report)) ? readFileSync(join(root, r.report), 'utf8').slice(0, 4000) : '';
  return { runId: started.runId, agentId: started.agentId, status: r?.status || 'unknown', report };
}

// ---------------------------------------------------------------- the loop

/**
 * Drives the project with `next()`. Returns `{ status, step, steps }` where status is `waiting-owner` (a gate that is the
 * owner's), `done`, `failed` (the same step failed SAME_FAIL_LIMIT times, or no agent can run), `stopped` (maxSteps or a
 * stop request), or `paused` (an owner pause). `runAgent(step, mem)` performs an agent step: the real runner dispatches
 * headless; a test can act as the builder and judge itself. `mem.tokens[task]` holds a judge token for the judge step.
 */
export async function loop(root, { runAgent = (step, mem) => dispatchHeadless(root, step, mem), maxSteps = 200, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), onStep = null, shouldStop = () => false, owner = null } = {}) {
  const mem = { tokens: {} };
  let steps = 0;
  let lastFail = { key: null, n: 0 };
  let step = null;
  const result = (status, extra = {}) => ({ status, step, steps, ...extra });
  while (steps < maxSteps) {
    if (shouldStop()) return result('stopped', { reason: 'stop requested' });
    try { step = next(root); } catch (e) { return result('failed', { reason: `next(): ${e.message}` }); }
    writeState(root, { step: steps, last: { id: step.id, say: step.say, task: step.task || null }, lastStepAt: nowIso() }, { owner });
    if (step.kind === 'done') { log(root, { id: step.id, say: step.say, result: 'done', ms: 0 }); return result('done'); }
    if (step.kind === 'owner') { log(root, { id: step.id, say: step.say, result: 'waiting-owner', ms: 0 }); return result(step.id === 'paused' && step.owner?.gate === 'go' ? 'paused' : 'waiting-owner'); }
    if (step.kind === 'wait') { steps += 1; log(root, { id: step.id, say: step.say, result: 'wait', ms: 0 }); await sleep((step.wait?.seconds || 20) * 1000); continue; }
    const t0 = Date.now();
    let outcome = 'ok', detail = null;
    try {
      let r = step.kind === 'do' ? doStep(root, step, mem) : null;
      if (r === null) {
        // Not the runner's to do in-process: an agent does it (a document to write, a builder, a judge, the planner).
        const agentStep = step.kind === 'agent' ? step : { ...step, kind: 'agent', role: step.role || 'planner' };
        const before = eventSeq(root);
        r = await runAgent(agentStep, mem);
        if (r && typeof r === 'object' && ['failed', 'timeout', 'quota', 'lost'].includes(r.status)) { outcome = 'failed'; detail = `${r.agentId || 'agent'} ${r.status}`; }
        else detail = r && typeof r === 'object' && r.status ? `${r.agentId || 'agent'} ${r.status}` : null;
        // An agent that came back with nothing recorded (no evidence, no verdict, no file) made no progress: a retry of
        // the same step would loop, so it counts as a failure towards SAME_FAIL_LIMIT.
        if (outcome === 'ok' && agentStep.role !== 'planner' && eventSeq(root) === before) { outcome = 'failed'; detail = `${detail ? `${detail}: ` : ''}no progress recorded`; }
      }
    } catch (e) { outcome = 'failed'; detail = e.message; }
    const ms = Date.now() - t0;
    steps += 1;
    log(root, { id: step.id, task: step.task || null, say: step.say, result: outcome, detail, ms });
    if (onStep) await onStep({ ...step, result: outcome, detail, ms });
    if (outcome === 'failed') {
      const key = `${step.id}:${step.task || ''}:${detail}`;
      lastFail = lastFail.key === key ? { key, n: lastFail.n + 1 } : { key, n: 1 };
      if (/NO_HEADLESS_AGENT|No configured agent has a headless mode/.test(String(detail))) return result('failed', { reason: detail });
      if (lastFail.n >= SAME_FAIL_LIMIT) {
        const reason = `${step.id}${step.task ? ` ${step.task}` : ''} failed ${lastFail.n} times: ${detail}`;
        try { raise(root, `Ghostship autopilot stopped: ${reason}`, 'action'); } catch { /* best effort */ }
        return result('failed', { reason });
      }
    } else lastFail = { key: null, n: 0 };
    if (paused(root) && !paused(root).kind) return result('paused');
  }
  return result('stopped', { reason: `${maxSteps} steps` });
}

// ---------------------------------------------------------------- the CLI (gs autopilot …), called from gs.mjs

export function start(root, opts = {}) {
  return withLock(root, LOCK, () => startLocked(root, opts), { busy: (holder) => new FactoryError('AUTOPILOT_STARTING', `Another autopilot start is in progress${holder ? ` (pid ${holder})` : ''}. Check it with gs autopilot status.`) });
}

function startLocked(root, { once = false, maxSteps = 0 } = {}) {
  if (!stateExists(root)) throw new FactoryError('NO_STATE', 'Not a Ghostship project: run /ghostship init first.');
  const cur = statusOf(root);
  if (cur && ['running', 'waiting-owner', 'paused'].includes(cur.status)) throw new FactoryError('AUTOPILOT_RUNNING', `The autopilot runner is already ${cur.status} (pid ${cur.pid}). Stop it with gs autopilot stop.`);
  const state = load(root);
  if ((state.stage === 'new' || state.stage === 'adopt') && !state.prd?.approved) throw new FactoryError('BEFORE_PRD', 'The interview and the PRD are yours: finish them in the session (/ghostship new), then start the runner.');
  const cfg = loadConfig(root);
  if (!cfg.commands?.test) throw new FactoryError('NO_COMMAND', 'Set commands.test in .ghostship/config.yaml (gs config set commands.test "…") so the runner can record evidence.');
  if (!headlessAgent(cfg)) throw new FactoryError('NO_HEADLESS_AGENT', 'No configured agent can run headless. Claude (claude -p) or Codex (codex exec) under agents, or harnesses.<id>.headless, is needed.');
  const env = { ...process.env, ...(once ? { GS_AP_ONCE: '1' } : {}), ...(maxSteps ? { GS_AP_MAX: String(maxSteps) } : {}) };
  mkdirSync(join(root, RUNS_DIR), { recursive: true });
  // The fresh record goes first, so the runner's own writes (and a stop) land on it, never under it; the pid follows,
  // and is dropped if the runner has already finished or been stopped.
  writeState(root, { pid: null, startedAt: nowIso(), status: 'running', step: 0, last: null, reason: null, once }, { force: true });
  const child = spawn(process.execPath, [RUNNER, root], { detached: true, stdio: 'ignore', windowsHide: true, env });
  child.unref();
  const v = writeState(root, { pid: child.pid }) || readState(root);
  log(root, { id: 'runner', say: `autopilot runner started (pid ${child.pid})`, result: 'ok', ms: 0 });
  return v;
}

export function stop(root) {
  const r = statusOf(root);
  if (!r) throw new FactoryError('NO_AUTOPILOT', 'No autopilot runner has been started here.');
  if (TERMINAL.includes(r.status)) return r;
  if (r.status === 'lost') {
    log(root, { id: 'runner', say: 'stop requested by the owner; the runner process was already gone', result: 'ok', ms: 0 });
    return writeState(root, { status: 'stopped', reason: r.reason || 'its process was gone', endedAt: r.endedAt || nowIso() }) || readState(root);
  }
  // The record turns TERMINAL before the signal, so nothing the runner writes after it can bring `running` back.
  // If the runner finished first (done, failed), its own ending stands.
  const v = writeState(root, { status: 'stopped', reason: 'stopped by the owner', endedAt: nowIso() }) || readState(root);
  try { process.kill(r.pid, 'SIGTERM'); } catch { /* already gone */ }
  log(root, { id: 'runner', say: 'stop requested by the owner', result: 'ok', ms: 0 });
  return v;
}

export function statusText(r) {
  if (!r) return 'No autopilot runner. Start one with gs autopilot start.';
  const last = r.last ? ` · step ${r.step}: ${r.last.say}` : '';
  const why = r.reason ? ` · ${r.reason}` : '';
  return `autopilot: ${r.status}${r.pid ? ` (pid ${r.pid})` : ''}${last}${why}`;
}

export async function cli(root, sub, opt = {}, out = (t) => process.stdout.write(`${t}\n`)) {
  const json = !!opt.json;
  if (sub === 'start') { const r = start(root, { once: !!opt.once, maxSteps: Number(opt['max-steps'] || 0) }); return out(json ? r : `${statusText(r)}\nIt does each step itself and dispatches builders and judges headless. Watch it: gs autopilot status | log. Stop it: gs autopilot stop.`); }
  if (sub === 'stop') { const r = stop(root); return out(json ? r : statusText(r)); }
  if (sub === 'log') { const rows = readLog(root, Number(opt.tail || 20)); return out(json ? rows : rows.length ? rows.map((l) => `${l.at.slice(11, 19)} ${l.result.padEnd(13)} ${l.id}${l.task ? ` ${l.task}` : ''}${l.detail ? ` — ${l.detail}` : ''}`).join('\n') : 'No autopilot steps yet.'); }
  const r = statusOf(root);
  return out(json ? r : statusText(r));
}
