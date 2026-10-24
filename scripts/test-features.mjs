// Offline regression suite. Each script uses isolated fixtures, never real QQ.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-deepseek-web-search.mjs', 'test-fixed-observation.mjs',
  'test-group-identity.mjs', 'test-group-observation.mjs',
  'test-image-cdn.mjs', 'test-image-dedup.mjs', 'test-image-dns.mjs',
  'test-image-routing.mjs', 'test-image-sending.mjs', 'test-local-image.mjs',
  'test-memory-bridge.mjs', 'test-memory-store.mjs',
  'test-natural-participation.mjs', 'test-network-failure.mjs',
  'test-pi-image-rejection.mjs', 'test-pi-maintenance.mjs', 'test-pi-media.mjs',
  'test-site-browser.mjs', 'test-privacy-scan.mjs', 'test-tts-feedback.mjs', 'test-tts-transport.mjs',
  'test-tts.mjs', 'test-voice-cadence.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000, windowsHide: true,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nFeature suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
