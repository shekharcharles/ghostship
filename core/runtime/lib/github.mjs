// GitHub tracker (tracker.mode github | both): mirrors local truth to GitHub with the `gh` CLI.
// Tasks ↔ issues, the release candidate ↔ a develop→main pull request, approved releases ↔ GitHub releases,
// branches and tags pushed. Local state stays the source of truth; GitHub never decides anything.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load, mutate, fail } from './store.mjs';
import { loadConfig } from './config.mjs';

export function realExec(bin, args, { cwd, input } = {}) {
  const r = spawnSync(bin, args, { cwd, input, encoding: 'utf8', timeout: 120000, windowsHide: true });
  return { status: typeof r.status === 'number' ? r.status : 1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || r.error?.message || '').trim() };
}

const num = (url) => Number(/\/(\d+)\s*$/.exec(url || '')?.[1] || 0) || null;

function taskFile(root, id) {
  try { const f = readdirSync(join(root, 'tasks')).find((n) => n.startsWith(`${id}-`)); return f ? join(root, 'tasks', f) : null; } catch { return null; }
}

export function ready(root, exec = realExec) {
  const cfg = loadConfig(root);
  if (!['github', 'both'].includes(cfg.tracker?.mode)) return { ok: false, reason: 'tracker.mode is local' };
  if (exec('git', ['remote', 'get-url', 'origin'], { cwd: root }).status !== 0) return { ok: false, reason: 'no git remote "origin"' };
  if (exec('gh', ['auth', 'status'], { cwd: root }).status !== 0) return { ok: false, reason: 'gh is not installed or not signed in (gh auth login)' };
  return { ok: true };
}

/** One sync pass. Returns what it did; safe to run any time (idempotent). */
export function sync(root, { exec = realExec, push = true } = {}) {
  const r = ready(root, exec);
  if (!r.ok) fail('GITHUB_NOT_READY', r.reason);
  const cfg = loadConfig(root);
  const state = load(root);
  const did = [];
  const run = (bin, args, opts) => { const x = exec(bin, args, { cwd: root, ...opts }); if (x.status !== 0) did.push(`! ${bin} ${args.slice(0, 2).join(' ')}: ${x.stderr.slice(0, 200)}`); return x; };
  if (push) {
    const branches = [cfg.branches.develop, cfg.branches.main].filter((b) => exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { cwd: root }).status === 0);
    if (branches.length && run('git', ['push', '--follow-tags', 'origin', ...branches]).status === 0) did.push(`pushed ${branches.join(', ')} and tags`);
  }
  run('gh', ['label', 'create', 'ghostship', '--color', '2f5d8a', '--description', 'Managed by Ghostship', '--force']);
  const updates = {};
  for (const t of Object.values(state.tasks || {})) {
    const gh = { ...(t.github || {}) };
    if (!gh.issue && !['DROPPED'].includes(t.status)) {
      const f = taskFile(root, t.id);
      const x = run('gh', ['issue', 'create', '--title', `${t.id} ${t.title}`, '--label', 'ghostship', '--body-file', '-'], { input: f ? readFileSync(f, 'utf8') : t.title });
      if (x.status === 0) { gh.issue = num(x.stdout); did.push(`issue #${gh.issue} for ${t.id}`); }
    }
    if (gh.issue && !gh.closed && ['MERGED', 'DROPPED'].includes(t.status)) {
      const why = t.status === 'MERGED' ? `Merged into develop${t.merged?.commit ? ` as ${t.merged.commit.slice(0, 10)}` : ''}: ${t.merged?.message || ''}` : 'Dropped by the owner.';
      if (run('gh', ['issue', 'close', String(gh.issue), '--comment', why, ...(t.status === 'DROPPED' ? ['--reason', 'not planned'] : [])]).status === 0) { gh.closed = true; did.push(`closed #${gh.issue}`); }
    }
    if (gh.issue && t.status === 'NEEDS_DECISION' && gh.flagged !== t.attempt) {
      if (run('gh', ['issue', 'comment', String(gh.issue), '--body', `Needs the owner's decision after ${t.attempt}/${t.maxAttempts} attempts. Last: ${t.history.at(-1)?.reason || '-'}`]).status === 0) gh.flagged = t.attempt;
    }
    if (JSON.stringify(gh) !== JSON.stringify(t.github || {})) updates[t.id] = gh;
  }
  let pr = null;
  if (state.release && !state.release.pr && existsSync(join(root, state.release.packet))) {
    const x = run('gh', ['pr', 'create', '--base', cfg.branches.main, '--head', cfg.branches.develop, '--title', `Release v${state.release.version}`, '--body-file', state.release.packet]);
    if (x.status === 0) { pr = num(x.stdout); did.push(`release PR #${pr}`); }
  }
  const relDone = [];
  for (const rel of state.releases || []) {
    if (rel.github) continue;
    const assets = [];
    try { for (const n of readdirSync(join(root, 'docs-site'))) if (n.endsWith(`${rel.tag}.tar.gz`)) assets.push(join('docs-site', n)); } catch { /* none */ }
    const x = run('gh', ['release', 'create', rel.tag, '--title', rel.tag, '--notes-file', rel.packet, ...assets]);
    if (x.status === 0) { relDone.push(rel.tag); did.push(`GitHub release ${rel.tag}${assets.length ? ' with docs' : ''}`); }
  }
  if (Object.keys(updates).length || pr || relDone.length) {
    mutate(root, 'github.sync', null, { updates, pr, releases: relDone }, (s) => {
      for (const [id, gh] of Object.entries(updates)) if (s.tasks[id]) s.tasks[id].github = gh;
      if (pr && s.release) s.release.pr = pr;
      for (const rel of s.releases || []) if (relDone.includes(rel.tag)) rel.github = true;
    });
  }
  return did;
}
