import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, write } from './helpers.mjs';
import { treeHash, changedPaths, headCommit } from '../lib/git.mjs';

test('treeHash covers untracked files and changes when content changes', () => {
  const r = makeRepo();
  try {
    const t0 = treeHash(r.dir);
    write(r.dir, 'src/a.js', 'x');
    const t1 = treeHash(r.dir);
    assert.notEqual(t0, t1);
    assert.equal(treeHash(r.dir), t1, 'deterministic');
    write(r.dir, 'src/a.js', 'y');
    assert.notEqual(treeHash(r.dir), t1);
  } finally { r.cleanup(); }
});

test('treeHash ignores Ghostship state, evidence and task files but not the contract', () => {
  const r = makeRepo();
  try {
    const t0 = treeHash(r.dir);
    write(r.dir, '.ghostship/state/state.json', '{}');
    write(r.dir, '.ghostship/evidence/T1/E1/output.log', 'x'); write(r.dir, 'tasks/T001-x.md', 'x');
    assert.equal(treeHash(r.dir), t0);
    write(r.dir, 'docs/03-acceptance/ACCEPTANCE-CHECKS.md', 'x');
    assert.notEqual(treeHash(r.dir), t0);
  } finally { r.cleanup(); }
});

test('treeHash does not touch the real index', () => {
  const r = makeRepo();
  try {
    write(r.dir, 'new.txt', 'x');
    treeHash(r.dir);
    assert.match(r.git('status', '--porcelain'), /\?\? new\.txt/);
  } finally { r.cleanup(); }
});

test('changedPaths lists added, modified and deleted paths between trees', () => {
  const r = makeRepo();
  try {
    write(r.dir, 'keep.txt', '1');
    write(r.dir, 'gone.txt', '1');
    const a = treeHash(r.dir);
    write(r.dir, 'keep.txt', '2');
    write(r.dir, 'added/x.js', '1');
    require_unlink(r.dir + '/gone.txt');
    const b = treeHash(r.dir);
    assert.deepEqual(changedPaths(r.dir, a, b).sort(), ['added/x.js', 'gone.txt', 'keep.txt']);
  } finally { r.cleanup(); }
});

test('headCommit returns a sha in a repo', () => {
  const r = makeRepo();
  try { assert.match(headCommit(r.dir), /^[0-9a-f]{40}$/); } finally { r.cleanup(); }
});

import { unlinkSync } from 'node:fs';
function require_unlink(p) { unlinkSync(p); }

test('treeHash ignores build output and tool caches even without a .gitignore, at any depth, tracked or not', () => {
  const r = makeRepo();
  try {
    write(r.dir, 'src/a.js', 'x');
    write(r.dir, 'out/old.txt', 'tracked by mistake');
    r.git('add', '-A'); r.git('commit', '-qm', 'src');
    const t0 = treeHash(r.dir);
    write(r.dir, 'dist/x.js', 'built');
    write(r.dir, 'a.tsbuildinfo', '{}');
    write(r.dir, 'packages/web/node_modules/.vite/results.json', '{}');
    write(r.dir, 'test-results/run/trace.zip', 'z');
    write(r.dir, 'pkg/__pycache__/m.cpython-312.pyc', 'b');
    write(r.dir, 'out/old.txt', 'rewritten by a build');
    assert.equal(treeHash(r.dir), t0, 'tool output is not a change to the tree');
    write(r.dir, 'src/a.js', 'y');
    const t1 = treeHash(r.dir);
    assert.notEqual(t1, t0, 'source still counts');
    assert.deepEqual(changedPaths(r.dir, t0, t1), ['src/a.js']);
    write(r.dir, 'src/distance.js', 'not a dist folder');
    assert.notEqual(treeHash(r.dir), t1, 'names that only start like an output dir still count');
  } finally { r.cleanup(); }
});
