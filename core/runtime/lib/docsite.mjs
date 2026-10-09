// Builds the offline docs site: one self-contained index.html (every doc page, the API reference, search,
// diagrams drawn by the bundled Mermaid when present) plus explorer.html, and packs it as a .tar.gz to ship.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { gzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { renderMarkdown, esc } from './markdown.mjs';
import { loadOpenApi, renderOpenApi } from './openapi.mjs';
import { writeExplorer } from './explorer.mjs';
import { loadConfig } from './config.mjs';

const SECTIONS = [
  ['README.md', 'Overview'], ['docs/01-requirements', 'Requirements'], ['docs/02-design', 'Design'], ['docs/03-acceptance', 'Acceptance'],
  ['docs/04-plan', 'Plan'], ['docs/05-code', 'Code'], ['docs/06-quality', 'Quality'], ['docs/07-security', 'Security'], ['docs/08-operations', 'Operations'],
  ['docs/09-user-guides', 'User guides'], ['docs/10-releases', 'Releases'], ['docs/11-memory', 'Memory'],
];
const IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };

function mdFiles(root, rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return [];
  if (statSync(p).isFile()) return rel.endsWith('.md') ? [rel] : [];
  const out = [];
  for (const name of readdirSync(p).sort()) {
    const r = `${rel}/${name}`;
    if (name.startsWith('.')) continue;
    if (statSync(join(root, r)).isDirectory()) out.push(...mdFiles(root, r)); else if (name.endsWith('.md')) out.push(r);
  }
  return out;
}

export function findMermaid(root, extra = []) {
  const candidates = [join(root, '.ghostship/core/vendor/mermaid.min.js'), ...extra.map((d) => join(d, 'vendor/mermaid.min.js')),
    join(process.env.GHOSTSHIP_HOME || homedir(), '.ghostship/core/vendor/mermaid.min.js')];
  return candidates.find((c) => existsSync(c)) || null;
}

export function buildSite(root, { out = 'docs-site', version = '', mermaid = true, coreDirs = [] } = {}) {
  const cfg = loadConfig(root);
  const name = cfg.project?.name || 'project';
  const pages = [];
  const idOf = (rel) => 'p-' + rel.replace(/[^\w]+/g, '-').toLowerCase();
  const all = SECTIONS.flatMap(([rel, sec]) => mdFiles(root, rel).map((f) => ({ rel: f, sec })));
  const known = new Set(all.map((p) => p.rel));
  for (const { rel, sec } of all) {
    const text = readFileSync(join(root, rel), 'utf8');
    const dir = posix.dirname(rel);
    const rewriteLink = (u) => {
      if (/^[a-z]+:|^#/.test(u)) return u;
      const [path, hash] = u.split('#');
      const target = posix.normalize(posix.join(dir, path));
      if (known.has(target)) return `#${idOf(target)}${hash ? `--${hash}` : ''}`;
      return u;
    };
    const rewriteImage = (u) => {
      if (/^[a-z]+:/.test(u)) return u;
      const p = join(root, posix.normalize(posix.join(dir, u)));
      const ext = (/\.(\w+)$/.exec(p)?.[1] || '').toLowerCase();
      if (!IMG[ext] || !existsSync(p) || statSync(p).size > 2e6) return u;
      return `data:${IMG[ext]};base64,${readFileSync(p).toString('base64')}`;
    };
    const r = renderMarkdown(text, { idPrefix: `${idOf(rel)}--`, rewriteLink, rewriteImage });
    pages.push({ id: idOf(rel), rel, sec, title: r.headings[0]?.text || posix.basename(rel, '.md'), html: r.html, text: text.slice(0, 20000) });
  }
  const apiFile = ['yaml', 'yml', 'json'].map((x) => `docs/02-design/api/openapi.${x}`).find((f) => existsSync(join(root, f)));
  if (apiFile) {
    try {
      const r = renderOpenApi(loadOpenApi(join(root, apiFile)));
      const at = pages.findIndex((p) => p.sec === 'Acceptance');
      pages.splice(at === -1 ? pages.length : at, 0, { id: 'p-api', rel: apiFile, sec: 'Design', title: 'API reference', html: r.html, text: '' });
    }
    catch (e) { pages.push({ id: 'p-api', rel: apiFile, sec: 'Design', title: 'API reference', html: `<p>Could not read ${esc(apiFile)}: ${esc(e.message)}</p>`, text: '' }); }
  }
  const mm = mermaid ? findMermaid(root, coreDirs) : null;
  const nav = [];
  let cur = '';
  for (const p of pages) { if (p.sec !== cur) { nav.push(`<div class="sec">${esc(p.sec)}</div>`); cur = p.sec; } nav.push(`<a href="#${p.id}" data-id="${p.id}">${esc(p.title)}</a>`); }
  const searchIndex = JSON.stringify(pages.map((p) => ({ id: p.id, title: p.title, sec: p.sec, text: p.text.toLowerCase() }))).replace(/</g, '\\u003c');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(name)} docs${version ? ` ${esc(version)}` : ''}</title>
<style>
:root{--bg:#fbfaf8;--panel:#fff;--ink:#1d1f23;--sub:#626873;--line:#e6e3dd;--acc:#2f5d8a;--chip:#eef1f5;--code:#f3f2ee;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--panel:#1a1d21;--ink:#e6e8eb;--sub:#9aa1ab;--line:#2a2e34;--acc:#7fb0e0;--chip:#232830;--code:#1f2328}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;grid-template-columns:280px 1fr;min-height:100vh}
nav{position:sticky;top:0;height:100vh;overflow:auto;border-right:1px solid var(--line);background:var(--panel);padding:14px 0}
nav .brand{padding:0 16px 10px;font-weight:700}nav .brand small{display:block;color:var(--sub);font-weight:400}
nav input{margin:0 16px 10px;width:calc(100% - 32px);padding:6px 9px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);font:inherit;font-size:14px}
nav .sec{padding:12px 16px 4px;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--sub);font-weight:600}
nav .brand a.ext{display:inline;padding:0;color:var(--acc)}nav a[data-id]{display:block;padding:3px 16px 3px 22px;color:var(--ink);text-decoration:none;font-size:14px}nav a[data-id]:hover,nav a.on{background:var(--chip)}
main{padding:28px 44px;max-width:980px;min-width:0}article{display:none}article.on{display:block}
h1{font-size:28px;line-height:1.25;margin:0 0 14px}h2{margin-top:30px;padding-bottom:4px;border-bottom:1px solid var(--line)}h3{margin-top:22px}
a{color:var(--acc)}code{font-family:var(--mono);font-size:.88em;background:var(--code);padding:1px 5px;border-radius:4px}
pre{background:var(--code);padding:12px 14px;border-radius:8px;overflow:auto}pre code{background:none;padding:0}
.table{overflow:auto}table{border-collapse:collapse;margin:12px 0;font-size:14px;width:100%}th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}th{background:var(--chip)}
blockquote{margin:12px 0;padding:2px 14px;border-left:3px solid var(--line);color:var(--sub)}li.task{list-style:none;margin-left:-20px}
pre.mermaid{background:var(--panel);border:1px solid var(--line);text-align:center}.muted{color:var(--sub);font-weight:400}
.verb{font:700 11px var(--mono);padding:2px 6px;border-radius:4px;color:#fff;background:#666}.verb-get{background:#2e7d4f}.verb-post{background:#2f5d8a}.verb-put,.verb-patch{background:#b26b00}.verb-delete{background:#b3261e}
.foot{margin-top:40px;color:var(--sub);font-size:13px}
@media (max-width:860px){body{grid-template-columns:1fr}nav{position:static;height:auto;max-height:45vh}main{padding:18px 16px}}
</style></head><body>
<nav><div class="brand">${esc(name)}<small>${esc(version || 'documentation')} · <a class="ext" href="explorer.html">code explorer →</a></small></div><input id="q" placeholder="Search the docs…">${nav.join('')}</nav>
<main>${pages.map((p) => `<article id="${p.id}"><div class="muted" style="font-size:12px">${esc(p.rel)}</div>${p.html}</article>`).join('\n')}
<div class="foot">Generated by Ghostship${version ? ` for ${esc(version)}` : ''} on ${new Date().toISOString().slice(0, 10)}. Offline: no network needed.</div></main>
<script type="application/json" id="idx">${searchIndex}</script>
${mm ? `<script>${readFileSync(mm, 'utf8').replace(/<\/script/gi, '<\\/script')}</script>` : ''}
<script>
const pages=[...document.querySelectorAll('article')];const links=[...document.querySelectorAll('nav a[data-id]')];
function show(h){const [id,anchor]=h.split('--');const pid=(id||'').replace(/^#/,'')||pages[0].id;pages.forEach(p=>p.classList.toggle('on',p.id===pid));links.forEach(a=>a.classList.toggle('on',a.dataset.id===pid));
 if(window.mermaid){const el=document.getElementById(pid);if(el&&!el.dataset.drawn){el.dataset.drawn='1';mermaid.run({nodes:el.querySelectorAll('pre.mermaid')}).catch(()=>{});}}
 const t=anchor?document.getElementById(pid+'--'+anchor):null;(t||document.querySelector('main')).scrollIntoView();window.scrollTo(0,t?window.scrollY:0);}
if(window.mermaid){mermaid.initialize({startOnLoad:false,theme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'default',securityLevel:'strict'});}
window.addEventListener('hashchange',()=>show(location.hash));show(location.hash||'#'+pages[0]?.id);
const idx=JSON.parse(document.getElementById('idx').textContent);const q=document.getElementById('q');
q.oninput=()=>{const t=q.value.trim().toLowerCase();links.forEach(a=>{const p=idx.find(x=>x.id===a.dataset.id);a.style.display=!t||(p&&(p.title.toLowerCase().includes(t)||p.text.includes(t)))?'':'none';});};
</script></body></html>`;
  mkdirSync(join(root, out), { recursive: true });
  writeFileSync(join(root, out, 'index.html'), html);
  const ex = writeExplorer(root, `${out}/explorer.html`, { title: `${name} — code explorer`, version });
  return { out, pages: pages.length, api: !!apiFile, mermaid: !!mm, explorer: ex.stats };
}

// ---------------------------------------------------------------- tar.gz (ustar), so the site ships as one file

function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512, 0);
  const put = (s, off, len) => h.write(String(s).slice(0, len), off, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100); put(oct(0o644, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12); put(oct(Math.floor(mtime / 1000), 12), 136, 12); h.fill(' ', 148, 156); put('0', 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
  let sum = 0; for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

export function packSite(root, dir, outFile, prefix) {
  const parts = [];
  for (const name of readdirSync(join(root, dir)).sort()) {
    const p = join(root, dir, name);
    if (!statSync(p).isFile() || name.endsWith('.tar.gz')) continue;
    const data = readFileSync(p);
    parts.push(tarHeader(`${prefix}/${name}`, data.length, Date.now()), data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  writeFileSync(join(root, outFile), gzipSync(Buffer.concat(parts)));
  return { path: outFile };
}
