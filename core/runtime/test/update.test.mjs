// gs update: ask GitHub for the published VERSION without cloning (check), and clone+install on apply.
// No network or real git here — the fetch, git and node runners are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as UPD from '../lib/update.mjs';

function fakeHome(version) {
  const home = mkdtempSync(join(tmpdir(), 'gs-uhome-'));
  if (version) { mkdirSync(join(home, '.ghostship/core'), { recursive: true }); writeFileSync(join(home, '.ghostship/core/VERSION'), version + '\n'); }
  return home;
}
const fetchOf = (body, { ok = true, status = 200 } = {}) => async () => ({ ok, status, text: async () => body });

test('update check: reports installed vs published and whether the published one is newer', async () => {
  const home = fakeHome('1.6.0');
  try {
    let c = await UPD.check({ home, repo: 'o/r', fetchImpl: fetchOf('1.6.1\n') });
    assert.deepEqual([c.installed, c.remote, c.newer], ['1.6.0', '1.6.1', true]);
    c = await UPD.check({ home, repo: 'o/r', fetchImpl: fetchOf('1.6.0\n') });
    assert.equal(c.newer, false, 'same version is not newer');
    c = await UPD.check({ home, repo: 'o/r', fetchImpl: fetchOf('1.5.9') });
    assert.equal(c.newer, false, 'an older published version is not newer');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('update check: surfaces a bad response, an unreachable host and junk, without throwing', async () => {
  const home = fakeHome('1.6.0');
  try {
    let c = await UPD.check({ home, repo: 'o/r', fetchImpl: fetchOf('', { ok: false, status: 404 }) });
    assert.match(c.error, /404/); assert.equal(c.remote, undefined);
    c = await UPD.check({ home, repo: 'o/r', fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
    assert.match(c.error, /could not reach GitHub/);
    c = await UPD.check({ home, repo: 'o/r', fetchImpl: fetchOf('<html>not a version</html>') });
    assert.match(c.error, /unexpected VERSION/);
    c = await UPD.check({ home, repo: '/a/local/path', fetchImpl: fetchOf('1.0.0') });
    assert.match(c.error, /owner\/name repo/, 'check needs a GitHub slug, not a local path');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('update apply: clones the repo and runs its install.mjs, reporting from → to', () => {
  const home = fakeHome('1.6.0');
  try {
    const runGit = (args) => { const dest = args[args.length - 1]; writeFileSync(join(dest, 'install.mjs'), '// installer\n'); return { status: 0, stdout: '', stderr: '' }; };
    // the "installer" bumps the home's installed VERSION, like the real install.mjs swapping the core
    const runNode = (args) => { assert.ok(args[0].endsWith('install.mjs')); assert.ok(args.includes('--home') && args.includes(home)); writeFileSync(join(home, '.ghostship/core/VERSION'), '1.6.1\n'); return { status: 0, stdout: 'core 1.6.1 → ~/.ghostship/core\n', stderr: '' }; };
    const r = UPD.apply({ home, repo: 'o/r', runGit, runNode });
    assert.deepEqual([r.ok, r.from, r.to], [true, '1.6.0', '1.6.1']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('update apply: a clone failure and a repo with no install.mjs both fail cleanly', () => {
  const home = fakeHome('1.6.0');
  try {
    let r = UPD.apply({ home, repo: 'o/r', runGit: () => ({ status: 128, stdout: '', stderr: 'fatal: repository not found' }) });
    assert.equal(r.ok, false); assert.match(r.reason, /git clone failed/);
    r = UPD.apply({ home, repo: 'o/r', runGit: () => ({ status: 0, stdout: '', stderr: '' }) }); // "cloned" but left no install.mjs
    assert.equal(r.ok, false); assert.match(r.reason, /no install\.mjs/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
