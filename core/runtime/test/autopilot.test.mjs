// Autopilot: the stop hook keeps the loop going while there is work without the owner, lets the session rest while the
// owner is the one waited on, and pauses rather than loops; night shift pauses at the plan limit and resumes after it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectAtBuild, CORE, TTY, put, git } from './project.mjs';
import * as E from '../lib/engine.mjs';
import * as B from '../lib/bridge.mjs';
import { initProject } from '../lib/init.mjs';
import { load } from '../lib/store.mjs';
import { loadConfig, saveConfig } from '../lib/config.mjs';

const HOOK = (n) => join(CORE, 'runtime', 'hooks', n);
const run = (file, dir, input) => spawnSync(process.execPath, [file], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
const stop = (dir) => { const out = run(HOOK('stop.mjs'), dir, {}).stdout; return out ? JSON.parse(out) : null; };
const mode = (dir, autonomy) => { const c = loadConfig(dir); c.autonomy = { ...(c.autonomy || {}), ...autonomy }; saveConfig(dir, c); };
const limits = (dir, fiveHour) => {
  mkdirSync(join(dir, '.ghostship/runs'), { recursive: true });
  writeFileSync(join(dir, '.ghostship/runs/heartbeat.json'), JSON.stringify({ at: new Date().toISOString(), source: 'mod', limits: { fiveHour } }));
};
const CHECKS = '# Acceptance checks — math\n\n## Destination\nA tiny math library.\n\n## Checks\n| # | check | kind | proven by | reference | source |\n|---|---|---|---|---|---|\n| C1 | add(2, 3) returns 5 | run | tests/acceptance/C1-* | - | PRD#add |\n\n## Out of scope\n1. Multiplication\n\n## Unknowns\nNone identified.\n';

function projectAtStop1() {
  const dir = mkdtempSync(join(tmpdir(), 'gs-ap-'));
  initProject(dir, { name: 'math', coreSrc: CORE, gitIdentity: { name: 't', email: 't@t' }, which: () => null, tier: 'light' });
  git(dir, 'config', 'commit.gpgsign', 'false');
  E.interviewInit(dir);
  for (const a of E.interviewStatus(dir).open) E.interviewMark(dir, a, 'answered', 'ok');
  put(dir, 'docs/01-requirements/PRD.draft.md', '# PRD — math\n\n## add\nAdds two numbers and returns their sum.\n\n## Notes\nPure functions only.\n');
  E.prdApprove(dir, TTY);
  put(dir, 'docs/02-design/BLUEPRINT.md', '# Blueprint\n\nOne pure function in src/, one file, unit tests in tests/unit.\n');
  E.designDone(dir);
  return dir;
}

test('autopilot: with the next task startable and no agent working, a stop is blocked with "keep going"', () => {
  const dir = projectAtBuild();
  try {
    mode(dir, { mode: 'autopilot' });
    const s = stop(dir);
    assert.equal(s.decision, 'block');
    assert.match(s.reason, /Ghostship autopilot: keep going — .*T001/);
    assert.match(s.reason, /Do not ask the owner/);
    mode(dir, { mode: 'guided' });
    assert.equal(stop(dir), null, 'guided: the session rests between tasks');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('autopilot: a builder working in the background lets the session rest', () => {
  const dir = projectAtBuild();
  try {
    mode(dir, { mode: 'autopilot' });
    run(HOOK('guard.mjs'), dir, { tool_name: 'Read', tool_input: { file_path: `${dir}/src/add.mjs` }, agent_type: 'ghostship-builder', cwd: dir });
    for (let i = 0; i < 4; i++) assert.equal(stop(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('autopilot: waiting at STOP 1 for the owner lets the session rest; full mode keeps going to approve it by policy', () => {
  const dir = projectAtStop1();
  try {
    mode(dir, { mode: 'autopilot' });
    const writing = stop(dir);
    assert.equal(writing?.decision, 'block', 'the checks are not written yet: that is the orchestrator\'s work');
    put(dir, 'docs/03-acceptance/ACCEPTANCE-CHECKS.draft.md', CHECKS);
    assert.ok(E.acceptanceLint(dir).ok);
    assert.equal(stop(dir), null, 'checks written and clean: STOP 1 is the owner\'s');
    mode(dir, { mode: 'full' });
    assert.equal(stop(dir)?.decision, 'block', 'full approves STOP 1 by policy, so it is work');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('autopilot: the interview and an owner pause are never pushed on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gs-ap-'));
  try {
    initProject(dir, { name: 'x', coreSrc: CORE, gitIdentity: { name: 't', email: 't@t' }, which: () => null, tier: 'light' });
    mode(dir, { mode: 'autopilot' });
    assert.equal(stop(dir), null, 'the interview is the owner\'s');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const b = projectAtBuild();
  try {
    mode(b, { mode: 'autopilot' });
    B.pause(b, 'lunch');
    assert.equal(stop(b), null);
  } finally { rmSync(b, { recursive: true, force: true }); }
});

test('autopilot: no progress after the limit pauses with an action alert instead of looping', () => {
  const dir = projectAtBuild();
  try {
    mode(dir, { mode: 'autopilot' });
    for (let i = 1; i <= 3; i++) assert.match(stop(dir).reason, new RegExp(`${i}/3 no-progress stops`));
    const last = stop(dir);
    assert.match(last.systemMessage, /autopilot made no progress after 3 tries, so it paused/);
    assert.match(B.paused(dir).reason, /autopilot made no progress/);
    assert.ok(B.alertsSince(dir).alerts.some((a) => a.level === 'action' && /Ghostship paused/.test(a.alert)));
    assert.equal(load(dir).tasks.T001.status, 'TODO', 'no task is escalated');
    assert.equal(stop(dir), null, 'paused: the session rests');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('night shift: pauses at the 5h threshold, resumes after the reset; an owner pause is never resumed for them', () => {
  const dir = projectAtBuild();
  try {
    mode(dir, { mode: 'autopilot', 'night-shift': true, 'night-shift-at': 90 });
    limits(dir, { percent: 80, resetsAt: new Date(Date.now() + 3600e3).toISOString() });
    B.tick(dir, {});
    assert.equal(B.paused(dir), null, 'below the line: no pause');
    limits(dir, { percent: 93, resetsAt: new Date(Date.now() + 3600e3).toISOString() });
    const t = B.tick(dir, {});
    assert.equal(B.paused(dir).kind, 'night-shift');
    assert.match(B.paused(dir).reason, /night shift: 5h at 93%, resumes \d\d:\d\d/);
    assert.deepEqual(t.autonomy, { mode: 'autopilot', nightShift: true, nightShiftAt: 90, autoRetries: 1 });
    assert.ok(Array.isArray(t.parked));
    const pz = B.paused(dir);
    writeFileSync(join(dir, '.ghostship/runs/pause.json'), JSON.stringify({ ...pz, resumeAt: new Date(Date.now() - 1000).toISOString() }));
    limits(dir, { percent: 93, resetsAt: new Date(Date.now() - 1000).toISOString() });
    B.tick(dir, {});
    assert.equal(B.paused(dir), null, 'past the reset: resumed');
    B.tick(dir, {});
    assert.equal(B.paused(dir), null, 'a stale reading (reset already past) does not pause again');
    assert.ok(B.alertsSince(dir).alerts.some((a) => /night shift over: resuming/.test(a.alert)));
    B.pause(dir, 'lunch');
    limits(dir, { percent: 5, resetsAt: new Date(Date.now() + 3600e3).toISOString() });
    B.tick(dir, {});
    assert.equal(B.paused(dir).reason, 'lunch', 'the owner\'s pause waits for the owner');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
