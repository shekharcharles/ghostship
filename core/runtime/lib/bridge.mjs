// What the Bridge mod (and its fallbacks: status line script, gs watch) reads and writes:
// heartbeat, logbook, per-session spend, alerts, pause flag, and the handoff note for clear-and-resume.
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { load, exists as stateExists } from './store.mjs';
import { status, settleDecisions } from './engine.mjs';
import { loadConfig } from './config.mjs';
import { readActive, alive } from './runs.mjs';
import { RUNS_DIR, HANDOFF_DIR } from './paths.mjs';
import { list as listAsks } from './asks.mjs';
import { next as nextStep } from './next.mjs';
import { statusOf as autopilotStatus } from './autopilot.mjs';

const P = {
  heartbeat: `${RUNS_DIR}/heartbeat.json`,
  last: `${RUNS_DIR}/bridge-last.json`,
  alerts: `${RUNS_DIR}/alerts.jsonl`,
  pause: `${RUNS_DIR}/pause.json`,
  logbook: '.ghostship/usage/logbook.jsonl',
  sessions: '.ghostship/usage/sessions.json',
  handoff: `${HANDOFF_DIR}/HANDOFF.md`,
};
export const BRIDGE_PATHS = P;

const readJson = (root, rel, dflt) => { try { return JSON.parse(readFileSync(join(root, rel), 'utf8')); } catch { return dflt; } };
const writeJson = (root, rel, v) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), JSON.stringify(v, null, 2) + '\n'); };
const appendLine = (root, rel, v) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); appendFileSync(join(root, rel), JSON.stringify(v) + '\n'); };

// ---------------------------------------------------------------- owner key: a Bridge press is the owner's own act
// The installer writes ~/.ghostship/bridge.key (owner-only). The Bridge mod reads it and hands it to the CLI on stdin, so a
// press in the pane can approve when approvals.mode is "bridge". Agents never read it (guard + riskhold), and it never
// reaches an environment variable, a command line or a log.

export const ownerKeyPath = (home) => join(home || process.env.GHOSTSHIP_HOME || homedir(), '.ghostship', 'bridge.key');

export function ownerKeyOk(given, home) {
  let want;
  try { want = readFileSync(ownerKeyPath(home), 'utf8').trim(); } catch { return false; }
  const g = Buffer.from(String(given || '').trim());
  const w = Buffer.from(want);
  return w.length >= 32 && g.length === w.length && timingSafeEqual(g, w);
}

// ---------------------------------------------------------------- helm: pause / go

export function paused(root) { return readJson(root, P.pause, null); }
export function pause(root, reason = 'paused by the owner') { const v = { at: new Date().toISOString(), reason }; writeJson(root, P.pause, v); return v; }
export function go(root) { rmSync(join(root, P.pause), { force: true }); return true; }

// ---------------------------------------------------------------- autonomy settings and night shift

const AUTONOMY = { mode: 'autopilot', 'auto-retries': 1, 'night-shift': false, 'night-shift-at': 90 };
export function autonomyOf(cfg) { return { ...AUTONOMY, ...(cfg?.autonomy || {}) }; }

/**
 * Night shift: with autonomy.night-shift on, new work pauses when the Claude plan's 5h use reaches night-shift-at and
 * resumes by itself after the 5h window resets (or once use falls well below the line). Only its own pauses resume
 * themselves: a pause the owner made waits for the owner.
 */
export function nightShift(root, cfg, now = Date.now()) {
  const a = autonomyOf(cfg);
  const pz = paused(root);
  const five = claudeLimits(root)?.fiveHour || null;
  if (pz?.kind === 'night-shift') {
    const due = pz.resumeAt && now >= Date.parse(pz.resumeAt);
    const eased = five && five.percent < a['night-shift-at'] - 20;
    if (due || eased || !a['night-shift']) {
      go(root);
      raise(root, 'night shift over: resuming', 'info');
      return 'resumed';
    }
    return 'paused';
  }
  if (!a['night-shift'] || pz || !five || five.percent < a['night-shift-at']) return null;
  // A reset time already past means the reading is stale: wait for a fresh one rather than pause and resume in a loop.
  if (five.resetsAt && Date.parse(five.resetsAt) <= now) return null;
  const at = five.resetsAt ? new Date(five.resetsAt) : null;
  const when = at ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : 'after the 5h reset';
  writeJson(root, P.pause, { at: new Date(now).toISOString(), reason: `night shift: 5h at ${Math.round(five.percent)}%, resumes ${when}`, kind: 'night-shift', resumeAt: five.resetsAt || null });
  raise(root, `night shift: Claude plan 5h at ${Math.round(five.percent)}%; new work waits until ${when}`, 'info');
  return 'paused';
}

// ---------------------------------------------------------------- alerts

export function raise(root, text, level = 'info', extra = {}) {
  const a = { at: new Date().toISOString(), level, alert: text, ...extra };
  appendLine(root, P.alerts, a);
  return a;
}

export function alertsSince(root, n = 0) {
  if (!existsSync(join(root, P.alerts))) return { alerts: [], cursor: 0 };
  const lines = readFileSync(join(root, P.alerts), 'utf8').split('\n').filter(Boolean);
  const alerts = lines.slice(n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { alerts, cursor: lines.length };
}

/** Turns changes since the last tick into alerts: new decisions needed, a run that ended, a release waiting for STOP 2. */
function derive(root, s, run) {
  const last = readJson(root, P.last, { needs: [], run: null, release: null, stage: null });
  const out = [];
  for (const id of s.needsDecision) if (!last.needs.includes(id)) out.push(raise(root, `${id} needs your decision`, 'action', { task: id }));
  if (run && run.status !== 'running' && last.run?.runId === run.runId && last.run.status === 'running') {
    out.push(raise(root, `${run.role} run for ${run.task || 'plan'} ended: ${run.status}`, run.status === 'done' ? 'info' : 'warn', { runId: run.runId }));
  }
  if (s.release && !last.release) out.push(raise(root, `v${s.release.version} is ready for STOP 2 (${s.release.result})`, 'action'));
  if (s.stage !== last.stage && last.stage) out.push(raise(root, `stage: ${last.stage} → ${s.stage}`, 'info'));
  writeJson(root, P.last, { needs: s.needsDecision, run: run ? { runId: run.runId, status: run.status } : null, release: s.release, stage: s.stage });
  return out;
}

// ---------------------------------------------------------------- Claude plan limits (5h / 7d), with burn rate

/** Normalise rate-limit readings from the mod ({kind, percentUsed, resetsAt}) or the status line ({window, percent, resetsAt}). */
export function normLimits(list = []) {
  const out = {};
  for (const r of list || []) {
    const k = String(r.kind || r.window || '').toLowerCase();
    const key = /five|5h|5_h|hour/.test(k) ? 'fiveHour' : /seven|7d|week/.test(k) ? 'sevenDay' : null;
    const pct = r.percentUsed ?? r.percent;
    if (key && typeof pct === 'number') out[key] = { percent: Math.round(pct * 10) / 10, resetsAt: r.resetsAt || null };
  }
  return out;
}

export function claudeLimits(root) {
  const hb = readJson(root, P.heartbeat, null);
  if (!hb?.limits || Date.now() - Date.parse(hb.at) > 6 * 3600e3) return null;
  return hb.limits;
}

function burn(samples, key) {
  const pts = samples.filter((x) => x[key] !== undefined && Date.now() - x.t < 3600e3);
  if (pts.length < 2) return null;
  const a = pts[0], b = pts.at(-1);
  const h = (b.t - a.t) / 3600e3;
  return h > 0.05 && b[key] >= a[key] ? Math.round(((b[key] - a[key]) / h) * 10) / 10 : null;
}

// ---------------------------------------------------------------- tick: heartbeat + logbook + spend + snapshot

export function tick(root, { usage = null, turn = null, sessionId = null, source = 'mod', since = 0 } = {}) {
  if (!stateExists(root)) return { active: false };
  const cfg = loadConfig(root);
  const limits = cfg.loop?.['handoff-tokens'] || { soft: 150000, hard: 200000 };
  const now = new Date().toISOString();
  if (usage) {
    const prev = readJson(root, P.heartbeat, {});
    const limits = normLimits(usage.rateLimits);
    const samples = [...(prev.samples || []), { t: Date.now(), f: limits.fiveHour?.percent, s: limits.sevenDay?.percent }].filter((x) => Date.now() - x.t < 3600e3).slice(-60);
    if (limits.fiveHour) limits.fiveHour.burnPerHour = burn(samples, 'f');
    if (limits.sevenDay) limits.sevenDay.burnPerHour = burn(samples, 's');
    writeJson(root, P.heartbeat, { at: now, source, sessionId, tokens: usage.context?.tokens ?? null, window: usage.context?.window ?? null, percent: usage.context?.percent ?? null, usd: usage.cost?.usd ?? null, rateLimits: usage.rateLimits || [], limits: Object.keys(limits).length ? limits : (prev.limits || null), samples });
    if (sessionId && usage.cost?.usd !== undefined) {
      const ses = readJson(root, P.sessions, {});
      ses[sessionId] = { usd: usage.cost.usd, lastAt: now, startedAt: ses[sessionId]?.startedAt || now };
      writeJson(root, P.sessions, ses);
    }
  }
  if (turn) appendLine(root, P.logbook, { at: now, sessionId, ...turn, tokens: usage?.context?.tokens ?? null });
  try { nightShift(root, cfg); } catch { /* night shift is best effort */ }
  try { settleDecisions(root); } catch { /* the next tick tries again */ }
  let s;
  try { s = status(root); } catch (e) { return { active: true, error: e.message }; }
  let run = readActive(root);
  if (run?.status === 'running' && !alive(run.supervisorPid)) run = { ...run, status: 'lost' };
  derive(root, s, run);
  const { alerts, cursor } = alertsSince(root, since);
  const h = join(root, P.handoff);
  return {
    active: true, status: s, run: run ? { runId: run.runId, role: run.role, task: run.task, agentId: run.agentId, mode: run.mode, status: run.status, startedAt: run.startedAt, blocked: !!run.blocked } : null,
    alerts, cursor, paused: paused(root), limits, claude: claudeLimits(root), asks: safeAsks(root), keeper: cfg.loop?.keeper || 'auto', handoff: existsSync(h) ? { path: P.handoff, mtimeMs: statSync(h).mtimeMs } : null, project: cfg.project?.name,
    approvals: cfg.approvals?.mode || 'terminal', version: coreVersion(root), agents: agentsAtWork(root), author: cfg.project?.author || '', tagline: cfg.project?.tagline || '', ...overview(root), spend: projectSpend(root),
    autonomy: (() => { const a = autonomyOf(cfg); return { mode: a.mode, nightShift: !!a['night-shift'], nightShiftAt: a['night-shift-at'], autoRetries: a['auto-retries'] }; })(),
    autopilot: safeAutopilot(root), next: safeNext(root),
  };
}

// The headless autopilot runner, if one was started here, and the one step `next()` names now.
function safeAutopilot(root) { try { const r = autopilotStatus(root); return r ? { status: r.status, pid: r.pid || null, step: r.step || 0, last: r.last || null, reason: r.reason || null, startedAt: r.startedAt || null } : null; } catch { return null; } }
function safeNext(root) { try { const n = nextStep(root); return { kind: n.kind, id: n.id, say: n.say, why: n.why, task: n.task || null, command: n.command || null, role: n.role || null }; } catch { return null; } }

// Builders, judges and planners seen working in the last 5 minutes (the guard records each tool call they make).
function agentsAtWork(root, now = Date.now()) {
  const beats = readJson(root, `${RUNS_DIR}/agents.json`, {});
  return Object.entries(beats).filter(([, b]) => b && now - b.at < 5 * 60000)
    .map(([type, b]) => ({ role: type.replace(/^ghostship-/, ''), step: b.step || 'working', at: b.at }));
}

// Claude spend on this project from its first session to now: every session's last reported cost, summed.
function projectSpend(root) { try { const r = spend(root); return { usd: r.claudeUsd, sessions: r.sessions }; } catch { return null; } }

// What the Bridge pane draws beyond status: the task board and the interview's progress.
function overview(root) {
  try {
    const state = load(root);
    const tasks = Object.values(state.tasks || {}).map((t) => ({ id: t.id, title: String(t.title || '').slice(0, 80), status: t.status, attempt: t.attempt || 0, max: t.maxAttempts || 0, blockedBy: t.blockedBy || [], checks: t.checks || [], phase: t.phase || null }));
    const areas = Object.values(state.interview?.areas || {});
    return { tasks, parked: tasks.filter((t) => t.status === 'PARKED').map((t) => t.id), interview: state.interview ? { closed: areas.filter((a) => a.state !== 'open').length, total: areas.length } : null };
  } catch { return { tasks: [], parked: [], interview: null }; }
}

function coreVersion(root) { try { return readFileSync(join(root, '.ghostship/core/VERSION'), 'utf8').trim(); } catch { return null; } }

// ---------------------------------------------------------------- spend

function safeAsks(root) { try { return listAsks(root).map((a) => ({ id: a.id, kind: a.kind, title: a.title, why: a.why || '', doneWhen: a.doneWhen || '', options: a.options || [], source: a.source, at: a.at || null, gate: a.ref?.action || null, task: a.ref?.task || null, command: a.command || null })); } catch { return []; } }

export function spend(root) {
  const ses = readJson(root, P.sessions, {});
  const claudeUsd = Object.values(ses).reduce((a, s) => a + (Number(s.usd) || 0), 0);
  let gwIn = 0, gwOut = 0, gwCalls = 0;
  try {
    for (const l of readFileSync(join(root, '.ghostship/usage/gateway.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(l); gwIn += e.input_tokens || 0; gwOut += e.output_tokens || 0; gwCalls += 1;
    }
  } catch { /* none */ }
  let runMs = 0, runs = 0;
  try { for (const l of readFileSync(join(root, '.ghostship/usage/runs.jsonl'), 'utf8').split('\n').filter(Boolean)) { const e = JSON.parse(l); runMs += e.durationMs || 0; runs += 1; } } catch { /* none */ }
  return { claudeUsd: Math.round(claudeUsd * 100) / 100, sessions: Object.keys(ses).length, gateway: { calls: gwCalls, inputTokens: gwIn, outputTokens: gwOut }, outsideRuns: { runs, minutes: Math.round(runMs / 60000) } };
}

// ---------------------------------------------------------------- keeper: handoff note

export function handoff(root, { note = '', reason = 'context limit' } = {}) {
  const s = status(root);
  const state = load(root);
  const run = readActive(root);
  const recent = [];
  try {
    const lines = readFileSync(join(root, '.ghostship/state/events.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-12);
    for (const l of lines) { const e = JSON.parse(l); recent.push(`- ${e.at} ${e.type}${e.ref ? ` ${e.ref}` : ''}`); }
  } catch { /* none */ }
  const act = s.active ? state.tasks[s.active.id] : null;
  const md = [
    `# Handoff — ${new Date().toISOString()}`, '', `Reason: ${reason}.`, '',
    '| item | value |', '|---|---|',
    `| stage | ${s.stage} |`,
    `| active task | ${act ? `${act.id} ${act.title} — ${act.status}, attempt ${act.attempt}/${act.maxAttempts}, branch ${act.branch}` : 'none'} |`,
    `| outside run | ${run ? `${run.runId} ${run.status} (${run.agentId}, ${run.mode})` : 'none'} |`,
    `| needs a decision | ${s.needsDecision.join(', ') || 'nothing'} |`,
    `| next step | ${s.next} |`, '',
    '## What I was doing', note.trim() || '_No note was left. Start from the next step above._', '',
    '## Last events', ...(recent.length ? recent : ['- none']), '',
    'Resume with `/ghostship resume`. State on disk is the truth; this note is only a pointer.', '',
  ].join('\n');
  mkdirSync(join(root, HANDOFF_DIR), { recursive: true });
  writeFileSync(join(root, P.handoff), md);
  return { path: P.handoff };
}

export function untilText(iso) {
  const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

// ---------------------------------------------------------------- the status line: two coloured lines under the prompt
// Line 1, the voyage: project, the stages around the current one with its progress bar, the task in hand.
// Line 2, the owner: what waits for you first, then context, the plan's 5h/7d with reset, and spend as bars (claude-deck style).
const LEGS = [['Discover', ['new', 'adopt']], ['Design', ['design']], ['Checks', ['acceptance'], 1], ['Plan', ['plan']], ['Build', ['build']], ['Release', ['release'], 2]];
const paint = (on) => {
  const c = (code) => (t) => (on ? `\x1b[${code}m${t}\x1b[0m` : String(t));
  return { accent: c('38;5;209'), ok: c('32'), warn: c('33'), err: c('31'), info: c('36'), dim: c('2'), bold: c('1') };
};
const bar = (f, w) => { const n = Math.max(0, Math.min(w, Math.round(Math.max(0, Math.min(1, f)) * w))); return ['▰'.repeat(n), '▱'.repeat(w - n)]; };

export function statusBand(snap, usage = {}, { color = !process.env.NO_COLOR, now = Date.now() } = {}) {
  if (!snap?.active) return '';
  const P = paint(color);
  const s = snap.status || {};
  const at = Math.max(0, LEGS.findIndex(([, st]) => st.includes(s.stage)));
  const live = (snap.tasks || []).filter((t) => t.status !== 'DROPPED');
  const prog = (s.stage === 'new' || s.stage === 'adopt') && snap.interview?.total ? [snap.interview.closed, snap.interview.total]
    : ['plan', 'build', 'release'].includes(s.stage) && live.length ? [live.filter((t) => t.status === 'MERGED').length, live.length] : null;
  const legs = [];
  LEGS.forEach(([label, , stop], i) => {
    if (Math.abs(i - at) > 1) return;
    if (legs.length) legs.push(P.dim(i <= at ? ' ━ ' : ' ─ '));
    if (i < at) legs.push(P.ok(`✓ ${label}`));
    else if (i === at) {
      // A square turning round while a task is being built (Claude Code redraws the status line as work goes on).
      const turning = s.active && ['BUILDING', 'RETRY', 'JUDGING'].includes(s.active.status) && !snap.paused;
      legs.push(turning ? P.bold(P.ok(`${'◰◳◲◱'[Math.floor(now / 500) % 4]} ${label}`)) : P.bold(P.accent(`◉ ${label}`)));
      if (prog) { const [on, off] = bar(prog[0] / prog[1], 6); legs.push(` ${P.accent(on)}${P.dim(off)} ${prog[0]}/${prog[1]}`); }
    } else legs.push(P.dim(`${stop ? '◆' : '○'} ${label}`));
  });
  const l1 = [P.bold(P.accent(`⛴ ${snap.project || 'ghostship'}`)), legs.join('')];
  if (snap.paused) l1.push(P.warn('⏸ paused'));
  if (s.active) {
    const dots = s.active.max <= 6 ? '●'.repeat(Math.min(s.active.attempt, s.active.max)) + '○'.repeat(Math.max(0, s.active.max - s.active.attempt)) : `${s.active.attempt}/${s.active.max}`;
    const verb = { BUILDING: 'building', JUDGING: 'with the judge', PASSED: 'passed', RETRY: 'retrying' }[s.active.status] || s.active.status.toLowerCase();
    l1.push(`${P.bold(s.active.id)} ${s.active.status === 'JUDGING' ? P.info('⚖') : P.accent('◐')} ${P.dim(dots)} ${P.dim(verb)}`);
  }
  if (snap.run?.status === 'running') l1.push(snap.run.blocked ? P.warn(`◆ ${snap.run.agentId} needs you in its tab`) : P.dim(`◆ ${snap.run.agentId} running`));

  const tone = (pct) => (pct >= 85 ? P.err : pct >= 65 ? P.warn : P.ok);
  const meter = (label, pct, extra = '') => { const [on, off] = bar(pct / 100, 5); return `${P.dim(label)} ${tone(pct)(on)}${P.dim(off)} ${pct >= 65 ? tone(pct)(`${Math.round(pct)}%`) : `${Math.round(pct)}%`}${extra ? P.dim(` ${extra}`) : ''}`; };
  const l2 = [];
  const asks = snap.asks || [];
  if (asks.length) {
    const first = asks[0];
    const name = first.id.startsWith('G-') ? first.title : `#${first.id} ${first.title}`;
    l2.push(P.bold(P.warn(`☐ ${asks.length} for you`)) + P.warn(`: ${name.length > 42 ? `${name.slice(0, 41)}…` : name}`) + P.dim(' · /gs-bridge'));
  } else l2.push(P.ok('✓ nothing waiting for you'));
  if (usage.context?.percent != null) l2.push(meter('ctx', usage.context.percent));
  const c = snap.claude;
  if (c?.fiveHour) l2.push(meter('5h', c.fiveHour.percent, c.fiveHour.resetsAt ? `↻${untilText(c.fiveHour.resetsAt)}` : ''));
  if (c?.sevenDay) l2.push(meter('7d', c.sevenDay.percent));
  const proj = snap.spend?.usd;
  if (usage.cost?.usd != null || proj != null) {
    const bits = [];
    if (usage.cost?.usd != null) bits.push(`${P.dim('session')} $${usage.cost.usd.toFixed(2)}`);
    if (proj != null) bits.push(`${P.dim('project')} ${P.bold(`$${proj.toFixed(2)}`)}`);
    l2.push(bits.join(P.dim(' · ')));
  }
  return `${l1.join('   ')}\n${l2.join('   ')}`;
}

export function band(snap) {
  if (!snap?.active) return '';
  const s = snap.status || {};
  const parts = [`⛴ ${snap.project || 'ghostship'}`, s.stage];
  if (snap.paused) parts.push('⏸ paused');
  if (s.active) parts.push(`${s.active.id} ${s.active.status} ${s.active.attempt}/${s.active.max}`);
  if (snap.run && snap.run.status === 'running') parts.push(`run ${snap.run.agentId}${snap.run.blocked ? ' ⚠ waiting for you' : ''}`);
  if (s.needsDecision?.length) parts.push(`⚑ decide ${s.needsDecision.join(',')}`);
  if (snap.asks?.length) parts.push(`☐ ${snap.asks.length} for you`);
  const c = snap.claude;
  if (c?.fiveHour) parts.push(`5h ${Math.round(c.fiveHour.percent)}%${c.fiveHour.resetsAt ? ` ↻${untilText(c.fiveHour.resetsAt)}` : ''}`);
  if (c?.sevenDay) parts.push(`7d ${Math.round(c.sevenDay.percent)}%`);
  parts.push(`next: ${s.next}`);
  return parts.filter(Boolean).join(' · ');
}
