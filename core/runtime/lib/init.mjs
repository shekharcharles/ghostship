// /ghostship init: detect → scaffold → instruction files → hooks/agents → state → one commit.
// Never deletes or moves user files; migration is only planned here and applied after approval.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { gitRun, tryGit, hasStagedChanges, hasIdentity, currentBranch } from './git.mjs';
import { defaultConfig, loadConfig, saveConfig } from './config.mjs';
import { initState, exists as stateExists } from './store.mjs';
import { detect } from './harness.mjs';
import { preflight, gitProbe } from './preflight.mjs';
import { CONFIG_FILE, VERSION_FILE, CORE_DIR, GS_DIR } from './paths.mjs';

export const MARK_START = '<!-- ghostship:start -->';
export const MARK_END = '<!-- ghostship:end -->';

export function upsertMarkerBlock(text, block) {
  const body = `${MARK_START}\n${block.trim()}\n${MARK_END}`;
  const s = String(text || '');
  const a = s.indexOf(MARK_START), b = s.indexOf(MARK_END);
  if (a !== -1 && b > a) return s.slice(0, a) + body + s.slice(b + MARK_END.length);
  return s.trim() ? `${s.trimEnd()}\n\n${body}\n` : `${body}\n`;
}


function defaultWhich(bin) {
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0] || null; } catch { return null; }
}

// Known footprints of other frameworks. action: archive (move after approval) · keep · import · ask
const FOOTPRINTS = [
  { path: '.planning', tool: 'GSD', kind: 'state + plans', action: 'archive', reason: 'Another tool\'s state/plans would compete with Ghostship\'s' },
  { path: '.sch-loop', tool: 'SCH-LOOP', kind: 'state', action: 'archive', reason: 'Previous lifecycle state' },
  { path: '.specify', tool: 'Spec Kit', kind: 'config + constitution', action: 'archive', reason: 'Spec Kit workflow config' },
  { path: 'specs', tool: 'Spec Kit', kind: 'specs/plans/tasks', action: 'import', reason: 'Requirements feed the PRD; open tasks become Ghostship tasks' },
  { path: 'docs/superpowers', tool: 'Superpowers', kind: 'specs + plans', action: 'import', reason: 'Specs feed the PRD/design; plans archived after import' },
  { path: 'docs/plans', tool: 'Superpowers', kind: 'dated plans', action: 'import', reason: 'Open plan items become tasks' },
  { path: '.scratch', tool: 'Matt Pocock skills', kind: 'issues/notes', action: 'import', reason: 'Open issues become tasks' },
  { path: 'CONTEXT.md', tool: 'Matt Pocock skills', kind: 'glossary', action: 'keep', reason: 'Other skills reference it by name' },
  { path: 'GLOSSARY.md', tool: 'Matt Pocock skills', kind: 'glossary', action: 'keep', reason: 'Glossary stays authoritative' },
  { path: 'docs/adr', tool: 'ADRs', kind: 'decisions', action: 'keep', reason: 'Decisions are history; indexed, never rewritten' },
  { path: '.taskmaster', tool: 'Taskmaster', kind: 'tasks + state', action: 'archive', reason: 'Competing task list' },
  { path: '.kiro', tool: 'Kiro', kind: 'specs + steering', action: 'import', reason: 'Specs feed the PRD' },
  { path: '.bmad-core', tool: 'BMAD', kind: 'agents + config', action: 'archive', reason: 'Competing workflow' },
  { path: '.cursor/rules', tool: 'Cursor', kind: 'rules', action: 'ask', reason: 'Rules are split into facts (kept) and workflow (dropped)' },
  { path: '.github/copilot-instructions.md', tool: 'Copilot', kind: 'rules', action: 'ask', reason: 'Rules are split into facts and workflow' },
  { path: 'CLAUDE.md', tool: 'Claude Code', kind: 'instructions', action: 'ask', reason: 'Rules move into AGENTS.md after you see the diff' },
  { path: 'GEMINI.md', tool: 'Gemini', kind: 'instructions', action: 'ask', reason: 'Rules move into AGENTS.md' },
];

export function scanExisting(root) {
  const rows = [];
  for (const f of FOOTPRINTS) {
    const p = join(root, f.path);
    if (!existsSync(p)) continue;
    if (f.path === 'CLAUDE.md' || f.path === 'GEMINI.md') {
      const txt = readFileSync(p, 'utf8');
      // Skip only files Ghostship itself wrote; any other content may hold rules.
      if (txt.includes(MARK_START) || /Project rules live in `AGENTS\.md`|Read and follow `AGENTS\.md`/.test(txt) || !txt.trim()) continue;
    }
    rows.push({ ...f });
  }
  return rows;
}

function folderState(root) {
  if (stateExists(root)) return 'ghostship';
  if (!existsSync(root)) return 'empty';
  const entries = readdirSync(root).filter((n) => n !== '.git');
  return entries.length ? 'existing' : 'empty';
}

function writeIfAbsent(root, rel, content, created) {
  const p = join(root, rel);
  if (existsSync(p)) return false;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  created.push(rel);
  return true;
}

function appendLinesOnce(root, rel, lines, created) {
  const p = join(root, rel);
  const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const missing = lines.filter((l) => !cur.split(/\r?\n/).includes(l));
  if (!missing.length) return;
  writeFileSync(p, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + missing.join('\n') + '\n');
  if (!created.includes(rel)) created.push(rel);
}

const hookCmd = (name) => `node "$CLAUDE_PROJECT_DIR/.ghostship/core/runtime/hooks/${name}"`;
const OURS = /\.ghostship\/core\/runtime\/hooks\/(guard|stop|session|statusline)\.mjs/;

export function mergeSettings(root, created, homeDir = process.env.GHOSTSHIP_HOME || homedir()) {
  const rel = '.claude/settings.json';
  const p = join(root, rel);
  let s = {};
  if (existsSync(p)) {
    s = JSON.parse(readFileSync(p, 'utf8'));
    copyFileSync(p, `${p}.bak`);
  }
  s.hooks = s.hooks || {};
  for (const ev of Object.keys(s.hooks)) {
    s.hooks[ev] = (s.hooks[ev] || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !OURS.test(String(h.command || ''))) }))
      .filter((g) => g.hooks.length);
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  const want = [
    ['PreToolUse', 'Read|Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|Grep', 'guard.mjs'],
    ['Stop', null, 'stop.mjs'],
    ['SessionStart', 'startup|resume|clear|compact', 'session.mjs'],
  ];
  for (const [ev, matcher, file] of want) {
    (s.hooks[ev] = s.hooks[ev] || []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: hookCmd(file), timeout: 30 }] });
  }
  // Status line fallback for the Bridge mod, only when neither the project nor the user already has one.
  let userHas = false;
  try { userHas = !!JSON.parse(readFileSync(join(homeDir, '.claude', 'settings.json'), 'utf8')).statusLine; } catch { /* none */ }
  if (!s.statusLine && !userHas) s.statusLine = { type: 'command', command: hookCmd('statusline.mjs'), padding: 0 };
  const next = JSON.stringify(s, null, 2) + '\n';
  const prev = existsSync(p) ? readFileSync(p, 'utf8') : null;
  if (prev !== next) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, next);
    created.push(rel);
  }
}

function copyCore(coreSrc, root, created) {
  const dst = join(root, CORE_DIR);
  const srcVer = readFileSync(join(coreSrc, 'VERSION'), 'utf8').trim();
  const dstVerFile = join(dst, 'VERSION');
  if (existsSync(dstVerFile) && readFileSync(dstVerFile, 'utf8').trim() === srcVer) return srcVer;
  rmSync(dst, { recursive: true, force: true });
  cpSync(coreSrc, dst, { recursive: true, filter: (s) => !/node_modules|\.git(\/|$)|[\\/]\.prev([\\/]|$)|[\\/]vendor([\\/]|$)|[\\/]mod[\\/][^\\/]+[\\/]tests/.test(s) });
  created.push(CORE_DIR);
  return srcVer;
}

function renderTemplate(coreSrc, name, vars = {}) {
  let t = readFileSync(join(coreSrc, 'templates', name), 'utf8');
  for (const [k, v] of Object.entries(vars)) t = t.split(`{{${k}}}`).join(v);
  return t;
}

export function initProject(root, opts = {}) {
  const { name = root.split(/[\\/]/).filter(Boolean).pop(), coreSrc, gitIdentity, which = defaultWhich, tracker, approvals, tier } = opts;
  if (!coreSrc) throw new Error('initProject needs coreSrc (the Ghostship core folder to copy)');
  mkdirSync(root, { recursive: true });
  const warnings = [];
  const created = [];
  const state = folderState(root);

  // A. detect
  // A repo git refuses (owned by another user) is still a repo: never re-init it; preflight reports the fix.
  const probe = gitProbe(root);
  if (!probe.repo && !probe.missing) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    tryGit(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    created.push('.git');
  }
  if (!probe.dubious && !hasIdentity(root) && gitIdentity) {
    gitRun(root, ['config', 'user.name', gitIdentity.name]);
    gitRun(root, ['config', 'user.email', gitIdentity.email]);
  }
  const harnesses = Object.entries(detect({ which })).map(([n, h]) => ({ name: n, path: h.path }));
  if (which('herdr')) harnesses.push({ name: 'herdr', path: which('herdr') });
  const detection = { node: process.version, harnesses, branch: currentBranch(root) };
  const migration = state === 'existing' ? scanExisting(root) : [];

  // D. write (inside the project only)
  const version = copyCore(coreSrc, root, created);
  writeIfAbsent(root, VERSION_FILE, version + '\n', created);
  if (!existsSync(join(root, CONFIG_FILE))) {
    const cfg = defaultConfig({ name, tracker, approvals, tier });
    if (detection.branch && detection.branch !== 'main') cfg.branches.main = detection.branch;
    saveConfig(root, cfg);
    created.push(CONFIG_FILE);
  }
  for (const d of ['docs/research', 'docs/archive']) writeIfAbsent(root, `${d}/.gitkeep`, '', created);
  writeIfAbsent(root, 'tasks/BOARD.md', renderTemplate(coreSrc, 'BOARD.md'), created);

  const agentsPath = join(root, 'AGENTS.md');
  const agentsCur = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : `# ${name}\n\n## Project facts (owned by you)\n\n- _Stack, commands and conventions go here._\n`;
  const agentsNext = upsertMarkerBlock(agentsCur, renderTemplate(coreSrc, 'agents-block.md'));
  if (agentsNext !== (existsSync(agentsPath) ? agentsCur : null)) { writeFileSync(agentsPath, agentsNext); created.push('AGENTS.md'); }
  writeIfAbsent(root, 'CLAUDE.md', renderTemplate(coreSrc, 'CLAUDE.md'), created);
  writeIfAbsent(root, 'GEMINI.md', renderTemplate(coreSrc, 'GEMINI.md'), created);
  writeIfAbsent(root, 'README.md', renderTemplate(coreSrc, 'README.md', { name }), created);

  mergeSettings(root, created);
  for (const a of ['ghostship-planner.md', 'ghostship-builder.md', 'ghostship-judge.md']) {
    const rel = `.claude/agents/${a}`;
    const content = renderTemplate(coreSrc, `agents/${a}`);
    const p = join(root, rel);
    if (!existsSync(p) || readFileSync(p, 'utf8') !== content) {
      mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); created.push(rel);
    }
  }
  appendLinesOnce(root, '.gitignore', ['.claude/settings.local.json', '.claude/settings.json.bak', '.claude/skills/ghostship-bridge/.claude-plugin/types/', '.ghostship/runs/', '.ghostship/handoff/', '.ghostship/core.prev/', 'docs-site/'], created);
  appendLinesOnce(root, '.gitattributes', ['*.mjs text eol=lf', '*.sh text eol=lf', '*.md text eol=lf'], created);

  if (migration.length) {
    const table = ['# Migration plan (not applied yet)', '', 'Approve with `/ghostship init` review. Nothing has been moved.', '',
      '| # | path | tool | kind | action | reason |', '|---|---|---|---|---|---|',
      ...migration.map((m, i) => `| ${i + 1} | \`${m.path}\` | ${m.tool} | ${m.kind} | ${m.action} | ${m.reason} |`)].join('\n');
    writeFileSync(join(root, GS_DIR, 'migration-plan.md'), table + '\n');
    created.push(`${GS_DIR}/migration-plan.md`);
  }

  // State
  if (state !== 'ghostship') {
    initState(root, { stage: state === 'existing' ? 'adopt' : 'new', createdAt: new Date().toISOString(), migration: migration.map((m) => ({ ...m, status: 'planned' })) });
  }

  // One commit, only of what init wrote, and never over the user's staged work
  let committed = false;
  const pre = preflight(root, { tracker, which });
  const safe = pre.checks.find((c) => c.id === 'git-safe');
  if (safe && !safe.ok) {
    warnings.push(`git refuses this folder, so init did not commit. ${safe.detail}. Fix: ${safe.fix}`);
  } else if (hasStagedChanges(root)) {
    warnings.push('You have staged changes, so init did not commit. Commit or unstage your work, then run init again to commit Ghostship\'s files.');
  } else if (!hasIdentity(root)) {
    warnings.push('git user.name/user.email not set, so init did not commit.');
  } else {
    const paths = [...new Set(created.filter((p) => p !== '.git'))].filter((p) => existsSync(join(root, p)));
    if (paths.length) {
      gitRun(root, ['add', '--', ...paths, '.ghostship']);
      if (hasStagedChanges(root)) {
        gitRun(root, ['commit', '-q', '-m', state === 'existing' && migration.length
          ? `chore: ghostship init (migration planned: ${[...new Set(migration.map((m) => m.tool))].join(', ')})`
          : opts.commitMessage || 'chore: ghostship init']);
        committed = true;
      }
    }
  }

  // What still stands after the commit: the health table shows it, and the init procedure asks the owner once.
  const preflightAfter = preflight(root, { tracker, which });
  return {
    folderState: state, detection, created, migration, warnings, committed, version, preflight: preflightAfter, skipPermissions: loadConfig(root)?.launch?.skipPermissions === true,
    next: state === 'empty' ? 'new' : state === 'existing' ? 'adopt' : (loadConfig(root) && 'bridge'),
  };
}
