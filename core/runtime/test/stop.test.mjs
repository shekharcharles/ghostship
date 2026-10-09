// Stop hook and agent heartbeats: waiting on a background builder is not a stall; a quiet one still is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectAtBuild, CORE, git } from './project.mjs';
import * as E from '../lib/engine.mjs';
import { load } from '../lib/store.mjs';
import { loadConfig, saveConfig } from '../lib/config.mjs';

const HOOK = (n) => join(CORE, 'runtime', 'hooks', n);
const run = (file, dir, input) => spawnSync(process.execPath, [file], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
const beats = (dir) => JSON.parse(readFileSync(join(dir, '.ghostship/runs/agents.json'), 'utf8'));
const stop = (dir) => { const out = run(HOOK('stop.mjs'), dir, {}).stdout; return out ? JSON.parse(out) : null; };

test('guard records a heartbeat for builder, judge and planner calls, and nothing for the main session', () => {
  const dir = projectAtBuild();
  try {
    E.taskStart(dir, 'T001');
    const r = run(HOOK('guard.mjs'), dir, { tool_name: 'Read', tool_input: { file_path: `${dir}/src/add.mjs` }, agent_type: 'ghostship-builder', agent_id: 'b1', cwd: dir });
    assert.equal(r.status, 0);
    assert.equal(beats(dir)['ghostship-builder'].agentId, 'b1');
    assert.ok(Date.now() - beats(dir)['ghostship-builder'].at < 5000);
    run(HOOK('guard.mjs'), dir, { tool_name: 'Read', tool_input: { file_path: `${dir}/x` }, cwd: dir });
    assert.deepEqual(Object.keys(beats(dir)), ['ghostship-builder'], 'the main session leaves no heartbeat');
    const denied = run(HOOK('guard.mjs'), dir, { tool_name: 'Write', tool_input: { file_path: `${dir}/.ghostship/state/state.json` }, agent_type: 'ghostship-judge', cwd: dir });
    assert.equal(denied.status, 2, 'the heartbeat never changes the verdict');
    assert.ok(beats(dir)['ghostship-judge']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stop: with a builder working in the background, stops never block or escalate', () => {
  const dir = projectAtBuild();
  try {
    E.taskStart(dir, 'T001');
    run(HOOK('guard.mjs'), dir, { tool_name: 'Read', tool_input: { file_path: `${dir}/src/add.mjs` }, agent_type: 'ghostship-builder', cwd: dir });
    for (let i = 0; i < 5; i++) assert.equal(stop(dir), null, `stop ${i + 1} goes through`);
    assert.equal(load(dir).tasks.T001.status, 'BUILDING', 'no false stall');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stop: with the builder quiet for 10 minutes, the old rule holds: block, then escalate past the limit (guided)', () => {
  const dir = projectAtBuild();
  try {
    const c = loadConfig(dir); c.autonomy = { ...(c.autonomy || {}), mode: 'guided' }; saveConfig(dir, c);
    git(dir, 'commit', '-qam', 'guided');
    E.taskStart(dir, 'T001');
    mkdirSync(join(dir, '.ghostship/runs'), { recursive: true });
    writeFileSync(join(dir, '.ghostship/runs/agents.json'), JSON.stringify({ 'ghostship-builder': { at: Date.now() - 10 * 60000, agentId: null } }));
    for (let i = 1; i <= 3; i++) {
      const s = stop(dir);
      assert.equal(s.decision, 'block');
      assert.match(s.reason, new RegExp(`No builder or judge has worked on it for 5 minutes.*${i}/3`));
    }
    const last = stop(dir);
    assert.match(last.systemMessage, /stalled and now needs your decision/);
    assert.equal(load(dir).tasks.T001.status, 'NEEDS_DECISION');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
