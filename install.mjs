#!/usr/bin/env node
// Installs Ghostship for this user: ~/.ghostship/{core/, projects.json, shared-lessons.md, secrets, bridge.key}, the /ghostship launcher skill, the ghostship-help skill and the Bridge mod.
// Touches nothing else. Re-running upgrades the core (by version, or by content when the version is unchanged) and keeps
// the previous one as core/.prev for rollback. The new core is copied to core.new first and swapped in only when the
// copy is whole, so a crash mid-copy never leaves a half core and never loses the one that was there.
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, renameSync, chmodSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const home = args.includes('--home') ? args[args.indexOf('--home') + 1] : homedir();
const force = args.includes('--force');
const gsHome = join(home, '.ghostship');
const skillDir = join(home, '.claude', 'skills', 'ghostship');
const version = readFileSync(join(here, 'core', 'VERSION'), 'utf8').trim();
const log = [];

/** sha256 over the sorted relative paths and contents of a tree: the same bytes give the same hash wherever they sit. */
function treeHash(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(dir, p).split(sep).join('/');
      if (rel === '.prev' || rel === '.hash' || rel.startsWith('.prev/')) continue;
      if (statSync(p).isDirectory()) walk(p); else files.push([rel, p]);
    }
  };
  walk(dir);
  const h = createHash('sha256');
  for (const [rel, p] of files) { h.update(rel); h.update('\0'); h.update(readFileSync(p)); h.update('\0'); }
  return h.digest('hex');
}

mkdirSync(gsHome, { recursive: true });
const core = join(gsHome, 'core');
const fresh = `${core}.new`;
const stale = `${core}.upgrading`; // what an older installer used mid-swap
rmSync(fresh, { recursive: true, force: true }); // a leftover from a crashed run
if (existsSync(stale) && !existsSync(join(core, 'VERSION'))) { renameSync(stale, core); log.push('restored the core an interrupted upgrade had set aside'); }
rmSync(stale, { recursive: true, force: true });

const prevVer = existsSync(join(core, 'VERSION')) ? readFileSync(join(core, 'VERSION'), 'utf8').trim() : null;
const srcHash = treeHash(join(here, 'core'));
const prevHash = (() => { try { return readFileSync(join(core, '.hash'), 'utf8').trim(); } catch { return null; } })();
const sameVersion = prevVer === version;
const sameContent = prevHash === srcHash;
if (force || !prevVer || !sameVersion || !sameContent) {
  // 1. copy beside the old core; 2. only then swap. The old core is untouched until the new one is whole.
  cpSync(join(here, 'core'), fresh, { recursive: true });
  writeFileSync(join(fresh, '.hash'), srcHash + '\n');
  if (prevVer) {
    rmSync(join(core, '.prev'), { recursive: true, force: true });
    renameSync(core, join(fresh, '.prev'));
  }
  renameSync(fresh, core);
  if (prevVer) log.push(`core ${prevVer} kept in ~/.ghostship/core/.prev for rollback`);
  log.push(`core ${version} → ~/.ghostship/core${sameVersion ? (force ? ' (forced)' : ' (same version, changed content)') : ''}`);
} else log.push(`core ${version} already installed (unchanged; --force to reinstall)`);

const seed = (name, text, mode) => {
  const p = join(gsHome, name);
  if (existsSync(p)) return;
  writeFileSync(p, text, mode ? { mode } : undefined); // created owner-only, never readable in between
  if (mode) try { chmodSync(p, mode); } catch { /* Windows */ }
  log.push(`created ~/.ghostship/${name}`);
};
seed('projects.json', JSON.stringify({ projects: [] }, null, 2) + '\n');
seed('shared-lessons.md', '# Shared lessons\n\nLessons that hold across projects. Ghostship reads this when briefing agents.\n');
seed('secrets', '# KEY=value, one per line. Owner-only. Never committed, always redacted from evidence.\n', 0o600);
// The Bridge owner key: lets a press in the Bridge pane approve when a project sets approvals.mode: bridge. Agents never read it.
seed('bridge.key', randomBytes(32).toString('hex') + '\n', 0o600);

mkdirSync(skillDir, { recursive: true });
copyFileSync(join(here, 'launcher', 'SKILL.md'), join(skillDir, 'SKILL.md'));
log.push('launcher skill → ~/.claude/skills/ghostship/SKILL.md');

// ghostship-help: a self-contained global skill that explains every /ghostship command. Cheap; reads nothing.
const helpDir = join(home, '.claude', 'skills', 'ghostship-help');
mkdirSync(helpDir, { recursive: true });
copyFileSync(join(here, 'core', 'help', 'SKILL.md'), join(helpDir, 'SKILL.md'));
log.push('help skill → ~/.claude/skills/ghostship-help/SKILL.md');

// Bridge mod: Claude Code loads plugins from the user's skills folder. It stays inert outside Ghostship projects.
const modDir = join(home, '.claude', 'skills', 'ghostship-bridge');
rmSync(modDir, { recursive: true, force: true });
cpSync(join(here, 'core', 'mod', 'ghostship-bridge'), modDir, { recursive: true, filter: (p) => !/[\\/](tests|node_modules)([\\/]|$)|[\\/]\.claude-plugin[\\/]types/.test(p) });
log.push('Bridge mod → ~/.claude/skills/ghostship-bridge (active only in Ghostship projects)');

process.stdout.write(log.map((l) => `• ${l}`).join('\n') + '\n\nIn a project folder, start Claude Code and type: /ghostship init\n');
