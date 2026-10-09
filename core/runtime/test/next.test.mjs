// gs next: one step at a time from a fresh init to a release, performed exactly as said; setup tasks; runs in flight;
// owner gates per autonomy mode; pauses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initProject } from '../lib/init.mjs';
import { loadConfig, saveConfig } from '../lib/config.mjs';
import { load } from '../lib/store.mjs';
import { writeActive, clearActive } from '../lib/runs.mjs';
import * as E from '../lib/engine.mjs';
import * as B from '../lib/bridge.mjs';
import { next, text } from '../lib/next.mjs';
import { projectAtBuild, CORE, GS, TTY, git, put, CHECKS } from './project.mjs';
import { mkdirSync } from 'node:fs';

const code = (fn) => { try { fn(); return null; } catch (e) { return e.code || e.message; } };

function freshProject({ autonomy = 'autopilot' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gs-next-'));
  initProject(dir, { name: 'math', coreSrc: CORE, gitIdentity: { name: 't', email: 't@t' }, which: () => null, tier: 'light' });
  git(dir, 'config', 'commit.gpgsign', 'false');
  const cfg = loadConfig(dir);
  cfg.commands.test = 'node scripts/unit.mjs';
  cfg.commands.acceptance = 'node scripts/acc.mjs {files}';
  cfg.autonomy = { ...(cfg.autonomy || {}), mode: autonomy };
  saveConfig(dir, cfg);
  put(dir, 'scripts/unit.mjs', "// Runs unit tests.\nimport { readdirSync } from 'node:fs';\nconst f = readdirSync('tests/unit').filter((x) => x.endsWith('.test.mjs'));\nfor (const x of f) await import('../tests/unit/' + x);\nconsole.log(f.length ? f.length + ' files passed' : 'no tests found');\n");
  put(dir, 'scripts/acc.mjs', "// Runs acceptance tests.\nconst f = process.argv.slice(2);\nif (!f.length) { console.log('no tests found'); process.exit(1); }\nfor (const x of f) await import('../' + x);\nconsole.log(f.length + ' acceptance files passed');\n");
  put(dir, 'tests/unit/.gitkeep', '');
  git(dir, 'add', '-A', '--', '.ghostship/config.yaml', 'scripts', 'tests/unit');
  git(dir, 'commit', '-qm', 'chore: runners');
  return dir;
}

const IMPL = { add: 'export const add = (a, b) => a + b;', sub: 'export const sub = (a, b) => a - b;' };
const NAME = { T001: 'add', T002: 'sub' };

/** A scripted builder: a failing unit test, RED, the code, GREEN and the acceptance evidence, exactly as the brief asks. */
function builder(dir, id) {
  const name = NAME[id];
  put(dir, `tests/unit/${name}.test.mjs`, `// Unit test for ${name}.\nimport { ${name} } from '../../src/${name}.mjs';\nif (${name}(7, 2) !== ${name === 'add' ? 9 : 5}) throw new Error('${name}');\n`);
  assert.equal(E.evidence(dir, { task: id, kind: 'red' }).accepted, true, `${id} red`);
  put(dir, `src/${name}.mjs`, `// ${name === 'add' ? 'Adds' : 'Subtracts'} two numbers.\n${IMPL[name]}\n`);
  E.codemap(dir);
  for (const k of ['green', 'acceptance']) assert.equal(E.evidence(dir, { task: id, kind: k }).accepted, true, `${id} ${k}`);
}

/** A scripted judge: runs the proof with the token, then passes every check. */
function judge(dir, id, token) {
  E.evidence(dir, { task: id, kind: 'judge', token });
  const t = load(dir).tasks[id];
  E.verdict(dir, { task: id, result: 'PASS', token, checks: Object.fromEntries(t.checks.map((c) => [c, `PASS ${c}`])) });
}

/** Performs one step exactly as next() said it, the way the orchestrator (or the runner) would. */
function perform(dir, n, ctx) {
  switch (n.id) {
    case 'interview.init': return E.interviewInit(dir);
    case 'interview': for (const a of E.interviewStatus(dir).open) E.interviewMark(dir, a, 'answered', 'ok'); return;
    case 'prd.write': return put(dir, n.path, '# PRD — math\n\n## add\nAdds two numbers.\n\n## sub\nSubtracts.\n');
    case 'prd.approve': return E.prdApprove(dir, TTY);
    case 'design.write': for (const p of n.paths) put(dir, p, `# ${p}\n\nTwo pure functions in src/, one file each, unit tests in tests/unit. Enough words to count as written.\n`); return;
    case 'design.done': return E.designDone(dir);
    case 'acceptance.write': return put(dir, n.path, CHECKS);
    case 'acceptance.approve': return n.kind === 'owner' ? E.acceptanceApprove(dir, TTY) : E.acceptanceApprove(dir, {}, { auto: true });
    case 'plan.write':
      put(dir, '.ghostship/drafts/tasks/T001.md', '---\nid: T001\ntitle: Add two numbers\nphase: 1-core\nchecks: [C1]\nallowedPaths: [src/add.mjs, tests/unit/add.test.mjs]\n---\n\n## Goal\nadd()\n');
      put(dir, '.ghostship/drafts/tasks/T002.md', '---\nid: T002\ntitle: Subtract two numbers\nphase: 1-core\nchecks: [C2]\nblockedBy: [T001]\nallowedPaths: [src/sub.mjs, tests/unit/sub.test.mjs]\n---\n\n## Goal\nsub()\n');
      return;
    case 'task.import': return E.taskImport(dir);
    case 'acceptance.tests':
      put(dir, 'tests/acceptance/C1-add.test.mjs', "// C1\nimport { add } from '../../src/add.mjs';\nif (add(2, 3) !== 5) throw new Error('C1');\n");
      put(dir, 'tests/acceptance/C2-sub.test.mjs', "// C2\nimport { sub } from '../../src/sub.mjs';\nif (sub(5, 3) !== 2) throw new Error('C2');\n");
      return;
    case 'acceptance.lock': return E.acceptanceLock(dir);
    case 'task.start': return E.taskStart(dir, n.task);
    case 'builder': return builder(dir, n.task);
    case 'submit': ctx.token = E.taskSubmit(dir, n.task).token; return;
    case 'judge': return judge(dir, n.task, ctx.token);
    case 'merge': return E.taskMerge(dir, n.task);
    case 'docs.check': return ctx.docs(dir, n);
    case 'release.candidate': return E.releaseCandidate(dir);
    case 'release.approve': return E.releaseApprove(dir, TTY);
    default: throw new Error(`the test does not know how to perform ${n.id}`);
  }
}

/** Fills every release doc that still carries a TODO mark, as the orchestrator does for docs-only work. */
function fillDocs(dir, n) {
  for (const rel of [...n.missing, ...n.unfilled]) {
    const p = join(dir, rel);
    const cur = existsSync(p) ? readFileSync(p, 'utf8') : `# ${rel}\n`;
    put(dir, rel, cur.replace(/<!-- ghostship:todo[^>]*-->/g, '').replace(/^\s*(\|.*)?TODO\b.*$/gm, 'Done.') + '\nWritten for the release.\n');
  }
}

function walk(dir, { max = 60, docs = fillDocs } = {}) {
  const seen = [];
  const ctx = { token: null, docs };
  for (let i = 0; i < max; i++) {
    const n = next(dir);
    assert.ok(['do', 'agent', 'owner', 'wait', 'done'].includes(n.kind), `kind ${n.kind}`);
    assert.ok(n.say && n.why, `say and why on ${n.id}`);
    seen.push(n);
    if (n.kind === 'done') return seen;
    assert.notEqual(n.kind, 'wait', `unexpected wait at ${n.id}`);
    assert.equal(E.status(dir).next, n.say, 'status().next is next().say');
    perform(dir, n, ctx);
  }
  throw new Error(`no done after ${max} steps: ${seen.map((s) => s.id).join(' → ')}`);
}

test('next: from a fresh init to a release, one step at a time, in autopilot; the owner is asked only at the PRD and the two stops', () => {
  const dir = freshProject();
  try {
    const seen = walk(dir);
    const ids = seen.map((s) => s.id);
    assert.deepEqual(ids, [
      'interview.init', 'interview', 'prd.write', 'prd.approve', 'design.write', 'design.done', 'acceptance.write', 'acceptance.approve',
      'plan.write', 'task.import', 'acceptance.tests', 'acceptance.lock',
      'task.start', 'builder', 'submit', 'judge', 'merge', 'task.start', 'builder', 'submit', 'judge', 'merge',
      'docs.check', 'release.candidate', 'release.approve', 'done',
    ]);
    const owner = seen.filter((s) => s.kind === 'owner').map((s) => s.id);
    assert.deepEqual(owner, ['interview', 'prd.approve', 'acceptance.approve', 'release.approve']);
    assert.deepEqual(seen.filter((s) => s.kind === 'agent').map((s) => `${s.role}${s.task ? ':' + s.task : ''}`), ['planner', 'builder:T001', 'judge:T001', 'builder:T002', 'judge:T002']);
    const j = seen.find((s) => s.id === 'judge');
    assert.equal(j.depth, 'light');
    assert.match(j.brief, /brief --role judge --task T001 --depth light --token <token>/);
    assert.match(j.say, /gs task reissue T001/);
    assert.equal(seen.find((s) => s.id === 'submit').command, 'node .ghostship/core/runtime/gs.mjs task submit T001');
    assert.equal(git(dir, 'describe', '--tags', 'main'), 'v0.1.0');
    assert.match(next(dir).say, /Released v0\.1\.0/);
    assert.match(text(seen[0]), /^→ Start the interview/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('next: full autonomy approves STOP 1 itself (acceptance.approve is a do, with --auto); PRD and STOP 2 stay with the owner', () => {
  const dir = freshProject({ autonomy: 'full' });
  try {
    const seen = walk(dir);
    const acc = seen.find((s) => s.id === 'acceptance.approve');
    assert.equal(acc.kind, 'do');
    assert.match(acc.command, /acceptance approve --auto$/);
    assert.deepEqual(seen.filter((s) => s.kind === 'owner').map((s) => s.id), ['interview', 'prd.approve', 'release.approve']);
    assert.equal(load(dir).acceptance.gate.via, 'autopilot');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('next: a setup task needs no failing test; green is accepted without red and red is refused with a clear message', () => {
  const dir = projectAtBuild();
  try {
    put(dir, '.ghostship/drafts/tasks/T003.md', '---\nid: T003\ntitle: Set up the lint runner\nkind: setup\nallowedPaths: [scripts/lint.mjs, tests/unit/lint.test.mjs]\n---\n\n## Goal\nA lint script.\n');
    assert.equal(next(dir).id, 'task.import', 'drafts are imported before anything else');
    E.taskImport(dir);
    const t = load(dir).tasks.T003;
    assert.equal(t.setup, true);
    assert.equal(t.noTdd, E.SETUP_NO_TDD);
    assert.match(readFileSync(join(dir, 'tasks', 'T003-set-up-the-lint-runner.md'), 'utf8'), /^setup: true$/m);
    E.taskStart(dir, 'T003');
    const n = next(dir);
    assert.equal(n.id, 'builder');
    assert.match(n.say, /setup task: make the build, lint and tests pass, then evidence --kind green/);
    assert.match(E.status(dir).next, /setup task/);
    put(dir, 'scripts/lint.mjs', '// Lints nothing yet.\nconsole.log("lint ok");\n');
    put(dir, 'tests/unit/lint.test.mjs', '// Proves the unit runner works.\nif (1 + 1 !== 2) throw new Error("math");\n');
    assert.equal(code(() => E.evidence(dir, { task: 'T003', kind: 'red' })), 'SETUP_TASK');
    E.codemap(dir);
    assert.equal(E.evidence(dir, { task: 'T003', kind: 'green' }).accepted, true, 'green without red');
    assert.equal(next(dir).id, 'submit');
    const sub = E.taskSubmit(dir, 'T003');
    assert.equal(next(dir).id, 'judge');
    E.evidence(dir, { task: 'T003', kind: 'judge', token: sub.token });
    E.verdict(dir, { task: 'T003', result: 'PASS', token: sub.token, checks: {} });
    assert.equal(next(dir).id, 'merge');
    // a plain task still needs RED first
    E.taskMerge(dir, 'T003');
    E.taskStart(dir, 'T001');
    assert.match(next(dir).say, /write a failing test, record evidence --kind red/);
    assert.equal(code(() => E.evidence(dir, { task: 'T001', kind: 'green' })), 'TDD_NO_RED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('next: a run in flight means wait; a run whose supervisor died means clear it; the lock gate names the setup task first', () => {
  const dir = projectAtBuild();
  try {
    E.taskStart(dir, 'T001');
    writeActive(dir, { runId: 't001-a1-builder-abc', role: 'builder', task: 'T001', agentId: 'claude-sonnet', status: 'running', supervisorPid: process.pid });
    let n = next(dir);
    assert.equal(n.kind, 'wait');
    assert.equal(n.id, 'run.wait');
    assert.equal(n.wait.seconds, 20);
    assert.match(n.say, /Wait for the builder on T001/);
    writeActive(dir, { runId: 't001-a1-builder-abc', role: 'builder', task: 'T001', agentId: 'claude-sonnet', status: 'running', supervisorPid: 999999 });
    n = next(dir);
    assert.equal(n.id, 'run.lost');
    assert.equal(n.kind, 'do');
    assert.match(n.command, /run clear$/);
    clearActive(dir);
    assert.equal(next(dir).id, 'builder');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('next: guided leaves a stuck task with the owner (decide); autopilot settles it and carries on; pauses wait for the right thing', () => {
  const dir = projectAtBuild();
  try {
    const cfg = loadConfig(dir); cfg.autonomy = { ...(cfg.autonomy || {}), mode: 'guided' }; saveConfig(dir, cfg);
    git(dir, 'commit', '-qam', 'chore: guided');
    for (let i = 1; i <= 3; i++) { E.taskStart(dir, 'T001'); E.taskFail(dir, 'T001', `x${i}`); }
    let n = next(dir);
    assert.equal(n.kind, 'owner');
    assert.equal(n.id, 'decide');
    assert.equal(n.owner.gate, 'decide');
    assert.match(n.say, /^You decide: gs decide T001 --grant 1 \| --drop$/);
    cfg.autonomy.mode = 'autopilot'; saveConfig(dir, cfg); git(dir, 'commit', '-qam', 'chore: autopilot');
    n = next(dir);
    assert.equal(n.id, 'task.start', 'the waiting decision was settled by policy: one more attempt');
    assert.equal(load(dir).tasks.T001.status, 'RETRY');
    B.pause(dir, 'lunch');
    n = next(dir);
    assert.equal(n.kind, 'owner');
    assert.equal(n.id, 'paused');
    assert.equal(n.owner.gate, 'go');
    assert.match(E.status(dir).next, /Resume work \(gs go\) — paused: lunch/);
    B.go(dir);
    put(dir, '.ghostship/runs/pause.json', JSON.stringify({ at: new Date().toISOString(), reason: 'night shift: 5h at 91%, resumes 23:30', kind: 'night-shift', resumeAt: new Date(Date.now() + 30 * 60000).toISOString() }));
    n = next(dir);
    assert.equal(n.kind, 'wait');
    assert.equal(n.id, 'night-shift');
    assert.ok(n.wait.seconds >= 60 && n.wait.seconds <= 1800);
    B.go(dir);
    assert.equal(next(dir).id, 'task.start');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gs next prints the step; before init it points at /ghostship init; a parked task shows in the candidate step', () => {
  const dir = projectAtBuild();
  const empty = mkdtempSync(join(tmpdir(), 'gs-empty-'));
  try {
    const r = spawnSync(process.execPath, [GS, 'next'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^→ Start T001 \(gs task start T001\)\n {3}ready: T001\n {3}\$ node \.ghostship\/core\/runtime\/gs\.mjs task start T001\n$/);
    const j = JSON.parse(spawnSync(process.execPath, [GS, 'next', '--json'], { cwd: dir, encoding: 'utf8' }).stdout);
    assert.equal(j.id, 'task.start');
    assert.equal(j.task, 'T001');
    const e = next(empty);
    assert.equal(e.kind, 'owner');
    assert.equal(e.id, 'init');
    // T001 parked (autopilot: 3 attempts + 1 auto grant), T002 waits on it → the candidate step names it
    const cfg = loadConfig(dir); cfg.docs['release-gate'] = false; saveConfig(dir, cfg); git(dir, 'commit', '-qam', 'chore: no docs gate');
    for (let i = 1; i <= 4; i++) { E.taskStart(dir, 'T001'); E.taskFail(dir, 'T001', `x${i}`); }
    assert.equal(load(dir).tasks.T001.status, 'PARKED');
    const n = next(dir);
    assert.equal(n.id, 'release.candidate');
    assert.deepEqual(n.parked, ['T001']);
    assert.match(n.say, /gs release candidate \(1 parked for STOP 2: T001\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(empty, { recursive: true, force: true }); }
});

test('gs config set and gs autonomy commit the config, so the next task start finds a clean tree', () => {
  const dir = projectAtBuild();
  const home = mkdtempSync(join(tmpdir(), 'gs-key-'));
  try {
    const bc = loadConfig(dir); bc.approvals.mode = 'bridge'; saveConfig(dir, bc); // this test exercises the Bridge-key approval path
    const gs = (args, input) => spawnSync(process.execPath, [GS, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, GHOSTSHIP_HOME: home }, input });
    let r = gs(['config', 'set', 'commands.lint', 'node scripts/lint.mjs', '--owner-key-stdin'], 'x'.repeat(64));
    assert.notEqual(r.status, 0, 'after STOP 1 a command change is gated');
    assert.equal(loadConfig(dir).approvals.mode, 'bridge', 'bridge mode: a press in the pane, proven by the owner key');
    mkdirSync(join(home, '.ghostship'), { recursive: true }); put(home, '.ghostship/bridge.key', 'k'.repeat(64) + '\n');
    r = gs(['config', 'set', 'commands.lint', 'node scripts/lint.mjs', '--owner-key-stdin'], 'k'.repeat(64));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(dir, 'status', '--porcelain', '--', '.ghostship/config.yaml'), '', 'config committed');
    assert.match(git(dir, 'log', '-1', '--format=%s'), /^chore: config commands\.lint$/);
    r = gs(['autonomy', 'guided', '--owner-key-stdin'], 'k'.repeat(64));
    assert.equal(r.status, 0, r.stderr);
    assert.match(git(dir, 'log', '-1', '--format=%s'), /^chore: autonomy guided$/);
    assert.equal(loadConfig(dir).commands.lint, 'node scripts/lint.mjs');
    assert.equal(E.taskStart(dir, 'T001').status, 'BUILDING', 'a clean tree: the task starts');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});
