#!/usr/bin/env node
// SessionStart hook: re-inject where the project stands from durable state, so a resumed or cleared session continues correctly.
import { readFileSync, existsSync } from 'node:fs';
import { statePath } from '../lib/store.mjs';
import { status, audit } from '../lib/engine.mjs';

let payload = {};
try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* ignore */ }
const root = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
if (!existsSync(statePath(root))) process.exit(0);

const lines = ['[Ghostship] This project is run by Ghostship. State on disk is the truth; do not rely on memory of earlier sessions.'];
try {
  const s = status(root);
  lines.push(`stage=${s.stage} approvals=${s.approvals} tasks=${JSON.stringify(s.counts)}`);
  if (s.active) lines.push(`ACTIVE: ${s.active.id} ${s.active.status} attempt ${s.active.attempt}/${s.active.max} (attempts carry over on resume)`);
  if (s.needsDecision.length) lines.push(`NEEDS YOUR DECISION: ${s.needsDecision.join(', ')}`);
  if (s.frontier.length) lines.push(`ready: ${s.frontier.join(', ')}`);
  lines.push(`next: ${s.next}`);
} catch (e) {
  lines.push(`STATE UNREADABLE: ${e.message}. Stop and ask the owner.`);
}
try {
  const a = audit(root);
  if (!a.ok) lines.push(`AUDIT FAILED: ${a.problems.slice(0, 5).join('; ')}. Treat as a decision for the owner.`);
} catch (e) { lines.push(`AUDIT FAILED: ${e.message}`); }
try {
  const { loadConfig } = await import('../lib/config.mjs');
  const UP = await import('../lib/upgrade.mjs');
  const c = UP.check(root);
  if (c.newer) {
    const auto = loadConfig(root).upgrade?.auto;
    if (auto === 'safe-point' && UP.safePoint(root).ok) {
      const r = UP.apply(root);
      lines.push(r.ok ? `Ghostship core upgraded ${r.from} → ${r.to} at this safe point (rollback: gs upgrade rollback).` : `Ghostship core ${c.available} is available but was not applied: ${r.reason}`);
    } else lines.push(`Ghostship core ${c.available} is available (this project runs ${c.project}); it applies at the next safe point, or run gs upgrade apply.`);
  }
} catch { /* upgrade is best effort */ }
lines.push('Continue with /ghostship resume.');
process.stdout.write(lines.join('\n') + '\n');
