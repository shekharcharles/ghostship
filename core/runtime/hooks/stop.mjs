#!/usr/bin/env node
// Stop hook: while a task is BUILDING or JUDGING the main session may not quietly end.
// If the event log has not moved since the last block, count it; past the limit the task becomes
// NEEDS_DECISION (or, in autopilot, is retried or parked by policy) and the stop goes through, so a stall is visible,
// never a silent exit or a loop.
// Autopilot driver: in autopilot/full with no task in hand, a stop is blocked while `next()` names work the orchestrator
// can do without the owner (a `do` or `agent` step). It always goes through while the owner is the one being waited on
// (interview, PRD, STOP 1, STOP 2), when paused, in guided mode, while an agent works, or while the headless autopilot
// runner is alive: then the runner drives, and the session is the owner's control tower.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { loadConfig } from '../lib/config.mjs';
import { join } from 'node:path';
import { statePath, load } from '../lib/store.mjs';
import { activeTask, escalateStall, settleDecisions } from '../lib/engine.mjs';
import { pause, raise } from '../lib/bridge.mjs';
import { next } from '../lib/next.mjs';
import { statusOf as autopilotStatus } from '../lib/autopilot.mjs';
import { RUNS_DIR } from '../lib/paths.mjs';

let payload = {};
try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* ignore */ }
const root = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
if (!existsSync(statePath(root))) process.exit(0);

let state;
try { state = load(root); } catch { process.exit(0); } // corrupt state: the guard and session hook surface it
// Keeper fallback (no Bridge mod): past the hard context limit, ask once for a handoff before the session goes on.
try {
  const hb = JSON.parse(readFileSync(join(root, RUNS_DIR, 'heartbeat.json'), 'utf8'));
  const hard = loadConfig(root).loop?.['handoff-tokens']?.hard || 200000;
  const ho = join(root, '.ghostship/handoff/HANDOFF.md');
  const fresh = existsSync(ho) && Date.now() - statSync(ho).mtimeMs < 30 * 60000;
  const kp = join(root, RUNS_DIR, 'keeper.json');
  let k = {}; try { k = JSON.parse(readFileSync(kp, 'utf8')); } catch { /* first */ }
  if (hb.source !== 'mod' && hb.tokens >= hard && !fresh && k.askedAt !== hb.sessionId) {
    mkdirSync(join(root, RUNS_DIR), { recursive: true });
    writeFileSync(kp, JSON.stringify({ askedAt: hb.sessionId }));
    process.stdout.write(JSON.stringify({ decision: 'block', reason: `Ghostship keeper: context is at ${hb.tokens} tokens (hard limit ${hard}). Run \`node .ghostship/core/runtime/gs.mjs bridge handoff --note "<what you were doing and what is next>"\`, then tell the owner to /clear and run /ghostship resume.` }));
    process.exit(0);
  }
} catch { /* no heartbeat yet */ }

const AUTONOMY = { mode: 'autopilot', 'auto-retries': 1, 'night-shift': false, 'night-shift-at': 90 };
let cfg = {};
try { cfg = loadConfig(root); } catch { /* defaults */ }
const autonomy = { ...AUTONOMY, ...(cfg.autonomy || {}) };
const autopilot = autonomy.mode === 'autopilot' || autonomy.mode === 'full';
try { if (settleDecisions(root).length) state = load(root); } catch { /* best effort */ }
// The headless runner drives the loop while it is alive: the session is never pushed, and never counts as stalled.
let runner = null;
try { runner = autopilotStatus(root); } catch { /* none */ }
if (runner && ['running', 'waiting-owner', 'paused'].includes(runner.status)) process.exit(0);
const act = activeTask(state);
const held = act && act.status !== 'PASSED';
const work = held ? null : (autopilot ? workWithoutOwner() : null);
if (!held && !work) process.exit(0);

const LIMIT = 3;
mkdirSync(join(root, RUNS_DIR), { recursive: true });
const counterPath = join(root, RUNS_DIR, 'stop.json');

/** What the orchestrator can do now without the owner (a `do` or `agent` step of `next()`), or null when it is the owner's turn. */
function workWithoutOwner() {
  if (state.stage === 'new' || state.stage === 'adopt') return null; // the interview and the PRD are the owner's
  let n;
  try { n = next(root); } catch { return null; }
  return n.kind === 'do' || n.kind === 'agent' ? n.say : null;
}

// A builder, judge or planner that made a tool call in the last few minutes is still working (the guard records each
// call). The orchestrator waiting on it in the background is not a stall: it is woken when that agent finishes. Five
// minutes covers a long test run or install between two tool calls without hiding an agent that has really gone quiet.
const ALIVE_MS = 5 * 60000;
let beats = {};
try { beats = JSON.parse(readFileSync(join(root, RUNS_DIR, 'agents.json'), 'utf8')); } catch { /* none yet */ }
const alive = Object.entries(beats).some(([k, v]) => k.startsWith('ghostship-') && Date.now() - Number(v?.at || 0) < ALIVE_MS);
if (alive) {
  writeFileSync(counterPath, JSON.stringify({ eventSeq: -1, blocks: 0 }));
  process.exit(0);
}
let counter = { eventSeq: -1, blocks: 0 };
try { counter = JSON.parse(readFileSync(counterPath, 'utf8')); } catch { /* first time */ }
const blocks = counter.eventSeq === state.eventSeq ? counter.blocks + 1 : 1;

if (blocks > LIMIT) {
  writeFileSync(counterPath, JSON.stringify({ eventSeq: -1, blocks: 0 }));
  if (!held) {
    // No task to escalate: autopilot pauses and tells the owner, rather than looping or quietly ending.
    const why = `autopilot made no progress after ${blocks - 1} tries`;
    try { pause(root, why); raise(root, `Ghostship paused: ${why}. Next was: ${work}`, 'action'); } catch { /* best effort */ }
    process.stdout.write(JSON.stringify({ systemMessage: `Ghostship: ${why}, so it paused. The owner resumes from the Bridge or with gs go.` }));
    process.exit(0);
  }
  try { escalateStall(root, act.id, `session tried to stop ${blocks - 1}× with no progress`); } catch { /* best effort */ }
  let after = 'NEEDS_DECISION';
  try { after = load(root).tasks[act.id].status; } catch { /* keep the default wording */ }
  const msg = after === 'NEEDS_DECISION' ? `${act.id} stalled and now needs your decision: gs decide ${act.id} --grant 1 | --drop`
    : after === 'PARKED' ? `${act.id} stalled and is parked; autopilot moves on to other work`
    : `${act.id} stalled; autopilot granted it one more attempt`;
  process.stdout.write(JSON.stringify({ systemMessage: `Ghostship: ${msg}` }));
  process.exit(0);
}
writeFileSync(counterPath, JSON.stringify({ eventSeq: state.eventSeq, blocks }));
if (!held) {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `Ghostship autopilot: keep going — ${work}. Do not ask the owner; gates you cannot pass are handled by policy or wait at STOP 1/STOP 2. (${blocks}/${LIMIT} no-progress stops before autopilot pauses.)`,
  }));
  process.exit(0);
}
const phase = act.status === 'JUDGING' ? 'is waiting for the judge'
  : !act.red && !act.noTdd ? 'needs a failing test recorded (gs evidence --kind red)'
  : !act.evidence?.green ? 'needs GREEN evidence' : 'needs its gates, then gs task submit';
process.stdout.write(JSON.stringify({
  decision: 'block',
  reason: `Ghostship: ${act.id} is ${act.status} (attempt ${act.attempt}/${act.maxAttempts}) and ${phase}. No builder or judge has worked on it for 5 minutes. Continue, or record the outcome: gs task fail ${act.id} --reason "…". (${blocks}/${LIMIT} no-progress stops before this becomes your decision.)`,
}));
process.exit(0);
