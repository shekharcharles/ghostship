// The todo commands: each takes the item file and returns the text to print.
import { load, save } from './store.mjs';
export function add(file, text) {
  const items = load(file);
  items.push({ text, done: false });
  save(file, items);
  return `added: ${text}`;
}
export function list(file) {
  const items = load(file);
  if (!items.length) return 'nothing to do';
  return items.map((it, i) => `${i + 1}. [${it.done ? 'x' : ' '}] ${it.text}`).join('\n');
}
