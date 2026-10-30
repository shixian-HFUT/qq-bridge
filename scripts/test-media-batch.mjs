import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { normalizeImageBatch, normalizeStickerRefs } from '../src/media-batch.js';
import { ImageOutbox } from '../src/image-outbox.js';
import { buildToolExposure } from '../src/simple-tools.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
const image = n => Buffer.concat([png, Buffer.from(String(n))]);
const urls = ['https://public.test/1.png', 'https://public.test/2.png'];
const ids = ['sticker-one', 'sticker-two'];

test('input lists retain order, reject mixed sources, missing IDs, duplicates and oversized lists', () => {
  assert.deepEqual(normalizeImageBatch({ urls }).items, urls.map(url => ({ url })));
  assert.deepEqual(normalizeImageBatch({ sourceMessageId: '100', imageIndexes: [2, 1] }).items.map(x => x.imageIndex), [2, 1]);
  for (const body of [{ urls: [] }, { urls: Array(9).fill(urls[0]) }, { urls: [42] }, { urls, url: urls[0] },
    { urls, sourceMessageId: '100' }, { imageIndexes: [1] }, { sourceMessageId: '100', imageIndexes: [1, 1] },
    { sourceMessageId: '100', imageIndexes: [6] }, { sourceMessageId: '100', imageIndexes: [1], imageIndex: 1 }]) {
    assert.throws(() => normalizeImageBatch(body));
  }
  assert.deepEqual(normalizeStickerRefs(ids), ids); assert.deepEqual(normalizeStickerRefs(ids[0]), [ids[0]]);
  for (const value of [undefined, '', 42, [], Array(9).fill('x'), ['x', 'x'], ['x', {}]]) assert.throws(() => normalizeStickerRefs(value));
});

function boxFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-outbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'outbox.json'); let sends = 0;
  return { file, box: new ImageOutbox(file), sends: () => sends,
    args: { key: 'group:456', requestId: '101', source: { urls },
      prepare: async () => ({ images: [1, 2].map(n => ({ buffer: image(n) })) }),
      dispatch: async (_images, mark) => { mark(); sends++; return '901'; } } };
}

test('batch receipts survive concurrency and restart and protect every member URL and bytes', async t => {
  const f = boxFixture(t);
  await Promise.all([f.box.send(f.args), f.box.send(f.args)]); assert.equal(f.sends(), 1);
  assert.equal((await new ImageOutbox(f.file).send(f.args)).alreadySent, true);
  await assert.rejects(f.box.send({ ...f.args, source: { urls: [...urls].reverse() } }), /绑定/);
  for (let n = 0; n < 2; n++) {
    assert(f.box.hasUrl(f.args.key, urls[n]));
    await assert.rejects(f.box.send({ ...f.args, requestId: '102', source: { url: urls[n] } }), e => e.duplicate && !e.unknown);
    await assert.rejects(f.box.send({ ...f.args, requestId: '103', source: { url: `https://alias.test/${n}.png` },
      prepare: async () => ({ buffer: image(n + 1) }) }), e => e.duplicate && !e.unknown);
  }
  await f.box.send({ ...f.args, key: 'private:123' }); assert.equal(f.sends(), 2);
});

test('a source rollback retains dedup for all batch members through scalar receipts', async t => {
  const f = boxFixture(t); await f.box.send(f.args);
  const oldPath = path.resolve('..', 'baseline/src/image-outbox.js');
  if (!fs.existsSync(oldPath)) { t.skip('source rollback audit requires the captured deployment baseline'); return; }
  const { ImageOutbox: OldOutbox } = await import(pathToFileURL(oldPath).href);
  const old = new OldOutbox(f.file);
  for (let n = 0; n < urls.length; n++) {
    assert(old.hasUrl(f.args.key, urls[n]));
    await assert.rejects(old.send({ ...f.args, requestId: '104', source: { url: `https://old-reader.test/${n}.png` },
      prepare: async () => ({ buffer: image(n + 1) }) }), e => e.duplicate);
  }
  assert.equal(f.sends(), 1);
});

test('unknown whole-batch delivery, including sending-state restart, cannot replay any member', async t => {
  const f = boxFixture(t);
  await assert.rejects(f.box.send({ ...f.args, dispatch: async (_, mark) => { mark(); throw Error('response lost'); } }), e => e.unknown);
  const rows = JSON.parse(fs.readFileSync(f.file));
  assert.equal(Object.keys(rows).length, 3);
  for (const row of Object.values(rows)) row.status = 'sending';
  fs.writeFileSync(f.file, JSON.stringify(rows));
  const box = new ImageOutbox(f.file);
  await assert.rejects(box.send(f.args), e => e.unknown);
  for (let n = 0; n < 2; n++) await assert.rejects(box.send({ ...f.args, requestId: '102', source: { url: urls[n] } }), e => e.unknown);
  assert.equal(f.sends(), 0);
});

test('preparation failure and duplicates inside a group never dispatch or blacklist fresh sources', async t => {
  const f = boxFixture(t);
  await assert.rejects(f.box.send({ ...f.args, prepare: async () => { throw Error('second download failed'); } }), e => e.unknown === false);
  await assert.rejects(f.box.send({ ...f.args, source: { urls: [urls[0], urls[0]] } }), /重复/);
  await assert.rejects(f.box.send({ ...f.args, prepare: async () => ({ images: [{ buffer: png }, { buffer: png }] }) }), /重复/);
  assert.equal(f.sends(), 0); assert.equal(f.box.hasUrl(f.args.key, urls[0]), false);
  await f.box.send(f.args); assert.equal(f.sends(), 1);
});

test('overlapping concurrent groups cannot dispatch a shared image twice', async t => {
  const f = boxFixture(t);
  const results = await Promise.allSettled([f.box.send(f.args), f.box.send({ ...f.args, requestId: '102',
    source: { urls: ['https://alias.test/2.png', 'https://public.test/3.png'] },
    prepare: async () => ({ images: [2, 3].map(n => ({ buffer: image(n) })) }) })]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert(results.find(x => x.status === 'rejected').reason.duplicate); assert.equal(f.sends(), 1);
});

async function fixture(t) {
  let downloads = [], failAt = '', unknown = false, onDownload = () => {}, size = 0;
  const sends = [];
  class Bot {
    async getImage({ file }) { return { base64: image(file).toString('base64') }; }
    async request() { return { status: 'ok', retcode: 0, data: ids.map((id, n) => ({ emoji_id: id, url: urls[n] })) }; }
  }
  const h = await bridgeHarness({ config: { snowluma: { httpUrl: 'http://127.0.0.1:3000' },
    socialV2: { tools: { sendImage: true, sendSticker: true }, sticker: { enabled: true }, send: {}, proactive: { enabled: false }, wake: { observationMode: 'background' } } },
    globals: { SnowLumaWebSocketClient: Bot,
      safeFetchBuffer: async url => {
        downloads.push(url); onDownload(url);
        if (url === failAt || !url.startsWith('https://public.test/')) throw Error('download rejected');
        return { buffer: size ? Buffer.concat([png, Buffer.alloc(size)]) : image(url) };
      },
      fetch: async (url, options) => {
        if (/send_(group|private)_msg$/.test(String(url))) {
          sends.push(JSON.parse(options.body)); if (unknown) throw Error('reply lost');
        }
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
      } } });
  h.setMode('reserved2'); const key = 'group:456', st = h.getSocialV2State(key);
  h.cfg.socialV2.send.maxSendPerMinute = 100; h.cfg.socialV2.send.maxSendPerHour = 100;
  const add = (id, media = [], target = key) => h.appendSocialV2Message(target, 'user', '图片请求', '图片请求', false, false, id, media, '12345');
  add('100', [1, 2].map(n => ({ kind: 'image', file: String(n) }))); add('101');
  const server = h.startConsoleServer(); if (!server.listening) await once(server, 'listening');
  t.after(async () => { await new Promise(r => server.close(r)); await h.close(); });
  const request = async (body, route = 'send-image', token = st.agentToken) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/${route}?key=${key}`, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': token },
      ...(body ? { body: JSON.stringify({ key, requestId: '101', ...body }) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  return { h, st, sends, downloads, request, add, fail(url) { failAt = url; }, unknown() { unknown = true; },
    duringDownload(fn) { onDownload = fn; }, large(bytes) { size = bytes; } };
}

test('HTTP ordinary batch emits ordered segments in one message, one quota, one history and correct ack', async t => {
  const f = await fixture(t), unread = await f.request(undefined, 'unread');
  const response = await f.request({ urls, throughSeq: unread.data.readThroughSeq });
  assert.equal(response.data.ok, true, JSON.stringify(response.data)); assert.equal(response.data.imageCount, 2);
  assert.equal(response.data.turnComplete, true); assert.equal(f.sends.length, 1); assert.equal(f.st.sendTimes.length, 1);
  assert.deepEqual(f.sends[0].message.map(s => s.data.file), urls.map(url => 'base64://' + image(url).toString('base64')));
  assert.equal((await f.request({ urls })).data.alreadySent, true); assert.equal(f.sends.length, 1);
  assert.equal(f.st.recentMessages.filter(m => m.isSelf).length, 1);
});

test('HTTP forwarding preserves requested index order and refuses another conversation', async t => {
  const f = await fixture(t);
  const response = await f.request({ sourceMessageId: '100', imageIndexes: [2, 1] });
  assert.equal(response.data.ok, true, JSON.stringify(response.data)); assert.equal(f.sends.length, 1);
  assert.deepEqual(f.sends[0].message.map(s => s.data.file), [2, 1].map(n => 'base64://' + image(String(n)).toString('base64')));
  f.add('private-image', [{ kind: 'image', file: '3' }], 'private:123'); f.add('102');
  assert.equal((await f.request({ sourceMessageId: 'private-image', imageIndexes: [1], requestId: '102' })).data.ok, false);
  assert.equal(f.sends.length, 1);
});

test('HTTP maximum batch accepts eight distinct pictures in a single QQ message', async t => {
  const f = await fixture(t), eight = Array.from({ length: 8 }, (_, i) => `https://public.test/${i + 1}.png`);
  const response = await f.request({ urls: eight });
  assert.equal(response.data.ok, true, JSON.stringify(response.data)); assert.equal(response.data.imageCount, 8);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].message.length, 8); assert.equal(f.st.sendTimes.length, 1);
});

test('HTTP complete preflight blocks late failure, over-size, bad lists and authority changes; dry run is inert', async t => {
  const f = await fixture(t);
  const ledger = path.join(f.h.temp, 'state/image-sends.json');
  const before = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : null;
  assert.equal((await f.request({ urls, dryRun: true })).data.imageCount, 2);
  assert.equal(fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : null, before);
  f.fail(urls[1]); assert.equal((await f.request({ urls })).data.ok, false);
  assert.equal(f.sends.length, 0); assert.equal(f.st.sendTimes.length, 0);
  f.fail(''); f.large(6 * 1024 * 1024); assert.equal((await f.request({ urls })).data.ok, false); f.large(0);
  for (const body of [{ urls: [] }, { urls: Array(9).fill(urls[0]) }, { urls, url: urls[0] }, { urls: [urls[0], urls[0]] }]) assert.equal((await f.request(body)).data.ok, false);
  assert.equal((await f.request({ urls }, 'send-image', 'wrong')).data.ok, false);
  f.duringDownload(() => { f.h.socialV2.paused = true; }); assert.equal((await f.request({ urls })).data.ok, false);
  assert.equal(f.sends.length, 0);
});

test('HTTP unknown ordinary batch remains protected on retry and protects its second URL', async t => {
  const f = await fixture(t); f.unknown();
  assert.equal((await f.request({ urls })).data.unknown, true);
  assert.equal((await f.request({ urls })).data.unknown, true);
  f.add('102'); assert.equal((await f.request({ url: urls[1], requestId: '102' })).data.unknown, true);
  assert.equal(f.sends.length, 1); assert.equal(f.st.sendTimes.length, 1);
});

test('HTTP sticker batch uses one bubble and receipt; replay never recounts usage, history or quota', async t => {
  const f = await fixture(t);
  const first = await f.request({ stickerId: ids }, 'send-sticker');
  assert.equal(first.data.ok, true, JSON.stringify(first.data)); assert.equal(first.data.imageCount, 2);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].message.filter(s => s.type === 'image').length, 2);
  const historyCount = f.st.recentMessages.filter(m => m.sticker).length;
  const storeFiles = fs.readdirSync(path.join(f.h.temp, 'state')).filter(n => /sticker/.test(n));
  assert(storeFiles.length); const stores = storeFiles.map(n => fs.readFileSync(path.join(f.h.temp, 'state', n), 'utf8'));
  const repeat = await f.request({ stickerId: ids }, 'send-sticker');
  assert.equal(repeat.data.alreadySent, true); assert.equal(f.sends.length, 1); assert.equal(f.st.sendTimes.length, 1);
  assert.equal(f.st.recentMessages.filter(m => m.sticker).length, historyCount);
  assert.deepEqual(storeFiles.map(n => fs.readFileSync(path.join(f.h.temp, 'state', n), 'utf8')), stores);
});

test('HTTP sticker batch preflight and late revocation emit no partial group; unknown never replays', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ stickerId: ids, requestId: 'fake' }, 'send-sticker')).data.ok, false);
  f.fail(urls[1]); assert.equal((await f.request({ stickerId: ids }, 'send-sticker')).data.unknown, false);
  assert.equal(f.sends.length, 0); assert.equal(f.st.sendTimes.length, 0);
  f.fail(''); f.duringDownload(() => { f.h.cfg.socialV2.tools.sendSticker = false; });
  assert.equal((await f.request({ stickerId: ids }, 'send-sticker')).data.ok, false); assert.equal(f.sends.length, 0);
  f.duringDownload(() => {}); f.h.cfg.socialV2.tools.sendSticker = true; f.unknown();
  assert.equal((await f.request({ stickerId: ids }, 'send-sticker')).data.unknown, true);
  assert.equal((await f.request({ stickerId: ids }, 'send-sticker')).data.unknown, true);
  assert.equal(f.sends.length, 1); assert.equal(f.st.sendTimes.length, 1);
});

test('HTTP text plus a sticker group emits exactly two bubbles, and failed group preserves delivered text', async t => {
  const f = await fixture(t);
  const first = await f.request({ messages: '好耶', stickerId: ids }, 'send-message');
  assert.equal(first.data.ok, true, JSON.stringify(first.data)); assert.equal(first.data.stickerResult.imageCount, 2);
  assert.equal(f.sends.length, 2); assert.equal(f.sends[0].message.some(s => s.type === 'text'), true);
  assert.equal(f.sends[1].message.filter(s => s.type === 'image').length, 2); assert.equal(f.st.sendTimes.length, 2);
  f.add('102'); f.fail(urls[1]);
  const failed = await f.request({ messages: '正文保留', stickerId: ids, requestId: '102' }, 'send-message');
  assert.equal(failed.data.ok, true); assert.equal(failed.data.sent, 1); assert.equal(failed.data.stickerResult.status, 'skipped');
  assert.equal(f.sends.length, 3); assert.equal(f.st.sendTimes.length, 3);
});

test('all exposed batch tools retain array schemas and overwrite original message ID from trusted context', () => {
  const str = { type: 'string' }, refs = { anyOf: [str, { type: 'array', items: str, minItems: 1, maxItems: 8 }] };
  const definitions = ['qq_send_message', 'qq_send_sticker', 'qq_send_image'].map(name => ({ name: 'mcp__snowluma__' + name,
    parameters: { type: 'object', properties: { key: str, token: str, requestId: str, messages: str, stickerId: refs,
      urls: { type: 'array', items: str, maxItems: 8 } }, required: ['key', 'token'] } }));
  const turn = { key: 'group:456', token: 'trusted', requestMessageId: '101', readThroughSeq: 2 };
  const exposed = buildToolExposure(definitions, { enabled: true, turn });
  for (const name of ['send', 'qq_send_message', 'mcp__snowluma__qq_send_message', 'qq_send_sticker', 'mcp__snowluma__qq_send_sticker']) {
    const tool = exposed.find(t => t.name === name); assert(tool.parameters.properties.stickerId.anyOf);
    const args = tool.bindArgs({ text: '好耶', stickerId: ids, requestId: 'forged' });
    assert.equal(args.requestId, '101'); assert.equal(args.key, turn.key); assert.equal(args.token, turn.token);
  }
  for (const name of ['qq_send_image', 'mcp__snowluma__qq_send_image']) assert(exposed.find(t => t.name === name).parameters.properties.urls);
  const missing = buildToolExposure(definitions, { enabled: true, turn: { ...turn, requestMessageId: null } });
  assert.throws(() => missing.find(t => t.name === 'send').bindArgs({ text: '好耶', stickerId: ids, requestId: 'forged' }));
});
