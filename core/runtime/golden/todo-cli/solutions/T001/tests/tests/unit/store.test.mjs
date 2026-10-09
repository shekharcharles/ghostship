// Unit test: the store round-trips a list through the item file.
import { load, save } from '../../src/store.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const f = join(mkdtempSync(join(tmpdir(), 'todo-')), 'items.json');
if (load(f).length !== 0) throw new Error('empty store');
save(f, [{ text: 'a', done: false }]);
if (load(f)[0].text !== 'a') throw new Error('round trip');
