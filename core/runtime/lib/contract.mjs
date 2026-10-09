// ACCEPTANCE-CHECKS.md parser and deterministic linter.
const KINDS = new Set(['run', 'pick']);

function sections(md) {
  const out = { _preamble: [] };
  let cur = '_preamble';
  for (const line of String(md).split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { cur = h[1].toLowerCase(); out[cur] = []; continue; }
    out[cur].push(line);
  }
  return out;
}
const find = (secs, ...names) => { const k = Object.keys(secs).find((x) => names.some((n) => x.startsWith(n))); return k ? secs[k] : null; };
const cells = (line) => { const p = line.split('|').map((s) => s.trim()); return p.slice(1, p.length - 1); };
const nonEmpty = (lines) => (lines || []).map((l) => l.trim()).filter((l) => l && !l.startsWith('<!--'));

export function parseContract(md) {
  const secs = sections(md);
  const checks = [];
  for (const line of find(secs, 'checks', 'bar') || []) {
    if (!line.trim().startsWith('|')) continue;
    const c = cells(line);
    if (!c.length || c[0] === '#' || /^:?-{2,}/.test(c[0])) continue;
    const [id, text, kind, provenBy, reference, source] = c;
    checks.push({ id, text: text || '', kind: (kind || '').toLowerCase(), provenBy: provenBy || '', reference: reference || '', source: source || '' });
  }
  const unknownLines = find(secs, 'unknowns');
  const unknowns = nonEmpty(unknownLines).filter((l) => /\bU\d+\b/.test(l)).map((l) => {
    const m = /\b(U\d+)\s*[:—-]\s*(.*)$/.exec(l) || [];
    const rest = m[2] || '';
    const owner = /owner:\s*([^,]+)/i.exec(rest)?.[1]?.trim() || '';
    const by = /by:\s*(\d{4}-\d{2}-\d{2})/i.exec(rest)?.[1] || '';
    const blocks = (/blocks:\s*([C\d,\s]+)/i.exec(rest)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const text = rest.split(/\s+—\s+owner:|,\s*owner:|owner:/i)[0].trim();
    return { id: m[1], text, owner, by, blocks };
  });
  return {
    destination: nonEmpty(find(secs, 'destination')).join(' '),
    checks,
    outOfScope: nonEmpty(find(secs, 'out of scope')).filter((l) => /^(\d+[.)]|[-*])\s+\S/.test(l)),
    unknowns,
    hasUnknowns: unknownLines !== null,
    noneIdentified: nonEmpty(unknownLines).some((l) => /^none identified\b/i.test(l)),
  };
}

export function lintContract(md) {
  const c = parseContract(md);
  const errors = [];
  if (!c.destination) errors.push('Destination: missing or empty');
  if (!c.checks.length) errors.push('Checks: no checks found (table | C1 | check | kind | proven by | reference | source |)');
  const seen = new Set();
  for (const k of c.checks) {
    if (!/^C\d+$/.test(k.id)) errors.push(`${k.id || '(blank)'}: id must look like C1, C2 …`);
    if (seen.has(k.id)) errors.push(`${k.id}: duplicate id`);
    seen.add(k.id);
    if (!k.text) errors.push(`${k.id}: empty check`);
    if (/\band\b/i.test(k.text)) errors.push(`${k.id}: one outcome per check — split it on "and"`);
    if (!KINDS.has(k.kind)) errors.push(`${k.id}: kind must be "run" or "pick" (got "${k.kind}")`);
    if (!k.provenBy || k.provenBy === '-') errors.push(`${k.id}: "proven by" is empty`);
    if (k.kind === 'pick' && (!k.reference || k.reference === '-')) errors.push(`${k.id}: pick checks need a reference to compare against`);
    if (!k.source || k.source === '-') errors.push(`${k.id}: "source" must point at the requirement it came from (e.g. PRD#login)`);
  }
  if (!c.outOfScope.length) errors.push('Out of scope: needs at least one numbered item');
  if (!c.hasUnknowns) errors.push('Unknowns: section missing');
  else if (!c.unknowns.length && !c.noneIdentified) errors.push('Unknowns: list U1, U2 … or write "None identified — <why>"');
  for (const u of c.unknowns) {
    if (!u.owner) errors.push(`${u.id}: needs "owner: <who decides>"`);
    if (!u.by) errors.push(`${u.id}: needs "by: YYYY-MM-DD" date`);
    for (const b of u.blocks) if (!seen.has(b)) errors.push(`${u.id}: blocks unknown check ${b}`);
  }
  return { ok: errors.length === 0, errors, contract: c };
}
