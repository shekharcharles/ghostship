// Interactive code explorer: indexes the repository (files, purposes, symbols, imports) with small per-language
// parsers and writes one offline HTML file to browse it — tree, search, source with symbol jumps, dependency map.
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { tryGit } from './git.mjs';
import { purposeOf } from './codemap.mjs';

const LANG = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', py: 'py', go: 'go', rs: 'rs', java: 'java', kt: 'kt',
  cs: 'cs', rb: 'rb', php: 'php', swift: 'swift', sh: 'sh', bash: 'sh', ps1: 'ps1', sql: 'sql', vue: 'js', svelte: 'js', css: 'css', scss: 'css',
  html: 'html', md: 'md', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
};
const SKIP = /(^|\/)(node_modules|dist|build|coverage|\.git|\.ghostship|docs-site|vendor|\.next|target|__pycache__|\.venv)(\/|$)|\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|mp3|lock|min\.js|map|wasm|bin|exe|dll|so|dylib)$/i;
const MAX_FILE = 400 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;

const SYMBOLS = {
  js: [[/^\s*export\s+(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, 'function'], [/^\s*(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'], [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, 'function'],
    [/^\s*(?:export\s+)?(?:const|let)\s+([A-Z][A-Z0-9_]+)\s*=/, 'const']],
  py: [[/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'function'], [/^\s*class\s+([A-Za-z_]\w*)/, 'class']],
  go: [[/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'function'], [/^type\s+([A-Za-z_]\w*)\s+(struct|interface)/, 'type']],
  rs: [[/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, 'function'], [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, 'type'], [/^\s*impl(?:<[^>]*>)?\s+([A-Za-z_][\w:]*)/, 'impl']],
  java: [[/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, 'class'], [/^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\],\s]+\s+([a-zA-Z_]\w*)\s*\(/, 'method']],
  cs: [[/^\s*(?:public|private|protected|internal)?\s*(?:static\s+|sealed\s+|abstract\s+|partial\s+)*(?:class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/, 'class'], [/^\s*(?:public|private|protected|internal)\s+(?:static\s+|async\s+|override\s+|virtual\s+)*[\w<>\[\],?\s]+\s+([A-Z]\w*)\s*\(/, 'method']],
  rb: [[/^\s*def\s+([\w.?!]+)/, 'method'], [/^\s*(?:class|module)\s+([A-Z][\w:]*)/, 'class']],
  php: [[/^\s*(?:public|private|protected)?\s*(?:static\s+)?function\s+([A-Za-z_]\w*)/, 'function'], [/^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, 'class']],
  sh: [[/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/, 'function']],
  sql: [[/^\s*create\s+(?:or\s+replace\s+)?(table|view|function|procedure|index)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i, 'sql']],
  kt: [[/^\s*(?:fun)\s+([A-Za-z_]\w*)/, 'function'], [/^\s*(?:data\s+)?class\s+([A-Za-z_]\w*)/, 'class']],
  swift: [[/^\s*func\s+([A-Za-z_]\w*)/, 'function'], [/^\s*(?:class|struct|enum|protocol)\s+([A-Za-z_]\w*)/, 'type']],
};
SYMBOLS.ts = [...SYMBOLS.js, [/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, 'type']];

const IMPORTS = {
  js: [/\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g],
  py: [/^\s*from\s+([.\w]+)\s+import/gm, /^\s*import\s+([.\w]+)/gm],
  go: [/^\s*"([\w./-]+)"\s*$/gm, /^import\s+"([\w./-]+)"/gm],
  rs: [/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm, /^\s*use\s+crate::([\w:]+)/gm],
};
IMPORTS.ts = IMPORTS.js;

function listFiles(root) {
  const r = tryGit(root, ['ls-files', '-co', '--exclude-standard']);
  if (r.ok && r.out) return r.out.split('\n').filter(Boolean);
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP.test(p)) continue;
      if (e.isDirectory()) walk(p); else if (e.isFile()) out.push(p);
    }
  };
  try { walk(''); } catch { /* unreadable */ }
  return out;
}

function resolveImport(from, spec, set, lang) {
  if (lang === 'js' || lang === 'ts') {
    if (!spec.startsWith('.')) return null;
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    for (const c of [base, ...['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts'].map((x) => base + x), ...['index.js', 'index.ts', 'index.mjs', 'index.tsx'].map((x) => `${base}/${x}`)]) if (set.has(c)) return c;
    return null;
  }
  if (lang === 'py') {
    const dots = /^\.+/.exec(spec)?.[0].length || 0;
    const rest = spec.slice(dots).replace(/\./g, '/');
    const dir = dots ? posix.join(posix.dirname(from), ...Array(dots - 1).fill('..')) : '';
    for (const c of [posix.join(dir, `${rest}.py`), posix.join(dir, rest, '__init__.py')]) if (set.has(c)) return c;
    return null;
  }
  if (lang === 'rs') {
    const c = posix.join(posix.dirname(from), `${spec.split('::')[0]}.rs`);
    return set.has(c) ? c : null;
  }
  return null;
}

export function indexRepo(root) {
  const files = [];
  let total = 0;
  const paths = listFiles(root).filter((p) => !SKIP.test(p));
  const set = new Set(paths);
  for (const p of paths) {
    let st;
    try { st = statSync(join(root, p)); } catch { continue; }
    if (!st.isFile() || st.size > MAX_FILE || total + st.size > MAX_TOTAL) { files.push({ path: p, lang: 'skip', size: st?.size || 0, lines: 0, skipped: true }); continue; }
    const text = readFileSync(join(root, p), 'utf8');
    if (text.includes('\u0000')) continue;
    total += st.size;
    const ext = (/\.([\w]+)$/.exec(p)?.[1] || '').toLowerCase();
    const lang = LANG[ext] || 'text';
    const lines = text.split(/\r?\n/);
    const symbols = [];
    for (const [re, kind] of SYMBOLS[lang] || []) {
      lines.forEach((l, i) => { const m = re.exec(l); if (m) symbols.push({ name: m[m.length - 1] && kind === 'sql' ? m[2] : m[1], kind: kind === 'sql' ? m[1].toLowerCase() : kind, line: i + 1 }); });
    }
    const seen = new Set();
    const syms = symbols.sort((a, b) => a.line - b.line).filter((s) => { const k = `${s.name}:${s.line}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const imports = [];
    for (const re of IMPORTS[lang] || []) for (const m of text.matchAll(new RegExp(re.source, re.flags))) imports.push(m[1]);
    const resolved = [...new Set(imports.map((s) => resolveImport(p, s, set, lang)).filter(Boolean))];
    const external = [...new Set(imports.filter((s) => !resolveImport(p, s, set, lang) && !s.startsWith('.')))].slice(0, 40);
    const purpose = purposeOf(p, text);
    files.push({ path: p, lang, size: st.size, lines: lines.length, purpose: purpose === undefined ? null : purpose, missingPurpose: purpose === null, symbols: syms, imports: resolved, external, text });
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const f of files) f.importedBy = [];
  for (const f of files) for (const t of f.imports || []) byPath.get(t)?.importedBy.push(f.path);
  return { files, stats: { files: files.length, lines: files.reduce((a, f) => a + f.lines, 0), symbols: files.reduce((a, f) => a + (f.symbols?.length || 0), 0), languages: [...new Set(files.map((f) => f.lang))].filter((l) => !['skip', 'text'].includes(l)) } };
}

export function explorerHtml(index, { title = 'Code explorer', version = '' } = {}) {
  const data = JSON.stringify(index).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title.replace(/</g, '&lt;')}</title>
<style>
:root{--bg:#fbfaf8;--panel:#fff;--ink:#1d1f23;--sub:#626873;--line:#e6e3dd;--acc:#2f5d8a;--hl:#fff4c2;--kw:#8a3ab9;--str:#1f7a4d;--com:#8a8f98;--num:#b5520f;--chip:#eef1f5;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--panel:#1a1d21;--ink:#e6e8eb;--sub:#9aa1ab;--line:#2a2e34;--acc:#7fb0e0;--hl:#3a3420;--kw:#c792ea;--str:#8fd19e;--com:#6b7280;--num:#f2a65a;--chip:#232830}}
*{box-sizing:border-box}body{margin:0;height:100vh;display:grid;grid-template-rows:auto 1fr;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel)}header b{font-size:15px}header .s{color:var(--sub);font-size:12px}
#q{flex:1;max-width:520px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);font:inherit}
.grid{display:grid;grid-template-columns:290px 1fr 260px;min-height:0}
nav,aside{overflow:auto;border-right:1px solid var(--line);background:var(--panel);padding:6px 0}aside{border-right:0;border-left:1px solid var(--line);padding:10px 12px}
.dir>summary{cursor:pointer;padding:2px 10px;color:var(--sub);list-style:none}.dir>summary::before{content:'▸ ';}.dir[open]>summary::before{content:'▾ ';}
.dir .dir{margin-left:12px}.f{display:block;padding:2px 10px 2px 22px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.f:hover,.f.on{background:var(--chip)}.f .w{color:#b26b00}
main{overflow:auto;min-width:0}.head{padding:14px 18px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0}
.head h2{margin:0;font:600 15px var(--mono)}.head p{margin:4px 0 0;color:var(--sub)}.chips{margin-top:6px}.chip{display:inline-block;background:var(--chip);border-radius:10px;padding:1px 8px;margin:2px 4px 2px 0;font-size:12px;cursor:pointer}
pre{margin:0;font:12.5px/1.55 var(--mono);counter-reset:l}pre .ln{display:block;padding:0 18px 0 0;white-space:pre}pre .ln::before{counter-increment:l;content:counter(l);display:inline-block;width:52px;margin-right:14px;text-align:right;color:var(--sub);user-select:none}
pre .ln.hit{background:var(--hl)}.k{color:var(--kw)}.st{color:var(--str)}.c{color:var(--com);font-style:italic}.n{color:var(--num)}
aside h4{margin:12px 0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--sub)}aside a{display:block;color:var(--ink);text-decoration:none;padding:1px 0;font:12.5px var(--mono);cursor:pointer}aside a:hover{color:var(--acc)}aside .kind{color:var(--sub);font-size:11px;margin-left:6px}
#res{position:absolute;top:46px;left:16px;right:16px;max-width:640px;max-height:60vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.15);display:none;z-index:9}#res div{padding:6px 10px;cursor:pointer;border-bottom:1px solid var(--line)}#res div:hover{background:var(--chip)}#res small{color:var(--sub);margin-left:8px}
svg text{font:11px var(--mono);fill:var(--ink)}svg .lbl{fill:var(--sub);font:600 10px system-ui;letter-spacing:.06em;text-transform:uppercase}svg .node{fill:var(--chip);stroke:var(--line)}svg .me{fill:var(--acc)}svg .me+text{fill:#fff}svg line{stroke:var(--sub);stroke-opacity:.5}
.empty{padding:40px;color:var(--sub)}
@media (max-width:900px){.grid{grid-template-columns:1fr}nav{max-height:30vh;border-right:0;border-bottom:1px solid var(--line)}aside{display:none}}
</style></head><body>
<header><b>${title.replace(/</g, '&lt;')}</b><span class="s" id="stats"></span><input id="q" placeholder="Search files and symbols…" autocomplete="off"></header>
<div id="res"></div>
<div class="grid"><nav id="tree"></nav><main id="main"><div class="empty">Pick a file, or search.</div></main><aside id="side"></aside></div>
<script type="application/json" id="data">${data}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const F = new Map(D.files.map((f) => [f.path, f]));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
document.getElementById('stats').textContent = D.stats.files + ' files · ' + D.stats.lines.toLocaleString() + ' lines · ' + D.stats.symbols + ' symbols · ' + D.stats.languages.join(', ') + ${JSON.stringify(version ? ` · ${version}` : '')};
function tree() {
  const root = {};
  for (const f of D.files) { let n = root; const parts = f.path.split('/'); parts.slice(0, -1).forEach((d) => { n = n[d + '/'] = n[d + '/'] || {}; }); n[parts.at(-1)] = f; }
  const walk = (n, depth) => Object.entries(n).sort(([a, x], [b, y]) => ((a.endsWith('/') ? 0 : 1) - (b.endsWith('/') ? 0 : 1)) || a.localeCompare(b)).map(([k, v]) => k.endsWith('/')
    ? '<details class="dir"' + (depth < 1 ? ' open' : '') + '><summary>' + esc(k) + '</summary>' + walk(v, depth + 1) + '</details>'
    : '<span class="f" data-p="' + esc(v.path) + '" title="' + esc(v.purpose || (v.skipped ? 'too large to index' : '')) + '">' + esc(k) + (v.missingPurpose ? ' <span class="w" title="no purpose header">⚠</span>' : '') + '</span>').join('');
  document.getElementById('tree').innerHTML = walk(root, 0);
  document.querySelectorAll('.f').forEach((el) => el.onclick = () => open(el.dataset.p));
}
const KW = /\\b(import|from|export|default|function|return|const|let|var|if|else|for|while|class|new|async|await|try|catch|throw|def|self|None|True|False|func|package|type|struct|interface|fn|pub|impl|use|mod|public|private|protected|static|void|null|true|false|this|yield|in|of|switch|case|break|continue|enum|extends|implements|lambda|with|as|elif|pass|raise|not|and|or)\\b/g;
function hl(line, lang) {
  if (['md', 'text', 'json', 'yaml', 'skip', 'toml', 'html', 'css'].includes(lang)) return esc(line);
  const hash = ['py', 'sh', 'rb', 'ps1'].includes(lang);
  let q = null, cut = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '\`') { q = c; continue; }
    if (hash ? c === '#' : (c === '/' && line[i + 1] === '/')) { cut = i; break; }
  }
  const code = cut < 0 ? line : line.slice(0, cut);
  const com = cut < 0 ? '' : '<span class="c">' + esc(line.slice(cut)) + '</span>';
  const parts = code.split(/("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`[^\`]*\`)/g);
  return parts.map((p, i) => i % 2 ? '<span class="st">' + esc(p) + '</span>' : esc(p).replace(KW, '<span class="k">$1</span>').replace(/\\b(\\d+(?:\\.\\d+)?)\\b/g, '<span class="n">$1</span>')).join('') + com;
}
function graph(f) {
  const ins = f.importedBy.slice(0, 10), outs = f.imports.slice(0, 10), W = 236, step = 24;
  const box = (y, t, cls) => '<g data-p="' + esc(t) + '" style="cursor:pointer"><rect class="' + cls + '" x="8" y="' + y + '" width="' + (W - 16) + '" height="20" rx="4"></rect><text x="' + (W / 2) + '" y="' + (y + 14) + '" text-anchor="middle">' + esc(t.length > 34 ? '…' + t.slice(-33) : t) + '</text></g>';
  let y = 4, s = '';
  if (ins.length) { s += '<text x="8" y="' + (y + 10) + '" class="lbl">used by</text>'; y += 16; ins.forEach((p) => { s += box(y, p, 'node'); y += step; }); s += '<line x1="' + W / 2 + '" y1="' + (y - 2) + '" x2="' + W / 2 + '" y2="' + (y + 8) + '"></line>'; y += 10; }
  s += box(y, f.path, 'me'); y += step;
  if (outs.length) { s += '<line x1="' + W / 2 + '" y1="' + (y - 4) + '" x2="' + W / 2 + '" y2="' + (y + 6) + '"></line>'; y += 8; s += '<text x="8" y="' + (y + 10) + '" class="lbl">imports</text>'; y += 16; outs.forEach((p) => { s += box(y, p, 'node'); y += step; }); }
  return '<svg viewBox="0 0 ' + W + ' ' + (y + 4) + '" width="' + W + '">' + s + '</svg>';
}
function open(path, line) {
  const f = F.get(path); if (!f) return;
  document.querySelectorAll('.f').forEach((el) => el.classList.toggle('on', el.dataset.p === path));
  const chips = (list, label) => list.length ? '<div class="chips"><span class="s" style="color:var(--sub)">' + label + ':</span> ' + list.map((p) => '<span class="chip" data-p="' + esc(p) + '">' + esc(p) + '</span>').join('') + '</div>' : '';
  const head = '<div class="head"><h2>' + esc(f.path) + '</h2><p>' + (f.purpose ? esc(f.purpose) : f.missingPurpose ? '⚠ no purpose header' : '') + ' · ' + f.lines + ' lines · ' + esc(f.lang) + '</p>' + chips(f.imports || [], 'imports') + chips(f.importedBy || [], 'used by') + (f.external && f.external.length ? '<div class="chips"><span style="color:var(--sub)">packages:</span> ' + f.external.map((x) => '<span class="chip">' + esc(x) + '</span>').join('') + '</div>' : '') + '</div>';
  const body = f.skipped ? '<div class="empty">Not indexed (too large or binary).</div>' : '<pre>' + f.text.split(/\\r?\\n/).map((l, i) => '<span class="ln' + (line === i + 1 ? ' hit' : '') + '" id="L' + (i + 1) + '">' + hl(l, f.lang) + '</span>').join('') + '</pre>';
  document.getElementById('main').innerHTML = head + body;
  document.querySelectorAll('.chip[data-p]').forEach((el) => el.onclick = () => open(el.dataset.p));
  const side = '<h4>Symbols</h4>' + ((f.symbols || []).map((s) => '<a data-l="' + s.line + '">' + esc(s.name) + '<span class="kind">' + esc(s.kind) + ' · ' + s.line + '</span></a>').join('') || '<span style="color:var(--sub)">none</span>') + ((f.imports || []).length + (f.importedBy || []).length ? '<h4>Dependencies</h4>' + graph(f) : '');
  document.getElementById('side').innerHTML = side;
  document.querySelectorAll('aside a[data-l]').forEach((el) => el.onclick = () => open(path, Number(el.dataset.l)));
  document.querySelectorAll('aside g[data-p]').forEach((el) => el.onclick = () => open(el.dataset.p));
  if (line) document.getElementById('L' + line)?.scrollIntoView({ block: 'center' }); else document.getElementById('main').scrollTop = 0;
  history.replaceState(null, '', '#' + encodeURIComponent(path) + (line ? ':' + line : ''));
}
const q = document.getElementById('q'), res = document.getElementById('res');
q.oninput = () => {
  const t = q.value.trim().toLowerCase(); if (!t) { res.style.display = 'none'; return; }
  const hits = [];
  for (const f of D.files) {
    if (f.path.toLowerCase().includes(t)) hits.push({ p: f.path, label: f.path, sub: f.purpose || '' });
    for (const s of f.symbols || []) if (s.name.toLowerCase().includes(t)) hits.push({ p: f.path, l: s.line, label: s.name, sub: s.kind + ' · ' + f.path + ':' + s.line });
    if (hits.length > 80) break;
  }
  res.innerHTML = hits.map((h, i) => '<div data-i="' + i + '">' + esc(h.label) + '<small>' + esc(h.sub) + '</small></div>').join('') || '<div>No match</div>';
  res.style.display = 'block';
  res.querySelectorAll('[data-i]').forEach((el) => el.onclick = () => { const h = hits[Number(el.dataset.i)]; res.style.display = 'none'; q.value = ''; open(h.p, h.l); });
};
document.addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); } if (e.key === 'Escape') res.style.display = 'none'; });
tree();
const start = decodeURIComponent(location.hash.slice(1)); if (start) { const [p, l] = start.split(':'); open(p, Number(l) || undefined); }
</script></body></html>`;
}

export function writeExplorer(root, outFile, opts = {}) {
  const index = indexRepo(root);
  mkdirSync(dirname(join(root, outFile)), { recursive: true });
  writeFileSync(join(root, outFile), explorerHtml(index, opts));
  return { path: outFile, stats: index.stats };
}

