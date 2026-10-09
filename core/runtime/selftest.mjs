#!/usr/bin/env node
// Cross-platform test runner (Node 18+ cannot glob `--test` arguments; PowerShell does not expand globs).
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'test');
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => join(dir, f));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
