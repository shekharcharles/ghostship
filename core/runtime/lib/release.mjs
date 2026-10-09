// Versioning and changelog from conventional commits. Pure functions, zero tokens.

const RE = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

export function parseCommit(msg) {
  const m = RE.exec(String(msg).split('\n')[0].trim());
  if (!m) return { type: 'other', scope: null, breaking: /BREAKING CHANGE/.test(msg), subject: String(msg).split('\n')[0] };
  return { type: m[1], scope: m[2] || null, breaking: !!m[3] || /BREAKING CHANGE/.test(msg), subject: m[4] };
}

export function nextVersion(prev, messages) {
  const [maj, min, pat] = (prev || '0.0.0').split('.').map(Number);
  const cs = messages.map(parseCommit);
  const breaking = cs.some((c) => c.breaking);
  const feat = cs.some((c) => c.type === 'feat');
  if (!prev) return feat || breaking ? '0.1.0' : '0.0.1';
  if (breaking) return maj === 0 ? `0.${min + 1}.0` : `${maj + 1}.0.0`;
  if (feat) return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

const GROUPS = [['feat', 'Features'], ['fix', 'Fixes'], ['perf', 'Performance'], ['refactor', 'Refactoring'], ['docs', 'Documentation'], ['test', 'Tests']];

export function changelogSection(version, date, messages) {
  const cs = messages.map(parseCommit).filter((c) => c.scope !== 'ghostship');
  const out = [`## ${version} — ${date}`];
  for (const [type, title] of GROUPS) {
    const items = cs.filter((c) => c.type === type);
    if (!items.length) continue;
    out.push('', `### ${title}`, ...items.map((c) => `- ${c.scope ? `**${c.scope}**: ` : ''}${c.subject}${c.breaking ? ' ⚠ BREAKING' : ''}`));
  }
  return out.join('\n') + '\n';
}

export function conventionalMessage(task) {
  const scope = task.scope || (task.allowedPaths?.[0] || '').replace(/^(src|lib|app|apps|packages)\//, '').split(/[/*]/)[0].replace(/\.\w+$/, '') || null;
  const subject = String(task.title || task.id).replace(/^\w/, (c) => c.toLowerCase());
  const refs = [task.id, (task.checks || []).join(' ')].filter(Boolean).join(', ');
  return `${task.kind || 'feat'}${scope ? `(${scope})` : ''}: ${subject} (${refs})`;
}
