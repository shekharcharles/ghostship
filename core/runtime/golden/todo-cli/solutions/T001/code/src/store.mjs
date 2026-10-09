// Loads and saves the item list in the JSON file named by TODO_FILE.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
export const fileOf = () => process.env.TODO_FILE || '.todo.json';
export function load(file = fileOf()) {
  if (!existsSync(file)) return [];
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
}
export function save(file, items) { writeFileSync(file, JSON.stringify(items, null, 2) + '\n'); }
