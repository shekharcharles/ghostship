// The autonomy scorecard: how much of a project ran on its own, read from the records Ghostship already keeps
// (events.jsonl, state.decisions, the owner queue, per-session spend). `text` for the terminal, `markdown` for the release packet.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, eventsPath } from './store.mjs';
import { loadConfig } from './config.mjs';
import { RUNS_DIR } from './paths.mjs';

const readJson = (p, dflt) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return dflt; } };

function events(root) {
  const p = eventsPath(root);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const OWNER_VIAS = new Set(['tty', 'bridge', 'chat']);
const ownerGate = (ev) => OWNER_VIAS.has(ev?.data?.gate?.via);

export function scorecard(root) {
  const state = load(root);
  const cfg = loadConfig(root);
  const evs = events(root);
  const tasks = Object.values(state.tasks || {});
  const decisions = state.decisions || [];
  const asksDb = readJson(join(root, RUNS_DIR, 'asks.json'), { asks: [] });
  const asks = asksDb.asks || [];
  const sessions = readJson(join(root, '.ghostship/usage/sessions.json'), {});

  const prdAt = evs.find((e) => e.type === 'prd.approve')?.at || null;
  const after = (at) => prdAt && at && Date.parse(at) > Date.parse(prdAt);

  const gates = { prd: 0, acceptance: 0, release: 0, decide: 0, go: 0 };
  for (const e of evs) {
    if (e.type === 'prd.approve' && ownerGate(e)) gates.prd += 1;
    if (e.type === 'acceptance.approve' && ownerGate(e)) gates.acceptance += 1;
    if (e.type === 'release.approve' && ownerGate(e)) gates.release += 1;
    if ((e.type === 'human.grant' || e.type === 'human.drop') && ownerGate(e)) gates.decide += 1;
  }
  gates.decide = Math.max(gates.decide, decisions.filter((d) => OWNER_VIAS.has(d.gate?.via)).length);
  gates.go = evs.filter((e) => e.type === 'helm.go' || e.type === 'go').length;

  const judgeFails = evs.filter((e) => e.type === 'task.verdict' && e.data?.result === 'FAIL').length;
  const attemptsTotal = tasks.reduce((n, t) => n + (t.attempt || 0), 0);
  const autoGrants = decisions.filter((d) => d.gate?.via === 'autopilot').length;

  const asksAfterPrd = asks.filter((a) => a.source === 'agent' && after(a.at)).length;
  const decidesAfterPrd = decisions.filter((d) => OWNER_VIAS.has(d.gate?.via) && after(d.at)).length;

  const first = evs[0]?.at || null, last = evs.at(-1)?.at || null;
  const taskMs = tasks.filter((t) => t.merged?.at).map((t) => {
    const start = evs.find((e) => e.type === 'task.start' && e.ref === t.id)?.at;
    return start ? Date.parse(t.merged.at) - Date.parse(start) : null;
  }).filter((x) => x !== null && x >= 0);
  const usdTotal = Math.round(Object.values(sessions).reduce((n, s) => n + (Number(s.usd) || 0), 0) * 100) / 100;
  const merged = tasks.filter((t) => t.status === 'MERGED').length;

  return {
    autonomy: { mode: cfg.autonomy?.mode || 'autopilot' },
    tasks: { total: tasks.length, merged, parked: tasks.filter((t) => t.status === 'PARKED').length, dropped: tasks.filter((t) => t.status === 'DROPPED').length },
    attempts: { total: attemptsTotal, autoGrants, judgeFails },
    asks: { filed: asks.filter((a) => a.source === 'agent').length, answered: asks.filter((a) => a.status === 'answered').length, openNow: asks.filter((a) => a.status === 'open').length },
    ownerGates: gates,
    questionsAfterPrd: asksAfterPrd + decidesAfterPrd,
    timeMs: { firstEvent: first, lastEvent: last, total: first && last ? Date.parse(last) - Date.parse(first) : 0, perTaskAvg: taskMs.length ? Math.round(taskMs.reduce((a, b) => a + b, 0) / taskMs.length) : null },
    usd: { total: usdTotal, perTask: merged ? Math.round((usdTotal / merged) * 100) / 100 : null },
  };
}

const mins = (ms) => (ms == null ? '-' : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`);
const gateLine = (g) => Object.entries(g).filter(([, n]) => n).map(([k, n]) => `${k} ×${n}`).join(', ') || 'none';

export function text(sc) {
  return [
    `autonomy: ${sc.autonomy.mode}`,
    `tasks: ${sc.tasks.merged}/${sc.tasks.total} merged · ${sc.tasks.parked} parked · ${sc.tasks.dropped} dropped`,
    `attempts: ${sc.attempts.total} (${sc.attempts.autoGrants} auto-granted, ${sc.attempts.judgeFails} judge fails)`,
    `asks: ${sc.asks.filed} filed · ${sc.asks.answered} answered · ${sc.asks.openNow} open`,
    `owner gates: ${gateLine(sc.ownerGates)}`,
    `questions after the PRD: ${sc.questionsAfterPrd}`,
    `time: ${mins(sc.timeMs.total)} total · ${mins(sc.timeMs.perTaskAvg)} per task`,
    `spend: $${sc.usd.total.toFixed(2)} total${sc.usd.perTask != null ? ` · $${sc.usd.perTask.toFixed(2)} per task` : ''}`,
  ].join('\n');
}

export function markdown(sc) {
  return [
    '## Autonomy scorecard',
    '| measure | value |', '|---|---|',
    `| mode | ${sc.autonomy.mode} |`,
    `| tasks | ${sc.tasks.merged}/${sc.tasks.total} merged, ${sc.tasks.parked} parked, ${sc.tasks.dropped} dropped |`,
    `| attempts | ${sc.attempts.total} (${sc.attempts.autoGrants} auto-granted, ${sc.attempts.judgeFails} judge fails) |`,
    `| asks for the owner | ${sc.asks.filed} filed, ${sc.asks.answered} answered, ${sc.asks.openNow} open |`,
    `| owner gates | ${gateLine(sc.ownerGates)} |`,
    `| questions after the PRD | ${sc.questionsAfterPrd} |`,
    `| time | ${mins(sc.timeMs.total)} total, ${mins(sc.timeMs.perTaskAvg)} per task |`,
    `| spend | $${sc.usd.total.toFixed(2)} total${sc.usd.perTask != null ? `, $${sc.usd.perTask.toFixed(2)} per task` : ''} |`,
    '',
  ].join('\n');
}
