import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newCoverage, markArea, coverageSummary, SOFTWARE_AREAS } from '../lib/interview.mjs';

test('software preset has 22 areas, all open', () => {
  assert.equal(SOFTWARE_AREAS.length, 22);
  const c = newCoverage('standard');
  assert.equal(coverageSummary(c).open.length, 22);
});

test('marking areas: answered, na needs a reason, assumption needs a note', () => {
  let c = newCoverage('standard');
  c = markArea(c, 'vision', 'answered');
  assert.throws(() => markArea(c, 'ai-llm', 'na'), /reason/);
  c = markArea(c, 'ai-llm', 'na', 'no AI features in scope');
  assert.throws(() => markArea(c, 'timeline-delivery', 'assumption'), /note/);
  c = markArea(c, 'timeline-delivery', 'assumption', 'MVP in 4 weeks');
  const s = coverageSummary(c);
  assert.equal(s.open.length, 19);
  assert.deepEqual(s.assumptions, [{ area: 'timeline-delivery', note: 'MVP in 4 weeks' }]);
  assert.throws(() => markArea(c, 'nope', 'answered'), /unknown area/i);
});

test('light tier pre-marks heavy areas as na with a reason, still overridable', () => {
  const c = newCoverage('light');
  const s = coverageSummary(c);
  assert.ok(s.open.length < 22);
  const reopened = markArea(c, 'legal-compliance', 'open');
  assert.ok(coverageSummary(reopened).open.includes('legal-compliance'));
});
