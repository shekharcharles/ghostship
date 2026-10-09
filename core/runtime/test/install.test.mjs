// install.mjs writes only the five ~/.ghostship entries and the launcher skill; re-runs upgrade by version or by content,
// keep one rollback copy, and never lose the installed core to a crash mid-copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, statSync, readFileSync, mkdirSync, cpSync, chmodSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const run = (home, pkg = PKG, ...extra) => spawnSync(process.execPath, [join(pkg, 'install.mjs'), '--home', home, ...extra], { encoding: 'utf8' });
const ver = (home) => readFileSync(join(home, '.ghostship/core/VERSION'), 'utf8').trim();
const ENTRIES = ['bridge.key', 'core', 'projects.json', 'secrets', 'shared-lessons.md'];

/** A copy of the package without the vendored Mermaid, so each install in a test is fast. */
function smallPkg() {
  const dir = mkdtempSync(join(tmpdir(), 'gs-pkg-'));
  cpSync(PKG, dir, { recursive: true, filter: (p) => !/[\\/](vendor|node_modules)([\\/]|$)/.test(p) });
  return dir;
}

test('install: five entries in ~/.ghostship plus the launcher; idempotent; upgrade keeps core/.prev', () => {
  const home = mkdtempSync(join(tmpdir(), 'gs-home-'));
  const pkg = smallPkg();
  try {
    assert.equal(run(home, pkg).status, 0);
    assert.deepEqual(readdirSync(join(home, '.ghostship')).sort(), ENTRIES);
    assert.ok(existsSync(join(home, '.claude/skills/ghostship/SKILL.md')));
    assert.ok(existsSync(join(home, '.claude/skills/ghostship-help/SKILL.md')), 'help skill installed next to the launcher');
    assert.ok(existsSync(join(home, '.claude/skills/ghostship-bridge/hooks/register.tsx')), 'Bridge mod installed where Claude Code loads it');
    assert.ok(!existsSync(join(home, '.claude/skills/ghostship-bridge/tests')));
    assert.deepEqual(readdirSync(home).sort(), ['.claude', '.ghostship']);
    if (process.platform !== 'win32') assert.equal(statSync(join(home, '.ghostship/secrets')).mode & 0o777, 0o600);
    if (process.platform !== 'win32') assert.equal(statSync(join(home, '.ghostship/bridge.key')).mode & 0o777, 0o600);
    assert.match(readFileSync(join(home, '.ghostship/bridge.key'), 'utf8'), /^[0-9a-f]{64}\n$/, 'a 256-bit owner key');
    assert.match(readFileSync(join(home, '.ghostship/core/.hash'), 'utf8'), /^[0-9a-f]{64}\n$/, 'the content hash of the installed core');
    writeFileSync(join(home, '.ghostship/secrets'), 'K=v\n');
    assert.match(run(home, pkg).stdout, /already installed \(unchanged/);
    assert.equal(readFileSync(join(home, '.ghostship/secrets'), 'utf8'), 'K=v\n', 'never overwrites secrets');
    assert.ok(!existsSync(join(home, '.ghostship/core/.prev')), 'an unchanged re-run keeps no rollback copy');
    // An older version installed: the re-run upgrades and keeps it in core/.prev.
    writeFileSync(join(home, '.ghostship/core/VERSION'), '0.0.1\n');
    const up = run(home, pkg).stdout;
    assert.match(up, /core 0\.0\.1 kept in ~\/\.ghostship\/core\/\.prev/);
    assert.equal(readFileSync(join(home, '.ghostship/core/.prev/VERSION'), 'utf8').trim(), '0.0.1');
    assert.notEqual(ver(home), '0.0.1');
    assert.deepEqual(readdirSync(join(home, '.ghostship')).sort(), ENTRIES, 'still five: no core.new or core.upgrading left behind');
    // Upgrading again replaces .prev rather than nesting it.
    writeFileSync(join(home, '.ghostship/core/VERSION'), '0.0.2\n');
    run(home, pkg);
    assert.equal(readFileSync(join(home, '.ghostship/core/.prev/VERSION'), 'utf8').trim(), '0.0.2');
    assert.ok(!existsSync(join(home, '.ghostship/core/.prev/.prev')), 'one rollback copy, never a chain');
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(pkg, { recursive: true, force: true }); }
});

test('install: the same version with changed content is reinstalled; --force always reinstalls', () => {
  const home = mkdtempSync(join(tmpdir(), 'gs-home-'));
  const pkg = smallPkg();
  try {
    run(home, pkg);
    const v = ver(home);
    // The package changes under the same version number (a rebuilt zip): the content hash differs.
    writeFileSync(join(pkg, 'core/procedures/build.md'), readFileSync(join(pkg, 'core/procedures/build.md'), 'utf8') + '\n<!-- rebuilt -->\n');
    const out = run(home, pkg).stdout;
    assert.match(out, /same version, changed content/);
    assert.match(readFileSync(join(home, '.ghostship/core/procedures/build.md'), 'utf8'), /rebuilt/);
    assert.equal(readFileSync(join(home, '.ghostship/core/.prev/VERSION'), 'utf8').trim(), v, 'the previous content is kept for rollback');
    assert.match(run(home, pkg).stdout, /already installed \(unchanged/);
    assert.match(run(home, pkg, '--force').stdout, /\(forced\)/);
    assert.deepEqual(readdirSync(join(home, '.ghostship')).sort(), ENTRIES);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(pkg, { recursive: true, force: true }); }
});

test('install: a crash mid-copy leaves the installed core untouched, and the next run completes', () => {
  const home = mkdtempSync(join(tmpdir(), 'gs-home-'));
  const pkg = smallPkg();
  try {
    run(home, pkg);
    const v = ver(home);
    const hash = readFileSync(join(home, '.ghostship/core/.hash'), 'utf8');
    // A run that died while copying: core.new holds a partial tree, the old core is still in place.
    mkdirSync(join(home, '.ghostship/core.new/runtime'), { recursive: true });
    writeFileSync(join(home, '.ghostship/core.new/VERSION'), '9.9.9\n');
    writeFileSync(join(home, '.ghostship/core.new/runtime/gs.mjs'), '// half a file');
    assert.equal(ver(home), v, 'the old core survived the crash');
    assert.ok(existsSync(join(home, '.ghostship/core/runtime/lib/engine.mjs')));
    // The next run clears the leftover and finishes the install.
    const out = run(home, pkg);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(!existsSync(join(home, '.ghostship/core.new')), 'the half copy is gone');
    assert.equal(ver(home), v);
    assert.equal(readFileSync(join(home, '.ghostship/core/.hash'), 'utf8'), hash);
    assert.ok(existsSync(join(home, '.ghostship/core/runtime/lib/engine.mjs')));
    // A copy that fails outright (an unreadable source file) leaves the old core as it was.
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const bad = smallPkg();
      writeFileSync(join(bad, 'core/VERSION'), '9.9.9\n');
      chmodSync(join(bad, 'core/runtime/lib/engine.mjs'), 0o000);
      const failed = run(home, bad);
      assert.notEqual(failed.status, 0, 'the broken package is refused');
      assert.equal(ver(home), v, 'the old core is untouched by a failed copy');
      assert.ok(existsSync(join(home, '.ghostship/core/runtime/lib/engine.mjs')));
      assert.ok(!existsSync(join(home, '.ghostship/core.upgrading')));
      assert.equal(run(home, pkg).status, 0, 'and a good package installs again');
      assert.ok(!existsSync(join(home, '.ghostship/core.new')));
      chmodSync(join(bad, 'core/runtime/lib/engine.mjs'), 0o644);
      rmSync(bad, { recursive: true, force: true });
    }
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(pkg, { recursive: true, force: true }); }
});

test('install: a core.upgrading left by the old installer with no core in place is restored', () => {
  const home = mkdtempSync(join(tmpdir(), 'gs-home-'));
  const pkg = smallPkg();
  try {
    run(home, pkg);
    // The 1.1 installer renamed core → core.upgrading and died before copying: no core, one set-aside copy.
    renameSync(join(home, '.ghostship/core'), join(home, '.ghostship/core.upgrading'));
    const out = run(home, pkg);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /restored the core an interrupted upgrade had set aside/);
    assert.ok(existsSync(join(home, '.ghostship/core/runtime/lib/engine.mjs')));
    assert.ok(!existsSync(join(home, '.ghostship/core.upgrading')));
    assert.deepEqual(readdirSync(join(home, '.ghostship')).sort(), ENTRIES);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(pkg, { recursive: true, force: true }); }
});
