// Harbor: the owner's view across every Ghostship project on this machine (~/.ghostship/projects.json),
// served on 127.0.0.1 with a per-launch token, plus a terminal table (--tui). The owner edits project config here.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { load, exists as stateExists } from './store.mjs';
import { status } from './engine.mjs';
import { loadConfig, saveConfig, validateConfig, defaultConfig } from './config.mjs';
import { parseYaml, stringifyYaml } from './yaml.mjs';
import { readActive, history, alive } from './runs.mjs';
import { spend, alertsSince, paused, pause, go, claudeLimits } from './bridge.mjs';
import { list as listAsks } from './asks.mjs';
import { clearQuota, loadQuota, policyBlocks, modeFor } from './routing.mjs';
import { detect } from './harness.mjs';
import { HARBOR_HTML } from './harbor-ui.mjs';

export const gsHome = (home) => join(home || process.env.GHOSTSHIP_HOME || homedir(), '.ghostship');
const projectsFile = (home) => join(gsHome(home), 'projects.json');

export function readProjects(home) {
  try { return JSON.parse(readFileSync(projectsFile(home), 'utf8')).projects || []; } catch { return []; }
}

function writeProjects(home, list) {
  mkdirSync(gsHome(home), { recursive: true });
  writeFileSync(projectsFile(home), JSON.stringify({ projects: list }, null, 2) + '\n');
}

export function registerProject(home, { name, path }) {
  const p = resolve(path);
  const list = readProjects(home);
  const i = list.findIndex((x) => resolve(x.path) === p);
  const entry = { name: name || p.split(/[\\/]/).pop(), path: p, added: i >= 0 ? list[i].added : new Date().toISOString() };
  if (i >= 0) list[i] = entry; else list.push(entry);
  writeProjects(home, list);
  return list;
}

export function unregisterProject(home, path) {
  const p = resolve(path);
  const list = readProjects(home).filter((x) => resolve(x.path) !== p);
  writeProjects(home, list);
  return list;
}

const ago = (iso) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 60000) : null);

export function summary(p) {
  const base = { name: p.name, path: p.path };
  if (!existsSync(p.path)) return { ...base, health: 'missing', note: 'folder not found' };
  if (!stateExists(p.path)) return { ...base, health: 'missing', note: 'no Ghostship state' };
  try {
    const s = status(p.path);
    const cfg = loadConfig(p.path);
    let run = readActive(p.path);
    if (run?.status === 'running' && !alive(run.supervisorPid)) run = { ...run, status: 'lost' };
    let hb = null;
    try { hb = JSON.parse(readFileSync(join(p.path, '.ghostship/runs/heartbeat.json'), 'utf8')); } catch { /* none */ }
    const recent = alertsSince(p.path, 0).alerts.filter((a) => Date.now() - Date.parse(a.at) < 864e5);
    const ver = (() => { try { return readFileSync(join(p.path, '.ghostship/core/VERSION'), 'utf8').trim(); } catch { return '?'; } })();
    const asks = (() => { try { return listAsks(p.path).map((a) => ({ id: a.id, kind: a.kind, title: a.title, why: a.why || '', options: a.options || [] })); } catch { return []; } })();
    const health = s.needsDecision.length || s.release || asks.length ? 'action' : run?.status === 'lost' || run?.blocked ? 'warn' : s.paused ? 'paused' : s.active || run?.status === 'running' ? 'busy' : 'idle';
    return {
      ...base, health, stage: s.stage, next: s.next, paused: s.paused, active: s.active, needsDecision: s.needsDecision, counts: s.counts,
      release: s.release, run: run ? { agentId: run.agentId, role: run.role, task: run.task, status: run.status, mode: run.mode, blocked: !!run.blocked } : null,
      session: hb ? { minutesAgo: ago(hb.at), percent: hb.percent, usd: hb.usd } : null, alerts24h: recent.length, spend: spend(p.path), asks, claude: claudeLimits(p.path),
      tier: cfg.project?.tier, confidential: !!cfg.policy?.confidential, tracker: cfg.tracker?.mode, version: ver,
    };
  } catch (e) { return { ...base, health: 'error', note: e.message }; }
}

function lastEvents(root, n = 25) {
  try {
    return readFileSync(join(root, '.ghostship/state/events.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-n).reverse()
      .map((l) => { const e = JSON.parse(l); return { at: e.at, type: e.type, ref: e.ref }; });
  } catch { return []; }
}

export function detail(p) {
  const sum = summary(p);
  if (sum.health === 'missing' || sum.health === 'error') return sum;
  const state = load(p.path);
  const cfg = loadConfig(p.path);
  const detected = detect();
  const quota = loadQuota(p.path);
  const agents = Object.entries(cfg.agents || {}).map(([id, a]) => {
    const pol = policyBlocks(cfg, a);
    const m = modeFor(cfg, a, { detected, herdr: false });
    const q = quota[id] && Date.parse(quota[id].until) > Date.now() ? quota[id] : null;
    return { id, ...a, runsAs: pol ? '-' : m.mode || '-', note: pol || (q ? `cooling until ${q.until.slice(11, 16)}` : m.reason || 'ready'), cooling: !!q };
  });
  const tasks = Object.values(state.tasks || {}).sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => ({ id: t.id, title: t.title, status: t.status, attempts: `${t.attempt}/${t.maxAttempts}`, checks: t.checks, tier: t.tier, risk: t.risk }));
  const configText = existsSync(join(p.path, '.ghostship/config.yaml')) ? readFileSync(join(p.path, '.ghostship/config.yaml'), 'utf8') : stringifyYaml(cfg);
  return {
    ...sum, tasks, agents, tiers: cfg.routing?.tiers || {}, runs: history(p.path).slice(-20).reverse(), alerts: alertsSince(p.path, 0).alerts.slice(-30).reverse(),
    events: lastEvents(p.path), releases: (state.releases || []).map((r) => ({ tag: r.tag, at: r.approvedAt, result: r.result })).reverse(), configText,
    checks: state.acceptance?.checks || [], approvals: cfg.approvals?.mode || 'terminal',
  };
}

/** The approval modes the owner picks between (approvals.mode), with what each one trusts. */
export const APPROVAL_MODES = [
  { mode: 'terminal', note: 'you type yes in your own terminal (default; the CLI checks for a real TTY)' },
  { mode: 'chat', note: 'you approve in words; Claude passes your exact quote' },
  { mode: 'bridge', note: 'one press in the Bridge pane, proved by ~/.ghostship/bridge.key (opt-in; weaker than the TTY check, since only the guard keeps agents from the key)' },
];

/** Owner edit from Harbor: validate before writing; agents never reach this path. */
export function saveConfigText(root, text) {
  let parsed;
  try { parsed = parseYaml(text) || {}; } catch (e) { return { ok: false, errors: [`YAML: ${e.message}`] }; }
  const errors = validateConfig(loadConfigFrom(parsed));
  if (errors.length) return { ok: false, errors };
  saveConfig(root, parsed);
  return { ok: true };
}

function loadConfigFrom(raw) {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const fill = (base, over) => { if (!isObj(over)) return over === undefined ? base : over; const o = { ...base }; for (const [k, v] of Object.entries(over)) o[k] = isObj(v) && isObj(base?.[k]) ? fill(base[k], v) : v; return o; };
  return fill(defaultConfig({ name: raw?.project?.name || 'project' }), raw || {});
}

// ---------------------------------------------------------------- web server

export function createHarbor({ home, token = randomBytes(18).toString('base64url') } = {}) {
  const want = Buffer.from(token);
  const ok = (req, url) => {
    const got = Buffer.from(String(req.headers['x-harbor-token'] || url.searchParams.get('t') || ''));
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const find = (path) => readProjects(home).find((x) => resolve(x.path) === resolve(String(path || '')));
  const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const body = (req) => new Promise((okr, bad) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 2e6) { bad(new Error('too large')); req.destroy(); } }); req.on('end', () => okr(b)); });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        if (!ok(req, url)) return send(res, 401, 'Open the link Harbor printed (it carries the access token).', 'text/plain; charset=utf-8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'", 'referrer-policy': 'no-referrer' });
        return res.end(HARBOR_HTML);
      }
      // API: the token must come in the header (not the URL) so another page cannot drive it
      const hdr = Buffer.from(String(req.headers['x-harbor-token'] || ''));
      if (hdr.length !== want.length || !timingSafeEqual(hdr, want)) return send(res, 401, { error: 'token required' });
      if (req.method === 'GET' && url.pathname === '/api/projects') return send(res, 200, readProjects(home).map(summary));
      if (req.method === 'GET' && url.pathname === '/api/project') {
        const p = find(url.searchParams.get('path'));
        return p ? send(res, 200, detail(p)) : send(res, 404, { error: 'unknown project' });
      }
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
      const data = JSON.parse((await body(req)) || '{}');
      if (url.pathname === '/api/projects/add') {
        if (!data.path || !existsSync(join(data.path, '.ghostship'))) return send(res, 400, { error: 'That folder has no .ghostship/ (run /ghostship init there first).' });
        return send(res, 200, registerProject(home, { name: data.name, path: data.path }));
      }
      const p = find(data.path);
      if (!p) return send(res, 404, { error: 'unknown project' });
      if (url.pathname === '/api/projects/remove') return send(res, 200, unregisterProject(home, p.path));
      if (url.pathname === '/api/config') return send(res, 200, saveConfigText(p.path, String(data.text || '')));
      if (url.pathname === '/api/pause') { pause(p.path, data.reason || 'paused from Harbor'); return send(res, 200, { ok: true }); }
      if (url.pathname === '/api/go') { go(p.path); return send(res, 200, { ok: true }); }
      if (url.pathname === '/api/quota/clear') { clearQuota(p.path, String(data.agent)); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: 'not found' });
    } catch (e) { return send(res, 500, { error: e.message }); }
  });
  return { server, token, listen: (port = 8788) => new Promise((okp, bad) => { server.once('error', bad); server.listen(port, '127.0.0.1', () => okp(server.address().port)); }) };
}

// ---------------------------------------------------------------- terminal table

export function tuiTable(home) {
  const rows = readProjects(home).map(summary);
  if (!rows.length) return 'No projects yet. Run /ghostship init in a project folder.';
  const icon = { action: '⚑', warn: '⚠', busy: '●', idle: '○', paused: '⏸', missing: '✗', error: '✗' };
  const head = ['', 'project', 'stage', 'task', 'run', 'for you', 'Claude $', 'next'];
  const body = rows.map((r) => [icon[r.health] || '?', r.name, r.stage || '-', r.active ? `${r.active.id} ${r.active.status} ${r.active.attempt}/${r.active.max}` : '-',
    r.run ? `${r.run.agentId} ${r.run.status}` : '-', (r.asks || []).length ? `${r.asks.length}: ${r.asks[0].title.slice(0, 30)}` : '-', r.spend ? r.spend.claudeUsd.toFixed(2) : '-', (r.next || r.note || '').slice(0, 60)]);
  const all = [head, ...body];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  return all.map((r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ')).join('\n');
}
