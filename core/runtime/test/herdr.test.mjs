// A Claude agent started in a herdr tab must be able to work with no human in the tab, without a permission bypass,
// and the herdr argv must match the herdr CLI contract. Plus: judge work routes to a stronger agent than the builder.
import { test } from 'node:test';
import { load } from '../lib/store.mjs';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { safeTabClaudeArgs, plan } from '../lib/dispatch.mjs';
import { createHerdr, agentName } from '../lib/herdr.mjs';
import { BYPASS, allowedTools } from '../lib/harness.mjs';
import { tierFor, pickAgent } from '../lib/routing.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { projectAtBuild } from './project.mjs';
import * as E from '../lib/engine.mjs';

test('a Claude builder in a herdr tab gets the non-interactive posture (acceptEdits + scoped tools), no bypass, bare --remote-control', () => {
  const args = safeTabClaudeArgs({ model: 'sonnet', name: 'gs-t001-builder-a1', remoteControl: true, role: 'builder' });
  const s = args.join(' ');
  assert.ok(args.includes('--permission-mode') && args[args.indexOf('--permission-mode') + 1] === 'acceptEdits', 'acceptEdits so edits are not blocked');
  assert.ok(s.includes('--allowedTools'), 'scoped allow-list so the builder can edit and run gs without a prompt');
  for (const t of allowedTools('builder')) assert.ok(args.includes(t), `allow-list carries ${t}`);
  assert.ok(!args.some((a) => BYPASS.test(a)), 'never a permission bypass');
  // --remote-control is a bare flag; the name belongs to -n and to `herdr agent start`, never a positional prompt.
  assert.equal(args[args.indexOf('--remote-control') + 1] ?? '--allowedTools', '--allowedTools');
  assert.equal(args[args.indexOf('-n') + 1], 'gs-t001-builder-a1');
  // Without remote control, the flag is absent (not left dangling with the name).
  assert.ok(!safeTabClaudeArgs({ model: 'sonnet', name: 'n', remoteControl: false, role: 'judge' }).includes('--remote-control'));
});

test('dispatch.plan routes a Claude builder into a tab, named for its task, with the owner\'s launch posture', () => {
  const dir = projectAtBuild({ configure: (c) => { c.dispatch = { claude: 'tab', mode: 'tab', 'timeout-min': 45 }; } });
  try {
    E.taskStart(dir, 'T001');
    const which = (b) => (b === 'claude' || b === 'herdr' ? `/usr/bin/${b}` : null);
    const p = plan(dir, { task: 'T001', role: 'builder', which, env: { HERDR_ENV: '1' } });
    assert.equal(p.mode, 'tab');
    assert.equal(p.herdrKind, 'claude');
    // Default here: launch.skipPermissions is on, so the tab agent never waits on a prompt (the guard hooks still apply).
    assert.ok(p.args.includes('--dangerously-skip-permissions'), p.args.join(' '));
    assert.ok(p.args.includes('--remote-control'));
    assert.ok(!p.args.includes('acceptEdits'));
    const title = load(dir).tasks.T001.title;
    assert.equal(p.name, agentName('T001', 'builder', 1, title));
    assert.match(p.name, /^gs-t001-build-/);
    assert.equal(p.label, `⛴ T001 build · ${title}`);
    assert.equal(p.args[p.args.indexOf('-n') + 1], p.label, 'the Claude session carries the same human name');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the herdr adapter builds argv to the herdr CLI contract (tab create → agent start -- args)', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'tab' && args[1] === 'create') return { status: 0, stdout: JSON.stringify({ result: { tab: { tab_id: 'w1:t2' }, root_pane: { pane_id: 'w1:p3' } } }) };
    if (args[0] === 'agent' && args[1] === 'start') return { status: 0, stdout: JSON.stringify({ result: { agent: { name: args[2], status: 'idle' } } }) };
    return { status: 0, stdout: '{}' };
  };
  const h = createHerdr({ run, env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1' } });
  const tab = h.openTab({ workspace: 'w1', cwd: '/repo', label: 'T001 builder a1', env: { GHOSTSHIP_ROLE: 'builder' } });
  assert.deepEqual(tab, { tabId: 'w1:t2', paneId: 'w1:p3' });
  const agent = h.startAgent({ name: 'gs-t001-builder-a1', kind: 'claude', paneId: 'w1:p3', args: ['--model', 'sonnet', '--permission-mode', 'acceptEdits'] });
  assert.equal(agent.status, 'idle');
  const start = calls.find((a) => a[0] === 'agent' && a[1] === 'start');
  // herdr agent start <name> --kind <kind> --pane <pane> [--timeout n] -- <agent args...>
  assert.equal(start[2], 'gs-t001-builder-a1');
  assert.equal(start[start.indexOf('--kind') + 1], 'claude');
  assert.equal(start[start.indexOf('--pane') + 1], 'w1:p3');
  const dash = start.indexOf('--');
  assert.ok(dash !== -1 && start.slice(dash + 1).join(' ') === '--model sonnet --permission-mode acceptEdits', 'native args only after --');
  const tabCreate = calls.find((a) => a[0] === 'tab' && a[1] === 'create');
  assert.ok(tabCreate.includes('--no-focus') && tabCreate.includes('--cwd'), 'background tab in the project cwd');
});

test('model routing: a high-risk or last-attempt judge picks a stronger agent than the builder', () => {
  const c = defaultConfig({ name: 'x' });
  const det = { claude: { bin: 'claude', path: '/c' } };
  const pickFor = (tier) => pickAgent(c, tier, { detected: det, herdr: false }).agentId;
  const builderTier = tierFor(c, { role: 'builder', task: { tier: 'standard', risk: 'low' }, attempt: 1, maxAttempts: 3 });
  const judgeTier = tierFor(c, { role: 'judge', task: { risk: 'high' }, attempt: 1, maxAttempts: 3 });
  assert.equal(builderTier, 'standard');
  assert.equal(judgeTier, 'judge-full');
  assert.equal(pickFor(builderTier), 'claude-sonnet');
  assert.equal(pickFor(judgeTier), 'claude-opus', 'the judge is a stronger model than the builder');
  // The planner runs on the frontier tier too.
  assert.equal(tierFor(c, { role: 'planner' }), 'frontier');
  assert.equal(pickFor(tierFor(c, { role: 'planner' })), 'claude-opus');
});

test('with launch.skipPermissions off, a tab agent falls back to acceptEdits + the role allow-list', () => {
  const dir = projectAtBuild({ configure: (c) => { c.dispatch = { claude: 'tab', mode: 'tab', 'timeout-min': 45 }; c.launch = { ...(c.launch || {}), skipPermissions: false }; } });
  try {
    E.taskStart(dir, 'T001');
    const which = (b) => (b === 'claude' || b === 'herdr' ? `/usr/bin/${b}` : null);
    const p = plan(dir, { task: 'T001', role: 'builder', which, env: { HERDR_ENV: '1' } });
    assert.ok(p.args.includes('acceptEdits') && p.args.includes('--allowedTools'));
    assert.ok(!p.args.some((a) => BYPASS.test(a)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
