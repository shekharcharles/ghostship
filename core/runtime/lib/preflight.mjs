// Preflight: everything that would stop Ghostship later, found before the first task.
// Run inside /ghostship init (report only) and by `gs preflight [--fix]`, so the owner is asked once, at the start,
// instead of meeting a refused git folder, a missing author and a missing first commit one question at a time.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';

/** git's refusal for a folder owned by another user (safe.directory). */
export const DUBIOUS = /detected dubious ownership/i;
export const isDubious = (text) => DUBIOUS.test(String(text || ''));
// Never swept into a first commit: what usually holds secrets.
const SECRETISH = /(^|\/)(\.env(\.[\w.-]+)?|[^/]+\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa))$/i;

function run(root, bin, args) {
  try {
    const out = execFileSync(bin, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).trim();
    return { ok: true, out, err: '' };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '').trim(), err: String(e.stderr || e.message || '').trim(), missing: e.code === 'ENOENT' };
  }
}
const git = (root, args) => run(root, 'git', args);

/** Is the folder a repo, and does git refuse it? `dubious` carries git's own words. */
export function gitProbe(root) {
  const r = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (r.ok) return { repo: r.out === 'true', dubious: false, err: '' };
  if (r.missing) return { repo: false, dubious: false, err: 'git is not installed', missing: true };
  return { repo: isDubious(r.err), dubious: isDubious(r.err), err: r.err.split('\n')[0] };
}

function defaultWhich(bin) {
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0] || null; } catch { return null; }
}
const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;

/**
 * Checks (and with `fix`, repairs) what Ghostship needs. Global changes happen only with `allowGlobal`;
 * the identity fix is repo-local. Returns { ok, checks: [{ id, ok, detail, fix, fixed }] }.
 */
export function preflight(root, { fix = false, allowGlobal = false, name, email, tracker, which = defaultWhich } = {}) {
  const checks = [];
  const add = (id, ok, detail, fixCmd = null, fixed = false) => checks.push({ id, ok, detail, fix: ok ? null : fixCmd, fixed });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 18, `node ${process.version}${major >= 18 ? '' : ' (Ghostship needs 18 or later)'}`, 'install Node 18 or later');

  const gv = git(root, ['--version']);
  add('git', gv.ok, gv.ok ? gv.out.replace(/^git version /, 'git ') : 'git is not installed', 'install git');
  if (!gv.ok) return { ok: false, checks };

  // git-safe: a folder owned by another user (a root-owned mount in a container) is refused by every git command.
  let probe = gitProbe(root);
  const safeFix = `git config --global --add safe.directory ${q(root)}`;
  let safeFixed = false;
  if (probe.dubious && fix && allowGlobal) {
    const r = git(root, ['config', '--global', '--add', 'safe.directory', root]);
    probe = gitProbe(root);
    safeFixed = r.ok && !probe.dubious;
  }
  if (!probe.repo && !probe.dubious && fix) { git(root, ['init', '-q']); probe = gitProbe(root); }
  const safeOk = probe.repo && !probe.dubious;
  add('git-safe', safeOk,
    probe.dubious ? 'git refuses this folder: it is owned by another user (dubious ownership)'
      : probe.repo ? 'git can use this folder' : 'not a git repository yet',
    probe.dubious ? (allowGlobal ? safeFix : `${safeFix}   (changes your global git config)`) : 'git init', safeFixed);

  // git-identity: commits need an author; the fix is local to this repo.
  const has = (k) => git(root, ['config', k]).ok;
  let idOk = safeOk && has('user.name') && has('user.email');
  let idFixed = false;
  if (safeOk && !idOk && fix && name && email) {
    git(root, ['config', 'user.name', String(name)]);
    git(root, ['config', 'user.email', String(email)]);
    idOk = has('user.name') && has('user.email');
    idFixed = idOk;
  }
  add('git-identity', idOk,
    !safeOk ? 'cannot check until git can use this folder' : idOk ? `author ${git(root, ['config', 'user.name']).out} <${git(root, ['config', 'user.email']).out}>` : 'no git author name/email',
    `git config user.name ${q(name || 'Your Name')} && git config user.email ${q(email || 'you@example.com')}`, idFixed);

  // git-commit: tasks branch from a commit; a repo with none cannot start one.
  let headOk = safeOk && git(root, ['rev-parse', '--verify', '-q', 'HEAD']).ok;
  let commitFixed = false;
  let skipped = [];
  if (safeOk && idOk && !headOk && fix) {
    git(root, ['add', '-A', '--', '.']);
    skipped = git(root, ['diff', '--cached', '--name-only']).out.split('\n').filter((p) => p && SECRETISH.test(p));
    if (skipped.length) git(root, ['reset', '-q', '--', ...skipped]);
    const c = git(root, ['commit', '-q', '--allow-empty', '-m', 'chore: ghostship init']);
    headOk = c.ok && git(root, ['rev-parse', '--verify', '-q', 'HEAD']).ok;
    commitFixed = headOk;
  }
  add('git-commit', headOk,
    !safeOk ? 'cannot check until git can use this folder'
      : headOk ? `first commit ${git(root, ['rev-parse', '--short', 'HEAD']).out}${skipped.length ? ` (left out: ${skipped.join(', ')})` : ''}` : 'no commit yet, so no task can branch',
    'gs preflight --fix (commits the current files, never .env or keys)', commitFixed);

  // gh: only when issues and PRs go to GitHub.
  let trk = tracker;
  if (!trk) { try { trk = existsSync(join(root, '.ghostship', 'config.yaml')) ? loadConfig(root).tracker?.mode : null; } catch { trk = null; } }
  if (trk === 'github' || trk === 'both') {
    const ghPath = which('gh');
    const auth = ghPath ? run(root, 'gh', ['auth', 'status']) : { ok: false };
    add('gh', !!ghPath && auth.ok, !ghPath ? 'gh is not installed' : auth.ok ? 'gh signed in' : 'gh is not signed in', ghPath ? 'gh auth login' : 'install the GitHub CLI (gh), then gh auth login');
  }

  // herdr: information only; outside agents fall back to headless runs without it.
  const herdr = which('herdr');
  add('herdr', true, herdr ? 'herdr found: outside agents open in tabs' : 'herdr not found: outside agents run headless');

  return { ok: checks.every((c) => c.ok), checks };
}

/** One line for the init health table: all clear, or what fails and that init asks once to fix it. */
export function preflightSummary(pre) {
  if (!pre) return 'not run';
  const bad = pre.checks.filter((c) => !c.ok);
  if (!bad.length) return '✓ all clear';
  return `✗ ${bad.map((c) => c.detail).join(' · ')} — /ghostship init asks once to fix`;
}
