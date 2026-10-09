// Task files: tasks/T###-slug.md. Front matter (YAML subset) + Markdown sections.
// The CLI renders managed fields (status, attempts, branch, notes, history); humans and agents read them.
import { parseYaml, stringifyYaml } from './yaml.mjs';

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

export function parseTaskFile(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text));
  if (!m) throw new Error('task file needs YAML front matter between --- lines');
  const meta = parseYaml(m[1]) || {};
  if (!meta.id) throw new Error('task front matter needs an id');
  const sections = {};
  let cur = null;
  for (const line of m[2].split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { cur = h[1]; sections[cur] = []; continue; }
    if (cur) sections[cur].push(line);
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].join('\n').trim();
  return { meta, sections };
}

const MANAGED_ORDER = ['id', 'title', 'phase', 'kind', 'scope', 'status', 'tier', 'risk', 'checks', 'requirement', 'blockedBy',
  'allowedPaths', 'testCommand', 'noTdd', 'finding', 'skeleton', 'setup', 'attempts', 'restarts', 'branch'];

export function renderTaskFile(meta, sections = {}, { judgeNotes = [], history = [] } = {}) {
  const m = { ...meta };
  if (m.attempt !== undefined || m.maxAttempts !== undefined) m.attempts = `${m.attempt ?? 0}/${m.maxAttempts ?? 3}`;
  delete m.attempt; delete m.maxAttempts;
  const ordered = {};
  for (const k of MANAGED_ORDER) if (m[k] !== undefined && m[k] !== null) ordered[k] = m[k];
  for (const k of Object.keys(m)) if (!(k in ordered) && m[k] !== undefined && m[k] !== null) ordered[k] = m[k];
  const body = [];
  for (const name of ['Goal', 'Checks served', 'Context']) {
    if (sections[name]) body.push(`## ${name}\n${sections[name]}`);
  }
  for (const [name, text] of Object.entries(sections)) {
    if (['Goal', 'Checks served', 'Context', 'Done when', 'Judge notes', 'History'].includes(name)) continue;
    body.push(`## ${name}\n${text}`);
  }
  body.push(['## Done when',
    '- [ ] acceptance tests for its checks pass',
    '- [ ] red → green → refactor evidence recorded',
    '- [ ] code-health gates pass',
    '- [ ] docs updated (file purpose headers, CODEMAP, API spec, handbook section)'].join('\n'));
  body.push(`## Judge notes\n${judgeNotes.length ? judgeNotes.map((n) => `- ${n}`).join('\n') : '_none yet_'}`);
  body.push(`## History\n${history.length ? history.map((n) => `- ${n}`).join('\n') : '_none yet_'}`);
  return `---\n${stringifyYaml(ordered)}\n---\n\n${body.join('\n\n')}\n`;
}
