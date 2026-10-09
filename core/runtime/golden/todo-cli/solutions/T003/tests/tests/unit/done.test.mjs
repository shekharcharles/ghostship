// Unit test: done marks an item and list shows [x].
import { add, done, list } from '../../src/commands.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const f = join(mkdtempSync(join(tmpdir(), 'todo-')), 'items.json');
add(f, 'milk');
if (done(f, 1) !== 'done: milk') throw new Error('done');
if (list(f) !== '1. [x] milk') throw new Error('list after done');
