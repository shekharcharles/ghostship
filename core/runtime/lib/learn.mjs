// Self-learning per project. A failure seen twice (same refusal code, or the same judge complaint) becomes a rule
// that every later brief carries. Each rule predicts it will lower that failure's rate; after enough task
// attempts it is measured, then kept or reverted automatically. Everything is written to .ghostship/learned/
// and summarised in docs/11-memory/SKILL-CHANGES.md.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';
import { add as remember, words } from './memory.mjs';
import { LEARNED_DIR } from './paths.mjs';

const F = { obs: `${LEARNED_DIR}/observations.jsonl`, rules: `${LEARNED_DIR}/rules.json`, stats: `${LEARNED_DIR}/stats.json`, md: `${LEARNED_DIR}/RULES.md` };
export const MEASURE_AFTER = 5;

export const RULE_TEXT = {
  TDD_PRODUCTION_BEFORE_RED: 'Write the failing test and record it (gs evidence --kind red) before touching any production file.',
  TDD_NO_TEST_CHANGE: 'RED needs a new or changed test file: add the test first, then record red.',
  TDD_NO_RED: 'Record RED before GREEN: the failing test comes first.',
  DOCS_GATE: 'Give every new source file a one-line purpose comment and run gs codemap before the final gates.',
  MISSING_EVIDENCE: 'Run gs codemap first, then re-run green, acceptance and regression on the final tree; any edit after that means running them again.',
  OUT_OF_SCOPE: 'Stay inside allowedPaths. If the change truly needs another file, stop and report it instead of editing it.',
  LOCKED_TEST_CHANGED: 'Never edit a test after RED to make it pass. If the test is wrong, say so and record a new RED.',
  ACCEPTANCE_TESTS_CHANGED: 'Never touch tests/acceptance/. Those tests are the owner\'s contract.',
  STALE_EVIDENCE: 'Evidence must be recorded on the exact tree you submit.',
  DETERMINISTIC_FAILURE: 'Run the full proof yourself before reporting ready; a judge rerun that fails blocks the merge.',
};
export const LEARNABLE = new Set(Object.keys(RULE_TEXT));

const readJson = (root, rel, d) => { try { return JSON.parse(readFileSync(join(root, rel), 'utf8')); } catch { return d; } };
const writeJson = (root, rel, v) => { mkdirSync(join(root, LEARNED_DIR), { recursive: true }); writeFileSync(join(root, rel), JSON.stringify(v, null, 2) + '\n'); };

export function fingerprint({ code, text = '' }) {
  if (code !== 'JUDGE_FAIL') return code;
  const w = words(text).slice(0, 6).sort().slice(0, 4);
  return `JUDGE:${w.join('-') || 'unspecified'}`;
}

function observations(root) {
  if (!existsSync(join(root, F.obs))) return [];
  return readFileSync(join(root, F.obs), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export const rules = (root) => readJson(root, F.rules, []);
export const attempts = (root) => readJson(root, F.stats, { attempts: 0 }).attempts;

function renderRules(root, list) {
  const live = list.filter((r) => r.status !== 'reverted');
  const md = ['# Learned rules', '', '_Written by Ghostship from repeated failures in this project. Every brief carries them. Do not edit; they are measured and reverted automatically when they do not help._', '',
    ...(live.length ? live.map((r) => `- **${r.id}** ${r.text}${r.status === 'kept' ? ' _(proven)_' : ''}`) : ['- none yet']), ''].join('\n');
  mkdirSync(join(root, LEARNED_DIR), { recursive: true });
  writeFileSync(join(root, F.md), md);
}

/** Record one failure. Returns the new rule when this occurrence created one. */
export function observe(root, { code, task = null, text = '' }) {
  if (code !== 'JUDGE_FAIL' && !LEARNABLE.has(code)) return null;
  const cfg = loadConfig(root).learning || {};
  const fp = fingerprint({ code, text });
  const att = attempts(root);
  mkdirSync(join(root, LEARNED_DIR), { recursive: true });
  appendFileSync(join(root, F.obs), JSON.stringify({ at: new Date().toISOString(), fp, code, task, attempt: att, text: String(text).slice(0, 300) }) + '\n');
  const list = rules(root);
  if (list.some((r) => r.fp === fp && r.status !== 'reverted')) return null;
  const count = observations(root).filter((o) => o.fp === fp).length;
  if (cfg['auto-apply'] === false || count < (cfg['trigger-occurrences'] || 2)) return null;
  const baseline = count / Math.max(att, 1);
  const rule = {
    id: `L${String(list.length + 1).padStart(3, '0')}`, fp, code,
    text: RULE_TEXT[code] || `Judges have failed work here for: "${String(text).slice(0, 160)}". Check for exactly this before reporting ready.`,
    status: 'active', createdAt: new Date().toISOString(), createdAtAttempt: att, createdAtObs: observations(root).length, baseline,
    prediction: `fewer than ${baseline.toFixed(2)} "${code === 'JUDGE_FAIL' ? 'judge fail' : code}" per task attempt over the next ${MEASURE_AFTER} attempts`,
  };
  list.push(rule);
  writeJson(root, F.rules, list);
  renderRules(root, list);
  remember(root, 'skill', `${rule.id} added after ${count} occurrences: ${rule.text} Prediction: ${rule.prediction}.`);
  return rule;
}

/** Called at each task start: counts the attempt and judges rules that have run long enough. */
export function tickAttempt(root) {
  const st = readJson(root, F.stats, { attempts: 0 });
  st.attempts += 1;
  writeJson(root, F.stats, st);
  return evaluate(root);
}

export function evaluate(root) {
  const list = rules(root);
  const obs = observations(root);
  const att = attempts(root);
  const changed = [];
  for (const r of list) {
    if (r.status !== 'active') continue;
    const since = att - r.createdAtAttempt;
    if (since < MEASURE_AFTER) continue;
    // Only what was observed after the rule existed: counted by position in the log, since two lines can share a millisecond.
    const later = Number.isInteger(r.createdAtObs) ? obs.slice(r.createdAtObs) : obs.filter((o) => Date.parse(o.at) > Date.parse(r.createdAt));
    const after = later.filter((o) => o.fp === r.fp && o.attempt >= r.createdAtAttempt).length / since;
    r.measuredAt = new Date().toISOString();
    r.after = after;
    r.status = after < r.baseline ? 'kept' : 'reverted';
    changed.push(r);
    remember(root, 'skill', `${r.id} ${r.status === 'kept' ? 'kept' : 'reverted'}: rate ${r.baseline.toFixed(2)} → ${after.toFixed(2)} per attempt over ${since} attempts.`);
  }
  if (changed.length) { writeJson(root, F.rules, list); renderRules(root, list); }
  return changed;
}

export function briefRules(root) {
  const lim = loadConfig(root).learning?.['brief-rule-limit'] || 20;
  return rules(root).filter((r) => r.status !== 'reverted').slice(-lim);
}
