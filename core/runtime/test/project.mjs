// Shared fixture: a Ghostship project driven to the plan stage with locked acceptance tests and two imported tasks.
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initProject } from '../lib/init.mjs';
import { loadConfig, saveConfig } from '../lib/config.mjs';
import * as E from '../lib/engine.mjs';

export const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GS = join(CORE, 'runtime', 'gs.mjs');
export const TTY = { via: 'tty', confirmed: true };
export const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
export const put = (dir, rel, s) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), s); };

export const CHECKS = `# Acceptance checks — math

## Destination
A tiny math library.

## Checks
| # | check | kind | proven by | reference | source |
|---|---|---|---|---|---|
| C1 | add(2, 3) returns 5 | run | tests/acceptance/C1-* | - | PRD#add |
| C2 | sub(5, 3) returns 2 | run | tests/acceptance/C2-* | - | PRD#sub |

## Out of scope
1. Multiplication

## Unknowns
None identified — two pure functions.
`;

export function projectAtBuild({ configure } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gs-proj-'));
  initProject(dir, { name: 'math', coreSrc: CORE, gitIdentity: { name: 't', email: 't@t' }, which: () => null, tier: 'light' });
  git(dir, 'config', 'commit.gpgsign', 'false');
  E.interviewInit(dir);
  for (const a of E.interviewStatus(dir).open) E.interviewMark(dir, a, 'answered', 'ok');
  put(dir, 'docs/01-requirements/PRD.draft.md', '# PRD — math\n\n## add\nAdds two numbers.\n\n## sub\nSubtracts.\n');
  E.prdApprove(dir, TTY);
  put(dir, 'docs/02-design/BLUEPRINT.md', '# Blueprint\n\nTwo pure functions in src/, one file each, unit tests in tests/unit.\n');
  E.designDone(dir);
  put(dir, 'docs/03-acceptance/ACCEPTANCE-CHECKS.draft.md', CHECKS);
  E.acceptanceApprove(dir, TTY);
  const cfg = loadConfig(dir);
  cfg.commands.test = 'node scripts/unit.mjs';
  cfg.commands.acceptance = 'node scripts/acc.mjs {files}';
  if (configure) configure(cfg);
  saveConfig(dir, cfg);
  put(dir, 'scripts/unit.mjs', "// Runs unit tests.\nimport { readdirSync } from 'node:fs';\nconst f = readdirSync('tests/unit').filter((x) => x.endsWith('.test.mjs'));\nfor (const x of f) await import('../tests/unit/' + x);\nconsole.log(f.length ? f.length + ' files passed' : 'no tests found');\n");
  put(dir, 'scripts/acc.mjs', "// Runs acceptance tests.\nconst f = process.argv.slice(2);\nif (!f.length) { console.log('no tests found'); process.exit(1); }\nfor (const x of f) await import('../' + x);\nconsole.log(f.length + ' acceptance files passed');\n");
  put(dir, 'tests/unit/.gitkeep', '');
  git(dir, 'add', '-A', '--', '.ghostship/config.yaml', 'scripts', 'tests/unit');
  git(dir, 'commit', '-qm', 'chore: runners');
  put(dir, 'tests/acceptance/C1-add.test.mjs', "// C1\nimport { add } from '../../src/add.mjs';\nif (add(2, 3) !== 5) throw new Error('C1');\n");
  put(dir, 'tests/acceptance/C2-sub.test.mjs', "// C2\nimport { sub } from '../../src/sub.mjs';\nif (sub(5, 3) !== 2) throw new Error('C2');\n");
  E.acceptanceLock(dir);
  put(dir, '.ghostship/drafts/tasks/T001.md', '---\nid: T001\ntitle: Add two numbers\nchecks: [C1]\nallowedPaths: [src/add.mjs, tests/unit/add.test.mjs]\n---\n\n## Goal\nadd()\n');
  put(dir, '.ghostship/drafts/tasks/T002.md', '---\nid: T002\ntitle: Subtract two numbers\nrisk: high\nchecks: [C2]\nblockedBy: [T001]\nallowedPaths: [src/sub.mjs, tests/unit/sub.test.mjs]\n---\n\n## Goal\nsub()\n');
  E.taskImport(dir);
  return dir;
}

/** Put a fake executable (a Node script) on a private PATH directory. */
export function fakeBin(binDir, name, source) {
  mkdirSync(binDir, { recursive: true });
  const p = join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${source}\n`);
  chmodSync(p, 0o755);
  return p;
}
