import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { deepseekWebSearch, mapSearchResults } from '../src/deepseek-web-search.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-search-'));
const credentialFile = path.join(root, 'search.env');
fs.writeFileSync(credentialFile, 'QQ_SEARCH_FIXTURE="fixture-file-key"\n');
const settings = { credentialFile, apiKeyEnv: 'QQ_SEARCH_FIXTURE', count: 3 };
const page = { title: 'Official news', url: 'https://example.com/news', snippet: 'x'.repeat(1000), summary: 'long-summary', content: 'full-body' };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('direct search sends query only, bounds results and prefers deployment credentials', async () => {
  process.env.QQ_SEARCH_FIXTURE = 'fixture-inherited-key';
  try {
    const result = await deepseekWebSearch(root, '  news\n today ', settings, { fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.deepseek.com/v1/tools/search');
      assert.equal(init.headers.authorization, 'Bearer fixture-file-key');
      assert.equal(init.redirect, 'error');
      assert.deepEqual(JSON.parse(init.body), { query: 'news today', count: 3, need_content: false });
      return json({ results: [page, { ...page, url: 'https://example.com/2' }, { ...page, url: 'https://example.com/3' }, { ...page, url: 'https://example.com/4' }] });
    } });
    assert.equal(result.results.length, 3);
    assert.equal(result.results[0].snippet.length, 360);
    assert.equal('summary' in result, false);
    assert.equal('content' in result.results[0], false);
  } finally { delete process.env.QQ_SEARCH_FIXTURE; }
});

test('tracking and secret parameters are removed; duplicate and invalid URLs are excluded', () => {
  const results = mapSearchResults([
    { ...page, url: 'https://example.com/news?accessToken=secret&utm_source=tracking#fragment' }, page,
    { ...page, url: 'https://user:password@example.com/' }, { ...page, url: 'file:///local' }, null,
  ], 5);
  assert.deepEqual(results.map(r => r.url), ['https://example.com/news']);
});

test('successful repeats use cache and expire after ten minutes', async () => {
  let calls = 0, at = 1000000;
  const options = { now: () => at, fetchImpl: async () => { calls++; return json({ results: [page] }); } };
  assert.equal((await deepseekWebSearch(root, 'cache-query', settings, options)).cached, false);
  assert.equal((await deepseekWebSearch(root, 'cache-query', settings, options)).cached, true);
  assert.equal(calls, 1);
  at += 600001;
  assert.equal((await deepseekWebSearch(root, 'cache-query', settings, options)).cached, false);
  assert.equal(calls, 2);
});

test('provider errors and transport exceptions never echo secret bodies or request headers', async () => {
  await assert.rejects(deepseekWebSearch(root, 'error-query', settings, { fetchImpl: async () => new Response('fixture-file-key', { status: 401 }) }), /^Error: DeepSeek 搜索失败（HTTP 401）$/);
  await assert.rejects(deepseekWebSearch(root, 'error-query', settings, { fetchImpl: async () => { throw Error('fixture-file-key'); } }), /^Error: DeepSeek 搜索连接失败或超时$/);
});

test('invalid and oversized responses fail without poisoning cache', async () => {
  for (const response of [json({ text: 'unstructured answer' }), new Response('{'), new Response('x'.repeat(512 * 1024 + 1)), json({ results: [{ ...page, url: 'javascript:alert(1)' }] })]) {
    await assert.rejects(deepseekWebSearch(root, 'bad-query', settings, { fetchImpl: async () => response }));
  }
  assert.equal((await deepseekWebSearch(root, 'bad-query', settings, { fetchImpl: async () => json({ results: [page] }) })).results.length, 1);
});

test('empty results remain a valid empty search; missing credentials fail before dispatch', async () => {
  assert.equal((await deepseekWebSearch(root, 'empty-query', settings, { fetchImpl: async () => json({ results: [] }) })).results.length, 0);
  await assert.rejects(deepseekWebSearch(root, 'query', { credentialFile: path.join(root, 'missing'), apiKeyEnv: 'QQ_NONEXISTENT_KEY' }, { fetchImpl: () => assert.fail('unexpected request') }), /密钥未配置/);
});
