#!/usr/bin/env node
// PreToolUse guard. Exit 0 = allow, exit 2 = deny (reason on stderr, shown to the agent).
// Inert when the project has no Ghostship state. Fails CLOSED once state exists.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate } from '../lib/guard-rules.mjs';
import { statePath } from '../lib/store.mjs';
import { RUNS_DIR } from '../lib/paths.mjs';

let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { /* none */ }
let payload = null;
try { payload = JSON.parse(raw); } catch { /* handled below */ }
const root = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
if (!existsSync(statePath(root))) process.exit(0);

// What a tool call is doing, in plain words, for the status line (the idea of tzafrir/whats-agent-doing, MIT).
function stepWords(tool, i) {
  const base = (p) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'a file';
  const cut = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  if (tool === 'Bash' || tool === 'PowerShell') {
    const g = /gs\.mjs\s+([a-z-]+)(?:\s+([a-z-]+))?/.exec(String(i.command || ''));
    return g ? `Ghostship: ${[g[1], g[2]].filter(Boolean).join(' ')}` : i.description ? cut(i.description, 40) : `Running ${cut(i.command, 32)}`;
  }
  if (tool === 'Read') return `Reading ${base(i.file_path)}`;
  if (tool === 'Write') return `Writing ${base(i.file_path)}`;
  if (tool === 'Edit' || tool === 'MultiEdit') return `Editing ${base(i.file_path)}`;
  if (tool === 'NotebookEdit') return `Editing ${base(i.notebook_path)}`;
  if (tool === 'Grep') return `Searching for ${cut(i.pattern, 24)}`;
  return `Using ${String(tool || 'a tool')}`;
}

// Heartbeat: a builder, judge or planner tool call proves that agent is working. The Stop hook reads it so the
// orchestrator waiting on a background agent is not counted as stalled. Best effort; never touches the verdict.
if (typeof payload?.agent_type === 'string' && payload.agent_type.startsWith('ghostship-')) {
  try {
    const p = join(root, RUNS_DIR, 'agents.json');
    let beats = {};
    try { beats = JSON.parse(readFileSync(p, 'utf8')); } catch { /* first */ }
    beats[payload.agent_type] = { at: Date.now(), agentId: payload.agent_id ?? null, step: stepWords(payload.tool_name, payload.tool_input || {}) };
    mkdirSync(join(root, RUNS_DIR), { recursive: true });
    writeFileSync(p, JSON.stringify(beats));
  } catch { /* heartbeat is a nicety */ }
}

try {
  if (!payload || typeof payload !== 'object') throw new Error('unparseable hook input');
  const state = JSON.parse(readFileSync(statePath(root), 'utf8'));
  const r = evaluate(state, root, payload);
  if (r.deny) { process.stderr.write(`Ghostship guard: ${r.reason}\n`); process.exit(2); }
  process.exit(0);
} catch (e) {
  process.stderr.write(`Ghostship guard: failing closed (${e.message}). Run \`gs audit\` and fix the state, or ask the owner.\n`);
  process.exit(2);
}
