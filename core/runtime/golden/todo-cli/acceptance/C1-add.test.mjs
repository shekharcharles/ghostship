// C1: todo add "milk" prints added: milk
import { todo, todoFile } from './_run.mjs';
const f = todoFile();
const out = todo(f, 'add', 'milk');
if (out.trim() !== 'added: milk') throw new Error(`C1: got ${JSON.stringify(out)}`);
