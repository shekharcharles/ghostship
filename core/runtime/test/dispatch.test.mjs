// Outside agent runs through fake CLIs: headless codex and an agent in a (fake) herdr tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectAtBuild, fakeBin, GS } from './project.mjs';
import * as E from '../lib/engine.mjs';
import { loadQuota } from '../lib/routing.mjs';
import { createHerdr } from '../lib/herdr.mjs';

function codexProject(extra = (c) => c) {
  return projectAtBuild({ configure: (c) => {
    c.providers['codex-plan'] = { type: 'cli-login' };
    c.agents['codex-gpt'] = { harness: 'codex', provider: 'codex-plan', model: 'gpt-5' };
    c.routing.tiers.standard = ['codex-gpt', 'claude-sonnet'];
    extra(c);
  } });
}

// Fake codex: logs argv/env, tries a forbidden command, then writes its report where the prompt says.
const CODEX = (behaviour) => `
const fs = require('fs'); const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
fs.writeFileSync('.ghostship/runs/fake-argv.json', JSON.stringify({ args, role: process.env.GHOSTSHIP_ROLE }));
const tried = spawnSync(process.execPath, [${JSON.stringify(GS)}, 'task', 'submit', 'T001'], { encoding: 'utf8' });
fs.writeFileSync('.ghostship/runs/fake-submit.txt', tried.stderr);
${behaviour}
const m = /write your report to (\\S+?)\\.?$/.exec(args.at(-1)); if (m) fs.writeFileSync(m[1], 'ready to submit\\n');
`;

const gs = (dir, env, ...a) => spawnSync(process.execPath, [GS, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...env } });

test('headless codex run: scoped flags, role env, report, history; a running builder cannot be submitted around', () => {
  const dir = codexProject();
  const bin = mkdtempSync(join(tmpdir(), 'gs-bin-'));
  try {
    fakeBin(bin, 'codex', CODEX("Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);"));
    const env = { PATH: `${bin}:${process.env.PATH}` };
    E.taskStart(dir, 'T001');
    const route = gs(dir, env, 'route', '--role', 'builder', '--task', 'T001');
    assert.match(route.stdout, /tier standard → codex-gpt \(codex gpt-5\) as headless/);
    const d = gs(dir, env, 'dispatch', '--role', 'builder', '--task', 'T001');
    assert.equal(d.status, 0, d.stderr);
    assert.equal(gs(dir, env, 'task', 'submit', 'T001').stderr.match(/✗ (\w+)/)?.[1], 'BUILDER_RUNNING');
    assert.match(gs(dir, env, 'dispatch', '--role', 'builder', '--task', 'T001').stderr, /RUN_ACTIVE/);
    const w = gs(dir, env, 'run', 'wait', '--timeout', '30', '--json');
    const r = JSON.parse(w.stdout);
    assert.equal(r.status, 'done');
    assert.equal(r.report, '.ghostship/runs/T001/a1-builder.report.md');
    const argv = JSON.parse(readFileSync(join(dir, '.ghostship/runs/fake-argv.json'), 'utf8'));
    assert.equal(argv.role, 'builder');
    assert.deepEqual(argv.args.slice(0, 7), ['exec', '-m', 'gpt-5', '--sandbox', 'workspace-write', '--ask-for-approval', 'never']);
    assert.ok(!argv.args.some((a) => /dangerously|yolo|bypass/i.test(a)));
    assert.match(readFileSync(join(dir, '.ghostship/runs/fake-submit.txt'), 'utf8'), /ROLE_FORBIDDEN/, 'the builder cannot submit itself');
    const brief = readFileSync(join(dir, '.ghostship/runs/T001/a1-builder.brief.md'), 'utf8');
    assert.match(brief, /C1 \[run\]: add\(2, 3\) returns 5/);
    assert.doesNotMatch(brief, /token:/, 'builders never see a judge token');
    assert.equal(JSON.parse(gs(dir, env, 'run', 'history', '--json').stdout).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
});

test('quota errors cool the agent down and routing falls back to Claude', () => {
  const dir = codexProject();
  const bin = mkdtempSync(join(tmpdir(), 'gs-bin-'));
  try {
    fakeBin(bin, 'codex', CODEX("console.error('Error: rate limit exceeded, try later'); process.exit(1);"));
    const env = { PATH: `${bin}:${process.env.PATH}` };
    E.taskStart(dir, 'T001');
    gs(dir, env, 'dispatch', '--role', 'builder', '--task', 'T001');
    const r = JSON.parse(gs(dir, env, 'run', 'wait', '--timeout', '30', '--json').stdout);
    assert.equal(r.status, 'quota');
    assert.ok(loadQuota(dir)['codex-gpt']);
    assert.match(gs(dir, env, 'route', '--role', 'builder', '--task', 'T001').stdout, /→ claude-sonnet .*in-session[\s\S]*cooling down/);
    assert.match(gs(dir, env, 'dispatch', '--role', 'builder', '--task', 'T001').stdout, /runs in this session/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
});

// Fake herdr: JSON like the real CLI; the first prompt ends "blocked" (an approval), then the owner answers.
const HERDR = `
const fs = require('fs'); const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(a) + '\\n');
const out = (o) => console.log(JSON.stringify({ result: o }));
const k = a[0] + ' ' + a[1];
if (k === 'tab create') out({ tab: { tab_id: 'w1:t2' }, root_pane: { pane_id: 'w1:p5' } });
else if (k === 'agent start') out({ agent: { name: a[2], status: 'idle' } });
else if (k === 'agent prompt') { const m = /write your report to (\\S+?)\\.?$/.exec(a[3]); fs.writeFileSync(m[1], 'done'); out({ agent: { status: 'blocked' } }); }
else if (k === 'agent wait') out({ agent: { status: 'idle' } });
else if (k === 'agent read') console.log('transcript tail');
else if (k === 'tab close') out({});
else { console.error(JSON.stringify({ error: { code: 'unknown' } })); process.exit(1); }
`;

test('herdr tab run: named tab in the orchestrator workspace, blocked → alert → wait, tab closed', () => {
  const dir = projectAtBuild({ configure: (c) => {
    c.providers['g'] = { type: 'cli-login' };
    c.agents.gem = { harness: 'gemini', provider: 'g', model: 'gemini-2.5-pro' };
    c.routing.tiers.frontier = ['gem', 'claude-opus'];
  } });
  const bin = mkdtempSync(join(tmpdir(), 'gs-bin-'));
  try {
    fakeBin(bin, 'herdr', HERDR);
    fakeBin(bin, 'gemini', 'process.exit(0)');
    const log = join(bin, 'herdr.log');
    const env = { PATH: `${bin}:${process.env.PATH}`, HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1', FAKE_HERDR_LOG: log };
    E.taskStart(dir, 'T001');
    const d = gs(dir, env, 'dispatch', '--role', 'planner');
    assert.equal(d.status, 0, d.stderr);
    assert.match(d.stdout, /gem \(gemini gemini-2\.5-pro\) as tab/);
    const r = JSON.parse(gs(dir, env, 'run', 'wait', '--timeout', '30', '--json').stdout);
    assert.equal(r.status, 'done', JSON.stringify(r));
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(calls.map((c) => `${c[0]} ${c[1]}`), ['tab create', 'agent start', 'agent prompt', 'agent wait', 'agent read', 'tab close']);
    assert.deepEqual(calls[0].slice(0, 4), ['tab', 'create', '--workspace', 'w1']);
    assert.ok(calls[0].includes('--env') && calls[0].includes('GHOSTSHIP_ROLE=planner'));
    assert.deepEqual(calls[1].slice(0, 7), ['agent', 'start', 'gs-plan-tasks', '--kind', 'gemini', '--pane', 'w1:p5']);
    assert.deepEqual(calls[1].slice(-3), ['--', '-m', 'gemini-2.5-pro']);
    assert.match(readFileSync(join(dir, '.ghostship/runs/alerts.jsonl'), 'utf8'), /blocked: needs your answer/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
});

test('herdr adapter: workspace from env, else created; errors carry herdr codes', () => {
  const calls = [];
  const h = createHerdr({ env: {}, run: (a) => { calls.push(a); return a[0] === 'workspace' ? { status: 0, stdout: JSON.stringify({ result: { workspace: { workspace_id: 'w9' } } }) } : { status: 1, stdout: '', stderr: JSON.stringify({ error: { code: 'agent_blocked' } }) }; } });
  assert.equal(h.workspace('/p', 'math'), 'w9');
  assert.deepEqual(calls[0], ['workspace', 'create', '--cwd', '/p', '--label', 'math', '--no-focus']);
  assert.throws(() => h.prompt({ name: 'x', text: 'y', timeoutMs: 1000 }), (e) => e.code === 'agent_blocked');
  assert.equal(createHerdr({ env: { HERDR_WORKSPACE_ID: 'w1' }, run: () => { throw new Error('not called'); } }).workspace('/p', 'm'), 'w1');
});
