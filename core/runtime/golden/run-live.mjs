#!/usr/bin/env node
// The golden path for real: the same to-do fixture, but the agents are `claude -p` runs started by the headless
// autopilot runner (`gs autopilot start`), not scripts. Not part of the test suite: it needs a Claude login and minutes.
//
//   node core/runtime/golden/run-live.mjs [--mode autopilot|full] [--keep] [--dir <folder>]
//
// What it does: sets up a fresh project, answers the interview and approves the PRD as the owner would (those gates
// are the owner's in every mode), then starts the runner and polls `gs next` until it is waiting at STOP 1 / STOP 2,
// approves there as the owner, and stops when `next` says done. It prints the scorecard at the end.
import { spawnSync } from 'node:child_process';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshProject, FIXTURE, TTY } from './drive.mjs';
import { next } from '../lib/next.mjs';
import { scorecard, text } from '../lib/scorecard.mjs';
import * as E from '../lib/engine.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const mode = opt('--mode', 'autopilot');
const keep = args.includes('--keep');
const dir = opt('--dir', null) || freshProject({ mode, name: 'todo-live' });
const gs = (...a) => spawnSync(process.execPath, [join(dir, '.ghostship/core/runtime/gs.mjs'), ...a], { cwd: dir, encoding: 'utf8' });
const log = (m) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The owner's part, scripted: the interview answers come from the fixture's PRD so the live planner/builders have the same brief.
const owner = {
  interview: () => { for (const a of E.interviewStatus(dir).open) E.interviewMark(dir, a, 'answered', 'see the PRD draft'); },
  'prd.approve': () => E.prdApprove(dir, TTY),
  'acceptance.approve': () => E.acceptanceApprove(dir, TTY),
  'release.approve': () => E.releaseApprove(dir, TTY),
};
(async () => {
  log(`project: ${dir} (mode ${mode})`);
  let started = false;
  for (let i = 0; i < 2000; i++) {
    const n = next(dir);
    if (n.kind === 'done') { log(`done: ${n.say}`); break; }
    if (n.kind === 'owner' && owner[n.id]) { log(`owner: ${n.say}`); owner[n.id](); continue; }
    if (n.id === 'interview.init') { E.interviewInit(dir); continue; }
    if (n.id === 'prd.write') { const { cpSync } = await import('node:fs'); cpSync(join(FIXTURE, 'docs/PRD.draft.md'), join(dir, n.path)); continue; }
    if (!started) {
      const r = gs('autopilot', 'start');
      if (r.status !== 0) { log(`autopilot start refused: ${r.stderr || r.stdout}`); process.exit(1); }
      started = true;
      log('autopilot runner started; the builders are claude -p runs');
    }
    if (n.kind === 'owner') { log(`waiting for an owner gate this script does not handle: ${n.id} — ${n.say}`); process.exit(2); }
    const st = gs('autopilot', 'status').stdout.trim();
    log(`${n.kind} ${n.id}: ${n.say}${st ? ` · runner: ${st.split('\n')[0]}` : ''}`);
    if (/failed|stopped/.test(st) && !/running|waiting/.test(st)) { log('the runner stopped; see gs autopilot log'); process.exit(3); }
    await sleep(15000);
  }
  gs('autopilot', 'stop');
  console.log('\n' + text(scorecard(dir)));
  if (!keep) rmSync(dir, { recursive: true, force: true }); else log(`kept ${dir}`);
})();
