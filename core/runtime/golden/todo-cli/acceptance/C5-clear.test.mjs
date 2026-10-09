// C5: todo clear empties the list
import { todo, todoFile } from './_run.mjs';
const f = todoFile();
todo(f, 'add', 'milk');
if (todo(f, 'clear').trim() !== 'cleared') throw new Error('C5: confirmation');
if (todo(f, 'list').trim() !== 'nothing to do') throw new Error('C5: still has items');
