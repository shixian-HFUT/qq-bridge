import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { ImageOutbox } from '../src/image-outbox.js';
import { imageHash, imageUrlFingerprint } from '../src/image-identity.js';
import { backfillImageOutbox } from '../src/image-outbox-backfill.js';
import { searchImages } from '../src/image-search-routing.js';
import { searchDanbooru } from '../src/danbooru-search.js';
import { searchBingImages } from '../src/bing-images.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-dedup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'outbox.json');
  const box = new ImageOutbox(file);
  let sends = 0, downloads = 0;
  const args = { key: 'private:123', requestId: '101', source: { url: 'https://example.com/a.png' },
    prepare: async () => { downloads++; return { buffer: Buffer.from('same-image') }; },
    dispatch: async (_, mark) => { mark(); return String(++sends); } };
  return { dir, file, box, args, sends: () => sends, downloads: () => downloads };
}

test('URL identity ignores fragments/tracking/order but retains image-selecting parameters', () => {
  assert.equal(imageUrlFingerprint('https://EXAMPLE.com/a?b=2&a=1&utm_source=x#one'),
    imageUrlFingerprint('https://example.com/a?a=1&b=2#two'));
  assert.notEqual(imageUrlFingerprint('https://example.com/a?id=1'), imageUrlFingerprint('https://example.com/a?id=2'));
});

test('different requests cannot resend a URL, while same-request idempotency and conversation isolation remain', async t => {
  const f = fixture(t); await f.box.send(f.args);
  assert.equal((await f.box.send(f.args)).alreadySent, true);
  await assert.rejects(f.box.send({ ...f.args, requestId: '102' }), e => e.duplicate && !e.unknown);
  assert.equal(f.downloads(), 1); assert.equal(f.box.hasUrl(f.args.key, f.args.source.url), true);
  assert.equal(f.box.hasUrl('private:456', f.args.source.url), false);
  await f.box.send({ ...f.args, key: 'private:456' }); assert.equal(f.sends(), 2);
});

test('same bytes on another host are blocked across restarts; failed duplicate can choose a fresh image', async t => {
  const f = fixture(t); await f.box.send(f.args);
  const box = new ImageOutbox(f.file);
  const next = { ...f.args, requestId: '102', source: { url: 'https://another.test/b.png' } };
  await assert.rejects(box.send(next), e => e.duplicate && !e.unknown);
  assert.equal(new ImageOutbox(f.file).hasUrl(f.args.key, next.source.url), true);
  await box.send({ ...next, source: { url: 'https://another.test/c.png' }, prepare: async () => Buffer.from('fresh-image') });
  assert.equal(f.sends(), 2);
});

test('concurrent requests cannot dispatch identical bytes twice even with different URLs', async t => {
  const f = fixture(t);
  const results = await Promise.allSettled([f.box.send(f.args), f.box.send({ ...f.args, requestId: '102', source: { url: 'https://another.test/b.png' } })]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.duplicate, true);
  assert.equal(f.sends(), 1);
});

test('unknown delivery protects URL and content on a new request after a restart', async t => {
  const f = fixture(t);
  await assert.rejects(f.box.send({ ...f.args, dispatch: async (_, mark) => { mark(); throw Error('timeout'); } }), e => e.unknown);
  const box = new ImageOutbox(f.file);
  assert.equal(box.hasUrl(f.args.key, f.args.source.url), true);
  await assert.rejects(box.send({ ...f.args, requestId: '102', source: { url: 'https://another.test/b.png' } }), e => e.duplicate && e.unknown);
  assert.equal(f.sends(), 0);
});

test('failed download does not blacklist an unsent URL, and explicit chat-image forwarding is independent', async t => {
  const f = fixture(t);
  await assert.rejects(f.box.send({ ...f.args, prepare: async () => { throw Error('download failure'); } }));
  assert.equal(f.box.hasUrl(f.args.key, f.args.source.url), false);
  await f.box.send(f.args);
  await f.box.send({ ...f.args, requestId: '102', source: { sourceId: '77', imageIndex: 1 } });
  assert.equal(f.sends(), 2);
});

test('legacy backfill corroborates only existing outbox fingerprints and preserves all statuses and Pi bytes', t => {
  const f = fixture(t), pi = path.join(f.dir, 'pi');
  fs.mkdirSync(path.join(pi, 'history', 's'), { recursive: true });
  const id = imageHash(JSON.stringify([f.args.key, f.args.requestId]));
  const original = { fingerprint: imageHash(JSON.stringify(f.args.source)), status: 'unknown', at: 123 };
  fs.writeFileSync(f.file, JSON.stringify({ [id]: original }));
  const archive = path.join(pi, 'history/s/a.json.gz');
  const data = gzipSync(JSON.stringify({ messages: [{ role: 'assistant', content: [
    { type: 'toolCall', name: 'mcp__snowluma__qq_send_image', arguments: { ...f.args, url: f.args.source.url, prepare: undefined, dispatch: undefined } },
  ] }] }));
  fs.writeFileSync(archive, data);
  assert.equal(backfillImageOutbox(f.file, pi).matchedRows, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.file))[id].scope, undefined);
  assert.equal(backfillImageOutbox(f.file, pi, { apply: true }).matchedRows, 1);
  const row = JSON.parse(fs.readFileSync(f.file))[id];
  assert.deepEqual({ fingerprint: row.fingerprint, status: row.status, at: row.at }, original);
  assert.deepEqual(fs.readFileSync(archive), data);
  assert.equal(new ImageOutbox(f.file).hasUrl(f.args.key, f.args.source.url), true);
  assert.equal(backfillImageOutbox(f.file, pi, { apply: true }).matchedRows, 0);
});

test('search skips sent candidates and duplicate URLs, then pages without repeating old results', async () => {
  const pages = [];
  const result = await searchImages({ query: '阿米娅', count: 2 }, { isExcluded: url => url.includes('/old'),
    danbooru: async ({ page, limit }) => { pages.push(page); return { ok: true, results: page === 1
      ? Array.from({ length: limit }, (_, i) => ({ url: `https://example.com/old${i}.png` }))
      : [{ url: 'https://example.com/new.png#one' }, { url: 'https://example.com/new.png#two' }, { url: 'https://example.com/other.png' }] }; },
    bing: async () => assert.fail('has fresh Danbooru images'),
  });
  assert.deepEqual(pages, [1, 2]); assert.equal(result.count, 2); assert.equal(result.excludedCount, 24);
  assert.deepEqual(result.results.map(x => new URL(x.url).pathname), ['/new.png', '/other.png']);
});

test('exhausted adult search returns no old images and never falls back to Bing', async () => {
  const result = await searchImages({ query: '阿米娅', rating: 'nsfw' }, { isExcluded: () => true,
    danbooru: async () => ({ ok: true, results: [{ url: 'https://example.com/old.png' }] }),
    bing: async () => assert.fail('adult fallback forbidden'),
  });
  assert.equal(result.ok, false); assert.equal(result.exhausted, true); assert.deepEqual(result.results, []);
});

test('provider page parameters advance both APIs without dropping ratings or query', async () => {
  await searchDanbooru({ query: '阿米娅', limit: 24, page: 2, rating: 'safe', fetchImpl: async url => {
    const u = new URL(url); assert.equal(u.searchParams.get('page'), '2'); assert.equal(u.searchParams.get('limit'), '24');
    assert.match(u.searchParams.get('tags'), /rating:g/); return { ok: true, json: async () => [] };
  } });
  await searchBingImages({ query: 'landscape', limit: 24, page: 2, fetchImpl: async url => {
    const u = new URL(url); assert.equal(u.searchParams.get('first'), '97'); assert.equal(u.searchParams.get('q'), 'landscape');
    return { ok: true, text: async () => '"murl":"https://example.com/new.png"' };
  } });
});
