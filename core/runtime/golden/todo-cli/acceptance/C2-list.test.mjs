// C2: todo list prints the items numbered from 1
import { todo, todoFile } from './_run.mjs';
const f = todoFile();
todo(f, 'add', 'milk'); todo(f, 'add', 'eggs');
const out = todo(f, 'list');
if (out !== '1. [ ] milk\n2. [ ] eggs\n') throw new Error(`C2: got ${JSON.stringify(out)}`);
