// Harbor: project list, detail, owner config edits with validation, pause/go, token rules, terminal table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectAtBuild, GS } from './project.mjs';
import { createHarbor, registerProject, readProjects, tuiTable, saveConfigText, detail, APPROVAL_MODES } from '../lib/harbor.mjs';
import * as E from '../lib/engine.mjs';

test('Harbor API: token required, summaries, detail, config validation, pause and resume', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gs-home-'));
  const a = projectAtBuild({ configure: (c) => { c.autonomy = { ...c.autonomy, mode: 'guided' }; } });
  try {
    registerProject(home, { name: 'math', path: a });
    registerProject(home, { name: 'gone', path: join(home, 'nope') });
    registerProject(home, { name: 'math', path: a });
    assert.equal(readProjects(home).length, 2, 'no duplicates');
    for (let i = 1; i <= 3; i++) { E.taskStart(a, 'T001'); E.taskFail(a, 'T001', `x${i}`); }
    const h = createHarbor({ home, token: 'tok' });
    const port = await h.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const call = (p, body, token = 'tok') => fetch(base + p, body ? { method: 'POST', headers: { 'x-harbor-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: { 'x-harbor-token': token } });
    try {
      assert.equal(h.server.address().address, '127.0.0.1');
      assert.equal((await fetch(base + '/')).status, 401);
      assert.match(await (await fetch(base + '/?t=tok')).text(), /<title>Harbor · Ghostship<\/title>/);
      assert.equal((await fetch(base + '/api/projects?t=tok')).status, 401, 'API needs the header, not the URL');
      const list = await (await call('/api/projects')).json();
      assert.deepEqual(list.map((p) => [p.name, p.health]), [['math', 'action'], ['gone', 'missing']]);
      assert.deepEqual(list[0].needsDecision, ['T001']);
      const d = await (await call('/api/project?path=' + encodeURIComponent(a))).json();
      assert.equal(d.tasks.length, 2);
      assert.ok(d.agents.some((x) => x.id === 'claude-sonnet' && x.runsAs === 'in-session'));
      assert.match(d.configText, /tracker:/);
      const bad = await (await call('/api/config', { path: a, text: d.configText.replace('mode: local', 'mode: carrier-pigeon') })).json();
      assert.equal(bad.ok, false);
      assert.match(bad.errors.join(), /tracker\.mode/);
      const good = await (await call('/api/config', { path: a, text: d.configText.replace(/confidential: false/, 'confidential: true') })).json();
      assert.equal(good.ok, true);
      assert.match(readFileSync(join(a, '.ghostship/config.yaml'), 'utf8'), /confidential: true/);
      await call('/api/pause', { path: a });
      assert.equal((await (await call('/api/projects')).json())[0].paused, true);
      await call('/api/go', { path: a });
      assert.equal((await (await call('/api/projects')).json())[0].paused, false);
      assert.equal((await call('/api/pause', { path: '/elsewhere' })).status, 404, 'only registered projects');
      assert.match(tuiTable(home), /⚑\s+math\s+build[\s\S]*✗\s+gone/);
    } finally { h.server.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(a, { recursive: true, force: true }); }
});

test('gs harbor web refuses to start without the owner\'s terminal; --tui --once works anywhere', () => {
  const home = mkdtempSync(join(tmpdir(), 'gs-home-'));
  try {
    const env = { ...process.env, GHOSTSHIP_HOME: home, CLAUDE_PROJECT_DIR: '' };
    assert.match(spawnSync(process.execPath, [GS, 'harbor'], { encoding: 'utf8', env }).stderr, /HUMAN_GATE/);
    assert.match(spawnSync(process.execPath, [GS, 'harbor', '--tui', '--once'], { encoding: 'utf8', env }).stdout, /No projects yet/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Harbor config: approvals.mode takes terminal, chat or bridge, and nothing else; the detail shows it', () => {
  const a = projectAtBuild();
  try {
    assert.deepEqual(APPROVAL_MODES.map((m) => m.mode), ['terminal', 'chat', 'bridge']);
    const text = readFileSync(join(a, '.ghostship/config.yaml'), 'utf8');
    assert.match(text, /mode: chat/, 'chat is the default');
    assert.equal(saveConfigText(a, text.replace(/mode: chat/, 'mode: terminal')).ok, true);
    assert.equal(detail({ name: 'math', path: a }).approvals, 'terminal');
    assert.equal(saveConfigText(a, text).ok, true);
    assert.equal(detail({ name: 'math', path: a }).approvals, 'chat');
    const bad = saveConfigText(a, text.replace(/mode: chat/, 'mode: yolo'));
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join(' '), /terminal, chat or bridge/);
    assert.equal(detail({ name: 'math', path: a }).approvals, 'chat', 'a rejected edit writes nothing');
  } finally { rmSync(a, { recursive: true, force: true }); }
});
