// The golden path: a real to-do CLI, from gs init to a tagged release, doing only what `next()` says. Scripted agents
// stand in for the builder, judge and planner; the owner answers only at the gates. Any question outside those gates,
// a parked task, a spin, or a step the driver cannot act on fails the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { freshProject, drive } from '../golden/drive.mjs';
import { load } from '../lib/store.mjs';
import { scorecard } from '../lib/scorecard.mjs';
import * as E from '../lib/engine.mjs';

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const ownerIds = (trail) => [...new Set(trail.filter((s) => s.kind === 'owner').map((s) => s.id))].sort();

function assertShipped(dir, trail) {
  const tasks = Object.values(load(dir).tasks);
  assert.equal(tasks.length, 4, 'the plan has four tasks');
  assert.ok(tasks.every((t) => t.status === 'MERGED'), `every task merged: ${tasks.map((t) => `${t.id}=${t.status}`).join(', ')}`);
  assert.equal(tasks.filter((t) => t.status === 'PARKED').length, 0, 'nothing parked');
  assert.equal(git(dir, 'tag', '--list', 'v*'), 'v0.1.0', 'the release is tagged');
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'develop');
  assert.equal(trail.at(-1).kind, 'done');
  assert.ok(trail.some((s) => s.id === 'task.start' && s.task === 'T001') && trail.findIndex((s) => s.id === 'acceptance.lock') > trail.findIndex((s) => s.id === 'merge' && s.task === 'T001'), 'the setup task runs before the acceptance tests are locked');
  assert.equal(E.audit(dir).ok, true, 'the evidence chain verifies');
  // the product really works
  const todo = (...a) => execFileSync(process.execPath, ['bin/todo.mjs', ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, TODO_FILE: join(dir, '.todo.json') } });
  todo('add', 'milk'); todo('done', '1');
  assert.equal(todo('list'), '1. [x] milk\n');
}

test('golden path (autopilot): the owner is asked only at the PRD, STOP 1 and STOP 2', { timeout: 60000 }, () => {
  const dir = freshProject({ mode: 'autopilot' });
  try {
    const t0 = Date.now();
    const trail = drive(dir);
    assert.ok(Date.now() - t0 < 60000, 'the whole run takes under a minute');
    assert.deepEqual(ownerIds(trail), ['acceptance.approve', 'interview', 'prd.approve', 'release.approve']);
    assertShipped(dir, trail);
    const sc = scorecard(dir);
    assert.equal(sc.questionsAfterPrd, 0, 'no question after the PRD');
    assert.deepEqual(sc.tasks, { total: 4, merged: 4, parked: 0, dropped: 0 });
    assert.equal(sc.ownerGates.prd, 1); assert.equal(sc.ownerGates.acceptance, 1); assert.equal(sc.ownerGates.release, 1); assert.equal(sc.ownerGates.decide, 0);
    assert.match(readFileSync(join(dir, 'docs/10-releases/v0.1.0.md'), 'utf8'), /## Checks[\s\S]*\| C5 \| .* \| run \| T004 \| PASS/);
    // every step came from next(), and the trail is the whole lifecycle in order
    const ids = trail.map((s) => s.id);
    const order = ['interview.init', 'interview', 'prd.write', 'prd.approve', 'design.write', 'design.done', 'acceptance.write', 'acceptance.approve', 'plan.write', 'task.import', 'task.start', 'builder', 'submit', 'judge', 'merge', 'acceptance.tests', 'acceptance.lock', 'release.candidate', 'release.approve', 'done'];
    let at = -1;
    for (const id of order) { const i = ids.indexOf(id, at + 1); assert.ok(i > at, `${id} comes after ${order[order.indexOf(id) - 1] || 'the start'}`); at = i; }
    assert.equal(ids.filter((x) => x === 'merge').length, 4);
    assert.ok(!ids.includes('decide') && !ids.includes('paused') && !ids.includes('blocked'), 'no decision, pause or dead end');
    assert.ok(existsSync(join(dir, 'docs-site/index.html')), 'the docs site shipped with the release');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('golden path (full): STOP 1 passes by policy, so the owner is asked only at the PRD and STOP 2', { timeout: 60000 }, () => {
  const dir = freshProject({ mode: 'full' });
  try {
    const trail = drive(dir);
    assert.deepEqual(ownerIds(trail), ['interview', 'prd.approve', 'release.approve']);
    assert.ok(trail.some((s) => s.id === 'acceptance.approve' && s.kind === 'do'), 'STOP 1 was a policy step');
    assertShipped(dir, trail);
    assert.equal(scorecard(dir).ownerGates.acceptance, 0, 'STOP 1 was not an owner gate');
    assert.equal(scorecard(dir).questionsAfterPrd, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
