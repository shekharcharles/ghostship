// Evidence and the tree: tool output never invalidates a run; a real change to source is refused and named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { projectAtBuild } from './project.mjs';
import * as E from '../lib/engine.mjs';

test('evidence: build output written by a command is fine; a source file it writes is refused by name', () => {
  const writes = (files) => `node -e "const fs=require('fs');for (const f of ${JSON.stringify(files).replace(/"/g, "'")}) { fs.mkdirSync(require('path').dirname(f),{recursive:true}); fs.writeFileSync(f, String(Date.now())) }"`;
  const dir = projectAtBuild({ configure: (cfg) => {
    cfg.commands.lint = writes(['dist/app.js', 'tsconfig.tsbuildinfo', 'node_modules/.vite/vitest/results.json', 'coverage/lcov.info']);
    cfg.commands.typecheck = writes(['src/generated.js', 'src/also.js']);
  } });
  try {
    E.taskStart(dir, 'T001');
    const lint = E.evidence(dir, { task: 'T001', kind: 'lint' });
    assert.equal(lint.accepted, true, lint.rejectReason || '');
    const tc = E.evidence(dir, { task: 'T001', kind: 'typecheck' });
    assert.equal(tc.accepted, false);
    assert.match(tc.rejectReason, /changed project files: src\/also\.js, src\/generated\.js; evidence must not change the tree/);
    assert.match(tc.rejectReason, /\.gitignore/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
