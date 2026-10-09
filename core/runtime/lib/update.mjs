// `gs update`: update Ghostship ITSELF from its public GitHub repo. (Distinct from `gs upgrade`, which moves one
// project's pinned core to the already-installed one.) The repo is the published package — install.mjs + core/ +
// launcher/. We ask GitHub for its VERSION without cloning (update check), and on apply we clone it shallow and run
// its install.mjs, which swaps ~/.ghostship/core safely (content/version, one rollback copy) and refreshes the skills.
// Each project then adopts the newly installed core at a safe point with `gs upgrade apply`.
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { cmpVersion } from './upgrade.mjs';

// owner/name by default; override with GHOSTSHIP_REPO (owner/name, a full https URL, or a local path) and GHOSTSHIP_BRANCH.
export const REPO = process.env.GHOSTSHIP_REPO || 'shekharcharles/ghostship';
export const BRANCH = process.env.GHOSTSHIP_BRANCH || 'main';

const isSlug = (s) => /^[\w.-]+\/[\w.-]+$/.test(s) && !s.startsWith('/') && !s.startsWith('.');
const rawVersionUrl = (slug, branch) => `https://raw.githubusercontent.com/${slug}/${branch}/core/VERSION`;
const cloneUrl = (slug) => (isSlug(slug) ? `https://github.com/${slug}.git` : slug);

const home = (h) => h || process.env.GHOSTSHIP_HOME || homedir();
const installedVersion = (h) => { try { return readFileSync(join(home(h), '.ghostship/core/VERSION'), 'utf8').trim(); } catch { return null; } };

/** Ask GitHub for the published VERSION without cloning. Returns {installed, remote, newer} or {installed, error}. */
export async function check({ home: h, repo = REPO, branch = BRANCH, fetchImpl = globalThis.fetch } = {}) {
  const installed = installedVersion(h);
  if (!isSlug(repo)) return { installed, error: `update check needs an owner/name repo on GitHub; got "${repo}". Run \`gs update\` to install from it directly.` };
  let remote;
  try {
    const res = await fetchImpl(rawVersionUrl(repo, branch), { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) return { installed, error: `GitHub returned ${res.status} for ${repo}@${branch}` };
    remote = (await res.text()).trim();
  } catch (e) { return { installed, error: `could not reach GitHub: ${e.message}` }; }
  if (!/^\d+\.\d+\.\d+$/.test(remote)) return { installed, error: `unexpected VERSION from GitHub: "${remote.slice(0, 40)}"` };
  return { installed, remote, newer: cmpVersion(remote, installed || '0') > 0, repo, branch };
}

/** Clone the repo and run its install.mjs. Returns {ok, from, to} or {ok:false, reason}. Writes install.mjs's own log to stdout. */
export function apply({ home: h, repo = REPO, branch = BRANCH, force = false, runNode = defaultRunNode, runGit = defaultRunGit } = {}) {
  const from = installedVersion(h);
  const tmp = mkdtempSync(join(tmpdir(), 'gs-update-'));
  try {
    const clone = runGit(['clone', '--depth', '1', '--branch', branch, cloneUrl(repo), tmp]);
    if (clone.status !== 0) return { ok: false, reason: `git clone failed (${repo}@${branch}): ${(clone.stderr || clone.stdout || '').trim().slice(0, 300)}` };
    const installer = join(tmp, 'install.mjs');
    if (!existsSync(installer)) return { ok: false, reason: `the repo has no install.mjs at its root (${repo}@${branch})` };
    const args = [installer, '--home', home(h)];
    if (force) args.push('--force');
    const inst = runNode(args);
    if (inst.stdout) process.stdout.write(inst.stdout);
    if (inst.status !== 0) return { ok: false, reason: `install.mjs failed: ${(inst.stderr || inst.stdout || '').trim().slice(0, 300)}` };
    return { ok: true, from, to: installedVersion(h), repo, branch };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

function defaultRunGit(args) { return spawnSync('git', args, { encoding: 'utf8' }); }
function defaultRunNode(args) { return spawnSync(process.execPath, args, { encoding: 'utf8' }); }
