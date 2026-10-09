// The autonomy scorecard: counts from the records of a scripted run, and its two renderings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectAtBuild, TTY, git } from './project.mjs';
import { loadConfig, saveConfig } from '../lib/config.mjs';
import * as E from '../lib/engine.mjs';
import * as A from '../lib/asks.mjs';
import { scorecard, text, markdown } from '../lib/scorecard.mjs';

test('scorecard: tasks, attempts, asks, owner gates, questions after the PRD, time and spend', () => {
  const dir = projectAtBuild();
  try {
    const cfg = loadConfig(dir); cfg.autonomy = { ...(cfg.autonomy || {}), mode: 'guided' }; saveConfig(dir, cfg);
    git(dir, 'commit', '-qam', 'chore: guided');
    // T001 fails three times → the owner grants one more, then it is left there
    for (let i = 1; i <= 3; i++) { E.taskStart(dir, 'T001'); E.taskFail(dir, 'T001', `broke ${i}`); }
    E.decide(dir, { task: 'T001', grant: 1, ...TTY });
    A.add(dir, { kind: 'do', title: 'Add STRIPE_KEY to secrets' });
    const pick = A.add(dir, { kind: 'choose', title: 'Region?', options: ['EU', 'US'] });
    A.answer(dir, pick.id, { option: 1 });
    mkdirSync(join(dir, '.ghostship/usage'), { recursive: true });
    writeFileSync(join(dir, '.ghostship/usage/sessions.json'), JSON.stringify({ s1: { usd: 3.5 }, s2: { usd: 1.25 } }));

    const sc = scorecard(dir);
    assert.equal(sc.autonomy.mode, 'guided');
    assert.deepEqual(sc.tasks, { total: 2, merged: 0, parked: 0, dropped: 0 });
    assert.equal(sc.attempts.total, 3);
    assert.equal(sc.attempts.autoGrants, 0);
    assert.deepEqual(sc.asks, { filed: 2, answered: 1, openNow: 1 });
    assert.equal(sc.ownerGates.prd, 1, 'the fixture approved the PRD at a terminal');
    assert.equal(sc.ownerGates.acceptance, 1);
    assert.equal(sc.ownerGates.decide, 1);
    assert.equal(sc.ownerGates.release, 0);
    assert.equal(sc.questionsAfterPrd, 3, 'two asks and one decision after the PRD');
    assert.equal(sc.usd.total, 4.75);
    assert.equal(sc.usd.perTask, null, 'nothing merged yet');
    assert.ok(sc.timeMs.total >= 0 && sc.timeMs.firstEvent && sc.timeMs.lastEvent);

    const t = text(sc);
    assert.match(t, /^autonomy: guided$/m);
    assert.match(t, /asks: 2 filed · 1 answered · 1 open/);
    assert.match(t, /owner gates: prd ×1, acceptance ×1, decide ×1/);
    assert.match(t, /questions after the PRD: 3/);
    assert.match(t, /spend: \$4\.75 total$/m);
    const md = markdown(sc);
    assert.match(md, /^## Autonomy scorecard\n\| measure \| value \|/);
    assert.match(md, /\| questions after the PRD \| 3 \|/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scorecard: an autopilot run counts auto-grants, never an owner decision', () => {
  const dir = projectAtBuild();
  try {
    for (let i = 1; i <= 3; i++) { E.taskStart(dir, 'T001'); E.taskFail(dir, 'T001', `broke ${i}`); }
    const sc = scorecard(dir);
    assert.equal(sc.autonomy.mode, 'autopilot');
    assert.equal(sc.attempts.autoGrants, 1);
    assert.equal(sc.ownerGates.decide, 0);
    assert.equal(sc.questionsAfterPrd, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
