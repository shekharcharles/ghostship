import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, stringifyYaml } from '../lib/yaml.mjs';

test('parses nested maps, lists, scalars and comments', () => {
  const y = parseYaml(`# top comment
project:
  name: my-app      # trailing comment
  tier: standard
tracker: { mode: local }
routing:
  tiers:
    grunt: [local-qwen, claude-haiku]
    frontier:
      - claude-opus
      - "claude sonnet"
loop:
  max-parallel: 4
  yolo: true
  ratio: 0.5
  empty: ''
  nothing: null
paths: ['.env*', "*.pem"]
`);
  assert.equal(y.project.name, 'my-app');
  assert.equal(y.tracker.mode, 'local');
  assert.deepEqual(y.routing.tiers.grunt, ['local-qwen', 'claude-haiku']);
  assert.deepEqual(y.routing.tiers.frontier, ['claude-opus', 'claude sonnet']);
  assert.equal(y.loop['max-parallel'], 4);
  assert.equal(y.loop.yolo, true);
  assert.equal(y.loop.ratio, 0.5);
  assert.equal(y.loop.empty, '');
  assert.equal(y.loop.nothing, null);
  assert.deepEqual(y.paths, ['.env*', '*.pem']);
});

test('parses lists of maps', () => {
  const y = parseYaml(`exceptions:
  - rule: test-first
    paths: [ui/**]
    until: 2026-12-01
  - rule: scope
    paths: []
`);
  assert.equal(y.exceptions.length, 2);
  assert.equal(y.exceptions[0].rule, 'test-first');
  assert.deepEqual(y.exceptions[0].paths, ['ui/**']);
  assert.equal(y.exceptions[0].until, '2026-12-01');
  assert.deepEqual(y.exceptions[1].paths, []);
});

test('round-trips through stringify', () => {
  const obj = { a: { b: 1, c: [1, 'two', true], d: { e: 'x: y' } }, f: [], g: {}, h: [{ k: 'v', n: 2 }] };
  assert.deepEqual(parseYaml(stringifyYaml(obj)), obj);
});

test('strings that look like other types stay strings when quoted', () => {
  const y = parseYaml(`v: "1.0"\nw: 'true'\nx: "# not a comment"\n`);
  assert.equal(y.v, '1.0');
  assert.equal(y.w, 'true');
  assert.equal(y.x, '# not a comment');
});

test('rejects tabs and bad indentation with a line number', () => {
  assert.throws(() => parseYaml('a:\n\tb: 1\n'), /line 2/);
  assert.throws(() => parseYaml('a:\n  b: 1\n c: 2\n'), /line 3/);
});
