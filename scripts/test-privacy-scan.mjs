import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-privacy-fixture-'));
try {
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.copyFileSync(new URL('./privacy-scan.mjs', import.meta.url), path.join(dir, 'scripts/privacy-scan.mjs'));
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  assert.equal(init.status, 0);
  const file = path.join(dir, 'src/example.js');
  const run = () => {
    const r = spawnSync(process.execPath, [path.join(dir, 'scripts/privacy-scan.mjs'), '--json'], { cwd: dir, encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(r.error, undefined);
    return { status: r.status, data: JSON.parse(r.stdout), error: r.stderr };
  };
  fs.writeFileSync(file, '// 123456789\n// 567891234\nconst apiKey = "FixtureOnlySecret987654321X";\napiKey: FixtureOnlyBareSecret987654321X\n');
  let result = run();
  assert.equal(result.status, 1);
  assert.ok(result.data.findings.some(f => f.rule.startsWith('QQ') && f.line === 2), 'numeric account is detected after a filtered placeholder');
  assert.ok(result.data.findings.some(f => f.rule.startsWith('疑似凭据赋值') && f.line === 3), 'literal credential assignment is detected');
  assert.ok(result.data.findings.some(f => f.rule.startsWith('疑似凭据赋值') && f.line === 4), 'unquoted credential is detected');
  assert.equal(new Set(result.data.findings.map(f => `${f.rule}:${f.line}`)).size, result.data.findings.length, 'regex iteration does not repeat the first match');
  assert.doesNotMatch(result.error, /提前结束/);
  fs.writeFileSync(file, 'const apiKey = process.env.TEST_KEY;\n// 123456789\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"integrity":"sha512-FixtureOnlyIntegrity987654321XOtherCharacters"}\n');
  result = run();
  assert.equal(result.status, 0, 'environment references and lock integrity are not credentials');
  console.log('PASS privacy scan: filtered-first iteration, numeric identifiers, literal credentials and runtime-reference false positives');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
