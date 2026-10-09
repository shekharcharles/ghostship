// Applies the migration plan init wrote for an existing project: other tools' files are moved to
// docs/archive/<tool>/ (never deleted), kept files stay, "ask" items are settled by the owner one by one.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { load, mutate, fail } from './store.mjs';
import { loadConfig } from './config.mjs';
import { humanGate } from './engine.mjs';
import { tryGit, gitRun, hasIdentity } from './git.mjs';
import { slugify } from './tasks.mjs';

export function list(root) {
  return (load(root).migration || []).map((m, i) => ({ n: i + 1, ...m }));
}

function move(root, from, to) {
  mkdirSync(dirname(join(root, to)), { recursive: true });
  const tracked = tryGit(root, ['ls-files', '--error-unmatch', '--', from]).ok;
  if (tracked) { const r = tryGit(root, ['mv', '--', from, to]); if (r.ok) return; }
  renameSync(join(root, from), join(root, to));
}

/** which: 'all' or a list of item numbers. 'ask' items need decision 'keep' | 'archive' for each. */
export function apply(root, { which = 'all', decisions = {}, ...gate } = {}) {
  const items = list(root);
  const pick = which === 'all' ? items : items.filter((m) => which.includes(m.n));
  if (!pick.length) fail('NOTHING_TO_DO', 'No migration items selected.');
  const g = humanGate(loadConfig(root), gate);
  const done = [];
  for (const m of pick) {
    if (m.status && m.status !== 'planned') continue;
    let action = m.action;
    if (action === 'ask') action = decisions[m.n];
    if (!action || action === 'ask') { done.push({ n: m.n, status: 'planned', note: 'needs your decision: keep or archive' }); continue; }
    if (action === 'keep') { done.push({ n: m.n, status: 'kept' }); continue; }
    if (!existsSync(join(root, m.path))) { done.push({ n: m.n, status: 'gone' }); continue; }
    const to = `docs/archive/${slugify(m.tool)}/${m.path.replace(/^\.+/, '')}`;
    move(root, m.path, to);
    done.push({ n: m.n, status: 'archived', to });
  }
  mutate(root, 'migration.apply', null, { done, gate: g }, (s) => {
    for (const d of done) if (s.migration?.[d.n - 1]) s.migration[d.n - 1] = { ...s.migration[d.n - 1], status: d.status, ...(d.to ? { to: d.to } : {}) };
  });
  if (hasIdentity(root) && done.some((d) => d.status === 'archived')) {
    tryGit(root, ['add', '-A', '--', 'docs/archive', '.ghostship/state']);
    const tools = [...new Set(pick.filter((m) => done.find((d) => d.n === m.n)?.status === 'archived').map((m) => m.tool))];
    if (!tryGit(root, ['diff', '--cached', '--quiet']).ok) gitRun(root, ['commit', '-q', '--no-verify', '-m', `chore: migrate ${tools.join(', ')} into ghostship (archived, nothing deleted)`]);
  }
  return done;
}
