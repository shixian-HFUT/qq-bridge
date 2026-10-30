// Bing 图片检索：补 Danbooru 只覆盖二次元的短板（真人 coser、实拍、商品图等）。
//
// 为什么不用百度：image.baidu.com 的 acjson 对非浏览器 UA 直接返回
// {"antiFlag":1,"message":"Forbid spider access"}，脚本拿不到结果。
// Bing 的 /images/async 片段不校验 Referer，HTML 里带 murl 直链，可解析。
//
// 已知不可达主机：pbs.twimg.com / i.pinimg.com 在本机（无代理）会超时，
// 检索阶段直接过滤，避免把注定失败的链接交给模型。

import { supportedImageUrl, candidateMatchesQuery } from './image-candidates.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20000;

// 中国大陆网络下通常不可达或必然超时的图床。
const BLOCKED_HOSTS = [
  'pbs.twimg.com',
  'i.pinimg.com',
  'pinimg.com',
  'pixiv.net',
  'i.pximg.net',
  'cdn.discordapp.com',
  'media.discordapp.net',
  'lookaside.fbsbx.com',
  'instagram.com',
  'cdninstagram.com',
];

function isBlocked(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return BLOCKED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return true;
  }
}

function decodeEntities(s) {
  return s
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_m, hex, dec) => {
      const code = parseInt(hex || dec, hex ? 16 : 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function parseBingImages(html) {
  const results = [], seen = new Set();
  for (const match of String(html).matchAll(/\bm\s*=\s*(["'])([\s\S]*?)\1/g)) {
    let data;
    try { data = JSON.parse(decodeEntities(match[2])); } catch { continue; }
    const url = data.murl;
    if (!supportedImageUrl(url) || isBlocked(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({ url, host: new URL(url).hostname,
      title: String(data.t || data.desc || '').replace(/<[^>]*>/g, '').slice(0, 240),
      pageUrl: supportedImageUrl(data.purl) ? data.purl : /^https?:\/\//i.test(data.purl || '') ? data.purl : '',
      width: Number(data.ow || data.width) || 0, height: Number(data.oh || data.height) || 0 });
  }
  return results;
}

/** 检索真实照片。失败抛错或返回空数组，由调用方处理。 */
export async function searchBingImages({ query, limit = 6, page = 1, fetchImpl = fetch, timeoutMs = TIMEOUT_MS, signal } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return { ok: false, error: '搜索词为空', results: [] };
  const count = Math.min(32, Math.max(1, Number(limit) || 6));
  const fetchCount = Math.max(count * 4, 20);
  const pageNumber = Math.min(1000, Math.max(1, Math.floor(Number(page) || 1)));
  const url = `https://www.bing.com/images/async?q=${encodeURIComponent(q)}&first=${1 + (pageNumber - 1) * fetchCount}&count=${fetchCount}&mmasync=1&adlt=strict`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9',
        referer: 'https://www.bing.com/images/search',
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, error: `图源请求失败：${error?.message ?? error}`, results: [] };
  }
  if (!response.ok) return { ok: false, error: `图源返回 HTTP ${response.status}`, results: [] };
  let html;
  try { html = await response.text(); }
  catch (error) { return { ok: false, error: `图源响应读取失败：${error?.message ?? error}`, results: [] }; }
  const parsed = parseBingImages(html);
  const results = parsed.filter(candidate => candidateMatchesQuery(candidate, q)).slice(0, count);
  if (!results.length) {
    return { ok: false, rejectedCount: parsed.length, error: '图源没有返回与原主题相符的图片候选；不使用无关热门图、视频或网页凑数。', results: [] };
  }
  return { ok: true, count: results.length, rejectedCount: parsed.length - results.length, results };
}
