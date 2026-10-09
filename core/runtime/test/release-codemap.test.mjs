import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextVersion, changelogSection, conventionalMessage } from '../lib/release.mjs';
import { purposeOf, buildCodemap, missingPurposeHeaders } from '../lib/codemap.mjs';

test('semver from conventional commits; 0.x until 1.0 declared', () => {
  assert.equal(nextVersion(null, ['feat(auth): x']), '0.1.0');
  assert.equal(nextVersion('0.1.0', ['fix: y']), '0.1.1');
  assert.equal(nextVersion('0.1.1', ['feat: z', 'fix: q']), '0.2.0');
  assert.equal(nextVersion('0.2.0', ['feat!: breaking']), '0.3.0', 'breaking bumps minor while 0.x');
  assert.equal(nextVersion('1.2.3', ['feat!: breaking']), '2.0.0');
  assert.equal(nextVersion('1.2.3', ['refactor: tidy', 'docs: x']), '1.2.4');
});

test('changelog groups by type and keeps task refs', () => {
  const md = changelogSection('0.2.0', '2026-10-06', ['feat(auth): reject wrong password (T014, C1)', 'fix(ui): button (T015)', 'chore(ghostship): T014 merged']);
  assert.match(md, /## 0\.2\.0 — 2026-10-06/);
  assert.match(md, /### Features\n- \*\*auth\*\*: reject wrong password \(T014, C1\)/);
  assert.match(md, /### Fixes/);
  assert.doesNotMatch(md, /ghostship\): T014 merged/, 'bookkeeping commits hidden');
});

test('conventional message from a task', () => {
  assert.equal(conventionalMessage({ id: 'T014', kind: 'feat', title: 'Reject wrong password', checks: ['C1', 'C2'], allowedPaths: ['src/auth/**'] }),
    'feat(auth): reject wrong password (T014, C1 C2)');
});

test('purpose headers: comment on first line (after shebang) per language', () => {
  assert.equal(purposeOf('a.js', '#!/usr/bin/env node\n// Parses invoices from CSV.\nx'), 'Parses invoices from CSV.');
  assert.equal(purposeOf('a.py', '"""Talks to the bank API."""\n'), 'Talks to the bank API.');
  assert.equal(purposeOf('a.py', '# Bank API client\n'), 'Bank API client');
  assert.equal(purposeOf('a.ts', '/* Shared types for billing */\n'), 'Shared types for billing');
  assert.equal(purposeOf('a.ts', 'export const x = 1\n'), null);
  assert.equal(purposeOf('README.md', 'anything'), undefined, 'non-source files are not checked');
});

test('codemap renders a tree with purposes; missing headers are listed', () => {
  const files = { 'src/app.js': '// App entry point.\n', 'src/auth/login.js': '// Login handler.\n', 'src/util.js': 'export {}\n', 'package.json': '{}' };
  const md = buildCodemap(files);
  assert.match(md, /src\/\n/);
  assert.match(md, /app\.js — App entry point\./);
  assert.match(md, /login\.js — Login handler\./);
  assert.match(md, /util\.js — ⚠ no purpose header/);
  assert.deepEqual(missingPurposeHeaders(files, ['src/util.js', 'src/app.js', 'package.json']), ['src/util.js']);
});
