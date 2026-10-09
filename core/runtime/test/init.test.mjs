import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initProject, upsertMarkerBlock, scanExisting, MARK_START, MARK_END } from '../lib/init.mjs';
import { load } from '../lib/store.mjs';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const put = (dir, rel, s) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), s); };
const fresh = () => mkdtempSync(join(tmpdir(), 'gs-init-'));
const opts = { name: 'demo', coreSrc: CORE, gitIdentity: { name: 't', email: 't@t' }, which: () => null };

test('marker block: insert into empty, replace in place, keep user text', () => {
  const a = upsertMarkerBlock('', 'RULES v1');
  assert.ok(a.includes(MARK_START) && a.includes('RULES v1') && a.includes(MARK_END));
  const user = `# My project\n\nUse pnpm.\n\n${a}\nNever touch /legacy.\n`;
  const b = upsertMarkerBlock(user, 'RULES v2');
  assert.ok(b.includes('Use pnpm.') && b.includes('Never touch /legacy.'));
  assert.ok(b.includes('RULES v2') && !b.includes('RULES v1'));
  assert.equal(b.split(MARK_START).length, 2, 'exactly one block');
});

test('empty folder: git init, scaffold, instruction files, hooks, state, one commit', () => {
  const dir = fresh();
  const r = initProject(dir, opts);
  assert.equal(r.folderState, 'empty');
  assert.equal(r.next, 'new');
  for (const p of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'README.md', 'tasks/BOARD.md', 'docs/research/.gitkeep',
    'docs/archive/.gitkeep', '.ghostship/config.yaml', '.ghostship/VERSION', '.ghostship/core/runtime/gs.mjs',
    '.claude/agents/ghostship-builder.md', '.claude/agents/ghostship-judge.md', '.claude/agents/ghostship-planner.md',
    '.gitignore', '.gitattributes']) assert.ok(existsSync(join(dir, p)), `missing ${p}`);
  const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes(MARK_START));
  assert.doesNotMatch(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), /@AGENTS\.md/, 'no import: AGENTS.md loads natively');
  const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'));
  const cmds = JSON.stringify(settings.hooks);
  assert.match(cmds, /\.ghostship\/core\/runtime\/hooks\/guard\.mjs/);
  assert.match(cmds, /stop\.mjs/); assert.match(cmds, /session\.mjs/);
  assert.equal(settings.permissions?.defaultMode, undefined, 'init never enables permission bypass');
  assert.ok(!existsSync(join(dir, '.claude/settings.local.json')));
  assert.equal(load(dir).stage, 'new');
  assert.match(git(dir, 'log', '--oneline'), /chore: ghostship init/);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('re-running init is idempotent: no duplicate hooks, blocks or commits', () => {
  const dir = fresh();
  initProject(dir, opts);
  const before = git(dir, 'rev-list', '--count', 'HEAD');
  const r2 = initProject(dir, opts);
  assert.equal(r2.folderState, 'ghostship');
  const cmds = readFileSync(join(dir, '.claude/settings.json'), 'utf8');
  assert.equal((cmds.match(/guard\.mjs/g) || []).length, 1);
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8').split(MARK_START).length, 2);
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), before);
});

test('existing project: preserves user files, detects other frameworks, plans migration, next = adopt', () => {
  const dir = fresh();
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 'u@u'); git(dir, 'config', 'user.name', 'u');
  put(dir, 'src/app.js', '// app entry\nconsole.log(1)\n');
  put(dir, 'CLAUDE.md', '# Rules\nUse pnpm.\nRun /gsd-execute-phase to build.\n');
  put(dir, '.planning/STATE.md', 'phase 2');
  put(dir, 'specs/001-login/spec.md', '# login');
  put(dir, '.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  const r = initProject(dir, opts);
  assert.equal(r.folderState, 'existing');
  assert.equal(r.next, 'adopt');
  assert.match(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), /Use pnpm/, 'user CLAUDE.md untouched');
  assert.match(readFileSync(join(dir, '.claude/settings.json'), 'utf8'), /echo mine/);
  assert.ok(existsSync(join(dir, '.claude/settings.json.bak')));
  const tools = r.migration.map((m) => m.tool);
  assert.ok(tools.includes('GSD') && tools.includes('Spec Kit'));
  assert.ok(r.migration.some((m) => m.path === 'CLAUDE.md' && m.action === 'ask'));
  assert.ok(existsSync(join(dir, '.ghostship/migration-plan.md')));
  assert.ok(existsSync(join(dir, '.planning/STATE.md')), 'nothing moved without approval');
});

test('staged user changes block the commit (never sweeps your work into ours)', () => {
  const dir = fresh();
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 'u@u'); git(dir, 'config', 'user.name', 'u');
  put(dir, 'a.txt', '1'); git(dir, 'add', 'a.txt'); git(dir, 'commit', '-qm', 'base');
  put(dir, 'a.txt', '2'); git(dir, 'add', 'a.txt');
  const r = initProject(dir, opts);
  assert.equal(r.committed, false);
  assert.match(r.warnings.join('\n'), /staged/);
  assert.match(git(dir, 'diff', '--cached', '--name-only'), /^a\.txt$/m);
});

test('scanExisting classifies known frameworks', () => {
  const dir = fresh();
  put(dir, '.sch-loop/config.md', 'x'); put(dir, 'docs/superpowers/plans/2026-01-01-x.md', 'x'); put(dir, 'CONTEXT.md', 'x');
  const rows = scanExisting(dir);
  const by = Object.fromEntries(rows.map((r) => [r.path, r]));
  assert.equal(by['.sch-loop'].action, 'archive');
  assert.equal(by['docs/superpowers'].tool, 'Superpowers');
  assert.equal(by['CONTEXT.md'].action, 'keep');
});

test('detects available harnesses through the injected lookup', () => {
  const dir = fresh();
  const r = initProject(dir, { ...opts, which: (b) => (b === 'claude' || b === 'codex' ? `/usr/bin/${b}` : null) });
  assert.deepEqual(r.detection.harnesses.map((h) => h.name).sort(), ['claude', 'codex']);
});

test('approvals bridge: init writes a valid config, and the report says whether the owner key exists', async () => {
  const { loadConfig, validateConfig } = await import('../lib/config.mjs');
  const dir = fresh();
  initProject(dir, { ...opts, approvals: 'bridge' });
  const cfg = loadConfig(dir);
  assert.equal(cfg.approvals.mode, 'bridge');
  assert.deepEqual(validateConfig(cfg), []);
  const GS = join(CORE, 'runtime', 'gs.mjs');
  const home = mkdtempSync(join(tmpdir(), 'gs-home-'));
  const run = (d) => execFileSync(process.execPath, [GS, 'init', '--approvals', 'bridge', '--name', 'demo2'], { cwd: d, encoding: 'utf8', env: { ...process.env, GHOSTSHIP_HOME: home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  const d1 = fresh();
  assert.match(run(d1), /approvals\s*\|\s*bridge — owner key missing: run node install\.mjs/);
  mkdirSync(join(home, '.ghostship'), { recursive: true });
  writeFileSync(join(home, '.ghostship', 'bridge.key'), 'a'.repeat(64) + '\n');
  assert.match(run(fresh()), /approvals\s*\|\s*bridge — one press in the Bridge pane \(owner key found\)/);
});
