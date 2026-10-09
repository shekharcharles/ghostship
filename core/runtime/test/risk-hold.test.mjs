// What a judged PASS still needs before it merges: risky paths get a full judge, a SECURITY lens and the owner; UI
// paths get a UX lens; a product assumption waits for the owner; a conflict with develop is found before any rebase;
// the owner merges a held task, or sends it back with a note the next builder reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectAtBuild, TTY, put, git, GS } from './project.mjs';
import * as E from '../lib/engine.mjs';
import * as D from '../lib/dispatch.mjs';
import { next, judgeDepth } from '../lib/next.mjs';
import { load } from '../lib/store.mjs';
import { loadConfig, saveConfig, defaultConfig, validateConfig } from '../lib/config.mjs';
import { riskyPaths, uiPaths, lensesFor, portFor } from '../lib/risk.mjs';

const mode = (dir, m) => { const c = loadConfig(dir); c.autonomy.mode = m; saveConfig(dir, c); E.commitConfig(dir, 'chore: autonomy'); };

/** T001 built test-first and submitted: returns the judge token and what submit reported. */
function buildT001(dir, { assume = null } = {}) {
  E.taskStart(dir, 'T001');
  put(dir, 'tests/unit/add.test.mjs', "// Unit test for add.\nimport { add } from '../../src/add.mjs';\nif (add(7, 2) !== 9) throw new Error('add');\n");
  assert.equal(E.evidence(dir, { task: 'T001', kind: 'red' }).accepted, true);
  put(dir, 'src/add.mjs', '// Adds two numbers.\nexport const add = (a, b) => a + b;\n');
  E.codemap(dir);
  for (const k of ['green', 'acceptance']) assert.equal(E.evidence(dir, { task: 'T001', kind: k }).accepted, true, k);
  if (assume) E.assume(dir, { task: 'T001', ...assume });
  return E.taskSubmit(dir, 'T001');
}
function judgeT001(dir, token, checks = {}) {
  assert.equal(E.evidence(dir, { task: 'T001', kind: 'judge', token, command: 'true' }).accepted, true);
  return E.verdict(dir, { task: 'T001', result: 'PASS', token, checks: { C1: 'PASS — add works', ...checks } });
}

test('risk: dependency, CI, deploy, migration and keyword paths are risky; author.js is not; a setup task may add its manifests', () => {
  const cfg = defaultConfig();
  const hits = riskyPaths(cfg, ['package.json', '.github/workflows/ci.yml', 'Dockerfile', 'db/migrations/001.sql', 'src/authService.ts', 'src/payments.js', 'src/author.js', 'src/rapid.js', 'src/add.mjs']);
  assert.deepEqual(hits.map((h) => `${h.path}:${h.why}`), ['package.json:dependency', '.github/workflows/ci.yml:ci', 'Dockerfile:deploy', 'db/migrations/001.sql:migration', 'src/authService.ts:risk-paths: auth', 'src/payments.js:risk-paths: payment']);
  assert.deepEqual(riskyPaths(cfg, ['package.json', '.github/workflows/ci.yml'], { setup: true }).map((h) => h.path), ['.github/workflows/ci.yml'], 'a setup task still may not touch CI unseen');
  assert.deepEqual(riskyPaths({ judge: { 'risk-paths': ['src/billing/**'] } }, ['src/billing/x.js', 'src/other.js']).map((h) => h.path), ['src/billing/x.js'], 'a risk-path with / or * is a glob');
  assert.deepEqual(uiPaths(cfg, ['src/App.vue', 'index.html', 'src/add.mjs']), ['src/App.vue', 'index.html']);
  assert.deepEqual(lensesFor(cfg, { risky: [{ path: 'x' }], ui: ['a.vue'] }), ['SECURITY', 'UX']);
  assert.deepEqual(lensesFor({ judge: { lenses: ['ux'] } }, { risky: [{ path: 'x' }], ui: [] }), [], 'a lens the owner turned off is not required');
  assert.equal(portFor('T003', 'builder'), 5130);
  assert.equal(portFor('T003', 'judge'), 5131);
  assert.deepEqual(validateConfig({ ...cfg, merge: { 'hold-risky': 'yes', 'hold-product-assumptions': true } }).filter((e) => /merge\./.test(e)).length, 1);
});

test('risky change (autopilot): full judge, SECURITY lens required, then held for the owner instead of merged; the owner merges it', () => {
  const dir = projectAtBuild({ configure: (c) => { c.judge['risk-paths'] = [...c.judge['risk-paths'], 'add']; } });
  try {
    const sub = buildT001(dir);
    assert.deepEqual(sub.risky.map((r) => r.path), ['src/add.mjs', 'tests/unit/add.test.mjs'], 'the keyword is a whole word of any changed path, tests too');
    assert.deepEqual(sub.lenses, ['SECURITY']);
    const t = load(dir).tasks.T001;
    assert.equal(judgeDepth(loadConfig(dir), t), 'full', 'risky paths always get the full judge');
    assert.equal(next(dir).depth, 'full');
    // The judge's brief carries the risky paths and the SECURITY checklist.
    const brief = readFileSync(join(dir, D.writeBrief(dir, { state: load(dir), task: t, role: 'judge', attempt: 1, token: sub.token, depth: 'full', changed: t.submit.changed, report: '.ghostship/runs/T001/a1-judge.report.md' })), 'utf8');
    assert.match(brief, /## Risky paths\n[\s\S]*src\/add\.mjs \(risk-paths: add\)/);
    assert.match(brief, /## Lens: SECURITY \(required\)/);
    assert.doesNotMatch(brief, new RegExp(sub.token), 'the token never reaches the brief on disk');
    assert.equal(E.evidence(dir, { task: 'T001', kind: 'judge', token: sub.token, command: 'true' }).accepted, true);
    assert.throws(() => E.verdict(dir, { task: 'T001', result: 'PASS', token: sub.token, checks: { C1: 'PASS' } }), /LENS_INCOMPLETE|SECURITY=PASS/);
    E.verdict(dir, { task: 'T001', result: 'PASS', token: sub.token, checks: { C1: 'PASS', SECURITY: 'PASS — pure function, no input' } });
    const m = E.taskMerge(dir, 'T001');
    assert.equal(m.merged, false);
    assert.equal(m.held, true);
    const held = load(dir).tasks.T001;
    assert.equal(held.status, 'PARKED', 'autopilot parks it for STOP 2 and moves on');
    assert.match(held.hold.reason, /risky change: src\/add\.mjs/);
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'develop', 'the checkout is free for other work');
    assert.ok(git(dir, 'branch', '--list', held.branch), 'the work stays on its branch');
    assert.ok(!existsSync(join(dir, 'src/add.mjs')), 'nothing merged into develop');
    assert.ok(E.waitingOnParked(load(dir)).includes('T002'), 'T002 waits on it');
    // The owner merges it.
    const r = E.decide(dir, { task: 'T001', merge: true, ...TTY });
    assert.equal(r.merged, true, JSON.stringify(r));
    const done = load(dir);
    assert.equal(done.tasks.T001.status, 'MERGED');
    assert.ok(done.decisions.some((d) => d.task === 'T001' && d.merge), 'the decision is on record');
    assert.ok(existsSync(join(dir, 'src/add.mjs')));
    const audit = E.audit(dir);
    assert.ok(audit.ok, `the records came through both branch switches intact: ${audit.problems.join('; ')}`);
    assert.throws(() => E.decide(dir, { task: 'T002', merge: true, ...TTY }), /is not held for a merge decision/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('risky change (guided): held as a decision; the owner sends it back with a note the next builder reads', () => {
  const dir = projectAtBuild({ configure: (c) => { c.judge['risk-paths'] = ['add']; c.autonomy.mode = 'guided'; } });
  try {
    const sub = buildT001(dir);
    judgeT001(dir, sub.token, { SECURITY: 'PASS' });
    E.taskMerge(dir, 'T001');
    assert.equal(load(dir).tasks.T001.status, 'NEEDS_DECISION');
    const n = next(dir);
    assert.equal(n.kind, 'owner');
    assert.match(n.say, /passed and waits for you before merging — gs decide T001 --merge/);
    assert.throws(() => E.decide(dir, { task: 'T001', drop: true, note: 'x', ...TTY }), /not --drop/);
    E.decide(dir, { task: 'T001', grant: 1, note: 'Guard against non-numbers: throw a TypeError.', ...TTY });
    const t = load(dir).tasks.T001;
    assert.equal(t.status, 'RETRY');
    assert.equal(t.hold, undefined, 'sent back: its PASS no longer stands');
    assert.deepEqual(t.history.slice(-2).map((h) => h.outcome), ['REWORK', 'OWNER_NOTE']);
    E.taskStart(dir, 'T001');
    assert.equal(load(dir).tasks.T001.status, 'BUILDING', 'back on the old branch after develop moved on, with the current records');
    assert.ok(E.audit(dir).ok, E.audit(dir).problems.join('; '));
    const brief = readFileSync(join(dir, D.writeBrief(dir, { state: load(dir), task: load(dir).tasks.T001, role: 'builder', attempt: 2, report: '.ghostship/runs/T001/a2-builder.report.md' })), 'utf8');
    assert.match(brief, /## The owner's notes \(address every one\)\n- after attempt 1: Guard against non-numbers: throw a TypeError\./);
    assert.match(brief, /## Earlier attempts\n- attempt 1 REWORK: owner sent it back/);
    assert.match(brief, /GS assume --task T001/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a held decision left from guided mode is parked, never rebuilt, when autopilot takes over', () => {
  const dir = projectAtBuild({ configure: (c) => { c.judge['risk-paths'] = ['add']; c.autonomy.mode = 'guided'; } });
  try {
    judgeT001(dir, buildT001(dir).token, { SECURITY: 'PASS' });
    E.taskMerge(dir, 'T001');
    assert.equal(load(dir).tasks.T001.status, 'NEEDS_DECISION');
    mode(dir, 'autopilot');
    E.settleDecisions(dir);
    const t = load(dir).tasks.T001;
    assert.equal(t.status, 'PARKED');
    assert.equal(t.maxAttempts, 3, 'no attempt granted: the judged work is kept');
    assert.ok(t.hold);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('assumptions: a product assumption holds the merge; the owner can turn that off; an inactive task takes none', () => {
  const dir = projectAtBuild();
  try {
    assert.throws(() => E.assume(dir, { task: 'T001', text: 'x' }), /is TODO; assumptions are recorded while it is built or judged/);
    const sub = buildT001(dir, { assume: { text: 'Free for every user: no paid tier', product: true } });
    assert.throws(() => E.assume(dir, { task: 'T001', text: '  ' }), /Say what you assumed/);
    E.assume(dir, { task: 'T001', text: 'Numbers only; strings are out of scope' });
    assert.deepEqual(sub.lenses, [], 'a plain change needs no lens');
    judgeT001(dir, sub.token);
    const m = E.taskMerge(dir, 'T001');
    assert.equal(m.held, true);
    assert.match(load(dir).tasks.T001.hold.reason, /product assumption: "Free for every user: no paid tier"/);
    assert.equal(load(dir).tasks.T001.assumptions.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const off = projectAtBuild({ configure: (c) => { c.merge['hold-product-assumptions'] = false; } });
  try {
    judgeT001(off, buildT001(off, { assume: { text: 'Free for every user', product: true } }).token);
    assert.equal(E.taskMerge(off, 'T001').merged, true);
  } finally { rmSync(off, { recursive: true, force: true }); }
});

test('UX lens: UI paths need UX=PASS, and the judge brief says how to look at it on its own port and browser session', () => {
  const dir = projectAtBuild({ configure: (c) => { c.judge['ui-paths'] = ['src/add.mjs']; c.commands.serve = 'node serve.mjs --port {port}'; } });
  try {
    const sub = buildT001(dir);
    assert.deepEqual(sub.lenses, ['UX']);
    const t = load(dir).tasks.T001;
    const brief = readFileSync(join(dir, D.writeBrief(dir, { state: load(dir), task: t, role: 'judge', attempt: 1, token: sub.token, depth: 'light', changed: t.submit.changed, report: '.ghostship/runs/T001/a1-judge.report.md' })), 'utf8');
    assert.match(brief, /## Lens: UX \(required\)/);
    assert.match(brief, /`node serve\.mjs --port 5111` with PORT=5111/);
    assert.match(brief, /--session T001-judge/);
    assert.equal(E.evidence(dir, { task: 'T001', kind: 'judge', token: sub.token, command: 'true' }).accepted, true);
    assert.throws(() => E.verdict(dir, { task: 'T001', result: 'PASS', token: sub.token, checks: { C1: 'PASS' } }), /UX=PASS/);
    E.verdict(dir, { task: 'T001', result: 'PASS', token: sub.token, checks: { C1: 'PASS', UX: 'PASS — no visible change' } });
    assert.equal(E.taskMerge(dir, 'T001').merged, true, 'a UX lens alone does not hold the merge');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('merge: a conflict with develop is found by merge-tree before any rebase, and the tree is left untouched', () => {
  const dir = projectAtBuild();
  try {
    judgeT001(dir, buildT001(dir).token);
    const branch = load(dir).tasks.T001.branch;
    // Someone else's add() lands on develop meanwhile.
    git(dir, 'checkout', '-q', 'develop');
    put(dir, 'src/add.mjs', '// Adds two numbers, differently.\nexport const add = (a, b) => b + a;\n');
    git(dir, 'add', 'src/add.mjs');
    git(dir, 'commit', '-qm', 'feat: other add');
    git(dir, 'checkout', '-q', branch);
    const r = E.taskMerge(dir, 'T001');
    assert.equal(r.merged, false);
    assert.deepEqual(r.files, ['src/add.mjs']);
    assert.ok(!existsSync(join(dir, '.git', 'rebase-merge')) && !existsSync(join(dir, '.git', 'rebase-apply')), 'no rebase was started');
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
    const t = load(dir).tasks.T001;
    const c = t.history.find((h) => h.outcome === 'MERGE_CONFLICT');
    assert.match(c?.reason || '', /conflicts with develop in src\/add\.mjs/);
    assert.equal(t.status, 'RETRY', 'autopilot policy: one more attempt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gs assume: an outside builder or judge may record an assumption; a planner may not, and nobody but the owner decides', () => {
  const dir = projectAtBuild();
  const gs = (role, ...args) => spawnSync(process.execPath, [GS, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir, GHOSTSHIP_ROLE: role } });
  try {
    E.taskStart(dir, 'T001');
    const b = gs('builder', 'assume', '--task', 'T001', '--text', 'Integers only', '--product');
    assert.equal(b.status, 0, b.stderr + b.stdout);
    assert.match(b.stdout, /assumption recorded \(a product decision/);
    assert.equal(gs('judge', 'assume', '--task', 'T001', '--text', 'Rounding is out of scope').status, 0);
    assert.match(gs('planner', 'assume', '--task', 'T001', '--text', 'x').stderr + gs('planner', 'assume', '--task', 'T001', '--text', 'x').stdout, /may not use `gs assume`/);
    assert.match(gs('builder', 'decide', 'T001', '--merge').stderr + gs('builder', 'decide', 'T001', '--merge').stdout, /may not use `gs decide/);
    assert.deepEqual(load(dir).tasks.T001.assumptions.map((a) => [a.text, a.product]), [['Integers only', true], ['Rounding is out of scope', false]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
