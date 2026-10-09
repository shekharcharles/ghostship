#!/usr/bin/env node
// Supervises one agent run started by `gs dispatch`: launches it (headless or in a herdr tab), keeps a heartbeat,
// enforces the timeout, spots quota errors, and records the outcome. Never adds permission-bypass flags.
import { openSync, closeSync, existsSync, statSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { readActive, updateActive, finishRun } from './lib/runs.mjs';
import { readSecrets } from './lib/secrets.mjs';
import { markQuota } from './lib/routing.mjs';
import { createHerdr, realRun } from './lib/herdr.mjs';
import { RUNS_DIR } from './lib/paths.mjs';

const [root, runId] = process.argv.slice(2);
const QUOTA = /rate.?limit|quota|usage limit|too many requests|\b429\b|credit balance|limit reached/i;
const stored = readActive(root);
if (!stored || stored.runId !== runId) process.exit(0);
const PROMPT = process.env.GS_RUN_PROMPT || '';
delete process.env.GS_RUN_PROMPT;
const run = { ...stored, prompt: PROMPT, args: (stored.args || []).map((a) => a.split('\u0000GS_PROMPT\u0000').join(PROMPT)) };

const logPath = join(root, run.log);
mkdirSync(dirname(logPath), { recursive: true });
const note = (s) => appendFileSync(logPath, `[ghostship ${new Date().toISOString()}] ${s}\n`);
const started = Date.now();
const timeoutMs = (run.timeoutMin || 45) * 60000;

function agentEnv() {
  const env = { ...process.env, GHOSTSHIP_ROLE: run.role, GHOSTSHIP_TASK: run.task || '', GHOSTSHIP_RUN: run.runId };
  const secrets = readSecrets();
  for (const { var: v, secret } of run.envNames || []) if (secrets[secret]) env[v] = secrets[secret];
  if (run.viaGateway) {
    try {
      const g = JSON.parse(readFileSync(join(root, RUNS_DIR, 'gateway.json'), 'utf8'));
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${g.port}`;
      env.ANTHROPIC_AUTH_TOKEN = g.clientKey;
    } catch { note('gateway is not running: start it with gs gateway start'); }
  }
  return env;
}

function finish(status, extra = {}) {
  const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-4000) : '';
  let finalStatus = status;
  if (status === 'failed' && QUOTA.test(tail)) { finalStatus = 'quota'; markQuota(root, run.agentId, 60, 'quota or rate limit in output'); }
  const report = existsSync(join(root, run.report));
  const done = { ...readActive(root), ...extra, status: finalStatus, report: report ? run.report : null, endedAt: new Date().toISOString(), durationMs: Date.now() - started };
  updateActive(root, done);
  finishRun(root, { runId, task: run.task, role: run.role, attempt: run.attempt, agentId: run.agentId, model: run.model, mode: run.mode, status: finalStatus, durationMs: done.durationMs, exitCode: extra.exitCode ?? null, at: done.endedAt });
  process.exit(0);
}

if (run.bypassNote) note(`notice: ${run.bypassNote} (owner setting; Ghostship itself never adds one)`);
for (const n of run.notes || []) note(n);

if (run.mode === 'headless') {
  const fd = openSync(logPath, 'a');
  const child = spawn(run.bin, run.args, { cwd: root, env: agentEnv(), stdio: ['ignore', fd, fd], windowsHide: true });
  updateActive(root, { childPid: child.pid });
  const beat = setInterval(() => {
    let bytes = 0; try { bytes = statSync(logPath).size; } catch { /* none */ }
    updateActive(root, { heartbeatAt: new Date().toISOString(), logBytes: bytes });
  }, 15000);
  const killer = setTimeout(() => { note(`timeout after ${run.timeoutMin} min: stopping`); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000); }, timeoutMs);
  child.on('error', (e) => { note(`could not start ${run.bin}: ${e.message}`); clearInterval(beat); clearTimeout(killer); closeSync(fd); finish('failed', { exitCode: 127 }); });
  child.on('exit', (code, signal) => {
    clearInterval(beat); clearTimeout(killer); closeSync(fd);
    const timedOut = Date.now() - started >= timeoutMs;
    finish(timedOut ? 'timeout' : code === 0 ? 'done' : 'failed', { exitCode: code ?? (signal ? 128 : 1) });
  });
} else if (run.mode === 'tab') {
  const h = createHerdr({ run: realRun });
  let tabId = null;
  try {
    const ws = h.workspace(root, run.workspaceLabel || 'ghostship');
    const env = {};
    for (const [k, v] of Object.entries(agentEnv())) if (/^(GHOSTSHIP_|ANTHROPIC_BASE_URL$|ANTHROPIC_AUTH_TOKEN$)/.test(k)) env[k] = v;
    for (const { var: v } of run.envNames || []) env[v] = agentEnv()[v];
    const tab = h.openTab({ workspace: ws, cwd: root, label: run.label || `${run.task || 'plan'} ${run.role} a${run.attempt}`, env });
    tabId = tab.tabId;
    updateActive(root, { tabId, paneId: tab.paneId });
    h.startAgent({ name: run.name, kind: run.herdrKind, paneId: tab.paneId, args: run.args });
    note(`started ${run.name} (${run.herdrKind}) in tab ${tabId}`);
    let left = () => Math.max(5000, timeoutMs - (Date.now() - started));
    let status = h.prompt({ name: run.name, text: run.prompt, timeoutMs: left() });
    while (status === 'blocked' && Date.now() - started < timeoutMs) {
      note('agent is waiting for an approval or answer in its tab');
      appendFileSync(join(root, RUNS_DIR, 'alerts.jsonl'), JSON.stringify({ at: new Date().toISOString(), runId, task: run.task, role: run.role, tab: tabId, alert: 'blocked: needs your answer in the herdr tab' }) + '\n');
      updateActive(root, { status: 'running', blocked: true });
      status = h.wait({ name: run.name, until: ['idle', 'done'], timeoutMs: left() });
    }
    appendFileSync(logPath, h.read({ name: run.name, lines: 200 }));
    if (run.closeTab !== false) h.closeTab(tabId);
    finish(status === 'idle' || status === 'done' ? 'done' : 'failed', { agentStatus: status });
  } catch (e) {
    note(`herdr: ${e.message}`);
    finish(/timeout/i.test(e.code || e.message) ? 'timeout' : 'failed', { error: e.message });
  }
} else {
  note(`unknown mode ${run.mode}`);
  finish('failed');
}
