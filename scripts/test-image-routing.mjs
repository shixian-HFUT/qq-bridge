// 找图路由回归：不联网，只验证标签拼装与图源选择。
// 运行：node --test qqbot/scripts/test-image-routing.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDanbooruQuery, matchCharacterAlias, searchDanbooru } from '../src/danbooru-search.js';
import { chooseImageSource, searchImages, wantsCosplay } from '../src/image-search-routing.js';

test('角色别名匹配', () => {
  assert.equal(matchCharacterAlias('阿米娅 泳装'), 'amiya_(arknights)');
  assert.equal(matchCharacterAlias('明日方舟 阿米娅 cos'), 'amiya_(arknights)');
  assert.equal(matchCharacterAlias('守岸人 cosplay'), 'shorekeeper_(wuthering_waves)');
  assert.equal(matchCharacterAlias('街拍 美女'), null);
});

test('真人 cos 标签：角色 + cosplay_photo，作品名让位', () => {
  const a = buildDanbooruQuery('阿米娅 cos', undefined, { cosplay: true });
  assert.equal(a.tags, 'amiya_(arknights) cosplay_photo rating:g');
  const b = buildDanbooruQuery('明日方舟 阿米娅 coser', undefined, { cosplay: true });
  assert.equal(b.tags, 'amiya_(arknights) cosplay_photo rating:g');
  const c = buildDanbooruQuery('真人阿米娅cos', undefined, { cosplay: true });
  assert.equal(c.tags, 'amiya_(arknights) cosplay_photo rating:g');
});

test('cosplay 整词替换不会留下 play', () => {
  const r = buildDanbooruQuery('阿米娅 cosplay', undefined, { cosplay: true });
  assert.equal(r.tags, 'amiya_(arknights) cosplay_photo rating:g');
});

test('普通角色图仍是角色 + 属性', () => {
  for (const clothing of ['泳装', '泳衣']) {
    const r = buildDanbooruQuery('阿米娅 ' + clothing);
    assert.equal(r.tags, 'amiya_(arknights) swimsuit rating:g');
    assert.equal(r.rating, 'safe');
    assert.equal(chooseImageSource({ query: '阿米娅 ' + clothing }).engine, 'danbooru');
  }
});

test('没有角色时仍检索真人 cos 照片', () => {
  const r = buildDanbooruQuery('cosplay', undefined, { cosplay: true });
  assert.equal(r.tags, 'cosplay_photo order:score rating:g');
});

test('cos 请求可带 nsfw 分级', () => {
  const r = buildDanbooruQuery('阿米娅 cos 色图', 'nsfw', { cosplay: true });
  assert.equal(r.tags, 'amiya_(arknights) cosplay_photo rating:q,e');
});

test('模型误传 photo：角色 cos 仍走 Danbooru cosplay', () => {
  const r = chooseImageSource({ source: 'photo', query: '找个真人阿米娅coser图' });
  assert.deepEqual(r, { engine: 'danbooru', cosplay: true, reason: 'character-cosplay' });
});

test('photo + 不带角色的真人照片：交给必应', () => {
  const r = chooseImageSource({ source: 'photo', query: '街拍 美女 实拍' });
  assert.equal(r.engine, 'bing');
  assert.equal(r.cosplay, false);
});

test('anime 但没提 cos：Danbooru 普通图', () => {
  const r = chooseImageSource({ source: 'anime', query: '阿米娅' });
  assert.deepEqual(r, { engine: 'danbooru', cosplay: false, reason: 'explicit-anime' });
});

test('auto + 角色名：Danbooru', () => {
  const r = chooseImageSource({ source: 'auto', query: '守岸人' });
  assert.equal(r.engine, 'danbooru');
  assert.equal(r.reason, 'character-name');
});

test('成人请求强制 Danbooru 分级，绝不回退必应', () => {
  const r = chooseImageSource({ source: 'photo', query: '阿米娅 色图' });
  assert.equal(r.engine, 'danbooru');
  assert.equal(r.reason, 'nsfw-requires-rating');
});

test('cos 判定不会误伤 costume / cosy', () => {
  assert.equal(wantsCosplay('阿米娅 costume'), false);
  assert.equal(wantsCosplay('阿米娅 cosy'), false);
  assert.equal(wantsCosplay('阿米娅 cos'), true);
  assert.equal(wantsCosplay('阿米娅 cosplay'), true);
});

test('默认请求仍走必应真人图源', () => {
  const r = chooseImageSource({ query: '好看的风景照' });
  assert.equal(r.engine, 'bing');
  assert.equal(r.reason, 'default-photo');
});

test('中文角色 cos 的各种写法都使用真人照片标签', () => {
  for (const word of ['cos', 'coser', 'cosplay']) {
    const r = buildDanbooruQuery(`阿米娅 ${word}`, 'safe');
    assert.equal(r.tags, 'amiya_(arknights) cosplay_photo rating:g');
    assert.equal(r.cosplay, true);
  }
});

test('真人 cos 无结果直接退必应，不重搜同标签或换成插画', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    const tags = new URL(url).searchParams.get('tags');
    requests.push(tags);
    return { ok: true, json: async () => [] };
  };
  const result = await searchImages({ source: 'photo', query: '阿米娅 cos', rating: 'safe', count: 3 }, {
    danbooru: (args) => searchDanbooru({ ...args, fetchImpl }),
    bing: async (args) => {
      assert.equal(args.query, '阿米娅 cos');
      assert.equal(args.limit, 24);
      return { ok: true, count: 1, results: [{ url: 'https://example.com/cos.jpg' }] };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'bing(fallback)');
  assert.deepEqual(requests, ['amiya_(arknights) cosplay_photo rating:g']);
});

test('成人 cos 无结果也不退必应，并保留真人照片条件', async () => {
  const result = await searchImages({ query: '阿米娅 cos 色图', rating: 'nsfw' }, {
    danbooru: async (args) => {
      assert.equal(args.cosplay, true);
      assert.equal(args.rating, 'nsfw');
      return { ok: false, results: [] };
    },
    bing: async () => { assert.fail('成人请求不能调用必应'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.source, 'danbooru(cosplay_photo)');
});

test('泛真人照片直接检索必应', async () => {
  const result = await searchImages({ query: '街拍 女生', source: 'photo', rating: 'safe' }, {
    danbooru: async () => { assert.fail('泛真人照片无需检索 Danbooru'); },
    bing: async () => ({ ok: true, count: 1, results: [] }),
  });
  assert.equal(result.source, 'bing');
});
