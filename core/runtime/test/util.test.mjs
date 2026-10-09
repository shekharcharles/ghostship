import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, matchesAny, normRel, redact, detectSkips, sha256 } from '../lib/util.mjs';

test('glob: ** spans directories, * stays in one segment', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b/c.ts'));
  assert.ok(globToRegExp('src/*.ts').test('src/a.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('**/*.test.*').test('a/b/x.test.mjs'));
  assert.ok(globToRegExp('**/*.test.*').test('x.test.js'));
  assert.ok(!globToRegExp('src/**').test('srcx/a.ts'));
});

test('glob: trailing slash means the whole directory', () => {
  assert.ok(matchesAny('src/auth/login.ts', ['src/auth/']));
  assert.ok(!matchesAny('src/authz/login.ts', ['src/auth/']));
});

test('glob: regex metacharacters in patterns are literal', () => {
  assert.ok(matchesAny('lib/a+b.(x).js', ['lib/a+b.(x).js']));
  assert.ok(!matchesAny('lib/aab.x.js', ['lib/a+b.(x).js']));
});

test('normRel: backslashes, ./ prefixes, absolute paths under root', () => {
  assert.equal(normRel('/repo', 'src\\a\\b.ts'), 'src/a/b.ts');
  assert.equal(normRel('/repo', './src/a.ts'), 'src/a.ts');
  assert.equal(normRel('/repo', '/repo/src/a.ts'), 'src/a.ts');
});

test('normRel: escape outside root returns null (fail closed)', () => {
  assert.equal(normRel('/repo', '../etc/passwd'), null);
  assert.equal(normRel('/repo', '/etc/passwd'), null);
  assert.equal(normRel('/repo', 'src/../../x'), null);
});

test('redact: removes literal secrets and shaped keys', () => {
  const out = redact('db=hunter2hunter2 key=AKIAABCDEFGHIJKLMNOP tok=ghp_abcdefghijklmnopqrstuvwxyz0123456789', ['hunter2hunter2']);
  assert.ok(!out.includes('hunter2hunter2'));
  assert.ok(!out.includes('AKIAABCDEFGHIJKLMNOP'));
  assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.ok(out.includes('[REDACTED]'));
});

test('redact: ignores short literals (would redact everywhere)', () => {
  assert.equal(redact('abc def', ['abc']), 'abc def');
});

test('detectSkips: flags skipped/todo/no-tests, ignores zero counts', () => {
  assert.ok(detectSkips('Tests: 3 passed, 1 skipped'));
  assert.ok(detectSkips('ℹ skipped 2'));
  assert.ok(detectSkips('collected 0 items'));
  assert.ok(detectSkips('No tests found'));
  assert.equal(detectSkips('Tests: 3 passed, 0 skipped\nℹ skipped 0\nℹ todo 0'), null);
});

test('sha256 is stable hex', () => {
  assert.equal(sha256('a'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
});
