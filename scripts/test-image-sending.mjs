import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { ImageOutbox } from '../src/image-outbox.js';
import { extractWebImages } from '../src/aliyun-web-search.js';
import { terminalToolResult } from '../src/pi-context.js';
import { searchImages } from '../src/image-search-routing.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const searchPng = Buffer.from(png); searchPng.writeUInt32BE(1024, 16); searchPng.writeUInt32BE(1024, 20);
  let prepare = async url => { if (!url.startsWith('https://public.test/')) throw Error('private URL rejected'); return { buffer: /\/\d+\.png$/.test(url) ? searchPng : png }; };
  const h = await bridgeHarness({ config: { snowluma: { httpUrl: 'http://127.0.0.1:3000' }, socialV2: {
    tools: { sendImage: true }, sticker: { enabled: false }, proactive: { enabled: false }, wake: { observationMode: 'background' }, send: {} } },
    globals: { safeFetchBuffer: (...args) => prepare(...args),
      searchImages: (args, options) => searchImages(args, { ...options, danbooru: async () => ({
        ok: true, results: [1, 2, 3].map(n => ({ url: `https://public.test/${n}.png`, title: '阿米娅' })),
      }) }) } });
  h.setMode('reserved2');
  const key = 'group:456', st = h.getSocialV2State(key);
  const add = (id, media = [], target = key) => h.appendSocialV2Message(target, 'user', '图片请求', '图片请求', false, false, id, media, '12345');
  add('101', [{ kind: 'image', file: 'fixture.png' }]); add('102');
  const server = h.startConsoleServer(); if (!server.listening) await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await h.close(); });
  const request = async (body, route = 'send-image', token = st.agentToken) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/${route}?key=${key}`, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': token },
      ...(body ? { body: JSON.stringify({ key, requestId: '102', ...body }) } : {}) });
    return { status: r.status, data: await r.json() };
  };
  const sends = () => h.calls.http.filter(c => /send_group_msg$/.test(c.url));
  return { h, st, add, request, sends, setPrepare(fn) { prepare = fn; } };
}

test('chat-image forwarding sends bytes, acknowledges only shown messages and deduplicates repeats', async t => {
  const f = await fixture(t);
  const unread = await f.request(undefined, 'unread');
  const r = await f.request({ sourceMessageId: '101', throughSeq: unread.data.readThroughSeq });
  assert.equal(r.data.ok, true, JSON.stringify(r.data));
  assert.equal(r.data.turnComplete, true);
  assert.equal(f.sends().length, 1);
  assert.equal(f.sends()[0].body.message[0].data.file, 'base64://' + png.toString('base64'));
  const repeat = await f.request({ sourceMessageId: '101' });
  assert.equal(repeat.data.alreadySent, true); assert.equal(f.sends().length, 1);
  assert.equal(terminalToolResult('mcp__snowluma__qq_send_image', { content: [{ type: 'text', text: JSON.stringify(r.data) }] }), true);
});

test('public-image dry run downloads without sending; invalid source, cursor and token stay blocked', async t => {
  const f = await fixture(t);
  const good = await f.request({ url: 'https://public.test/image.png', dryRun: true });
  assert.equal(good.data.ok, true); assert.equal(good.data.bytes, png.length); assert.equal(f.sends().length, 0);
  f.add('private-image', [{ kind: 'image', file: 'fixture.png' }], 'private:123');
  f.st.recentMessages.push({ isSelf: false, text: 'legacy row without a message ID' });
  for (const body of [
    { sourceMessageId: 'private-image' }, { sourceMessageId: '101', url: 'https://public.test/image.png' },
    { url: 'file:///private.png' }, { url: 'http://127.0.0.1/a.png' }, { sourceMessageId: '101', imageIndex: 9 },
    { sourceMessageId: '101', throughSeq: 999999 }, { sourceMessageId: '101', requestId: 'fake-request' },
    { sourceMessageId: '101', requestId: 'undefined' }, { sourceMessageId: '101', requestId: 'null' },
  ]) assert.equal((await f.request(body)).data.ok, false, JSON.stringify(body));
  assert.equal((await f.request({ sourceMessageId: '101' }, 'send-image', 'wrong-token')).data.ok, false);
  assert.equal(f.sends().length, 0);
});

test('an image finishing after another message cannot acknowledge the new message', async t => {
  const f = await fixture(t);
  const before = await f.request(undefined, 'unread');
  f.setPrepare(async () => { f.add('103'); return { buffer: png }; });
  const r = await f.request({ url: 'https://public.test/image.png', throughSeq: before.data.readThroughSeq });
  assert.equal(r.data.ok, true); assert.equal(r.data.turnComplete, true); assert.equal(r.data.unreadCount, 1);
  assert.equal(f.st.unread[0].messageId, '103');
});

test('pause during download, disabled tool and send-rate limits stop actual dispatch', async t => {
  const f = await fixture(t);
  f.setPrepare(async () => { f.h.socialV2.paused = true; return { buffer: png }; });
  assert.equal((await f.request({ url: 'https://public.test/image.png' })).data.ok, false);
  f.h.socialV2.paused = false; f.h.cfg.socialV2.tools.sendImage = false;
  assert.equal((await f.request({ sourceMessageId: '101' })).data.ok, false);
  f.h.cfg.socialV2.tools.sendImage = true;
  f.h.cfg.socialV2.send.maxSendPerMinute = 1; f.st.sendTimes = [Date.now()];
  assert.equal((await f.request({ sourceMessageId: '101' })).data.ok, false);
  assert.equal(f.sends().length, 0);
});

test('web-page image candidates are real bounded URLs, not scripts, credentials or data payloads', () => {
  const images = extractWebImages(`<meta property="og:image" content="/hero.png"><img src="/hero.png">
    <img width="1" height="1" src="/pixel.png"><img src="data:image/png;base64,AAAA">
    <script><img src="/fake.png"></script><img src="https://u:p@example.com/private.png">
    <img data-src="//cdn.example.com/a.jpg" alt="a"><img src="/b.webp"><img src="/c.png">`, 'https://example.com/page');
  assert.deepEqual(images.map(x => x.url), ['https://example.com/hero.png', 'https://cdn.example.com/a.jpg', 'https://example.com/b.webp']);
});

test('outbox prevents duplicate dispatch across concurrency and process restarts', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-outbox-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'outbox.json'); const box = new ImageOutbox(file); let sent = 0;
  const args = { key: 'group:456', requestId: '101', source: { sourceId: '101' }, prepare: async () => png,
    dispatch: async (_image, mark) => { mark(); sent++; return '1234'; } };
  await Promise.all([box.send(args), box.send(args)]);
  assert.equal(sent, 1);
  assert.equal((await new ImageOutbox(file).send(args)).alreadySent, true);
  await assert.rejects(box.send({ ...args, source: { sourceId: 'different' } }), /绑定另一张/);
});

test('uncertain delivery and a crash in sending state cannot trigger another send', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-unknown-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'outbox.json'); let sent = 0;
  const args = { key: 'group:456', requestId: '101', source: { url: 'https://example.com/a.png' }, prepare: async () => png,
    dispatch: async (_image, mark) => { mark(); sent++; throw Error('timeout'); } };
  await assert.rejects(new ImageOutbox(file).send(args), e => e.unknown === true);
  await assert.rejects(new ImageOutbox(file).send(args), e => e.unknown === true); assert.equal(sent, 1);
  const rows = JSON.parse(fs.readFileSync(file)); Object.values(rows)[0].status = 'sending'; fs.writeFileSync(file, JSON.stringify(rows));
  await assert.rejects(new ImageOutbox(file).send(args), e => e.unknown === true); assert.equal(sent, 1);
});

test('real search/send routes exclude old URLs and reject the same bytes at a new URL before QQ dispatch', async t => {
  const f = await fixture(t);
  const first = await f.request({ query: '阿米娅', count: 2 }, 'search-images');
  assert.equal(first.data.results[0].url, 'https://public.test/1.png');
  assert.equal((await f.request({ url: first.data.results[0].url })).data.ok, true);
  f.add('103');
  const next = await f.request({ query: '阿米娅', count: 2 }, 'search-images');
  assert.equal(next.data.results[0].url, 'https://public.test/2.png');
  assert.equal(next.data.excludedCount, 1);
  const old = await f.request({ requestId: '103', url: 'https://public.test/1.png' });
  assert.equal(old.data.duplicate, true); assert.equal(old.data.retryable, true);
  const alias = await f.request({ requestId: '103', url: 'https://public.test/2.png' });
  assert.equal(alias.data.duplicate, true); assert.equal(alias.data.unknown, false);
  assert.equal(f.sends().length, 1);
  f.setPrepare(async () => ({ buffer: Buffer.concat([png, Buffer.from('different-image')]) }));
  const different = await f.request({ requestId: '103', url: 'https://public.test/fresh.png' });
  assert.equal(different.data.ok, true, JSON.stringify(different.data));
  assert.equal(f.sends().length, 2);
});

test('search checks actual dimensions and send reuses those exact bytes without downloading again', async t => {
  const f = await fixture(t); let downloads = 0;
  const image = Buffer.from(png); image.writeUInt32BE(1200, 16); image.writeUInt32BE(1800, 20);
  f.setPrepare(async () => { downloads++; return { buffer: image }; });
  const found = await f.request({ query: '阿米娅', count: 1 }, 'search-images');
  assert.equal(found.data.ok, true); assert.equal(found.data.results[0].width, 1200);
  assert.equal(found.data.results[0].downloadVerified, true); assert.equal(found.data.results[0].contentVerified, false);
  assert.equal(downloads, 1);
  f.setPrepare(async () => { throw Error('origin now unavailable'); });
  const sent = await f.request({ url: found.data.results[0].url });
  assert.equal(sent.data.ok, true); assert.equal(f.sends().length, 1);
  assert.equal(f.sends()[0].body.message[0].data.file, 'base64://' + image.toString('base64'));
});

test('search rejects thumbnails and rechecks pause/authorization before returning candidates', async t => {
  const f = await fixture(t);
  f.setPrepare(async () => ({ buffer: png }));
  const small = await f.request({ query: '阿米娅', count: 1, rating: 'nsfw' }, 'search-images');
  assert.equal(small.data.ok, false); assert.equal(f.sends().length, 0);
  const image = Buffer.from(png); image.writeUInt32BE(1200, 16); image.writeUInt32BE(1800, 20);
  f.setPrepare(async () => { f.h.socialV2.paused = true; return { buffer: image }; });
  const paused = await f.request({ query: '阿米娅', count: 1 }, 'search-images');
  assert.equal(paused.data.ok, false); assert.match(paused.data.error, /状态已变化/);
  assert.equal(f.sends().length, 0);
});
