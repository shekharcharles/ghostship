#!/usr/bin/env node
// The autopilot runner process, started by `gs autopilot start`: runs the loop over `next()` until it is done, fails, or
// is stopped; while the owner is the one being waited on (PRD, STOP 1, STOP 2, a guided decision, an owner pause) it
// polls every OWNER_POLL_MS and carries on the moment the gate is passed. SIGTERM stops it cleanly after the current step.
import { loop, writeState, statusOf, log, OWNER_POLL_MS, TERMINAL } from './lib/autopilot.mjs';
import { next } from './lib/next.mjs';

const [root] = process.argv.slice(2);
if (!root) { process.stderr.write('usage: autopilot-runner.mjs <project root>\n'); process.exit(2); }
const once = process.env.GS_AP_ONCE === '1';
const maxSteps = Number(process.env.GS_AP_MAX || 0) || (once ? 1 : 200);
let stopping = false;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; });

// Only this process's own record is ours: a newer runner has replaced it when the pid differs, and a stopped record
// stays stopped. Every write names this runner as its owner, so it is dropped once the record is no longer ours.
const mine = () => { const s = statusOf(root); return s?.pid === process.pid && !TERMINAL.includes(s.status); };
const write = (patch) => writeState(root, patch, { owner: process.pid });
const key = (s) => `${s.kind}:${s.id}:${s.task || ''}`;

async function main() {
  if (!write({ pid: process.pid })) return;
  while (!stopping) {
    if (!mine()) return;
    const r = await loop(root, { maxSteps, sleep, shouldStop: () => stopping || !mine(), owner: process.pid });
    if (!mine()) return;
    if (r.status === 'done' || r.status === 'failed') { write({ status: r.status, reason: r.reason || null, endedAt: new Date().toISOString() }); return; }
    if (once) { write({ status: 'stopped', reason: 'one step, as asked', endedAt: new Date().toISOString() }); return; }
    if (r.status === 'stopped') { write({ status: 'stopped', reason: r.reason || null, endedAt: new Date().toISOString() }); return; }
    // waiting-owner or paused: poll until the gate changes, then loop again.
    if (!write({ status: r.status })) return;
    const was = key(r.step);
    while (!stopping && mine()) {
      await sleep(OWNER_POLL_MS);
      let n; try { n = next(root); } catch { continue; }
      if (key(n) !== was) { log(root, { id: n.id, say: n.say, result: 'resumed', ms: 0 }); if (!write({ status: 'running' })) return; break; }
    }
  }
  if (mine()) write({ status: 'stopped', reason: 'stopped by the owner', endedAt: new Date().toISOString() });
}

main().catch((e) => { log(root, { id: 'runner', say: e.message, result: 'failed', ms: 0 }); if (mine()) write({ status: 'failed', reason: e.message, endedAt: new Date().toISOString() }); process.exit(1); });
