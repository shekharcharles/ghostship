// Minimal YAML subset for Ghostship config and task front matter. Zero dependencies.
// Supports: block maps, block lists (of scalars or maps), flow lists [a, b], flow maps {a: b},
// quoted/plain scalars, numbers, booleans, null, comments, block scalars (| and >). No anchors or tags.

class YamlError extends Error {}

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function splitTop(s, sep) {
  const out = []; let depth = 0, q = null, cur = '';
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out.map((x) => x.trim());
}

function findColon(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === ':' && (i === s.length - 1 || s[i + 1] === ' ')) return i;
  }
  return -1;
}

export function parseScalar(raw) {
  const s = raw.trim();
  if (s === '') return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  if (s.startsWith('[') && s.endsWith(']')) return splitTop(s.slice(1, -1), ',').map(parseScalar);
  if (s.startsWith('{') && s.endsWith('}')) {
    const o = {};
    for (const part of splitTop(s.slice(1, -1), ',')) {
      const i = findColon(part + ' ');
      if (i < 0) throw new YamlError(`bad flow map entry "${part}"`);
      o[unquoteKey(part.slice(0, i))] = parseScalar(part.slice(i + 1));
    }
    return o;
  }
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

function unquoteKey(k) {
  const t = k.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

export function parseYaml(text) {
  const lines = [];
  const rawLines = String(text).split(/\r?\n/);
  // Block scalars keep their own lines (comments and blanks included): find them first.
  const inBlock = new Set();
  rawLines.forEach((raw, i) => {
    if (inBlock.has(i)) return;
    const m = /^(\s*)(?:- )?(?:[^#]*?:\s+)?([|>])[-+]?\s*(#.*)?$/.exec(raw);
    if (!m || !/[:-]\s+[|>][-+]?\s*(#.*)?$|^\s*-\s+[|>]/.test(raw)) return;
    const base = m[1].length;
    for (let j = i + 1; j < rawLines.length; j++) {
      const r = rawLines[j];
      if (r.trim() === '' || r.length - r.trimStart().length > base) inBlock.add(j); else break;
    }
  });
  const blockAfter = (n) => {
    const out = [];
    for (let j = n; j < rawLines.length && inBlock.has(j); j++) out.push(rawLines[j]);
    while (out.length && out.at(-1).trim() === '') out.pop();
    const ind = Math.min(...out.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    return out.map((l) => l.slice(Number.isFinite(ind) ? ind : 0));
  };
  const blockValue = (style, n) => {
    const body = blockAfter(n);
    const keep = style.endsWith('+'), strip = style.endsWith('-');
    let v = style[0] === '|' ? body.join('\n') : body.join('\n').replace(/([^\n])\n(?!\n)/g, '$1 ');
    if (!strip) v += '\n';
    if (keep) v += '';
    return v;
  };
  rawLines.forEach((raw, i) => {
    if (inBlock.has(i)) return;
    if (/^\s*\t/.test(raw) || /^\t/.test(raw)) throw new YamlError(`line ${i + 1}: tabs are not allowed for indentation`);
    const body = stripComment(raw);
    if (body.trim() === '') return;
    const indent = body.length - body.trimStart().length;
    lines.push({ n: i + 1, indent, text: body.trim() });
  });
  if (!lines.length) return {};
  let pos = 0;

  function parseBlock(indent) {
    const first = lines[pos];
    if (first.text.startsWith('- ') || first.text === '-') return parseList(indent);
    return parseMap(indent);
  }

  function parseMap(indent) {
    const obj = {};
    while (pos < lines.length) {
      const ln = lines[pos];
      if (ln.indent < indent) break;
      if (ln.indent > indent) throw new YamlError(`line ${ln.n}: unexpected indentation`);
      if (ln.text.startsWith('- ')) break;
      const i = findColon(ln.text);
      if (i < 0) throw new YamlError(`line ${ln.n}: expected "key: value"`);
      const key = unquoteKey(ln.text.slice(0, i));
      const rest = ln.text.slice(i + 1).trim();
      pos++;
      if (/^[|>][-+]?$/.test(rest)) { obj[key] = blockValue(rest, ln.n); continue; }
      if (rest !== '') { obj[key] = parseScalar(rest); continue; }
      const nxt = lines[pos];
      if (nxt && (nxt.indent > indent || (nxt.indent === indent && nxt.text.startsWith('- ')))) {
        obj[key] = parseBlock(nxt.indent);
      } else obj[key] = null;
    }
    return obj;
  }

  function parseList(indent) {
    const arr = [];
    while (pos < lines.length) {
      const ln = lines[pos];
      if (ln.indent < indent) break;
      if (ln.indent > indent) throw new YamlError(`line ${ln.n}: unexpected indentation`);
      if (!(ln.text.startsWith('- ') || ln.text === '-')) break;
      const rest = ln.text === '-' ? '' : ln.text.slice(2).trim();
      const itemIndent = indent + 2;
      if (rest === '') {
        pos++;
        arr.push(lines[pos] && lines[pos].indent > indent ? parseBlock(lines[pos].indent) : null);
        continue;
      }
      const i = findColon(rest);
      if (i >= 0 && !rest.startsWith('[') && !rest.startsWith('{') && !rest.startsWith('"') && !rest.startsWith("'")) {
        // "- key: value" starts a map item; following keys sit at indent + 2
        lines[pos] = { n: ln.n, indent: itemIndent, text: rest };
        arr.push(parseMap(itemIndent));
      } else if (/^[|>][-+]?$/.test(rest)) {
        pos++;
        arr.push(blockValue(rest, ln.n));
      } else {
        pos++;
        arr.push(parseScalar(rest));
      }
    }
    return arr;
  }

  const root = parseBlock(lines[0].indent);
  if (pos < lines.length) throw new YamlError(`line ${lines[pos].n}: unexpected indentation`);
  return root;
}

function needsQuote(s) {
  if (s === '') return true;
  if (/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s)) return true;
  if (/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(s) || /\s$/.test(s)) return true;
  if (/: |#|\n/.test(s) || s.endsWith(':')) return true;
  return false;
}

function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  return needsQuote(s) ? JSON.stringify(s) : s;
}

const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

export function stringifyYaml(obj, indent = 0) {
  const pad = ' '.repeat(indent);
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = needsQuote(k) ? JSON.stringify(k) : k;
    if (isScalar(v)) out.push(`${pad}${key}: ${scalar(v)}`);
    else if (Array.isArray(v)) {
      if (!v.length) out.push(`${pad}${key}: []`);
      else if (v.every(isScalar)) out.push(`${pad}${key}: [${v.map(scalar).join(', ')}]`);
      else {
        out.push(`${pad}${key}:`);
        for (const item of v) {
          if (isScalar(item)) out.push(`${pad}  - ${scalar(item)}`);
          else if (Array.isArray(item)) out.push(`${pad}  - [${item.map(scalar).join(', ')}]`);
          else {
            const body = stringifyYaml(item, indent + 4).split('\n');
            out.push(`${pad}  - ${body[0].trimStart()}`, ...body.slice(1));
          }
        }
      }
    } else {
      if (!Object.keys(v).length) out.push(`${pad}${key}: {}`);
      else out.push(`${pad}${key}:`, stringifyYaml(v, indent + 2));
    }
  }
  return out.join('\n');
}

export { YamlError };
