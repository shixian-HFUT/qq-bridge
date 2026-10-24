import assert from 'node:assert/strict';
import { test } from 'node:test';
import dns from 'node:dns';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const original = dns.promises.lookup;
dns.promises.lookup = async host => host === 'mixed.test' ? [{ address: '198.18.0.1' }, { address: '127.0.0.1' }] : [{ address: '198.18.0.1' }];
let mod;
try { mod = await import('../src/safe-fetch.js'); } finally { dns.promises.lookup = original; }
const { configureSafeDns, resolveSafeHost, validateFetchUrl } = mod;
function transport(t, address = '93.184.216.34') {
  let calls = 0;
  t.mock.method(https, 'request', (options, cb) => {
    calls++; assert.equal(options.hostname, '1.1.1.1'); assert.equal(options.servername, 'cloudflare-dns.com');
    assert.equal(options.rejectUnauthorized, true); assert.equal(options.headers.accept, 'application/dns-json');
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = new PassThrough(); res.statusCode = 200; res.headers = {}; res.complete = true;
      cb(res); res.end(JSON.stringify({ Status: 0, Question: [{ name: 'fake.test.' }], Answer: [{ type: 1, TTL: 60, data: address }] }));
    }); return req;
  });
  return () => calls;
}
test('opt-in fake DNS fallback authenticates its fixed resolver and caches only public answers', async t => {
  configureSafeDns({ fakeDnsFallback: true }); t.after(() => configureSafeDns());
  const calls = transport(t);
  assert.equal(await resolveSafeHost('fake.test'), '93.184.216.34');
  assert.equal(await resolveSafeHost('fake.test'), '93.184.216.34'); assert.equal(calls(), 1);
});
test('private, mixed and literal virtual addresses are never exempted by fallback', async t => {
  configureSafeDns({ fakeDnsFallback: true }); t.after(() => configureSafeDns());
  const calls = transport(t, '127.0.0.1');
  await assert.rejects(resolveSafeHost('fake.test'), /安全公网地址/);
  await assert.rejects(resolveSafeHost('mixed.test'), /内网/);
  for (const url of ['http://127.0.0.1/', 'http://198.18.0.1/', 'http://localhost/']) await assert.rejects(validateFetchUrl(url), /内网/);
  assert.equal(calls(), 1);
});
test('fallback stays disabled unless explicitly configured', async () => {
  configureSafeDns(); await assert.rejects(resolveSafeHost('fake.test'), /内网/);
});
