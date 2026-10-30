// Live public search/download only. The bridge, conversation, outbox and QQ
// transport are fixtures; dryRun never dispatches a QQ image or invokes a model.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { searchImages } from '../src/image-search-routing.js';
import fs from 'node:fs';
import path from 'node:path';

const h = await bridgeHarness({ globals: { searchImages }, config: { socialV2: {
  tools: { sendImage: true, searchImages: true }, sticker: { enabled: false }, proactive: { enabled: false }, send: {},
} } });
h.setMode('reserved2');
const key = 'group:456', st = h.getSocialV2State(key);
h.appendSocialV2Message(key, 'user', 'synthetic image request', 'synthetic image request', false, false, '101', [], '123');
const server = h.startConsoleServer(); if (!server.listening) await once(server, 'listening');
const call = async (route, body) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/${route}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': st.agentToken },
    body: JSON.stringify({ key, requestId: '101', ...body }) });
  return response.json();
};
try {
  for (const query of ['阿米娅 cos', '明日方舟 琴柳 cos', '普瑞赛斯 cos 明日方舟']) {
    const start = Date.now(), result = await call('search-images', { query, count: 2, rating: 'safe' });
    const checks = [];
    for (const image of result.results || []) {
      const dryRun = await call('send-image', { url: image.url, dryRun: true });
      assert.equal(dryRun.ok, true, JSON.stringify(dryRun));
      if (process.env.SAVE_CANDIDATES === '1') {
        const originalFetch = (await import('../src/safe-fetch.js')).safeFetchBuffer;
        const downloaded = await originalFetch(image.url, 10 * 1024 * 1024, { timeoutMs: 5000 });
        fs.mkdirSync('quality-candidates', { recursive: true });
        fs.writeFileSync(path.join('quality-candidates', `${query.startsWith('阿') ? 'amiya' : query.startsWith('明') ? 'saileach' : 'priestess'}-${checks.length}.jpg`), downloaded.buffer);
      }
      checks.push({ id: image.id, host: new URL(image.url).hostname, width: image.width, height: image.height,
        title: image.title, pageHost: image.pageUrl ? new URL(image.pageUrl).hostname : undefined,
        bytes: image.bytes, downloadVerified: image.downloadVerified, contentVerified: image.contentVerified, dryRun: true });
    }
    console.log(JSON.stringify({ query, source: result.source, ok: result.ok, count: result.count, error: result.error,
      rejectedCount: result.rejectedCount, elapsedMs: Date.now() - start, checks }));
  }
  assert.equal(h.calls.http.filter(x => /send_(?:group|private)_msg$/.test(x.url)).length, 0);
  console.log(JSON.stringify({ qqSends: 0, realModelCalls: 0 }));
} finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
