// Project memory (docs/11-memory/*.md) and the cross-project shared lessons (~/.ghostship/shared-lessons.md):
// dated one-line entries, appended by Ghostship and by agents through `gs memory add`, searched for every brief.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const KINDS = { memory: 'MEMORY', decision: 'DECISIONS', failed: 'FAILED-APPROACHES', lesson: 'LESSONS', baseline: 'BASELINES', skill: 'SKILL-CHANGES' };
const HEAD = {
  MEMORY: '# Memory\n\nWhat this project has learned about itself, newest last.\n',
  DECISIONS: '# Decisions\n\nChoices made during the build, with the reason.\n',
  'FAILED-APPROACHES': '# Failed approaches\n\nWhat was tried and did not work. Builders read this first.\n',
  LESSONS: '# Lessons\n\nShort, reusable lessons from building this project.\n',
  BASELINES: '# Baselines\n\nMeasured numbers to compare against, with the date measured.\n',
  'SKILL-CHANGES': '# Skill changes\n\nRules Ghostship learned from repeated failures, and whether each was kept or reverted.\n',
};
const STOP = new Set('the a an and or of to in on for with is are be was were it this that from by as at not no do does did into than then so if when what which who how its their our your'.split(' '));

export const memFile = (kind) => `docs/11-memory/${KINDS[kind] || kind}.md`;
const sharedFile = (home) => join(home || process.env.GHOSTSHIP_HOME || homedir(), '.ghostship', 'shared-lessons.md');

export function add(root, kind, text, { task = null, at = new Date() } = {}) {
  if (!KINDS[kind]) throw new Error(`kind is one of ${Object.keys(KINDS).join(', ')}`);
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('empty memory entry');
  const rel = memFile(kind);
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  if (!existsSync(p)) writeFileSync(p, HEAD[KINDS[kind]] + '\n');
  const line = `- ${at.toISOString().slice(0, 10)}${task ? ` [${task}]` : ''} ${clean}`;
  const cur = readFileSync(p, 'utf8');
  if (cur.split('\n').some((l) => l.slice(13) === line.slice(13))) return { path: rel, line, duplicate: true };
  appendFileSync(p, (cur.endsWith('\n') ? '' : '\n') + line + '\n');
  return { path: rel, line };
}

export const words = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

function entries(root, home) {
  const out = [];
  for (const [kind, f] of Object.entries(KINDS)) {
    const p = join(root, `docs/11-memory/${f}.md`);
    if (!existsSync(p)) continue;
    for (const l of readFileSync(p, 'utf8').split('\n')) if (/^- /.test(l)) out.push({ kind, line: l.slice(2) });
  }
  const sp = sharedFile(home);
  if (existsSync(sp)) for (const l of readFileSync(sp, 'utf8').split('\n')) if (/^- /.test(l)) out.push({ kind: 'shared', line: l.slice(2) });
  return out;
}

/** Lines that share the most words with the query; failed approaches and lessons weigh more. */
export function search(root, query, { limit = 12, home } = {}) {
  const q = new Set(words(query));
  if (!q.size) return [];
  const weight = { failed: 2, lesson: 1.5, shared: 1.5, decision: 1.2 };
  return entries(root, home)
    .map((e) => ({ ...e, score: words(e.line).filter((w) => q.has(w)).length * (weight[e.kind] || 1) }))
    .filter((e) => e.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function promote(root, text, { project = '', home } = {}) {
  const p = sharedFile(home);
  mkdirSync(dirname(p), { recursive: true });
  if (!existsSync(p)) writeFileSync(p, '# Shared lessons\n\nLessons that hold across projects.\n\n');
  const line = `- ${new Date().toISOString().slice(0, 10)}${project ? ` (${project})` : ''} ${String(text).replace(/\s+/g, ' ').trim()}`;
  appendFileSync(p, line + '\n');
  return { path: p, line };
}
