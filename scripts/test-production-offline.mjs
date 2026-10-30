// Existing regression suites use synthetic data and local HTTP doubles.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const suites = [
  'test-memory-store.mjs', 'test-memory-bridge.mjs',
  'test-livingmemory-client.mjs', 'test-livingmemory-bridge.mjs', 'test-livingmemory-export.mjs',
  'test-shared-memory.mjs', 'test-busy-watchdog.mjs', 'test-reply-wait.mjs',
  'test-token-usage.mjs', 'test-group-budget.mjs',
  'test-pi-simple-tools.mjs', 'test-pi-tool-loop.mjs',
];
let failed = 0;
for (const suite of suites) {
  const result = spawnSync(process.execPath, ['scripts/' + suite], { cwd: root, encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error('FAIL', suite, result.error?.message || '', result.stdout || '', result.stderr || '');
  } else console.log('PASS', suite);
}
console.log(`${suites.length - failed}/${suites.length} suites passed`);
process.exitCode = failed ? 1 : 0;
