import assert from 'node:assert/strict';
import { test } from 'node:test';
import dns from 'node:dns';
import https from 'node:https';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const original = dns.promises.lookup;
dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
let module;
try { module = await import('../src/safe-fetch.js'); } finally { dns.promises.lookup = original; }
const png = Buffer.from('89504e470d0a1a0a0000000000000000', 'hex');
function transport(t, scripts) {
  const calls = [];
  t.mock.method(https, 'request', (options, callback) => {
    const script = scripts[calls.length]; assert.ok(script, 'Unexpected extra download'); calls.push(options);
    const req = new EventEmitter(); req.destroy = e => { if (e) queueMicrotask(() => req.emit('error', e)); };
    req.end = () => queueMicrotask(() => {
      const res = new PassThrough(); res.statusCode = script.status || 200; res.headers = script.headers || {}; res.complete = true;
      callback(res); if (!res.destroyed) res.end(script.body || png);
    });
    return req;
  });
  return calls;
}

test('only exact public HTTPS Sina CDN hosts get fixed browser headers', async t => {
  const calls = transport(t, [{}, {}, {}]);
  await module.safeFetchBuffer('https://wx1.sinaimg.cn/large/abc.jpg');
  await module.safeFetchBuffer('https://wx1.sinaimg.cn.evil.test/large/abc.jpg');
  await module.safeFetchBuffer('https://public.test/image.jpg');
  assert.equal(calls[0].headers.referer, 'https://weibo.com/');
  assert.match(calls[0].headers['user-agent'], /Chrome/);
  assert.equal(calls[0].hostname, '93.184.216.34');
  assert.equal(calls[0].servername, 'wx1.sinaimg.cn');
  assert.equal(calls[0].rejectUnauthorized, true);
  assert.equal(calls[1].headers.referer, undefined); assert.equal(calls[2].headers.referer, undefined);
});

test('Bili image CDN gets its fixed public referrer without leaking it to lookalikes or redirects', async t => {
  const calls=transport(t,[{},{},{status:302,headers:{location:'https://public.test/final.jpg'}},{}]);
  await module.safeFetchBuffer('https://i0.hdslb.com/bfs/a.jpg');
  await module.safeFetchBuffer('https://i0.hdslb.com.evil.test/bfs/a.jpg');
  await module.safeFetchBuffer('https://i1.hdslb.com/bfs/b.jpg');
  assert.equal(calls[0].headers.referer,'https://www.bilibili.com/');
  assert.equal(calls[1].headers.referer,undefined);
  assert.equal(calls[2].headers.referer,'https://www.bilibili.com/');
  assert.equal(calls[3].headers.referer,undefined);
  for(const call of calls)assert.equal(call.headers.cookie,undefined);
});

test('oversized public Sina original falls back once to the same image mw2000 variant', async t => {
  const calls = transport(t, [{ body: Buffer.alloc(64) }, {}]);
  const result = await module.safeFetchBuffer('https://wx1.sinaimg.cn/large/abc123.jpg', 32);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, '/large/abc123.jpg'); assert.equal(calls[1].path, '/mw2000/abc123.jpg');
  assert.equal(calls[1].headers.referer, 'https://weibo.com/');
  assert.deepEqual(result.buffer, png);
});

test('resize does not lift limits or rewrite signed, unrelated or failed sources', async t => {
  const calls = transport(t, [{ body: Buffer.alloc(64) }, { body: Buffer.alloc(64) }, { body: Buffer.alloc(64) }, { status: 403 }]);
  await assert.rejects(module.safeFetchBuffer('https://wx1.sinaimg.cn/large/abc.jpg', 32), /大小限制/);
  assert.equal(calls.length, 2);
  await assert.rejects(module.safeFetchBuffer('https://wx1.sinaimg.cn/large/abc.jpg?signature=fixture', 32), /大小限制/);
  assert.equal(calls.length, 3);
  await assert.rejects(module.safeFetchBuffer('https://public.test/image.jpg'), /HTTP 403/);
  assert.equal(calls.length, 4);
});

test('redirects revalidate private destinations and drop CDN headers on unrelated hosts', async t => {
  const calls = transport(t, [{ status: 302, headers: { location: 'https://public.test/image.jpg' } }, {},
    { status: 302, headers: { location: 'http://127.0.0.1/image.jpg' } }]);
  await module.safeFetchBuffer('https://wx1.sinaimg.cn/large/abc.jpg');
  assert.equal(calls[0].headers.referer, 'https://weibo.com/'); assert.equal(calls[1].headers.referer, undefined);
  await assert.rejects(module.safeFetchBuffer('https://wx1.sinaimg.cn/large/abc.jpg'), /内网/);
  assert.equal(calls.length, 3);
});

test('actual MCP image wrapper distinguishes known pre-send failures from unknown delivery', async () => {
  const source = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('async function agentApi(path, init = {}) {');
  const end = source.indexOf('async function authorizeRead(', start);
  let agentApi;
  const apiContext = vm.createContext({ readConsoleToken: () => 'fixture-token', agentApiBase: () => 'http://fixture.test', AbortSignal,
    fetch: async () => ({ ok: false, status: 400, json: async () => ({ error: 'HTTP 403 downloading image', unknown: false, retryable: true }) }) });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.fixtureApi = agentApi;', apiContext); agentApi = apiContext.fixtureApi;
  await assert.rejects(agentApi('/api/socialV2/send-image'), e => e.unknown === false && e.retryable === true);
  const toolStart = source.indexOf("server.tool(\n  'qq_send_image',");
  const toolEnd = source.indexOf("if (cfg.socialV2?.tools?.searchImages", toolStart);
  let handler, unknown = false;
  const chain = new Proxy({}, { get: () => () => chain });
  const ctx = vm.createContext({ z: { string: () => chain, number: () => chain }, serializeModelData: JSON.stringify,
    server: { tool: (_name, _description, _schema, fn) => { handler = fn; } },
    agentApi: async () => { const e = Error('fixture failure'); if (!unknown) { e.unknown = false; e.retryable = true; } throw e; } });
  assert.ok(toolStart > 0 && toolEnd > toolStart);
  vm.runInContext(source.slice(toolStart, toolEnd), ctx);
  let result = JSON.parse((await handler({ key: 'group:456', token: 'fixture-token', requestId: '123' })).content[0].text);
  assert.equal(result.unknown, false); assert.equal(result.retryable, true); assert.match(result.hint, /尚未发送/);
  unknown = true;
  result = JSON.parse((await handler({ key: 'group:456', token: 'fixture-token', requestId: '123' })).content[0].text);
  assert.equal(result.unknown, true); assert.equal(result.retryable, false); assert.match(result.hint, /不可重发/);
});
