// The status line names what each Ghostship agent is doing, from the guard's heartbeat, even after Claude's own turn ended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectAtBuild, CORE } from './project.mjs';

const HOOK = (n) => join(CORE, 'runtime', 'hooks', n);
const run = (hook, dir, input) => spawnSync(process.execPath, [HOOK(hook)], { cwd: dir, input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir, NO_COLOR: '1' } });

test('a builder\'s tool call shows on the status line as "builder: Editing add.mjs"', () => {
  const dir = projectAtBuild();
  try {
    run('guard.mjs', dir, { tool_name: 'Read', tool_input: { file_path: `${dir}/src/add.mjs` }, agent_type: 'ghostship-builder', agent_id: 'b1' });
    run('guard.mjs', dir, { tool_name: 'Edit', tool_input: { file_path: `${dir}/src/add.mjs` }, agent_type: 'ghostship-builder', agent_id: 'b1' });
    const out = run('statusline.mjs', dir, { session_id: 's1', workspace: { project_dir: dir }, cost: { total_cost_usd: 0.4 }, context_window: { used_percentage: 10 } }).stdout;
    const lines = out.trimEnd().split('\n');
    assert.match(lines.at(-1), /^◆ builder: Editing add\.mjs · \d+s$/);
    const quiet = run('guard.mjs', dir, { tool_name: 'Read', tool_input: { file_path: `${dir}/README.md` } });
    assert.equal(quiet.status, 0, 'the main session records no heartbeat and is not refused');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
