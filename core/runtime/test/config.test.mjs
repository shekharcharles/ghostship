import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadConfig, saveConfig, validateConfig } from '../lib/config.mjs';

test('defaults are Claude-only and safe', () => {
  const c = defaultConfig({ name: 'demo' });
  assert.equal(c.project.name, 'demo');
  assert.equal(c.tracker.mode, 'local');
  assert.equal(c.approvals.mode, 'chat', 'new projects approve in chat with the owner\'s quoted words, so approvals work from any client; bridge and terminal stay available');
  assert.deepEqual(c.routing.tiers.frontier, ['claude-opus']);
  assert.equal(c.loop.attempts, 3);
  assert.equal('permissionBypass' in c.launch, false, 'Ghostship has no bypass setting');
  assert.deepEqual(validateConfig(c), []);
});

test('save then load round-trips and fills missing keys from defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gs-cfg-'));
  const c = defaultConfig({ name: 'demo' });
  saveConfig(dir, c);
  assert.match(readFileSync(join(dir, '.ghostship/config.yaml'), 'utf8'), /^# Ghostship project config/);
  assert.deepEqual(loadConfig(dir), c);
  writeFileSync(join(dir, '.ghostship/config.yaml'), 'project: { name: x }\nloop: { attempts: 5 }\n');
  const merged = loadConfig(dir);
  assert.equal(merged.loop.attempts, 5);
  assert.equal(merged.loop['max-parallel'], 1, 'Phase A default');
  assert.equal(merged.tracker.mode, 'local');
});

test('validation catches bad values', () => {
  const c = defaultConfig({ name: 'demo' });
  c.loop.attempts = 0;
  c.tracker.mode = 'jira';
  c.routing.tiers.grunt = ['not-an-agent'];
  const errs = validateConfig(c);
  assert.ok(errs.some((e) => /attempts/.test(e)));
  assert.ok(errs.some((e) => /tracker/.test(e)));
  assert.ok(errs.some((e) => /not-an-agent/.test(e)));
});
