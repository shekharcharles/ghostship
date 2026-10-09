// Git plumbing. Never touches the user's real index.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TREE_EXCLUDES } from './paths.mjs';

export const EXCLUDED = TREE_EXCLUDES;

// Tool output, not source: caches and build output that test, typecheck and build commands write. They never count
// as a change to the tree, even before the project's .gitignore lists them (a skeleton task writes that .gitignore
// itself), so running a command never invalidates evidence. A task's scope is still checked on its source files.
const TOOL_OUTPUT_DIRS = ['node_modules', 'dist', 'build', 'out', 'coverage', '.nyc_output', '.vite', '.cache', '.parcel-cache', '.turbo',
  '.next', '.nuxt', '.svelte-kit', 'test-results', 'playwright-report', 'blob-report', 'target', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.tox', '.gradle'];
export const TOOL_OUTPUT = [...TOOL_OUTPUT_DIRS.map((d) => `:(glob)**/${d}/**`), ':(glob)**/*.tsbuildinfo', ':(glob)**/*.pyc'];
const TOOL_OUTPUT_EXCLUDE = TOOL_OUTPUT.map((p) => p.replace(':(glob)', ':(exclude,glob)'));

function git(root, args, env) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

export function isRepo(root) {
  try { return git(root, ['rev-parse', '--is-inside-work-tree']) === 'true'; } catch { return false; }
}

export function headCommit(root) {
  try { return git(root, ['rev-parse', 'HEAD']); } catch { return null; }
}

/**
 * Hash of the working tree as git would commit it (tracked + untracked, honouring
 * .gitignore), excluding factory state and evidence. Uses a throwaway index file.
 */
export function treeHash(root) {
  const dir = mkdtempSync(join(tmpdir(), 'schf-idx-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    if (headCommit(root)) git(root, ['read-tree', 'HEAD'], env);
    git(root, ['add', '-A', '--', '.', ...TOOL_OUTPUT_EXCLUDE], env);
    // Drop anything under excluded dirs (and tool output) that HEAD may already track.
    for (const p of [...EXCLUDED, ...TOOL_OUTPUT]) {
      try { git(root, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', p], env); } catch { /* none */ }
    }
    return git(root, ['write-tree'], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function changedPaths(root, treeA, treeB) {
  if (treeA === treeB) return [];
  const out = git(root, ['diff-tree', '-r', '--name-only', '--no-renames', treeA, treeB]);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** sha of a file's blob content inside a tree, or null if absent. */
export function blobInTree(root, tree, rel) {
  try { return git(root, ['rev-parse', `${tree}:${rel}`]); } catch { return null; }
}

export function diffStat(root, treeA, treeB) {
  try { return git(root, ['diff-tree', '-r', '--stat', treeA, treeB]); } catch { return ''; }
}

/**
 * Would merging `branch` into `base` conflict? Asked of git without touching the working tree or the index
 * (`git merge-tree --write-tree`, git 2.38+). Returns the conflicted paths ([] = merges cleanly), or null when this
 * git cannot answer, so callers fall back to trying the merge.
 */
export function mergeConflicts(root, base, branch) {
  try {
    execFileSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, branch], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return [];
  } catch (e) {
    if (e.status !== 1) return null;
    return [...new Set(String(e.stdout || '').split('\n').slice(1).map((l) => l.trim()).filter(Boolean))];
  }
}

export function gitRun(root, args, opts = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

export function tryGit(root, args) {
  try { return { ok: true, out: gitRun(root, args) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message) }; }
}

export function currentBranch(root) {
  const r = tryGit(root, ['symbolic-ref', '--short', 'HEAD']);
  return r.ok ? r.out : null;
}

export function branchExists(root, name) {
  return tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).ok;
}

/** Porcelain status lines, excluding paths Ghostship itself owns. */
export function dirtyPaths(root, ignore = EXCLUDED) {
  let out = '';
  try { out = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return []; }
  return out.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''))
    .filter((p) => !ignore.some((x) => p === x || p.startsWith(x + '/')));
}

export function hasStagedChanges(root) {
  return !tryGit(root, ['diff', '--cached', '--quiet']).ok;
}

export function hasIdentity(root) {
  return tryGit(root, ['config', 'user.email']).ok && tryGit(root, ['config', 'user.name']).ok;
}

/** Every file path inside a tree object. */
export function listTree(root, tree) {
  const out = tryGit(root, ['ls-tree', '-r', '--name-only', tree]);
  return out.ok && out.out ? out.out.split('\n').filter(Boolean) : [];
}

/** Stage everything except Ghostship-owned paths, then commit. Returns true if a commit was made. */
export function commitWork(root, message, excludes = EXCLUDED) {
  gitRun(root, ['add', '-A', '--', '.']);
  for (const p of excludes) tryGit(root, ['reset', '-q', '--', p]);
  if (!hasStagedChanges(root)) return false;
  gitRun(root, ['commit', '-q', '--no-verify', '-m', message]);
  return true;
}

/** Commit only the given paths (bookkeeping). Missing paths are skipped. */
export function commitPaths(root, paths, message) {
  const r = tryGit(root, ['add', '-A', '--', ...paths]);
  if (!r.ok) return false;
  if (!hasStagedChanges(root)) return false;
  gitRun(root, ['commit', '-q', '--no-verify', '-m', message]);
  return true;
}
