// Phase E operations: PRD change flow, safe-point upgrade with verification and rollback, migration, GitHub sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { projectAtBuild, put, git, TTY, CORE, GS, fakeBin } from './project.mjs';
import * as E from '../lib/engine.mjs';
import * as UP from '../lib/upgrade.mjs';
import * as MIG from '../lib/migrate.mjs';
import * as GH from '../lib/github.mjs';
import { initProject } from '../lib/init.mjs';
import { load } from '../lib/store.mjs';
import { loadConfig, saveConfig } from '../lib/config.mjs';

test('/ghostship change (PRD): PRD → design → checks reopen in turn', () => {
  const dir = projectAtBuild();
  try {
    const r = E.changeOpen(dir, { scope: 'prd', reason: 'add multiplication', ...TTY });
    assert.equal(r.draft, 'docs/01-requirements/PRD.draft.md');
    assert.equal(load(dir).stage, 'new');
    put(dir, r.draft, readFileSync(join(dir, r.draft), 'utf8') + '\n## mul\nMultiplies.\n');
    E.prdApprove(dir, TTY);
    assert.equal(load(dir).stage, 'design');
    E.designDone(dir);
    const st = load(dir);
    assert.equal(st.stage, 'acceptance');
    assert.equal(st.acceptance.approved, false, 'checks reopen after a PRD change');
    assert.ok(existsSync(join(dir, 'docs/03-acceptance/ACCEPTANCE-CHECKS.draft.md')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fakeCore(version, { broken = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'gs-core-'));
  cpSync(CORE, d, { recursive: true, filter: (p) => !/[\\/]vendor([\\/]|$)/.test(p) });
  writeFileSync(join(d, 'VERSION'), version + '\n');
  if (broken) writeFileSync(join(d, 'runtime/lib/engine.mjs'), 'throw new Error("broken core")\n');
  return d;
}

test('upgrade: waits for a safe point, verifies the new core on this project, keeps the old one for rollback', () => {
  const dir = projectAtBuild();
  const good = fakeCore('9.9.9'), bad = fakeCore('9.9.8', { broken: true });
  try {
    const before = readFileSync(join(dir, '.ghostship/core/VERSION'), 'utf8').trim();
    E.taskStart(dir, 'T001');
    assert.match(UP.apply(dir, { from: good }).reason, /Not a safe point: T001 is BUILDING/);
    E.taskFail(dir, 'T001', 'later');
    const b = UP.apply(dir, { from: bad });
    assert.equal(b.ok, false);
    assert.match(b.errors.join(), /audit with the new core failed/);
    assert.equal(readFileSync(join(dir, '.ghostship/core/VERSION'), 'utf8').trim(), before, 'nothing changed');
    const g = UP.apply(dir, { from: good });
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.equal(readFileSync(join(dir, '.ghostship/core/VERSION'), 'utf8').trim(), '9.9.9');
    assert.match(git(dir, 'log', '-1', '--format=%s'), new RegExp(`upgrade core ${before} → 9\\.9\\.9`));
    assert.equal(UP.check(dir, { from: good }).newer, false);
    const rb = UP.rollback(dir);
    assert.deepEqual([rb.ok, rb.from, rb.to], [true, '9.9.9', before]);
    assert.equal(readFileSync(join(dir, '.ghostship/core/VERSION'), 'utf8').trim(), before);
    assert.ok(git(dir, 'check-ignore', '.ghostship/core.prev/VERSION'), 'the kept copy is never committed');
  } finally { for (const d of [dir, good, bad]) rmSync(d, { recursive: true, force: true }); }
});

test('migrate: other tools\' files move to docs/archive/<tool>/, kept files stay, ask items wait for a decision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gs-mig-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) execFileSync('git', ['config', k, v], { cwd: dir });
    put(dir, '.planning/STATE.md', 'x'); put(dir, 'CONTEXT.md', 'glossary'); put(dir, 'CLAUDE.md', 'Use pnpm.\n'); put(dir, 'src/a.js', '// a\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'existing');
    initProject(dir, { name: 'old', coreSrc: CORE, which: () => null });
    const items = MIG.list(dir);
    assert.deepEqual(items.map((m) => [m.path, m.action]), [['.planning', 'archive'], ['CONTEXT.md', 'keep'], ['CLAUDE.md', 'ask']]);
    assert.throws(() => MIG.apply(dir, {}), /HUMAN_GATE|terminal|--quote/);
    const done = MIG.apply(dir, { ...TTY });
    assert.deepEqual(done.map((d) => d.status), ['archived', 'kept', 'planned']);
    assert.ok(existsSync(join(dir, 'docs/archive/gsd/planning/STATE.md')) && !existsSync(join(dir, '.planning')));
    assert.match(git(dir, 'log', '-1', '--format=%s'), /chore: migrate GSD into ghostship \(archived, nothing deleted\)/);
    const d2 = MIG.apply(dir, { which: [3], decisions: { 3: 'keep' }, ...TTY });
    assert.equal(d2[0].status, 'kept');
    assert.ok(existsSync(join(dir, 'CLAUDE.md')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const GH_FAKE = `
const fs = require('fs'); const a = process.argv.slice(2); const log = process.env.FAKE_GH_LOG;
let input = ''; try { input = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(log, JSON.stringify({ a, input: input.slice(0, 60) }) + '\\n');
const n = fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length;
if (a[0] === 'auth') process.exit(0);
if (a[0] === 'issue' && a[1] === 'create') console.log('https://github.com/o/r/issues/' + (100 + n));
if (a[0] === 'pr' && a[1] === 'create') console.log('https://github.com/o/r/pull/7');
`;

test('GitHub sync: off unless configured; issues per task, closes merged, release PR, pushes branches', () => {
  const dir = projectAtBuild({ configure: (c) => { c.tracker.mode = 'github'; } });
  const bin = mkdtempSync(join(tmpdir(), 'gs-bin-'));
  const remote = mkdtempSync(join(tmpdir(), 'gs-remote-'));
  try {
    const log = join(bin, 'gh.log');
    fakeBin(bin, 'gh', GH_FAKE);
    process.env.FAKE_GH_LOG = log;
    const exec = (b, args, o = {}) => GH.realExec(b === 'gh' ? join(bin, 'gh') : b, args, o);
    assert.match(GH.ready(dir, exec).reason, /no git remote/);
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(dir, 'remote', 'add', 'origin', remote);
    assert.equal(GH.ready(dir, exec).ok, true);
    let did = GH.sync(dir, { exec });
    assert.ok(did.includes('pushed develop, main and tags') || did.some((d) => /^pushed develop/.test(d)), did.join('|'));
    assert.ok(did.some((d) => /issue #\d+ for T001/.test(d)) && did.some((d) => /issue #\d+ for T002/.test(d)));
    assert.ok(execFileSync('git', ['--git-dir', remote, 'branch'], { encoding: 'utf8' }).includes('develop'));
    did = GH.sync(dir, { exec, push: false });
    assert.ok(!did.some((d) => /issue #/.test(d)), 'idempotent');
    const st = load(dir);
    assert.ok(st.tasks.T001.github.issue > 100);
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const create = calls.find((c) => c.a[0] === 'issue' && c.a[1] === 'create');
    assert.deepEqual(create.a.slice(0, 6), ['issue', 'create', '--title', 'T001 Add two numbers', '--label', 'ghostship']);
    assert.match(create.input, /^---\nid: T001/);
    const cfg = loadConfig(dir); cfg.tracker.mode = 'local'; saveConfig(dir, cfg);
    assert.throws(() => GH.sync(dir, { exec }), /tracker\.mode is local/);
  } finally { delete process.env.FAKE_GH_LOG; for (const d of [dir, bin, remote]) rmSync(d, { recursive: true, force: true }); }
});
