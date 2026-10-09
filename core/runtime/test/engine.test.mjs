// End-to-end lifecycle on a real git fixture: init → interview → PRD → design → STOP 1 → lock → tasks → merge → STOP 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initProject } from '../lib/init.mjs';
import { load } from '../lib/store.mjs';
import { loadConfig, saveConfig } from '../lib/config.mjs';
import * as E from '../lib/engine.mjs';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TTY = { via: 'tty', confirmed: true };
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const put = (dir, rel, s) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), s); };
const code = (fn) => { try { fn(); } catch (e) { return e.code || e.message; } return 'NO_ERROR'; };

const CHECKS = `# Acceptance checks — math

## Destination
A tiny math library.

## Checks
| # | check | kind | proven by | reference | source |
|---|---|---|---|---|---|
| C1 | add(2, 3) returns 5 | run | tests/acceptance/C1-* | - | PRD#add |
| C2 | sub(5, 3) returns 2 | run | tests/acceptance/C2-* | - | PRD#sub |

## Out of scope
1. Multiplication

## Unknowns
None identified — two pure functions.
`;

const UNIT = `// Runs every unit test file and reports a count.
import { readdirSync } from 'node:fs';
const files = readdirSync('tests/unit').filter((f) => f.endsWith('.test.mjs'));
let n = 0;
for (const f of files) { await import('../tests/unit/' + f); n++; }
console.log(n ? n + ' files passed' : 'no tests found');
`;
const ACC = `// Runs the acceptance test files given on the command line.
const files = process.argv.slice(2);
if (!files.length) { console.log('no tests found'); process.exit(1); }
for (const f of files) await import('../' + f);
console.log(files.length + ' acceptance files passed');
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gs-eng-'));
  initProject(dir, { name: 'math', coreSrc: CORE, gitIdentity: { name: 't', email: 't@t' }, which: () => null, tier: 'light' });
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function toPlan(dir) {
  E.interviewInit(dir);
  for (const a of E.interviewStatus(dir).open) E.interviewMark(dir, a, 'answered', 'covered in round 1');
  put(dir, 'docs/01-requirements/PRD.draft.md', '# PRD — math\n\n## add\nAdds two numbers.\n\n## sub\nSubtracts.\n');
  E.prdApprove(dir, TTY);
  put(dir, 'docs/02-design/BLUEPRINT.md', '# Blueprint\n\nTwo pure functions in src/, one file each, unit tests in tests/unit.\n');
  E.designDone(dir);
  put(dir, 'docs/03-acceptance/ACCEPTANCE-CHECKS.draft.md', CHECKS);
  E.acceptanceApprove(dir, TTY);
  // The owner wires the commands and runners (normally a skeleton task does this).
  const cfg = loadConfig(dir);
  cfg.commands.test = 'node scripts/unit.mjs';
  cfg.commands.acceptance = 'node scripts/acc.mjs {files}';
  cfg.docs['release-gate'] = false;
  saveConfig(dir, cfg);
  put(dir, 'scripts/unit.mjs', UNIT);
  put(dir, 'scripts/acc.mjs', ACC);
  put(dir, 'tests/unit/.gitkeep', '');
  git(dir, 'add', '-A', '--', '.ghostship/config.yaml', 'scripts', 'tests/unit');
  git(dir, 'commit', '-qm', 'chore: test runners');
}

function writeAcceptance(dir) {
  put(dir, 'tests/acceptance/C1-add.test.mjs', "// C1: add(2, 3) returns 5\nimport { add } from '../../src/add.mjs';\nif (add(2, 3) !== 5) throw new Error('C1');\n");
  put(dir, 'tests/acceptance/C2-sub.test.mjs', "// C2: sub(5, 3) returns 2\nimport { sub } from '../../src/sub.mjs';\nif (sub(5, 3) !== 2) throw new Error('C2');\n");
}

function draftTasks(dir) {
  put(dir, '.ghostship/drafts/tasks/T001.md', `---\nid: T001\ntitle: Add two numbers\nkind: feat\nchecks: [C1]\nallowedPaths: [src/add.mjs, tests/unit/add.test.mjs]\n---\n\n## Goal\nadd()\n`);
  put(dir, '.ghostship/drafts/tasks/T002.md', `---\nid: T002\ntitle: Subtract two numbers\nkind: feat\nchecks: [C2]\nblockedBy: [T001]\nallowedPaths: [src/sub.mjs, tests/unit/sub.test.mjs]\n---\n\n## Goal\nsub()\n`);
}

function buildToSubmit(dir, id, name, impl) {
  put(dir, `tests/unit/${name}.test.mjs`, `// Unit test for ${name}.\nimport { ${name} } from '../../src/${name}.mjs';\nif (${name}(7, 2) !== ${name === 'add' ? 9 : 5}) throw new Error('${name}');\n`);
  assert.equal(E.evidence(dir, { task: id, kind: 'red' }).accepted, true);
  put(dir, `src/${name}.mjs`, `// ${name === 'add' ? 'Adds' : 'Subtracts'} two numbers.\nexport const ${name} = ${impl};\n`);
  E.codemap(dir);
  for (const k of ['green', 'acceptance']) assert.equal(E.evidence(dir, { task: id, kind: k }).accepted, true, k);
  return E.taskSubmit(dir, id);
}

test('gates before STOP 1: coverage, PRD, design, lint, human gate', () => {
  const dir = setup();
  try {
    { const c = loadConfig(dir); c.approvals.mode = 'terminal'; saveConfig(dir, c); } // this test checks terminal-mode gate behaviour (tty vs non-tty, chat quotes rejected)
    assert.equal(load(dir).stage, 'new');
    E.interviewInit(dir);
    assert.equal(code(() => E.prdApprove(dir, TTY)), 'COVERAGE_OPEN');
    for (const a of E.interviewStatus(dir).open) E.interviewMark(dir, a, 'assumption', 'assumed');
    assert.equal(code(() => E.prdApprove(dir, TTY)), 'NO_PRD');
    put(dir, 'docs/01-requirements/PRD.draft.md', '# PRD\n\nA tiny math library for testing Ghostship.\n');
    assert.equal(code(() => E.prdApprove(dir, {})), 'HUMAN_GATE', 'terminal mode refuses a non-tty approval');
    assert.equal(code(() => E.prdApprove(dir, { via: 'chat', quote: 'yes' })), 'HUMAN_GATE', 'chat quotes only count in chat mode');
    E.prdApprove(dir, TTY);
    assert.ok(existsSync(join(dir, 'docs/01-requirements/PRD.md')));
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'develop');
    assert.equal(code(() => E.designDone(dir)), 'DESIGN_INCOMPLETE');
    put(dir, 'docs/02-design/BLUEPRINT.md', '# Blueprint\n\nTwo pure functions in src/, one file each.\n');
    E.designDone(dir);
    put(dir, 'docs/03-acceptance/ACCEPTANCE-CHECKS.draft.md', CHECKS.replace('returns 5', 'returns 5 and logs'));
    assert.equal(code(() => E.acceptanceApprove(dir, TTY)), 'ACCEPTANCE_LINT');
    put(dir, 'docs/03-acceptance/ACCEPTANCE-CHECKS.draft.md', CHECKS);
    E.acceptanceApprove(dir, TTY);
    assert.equal(load(dir).stage, 'plan');
    put(dir, 'docs/01-requirements/PRD.md', '# PRD\n\nchanged\n');
    assert.equal(code(() => E.taskImport(dir)), 'PRD_CHANGED', 'approved PRD is locked');
    assert.ok(E.audit(dir).problems.some((p) => /PRD changed/.test(p)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('full loop: lock → TDD task → judge → merge → retry → release', () => {
  const dir = setup();
  try {
    toPlan(dir);
    // acceptance lock needs a file per run check, and they must fail now
    put(dir, 'tests/acceptance/C1-add.test.mjs', "// C1\nimport { add } from '../../src/add.mjs';\n");
    assert.equal(code(() => E.acceptanceLock(dir)), 'ACCEPTANCE_TESTS_MISSING');
    writeAcceptance(dir);
    put(dir, 'src/stray.mjs', '// stray\n');
    assert.equal(code(() => E.acceptanceLock(dir)), 'DIRTY_TREE', 'code never rides in with the lock');
    rmSync(join(dir, 'src'), { recursive: true });
    const lock = E.acceptanceLock(dir);
    assert.deepEqual(Object.keys(lock.files).sort(), ['tests/acceptance/C1-add.test.mjs', 'tests/acceptance/C2-sub.test.mjs']);
    assert.match(git(dir, 'log', '-1', '--format=%s'), /^test\(acceptance\): lock C1 C2/);

    draftTasks(dir);
    const imp = E.taskImport(dir);
    assert.deepEqual(imp.imported, ['T001', 'T002']);
    assert.deepEqual(imp.uncovered, []);
    assert.ok(existsSync(join(dir, 'tasks/T001-add-two-numbers.md')));
    assert.match(readFileSync(join(dir, 'tasks/BOARD.md'), 'utf8'), /\| T002 \| Subtract two numbers \| TODO/);
    assert.equal(code(() => E.taskStart(dir, 'T002')), 'BLOCKED');

    // T001
    E.taskStart(dir, 'T001');
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'task/T001-add-two-numbers');
    assert.equal(code(() => E.taskStart(dir, 'T002')), 'TASK_ACTIVE');
    put(dir, 'src/add.mjs', '// Adds.\nexport const add = (a, b) => a + b;\n');
    put(dir, 'tests/unit/add.test.mjs', '// t\n');
    assert.equal(code(() => E.evidence(dir, { task: 'T001', kind: 'red' })), 'TDD_PRODUCTION_BEFORE_RED');
    rmSync(join(dir, 'src/add.mjs'));
    assert.equal(code(() => E.evidence(dir, { task: 'T001', kind: 'green' })), 'TDD_NO_RED');
    assert.equal(code(() => E.evidence(dir, { task: 'T001', kind: 'green', command: 'true' })), 'FIXED_COMMAND');
    put(dir, 'tests/unit/add.test.mjs', "// Unit test for add.\nimport { add } from '../../src/add.mjs';\nif (add(7, 2) !== 9) throw new Error('add');\n");
    assert.equal(E.evidence(dir, { task: 'T001', kind: 'red' }).accepted, true);
    put(dir, 'src/add.mjs', 'export const add = (a, b) => a + b;\n');
    assert.equal(E.evidence(dir, { task: 'T001', kind: 'green' }).accepted, true);
    assert.equal(E.evidence(dir, { task: 'T001', kind: 'acceptance' }).accepted, true);
    assert.equal(code(() => E.taskSubmit(dir, 'T001')), 'DOCS_GATE', 'no purpose header, no codemap');
    put(dir, 'src/add.mjs', '// Adds two numbers.\nexport const add = (a, b) => a + b;\n');
    E.codemap(dir);
    assert.equal(code(() => E.taskSubmit(dir, 'T001')), 'MISSING_EVIDENCE', 'evidence must match the submitted tree');
    for (const k of ['green', 'acceptance']) E.evidence(dir, { task: 'T001', kind: k });
    put(dir, 'tests/acceptance/C1-add.test.mjs', '// weakened\n');
    assert.equal(code(() => E.taskSubmit(dir, 'T001')), 'ACCEPTANCE_TESTS_CHANGED');
    git(dir, 'checkout', '--', 'tests/acceptance/C1-add.test.mjs');
    put(dir, 'README.md', '# changed outside scope\n');
    assert.equal(code(() => E.taskSubmit(dir, 'T001')), 'MISSING_EVIDENCE');
    git(dir, 'checkout', '--', 'README.md');
    const sub = E.taskSubmit(dir, 'T001');
    assert.ok(sub.token && sub.changed.includes('src/add.mjs'));
    assert.match(readFileSync(join(dir, 'docs/05-code/CODEMAP.md'), 'utf8'), /add\.mjs — Adds two numbers\./);

    assert.equal(code(() => E.verdict(dir, { task: 'T001', result: 'PASS', token: sub.token, checks: { C1: 'PASS' } })), 'NO_JUDGE_EVIDENCE');
    assert.equal(code(() => E.evidence(dir, { task: 'T001', kind: 'judge', token: 'nope' })), 'BAD_TOKEN');
    E.evidence(dir, { task: 'T001', kind: 'judge', token: sub.token, command: 'node scripts/acc.mjs tests/acceptance/C1-add.test.mjs' });
    E.verdict(dir, { task: 'T001', result: 'PASS', token: sub.token, checks: { C1: 'PASS add(2,3)=5' } });
    assert.equal(load(dir).tasks.T001.status, 'PASSED');
    const m = E.taskMerge(dir, 'T001');
    assert.equal(m.merged, true);
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'develop');
    assert.ok(git(dir, 'log', '--format=%s', '-3').split('\n').includes('feat(add): add two numbers (T001, C1)'));
    assert.equal(git(dir, 'branch', '--list', 'task/*'), '', 'task branch deleted');

    // T002: first attempt judged FAIL, second passes
    E.taskStart(dir, 'T002');
    let s2 = buildToSubmit(dir, 'T002', 'sub', '(a, b) => a - b');
    E.evidence(dir, { task: 'T002', kind: 'judge', token: s2.token });
    assert.equal(code(() => E.verdict(dir, { task: 'T002', result: 'FAIL', token: s2.token, checks: { C2: 'FAIL' } })), 'NO_REASON');
    E.verdict(dir, { task: 'T002', result: 'FAIL', token: s2.token, checks: { C2: 'FAIL edge case' }, reason: 'handle strings' });
    assert.equal(load(dir).tasks.T002.status, 'RETRY');
    assert.match(readFileSync(join(dir, 'tasks/T002-subtract-two-numbers.md'), 'utf8'), /attempt 1: handle strings/);
    E.taskStart(dir, 'T002');
    assert.equal(load(dir).tasks.T002.attempt, 2);
    put(dir, 'src/sub.mjs', '// Subtracts two numbers.\nexport const sub = (a, b) => Number(a) - Number(b);\n');
    for (const k of ['green', 'acceptance']) E.evidence(dir, { task: 'T002', kind: k });
    s2 = E.taskSubmit(dir, 'T002');
    E.evidence(dir, { task: 'T002', kind: 'judge', token: s2.token });
    E.verdict(dir, { task: 'T002', result: 'PASS', token: s2.token, checks: { C2: 'PASS' } });
    assert.equal(E.taskMerge(dir, 'T002').merged, true);

    // STOP 2
    assert.equal(E.status(dir).next, 'Prepare the release candidate: gs release candidate');
    const rc = E.releaseCandidate(dir);
    assert.equal(rc.version, '0.1.0');
    assert.equal(rc.result, 'PASS');
    const packet = readFileSync(join(dir, rc.packet), 'utf8');
    assert.match(packet, /\| C1 \| add\(2, 3\) returns 5 \| run \| T001 \| PASS/);
    assert.match(readFileSync(join(dir, 'docs/10-releases/CHANGELOG.md'), 'utf8'), /## 0\.1\.0[\s\S]*### Features\n- \*\*add\*\*: add two numbers/);
    assert.equal(code(() => E.releaseApprove(dir, {})), 'HUMAN_GATE');
    const rel = E.releaseApprove(dir, TTY);
    assert.equal(rel.tag, 'v0.1.0');
    assert.equal(git(dir, 'describe', '--tags', 'main'), 'v0.1.0');
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'develop');
    assert.ok(existsSync(join(dir, 'docs-site/index.html')) && existsSync(join(dir, 'docs-site/explorer.html')), 'docs site built at release');
    assert.ok(existsSync(join(dir, rel.site.archive)), 'and packed to ship');
    assert.match(readFileSync(join(dir, 'docs/01-requirements/TRACEABILITY.md'), 'utf8'), /\| add \| C1: add\(2, 3\) returns 5 \| run \| `C1-add\.test\.mjs` \| T001 \(MERGED/);
    assert.ok(existsSync(join(dir, 'docs/05-code/DEVELOPER-GUIDE.md')), 'SDLC docs scaffolded at design');
    const a = E.audit(dir);
    assert.deepEqual(a.problems, []);
    assert.equal(load(dir).stage, 'build');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('retry ceiling turns into a human decision (guided)', () => {
  const dir = setup();
  try {
    const c = loadConfig(dir); c.autonomy = { ...c.autonomy, mode: 'guided' }; saveConfig(dir, c);
    git(dir, 'commit', '-qam', 'guided');
    toPlan(dir);
    writeAcceptance(dir);
    E.acceptanceLock(dir);
    draftTasks(dir);
    E.taskImport(dir);
    for (let i = 1; i <= 3; i++) { E.taskStart(dir, 'T001'); E.taskFail(dir, 'T001', `try ${i}`); }
    assert.equal(load(dir).tasks.T001.status, 'NEEDS_DECISION');
    assert.equal(code(() => E.taskStart(dir, 'T001')), 'NEEDS_DECISION');
    assert.match(E.status(dir).next, /gs decide T001/);
    assert.equal(code(() => E.decide(dir, { task: 'T001', grant: 1 })), 'HUMAN_GATE');
    E.decide(dir, { task: 'T001', grant: 1, ...TTY });
    E.taskStart(dir, 'T001');
    assert.equal(load(dir).tasks.T001.attempt, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('task import validates scope, checks and cycles', () => {
  const dir = setup();
  try {
    toPlan(dir);
    put(dir, '.ghostship/drafts/tasks/T001.md', '---\nid: T001\ntitle: x\nchecks: [C9]\nallowedPaths: [src/**]\n---\n');
    assert.equal(code(() => E.taskImport(dir)), 'UNKNOWN_CHECK');
    put(dir, '.ghostship/drafts/tasks/T001.md', '---\nid: T001\ntitle: x\nchecks: [C1]\nallowedPaths: ["**"]\n---\n');
    assert.equal(code(() => E.taskImport(dir)), 'ALLOWED_PATHS_TOO_BROAD');
    put(dir, '.ghostship/drafts/tasks/T001.md', '---\nid: T001\ntitle: x\nchecks: [C1]\nallowedPaths: [tests/acceptance/**]\n---\n');
    assert.equal(code(() => E.taskImport(dir)), 'ALLOWED_PATHS_PROTECTED');
    put(dir, '.ghostship/drafts/tasks/T001.md', '---\nid: T001\ntitle: x\nchecks: [C1]\nblockedBy: [T002]\nallowedPaths: [src/a/**]\n---\n');
    put(dir, '.ghostship/drafts/tasks/T002.md', '---\nid: T002\ntitle: y\nchecks: [C2]\nblockedBy: [T001]\nallowedPaths: [src/b/**]\n---\n');
    assert.equal(code(() => E.taskImport(dir)), 'DEPENDENCY_CYCLE');
    put(dir, '.ghostship/drafts/tasks/T002.md', '---\nid: T002\ntitle: y\nchecks: [C2]\nallowedPaths: [src/b/**]\n---\n');
    E.taskImport(dir);
    assert.equal(code(() => E.taskStart(dir, 'T002')), 'ACCEPTANCE_NOT_LOCKED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
