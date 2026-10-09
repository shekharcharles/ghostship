#!/usr/bin/env node
// The todo command line: parses argv and prints what the command returns.
import { fileOf } from '../src/store.mjs';
import * as c from '../src/commands.mjs';
const USAGE = 'usage: todo add "<text>" | list | done <n> | clear';
const [cmd, ...rest] = process.argv.slice(2);
const file = fileOf();
let out;
if (cmd === 'add' && rest.length) out = c.add(file, rest.join(' '));
else if (cmd === 'list') out = c.list(file);
else if (cmd === 'done' && rest[0] && c.done) out = c.done(file, Number(rest[0]));
else if (cmd === 'clear' && c.clear) out = c.clear(file);
else { console.error(USAGE); process.exit(2); }
console.log(out);
