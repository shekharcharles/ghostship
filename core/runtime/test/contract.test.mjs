import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContract, lintContract } from '../lib/contract.mjs';
import { CHECKS } from './fixtures.mjs';

test('parses checks, out of scope and unknowns with owner/date', () => {
  const c = parseContract(CHECKS);
  assert.deepEqual(c.checks.map((x) => [x.id, x.kind]), [['C1', 'run'], ['C2', 'run'], ['C3', 'pick']]);
  assert.equal(c.outOfScope.length, 1);
  assert.deepEqual(c.unknowns[0], { id: 'U1', text: 'Lockout threshold', owner: 'Charles', by: '2026-10-20', blocks: ['C2'] });
});

test('lint passes the fixture', () => {
  const r = lintContract(CHECKS);
  assert.deepEqual(r.errors, []);
});

test('lint: one outcome per check, valid kind, source, reference for pick', () => {
  assert.match(lintContract(CHECKS.replace('within 300 ms', 'and logs it')).errors.join(), /C1.*one outcome/);
  assert.match(lintContract(CHECKS.replace('| run |', '| score |')).errors.join(), /kind/);
  assert.match(lintContract(CHECKS.replace('mocks/login-b.png', '-')).errors.join(), /C3.*reference/);
  assert.match(lintContract(CHECKS.replace('PRD#login |', '- |')).errors.join(), /source/);
});

test('lint: unknowns need owner and date; out of scope must not be empty', () => {
  assert.match(lintContract(CHECKS.replace('owner: Charles, ', '')).errors.join(), /U1.*owner/);
  assert.match(lintContract(CHECKS.replace(', by: 2026-10-20', '')).errors.join(), /U1.*date/);
  assert.match(lintContract(CHECKS.replace('1. Password reset — later', '')).errors.join(), /Out of scope/);
});

test('lint accepts "None identified" unknowns', () => {
  const c = CHECKS.replace(/- U1:.*\n/, 'None identified — all decisions closed\n');
  assert.deepEqual(lintContract(c).errors, []);
});
