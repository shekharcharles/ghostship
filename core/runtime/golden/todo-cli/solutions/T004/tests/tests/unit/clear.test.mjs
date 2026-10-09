// Unit test: clear empties the list.
import { add, clear, list } from '../../src/commands.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const f = join(mkdtempSync(join(tmpdir(), 'todo-')), 'items.json');
add(f, 'milk');
if (clear(f) !== 'cleared') throw new Error('clear');
if (list(f) !== 'nothing to do') throw new Error('list after clear');
