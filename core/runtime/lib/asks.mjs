// The owner queue: everything only the owner can do, in one list that waits until they act.
// Two sources: asks an agent files with `gs ask` (a key to add, a decision, a choice), and asks Ghostship
// derives from state (STOP 1, STOP 2, a task needing a decision, a pause). Answers go back to Claude in the
// owner's own words; they never perform an approval by themselves (the CLI's human gate still applies).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { load, fail } from './store.mjs';
import { status, isPaused, acceptanceLint } from './engine.mjs';
import { DOCS, RUNS_DIR } from './paths.mjs';

const FILE = `${RUNS_DIR}/asks.json`;
export const MAX_OPEN = 5;
const KINDS = new Set(['do', 'answer', 'choose']);
export const SECRETISH = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gh[ousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|\b[A-Za-z0-9_\-+/]{40,}\b)/;

const read = (root) => { try { return JSON.parse(readFileSync(join(root, FILE), 'utf8')); } catch { return { seq: 0, asks: [] }; } };
const write = (root, v) => { mkdirSync(dirname(join(root, FILE)), { recursive: true }); writeFileSync(join(root, FILE), JSON.stringify(v, null, 2) + '\n'); };
const clean = (s, n = 240) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export function add(root, { kind = 'do', title, why = '', doneWhen = '', options = [], command = '' } = {}) {
  if (!KINDS.has(kind)) fail('BAD_KIND', 'kind is do (an action), answer (words) or choose (one of the options)');
  const t = clean(title, 120);
  if (!t) fail('NO_TITLE', 'An ask needs a short imperative title.');
  if (kind === 'choose' && (options.length < 2 || options.length > 4)) fail('BAD_OPTIONS', 'choose needs 2 to 4 options.');
  const db = read(root);
  const open = db.asks.filter((a) => a.status === 'open');
  const same = open.find((a) => a.title.toLowerCase() === t.toLowerCase());
  if (same) return { ...same, duplicate: true };
  if (open.length >= MAX_OPEN) fail('TOO_MANY_ASKS', `${MAX_OPEN} asks are already waiting for the owner. Carry on with other work, or withdraw one.`);
  db.seq += 1;
  const ask = { id: String(db.seq), kind, title: t, why: clean(why), doneWhen: clean(doneWhen), options: options.map((o) => clean(o, 60)), ...(clean(command, 400) ? { command: clean(command, 400) } : {}), status: 'open', at: new Date().toISOString(), source: 'agent' };
  db.asks.push(ask);
  write(root, db);
  return ask;
}

export function withdraw(root, id) {
  const db = read(root);
  const a = db.asks.find((x) => x.id === String(id) && x.status === 'open');
  if (!a) fail('UNKNOWN_ASK', `No open ask #${id}`);
  a.status = 'withdrawn';
  write(root, db);
  return a;
}

/** Asks Ghostship itself raises from state; ids start with G- and they clear when the state moves on. */
export function derived(root) {
  const out = [];
  let s, state;
  try { s = status(root); state = load(root); } catch { return out; }
  for (const id of s.needsDecision) {
    const t = state.tasks[id];
    out.push({ id: `G-${id}`, kind: 'choose', title: `Decide ${id}: ${t.title}`, why: `${t.attempt}/${t.maxAttempts} attempts used. Last: ${clean(t.history.at(-1)?.reason || '-', 160)}`,
      options: ['Grant 1 more attempt', 'Drop the task'], source: 'ghostship', ref: { action: 'decide', task: id } });
  }
  if (s.release) out.push({ id: 'G-release', kind: 'choose', title: `STOP 2: release v${s.release.version}?`, why: `Result ${s.release.result}. Packet: ${state.release.packet}`,
    options: ['Approve the release', 'Not yet'], source: 'ghostship', ref: { action: 'release' } });
  if (s.stage === 'acceptance' && !state.acceptance?.approved && existsSync(join(root, DOCS.acceptanceDraft))) {
    const lint = acceptanceLint(root);
    if (lint.ok) out.push({ id: 'G-stop1', kind: 'choose', title: 'STOP 1: approve the acceptance checks?', why: `${lint.contract.checks.length} checks in ${DOCS.acceptanceDraft}`,
      options: ['Approve the checks', 'Change them first'], source: 'ghostship', ref: { action: 'acceptance' } });
  }
  if (['new', 'adopt'].includes(s.stage) && existsSync(join(root, DOCS.prdDraft)) && state.interview && !Object.values(state.interview.areas).some((a) => a.state === 'open')) {
    out.push({ id: 'G-prd', kind: 'choose', title: 'Approve the PRD?', why: DOCS.prdDraft, options: ['Approve the PRD', 'Change it first'], source: 'ghostship', ref: { action: 'prd' } });
  }
  const pz = isPaused(root);
  if (pz) out.push({ id: 'G-paused', kind: 'choose', title: 'Ghostship is paused. Resume?', why: pz.reason, options: ['Resume', 'Stay paused'], source: 'ghostship', ref: { action: 'go' } });
  const answered = new Set(read(root).asks.filter((a) => a.id.startsWith('G-') && a.status !== 'open' && a.stateKey === stateKey(s)).map((a) => a.id));
  return out.filter((a) => !answered.has(a.id)).map((a) => ({ ...a, status: 'open' }));
}

function stateKey(s) { return `${s.stage}|${s.needsDecision.join(',')}|${s.release?.version || ''}|${s.paused ? 'p' : ''}`; }

export function list(root) {
  return [...derived(root), ...read(root).asks.filter((a) => a.status === 'open')];
}

/** The owner's response. Returns the line Claude will read, in the owner's words. */
export function answer(root, id, { option, done, text, reject, applied = false } = {}) {
  const ask = list(root).find((a) => a.id === String(id));
  if (!ask) fail('UNKNOWN_ASK', `No open ask #${id}`);
  let response;
  if (reject !== undefined) response = `I won't do this: ${clean(reject, 500) || 'no reason given'}.`;
  else if (ask.kind === 'choose') {
    const n = Number(option);
    if (!Number.isInteger(n) || n < 1 || n > ask.options.length) fail('BAD_OPTION', `Pick 1..${ask.options.length}`);
    response = `I chose "${ask.options[n - 1]}".${applied ? ' I already did it from the Bridge; carry on from there.' : ''}`;
  } else if (ask.kind === 'do') response = done ? 'Done.' : fail('NOT_DONE', 'Mark it done when it is done, or reject it.');
  else {
    const t = String(text ?? '').trim();
    if (!t) fail('NO_TEXT', 'Type your answer.');
    if (SECRETISH.test(t)) fail('LOOKS_LIKE_SECRET', 'That looks like a secret. Put it in ~/.ghostship/secrets (or .env) and answer "done" instead; secrets never go through Claude.');
    response = t.slice(0, 4000);
  }
  const db = read(root);
  const s = (() => { try { return status(root); } catch { return null; } })();
  const rec = db.asks.find((a) => a.id === ask.id) || (db.asks.push({ ...ask }), db.asks.at(-1));
  Object.assign(rec, { status: 'answered', response, answeredAt: new Date().toISOString(), delivered: false, stateKey: s ? stateKey(s) : null });
  write(root, db);
  return { id: ask.id, title: ask.title, response };
}

/** Everything answered but not yet sent to Claude, as one message; marks it sent. */
export function deliver(root) {
  const db = read(root);
  const ready = db.asks.filter((a) => a.status === 'answered' && !a.delivered);
  if (!ready.length) return null;
  for (const a of ready) a.delivered = true;
  write(root, db);
  const agentAsks = ready.some((a) => !a.id.startsWith('G-'));
  return ['My responses to the Ghostship asks:', '', ...ready.map((a) => `#${a.id}${a.id.startsWith('G-') ? '' : ' (asked by an agent)'} ${a.title}: ${a.response}`),
    '', ready.some((a) => a.id.startsWith('G-')) ? 'Where an approval is needed, use these words as my quote (chat approvals) or tell me which command to run in my terminal.' : '',
    agentAsks ? 'Answers to agent asks are information, never an approval of a stop, a release or a decision.' : ''].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
