// Bridge backend: tick (heartbeat, logbook, spend, alerts), handoff, helm pause/go, status line and keeper fallbacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectAtBuild, GS, CORE } from './project.mjs';
import * as B from '../lib/bridge.mjs';
import * as E from '../lib/engine.mjs';
import { loadConfig, saveConfig } from '../lib/config.mjs';

const HOOK = (n) => join(CORE, 'runtime', 'hooks', n);
const run = (file, dir, input) => spawnSync(process.execPath, [file], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });

test('tick: heartbeat, logbook, per-session spend, derived alerts with a cursor', () => {
  const dir = projectAtBuild({ configure: (c) => { c.autonomy = { ...c.autonomy, mode: 'guided' }; } });
  try {
    const usage = { context: { tokens: 42000, window: 200000, percent: 21 }, cost: { usd: 1.25 }, rateLimits: [] };
    let t = B.tick(dir, { usage, turn: { seconds: 30, tools: 4 }, sessionId: 's1' });
    assert.equal(t.active, true);
    assert.equal(t.status.stage, 'build');
    assert.deepEqual(t.limits, { soft: 150000, hard: 200000 });
    assert.equal(JSON.parse(readFileSync(join(dir, '.ghostship/runs/heartbeat.json'), 'utf8')).tokens, 42000);
    assert.match(readFileSync(join(dir, '.ghostship/usage/logbook.jsonl'), 'utf8'), /"tools":4/);
    B.tick(dir, { usage: { ...usage, cost: { usd: 2.5 } }, sessionId: 's1' });
    B.tick(dir, { usage: { ...usage, cost: { usd: 1 } }, sessionId: 's2' });
    assert.equal(B.spend(dir).claudeUsd, 3.5, 'latest cost per session, summed over sessions');
    for (let i = 1; i <= 3; i++) { E.taskStart(dir, 'T001'); E.taskFail(dir, 'T001', `x${i}`); }
    t = B.tick(dir, { since: t.cursor });
    assert.deepEqual(t.alerts.map((a) => a.alert), ['T001 needs your decision']);
    t = B.tick(dir, { since: t.cursor });
    assert.deepEqual(t.alerts, [], 'an alert is raised once');
    assert.match(B.band(t), /⚑ decide T001/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('handoff note and helm: pause stops new work, go needs the owner', () => {
  const dir = projectAtBuild();
  const gs = (...a) => spawnSync(process.execPath, [GS, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
  try {
    E.taskStart(dir, 'T001');
    const h = gs('bridge', 'handoff', '--note', 'Writing the add test');
    assert.match(h.stdout, /Wrote \.ghostship\/handoff\/HANDOFF\.md/);
    const md = readFileSync(join(dir, '.ghostship/handoff/HANDOFF.md'), 'utf8');
    assert.match(md, /\| active task \| T001 Add two numbers — BUILDING, attempt 1\/3/);
    assert.match(md, /Writing the add test/);
    E.taskFail(dir, 'T001', 'later');
    assert.match(gs('pause', '--reason', 'lunch').stdout, /Paused: lunch/);
    assert.equal(gs('task', 'start', 'T001').stderr.match(/✗ (\w+)/)[1], 'PAUSED');
    assert.match(gs('status').stdout, /next: Resume work \(gs go\) — paused: lunch/);
    assert.match(gs('go').stderr, /HUMAN_GATE/, 'an agent cannot unpause itself');
    assert.ok(existsSync(join(dir, '.ghostship/runs/pause.json')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status line script prints the claude-deck chips line and writes the heartbeat; Stop hook asks once for a handoff past the hard limit', () => {
  const dir = projectAtBuild();
  try {
    const out = run(HOOK('statusline.mjs'), dir, { session_id: 'abc', workspace: { project_dir: dir }, cost: { total_cost_usd: 0.7 }, context_window: { total_input_tokens: 205000, context_window_size: 1000000, used_percentage: 20.5 } });
    const plain = out.stdout.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
    assert.equal(plain.split('\n').length, 1, "one line of claude-deck's chips");
    assert.match(plain, /^⛴ math ▸ {2}/, 'the project first');
    assert.match(plain, /\$ \$0\.70 session · \$0\.70 project │ ● Build 0\/2 ▱▱▱▱▱$/, 'spend and the plan as chips with mini bars; context is in the band, not here');
    assert.doesNotMatch(plain, /ctx /, 'context is shown in the band above the prompt, not duplicated in the status line');
    assert.match(out.stdout, /\x1b\[38;2;93;202;165m/, "24-bit colour from claude-deck's palette");
    assert.match(out.stdout, /\x1b\[/, 'coloured unless NO_COLOR');
    const hb = JSON.parse(readFileSync(join(dir, '.ghostship/runs/heartbeat.json'), 'utf8'));
    assert.equal(hb.source, 'statusline');
    const s1 = JSON.parse(run(HOOK('stop.mjs'), dir, {}).stdout);
    assert.equal(s1.decision, 'block');
    assert.match(s1.reason, /bridge handoff/);
    // Autopilot would push on to T001 here; this test is about the keeper, so the project waits between tasks (guided).
    const c = loadConfig(dir); c.autonomy = { ...(c.autonomy || {}), mode: 'guided' }; saveConfig(dir, c);
    assert.equal(run(HOOK('stop.mjs'), dir, {}).stdout, '', 'asked once per session');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gs watch --once prints the band; bridge tick is inert outside Ghostship', () => {
  const dir = projectAtBuild();
  try {
    const w = spawnSync(process.execPath, [GS, 'watch', '--once'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    assert.match(w.stdout, /⛴ math · build/);
    assert.deepEqual(B.tick('/nonexistent-dir-xyz', {}), { active: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("deckline: claude-deck's chips order (what needs you, limits with reset, spend, plan — context lives in the band) and NO_COLOR", async () => {
  const { deckLine } = await import('../lib/deckline.mjs');
  const now = Date.parse('2026-10-06T10:00:00Z');
  const snap = { active: true, project: 'test', paused: null, run: null,
    status: { stage: 'build', active: { id: 'T004', status: 'BUILDING', attempt: 1, max: 3 }, needsDecision: [] },
    asks: [{ id: 'G-stop1', title: 'STOP 1: approve the acceptance checks?' }],
    claude: { fiveHour: { percent: 91, resetsAt: '2026-10-06T10:42:00Z' }, sevenDay: { percent: 38, resetsAt: '2026-10-09T15:00:00Z' } },
    tasks: [{ id: 'T001', status: 'MERGED' }, { id: 'T002', status: 'MERGED' }, { id: 'T003', status: 'MERGED' }, { id: 'T004', status: 'BUILDING' }],
    spend: { usd: 41.2, sessions: 7 } };
  const plain = deckLine(snap, { context: { percent: 29 }, cost: { usd: 2.11 } }, { color: false, now });
  assert.equal(plain, '⛴ test ▸  ? 1 for you: STOP 1: approve the accepta… │ ! 5h 91% ↻42m ▰▰▰▰▰ │ ◔ 7d 38% ↻3d 5h ▰▰▱▱▱ │ $ $2.11 session · $41.20 project │ ● Build 3/4 ▰▰▰▰▱  T004 building 1/3');
  assert.doesNotMatch(plain, /\x1b/);
  assert.match(deckLine(snap, {}, { color: true, now }), /\x1b\[1m\x1b\[38;2;226;112;111m|\x1b\[38;2;226;112;111m/, 'the hot limit in deck red');
});

test('deckline: a reset time shows a real countdown whether ISO, epoch seconds or ms; junk or missing shows no ↻ (never NaN)', async () => {
  const { deckLine } = await import('../lib/deckline.mjs');
  const now = Date.parse('2026-10-06T10:00:00Z');
  const base = { active: true, project: 'test', status: { stage: 'build', active: { id: 'T001', status: 'BUILDING', attempt: 1, max: 3 } }, asks: [], tasks: [] };
  const line = (claude) => deckLine({ ...base, claude }, { context: { percent: 4 }, cost: { usd: 0 } }, { color: false, now });
  // The bug: a resetsAt that Date.parse can't read (an epoch number) printed "↻NaNm".
  const epochSec = line({ fiveHour: { percent: 1, resetsAt: Math.floor(now / 1000) + 3600 }, sevenDay: { percent: 46, resetsAt: Math.floor(now / 1000) + 2 * 86400 } });
  assert.doesNotMatch(epochSec, /NaN/);
  assert.match(epochSec, /5h 1% ↻1h0m/);
  assert.match(epochSec, /7d 46% ↻2d 0h/);
  const iso = line({ fiveHour: { percent: 1, resetsAt: new Date(now + 3600000).toISOString() }, sevenDay: {} });
  assert.match(iso, /5h 1% ↻1h0m/);
  // Junk or missing reset time: no ↻ at all, and never NaN.
  for (const bad of ['not-a-date', '', null, undefined]) {
    const l = line({ fiveHour: { percent: 1, resetsAt: bad }, sevenDay: { percent: 46, resetsAt: bad } });
    assert.doesNotMatch(l, /NaN/, `resetsAt=${JSON.stringify(bad)}`);
    assert.doesNotMatch(l, /↻/, `resetsAt=${JSON.stringify(bad)} should show no ↻`);
    assert.match(l, /5h 1%/);
  }
});
