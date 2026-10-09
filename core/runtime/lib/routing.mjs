// Which agent does a piece of work: role → tier → ordered agent list → first agent that is installed,
// allowed by the project's data policy, and not cooling down after a quota error.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { CATALOG } from './harness.mjs';

export const TIER_LADDER = ['grunt', 'standard', 'frontier'];
const QUOTA_FILE = '.ghostship/usage/quota.json';
// Provider types that keep code on the owner's machine or the owner's own Claude plan.
const CONFIDENTIAL_OK = new Set(['claude-login', 'local']);

export function up(tier) {
  const i = TIER_LADDER.indexOf(tier);
  return i === -1 ? tier : TIER_LADDER[Math.min(i + 1, TIER_LADDER.length - 1)];
}

export function tierFor(cfg, { role, task = {}, attempt = 1, maxAttempts = 3 } = {}) {
  const act = cfg.routing?.activities || {};
  if (role === 'planner') return act.plan || 'frontier';
  if (role === 'judge') return task.risk === 'high' || attempt >= maxAttempts ? (act['judge-high'] || 'judge-full') : (act.judge || 'judge-light');
  let base = act[`task-${task.tier}`] || task.tier || 'standard';
  if (!TIER_LADDER.includes(base)) base = 'standard';
  if (task.risk === 'high' && base !== 'frontier') base = 'frontier';
  const esc = cfg.routing?.escalation || [];
  if (esc[attempt - 1] === 'one-tier-up' || (attempt > esc.length && esc.at(-1) === 'one-tier-up')) base = up(base);
  return base;
}

export function loadQuota(root) {
  try { return JSON.parse(readFileSync(join(root, QUOTA_FILE), 'utf8')); } catch { return {}; }
}

export function markQuota(root, agentId, minutes, reason = 'quota') {
  const q = loadQuota(root);
  q[agentId] = { until: new Date(Date.now() + minutes * 60000).toISOString(), reason };
  mkdirSync(dirname(join(root, QUOTA_FILE)), { recursive: true });
  writeFileSync(join(root, QUOTA_FILE), JSON.stringify(q, null, 2) + '\n');
  return q[agentId];
}

export function clearQuota(root, agentId) {
  const q = loadQuota(root);
  delete q[agentId];
  if (existsSync(join(root, QUOTA_FILE))) writeFileSync(join(root, QUOTA_FILE), JSON.stringify(q, null, 2) + '\n');
}

/** Does the project's data policy allow this agent's provider? Returns null if yes, else the reason. */
export function policyBlocks(cfg, agent) {
  const pol = cfg.policy || {};
  const provider = cfg.providers?.[agent.provider];
  if (!provider) return `provider "${agent.provider}" is not defined`;
  const allowList = pol['allowed-providers'] || [];
  if (allowList.length && !allowList.includes(agent.provider)) return `provider "${agent.provider}" is not in policy.allowed-providers`;
  if (pol.confidential) {
    if (provider.type === 'gateway') {
      const routes = Object.values(cfg.gateway?.routes || {});
      const bad = routes.map((r) => cfg.providers?.[r.provider]).filter((p) => !p || !CONFIDENTIAL_OK.has(p.type));
      if (!routes.length || bad.length) return 'confidential project: the gateway routes to a non-local provider';
    } else if (!CONFIDENTIAL_OK.has(provider.type)) return `confidential project: ${agent.provider} (${provider.type}) would send code to a third party`;
  }
  return null;
}

/**
 * How an agent would run here: 'in-session' (Claude subagent via the Agent tool), 'headless', 'tab' (herdr), or null + reason.
 */
export function modeFor(cfg, agent, { detected = {}, herdr = false } = {}) {
  const provider = cfg.providers?.[agent.provider] || {};
  if (agent.harness === 'claude' && provider.type === 'claude-login' && (cfg.dispatch?.claude || 'in-session') === 'in-session') return { mode: 'in-session' };
  if (!detected[agent.harness]) return { mode: null, reason: `${agent.harness} is not installed` };
  const cat = CATALOG[agent.harness] || {};
  const own = cfg.harnesses?.[agent.harness] || {};
  const want = agent.mode || cfg.dispatch?.mode || 'auto';
  const canHeadless = !!(own.headless || cat.headless);
  const canTab = herdr && !!(own.args || cat.herdrKind);
  if (want === 'headless') return canHeadless ? { mode: 'headless' } : { mode: null, reason: `${agent.harness} has no safe headless mode` };
  if (want === 'tab') return canTab ? { mode: 'tab' } : { mode: null, reason: herdr ? `${agent.harness} cannot run in a herdr tab` : 'herdr is not available (run Claude inside herdr)' };
  if (canHeadless) return { mode: 'headless' };
  if (canTab) return { mode: 'tab' };
  return { mode: null, reason: herdr ? `${agent.harness} needs harnesses.${agent.harness}.headless in config` : `${agent.harness} needs a herdr tab (run Claude inside herdr) or a headless template` };
}

/** Above the threshold, Claude-plan agents sit out the cheap tiers so the plan is kept for frontier work and judges. */
export function claudeSaving(cfg, tier, claude) {
  const pct = cfg.routing?.['claude-limit-pct'] ?? 85;
  const tiers = cfg.routing?.['spare-claude-tiers'] || ['grunt', 'standard'];
  const used = Math.max(claude?.fiveHour?.percent ?? 0, claude?.sevenDay?.percent ?? 0);
  return pct > 0 && tiers.includes(tier) && used >= pct ? used : null;
}

export function pickAgent(cfg, tier, { detected = {}, herdr = false, quota = {}, now = Date.now(), claude = null } = {}) {
  const list = cfg.routing?.tiers?.[tier];
  if (!list) return { agentId: null, tier, skipped: [{ agent: '-', reason: `no tier "${tier}" in routing.tiers` }] };
  const saving = claudeSaving(cfg, tier, claude);
  if (saving !== null) {
    const r = pickFrom(cfg, tier, list, { detected, herdr, quota, now, skipClaude: saving });
    if (r.agentId) return r;
    const fallback = pickFrom(cfg, tier, list, { detected, herdr, quota, now });
    return { ...fallback, skipped: [...r.skipped, ...fallback.skipped], note: `Claude plan at ${saving}% but no other agent could take this; using Claude anyway.` };
  }
  return pickFrom(cfg, tier, list, { detected, herdr, quota, now });
}

function pickFrom(cfg, tier, list, { detected, herdr, quota, now, skipClaude = null }) {
  const skipped = [];
  for (const id of list) {
    const agent = cfg.agents?.[id];
    if (!agent) { skipped.push({ agent: id, reason: 'not defined under agents' }); continue; }
    const pol = policyBlocks(cfg, agent);
    if (pol) { skipped.push({ agent: id, reason: pol }); continue; }
    if (skipClaude !== null && cfg.providers?.[agent.provider]?.type === 'claude-login') { skipped.push({ agent: id, reason: `Claude plan at ${skipClaude}%: kept for frontier work and judges` }); continue; }
    const q = quota[id];
    if (q && Date.parse(q.until) > now) { skipped.push({ agent: id, reason: `cooling down until ${q.until} (${q.reason})` }); continue; }
    const m = modeFor(cfg, agent, { detected, herdr });
    if (!m.mode) { skipped.push({ agent: id, reason: m.reason }); continue; }
    return { agentId: id, agent, tier, mode: m.mode, skipped };
  }
  return { agentId: null, tier, skipped, wait: (cfg.routing?.['on-quota-out'] || '').includes('wait') };
}
