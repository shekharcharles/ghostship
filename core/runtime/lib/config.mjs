// .ghostship/config.yaml: one per project. Missing keys are filled from defaults on load.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseYaml, stringifyYaml } from './yaml.mjs';
import { CONFIG_FILE } from './paths.mjs';

export function defaultConfig({ name = 'project', tier = 'standard', tracker = 'local', approvals = 'chat', author = '', tagline = '' } = {}) {
  return {
    project: { name, domain: 'software', tier, author, tagline },
    tracker: { mode: tracker },
    approvals: { mode: approvals },
    // How much runs without the owner. autopilot: the owner approves the PRD, STOP 1 and STOP 2 only; a task that uses its
    // attempts gets auto-retries more, then is parked for STOP 2. full: STOP 1 too, once the checks pass lint. guided: every gate.
    autonomy: { mode: 'autopilot', 'auto-retries': 1, 'night-shift': false, 'night-shift-at': 90 },
    agents: {
      'claude-opus': { harness: 'claude', provider: 'claude-subscription', model: 'opus' },
      'claude-sonnet': { harness: 'claude', provider: 'claude-subscription', model: 'sonnet' },
      'claude-haiku': { harness: 'claude', provider: 'claude-subscription', model: 'haiku' },
    },
    providers: { 'claude-subscription': { type: 'claude-login' } },
    routing: {
      tiers: {
        grunt: ['claude-haiku'],
        standard: ['claude-sonnet'],
        frontier: ['claude-opus'],
        'judge-light': ['claude-sonnet'],
        'judge-full': ['claude-opus'],
      },
      activities: {},
      escalation: ['same-tier', 'same-tier+judge-notes', 'one-tier-up'],
      'on-quota-out': 'next-in-list-else-wait',
      'claude-limit-pct': 85,
      'spare-claude-tiers': ['grunt', 'standard'],
    },
    // serve: starts the app for a look in a browser, with {port} (or $PORT) for the port Ghostship gives each run.
    commands: { test: '', acceptance: '', lint: '', typecheck: '', serve: '' },
    branches: { main: 'main', develop: 'develop' },
    launch: { remoteControl: 'when-supported', skipPermissions: true },
    dispatch: { claude: 'in-session', mode: 'auto', 'timeout-min': 45 },
    harnesses: {},
    policy: { confidential: false, 'allowed-providers': [] },
    herdr: { use: 'auto' },
    gateway: { port: 8787, routes: {} },
    loop: { attempts: 3, 'restarts-per-attempt': 2, 'max-parallel': 1, 'timeout-sec': 900,
      stuck: { 'nudge-min': 5, 'restart-min': 10 }, 'handoff-tokens': { soft: 150000, hard: 200000 } },
    // risk-paths: keywords (a whole word of the path) or globs; with dependency, CI, deploy and migration files they make a
    // change risky: a full judge, a SECURITY lens, and the owner before it merges. lenses: what the judge reports besides the checks.
    judge: { depth: 'by-risk', 'risk-paths': ['auth', 'payment', 'billing', 'migration', 'secret', 'api'], lenses: ['security', 'ux'] },
    // A judged PASS that touches risky paths, or rests on a product assumption, waits for the owner (gs decide <id> --merge).
    merge: { 'hold-risky': true, 'hold-product-assumptions': true },
    'protected-paths': ['.env*', '*.pem', '*.key'],
    docs: { 'purpose-headers': true },
    spend: { caps: 'none', 'alert-over-estimate-pct': 50 },
    learning: { 'auto-apply': true, 'trigger-occurrences': 2, 'brief-rule-limit': 20 },
    upgrade: { auto: 'safe-point', 'rollback-on-fail': true },
    exceptions: [],
  };
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function deepFill(base, over) {
  if (!isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base?.[k]) ? deepFill(base[k], v) : v;
  return out;
}

export function loadConfig(root) {
  const p = join(root, CONFIG_FILE);
  const raw = existsSync(p) ? parseYaml(readFileSync(p, 'utf8')) : {};
  const name = raw?.project?.name || 'project';
  return deepFill(defaultConfig({ name }), raw || {});
}

export function saveConfig(root, cfg) {
  const p = join(root, CONFIG_FILE);
  mkdirSync(dirname(p), { recursive: true });
  const header = '# Ghostship project config. Edit here or in Harbor. Secrets never go in this file.\n';
  writeFileSync(p, header + stringifyYaml(cfg) + '\n');
}

export function validateConfig(cfg) {
  const errs = [];
  if (!['local', 'github', 'both'].includes(cfg.tracker?.mode)) errs.push(`tracker.mode must be local, github or both (got ${cfg.tracker?.mode})`);
  if (!['terminal', 'chat', 'bridge'].includes(cfg.approvals?.mode)) errs.push(`approvals.mode must be terminal, chat or bridge`);
  if (!['light', 'standard', 'full'].includes(cfg.project?.tier)) errs.push('project.tier must be light, standard or full');
  const au = cfg.autonomy || {};
  if (!AUTONOMY_MODES.includes(au.mode)) errs.push(`autonomy.mode must be ${AUTONOMY_MODES.join(', ')}`);
  if (!(Number.isInteger(au['auto-retries']) && au['auto-retries'] >= 0 && au['auto-retries'] <= 3)) errs.push('autonomy.auto-retries must be 0..3');
  if (typeof au['night-shift'] !== 'boolean') errs.push('autonomy.night-shift must be true or false');
  if (!(typeof au['night-shift-at'] === 'number' && au['night-shift-at'] >= 50 && au['night-shift-at'] <= 100)) errs.push('autonomy.night-shift-at must be 50..100');
  const a = cfg.loop?.attempts;
  if (!(Number.isInteger(a) && a >= 1 && a <= 10)) errs.push('loop.attempts must be 1..10');
  const agents = new Set(Object.keys(cfg.agents || {}));
  for (const [tier, list] of Object.entries(cfg.routing?.tiers || {})) {
    if (!Array.isArray(list) || !list.length) errs.push(`routing.tiers.${tier} needs at least one agent`);
    for (const id of list || []) if (!agents.has(id)) errs.push(`routing.tiers.${tier}: unknown agent "${id}" (define it under agents)`);
  }
  const TYPES = ['claude-login', 'cli-login', 'openai-compatible', 'local', 'anthropic-api-key', 'gateway'];
  for (const [id, p] of Object.entries(cfg.providers || {})) {
    if (!TYPES.includes(p?.type)) errs.push(`providers.${id}.type must be one of ${TYPES.join(', ')}`);
    if (p?.type === 'local' && p.baseUrl && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(p.baseUrl)) errs.push(`providers.${id}: a local provider must point at localhost`);
    if (p?.key && !/^[A-Z][A-Z0-9_]*$/.test(p.key)) errs.push(`providers.${id}.key is the NAME of a line in ~/.ghostship/secrets, not the key itself`);
  }
  for (const [id, a] of Object.entries(cfg.agents || {})) {
    if (!a?.harness) errs.push(`agents.${id}.harness is required`);
    if (a?.provider && !cfg.providers?.[a.provider]) errs.push(`agents.${id}: provider "${a.provider}" is not defined`);
  }
  for (const [name, r] of Object.entries(cfg.gateway?.routes || {})) {
    const p = cfg.providers?.[r?.provider];
    if (!p) errs.push(`gateway.routes.${name}: provider "${r?.provider}" is not defined`);
    else if (!['openai-compatible', 'local', 'anthropic-api-key'].includes(p.type)) errs.push(`gateway.routes.${name}: the gateway only forwards to API-key or local providers, never a subscription login`);
  }
  for (const k of ['hold-risky', 'hold-product-assumptions']) if (typeof cfg.merge?.[k] !== 'boolean') errs.push(`merge.${k} must be true or false`);
  for (const l of cfg.judge?.lenses || []) if (!['security', 'ux'].includes(l)) errs.push(`judge.lenses: unknown lens "${l}" (security, ux)`);
  if (cfg.launch && 'permissionBypass' in cfg.launch) errs.push('launch.permissionBypass was renamed: use launch.skipPermissions (true|false).');
  if (cfg.launch && 'skipPermissions' in cfg.launch && typeof cfg.launch.skipPermissions !== 'boolean') errs.push('launch.skipPermissions must be true or false');
  return errs;
}

export const AUTONOMY_MODES = ['autopilot', 'full', 'guided'];

/** The autonomy settings with defaults filled: { mode, autoRetries, nightShift, nightShiftAt }. */
export function autonomyOf(cfg) {
  const a = cfg?.autonomy || {};
  return {
    mode: AUTONOMY_MODES.includes(a.mode) ? a.mode : 'autopilot',
    autoRetries: Number.isInteger(a['auto-retries']) ? a['auto-retries'] : 1,
    nightShift: a['night-shift'] === true,
    nightShiftAt: typeof a['night-shift-at'] === 'number' ? a['night-shift-at'] : 90,
  };
}

// Keys an agent may set through `gs config set`. Agents, providers, harness launch templates and policy are owner-only (edit the file or Harbor).
const SETTABLE = [/^commands\.(test|acceptance|lint|typecheck|serve)$/, /^project\.tier$/, /^judge\.depth$/, /^routing\.tiers\.[\w-]+$/, /^routing\.activities\.[\w-]+$/];
export function settable(key) { return SETTABLE.some((re) => re.test(key)); }

export function setKey(cfg, key, value) {
  const parts = key.split('.');
  let o = cfg;
  for (const k of parts.slice(0, -1)) o = (o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {});
  o[parts.at(-1)] = value;
  return cfg;
}
