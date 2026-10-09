// Owner queue: agent asks, derived Ghostship asks, answers, secret refusal, delivery, and who may answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig } from '../lib/config.mjs';
import { spawnSync } from 'node:child_process';
import { projectAtBuild, GS } from './project.mjs';
import * as A from '../lib/asks.mjs';
import * as B from '../lib/bridge.mjs';
import * as E from '../lib/engine.mjs';
import { evaluate, BUILDER } from '../lib/guard-rules.mjs';

test('asks: add, dedupe, cap, answer by kind, refuse secrets, deliver once', () => {
  const dir = projectAtBuild();
  try {
    const key = A.add(dir, { kind: 'do', title: 'Add STRIPE_KEY to ~/.ghostship/secrets', doneWhen: 'gs config check passes' });
    assert.equal(A.add(dir, { kind: 'do', title: 'add stripe_key to ~/.ghostship/secrets' }).duplicate, true);
    const pick = A.add(dir, { kind: 'choose', title: 'Which region?', options: ['EU', 'US'] });
    const word = A.add(dir, { kind: 'answer', title: 'Company legal name?' });
    assert.throws(() => A.add(dir, { kind: 'choose', title: 'x', options: ['one'] }), /BAD_OPTIONS|2 to 4/);
    A.add(dir, { title: 'a4' }); A.add(dir, { title: 'a5' });
    assert.throws(() => A.add(dir, { title: 'a6' }), /already waiting/);
    assert.throws(() => A.answer(dir, key.id, {}), /done/);
    assert.equal(A.answer(dir, key.id, { done: true }).response, 'Done.');
    assert.equal(A.answer(dir, pick.id, { option: 2 }).response, 'I chose "US".');
    assert.throws(() => A.answer(dir, word.id, { text: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' }), /looks like a secret/);
    A.answer(dir, word.id, { text: 'Acme Ltd' });
    const msg = A.deliver(dir);
    assert.match(msg, /#1 \(asked by an agent\) Add STRIPE_KEY.*: Done\./);
    assert.match(msg, /I chose "US"/);
    assert.match(msg, /never an approval/);
    assert.equal(A.deliver(dir), null, 'delivered once');
    assert.equal(A.list(dir).filter((a) => a.source === 'agent').length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('derived asks: a task decision and a pause appear, and clear once answered', () => {
  const dir = projectAtBuild({ configure: (c) => { c.autonomy = { ...c.autonomy, mode: 'guided' }; } });
  try {
    for (let i = 1; i <= 3; i++) { E.taskStart(dir, 'T001'); E.taskFail(dir, 'T001', `x${i}`); }
    B.pause(dir, 'lunch');
    const ids = A.list(dir).map((a) => a.id);
    assert.ok(ids.includes('G-T001') && ids.includes('G-paused'));
    A.answer(dir, 'G-paused', { option: 1 });
    assert.ok(!A.list(dir).some((a) => a.id === 'G-paused'), 'answered derived ask leaves the queue');
    assert.ok(B.paused(dir), 'an answer never resumes by itself; Claude or the owner runs gs go');
    assert.match(A.deliver(dir), /#G-paused Ghostship is paused\. Resume\?: I chose "Resume"\.[\s\S]*use these words as my quote/);
    const t = B.tick(dir, {});
    assert.ok(t.asks.some((a) => a.id === 'G-T001'));
    assert.match(B.band(t), /☐ 1 for you/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only the owner answers: the guard refuses ask answer / asks deliver for every agent', () => {
  const S = { stage: 'build', prd: { approved: true }, acceptance: { approved: true }, acceptanceLock: { files: {} }, tasks: {} };
  const B_ = (command, agent_type = '') => ({ tool_name: 'Bash', tool_input: { command }, agent_type });
  for (const who of ['', BUILDER]) {
    assert.equal(evaluate(S, '/r', B_('node .ghostship/core/runtime/gs.mjs ask answer 1 --done', who)).deny, true);
    assert.equal(evaluate(S, '/r', B_('gs asks deliver', who)).deny, true);
  }
  assert.notEqual(evaluate(S, '/r', B_('node .ghostship/core/runtime/gs.mjs ask --title "Add KEY" --kind do')).deny, true, 'the orchestrator may file an ask');
  assert.equal(evaluate(S, '/r', B_('node .ghostship/core/runtime/gs.mjs ask --title x', BUILDER)).deny, true, 'subagents report to the orchestrator instead');
});

test('limits: normalised from the mod and the status line, with reset and the CLI view', () => {
  assert.deepEqual(B.normLimits([{ kind: 'five_hour', percentUsed: 62.34, resetsAt: '2026-10-06T15:00:00Z' }, { kind: 'seven_day', percentUsed: 30 }]),
    { fiveHour: { percent: 62.3, resetsAt: '2026-10-06T15:00:00Z' }, sevenDay: { percent: 30, resetsAt: null } });
  assert.deepEqual(B.normLimits([{ window: '5h', percent: 10 }]), { fiveHour: { percent: 10, resetsAt: null } });
  const dir = projectAtBuild();
  try {
    const resetsAt = new Date(Date.now() + 95 * 60000).toISOString();
    const t = B.tick(dir, { usage: { context: { tokens: 1 }, cost: { usd: 0 }, rateLimits: [{ kind: 'five_hour', percentUsed: 87, resetsAt }, { kind: 'seven_day', percentUsed: 41 }] } });
    assert.equal(t.claude.fiveHour.percent, 87);
    assert.match(B.band(t), /5h 87% ↻1h3[45]m · 7d 41%/);
    const r = spawnSync(process.execPath, [GS, 'limits'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /5h 87% · resets in 1h3[45]m/);
    assert.match(r.stdout, /spares Claude for grunt, standard work above 85%/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bridge approvals: a press carrying the owner key approves only in approvals.mode bridge; agents cannot reach the key', () => {
  const dir = projectAtBuild();
  const home = mkdtempSync(join(tmpdir(), 'gs-key-'));
  const env = { ...process.env, GHOSTSHIP_HOME: home };
  const gs = (args, input) => spawnSync(process.execPath, [GS, ...args], { cwd: dir, env, input, encoding: 'utf8' });
  try {
    mkdirSync(join(home, '.ghostship'));
    const key = 'a'.repeat(64);
    writeFileSync(join(home, '.ghostship', 'bridge.key'), key + '\n', { mode: 0o600 });
    B.pause(dir, 'lunch');
    assert.equal(B.tick(dir, {}).approvals, 'chat', 'chat is the default for new projects');
    const strict = loadConfig(dir); strict.approvals.mode = 'terminal'; saveConfig(dir, strict);
    const t = B.tick(dir, {});
    assert.equal(t.asks.find((a) => a.id === 'G-paused').gate, 'go', 'the pane knows which command a derived ask runs');
    assert.ok(Array.isArray(t.tasks) && t.tasks.some((x) => x.id === 'T001'), 'the task board rides on the tick');
    assert.equal(t.approvals, 'terminal');

    let r = gs(['go', '--owner-key-stdin'], key);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /Approving from the Bridge is off/, 'terminal mode ignores the key');

    const cfg = loadConfig(dir); cfg.approvals.mode = 'bridge'; saveConfig(dir, cfg);
    r = gs(['go', '--owner-key-stdin'], 'b'.repeat(64));
    assert.notEqual(r.status, 0, 'a wrong key is refused');
    assert.ok(B.paused(dir));
    r = gs(['go'], '');
    assert.notEqual(r.status, 0, 'no key, no tty: refused');
    assert.match(r.stderr + r.stdout, /Bridge pane/);
    r = gs(['go', '--owner-key-stdin'], key);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(B.paused(dir), null, 'the owner resumed from the Bridge');

    r = gs(['ask', 'answer', 'G-paused', '--option', '1', '--applied']);
    assert.notEqual(r.status, 0, 'the derived ask is gone once the state moved on');
    const pick = A.add(dir, { kind: 'choose', title: 'Region?', options: ['EU', 'US'] });
    assert.match(A.answer(dir, pick.id, { option: 1, applied: true }).response, /already did it from the Bridge/);

    for (const cmd of ['cat ~/.ghostship/bridge.key', 'node .ghostship/core/runtime/gs.mjs go --owner-key-stdin < k', 'gs go --owner-key-stdin']) {
      assert.equal(evaluate({ tasks: {} }, dir, { tool_name: 'Bash', tool_input: { command: cmd } }).deny, true, cmd);
    }
    assert.equal(evaluate({ tasks: {} }, dir, { tool_name: 'Read', tool_input: { file_path: `${home}/.ghostship/bridge.key` } }).deny, true);
    assert.equal(evaluate({ tasks: {} }, dir, { tool_name: 'Grep', tool_input: { pattern: 'KEY', path: `${dir}/.env` } }).deny, true, 'a search into .env reads it');
    assert.equal(evaluate({ tasks: {} }, dir, { tool_name: 'Grep', tool_input: { pattern: 'KEY', glob: '.env*' } }).deny, true);
    assert.equal(evaluate({ tasks: {} }, dir, { tool_name: 'Grep', tool_input: { pattern: '\\.env', path: `${dir}/src` } }).deny, false, 'searching code for the word .env is fine');
    assert.equal(evaluate({ tasks: {} }, dir, { tool_name: 'Read', tool_input: { file_path: `${dir}/.env.example` } }).deny, false);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});
