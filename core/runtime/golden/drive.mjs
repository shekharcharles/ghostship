// The golden-path driver: runs a Ghostship project from `gs init` to a tagged release by doing ONLY what `next()`
// says, with scripted stand-ins for the owner and for the builder, judge and planner. Every step must map to a
// handler here; a step the driver cannot act on is a failure, named, never a guess. Shared by the test suite
// (scripted agents, seconds) and run-live.mjs (the real autopilot runner and `claude -p`).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initProject } from '../lib/init.mjs';
import { loadConfig, saveConfig } from '../lib/config.mjs';
import { load } from '../lib/store.mjs';
import { check as docsCheck } from '../lib/docs.mjs';
import { next } from '../lib/next.mjs';
import * as E from '../lib/engine.mjs';

export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'todo-cli');
export const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TTY = { via: 'tty', confirmed: true };
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const put = (dir, rel, s) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), s); };
const copyTree = (from, to) => { if (existsSync(from)) cpSync(from, to, { recursive: true }); };

/** A fresh project folder with Ghostship set up, autonomy as asked, nothing else. */
export function freshProject({ mode = 'autopilot', name = 'todo' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gs-golden-'));
  initProject(dir, { name, coreSrc: CORE, gitIdentity: { name: 'golden', email: 'golden@example.com' }, which: () => null, tier: 'light' });
  git(dir, 'config', 'commit.gpgsign', 'false');
  const cfg = loadConfig(dir);
  cfg.autonomy = { ...(cfg.autonomy || {}), mode };
  saveConfig(dir, cfg);
  git(dir, 'add', '-A', '--', '.ghostship/config.yaml');
  if (git(dir, 'status', '--porcelain', '--', '.ghostship/config.yaml')) git(dir, 'commit', '-qm', `chore: autonomy ${mode}`);
  return dir;
}

// ---------------------------------------------------------------- scripted agents
/** The builder: tests first (RED), then the prepared solution (GREEN + the gates), the codemap, and "ready". */
export function scriptedBuilder(dir, task) {
  const t = load(dir).tasks[task];
  const sol = join(FIXTURE, 'solutions', task);
  if (!existsSync(sol)) throw new Error(`no prepared solution for ${task}`);
  const setup = t.setup || t.skeleton || t.noTdd;
  copyTree(join(sol, 'tests'), dir);
  if (!setup) {
    const red = E.evidence(dir, { task, kind: 'red' });
    if (!red.accepted) throw new Error(`${task}: RED not accepted: ${red.rejectReason}`);
  }
  copyTree(join(sol, 'code'), dir);
  const cfg = loadConfig(dir);
  const kinds = ['green'];
  if (t.checks.length && cfg.commands.acceptance) kinds.push('acceptance');
  if (cfg.commands.lint) kinds.push('lint');
  if (cfg.commands.typecheck) kinds.push('typecheck');
  E.codemap(dir);
  for (const k of kinds) {
    const ev = E.evidence(dir, { task, kind: k });
    if (!ev.accepted) throw new Error(`${task}: ${k} evidence rejected: ${ev.rejectReason}\n${readFileSync(join(dir, ev.dir, 'output.log'), 'utf8').slice(-800)}`);
  }
  return 'ready to submit';
}

/** The judge: runs the proof itself with its token, then a verdict with a line per check. */
export function scriptedJudge(dir, task, token) {
  const t = load(dir).tasks[task];
  const ev = E.evidence(dir, { task, kind: 'judge', token });
  if (!ev.accepted) return E.verdict(dir, { task, result: 'FAIL', token, checks: Object.fromEntries(t.checks.map((c) => [c, 'FAIL'])), reason: `judge run failed: ${ev.rejectReason}` });
  return E.verdict(dir, { task, result: 'PASS', token, checks: Object.fromEntries(t.checks.map((c) => [c, 'PASS proven by the acceptance test'])) });
}

/** The planner: the prepared task drafts and roadmap. */
export function scriptedPlanner(dir) {
  for (const f of readdirSync(join(FIXTURE, 'tasks'))) {
    if (f === 'ROADMAP.md') put(dir, 'docs/04-plan/ROADMAP.md', readFileSync(join(FIXTURE, 'tasks', f), 'utf8'));
    else put(dir, `.ghostship/drafts/tasks/${f}`, readFileSync(join(FIXTURE, 'tasks', f), 'utf8'));
  }
}

// ---------------------------------------------------------------- the loop
/**
 * Runs next() until done. `act` hooks let a caller replace the scripted agents (run-live.mjs uses the real runner).
 * Returns the trail: every step seen, in order, with how it was handled.
 */
export function drive(dir, { maxSteps = 120, maxRepeat = 3, act = {} } = {}) {
  const trail = [];
  let token = null;
  let last = null, repeats = 0;
  for (let i = 0; i < maxSteps; i++) {
    const n = next(dir);
    trail.push({ kind: n.kind, id: n.id, say: n.say, task: n.task || null });
    if (n.id === last) { repeats += 1; if (repeats >= maxRepeat) throw new Error(`spinning on ${n.id}: ${n.say}`); } else { last = n.id; repeats = 0; }
    if (n.kind === 'done') return trail;
    if (n.kind === 'wait') throw new Error(`cannot act on a wait step (${n.id}): ${n.say}`);
    const h = HANDLERS[n.id];
    if (!h) throw new Error(`no handler for next() step ${n.id} (${n.kind}): ${n.say}`);
    const r = h(dir, n, { token, act });
    if (r && typeof r === 'object' && 'token' in r) token = r.token;
  }
  throw new Error(`no release after ${maxSteps} steps; last: ${trail.at(-1)?.id}`);
}

const fixtureDoc = (name) => readFileSync(join(FIXTURE, 'docs', name), 'utf8');
const HANDLERS = {
  'interview.init': (dir) => E.interviewInit(dir),
  interview: (dir) => { for (const a of E.interviewStatus(dir).open) E.interviewMark(dir, a, 'answered', 'answered in the golden path'); },
  'prd.write': (dir, n) => put(dir, n.path, fixtureDoc('PRD.draft.md')),
  'prd.approve': (dir) => E.prdApprove(dir, TTY),
  'design.write': (dir, n) => {
    for (const p of n.paths || [n.path]) put(dir, p, fixtureDoc('BLUEPRINT.md'));
    // The design decides the runners: commands.* is agent-settable before STOP 1. Committed so a task can start on a clean tree.
    const cfg = loadConfig(dir);
    Object.assign(cfg.commands, JSON.parse(readFileSync(join(FIXTURE, 'config.json'), 'utf8')).commands);
    saveConfig(dir, cfg);
    git(dir, 'add', '-A', '--', '.ghostship/config.yaml');
    git(dir, 'commit', '-qm', 'chore(design): test runners');
  },
  'design.done': (dir) => E.designDone(dir),
  'acceptance.write': (dir, n) => put(dir, n.path, fixtureDoc('ACCEPTANCE-CHECKS.draft.md')),
  'acceptance.lint': (dir, n) => { throw new Error(`the fixture's checks fail lint: ${(n.errors || []).join('; ')}`); },
  'acceptance.approve': (dir, n) => (n.kind === 'owner' ? E.acceptanceApprove(dir, TTY) : E.acceptanceApprove(dir, {}, { auto: true })),
  'plan.write': (dir, n, { act }) => (act.planner || scriptedPlanner)(dir, n),
  'task.import': (dir) => E.taskImport(dir),
  'acceptance.tests': (dir) => { for (const f of readdirSync(join(FIXTURE, 'acceptance'))) put(dir, `tests/acceptance/${f}`, readFileSync(join(FIXTURE, 'acceptance', f), 'utf8')); },
  'acceptance.lock': (dir) => E.acceptanceLock(dir),
  'task.start': (dir, n) => E.taskStart(dir, n.task),
  builder: (dir, n, { act }) => (act.builder || scriptedBuilder)(dir, n.task, n),
  submit: (dir, n) => ({ token: E.taskSubmit(dir, n.task).token }),
  judge: (dir, n, { token, act }) => { if (!token) throw new Error('judge step without a token'); (act.judge || scriptedJudge)(dir, n.task, token, n); return { token: null }; },
  merge: (dir, n) => { const m = E.taskMerge(dir, n.task); if (!m.merged) throw new Error(`${n.task} did not merge: ${m.reason}`); },
  'docs.check': (dir, n) => { const dc = docsCheck(dir); if (!dc.ok) throw new Error(`docs unfilled after the skeleton: ${[...dc.missing, ...dc.unfilled].join(', ')}`); },
  'release.candidate': (dir) => { const r = E.releaseCandidate(dir); if (r.result === 'FAIL') throw new Error(`candidate v${r.version} is FAIL`); },
  'release.approve': (dir) => E.releaseApprove(dir, TTY),
};
