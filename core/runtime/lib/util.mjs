// Pure helpers. No I/O except where named. Zero dependencies.
import { createHash } from 'node:crypto';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Glob -> RegExp. Supports `**`, `*`, `?`. A trailing `/` means "everything under". */
export function globToRegExp(glob) {
  let g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` matches zero or more directories; bare `**` matches anything.
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', IS_WIN ? 'i' : '');
}

export function matchesAny(relPath, globs) {
  return (globs || []).some((g) => globToRegExp(g).test(relPath));
}

/**
 * Normalise a path to a forward-slash path relative to root.
 * Returns null if it escapes root (callers must fail closed on null).
 */
export function normRel(root, p) {
  if (typeof p !== 'string' || !p) return null;
  const s = p.replace(/\\/g, '/');
  const rootN = root.replace(/\\/g, '/');
  const abs = path.posix.isAbsolute(s) || /^[A-Za-z]:\//.test(s)
    ? path.posix.normalize(s)
    : path.posix.normalize(path.posix.join(rootN, s));
  let rel = path.posix.relative(path.posix.normalize(rootN), abs);
  if (IS_WIN) {
    const a = abs.toLowerCase(), r = path.posix.normalize(rootN).toLowerCase();
    if (!a.startsWith(r)) return null;
  }
  if (rel === '' ) return '.';
  if (rel.startsWith('..') || path.posix.isAbsolute(rel)) return null;
  return rel;
}

const SHAPED = [
  /AKIA[0-9A-Z]{16}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{10,}/g,
  /\bgh[pousr]_[0-9A-Za-z]{30,}/g,
  /\bxox[abprs]-[0-9A-Za-z-]{10,}/g,
  /\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsb_secret_[0-9A-Za-z_-]{10,}/g,
  /\bsk-ant-[0-9A-Za-z_-]{20,}/g,
  /\bsk-[0-9A-Za-z]{32,}/g,
];

/** Redact literal secrets (>= 8 chars) and shaped keys. */
export function redact(text, literals = []) {
  let out = String(text);
  const lits = [...new Set(literals.filter((l) => typeof l === 'string' && l.length >= 8))]
    .sort((a, b) => b.length - a.length);
  for (const l of lits) out = out.split(l).join('[REDACTED]');
  for (const re of SHAPED) out = out.replace(re, '[REDACTED]');
  return out;
}

const SKIP_PATTERNS = [
  /\b[1-9]\d*\s+(?:skipped|skip|pending|todo|xfailed|incomplete)\b/i,
  /\b(?:skipped|pending|todo)\s+[1-9]\d*\b/i,
  /\bcollected 0 items\b/i,
  /\bno tests? (?:found|ran|collected|to run)\b/i,
  /\bran 0 tests\b/i,
  /\b0 passing\b/i,
];

/** Returns the first matching line describing skipped/absent tests, or null. */
export function detectSkips(output, extra = []) {
  const pats = [...SKIP_PATTERNS, ...extra.map((s) => new RegExp(s, 'i'))];
  for (const line of String(output).split(/\r?\n/)) {
    if (pats.some((re) => re.test(line))) return line.trim();
  }
  return null;
}

export class FactoryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function nowIso() { return new Date().toISOString(); }
