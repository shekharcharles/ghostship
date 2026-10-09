// Unit test: add stores an item and list formats it.
import { add, list } from '../../src/commands.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const f = join(mkdtempSync(join(tmpdir(), 'todo-')), 'items.json');
if (list(f) !== 'nothing to do') throw new Error('empty list');
if (add(f, 'milk') !== 'added: milk') throw new Error('add');
if (list(f) !== '1. [ ] milk') throw new Error('list');
