// Guard policy and hook processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, BUILDER, JUDGE } from '../lib/guard-rules.mjs';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const ROOT = '/repo';
const W = (file_path, agent_type = '') => ({ tool_name: 'Write', tool_input: { file_path }, agent_type });
const B = (command, agent_type = '') => ({ tool_name: 'Bash', tool_input: { command }, agent_type });
const task = (status, extra = {}) => ({ id: 'T001', status, allowedPaths: ['src/auth/**', 'tests/auth/**'], locks: {}, ...extra });
const S = (over = {}) => ({ stage: 'build', prd: { approved: true }, acceptance: { approved: true }, acceptanceLock: { files: {} }, tasks: {}, ...over });
const denied = (r) => r.deny === true;

test('records, enforcement and secrets are never written by tools', () => {
  const s = S({ prd: null, acceptance: null, acceptanceLock: null, stage: 'new' });
  for (const p of ['.ghostship/state/state.json', '.ghostship/evidence/T1/E1/output.log', '.ghostship/core/runtime/gs.mjs', 'tasks/T001-x.md',
    '.claude/settings.json', '.claude/settings.local.json', '.claude/agents/ghostship-judge.md']) {
    assert.ok(denied(evaluate(s, ROOT, W(`${ROOT}/${p}`))), p);
  }
  assert.ok(denied(evaluate(s, ROOT, W('/home/u/.ghostship/secrets'))));
  assert.ok(!denied(evaluate(s, ROOT, W(`${ROOT}/src/anything.js`))), 'before STOP 1 prototypes write freely');
  assert.ok(denied(evaluate(s, ROOT, W(`${ROOT}/.ghostship/config.yaml`))), 'config changes go through gs config set');
});

test('locked documents and acceptance tests', () => {
  const s = S({ tasks: { T001: task('BUILDING') } });
  assert.ok(denied(evaluate(s, ROOT, W(`${ROOT}/docs/01-requirements/PRD.md`))));
  assert.ok(denied(evaluate(s, ROOT, W(`${ROOT}/docs/03-acceptance/ACCEPTANCE-CHECKS.md`))));
  assert.ok(denied(evaluate(s, ROOT, W(`${ROOT}/tests/acceptance/C1-x.test.js`))));
  assert.ok(denied(evaluate(s, ROOT, W(`${ROOT}/.ghostship/config.yaml`))));
  const plan = S({ stage: 'plan', acceptanceLock: null });
  assert.ok(!denied(evaluate(plan, ROOT, W(`${ROOT}/tests/acceptance/C1-x.test.js`))), 'acceptance tests are writable until locked');
});

test('task scope, frozen tree while judging, RED locks', () => {
  assert.ok(denied(evaluate(S(), ROOT, W(`${ROOT}/src/auth/login.js`))), 'no active task');
  assert.ok(!denied(evaluate(S(), ROOT, W(`${ROOT}/docs/04-plan/ROADMAP.md`))), 'docs are free');
  assert.ok(!denied(evaluate(S(), ROOT, W(`${ROOT}/.ghostship/drafts/tasks/T009.md`))), 'drafts are free');
  const b = S({ tasks: { T001: task('BUILDING', { locks: { 'tests/auth/login.test.js': 'abc' } }) } });
  assert.ok(!denied(evaluate(b, ROOT, W(`${ROOT}/src/auth/login.js`, BUILDER))));
  assert.ok(denied(evaluate(b, ROOT, W(`${ROOT}/src/billing/x.js`, BUILDER))));
  assert.ok(denied(evaluate(b, ROOT, W(`${ROOT}/tests/auth/login.test.js`, BUILDER))), 'locked at RED');
  const j = S({ tasks: { T001: task('JUDGING') } });
  assert.ok(denied(evaluate(j, ROOT, W(`${ROOT}/src/auth/login.js`))));
  assert.ok(denied(evaluate(j, ROOT, W(`${ROOT}/docs/05-code/CODEMAP.md`))), 'frozen means docs too');
  assert.ok(!denied(evaluate(j, ROOT, W(`${ROOT}/docs/11-memory/LESSONS.md`))), 'memory is outside the tree hash');
  assert.ok(denied(evaluate(b, ROOT, W(`${ROOT}/src/auth/login.js`, JUDGE))), 'judge is read-only');
});

test('shell: roles, records, git and secrets', () => {
  const b = S({ tasks: { T001: task('BUILDING') } });
  const gs = 'node .ghostship/core/runtime/gs.mjs';
  assert.ok(!denied(evaluate(b, ROOT, B(`${gs} evidence --task T001 --kind red`, BUILDER))));
  assert.ok(denied(evaluate(b, ROOT, B(`${gs} task submit T001`, BUILDER))));
  assert.ok(denied(evaluate(b, ROOT, B(`${gs} verdict --task T001 --result PASS`, BUILDER))));
  assert.ok(denied(evaluate(b, ROOT, B(`${gs} acceptance approve --quote yes`, BUILDER))));
  assert.ok(denied(evaluate(b, ROOT, B('git commit -am wip', BUILDER))));
  assert.ok(!denied(evaluate(b, ROOT, B('git diff --stat', BUILDER))));
  assert.ok(!denied(evaluate(b, ROOT, B(`${gs} task submit T001`))), 'the orchestrator submits');
  assert.ok(denied(evaluate(b, ROOT, B(`${gs} task start T002`, JUDGE))));
  assert.ok(denied(evaluate(b, ROOT, B(`${gs} evidence --task T001 --kind green`, JUDGE))));
  assert.ok(!denied(evaluate(b, ROOT, B(`${gs} evidence --task T001 --kind judge --token x`, JUDGE))));
  assert.ok(denied(evaluate(b, ROOT, B('echo x > .ghostship/state/state.json'))));
  assert.ok(denied(evaluate(b, ROOT, B('rm -rf tests/acceptance/'))));
  assert.ok(denied(evaluate(b, ROOT, B('sed -i s/a/b/ tasks/T001-x.md'))));
  assert.ok(!denied(evaluate(b, ROOT, B('cat tasks/T001-x.md'))));
  assert.ok(!denied(evaluate(b, ROOT, B('cp a src/tasks/b.js'))), 'a nested tasks/ folder is product code');
  assert.ok(denied(evaluate(b, ROOT, B('cat ~/.ghostship/secrets'))));
  assert.ok(denied(evaluate(b, ROOT, B('node .ghostship/core/runtime/lib/store.mjs'))));
  // An assumption's prose is not a command: words like go, merge or approve inside a plain quoted value pass.
  assert.ok(!denied(evaluate(b, ROOT, B(`${gs} assume --task T001 --text "we go with numbers; merge rules approve later"`, BUILDER))));
  assert.ok(!denied(evaluate(b, ROOT, B(`${gs} assume --task T001 --text='release notes stay as they are' --product`, BUILDER))));
  assert.ok(!denied(evaluate(b, ROOT, B(`${gs} task fail T001 --reason "the evidence of a verdict is unclear"`, BUILDER))));
  // …but a value the shell expands, or a command beside it, is still read.
  assert.ok(denied(evaluate(b, ROOT, B(`${gs} assume --task T001 --text "$(${gs} decide T001 --merge)"`, BUILDER))));
  assert.ok(denied(evaluate(b, ROOT, B(`${gs} assume --task T001 --text "\`${gs} release approve\`"`, BUILDER))));
  assert.ok(denied(evaluate(b, ROOT, B(`${gs} assume --text "x" decide T001 --merge`, BUILDER))));
  assert.ok(denied(evaluate(b, ROOT, B(`${gs} decide T001 --merge`, BUILDER))), 'a builder never decides a held merge');
  assert.ok(denied(evaluate(b, ROOT, B(`${gs} assume --task T001 --text "ok" --kind judge`, BUILDER))), 'a role flag outside the value is still read');
});

function hook(name, root, payload) {
  return spawnSync(process.execPath, [join(HOOKS, name)], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
}

test('hooks: inert without state, fail closed on garbage, block a stalled stop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gs-hook-'));
  try {
    assert.equal(hook('guard.mjs', dir, W(`${dir}/x.js`)).status, 0);
    assert.equal(hook('stop.mjs', dir, {}).status, 0);
    mkdirSync(join(dir, '.ghostship/state'), { recursive: true });
    const state = { ...S({ tasks: { T001: { ...task('BUILDING'), attempt: 1, maxAttempts: 3, history: [], evidence: {} } } }), eventSeq: 1, lastHash: 'x' };
    writeFileSync(join(dir, '.ghostship/state/state.json'), JSON.stringify(state));
    const g = hook('guard.mjs', dir, W(`${dir}/src/billing/x.js`));
    assert.equal(g.status, 2);
    assert.match(g.stderr, /outside T001 allowedPaths/);
    const bad = spawnSync(process.execPath, [join(HOOKS, 'guard.mjs')], { input: 'not json', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    assert.equal(bad.status, 2, 'fails closed');
    const st = hook('stop.mjs', dir, {});
    assert.equal(JSON.parse(st.stdout).decision, 'block');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('review fixes: the CLI is recognised however it is spelled; credentials are not readable', () => {
  const b = S({ tasks: { T001: task('BUILDING') } });
  for (const cmd of ['cd .ghostship/core/runtime && node gs.mjs task submit T001', 'node .ghostship/core/runtime//gs.mjs verdict --task T001', 'node ./.ghostship/core/runtime/./gs.mjs evidence --task T001 --kind judge'])
    assert.ok(denied(evaluate(b, ROOT, B(cmd, BUILDER))), cmd);
  assert.ok(denied(evaluate(b, ROOT, { tool_name: 'Read', tool_input: { file_path: `${ROOT}/.ghostship/runs/gateway.json` } })));
  assert.ok(denied(evaluate(b, ROOT, B('cat .ghostship/runs/gateway.json'))));
  assert.ok(!denied(evaluate(b, ROOT, { tool_name: 'Read', tool_input: { file_path: `${ROOT}/src/a.js` } })));
});
