// Bing 图片检索：补 Danbooru 只覆盖二次元的短板（真人 coser、实拍、商品图等）。
//
// 为什么不用百度：image.baidu.com 的 acjson 对非浏览器 UA 直接返回
// {"antiFlag":1,"message":"Forbid spider access"}，脚本拿不到结果。
// Bing 的 /images/async 片段不校验 Referer，HTML 里带 murl 直链，可解析。
//
// 已知不可达主机：pbs.twimg.com / i.pinimg.com 在本机（无代理）会超时，
// 检索阶段直接过滤，避免把注定失败的链接交给模型。

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
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** 检索真实照片。失败抛错或返回空数组，由调用方处理。 */
export async function searchBingImages({ query, limit = 6, page = 1, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return { ok: false, error: '搜索词为空', results: [] };
  const count = Math.min(32, Math.max(1, Number(limit) || 6));
  const fetchCount = Math.max(count * 4, 20);
  const pageNumber = Math.min(1000, Math.max(1, Math.floor(Number(page) || 1)));
  const url = `https://www.bing.com/images/async?q=${encodeURIComponent(q)}&first=${1 + (pageNumber - 1) * fetchCount}&count=${fetchCount}&mmasync=1`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9',
        referer: 'https://www.bing.com/images/search',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, error: `图源请求失败：${error?.message ?? error}`, results: [] };
  }
  if (!response.ok) return { ok: false, error: `图源返回 HTTP ${response.status}`, results: [] };
  const html = decodeEntities(await response.text());

  const seen = new Set();
  const results = [];
  for (const m of html.matchAll(/"murl":"(https?:\/\/[^"]+)"/g)) {
    const link = m[1];
    if (seen.has(link) || isBlocked(link)) continue;
    seen.add(link);
    let host = '';
    try { host = new URL(link).hostname; } catch { continue; }
    results.push({ url: link, host });
    if (results.length >= count) break;
  }
  if (!results.length) {
    return { ok: false, error: '没有解析到可用图片直链（该图源可能改了结构，或结果全是不可达图床）', results: [] };
  }
  return { ok: true, count: results.length, results };
}
