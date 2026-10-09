// The headless autopilot runner: the loop over next() with fake agents, the judge token kept in memory only, the
// owner's gates as the only stops, the stop hook standing down while a runner is alive, and the CLI's refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { projectAtBuild, CORE, TTY, put } from './project.mjs';
import * as E from '../lib/engine.mjs';
import * as B from '../lib/bridge.mjs';
import * as AP from '../lib/autopilot.mjs';
import { next } from '../lib/next.mjs';
import { load } from '../lib/store.mjs';
import { loadConfig, saveConfig } from '../lib/config.mjs';

const HOOK = (n) => join(CORE, 'runtime', 'hooks', n);
const runHook = (file, dir, input) => spawnSync(process.execPath, [file], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
const stop = (dir) => { const out = runHook(HOOK('stop.mjs'), dir, {}).stdout; return out ? JSON.parse(out) : null; };
const IMPL = { add: '(a, b) => a + b', sub: '(a, b) => a - b' };
const NAME = { T001: 'add', T002: 'sub' };

/** What a builder and a judge would do, scripted: the builder never submits and never sees a token; the judge gets it from the loop. */
function fakeAgents(dir, seen) {
  return async (step, mem) => {
    seen.push(step.id);
    if (step.role === 'builder') {
      const name = NAME[step.task];
      put(dir, `tests/unit/${name}.test.mjs`, `// Unit test for ${name}.\nimport { ${name} } from '../../src/${name}.mjs';\nif (${name}(7, 2) !== ${name === 'add' ? 9 : 5}) throw new Error('${name}');\n`);
      assert.equal(E.evidence(dir, { task: step.task, kind: 'red' }).accepted, true);
      put(dir, `src/${name}.mjs`, `// ${name === 'add' ? 'Adds' : 'Subtracts'} two numbers.\nexport const ${name} = ${IMPL[name]};\n`);
      E.codemap(dir);
      for (const k of ['green', 'acceptance']) assert.equal(E.evidence(dir, { task: step.task, kind: k }).accepted, true, k);
      return { status: 'done', agentId: 'fake-builder' };
    }
    if (step.role === 'judge') {
      const token = mem.tokens[step.task];
      assert.ok(token, 'the loop hands the judge the token it kept from submit');
      assert.equal(E.evidence(dir, { task: step.task, kind: 'judge', token, command: 'true' }).accepted, true);
      E.verdict(dir, { task: step.task, result: 'PASS', token, checks: { [step.task === 'T001' ? 'C1' : 'C2']: 'PASS' } });
      return { status: 'done', agentId: 'fake-judge' };
    }
    if (step.id === 'docs.check') {
      // The release ships its docs: the planner fills what the scaffold left as TODO.
      for (const rel of [...(step.missing || []), ...(step.unfilled || [])]) put(dir, rel, `# ${rel.split('/').pop().replace(/\.md$/, '')}\n\nFilled by the fake planner for the golden run.\n`);
      return { status: 'done', agentId: 'fake-planner' };
    }
    throw new Error(`unexpected agent step ${step.id} (${step.role})`);
  };
}

test('loop: from the build stage to the release candidate with fake agents; the only owner gate is STOP 2', async () => {
  const dir = projectAtBuild();
  try {
    const seen = [];
    const steps = [];
    const r = await AP.loop(dir, { runAgent: fakeAgents(dir, seen), maxSteps: 60, sleep: async () => {}, onStep: (s) => { steps.push(`${s.id}:${s.result}`); } });
    assert.equal(r.status, 'waiting-owner', JSON.stringify(r));
    assert.equal(r.step.id, 'release.approve');
    assert.equal(r.step.owner.gate, 'release');
    assert.deepEqual(seen.filter((x) => x !== 'docs.check'), ['builder', 'judge', 'builder', 'judge'], 'two tasks, each built then judged');
    assert.ok(steps.every((s) => s.endsWith(':ok')), `no failed step: ${steps.join(' ')}`);
    for (const id of ['task.start:ok', 'submit:ok', 'merge:ok', 'release.candidate:ok']) assert.ok(steps.includes(id), id);
    const st = load(dir);
    assert.equal(st.tasks.T001.status, 'MERGED');
    assert.equal(st.tasks.T002.status, 'MERGED');
    assert.ok(st.release, 'a release candidate waits at STOP 2');
    // Nothing the judge needs is on disk: the token lives in the loop's memory only.
    const disk = readFileSync(join(dir, AP.LOG), 'utf8') + readFileSync(join(dir, AP.FILE), 'utf8');
    assert.doesNotMatch(disk, /[0-9a-f]{32}/, 'no judge token in the log or the state file');
    const log = AP.readLog(dir, 100);
    assert.ok(log.some((l) => l.id === 'builder' && l.task === 'T001' && l.result === 'ok'));
    assert.equal(log.at(-1).result, 'waiting-owner');
    assert.equal(AP.readState(dir).last.id, 'release.approve');
    // The owner approves at STOP 2; the loop then has nothing left to do.
    E.releaseApprove(dir, TTY);
    const after = await AP.loop(dir, { runAgent: fakeAgents(dir, seen), maxSteps: 5, sleep: async () => {} });
    assert.equal(after.status, 'done');
    assert.match(after.step.say, /Released v/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loop: an agent that records nothing counts as a failure; the same failure three times stops the runner with an alert', async () => {
  const dir = projectAtBuild();
  try {
    let calls = 0;
    const r = await AP.loop(dir, { runAgent: async () => { calls += 1; return { status: 'done', agentId: 'idle-builder' }; }, maxSteps: 20, sleep: async () => {} });
    assert.equal(r.status, 'failed');
    assert.equal(calls, AP.SAME_FAIL_LIMIT);
    assert.match(r.reason, /builder T001 failed 3 times: idle-builder done: no progress recorded/);
    assert.ok(B.alertsSince(dir).alerts.some((a) => a.level === 'action' && /autopilot stopped/.test(a.alert)));
    assert.equal(load(dir).tasks.T001.status, 'BUILDING', 'the task is left for the next runner or the session');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loop: a guided decision and an owner pause stop the loop as the owner\'s; a stop request stops it cleanly', async () => {
  const dir = projectAtBuild();
  try {
    B.pause(dir, 'lunch');
    const p = await AP.loop(dir, { runAgent: async () => ({ status: 'done' }), maxSteps: 5, sleep: async () => {} });
    assert.equal(p.status, 'paused');
    assert.equal(p.step.owner.gate, 'go');
    B.go(dir);
    let n = 0;
    const s = await AP.loop(dir, { runAgent: async () => ({ status: 'done' }), maxSteps: 5, sleep: async () => {}, shouldStop: () => n++ > 0 });
    assert.equal(s.status, 'stopped');
    assert.equal(s.steps, 1, 'one step ran, then the stop request was honoured');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stop hook: while the autopilot runner is alive the session is never pushed; a dead runner reads as lost and the push returns', () => {
  const dir = projectAtBuild();
  try {
    const c = loadConfig(dir); c.autonomy = { ...(c.autonomy || {}), mode: 'autopilot' }; saveConfig(dir, c);
    assert.equal(stop(dir)?.decision, 'block', 'without a runner, autopilot pushes the session on');
    AP.writeState(dir, { pid: process.pid, status: 'running', startedAt: new Date().toISOString() });
    assert.equal(stop(dir), null, 'the runner drives: the session rests');
    assert.equal(AP.statusOf(dir).status, 'running');
    AP.writeState(dir, { pid: 999999999, status: 'waiting-owner' });
    assert.equal(AP.statusOf(dir).status, 'lost', 'its process is gone');
    assert.equal(stop(dir)?.decision, 'block', 'a lost runner no longer holds the session back');
    const t = B.tick(dir, {});
    assert.equal(t.autopilot.status, 'lost');
    assert.equal(t.next.id, 'task.start');
    assert.equal(t.next.kind, 'do');
    assert.match(t.next.command, /task start T001/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gs autopilot: start refuses before the PRD, without a test command or a headless agent; status, log and stop read back', async () => {
  const dir = projectAtBuild();
  const out = [];
  const say = (t) => out.push(typeof t === 'string' ? t : JSON.stringify(t));
  try {
    assert.equal(AP.statusOf(dir), null);
    await AP.cli(dir, 'status', {}, say);
    assert.match(out.at(-1), /No autopilot runner/);
    const c = loadConfig(dir);
    const test0 = c.commands.test; c.commands.test = ''; saveConfig(dir, c);
    assert.throws(() => AP.start(dir), /NO_COMMAND|commands\.test/);
    c.commands.test = test0;
    saveConfig(dir, c);
    // loadConfig always fills the default Claude agents back in, so an all-tab config is only reachable as a plain object.
    assert.equal(AP.headlessAgent({ agents: { gem: { harness: 'gemini', provider: 'p', model: 'x' } } }), null, 'gemini has no safe headless mode');
    assert.equal(AP.headlessAgent({ agents: { gem: { harness: 'gemini' } }, harnesses: { gemini: { headless: ['gemini', '-p', '{prompt}'] } } }), 'gem', 'an owner template makes it headless');
    assert.equal(AP.headlessAgent(loadConfig(dir)), 'claude-opus', 'claude -p is a headless mode');
    // A real runner process, one step only: it starts T001 in-process and stops, never dispatching an agent.
    const r = AP.start(dir, { once: true });
    assert.equal(r.status, 'running');
    const until = Date.now() + 20000;
    while (Date.now() < until && !['stopped', 'failed', 'done'].includes(AP.readState(dir).status)) await new Promise((ok) => setTimeout(ok, 200));
    const done = AP.readState(dir);
    assert.equal(done.status, 'stopped', JSON.stringify(done));
    assert.match(done.reason, /one step/);
    assert.equal(load(dir).tasks.T001.status, 'BUILDING', 'the runner did the step itself');
    assert.ok(AP.readLog(dir).some((l) => l.id === 'task.start' && l.result === 'ok'), 'the step is in the log');
  } finally {
    try { AP.stop(dir); } catch { /* already stopped */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gs autopilot: a running record refuses a second start; stop kills it and says so', async () => {
  const dir = projectAtBuild();
  try {
    AP.writeState(dir, { pid: process.pid, status: 'waiting-owner', startedAt: new Date().toISOString(), step: 3, last: { id: 'release.approve', say: 'STOP 2' } });
    assert.throws(() => AP.start(dir), /already waiting-owner/);
    const out = [];
    await AP.cli(dir, 'status', {}, (t) => out.push(t));
    assert.match(out[0], /autopilot: waiting-owner \(pid \d+\) · step 3: STOP 2/);
    // Stop must not kill this test process: point the record at a pid that is not ours before stopping.
    AP.writeState(dir, { pid: 999999999 });
    const s = AP.stop(dir);
    assert.equal(s.status, 'stopped');
    assert.ok(AP.readLog(dir).some((l) => /stop requested/.test(l.say)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gs autopilot: the record is written whole, through a temp file renamed over it', () => {
  const dir = projectAtBuild();
  try {
    AP.writeState(dir, { status: 'running', step: 1 });
    AP.writeState(dir, { step: 2, last: { id: 'task.start', say: 'start T001' } });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, AP.FILE), 'utf8')), { status: 'running', step: 2, last: { id: 'task.start', say: 'start T001' } });
    const runs = readdirSync(join(dir, '.ghostship/runs'));
    assert.ok(!runs.some((f) => f.endsWith('.tmp')), `no temp file left behind: ${runs.join(' ')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gs autopilot: a start already in progress refuses a second one; a lock left by a dead start is taken over', () => {
  const dir = projectAtBuild();
  const lock = join(dir, AP.LOCK);
  try {
    // A live holder (this process stands in for a start mid-way): the second start refuses and spawns nothing.
    mkdirSync(join(dir, '.ghostship/runs'), { recursive: true });
    writeFileSync(lock, String(process.pid));
    assert.throws(() => AP.start(dir, { once: true }), /start is in progress \(pid \d+\)/);
    assert.equal(AP.readState(dir), null, 'nothing was started');
    assert.ok(existsSync(lock), 'the holder keeps its lock');
    // An empty lock is a start that has only just created it: held while fresh, taken over once old.
    writeFileSync(lock, '');
    assert.throws(() => AP.start(dir, { once: true }), /start is in progress/);
    const old = new Date(Date.now() - 60000);
    utimesSync(lock, old, old);
    assert.equal(AP.start(dir, { once: true }).status, 'running');
    assert.ok(!existsSync(lock), 'the lock is released after the start');
    // The started runner's record still refuses a second start the old way.
    assert.throws(() => AP.start(dir, { once: true }), /already running/);
    AP.stop(dir);
    // A dead holder: the lock is taken over, and released once the start is done.
    writeFileSync(lock, '999999999');
    assert.equal(AP.start(dir, { once: true }).status, 'running');
    assert.ok(!existsSync(lock), 'the lock is released after the start');
  } finally {
    try { AP.stop(dir); } catch { /* already stopped */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the record under concurrent writers

const AP_URL = pathToFileURL(join(CORE, 'runtime', 'lib', 'autopilot.mjs')).href;
/** A separate node process running `body` with `AP` (the autopilot module) and `root` in scope. */
function child(dir, body) {
  return spawn(process.execPath, ['--input-type=module', '-e', `import * as AP from ${JSON.stringify(AP_URL)}; const root = ${JSON.stringify(dir)};\n${body}`], { stdio: ['ignore', 'pipe', 'pipe'] });
}
const exited = (c) => new Promise((ok) => c.on('exit', (code) => ok(code)));
const output = (c) => { let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); return () => out; };
const firstLine = (c) => new Promise((ok) => c.stdout.once('data', () => ok()));
/** A live process that is not this one: what a runner's pid looks like to `stop`. */
const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });

test('record: four processes writing at once lose no update, and leave no temp or lock file', async () => {
  const dir = projectAtBuild();
  try {
    AP.writeState(dir, { status: 'running' }, { force: true });
    const kids = [0, 1, 2, 3].map((i) => child(dir, `for (let j = 0; j < 40; j++) AP.writeState(root, { ['w${i}_' + j]: j });`));
    const outs = kids.map(output);
    const codes = await Promise.all(kids.map(exited));
    assert.deepEqual(codes, [0, 0, 0, 0], outs.map((o) => o()).join('\n'));
    const rec = AP.readState(dir);
    const missing = [];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 40; j++) if (rec[`w${i}_${j}`] !== j) missing.push(`w${i}_${j}`);
    assert.deepEqual(missing, [], `${missing.length} of 160 updates lost`);
    const runs = readdirSync(join(dir, '.ghostship/runs'));
    assert.ok(!runs.some((f) => f.endsWith('.tmp') || f.endsWith('.lock')), runs.join(' '));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('record: a stop is final; a runner that keeps writing after it never brings running back', async () => {
  const dir = projectAtBuild();
  // A stand-in runner in its own process: it claims the record, then keeps writing `running` as fast as it can, deaf
  // to SIGTERM the way a real runner finishes its current step first. It counts the writes that were dropped.
  const kid = child(dir, `process.on('SIGTERM', () => {});
AP.writeState(root, { pid: process.pid, status: 'running' }, { force: true });
process.stdout.write('claimed\\n');
let dropped = 0;
for (let i = 0; i < 400; i++) { if (!AP.writeState(root, { status: 'running', n: i }, { owner: process.pid })) dropped++; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); }
process.stdout.write('dropped ' + dropped + '\\n');`);
  const out = output(kid);
  try {
    await firstLine(kid);
    await new Promise((ok) => setTimeout(ok, 100));
    const s = AP.stop(dir);
    assert.equal(s.status, 'stopped');
    assert.equal(await exited(kid), 0, out());
    const rec = AP.readState(dir);
    assert.equal(rec.status, 'stopped', JSON.stringify(rec));
    assert.equal(rec.reason, 'stopped by the owner');
    assert.match(out(), /dropped [1-9]\d*/, 'the runner went on writing after the stop, and those writes were dropped');
    // Not even a write without an owner moves it; only a new start (force) does.
    assert.equal(AP.writeState(dir, { status: 'running' }), null);
    assert.equal(AP.writeState(dir, { status: 'running' }, { force: true }).status, 'running');
  } finally { kid.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('record: a runner that finished before the stop keeps its own ending; a replaced runner cannot write', () => {
  const dir = projectAtBuild();
  const a = sleeper();
  try {
    AP.writeState(dir, { pid: a.pid, status: 'running' }, { force: true });
    assert.equal(AP.writeState(dir, { status: 'done', endedAt: new Date().toISOString() }, { owner: a.pid }).status, 'done');
    assert.equal(AP.stop(dir).status, 'done', 'the stop does not overwrite done');
    // A newer start replaced runner A: A's late writes are dropped, even before anything is TERMINAL.
    AP.writeState(dir, { pid: 4242424, status: 'running' }, { force: true });
    assert.equal(AP.writeState(dir, { status: 'failed' }, { owner: a.pid }), null);
    assert.equal(AP.readState(dir).status, 'running');
  } finally { a.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('record: a runner killed outright reads as lost; stop settles it and a new start is allowed', async () => {
  const dir = projectAtBuild();
  const a = sleeper();
  try {
    AP.writeState(dir, { pid: a.pid, status: 'running' }, { force: true });
    assert.equal(AP.statusOf(dir).status, 'running');
    a.kill('SIGKILL');
    await exited(a);
    assert.equal(AP.statusOf(dir).status, 'lost');
    const s = AP.stop(dir);
    assert.equal(s.status, 'stopped');
    assert.match(s.reason, /process was gone/);
    const r = AP.start(dir, { once: true });
    assert.equal(r.status, 'running');
    assert.ok(r.pid && r.pid !== a.pid, 'the new runner owns the record');
  } finally {
    try { AP.stop(dir); } catch { /* already stopped */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record: its lock left by a dead writer is taken over; a live holder is waited on, then refused', () => {
  const dir = projectAtBuild();
  const lock = join(dir, AP.STATE_LOCK);
  try {
    mkdirSync(join(dir, '.ghostship/runs'), { recursive: true });
    writeFileSync(lock, '999999999');
    assert.equal(AP.writeState(dir, { status: 'running', a: 1 }, { force: true }).a, 1, 'a dead holder\'s lock is taken over');
    assert.ok(!existsSync(lock), 'and released');
    // A live holder (this process stands in for a writer mid-way): the write waits, then gives up and changes nothing.
    writeFileSync(lock, String(process.pid));
    const t0 = Date.now();
    assert.throws(() => AP.writeState(dir, { a: 2 }), /AUTOPILOT_BUSY|held by pid \d+/);
    assert.ok(Date.now() - t0 >= AP.STATE_LOCK_WAIT_MS - 50, 'it waited before refusing');
    assert.equal(AP.readState(dir).a, 1);
    assert.ok(existsSync(lock), 'the holder keeps its lock');
    // An empty lock: held while fresh, taken over once old.
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60000);
    utimesSync(lock, old, old);
    assert.equal(AP.writeState(dir, { a: 3 }).a, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
