// 找图路由：决定一次图片检索走 Danbooru 还是必应。
//
// 背景：2026-10-21 阿米娅按预设把"真人阿米娅 coser 图"标成 photo，直接走进必应，
// 拿回来花瓣/知乎的杂图；真人 cos 优先尝试带角色标注的 cosplay_photo。
// 服务端纠正 source；真人照片没有结果时可回退必应，不能用角色换装插画替代。

import { matchCharacterAlias, searchDanbooru } from './danbooru-search.js';
import { searchBingImages } from './bing-images.js';
import { imageUrlFingerprint } from './image-identity.js';
import { supportedImageUrl } from './image-candidates.js';

export const IMAGE_SOURCES = ['auto', 'anime', 'photo'];

const NSFW_HINT = /(色图|涩图|黄图|福利图|r18|18\+|裸照|露点)/i;
const ANIME_HINT = /(二次元|插画|壁纸|同人|立绘|anime|illustration|art)/i;
const COSPLAY_HINT = /(cosplay|coser|\bcos\b|真人\s*cos|cos\s*图)/i;

export function wantsCosplay(query) {
  return COSPLAY_HINT.test(String(query ?? ''));
}

/**
 * 选择图源。
 * @param {{source?: string, query?: string, rating?: string}} input
 * @returns {{engine: 'danbooru'|'bing', cosplay: boolean, reason: string}}
 */
export function chooseImageSource({ source = 'auto', query = '', rating } = {}) {
  const q = String(query ?? '');
  const src = IMAGE_SOURCES.includes(String(source).toLowerCase()) ? String(source).toLowerCase() : 'auto';
  const characterTag = matchCharacterAlias(q);
  const cosplay = wantsCosplay(q);

  // 成人请求只走 Danbooru：只有它带 rating 分级，必应没有过滤能力。
  if (rating === 'nsfw' || NSFW_HINT.test(q)) return { engine: 'danbooru', cosplay, reason: 'nsfw-requires-rating' };

  // 模型明确要二次元插画。
  if (src === 'anime') return { engine: 'danbooru', cosplay, reason: cosplay ? 'character-cosplay' : 'explicit-anime' };

  // 点名了角色/作品又要 coser 图：即使模型传了 photo，也先试 cosplay_photo。
  if (cosplay) return { engine: 'danbooru', cosplay: true, reason: 'character-cosplay' };

  // 模型明确要真人照片（不带角色 cos）：交给必应。
  if (src === 'photo') return { engine: 'bing', cosplay: false, reason: 'explicit-photo' };

  // auto：中文角色名在必应里基本搜不出对的东西，交给 Danbooru。
  if (characterTag) return { engine: 'danbooru', cosplay: false, reason: 'character-name' };
  if (ANIME_HINT.test(q)) return { engine: 'danbooru', cosplay: false, reason: 'anime-hint' };
  return { engine: 'bing', cosplay: false, reason: 'default-photo' };
}

// 真人 cos 在 Danbooru 上很少；不能把同角色插画当成照片回退。
// Each provider gets at most two pages; bounded 8s attempts keep fallback and
// duplicate filtering within the MCP timeout. Never return old images as filler.
export async function searchImages({ source, query, rating, count } = {}, {
  danbooru = searchDanbooru, bing = searchBingImages, isExcluded = () => false,
  validateCandidate, timeoutMs = 45000,
} = {}) {
  const route = chooseImageSource({ source, query, rating });
  const size = Math.min(8, Math.max(1, Math.floor(Number(count) || 6)));
  const poolSize = Math.min(32, Math.max(24, size * 4));
  const signal = AbortSignal.timeout(timeoutMs);
  let checkedCount = 0;
  const collect = async (provider, extra = {}) => {
    const results = [], seen = new Set();
    let last, excludedCount = 0, rejectedCount = 0, providerChecks = 0;
    for (let page = 1; page <= 2; page++) {
      if (signal.aborted) break;
      last = await provider({ query, limit: poolSize, page, timeoutMs: 8000, signal, ...extra });
      rejectedCount += Number(last.rejectedCount) || 0;
      if (!last.ok || !last.results?.length) break;
      let added = 0;
      const candidates = [];
      for (const candidate of last.results) {
        let identity;
        try { identity = imageUrlFingerprint(candidate.url); } catch { continue; }
        if (seen.has(identity)) continue;
        seen.add(identity); added++;
        if (isExcluded(candidate.url)) { excludedCount++; continue; }
        if (!supportedImageUrl(candidate.url)) { rejectedCount++; continue; }
        candidates.push(candidate);
      }
      for (let offset = 0; offset < candidates.length && results.length < size && !signal.aborted;) {
        if (validateCandidate && (checkedCount >= 32 || providerChecks >= 16)) break;
        const batch = candidates.slice(offset, offset + Math.min(3, size - results.length, validateCandidate ? Math.min(32 - checkedCount, 16 - providerChecks) : 3));
        offset += batch.length;
        if (validateCandidate) { checkedCount += batch.length; providerChecks += batch.length; }
        const accepted = await Promise.all(batch.map(async candidate => {
          if (!validateCandidate) return candidate;
          try { return await validateCandidate(candidate, { query, signal }); }
          catch { return null; }
        }));
        for (const candidate of accepted) {
          if (candidate) results.push(candidate); else rejectedCount++;
        }
      }
      if (results.length >= size || added === 0 || last.results.length < poolSize) break;
    }
    return { ...last, ok: results.length > 0, count: results.length, results, excludedCount, rejectedCount,
      ...(results.length ? { error: undefined } : excludedCount ? { exhausted: true,
        error: '当前候选已在本会话发送过或发送结果不明，暂未找到新图片；不要重发旧图或连续重试。' }
        : rejectedCount || signal.aborted ? { error: '本次未找到主题相符、清晰且能下载的图片；不要用低清图、视频或其他角色凑数。' } : {}) };
  };
  if (route.engine === 'bing') {
    return { source: 'bing', ...await collect(bing) };
  }
  const result = await collect(danbooru, { rating, cosplay: route.cosplay });
  const resultSource = route.cosplay ? 'danbooru(cosplay_photo)' : 'danbooru';
  const adultRequest = route.reason === 'nsfw-requires-rating' || rating === 'nsfw';
  if (result.ok === true || adultRequest) return { source: resultSource, ...result };
  const fallback = await collect(bing);
  if (fallback.ok === true) {
    return { source: 'bing(fallback)', ...fallback,
      note: route.cosplay ? 'Danbooru 未找到可用的真人 cos 照片，已改用必应检索；候选尚未做图像内容核验。'
        : 'Danbooru 未返回可用图片，已改用必应检索。' };
  }
  return { source: resultSource, ...result, rejectedCount: result.rejectedCount + fallback.rejectedCount,
    attempts: [{ source: resultSource, count: result.count, error: result.error },
      { source: 'bing(fallback)', count: fallback.count, error: fallback.error }] };
}
