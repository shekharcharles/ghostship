// Preflight: found up front, fixed once. Git runs against a throwaway global config, never the developer's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'gs-pre-home-'));
process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
const { preflight, preflightSummary, isDubious, gitProbe } = await import('../lib/preflight.mjs');
const { initProject } = await import('../lib/init.mjs');

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const repo = () => { const d = mkdtempSync(join(tmpdir(), 'gs-pre-')); git(d, 'init', '-q'); git(d, 'config', 'commit.gpgsign', 'false'); return d; };
const byId = (r, id) => r.checks.find((c) => c.id === id);

test('dubious ownership: git\'s refusal is recognised from its own words', () => {
  const msg = "fatal: detected dubious ownership in repository at '/workspace/test'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /workspace/test";
  assert.equal(isDubious(msg), true);
  assert.equal(isDubious('fatal: not a git repository (or any of the parent directories): .git'), false);
  assert.equal(isDubious(''), false);
});

test('a fresh repo with no author and no commit: both found at once, fixed repo-locally, first commit leaves secrets out', () => {
  const d = repo();
  try {
    writeFileSync(join(d, 'app.js'), 'console.log(1)\n');
    writeFileSync(join(d, '.env'), 'KEY=v\n');
    const before = preflight(d, { which: () => null });
    assert.equal(before.ok, false);
    assert.equal(byId(before, 'git-safe').ok, true);
    assert.equal(byId(before, 'git-identity').ok, false);
    assert.equal(byId(before, 'git-commit').ok, false);
    assert.match(byId(before, 'git-identity').fix, /git config user\.name/);
    assert.match(preflightSummary(before), /no git author.*no commit yet.*asks once/);
    assert.equal(byId(before, 'gh'), undefined, 'gh is checked only for a GitHub tracker');
    assert.equal(byId(before, 'herdr').ok, true, 'herdr is information only');

    const after = preflight(d, { fix: true, name: 'Shekhar Hussain', email: 's@example.com', which: () => null });
    assert.equal(after.ok, true, JSON.stringify(after.checks));
    assert.equal(byId(after, 'git-identity').fixed, true);
    assert.equal(byId(after, 'git-commit').fixed, true);
    assert.equal(git(d, 'config', '--local', 'user.name'), 'Shekhar Hussain', 'identity is repo-local');
    assert.equal(readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8'), '', 'nothing global without allowGlobal');
    const files = git(d, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
    assert.ok(files.includes('app.js'));
    assert.ok(!files.includes('.env'), 'a secrets file never goes into the first commit');
    assert.match(byId(after, 'git-commit').detail, /left out: \.env/);
    assert.equal(preflightSummary(after), '✓ all clear');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('without a name and email the identity is not guessed', () => {
  const d = repo();
  try {
    const r = preflight(d, { fix: true, which: () => null });
    assert.equal(byId(r, 'git-identity').ok, false);
    assert.equal(byId(r, 'git-commit').ok, false, 'no commit without an author');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a GitHub tracker needs gh installed and signed in', () => {
  const d = repo();
  try {
    const r = preflight(d, { tracker: 'github', which: () => null });
    assert.equal(byId(r, 'gh').ok, false);
    assert.match(byId(r, 'gh').fix, /gh auth login/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('not a repo: probe says so; --fix runs git init', () => {
  const d = mkdtempSync(join(tmpdir(), 'gs-pre-'));
  try {
    assert.deepEqual({ repo: gitProbe(d).repo, dubious: gitProbe(d).dubious }, { repo: false, dubious: false });
    const r = preflight(d, { fix: true, which: () => null });
    assert.equal(byId(r, 'git-safe').ok, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('init carries preflight in its result, and with an author it is all clear', () => {
  const d = mkdtempSync(join(tmpdir(), 'gs-pre-init-'));
  try {
    const r = initProject(d, { name: 'demo', coreSrc: CORE, gitIdentity: { name: 't', email: 't@t' }, which: () => null });
    assert.equal(r.committed, true);
    assert.equal(r.preflight.ok, true, JSON.stringify(r.preflight.checks));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('init without an author says it did not commit, and preflight names both fixes', () => {
  const d = mkdtempSync(join(tmpdir(), 'gs-pre-init-'));
  try {
    const r = initProject(d, { name: 'demo', coreSrc: CORE, which: () => null });
    assert.equal(r.committed, false);
    assert.ok(r.warnings.some((w) => /did not commit/.test(w)));
    assert.equal(byId(r.preflight, 'git-identity').ok, false);
    assert.equal(byId(r.preflight, 'git-commit').ok, false);
    const fixed = preflight(d, { fix: true, name: 'T', email: 't@t', which: () => null });
    assert.equal(fixed.ok, true, JSON.stringify(fixed.checks));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
