// Manual smoke check: one paid search, a cached repeat, and an internal URL rejection.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
if (!process.argv.includes('--live')) throw Error('Pass --live to authorize one real search request');
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp-web-search-safe.js', import.meta.url))] });
const client = new Client({ name: 'search-health-check', version: '1.0.0' });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(t => t.name);
  const start = Date.now();
  const args = { name: 'web_search', arguments: { query: 'DeepSeek V4.1 Flash site:deepseek.com' } };
  const response = await client.callTool(args);
  assert.ok(!response.isError, response.content?.[0]?.text);
  const result = JSON.parse(response.content[0].text);
  assert.equal(result.provider, 'deepseek');
  assert.ok(result.results.length > 0 && result.results.length <= 5);
  const elapsedMs = Date.now() - start;
  assert.ok(result.results.every(r => r.snippet.length <= 360));
  const repeated = JSON.parse((await client.callTool(args)).content[0].text);
  assert.equal(repeated.cached, true);
  const blocked = await client.callTool({ name: 'web_fetch', arguments: { url: 'http://127.0.0.1/' } });
  assert.equal(blocked.isError, true);
  console.log(JSON.stringify({ ok: true, provider: result.provider, results: result.results.length, elapsedMs,
    resultChars: response.content[0].text.length, cachedRepeat: repeated.cached, internalFetchBlocked: true, tools }));
} finally { await client.close(); await transport.close(); }
