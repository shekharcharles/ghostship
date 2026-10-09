// The gs CLI end to end through real processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GS = join(dirname(fileURLToPath(import.meta.url)), '..', 'gs.mjs');
const gs = (dir, ...args) => spawnSync(process.execPath, [GS, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });

test('init prints a health table, status says what is next, errors carry codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gs-cli-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    const init = gs(dir, 'init', '--name', 'demo', '--tier', 'light', '--approvals', 'chat');
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /\| permission bypass +\| ON — agents launch with --dangerously-skip-permissions/);
    assert.match(init.stdout, /Next: \/ghostship new/);
    assert.match(gs(dir, 'status').stdout, /stage: new[\s\S]*next: Start the interview \(gs interview init\)/);
    assert.equal(gs(dir, 'interview', 'init').status, 0);
    const mark = gs(dir, 'interview', 'mark', 'vision', 'na');
    assert.equal(mark.status, 1);
    assert.match(mark.stderr, /needs a reason/);
    const bad = gs(dir, 'prd', 'approve');
    assert.match(bad.stderr, /✗ COVERAGE_OPEN/);
    assert.equal(gs(dir, 'frobnicate').status, 64);
    assert.match(gs(dir, 'config', 'check').stdout, /Config OK/);
    assert.match(gs(dir, 'audit').stdout, /OK — \d+ events verified/);
    // chat-mode approval takes the owner's quote
    const st = JSON.parse(gs(dir, 'interview', 'status', '--json').stdout);
    for (const a of st.open) gs(dir, 'interview', 'mark', a, 'answered');
    mkdirSync(join(dir, 'docs/01-requirements'), { recursive: true });
    writeFileSync(join(dir, 'docs/01-requirements/PRD.draft.md'), '# PRD\n\nA demo project built only to test the CLI.\n');
    const ok = gs(dir, 'prd', 'approve', '--quote', 'Yes, approve the PRD');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(gs(dir, 'status').stdout, /stage: design/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
