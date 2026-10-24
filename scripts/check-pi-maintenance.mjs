// Operator-only status/manual trigger. Does not call a model or send QQ.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const token = config.consoleToken || fs.readFileSync(path.join(root, 'state/console-token'), 'utf8').trim();
const run = process.argv.includes('--run');
const response = await fetch(`http://127.0.0.1:${config.consolePort || 3100}/api/pi/maintenance`, {
  method: run ? 'POST' : 'GET',
  headers: { 'x-console-token': token, 'x-console-admin': '1', 'content-type': 'application/json' },
  ...(run ? { body: '{}' } : {}), signal: AbortSignal.timeout(30000),
});
const result = await response.json();
if (!response.ok || !result.ok) throw Error(`Pi maintenance request failed: HTTP ${response.status}`);
console.log(JSON.stringify(result));
if ((result.report || result.lastReport)?.errors?.length) process.exitCode = 1;
