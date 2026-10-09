// Small, safe Markdown → HTML for the docs site: GFM tables, task lists, fences (mermaid kept for drawing),
// nested lists, quotes. Raw HTML is escaped, never passed through; links are limited to safe schemes.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const slug = (s) => String(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

function safeUrl(u, rewrite) {
  const t = String(u).trim();
  if (/^(javascript|data|vbscript):/i.test(t)) return '#';
  return rewrite ? rewrite(t) : t;
}

export function inline(text, opts = {}) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, alt, u) => `<img alt="${alt}" src="${esc(safeUrl(u.replace(/&amp;/g, '&'), opts.rewriteImage))}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${esc(safeUrl(u.replace(/&amp;/g, '&'), opts.rewriteLink))}">${t}</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => `${pre}<a href="${u}">${u}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

function cells(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const out = []; let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
    if (t[i] === '|') { out.push(cur.trim()); cur = ''; continue; }
    cur += t[i];
  }
  out.push(cur.trim());
  return out;
}

export function renderMarkdown(md, opts = {}) {
  const lines = String(md).replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out = [];
  const headings = [];
  const used = new Map();
  let i = 0;
  const isBlank = (l) => l === undefined || l.trim() === '';
  const listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  function list(baseIndent) {
    const first = listRe.exec(lines[i]);
    const ordered = /\d/.test(first[2]);
    const html = [ordered ? '<ol>' : '<ul>'];
    while (i < lines.length) {
      const m = listRe.exec(lines[i]);
      if (!m || m[1].length !== baseIndent) break;
      let body = m[3];
      let task = '';
      const tm = /^\[([ xX])\]\s+(.*)$/.exec(body);
      if (tm) { task = `<input type="checkbox" disabled${tm[1] !== ' ' ? ' checked' : ''}> `; body = tm[2]; }
      i++;
      const parts = [inline(body, opts)];
      while (i < lines.length && !isBlank(lines[i]) && !listRe.test(lines[i]) && lines[i].length - lines[i].trimStart().length > baseIndent) { parts.push(inline(lines[i].trim(), opts)); i++; }
      let sub = '';
      while (i < lines.length && listRe.test(lines[i]) && listRe.exec(lines[i])[1].length > baseIndent) sub += list(listRe.exec(lines[i])[1].length);
      html.push(`<li${task ? ' class="task"' : ''}>${task}${parts.join(' ')}${sub}</li>`);
      if (isBlank(lines[i]) && listRe.test(lines[i + 1] || '') && listRe.exec(lines[i + 1])[1].length === baseIndent) i++;
    }
    html.push(ordered ? '</ol>' : '</ul>');
    return html.join('');
  }

  while (i < lines.length) {
    const l = lines[i];
    if (isBlank(l)) { i++; continue; }
    const fence = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)/.exec(l);
    if (fence) {
      const close = fence[2];
      const lang = fence[3].toLowerCase();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) { body.push(lines[i]); i++; }
      i++;
      if (lang === 'mermaid') out.push(`<pre class="mermaid">${esc(body.join('\n'))}</pre>`);
      else out.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ''}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) {
      const level = h[1].length;
      let id = (opts.idPrefix || '') + slug(h[2]);
      const n = used.get(id) || 0; used.set(id, n + 1); if (n) id += `-${n}`;
      headings.push({ level, text: h[2], id });
      out.push(`<h${level} id="${esc(id)}">${inline(h[2], opts)}</h${level}>`);
      i++; continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(l)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote>${renderMarkdown(q.join('\n'), { ...opts, idPrefix: (opts.idPrefix || '') + 'q-' }).html}</blockquote>`);
      continue;
    }
    if (l.includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1] || '')) {
      const head = cells(l);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) { rows.push(cells(lines[i])); i++; }
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c, opts)}</${tag}>`;
      out.push(`<div class="table"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => td('td', r[k] ?? '', k)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (listRe.test(l)) { out.push(list(listRe.exec(l)[1].length)); continue; }
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !/^(\s*)(`{3,}|~{3,})/.test(lines[i]) && !listRe.test(lines[i]) && !/^\s*>/.test(lines[i])) { para.push(lines[i].trim()); i++; }
    out.push(`<p>${inline(para.join(' '), opts)}</p>`);
  }
  return { html: out.join('\n'), headings };
}
