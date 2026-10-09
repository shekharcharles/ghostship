// C4: todo list with no items prints nothing to do
import { todo, todoFile } from './_run.mjs';
if (todo(todoFile(), 'list').trim() !== 'nothing to do') throw new Error('C4');
