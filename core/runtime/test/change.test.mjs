// Phase E: change after release (add a check), memory capture, learned rules with prediction and auto-revert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectAtBuild, put, git, TTY, GS } from './project.mjs';
import * as E from '../lib/engine.mjs';
import * as MEM from '../lib/memory.mjs';
import * as LEARN from '../lib/learn.mjs';
import { load } from '../lib/store.mjs';
import { evaluate } from '../lib/guard-rules.mjs';

const code = (fn) => { try { fn(); } catch (e) { return e.code || e.message; } return 'NO_ERROR'; };

function build(dir, id, name, impl, check) {
  E.taskStart(dir, id);
  put(dir, `tests/unit/${name}.test.mjs`, `// Unit test for ${name}.\nimport { ${name} } from '../../src/${name}.mjs';\nif (typeof ${name} !== 'function') throw new Error('${name}');\n`);
  E.evidence(dir, { task: id, kind: 'red' });
  put(dir, `src/${name}.mjs`, `// ${name}.\nexport const ${name} = ${impl};\n`);
  E.codemap(dir);
  for (const k of ['green', 'acceptance']) E.evidence(dir, { task: id, kind: k });
  const s = E.taskSubmit(dir, id);
  E.evidence(dir, { task: id, kind: 'judge', token: s.token });
  E.verdict(dir, { task: id, result: 'PASS', token: s.token, checks: { [check]: 'PASS' } });
  assert.equal(E.taskMerge(dir, id).merged, true);
}

test('/ghostship add: reopen the checks, add C3, amend the lock, plan and build only the new check', () => {
  const dir = projectAtBuild();
  try {
    build(dir, 'T001', 'add', '(a, b) => a + b', 'C1');
    build(dir, 'T002', 'sub', '(a, b) => a - b', 'C2');
    assert.equal(code(() => E.changeOpen(dir, { scope: 'acceptance', reason: 'add mul', via: 'tty', confirmed: false })), 'HUMAN_GATE');
    assert.equal(code(() => E.changeOpen(dir, { scope: 'acceptance', ...TTY })), 'NO_REASON');
    const r = E.changeOpen(dir, { scope: 'acceptance', reason: 'owner wants multiplication', ...TTY });
    assert.equal(r.draft, 'docs/03-acceptance/ACCEPTANCE-CHECKS.draft.md');
    assert.equal(load(dir).stage, 'acceptance');
    assert.equal(code(() => E.taskImport(dir)), 'ACCEPTANCE_NOT_APPROVED', 'no new work while the checks are open');
    const draft = readFileSync(join(dir, r.draft), 'utf8').replace('| C2 | sub(5, 3) returns 2 | run | tests/acceptance/C2-* | - | PRD#sub |',
      '| C2 | sub(5, 3) returns 2 | run | tests/acceptance/C2-* | - | PRD#sub |\n| C3 | mul(2, 3) returns 6 | run | tests/acceptance/C3-* | - | PRD#add |').replace('1. Multiplication', '1. Division');
    put(dir, r.draft, draft);
    E.acceptanceApprove(dir, TTY);
    const st = load(dir);
    assert.equal(st.acceptance.rev, 2);
    assert.deepEqual(st.acceptance.diff, { added: ['C3'], changed: [], removed: [] });
    assert.deepEqual(st.acceptance.checks.map((c) => `${c.id}@${c.rev}`), ['C1@1', 'C2@1', 'C3@2']);
    assert.deepEqual(E.coverage(dir).uncoveredRun, ['C3'], 'old checks stay covered by merged tasks');
    const guardState = load(dir);
    const w = (p) => evaluate(guardState, dir, { tool_name: 'Write', tool_input: { file_path: join(dir, p) } });
    assert.equal(w('tests/acceptance/C1-add.test.mjs').deny, true, 'unchanged checks stay locked');
    assert.equal(w('tests/acceptance/C3-mul.test.mjs').deny, false, 'the new check gets its test');
    put(dir, '.ghostship/drafts/tasks/T003.md', '---\nid: T003\ntitle: Multiply two numbers\nchecks: [C3]\nallowedPaths: [src/mul.mjs, tests/unit/mul.test.mjs]\n---\n');
    E.taskImport(dir);
    assert.equal(code(() => E.taskStart(dir, 'T003')), 'ACCEPTANCE_NOT_LOCKED');
    put(dir, 'tests/acceptance/C3-mul.test.mjs', "// C3\nimport { mul } from '../../src/mul.mjs';\nif (mul(2, 3) !== 6) throw new Error('C3');\n");
    const lock = E.acceptanceLock(dir);
    assert.equal(lock.rev, 2);
    assert.ok(lock.files['tests/acceptance/C1-add.test.mjs'] && lock.files['tests/acceptance/C3-mul.test.mjs']);
    assert.equal(load(dir).change, null);
    assert.equal(load(dir).changes.length, 1);
    build(dir, 'T003', 'mul', '(a, b) => a * b', 'C3');
    assert.deepEqual(E.coverage(dir).uncoveredRun, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('changing a check unlocks only its tests and needs a new task for it', () => {
  const dir = projectAtBuild();
  try {
    build(dir, 'T001', 'add', '(a, b) => a + b', 'C1');
    const r = E.changeOpen(dir, { scope: 'acceptance', reason: 'C1 must also take strings', ...TTY });
    put(dir, r.draft, readFileSync(join(dir, r.draft), 'utf8').replace('add(2, 3) returns 5', 'add("2", 3) returns 5'));
    E.acceptanceApprove(dir, TTY);
    const st = load(dir);
    assert.deepEqual(st.acceptance.diff.changed, ['C1']);
    assert.deepEqual(st.acceptanceLock.unlocked, ['tests/acceptance/C1-add.test.mjs']);
    assert.deepEqual(E.coverage(dir).uncoveredRun, ['C1'], 'the merged task proved the old C1, not the new one');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('memory: captured from verdicts and decisions, searched into briefs, promoted across projects', () => {
  const dir = projectAtBuild();
  const home = join(dir, '.home');
  try {
    E.taskStart(dir, 'T001');
    put(dir, 'tests/unit/add.test.mjs', "// Unit test for add.\nimport { add } from '../../src/add.mjs';\nif (add(1, 1) !== 2) throw new Error('x');\n");
    E.evidence(dir, { task: 'T001', kind: 'red' });
    put(dir, 'src/add.mjs', '// Adds.\nexport const add = (a, b) => a + b;\n');
    E.codemap(dir);
    for (const k of ['green', 'acceptance']) E.evidence(dir, { task: 'T001', kind: k });
    const s = E.taskSubmit(dir, 'T001');
    E.evidence(dir, { task: 'T001', kind: 'judge', token: s.token });
    E.verdict(dir, { task: 'T001', result: 'FAIL', token: s.token, checks: { C1: 'FAIL' }, reason: 'add ignores negative zero handling in numbers' });
    assert.match(readFileSync(join(dir, 'docs/11-memory/FAILED-APPROACHES.md'), 'utf8'), /\[T001\] attempt 1: add ignores negative zero/);
    MEM.add(dir, 'lesson', 'Use Number() before adding user input');
    assert.equal(MEM.add(dir, 'lesson', 'Use Number() before adding user input').duplicate, true);
    const hits = MEM.search(dir, 'add numbers input');
    assert.ok(hits.length >= 2 && hits[0].kind === 'failed');
    const brief = spawnSync(process.execPath, [GS, 'brief', '--role', 'builder', '--task', 'T001'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } }).stdout;
    assert.match(brief, /## Relevant memory[\s\S]*negative zero/);
    assert.match(brief, /## Earlier attempts[\s\S]*attempt 1 FAIL/);
    MEM.promote(dir, 'Lock acceptance tests before building', { project: 'math', home });
    assert.ok(MEM.search(dir, 'acceptance tests building', { home }).some((h) => h.kind === 'shared'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('learning: second occurrence makes a rule, briefs carry it, it is measured and reverted when it does not help', () => {
  const dir = projectAtBuild();
  try {
    LEARN.tickAttempt(dir);
    assert.equal(LEARN.observe(dir, { code: 'DOCS_GATE', task: 'T001' }), null, 'once is not a pattern');
    LEARN.tickAttempt(dir);
    const rule = LEARN.observe(dir, { code: 'DOCS_GATE', task: 'T002' });
    assert.equal(rule.id, 'L001');
    assert.match(rule.text, /purpose comment/);
    assert.match(rule.prediction, /fewer than 1\.00 "DOCS_GATE" per task attempt/);
    assert.match(readFileSync(join(dir, '.ghostship/learned/RULES.md'), 'utf8'), /L001/);
    assert.match(readFileSync(join(dir, 'docs/11-memory/SKILL-CHANGES.md'), 'utf8'), /L001 added after 2 occurrences/);
    assert.equal(LEARN.observe(dir, { code: 'DOCS_GATE', task: 'T003' }), null, 'no duplicate rule');
    assert.equal(LEARN.observe(dir, { code: 'NOT_A_LEARNABLE_CODE', task: 'T003' }), null);
    const j1 = LEARN.observe(dir, { code: 'JUDGE_FAIL', task: 'T001', text: 'Error messages leak stack traces to users' });
    const j2 = LEARN.observe(dir, { code: 'JUDGE_FAIL', task: 'T002', text: 'error messages leak stack traces to users!' });
    assert.equal(j1, null);
    assert.match(j2.text, /leak stack traces/);
    // the rule did not help: DOCS_GATE keeps happening every attempt → reverted after 5 attempts
    for (let i = 0; i < 5; i++) { LEARN.tickAttempt(dir); LEARN.observe(dir, { code: 'DOCS_GATE', task: `T00${i}` }); }
    const after = LEARN.rules(dir).find((r) => r.id === 'L001');
    assert.equal(after.status, 'reverted');
    assert.doesNotMatch(readFileSync(join(dir, '.ghostship/learned/RULES.md'), 'utf8'), /L001/);
    assert.match(readFileSync(join(dir, 'docs/11-memory/SKILL-CHANGES.md'), 'utf8'), /L001 reverted/);
    const s = spawnSync(process.execPath, [GS, 'learn', 'status'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } }).stdout;
    assert.match(s, /L001 \[reverted\][\s\S]*L002 \[kept\]/, "a rule that worked is kept");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a refused CLI call feeds learning', () => {
  const dir = projectAtBuild();
  try {
    const gs = (...a) => spawnSync(process.execPath, [GS, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    E.taskStart(dir, 'T001');
    put(dir, 'src/add.mjs', '// x\nexport const add = 1;\n');
    put(dir, 'tests/unit/add.test.mjs', '// t\n');
    assert.match(gs('evidence', '--task', 'T001', '--kind', 'red').stderr, /TDD_PRODUCTION_BEFORE_RED/);
    const second = gs('evidence', '--task', 'T001', '--kind', 'red').stderr;
    assert.match(second, /Ghostship learned L001: Write the failing test/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('review fixes: no release during an open change; protected paths never pass submit; judged tree is what merges', () => {
  const dir = projectAtBuild();
  try {
    build(dir, 'T001', 'add', '(a, b) => a + b', 'C1');
    E.taskStart(dir, 'T002');
    put(dir, 'tests/unit/sub.test.mjs', "// Unit test for sub.\nimport { sub } from '../../src/sub.mjs';\nif (typeof sub !== 'function') throw new Error('sub');\n");
    E.evidence(dir, { task: 'T002', kind: 'red' });
    put(dir, 'src/sub.mjs', '// Subtracts.\nexport const sub = (a, b) => a - b;\n');
    put(dir, '.ghostship/config.yaml', readFileSync(join(dir, '.ghostship/config.yaml'), 'utf8').replace('node scripts/unit.mjs', 'node -e 0'));
    E.codemap(dir);
    for (const k of ['green', 'acceptance']) E.evidence(dir, { task: 'T002', kind: k });
    assert.equal(code(() => E.taskSubmit(dir, 'T002')), 'PROTECTED_PATH');
    git(dir, 'checkout', '--', '.ghostship/config.yaml');
    for (const k of ['green', 'acceptance']) E.evidence(dir, { task: 'T002', kind: k });
    const s = E.taskSubmit(dir, 'T002');
    E.evidence(dir, { task: 'T002', kind: 'judge', token: s.token });
    E.verdict(dir, { task: 'T002', result: 'PASS', token: s.token, checks: { C2: 'PASS' } });
    put(dir, 'src/sub.mjs', '// Subtracts.\nexport const sub = () => 0;\n');
    git(dir, 'add', 'src/sub.mjs'); git(dir, 'commit', '-qm', 'sneaky');
    assert.equal(code(() => E.taskMerge(dir, 'T002')), 'TREE_CHANGED');
    git(dir, 'revert', '--no-edit', 'HEAD');
    assert.equal(E.taskMerge(dir, 'T002').merged, true);
    E.changeOpen(dir, { scope: 'prd', reason: 'more', ...TTY });
    assert.equal(code(() => E.releaseCandidate(dir)), 'CHANGE_OPEN');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
