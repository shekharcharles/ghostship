// Routing: tiers, escalation, policy, quota, and how each harness may run. Launch commands never carry bypass flags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validateConfig, settable } from '../lib/config.mjs';
import { tierFor, pickAgent, policyBlocks, modeFor } from '../lib/routing.mjs';
import { commandFor, fromTemplate, CATALOG, BYPASS, detect } from '../lib/harness.mjs';

function cfgWith() {
  const c = defaultConfig({ name: 'x' });
  c.providers['codex-plan'] = { type: 'cli-login' };
  c.providers.qwen = { type: 'local', baseUrl: 'http://127.0.0.1:11434/v1' };
  c.providers.gw = { type: 'gateway' };
  c.agents['codex-gpt'] = { harness: 'codex', provider: 'codex-plan', model: 'gpt-5' };
  c.agents['claude-qwen'] = { harness: 'claude', provider: 'gw', model: 'qwen-coder' };
  c.gateway.routes = { 'qwen-coder': { provider: 'qwen', model: 'qwen2.5-coder' } };
  c.routing.tiers.grunt = ['claude-qwen', 'claude-haiku'];
  c.routing.tiers.standard = ['codex-gpt', 'claude-sonnet'];
  return c;
}

test('tiers: role, risk, escalation on the last attempt', () => {
  const c = cfgWith();
  assert.equal(tierFor(c, { role: 'planner' }), 'frontier');
  assert.equal(tierFor(c, { role: 'builder', task: { tier: 'grunt' }, attempt: 1 }), 'grunt');
  assert.equal(tierFor(c, { role: 'builder', task: { tier: 'grunt' }, attempt: 2 }), 'grunt');
  assert.equal(tierFor(c, { role: 'builder', task: { tier: 'grunt' }, attempt: 3 }), 'standard', 'attempt 3 goes one tier up');
  assert.equal(tierFor(c, { role: 'builder', task: { tier: 'standard', risk: 'high' }, attempt: 1 }), 'frontier');
  assert.equal(tierFor(c, { role: 'judge', task: { risk: 'low' }, attempt: 1, maxAttempts: 3 }), 'judge-light');
  assert.equal(tierFor(c, { role: 'judge', task: { risk: 'low' }, attempt: 3, maxAttempts: 3 }), 'judge-full');
});

test('pick: first available agent; Claude-only setups always work', () => {
  const c = cfgWith();
  const none = pickAgent(c, 'standard', { detected: {} });
  assert.equal(none.agentId, 'claude-sonnet', 'codex not installed → falls through to Claude');
  assert.equal(none.mode, 'in-session');
  assert.match(none.skipped[0].reason, /codex is not installed/);
  const withCodex = pickAgent(c, 'standard', { detected: { codex: { path: '/x' } } });
  assert.equal(withCodex.agentId, 'codex-gpt');
  assert.equal(withCodex.mode, 'headless');
  const cooling = pickAgent(c, 'standard', { detected: { codex: { path: '/x' } }, quota: { 'codex-gpt': { until: new Date(Date.now() + 60000).toISOString(), reason: 'quota' } } });
  assert.equal(cooling.agentId, 'claude-sonnet');
  assert.match(cooling.skipped[0].reason, /cooling down/);
  const def = defaultConfig({ name: 'y' });
  for (const t of Object.keys(def.routing.tiers)) assert.ok(pickAgent(def, t, {}).agentId, `default ${t} works with Claude only`);
});

test('confidential projects keep code on the machine or the owner\'s Claude plan', () => {
  const c = cfgWith();
  c.policy.confidential = true;
  assert.match(policyBlocks(c, c.agents['codex-gpt']), /third party/);
  assert.equal(policyBlocks(c, c.agents['claude-sonnet']), null);
  assert.equal(policyBlocks(c, c.agents['claude-qwen']), null, 'gateway routed only to a local model is fine');
  c.providers.or = { type: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', key: 'OPENROUTER_KEY' };
  c.gateway.routes.cloud = { provider: 'or', model: 'x' };
  assert.match(policyBlocks(c, c.agents['claude-qwen']), /non-local/);
  assert.equal(pickAgent(c, 'standard', { detected: { codex: { path: '/x' } } }).agentId, 'claude-sonnet');
});

test('modes: gateway Claude cannot be an in-session subagent; tab needs herdr', () => {
  const c = cfgWith();
  assert.equal(modeFor(c, c.agents['claude-qwen'], { detected: { claude: {} } }).mode, 'headless');
  const g = { ...c, agents: { ...c.agents, gem: { harness: 'gemini', provider: 'codex-plan' } } };
  assert.equal(modeFor(g, g.agents.gem, { detected: { gemini: {} } }).mode, null);
  assert.equal(modeFor(g, g.agents.gem, { detected: { gemini: {} }, herdr: true }).mode, 'tab');
});

test('launch commands: scoped modes only, never a bypass flag; owner templates are theirs and flagged', () => {
  const vars = { model: 'm', prompt: 'Read brief', name: 'gs-t001-builder-a1', root: '/r', role: 'builder', remoteControl: true };
  for (const [id, cat] of Object.entries(CATALOG)) {
    for (const f of [cat.headless, cat.tab]) if (f) for (const a of f(vars)) assert.ok(!BYPASS.test(a), `${id}: ${a}`);
  }
  const claude = commandFor({ harness: 'claude', mode: 'headless', vars });
  assert.deepEqual(claude.args.slice(0, 2), ['-p', 'Read brief'], 'prompt before the variadic tool list');
  assert.ok(claude.args.includes('acceptEdits') && claude.args.includes('Bash(node .ghostship/core/runtime/gs.mjs *)'));
  const codex = commandFor({ harness: 'codex', mode: 'headless', vars });
  assert.deepEqual(codex.args.slice(0, 7), ['exec', '-m', 'm', '--sandbox', 'workspace-write', '--ask-for-approval', 'never']);
  assert.ok(commandFor({ harness: 'opencode', mode: 'headless', vars }).error, 'no safe headless mode → no guess');
  assert.deepEqual(commandFor({ harness: 'claude', mode: 'tab', vars }).args, ['--model', 'm', '--remote-control', 'gs-t001-builder-a1']);
  const own = commandFor({ harness: 'prime-agent', cfgHarness: { headless: 'prime run --model {model} "{prompt}" --yolo' }, mode: 'headless', vars });
  assert.deepEqual(own.args, ['run', '--model', 'm', 'Read brief', '--yolo']);
  assert.match(own.bypassNote, /your harnesses\.prime-agent\.headless template contains --yolo/);
  assert.deepEqual(fromTemplate('x {prompt}', { prompt: 'a; rm -rf /' }), ['x', 'a; rm -rf /'], 'substitution never reaches a shell');
});

test('detection and config validation', () => {
  const d = detect({ which: (b) => (['codex', 'herdr'].includes(b) ? `/bin/${b}` : null) });
  assert.deepEqual(Object.keys(d), ['codex']);
  const c = cfgWith();
  assert.deepEqual(validateConfig(c), []);
  c.providers.bad = { type: 'local', baseUrl: 'https://api.example.com' };
  c.providers.k = { type: 'openai-compatible', key: 'sk-live-123' };
  c.gateway.routes.sub = { provider: 'claude-subscription', model: 'opus' };
  c.launch.permissionBypass = true;
  const errs = validateConfig(c).join('\n');
  assert.match(errs, /local provider must point at localhost/);
  assert.match(errs, /NAME of a line in ~\/\.ghostship\/secrets/);
  assert.match(errs, /never a subscription login/);
  assert.match(errs, /launch\.permissionBypass was renamed: use launch\.skipPermissions/);
  assert.ok(settable('commands.test') && settable('routing.tiers.grunt'));
  assert.ok(!settable('agents.x.model') && !settable('harnesses.codex.headless') && !settable('policy.confidential') && !settable('providers.qwen.baseUrl'));
});

test('limit-aware routing: above the threshold, cheap tiers spare the Claude plan; frontier and fallbacks still work', () => {
  const c = cfgWith();
  c.routing.tiers.standard = ['claude-sonnet', 'codex-gpt'];
  const hot = { fiveHour: { percent: 91, resetsAt: null }, sevenDay: { percent: 40, resetsAt: null } };
  const cool = { fiveHour: { percent: 20, resetsAt: null } };
  const det = { codex: { path: '/x' } };
  assert.equal(pickAgent(c, 'standard', { detected: det, claude: cool }).agentId, 'claude-sonnet', 'below the threshold the list order holds');
  const r = pickAgent(c, 'standard', { detected: det, claude: hot });
  assert.equal(r.agentId, 'codex-gpt');
  assert.match(r.skipped[0].reason, /Claude plan at 91%/);
  const weekly = pickAgent(c, 'standard', { detected: det, claude: { sevenDay: { percent: 88 } } });
  assert.equal(weekly.agentId, 'codex-gpt', 'the 7-day window counts too');
  const alone = pickAgent(c, 'standard', { detected: {}, claude: hot });
  assert.equal(alone.agentId, 'claude-sonnet', 'nothing else installed → Claude anyway');
  assert.match(alone.note, /using Claude anyway/);
  assert.equal(pickAgent(c, 'frontier', { detected: det, claude: hot }).agentId, c.routing.tiers.frontier[0], 'frontier is never spared');
  c.routing['claude-limit-pct'] = 0;
  assert.equal(pickAgent(c, 'standard', { detected: det, claude: hot }).agentId, 'claude-sonnet', '0 turns saving off');
});
