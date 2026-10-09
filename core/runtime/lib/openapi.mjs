// Renders an OpenAPI 3 document (YAML or JSON) as a readable HTML API reference for the docs site. No dependencies.
import { readFileSync } from 'node:fs';
import { parseYaml } from './yaml.mjs';
import { esc, inline } from './markdown.mjs';

export function loadOpenApi(path) {
  const txt = readFileSync(path, 'utf8');
  return /\.json$/i.test(path) ? JSON.parse(txt) : parseYaml(txt);
}

const refName = (r) => String(r).split('/').pop();

function resolve(doc, node, depth = 0) {
  if (!node || depth > 6) return node;
  if (node.$ref) {
    const parts = String(node.$ref).replace(/^#\//, '').split('/');
    let cur = doc;
    for (const p of parts) cur = cur?.[p];
    return cur ? { ...resolve(doc, cur, depth + 1), __ref: refName(node.$ref) } : node;
  }
  return node;
}

function typeOf(doc, s) {
  if (!s) return 'any';
  if (s.$ref) return `<a href="#schema-${esc(refName(s.$ref))}">${esc(refName(s.$ref))}</a>`;
  if (s.type === 'array') return `${typeOf(doc, s.items)}[]`;
  if (s.enum) return `${esc(s.type || 'string')} (${s.enum.map(esc).join(' | ')})`;
  if (s.oneOf || s.anyOf) return (s.oneOf || s.anyOf).map((x) => typeOf(doc, x)).join(' | ');
  return esc(s.type || 'object') + (s.format ? ` <span class="muted">${esc(s.format)}</span>` : '');
}

function schemaTable(doc, schema) {
  const s = resolve(doc, schema);
  if (!s) return '';
  if (s.type === 'array' || !s.properties) return `<p>${typeOf(doc, schema)}</p>`;
  const req = new Set(s.required || []);
  return `<div class="table"><table><thead><tr><th>field</th><th>type</th><th>required</th><th>description</th></tr></thead><tbody>${Object.entries(s.properties).map(([k, v]) =>
    `<tr><td><code>${esc(k)}</code></td><td>${typeOf(doc, v)}</td><td>${req.has(k) ? 'yes' : ''}</td><td>${inline(v.description || '')}</td></tr>`).join('')}</tbody></table></div>`;
}

export function renderOpenApi(doc) {
  const info = doc.info || {};
  const out = [`<h1 id="api">${esc(info.title || 'API')} <span class="muted">${esc(info.version || '')}</span></h1>`];
  if (info.description) out.push(`<p>${inline(info.description)}</p>`);
  if (doc.servers?.length) out.push(`<p>Servers: ${doc.servers.map((s) => `<code>${esc(s.url)}</code>`).join(' ')}</p>`);
  const ops = [];
  for (const [path, item] of Object.entries(doc.paths || {})) {
    for (const m of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) if (item?.[m]) ops.push({ path, method: m, op: item[m], shared: item.parameters || [] });
  }
  out.push('<div class="table"><table><thead><tr><th>method</th><th>path</th><th>summary</th></tr></thead><tbody>' + ops.map((o, i) =>
    `<tr><td><span class="verb verb-${o.method}">${o.method.toUpperCase()}</span></td><td><a href="#op-${i}"><code>${esc(o.path)}</code></a></td><td>${inline(o.op.summary || '')}</td></tr>`).join('') + '</tbody></table></div>');
  ops.forEach((o, i) => {
    out.push(`<h2 id="op-${i}"><span class="verb verb-${o.method}">${o.method.toUpperCase()}</span> <code>${esc(o.path)}</code></h2>`);
    if (o.op.summary) out.push(`<p><strong>${inline(o.op.summary)}</strong></p>`);
    if (o.op.description) out.push(`<p>${inline(o.op.description)}</p>`);
    const params = [...o.shared, ...(o.op.parameters || [])].map((p) => resolve(doc, p));
    if (params.length) out.push('<h3>Parameters</h3><div class="table"><table><thead><tr><th>name</th><th>in</th><th>type</th><th>required</th><th>description</th></tr></thead><tbody>' +
      params.map((p) => `<tr><td><code>${esc(p.name)}</code></td><td>${esc(p.in)}</td><td>${typeOf(doc, p.schema)}</td><td>${p.required ? 'yes' : ''}</td><td>${inline(p.description || '')}</td></tr>`).join('') + '</tbody></table></div>');
    const rb = resolve(doc, o.op.requestBody);
    if (rb?.content) {
      const [ct, media] = Object.entries(rb.content)[0];
      out.push(`<h3>Request body <span class="muted">${esc(ct)}</span></h3>${schemaTable(doc, media.schema)}`);
    }
    if (o.op.responses) out.push('<h3>Responses</h3><div class="table"><table><thead><tr><th>status</th><th>description</th><th>body</th></tr></thead><tbody>' +
      Object.entries(o.op.responses).map(([code, r0]) => { const r = resolve(doc, r0) || {}; const media = r.content ? Object.values(r.content)[0] : null; return `<tr><td><code>${esc(code)}</code></td><td>${inline(r.description || '')}</td><td>${media?.schema ? typeOf(doc, media.schema) : ''}</td></tr>`; }).join('') + '</tbody></table></div>');
  });
  const schemas = doc.components?.schemas || {};
  if (Object.keys(schemas).length) {
    out.push('<h2 id="schemas">Schemas</h2>');
    for (const [name, s] of Object.entries(schemas)) out.push(`<h3 id="schema-${esc(name)}">${esc(name)}</h3>${s.description ? `<p>${inline(s.description)}</p>` : ''}${schemaTable(doc, s)}`);
  }
  return { html: out.join('\n'), operations: ops.length };
}
