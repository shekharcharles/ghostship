// Durable state: .ghostship/state/state.json + a hash-chained event log.
// Every mutation: load -> change -> append event -> atomic save (temp file + rename).
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sha256, FactoryError, nowIso } from './util.mjs';
import { STATE_DIR } from './paths.mjs';

const STATE_FILE = 'state.json';
const EVENTS_FILE = 'events.jsonl';

export const statePath = (root) => join(root, STATE_DIR, STATE_FILE);
export const eventsPath = (root) => join(root, STATE_DIR, EVENTS_FILE);
export const fail = (code, msg) => { throw new FactoryError(code, msg); };

export function exists(root) { return existsSync(statePath(root)); }

export function load(root) {
  if (!exists(root)) fail('NOT_INIT', 'No Ghostship state here. Run /ghostship init.');
  return JSON.parse(readFileSync(statePath(root), 'utf8'));
}

export function save(root, state) {
  const p = statePath(root);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, p);
}

function eventHash(prev, ev) {
  const { seq, at, type, ref, data } = ev;
  return sha256(prev + '\n' + JSON.stringify({ seq, at, type, ref, data }));
}

export function mutate(root, type, ref, data, fn) {
  const state = load(root);
  const result = fn(state);
  const seq = (state.eventSeq || 0) + 1;
  const ev = { seq, at: nowIso(), type, ref: ref || null, data: data ?? null, prev: state.lastHash || 'GENESIS' };
  ev.hash = eventHash(ev.prev, ev);
  appendFileSync(eventsPath(root), JSON.stringify(ev) + '\n');
  state.eventSeq = seq;
  state.lastHash = ev.hash;
  save(root, state);
  return result;
}

export function initState(root, initial) {
  if (exists(root)) return load(root);
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  save(root, { schema: 1, eventSeq: 0, lastHash: 'GENESIS', ...initial });
  writeFileSync(eventsPath(root), '');
  return mutate(root, 'init', null, { stage: initial.stage }, (s) => s);
}

export function verifyEventChain(root) {
  const state = load(root);
  const problems = [];
  let prev = 'GENESIS', count = 0;
  const lines = existsSync(eventsPath(root)) ? readFileSync(eventsPath(root), 'utf8').split('\n').filter(Boolean) : [];
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { problems.push(`unparseable event line ${count + 1}`); break; }
    count += 1;
    if (ev.seq !== count) problems.push(`event ${count}: seq ${ev.seq}`);
    if (ev.prev !== prev) problems.push(`event ${count}: chain broken`);
    if (eventHash(ev.prev, ev) !== ev.hash) problems.push(`event ${count}: content does not match its hash`);
    prev = ev.hash;
  }
  if (count !== state.eventSeq || prev !== state.lastHash) problems.push('state.json does not match the event log head');
  return { problems, events: count };
}
