import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskFile, renderTaskFile, slugify } from '../lib/tasks.mjs';

const SAMPLE = `---
id: T014
title: Reject wrong password
phase: 1-mvp
kind: feat
tier: standard
risk: high
checks: [C3, C4]
requirement: PRD#login
blockedBy: [T001]
allowedPaths: [src/auth/**, tests/auth/**]
testCommand: node --test tests/auth
---

## Goal
Users who type a wrong password are rejected.

## Context
docs/02-design/ARCHITECTURE.md#auth
`;

test('parses front matter and sections', () => {
  const t = parseTaskFile(SAMPLE);
  assert.equal(t.meta.id, 'T014');
  assert.deepEqual(t.meta.checks, ['C3', 'C4']);
  assert.deepEqual(t.meta.allowedPaths, ['src/auth/**', 'tests/auth/**']);
  assert.equal(t.meta.testCommand, 'node --test tests/auth');
  assert.match(t.sections.Goal, /wrong password/);
  assert.match(t.sections.Context, /ARCHITECTURE/);
});

test('render includes managed status fields, done-when checklist and history', () => {
  const t = parseTaskFile(SAMPLE);
  const out = renderTaskFile({ ...t.meta, status: 'building', attempt: 2, maxAttempts: 3, restarts: 1, branch: 'task/T014-reject-wrong-password' },
    t.sections, { judgeNotes: ['attempt 1: C4 FAIL — lockout not applied'], history: ['2026-10-06 start attempt 1'] });
  assert.match(out, /^---\nid: T014/);
  assert.match(out, /status: building/);
  assert.match(out, /attempts: 2\/3/);
  assert.match(out, /## Done when/);
  assert.match(out, /## Judge notes\n- attempt 1: C4 FAIL/);
  const again = parseTaskFile(out);
  assert.equal(again.meta.status, 'building');
  assert.match(again.sections.Goal, /wrong password/);
});

test('rejects a task file without front matter or id', () => {
  assert.throws(() => parseTaskFile('# no front matter'), /front matter/);
  assert.throws(() => parseTaskFile('---\ntitle: x\n---\n'), /id/);
});

test('slugify makes short kebab names', () => {
  assert.equal(slugify('Reject wrong password!'), 'reject-wrong-password');
  assert.equal(slugify('A'.repeat(80)).length <= 40, true);
});
