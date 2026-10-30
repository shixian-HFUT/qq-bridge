import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import dns from 'node:dns';
import https from 'node:https';
import { buildDanbooruQuery, matchCharacterAlias, searchDanbooru } from '../src/danbooru-search.js';
import { parseBingImages, searchBingImages } from '../src/bing-images.js';
import { ImageCandidateCache, candidateMatchesQuery, acceptableImageDimensions } from '../src/image-candidates.js';
import { searchImages } from '../src/image-search-routing.js';

const card = data => `<a class="iusc" m="${JSON.stringify(data).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></a>`;
const candidate = (n, more = {}) => ({ url: `https://public.test/${n}.jpg`, title: 'Amiya Arknights cosplay', ...more });

test('specific character aliases win over franchise names in Chinese and English', () => {
  for (const [query, tag] of [['明日方舟 琴柳 cos', 'saileach_(arknights)'], ['Priestess Arknights cosplay', 'priestess_(arknights)'],
    ['凯尔希cos图', "kal'tsit_(arknights)"], ['纳西妲 小草神 cos', 'nahida_(genshin_impact)'], ['德克萨斯 cos', 'texas_(arknights)']]) {
    assert.equal(matchCharacterAlias(query), tag);
    assert.equal(buildDanbooruQuery(query, 'safe', { cosplay: true }).tags, `${tag} cosplay_photo rating:g`);
  }
  assert.equal(matchCharacterAlias('Texasville'), null);
});

test('an unmapped character is not silently dropped in favour of its franchise', () => {
  const result = buildDanbooruQuery('明日方舟 未知角色 cos', 'safe', { cosplay: true });
  assert.equal(result.empty, true); assert.equal(result.unmapped, true);
  assert.equal(candidateMatchesQuery({ title: '明日方舟 阿米娅 cosplay' }, '明日方舟 未知角色 cos'), false);
  assert.equal(candidateMatchesQuery({ title: '明日方舟 未知角色 cosplay' }, '明日方舟 未知角色 cos'), true);
  assert.equal(buildDanbooruQuery('SilverAsh Arknights cosplay', 'safe', { cosplay: true }).unmapped, true);
  assert.equal(buildDanbooruQuery('Unknownperson cosplay', 'safe', { cosplay: true }).unmapped, true);
});

test('Bing retains per-image title, source page and size without regex pairing different cards', () => {
  const results = parseBingImages(card({ murl: 'https://public.test/a.jpg?x=1&y=2', purl: 'https://example.com/gallery', t: 'Amiya cosplay & photography', ow: 1200, oh: 1800 })
    + card({ murl: 'https://public.test/b.mp4', t: 'Amiya video' }) + card({ murl: 'javascript:bad()', t: 'bad' })
    + `<script>const murl="https://public.test/not-a-card.jpg";</script>`);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Amiya cosplay & photography');
  assert.equal(results[0].url, 'https://public.test/a.jpg?x=1&y=2');
  assert.equal(results[0].pageUrl, 'https://example.com/gallery');
  assert.equal(results[0].width, 1200); assert.equal(results[0].height, 1800);
});

test('unrelated popular Bing results do not count as a successful search', async () => {
  const result = await searchBingImages({ query: '阿米娅 cos', fetchImpl: async () => ({ ok: true,
    text: async () => card({ murl: 'https://public.test/lottery.jpg', t: '快乐8字图谜' })
      + card({ murl: 'https://public.test/sport.jpg', t: 'Athletes who died in 2024' }) }) });
  assert.equal(result.ok, false); assert.equal(result.results.length, 0);
  assert.equal(result.rejectedCount, 2);
});

test('Chinese subject can match its English alias but a different character cannot', () => {
  assert.equal(candidateMatchesQuery(candidate(1), '阿米娅 cos'), true);
  assert.equal(candidateMatchesQuery({ title: 'Arknights Texas cosplay' }, '阿米娅 cos'), false);
  assert.equal(candidateMatchesQuery({ title: 'Amiya Arknights illustration' }, '阿米娅 cos'), false);
  assert.equal(candidateMatchesQuery({ title: 'Amiya Arknights cosplay' }, '阿米娅 泳装 cos'), false);
  assert.equal(candidateMatchesQuery({ title: 'Amiya cosplay swimsuit' }, '阿米娅 泳装 cos'), true);
  assert.equal(candidateMatchesQuery({ title: 'golden photograph of athletes' }, 'golden retriever photograph'), false);
  assert.equal(candidateMatchesQuery({ title: 'golden retriever dog photo' }, 'golden retriever photograph'), true);
  assert.equal(candidateMatchesQuery({ title: '明日方舟 终末地 cosplay' }, '明日方舟 终末地 祀 cos'), false);
  assert.equal(candidateMatchesQuery({ title: '普瑞赛斯 cosplay服装现货全套', pageUrl: 'https://item.taobao.com/item.htm' }, '普瑞赛斯 cos 明日方舟'), false);
});

test('quality thresholds use actual dimensions and allow ordinary meme sizes', () => {
  assert.equal(acceptableImageDimensions({ width: 320, height: 480 }, '阿米娅 cos'), false);
  assert.equal(acceptableImageDimensions({ width: 1200, height: 1800 }, '阿米娅 cos'), true);
  assert.equal(acceptableImageDimensions({ width: 256, height: 256 }, '奶龙表情包'), true);
  assert.equal(acceptableImageDimensions({ width: 100000, height: 100000 }, '壁纸'), false);
  assert.equal(acceptableImageDimensions(null, '照片'), false);
});

test('Danbooru does not expose video, banned or deleted posts as image candidates', async () => {
  const result = await searchDanbooru({ query: '阿米娅', rating: 'safe', fetchImpl: async () => ({ ok: true,
    json: async () => [
      { id: 1, file_ext: 'mp4', file_url: 'https://public.test/a.mp4' },
      { id: 2, file_ext: 'jpg', file_url: 'https://public.test/a.jpg', is_deleted: true },
      { id: 3, file_ext: 'webp', large_file_url: 'https://public.test/a.webp', tag_string_character: 'amiya_(arknights)', tag_string: 'amiya_(arknights) cosplay_photo' },
    ] }) });
  assert.deepEqual(result.results.map(x => x.id), [3]);
});

test('failed preflights are replaced with later candidates, preserving provider order', async () => {
  const visited = [];
  const result = await searchImages({ query: '阿米娅', count: 2 }, {
    danbooru: async () => ({ ok: true, results: [1, 2, 3, 4].map(n => candidate(n)) }),
    validateCandidate: async c => { visited.push(c.url); return c.url.endsWith('/3.jpg') || c.url.endsWith('/4.jpg') ? c : null; },
  });
  assert.equal(result.ok, true); assert.equal(result.rejectedCount, 2);
  assert.deepEqual(result.results.map(x => x.url), [candidate(3).url, candidate(4).url]);
  assert.equal(visited.length, 4);
});

test('failed primary preflights fall back to photos and never to ordinary illustrations', async () => {
  const calls = [];
  const result = await searchImages({ query: '阿米娅 cos', count: 1, rating: 'safe' }, {
    danbooru: async args => { calls.push(args.cosplay); return { ok: true, results: [candidate(1)] }; },
    bing: async () => ({ ok: true, results: [candidate(2)] }),
    validateCandidate: async c => c.url.endsWith('/1.jpg') ? null : c,
  });
  assert.equal(result.source, 'bing(fallback)'); assert.equal(result.ok, true);
  assert.deepEqual(calls, [true]); assert.equal(result.results[0].url, candidate(2).url);
});

test('preflight work and concurrency stay bounded even when all candidates fail', async () => {
  let count = 0, active = 0, maxActive = 0;
  const result = await searchImages({ query: '阿米娅', count: 8, rating: 'safe' }, {
    danbooru: async args => ({ ok: true, results: Array.from({ length: 32 }, (_, i) => candidate(args.page * 100 + i)) }),
    bing: async args => ({ ok: true, results: Array.from({ length: 32 }, (_, i) => candidate(1000 + args.page * 100 + i)) }),
    validateCandidate: async () => { count++; maxActive = Math.max(maxActive, ++active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return null; },
  });
  assert.equal(result.ok, false); assert.equal(count, 32); assert.ok(maxActive <= 3);
});

test('the deadline is propagated to both providers and prevents further work', async () => {
  const result = await searchImages({ query: '阿米娅', count: 1 }, {
    timeoutMs: 10,
    danbooru: async args => { await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(args.signal.aborted, true); return { ok: false, results: [] }; },
    bing: async () => assert.fail('deadline must stop fallback'),
  });
  assert.equal(result.ok, false);
});

test('verified bytes are cached only within a session, with expiry and a hard memory cap', () => {
  let now = 0; const cache = new ImageCandidateCache({ maxBytes: 8, ttlMs: 10, now: () => now });
  cache.put('a', 'https://public.test/1', { buffer: Buffer.from('1234') });
  assert.equal(cache.get('b', 'https://public.test/1'), undefined);
  assert.equal(cache.get('a', 'https://public.test/1').buffer.toString(), '1234');
  cache.put('a', 'https://public.test/2', { buffer: Buffer.from('56789') });
  assert.equal(cache.get('a', 'https://public.test/1'), undefined); assert.equal(cache.bytes, 5);
  now = 11; assert.equal(cache.get('a', 'https://public.test/2'), undefined); assert.equal(cache.bytes, 0);
});

test('preflight deadline aborts the actual HTTP request and body rather than leaving a background download', async t => {
  const originalLookup = dns.promises.lookup;
  dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  let safe;
  try { safe = await import('../src/safe-fetch.js?quality-timeout'); } finally { dns.promises.lookup = originalLookup; }
  let requestDestroyed = false, body;
  t.mock.method(https, 'request', (_options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => { requestDestroyed = true; };
    request.end = () => queueMicrotask(() => { body = new PassThrough(); body.statusCode = 200; body.headers = {}; callback(body); body.write(Buffer.from('partial')); });
    return request;
  });
  const keepAlive = setTimeout(() => {}, 200);
  try { await assert.rejects(safe.safeFetchBuffer('https://public.test/slow.jpg', 1024, { timeoutMs: 10 }), /timeout|超时/i); }
  finally { clearTimeout(keepAlive); }
  assert.equal(requestDestroyed, true); assert.equal(body.destroyed, true);
});
