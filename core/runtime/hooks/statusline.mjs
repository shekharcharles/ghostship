#!/usr/bin/env node
// Status line command: prints the Ghostship status in claude-deck's chips look (lib/deckline.mjs) and records the heartbeat
// (context fill, cost, rate limits) that the keeper, Harbor and spend tracking read.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tick } from '../lib/bridge.mjs';
import { deckLine } from '../lib/deckline.mjs';

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* ignore */ }
const root = process.env.CLAUDE_PROJECT_DIR || input.workspace?.project_dir || input.cwd || process.cwd();
if (!existsSync(join(root, '.ghostship/state/state.json'))) process.exit(0);
const cw = input.context_window || {};
const rl = input.rate_limits || {};
const usage = {
  context: { tokens: cw.total_input_tokens ?? undefined, window: cw.context_window_size ?? undefined, percent: cw.used_percentage ?? undefined },
  cost: input.cost?.total_cost_usd !== undefined ? { usd: input.cost.total_cost_usd } : undefined,
  rateLimits: Object.entries(rl).map(([k, v]) => ({ window: k, percent: v?.used_percentage ?? null, resetsAt: v?.resets_at ?? null })),
};
try {
  const snap = tick(root, { usage, sessionId: input.session_id || null, source: 'statusline' });
  process.stdout.write(deckLine(snap, usage) + '\n');
} catch (e) {
  process.stdout.write(`⛴ ghostship: ${e.message}\n`);
}
