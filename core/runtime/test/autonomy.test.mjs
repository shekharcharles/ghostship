// Autonomy: autopilot decides stuck tasks by policy (one more attempt, then parked for STOP 2), full passes STOP 1 on a clean
// lint, guided keeps every gate with the owner, and only the owner changes the mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectAtBuild, GS, TTY, CHECKS, CORE, git, put } from './project.mjs';
import { initProject } from '../lib/init.mjs';
import { load } from '../lib/store.mjs';
import { loadConfig, saveConfig, validateConfig, autonomyOf } from '../lib/config.mjs';
import * as E from '../lib/engine.mjs';
import * as A from '../lib/asks.mjs';
import { evaluate, BUILDER } from '../lib/guard-rules.mjs';

const code = (fn) => { try { fn(); return 'OK'; } catch (e) { return e.code; } };
const failThrice = (dir, id) => { for (let i = 1; i <= 3; i++) { E.taskStart(dir, id); E.taskFail(dir, id, `try ${i}`); } };
const events = (dir) => readFileSync(join(dir, '.ghostship/state/events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('config: autopilot by default, validated, never agent-settable', () => {
  const dir = projectAtBuild();
  try {
    const cfg = loadConfig(dir);
    assert.deepEqual(autonomyOf(cfg), { mode: 'autopilot', autoRetries: 1, nightShift: false, nightShiftAt: 90 });
    assert.deepEqual(validateConfig(cfg), []);
    assert.match(validateConfig({ ...cfg, autonomy: { ...cfg.autonomy, mode: 'yolo' } }).join(), /autonomy\.mode/);
    assert.match(validateConfig({ ...cfg, autonomy: { ...cfg.autonomy, 'auto-retries': 9 } }).join(), /auto-retries/);
    assert.match(validateConfig({ ...cfg, autonomy: { ...cfg.autonomy, 'night-shift-at': 20 } }).join(), /night-shift-at/);
    const r = spawnSync(process.execPath, [GS, 'config', 'set', 'autonomy.mode', 'full'], { cwd: dir, encoding: 'utf8', input: '' });
    assert.match(r.stderr + r.stdout, /NOT_SETTABLE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('autopilot: a task out of attempts gets one more by policy, then is parked; its dependents are skipped; no owner ask', () => {
  const dir = projectAtBuild();
  try {
    failThrice(dir, 'T001');
    let t = load(dir).tasks.T001;
    assert.equal(t.status, 'RETRY', 'policy granted one more attempt instead of asking the owner');
    assert.equal(t.maxAttempts, 4);
    assert.equal(t.history.at(-1).outcome, 'AUTO_GRANT');
    assert.equal(load(dir).decisions.at(-1).gate.via, 'autopilot');
    assert.deepEqual(E.status(dir).needsDecision, []);
    E.taskStart(dir, 'T001'); E.taskFail(dir, 'T001', 'still no');
    t = load(dir).tasks.T001;
    assert.equal(t.status, 'PARKED');
    assert.match(t.parked.reason, /still no/);
    assert.ok(events(dir).some((e) => e.type === 'task.park' && e.ref === 'T001'), 'the log says it plainly');
    assert.equal(code(() => E.taskStart(dir, 'T001')), 'PARKED');
    assert.deepEqual(E.frontier(load(dir)), [], 'T002 waits on the parked T001, so nothing starts');
    assert.deepEqual(E.waitingOnParked(load(dir)), ['T002']);
    { const c = loadConfig(dir); c.docs['release-gate'] = false; saveConfig(dir, c); git(dir, 'commit', '-qam', 'chore: no docs gate'); }
    const s = E.status(dir);
    assert.deepEqual(s.parked, ['T001']);
    assert.equal(s.autonomy, 'autopilot');
    assert.match(s.next, /gs release candidate \(1 parked for STOP 2: T001\)/);
    assert.doesNotMatch(s.next, /You decide/);
    assert.ok(!A.list(dir).some((a) => a.id === 'G-T001'), 'no decision ask for the owner');
    assert.match(readFileSync(join(dir, 'tasks/BOARD.md'), 'utf8'), /\| T001 \| Add two numbers \| PARKED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('autopilot: a stall parks the same way; the owner un-parks with gs decide; drop works too', () => {
  const dir = projectAtBuild({ configure: (c) => { c.autonomy = { ...c.autonomy, 'auto-retries': 0 }; } });
  try {
    E.taskStart(dir, 'T001');
    E.escalateStall(dir, 'T001', 'no progress');
    assert.equal(load(dir).tasks.T001.status, 'PARKED', 'auto-retries 0: straight to parked');
    assert.equal(code(() => E.decide(dir, { task: 'T001', grant: 1 })), 'HUMAN_GATE', 'un-parking is the owner\'s');
    E.decide(dir, { task: 'T001', grant: 1, ...TTY });
    const t = load(dir).tasks.T001;
    assert.equal(t.status, 'RETRY');
    assert.equal(t.parked, undefined);
    E.taskStart(dir, 'T001');
    E.taskFail(dir, 'T001', 'again');
    assert.equal(load(dir).tasks.T001.status, 'RETRY', 'the stall parked it at attempt 1, so attempts remain after the grant');
    E.decide(dir, { task: 'T001', drop: true, ...TTY });
    assert.equal(load(dir).tasks.T001.status, 'DROPPED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('autopilot: the release candidate goes ahead with parked tasks listed for STOP 2', () => {
  const dir = projectAtBuild({ configure: (c) => { c.autonomy = { ...c.autonomy, 'auto-retries': 0 }; c.docs = { ...c.docs, 'release-gate': false }; } });
  try {
    failThrice(dir, 'T001');
    assert.equal(load(dir).tasks.T001.status, 'PARKED');
    const rc = E.releaseCandidate(dir);
    const packet = readFileSync(join(dir, rc.packet), 'utf8');
    assert.match(packet, /## Parked tasks/);
    assert.match(packet, /\| T001 Add two numbers \| 3\/3 \| builder gave up: try 3 \| T002 \|/);
    assert.match(packet, /\| C1 \| add\(2, 3\) returns 5 \| run \| T001 \| PARKED \(T001\)/);
    assert.equal(rc.result, 'FAIL', 'an honest result: parked checks do not pass');
    assert.equal(code(() => E.releaseApprove(dir, {})), 'RELEASE_BLOCKED', 'a FAIL packet needs the owner to override');
    assert.equal(code(() => E.releaseApprove(dir, { override: true })), 'HUMAN_GATE', 'STOP 2 stays with the owner');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guided keeps the owner decision', () => {
  const dir = projectAtBuild({ configure: (c) => { c.autonomy = { ...c.autonomy, mode: 'guided' }; } });
  try {
    failThrice(dir, 'T001');
    assert.equal(load(dir).tasks.T001.status, 'NEEDS_DECISION');
    assert.match(E.status(dir).next, /You decide: gs decide T001/);
    assert.ok(A.list(dir).some((a) => a.id === 'G-T001'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function atAcceptance(configure) {
  const dir = mkdtempSync(join(tmpdir(), 'gs-auto-'));
  initProject(dir, { name: 'math', coreSrc: CORE, gitIdentity: { name: 't', email: 't@t' }, which: () => null, tier: 'light' });
  git(dir, 'config', 'commit.gpgsign', 'false');
  if (configure) { const c = loadConfig(dir); configure(c); saveConfig(dir, c); git(dir, 'commit', '-qam', 'config'); }
  E.interviewInit(dir);
  for (const a of E.interviewStatus(dir).open) E.interviewMark(dir, a, 'answered', 'ok');
  put(dir, 'docs/01-requirements/PRD.draft.md', '# PRD — math\n\n## add\nAdds two numbers.\n\n## sub\nSubtracts.\n');
  E.prdApprove(dir, TTY);
  put(dir, 'docs/02-design/BLUEPRINT.md', '# Blueprint\n\nTwo pure functions in src/, one file each, unit tests in tests/unit.\n');
  E.designDone(dir);
  return dir;
}

test('full: STOP 1 passes by policy only with a clean lint, and only in full', () => {
  const full = atAcceptance((c) => { c.autonomy = { ...c.autonomy, mode: 'full' }; });
  const auto = atAcceptance();
  const gs = (dir, ...args) => spawnSync(process.execPath, [GS, ...args], { cwd: dir, encoding: 'utf8', input: '' });
  try {
    assert.match(E.status(full).next, /Write the acceptance checks/);
    put(full, 'docs/03-acceptance/ACCEPTANCE-CHECKS.draft.md', '# Acceptance checks — math\n\nnot a contract\n');
    assert.match(E.status(full).next, /Fix the acceptance checks/);
    let r = gs(full, 'acceptance', 'approve', '--auto');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /ACCEPTANCE_LINT/);
    put(full, 'docs/03-acceptance/ACCEPTANCE-CHECKS.draft.md', CHECKS);
    r = gs(full, 'acceptance', 'approve', '--auto');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(load(full).acceptance.gate.via, 'autopilot');
    assert.equal(load(full).stage, 'plan');

    put(auto, 'docs/03-acceptance/ACCEPTANCE-CHECKS.draft.md', CHECKS);
    r = gs(auto, 'acceptance', 'approve', '--auto');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /Only autonomy mode full/);
    assert.equal(load(auto).stage, 'acceptance');
  } finally { rmSync(full, { recursive: true, force: true }); rmSync(auto, { recursive: true, force: true }); }
});

test('gs autonomy: anyone reads it; only the owner changes it (terminal, quote or Bridge key)', () => {
  const dir = projectAtBuild();
  const home = mkdtempSync(join(tmpdir(), 'gs-key-'));
  const env = { ...process.env, GHOSTSHIP_HOME: home };
  const gs = (args, input = '') => spawnSync(process.execPath, [GS, ...args], { cwd: dir, env, input, encoding: 'utf8' });
  try {
    mkdirSync(join(home, '.ghostship'));
    const key = 'c'.repeat(64);
    writeFileSync(join(home, '.ghostship', 'bridge.key'), key + '\n', { mode: 0o600 });
    const bc = loadConfig(dir); bc.approvals.mode = 'bridge'; saveConfig(dir, bc); // this test exercises the Bridge-key approval path
    let r = gs(['autonomy']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /autonomy: autopilot · auto-retries 1 · night shift off/);
    r = gs(['autonomy', 'guided']);
    assert.notEqual(r.status, 0, 'an agent cannot loosen or tighten it');
    assert.match(r.stderr + r.stdout, /HUMAN_GATE/);
    assert.equal(loadConfig(dir).autonomy.mode, 'autopilot');
    r = gs(['autonomy', 'yolo', '--owner-key-stdin'], key);
    assert.match(r.stderr + r.stdout, /BAD_MODE/);
    r = gs(['autonomy', 'full', '--night-shift', 'on', '--owner-key-stdin'], key);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /autonomy: full · auto-retries 1 · night shift on at 90%/);
    assert.deepEqual(autonomyOf(loadConfig(dir)), { mode: 'full', autoRetries: 1, nightShift: true, nightShiftAt: 90 });
    r = gs(['autonomy', '--auto-retries', '7', '--owner-key-stdin'], key);
    assert.match(r.stderr + r.stdout, /BAD_CONFIG.*auto-retries/);
    for (const cmd of ['node .ghostship/core/runtime/gs.mjs autonomy guided', 'node .ghostship/core/runtime/gs.mjs preflight --fix']) {
      assert.equal(evaluate({ tasks: {} }, dir, { tool_name: 'Bash', tool_input: { command: cmd }, agent_type: BUILDER }).deny, true, cmd);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('a decision already waiting (from guided or an older core) is settled by autopilot policy: one more attempt, then parked', async () => {
  const { projectAtBuild } = await import('./project.mjs');
  const E2 = await import('../lib/engine.mjs');
  const { loadConfig: lc, saveConfig: sc } = await import('../lib/config.mjs');
  const dir = projectAtBuild();
  try {
    let cfg = lc(dir); cfg.autonomy = { ...(cfg.autonomy || {}), mode: 'guided' }; sc(dir, cfg);
    const { git: g } = await import('./project.mjs'); g(dir, 'commit', '-qam', 'chore: guided');
    for (let i = 1; i <= 3; i++) { E2.taskStart(dir, 'T001'); E2.taskFail(dir, 'T001', `x${i}`); }
    assert.equal(E2.status(dir).needsDecision[0], 'T001', 'guided leaves it with the owner');
    assert.deepEqual(E2.settleDecisions(dir), [], 'guided: nothing settled');
    cfg = lc(dir); cfg.autonomy.mode = 'autopilot'; sc(dir, cfg);
    assert.deepEqual(E2.settleDecisions(dir), ['T001']);
    const t = (await import('../lib/store.mjs')).load(dir).tasks.T001;
    assert.equal(t.status, 'RETRY', 'one more attempt by policy');
    assert.equal(E2.status(dir).needsDecision.length, 0, 'nothing waits for the owner');
    assert.doesNotMatch(E2.status(dir).next, /You decide/);
  } finally { (await import('node:fs')).rmSync(dir, { recursive: true, force: true }); }
});
