// C3: todo done 1 marks item 1 as [x]
import { todo, todoFile } from './_run.mjs';
const f = todoFile();
todo(f, 'add', 'milk');
if (todo(f, 'done', '1').trim() !== 'done: milk') throw new Error('C3: confirmation');
if (todo(f, 'list') !== '1. [x] milk\n') throw new Error('C3: list');
