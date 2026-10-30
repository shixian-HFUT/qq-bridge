import fs from 'node:fs';
import path from 'node:path';
import { exportLivingMemory } from '../src/livingmemory-export.js';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const database = option('--db');
if (!database) throw Error('Usage: node scripts/export-livingmemory.mjs --db COPY.sqlite [--out PRIVATE.json]');
const output = exportLivingMemory(path.resolve(database));
const destination = option('--out');
if (destination) {
  if (path.resolve(destination) === path.resolve(database)) throw Error('Output must not replace the source database');
  // Never overwrite an existing migration manifest accidentally.
  fs.writeFileSync(path.resolve(destination), JSON.stringify(output) + '\n', { flag: 'wx', mode: 0o600 });
}
// A dry-run prints counts and IDs only. Private memory text is never stdout.
console.log(JSON.stringify({ dryRun: !destination, ...output.report }, null, 2));
