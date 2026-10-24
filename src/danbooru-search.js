// Danbooru 图源检索：给机器人一个稳定的"找图"入口。
//
// 为什么不继续让模型从网页里猜图片直链：实测她爬新浪/微博页面时，图床防盗链
// 与 Cloudflare 会导致大量 403，且 HTML 里的 URL 经常是缩略图或跳转页。Danbooru 的
// JSON API 直接给出可下载直链与 rating，命中率高得多。
//
// 注意：Cloudflare 会拦浏览器 UA（Mozilla/5.0 直接 403 挑战页），
// 必须使用 qqbot-image/1.0 这类非浏览器 UA。

const API = 'https://danbooru.donmai.us/posts.json';
const UA = 'qqbot-image/1.0';
const TIMEOUT_MS = 20000;

// 角色/作品别名：命中就说明用户点名了具体角色，这类请求即便要的是"真人 coser"，
// 也应该走 Danbooru 的 cosplay 标签，而不是把中文丢给必应碰运气。
const CHARACTER_ALIASES = [
  ['初音未来', 'hatsune_miku'],
  ['守岸人', 'shorekeeper_(wuthering_waves)'],
  ['阿米娅', 'amiya_(arknights)'],
  ['鸣潮', 'wuthering_waves'],
  ['明日方舟', 'arknights'],
  ['原神', 'genshin_impact'],
  ['崩坏', 'honkai'],
  ['初音', 'hatsune_miku'],
  ['兔兔', 'amiya_(arknights)'],
];

// 服装/属性别名；cosplay 相关放最前，且长词在前，避免 "cosplay" 被 "cos" 先吃掉。
const ATTRIBUTE_ALIASES = [
  ['cosplay', 'cosplay_photo'],
  ['coser', 'cosplay_photo'],
  ['cos', 'cosplay_photo'],
  ['泳装', 'swimsuit'],
  ['泳衣', 'swimsuit'],
  ['比基尼', 'bikini'],
  ['婚纱', 'wedding_dress'],
  ['制服', 'school_uniform'],
  ['睡衣', 'pajamas'],
  ['猫耳', 'animal_ears'],
  ['白丝', 'white_thighhighs'],
  ['黑丝', 'black_thighhighs'],
  ['女仆', 'maid'],
  ['兔女郎', 'bunny_girl'],
];

const ALIASES = [...CHARACTER_ALIASES, ...ATTRIBUTE_ALIASES];

const RATING_TAG = {
  safe: 'rating:g',
  mild: 'rating:g,s',
  nsfw: 'rating:q,e',
};

const NSFW_HINT = /(色图|涩图|黄图|福利|裸|露点|nsfw|r18|18\+|性感)/i;

/** 命中角色/作品别名时返回对应 Danbooru tag，否则返回 null。 */
export function matchCharacterAlias(rawQuery) {
  const q = String(rawQuery ?? '');
  for (const [cn, tag] of CHARACTER_ALIASES) {
    if (q.includes(cn)) return tag;
  }
  return null;
}

/** 把用户口语化的中文要求转成 Danbooru 标签串，并给出建议 rating。 */
export function buildDanbooruQuery(rawQuery, requestedRating, { cosplay = false } = {}) {
  let q = String(rawQuery ?? '').trim();
  let rating = requestedRating && RATING_TAG[requestedRating] ? requestedRating : null;
  if (!rating) rating = NSFW_HINT.test(q) ? 'nsfw' : 'safe';

  const characterTag = matchCharacterAlias(q);
  const tags = new Set();
  for (const [cn, tag] of ALIASES) {
    if (!q.includes(cn)) continue;
    tags.add(tag);
    q = q.split(cn).join(' ');
  }
  // 去掉口语词，剩下按空白切分，符合 tag 字符集的原样保留。
  q = q.replace(/(色图|涩图|黄图|福利|美女|图片|照片|一张|给我|帮我|找|的|图|看看|发我|真人)/g, ' ');
  for (const token of q.split(/\s+/)) {
    const t = token.trim();
    if (!t) continue;
    if (/^[A-Za-z0-9_():.,'!-]{2,64}$/.test(t)) tags.add(t);
  }
  // 匿名 Danbooru API 一次最多 3 个 tag（含 rating），第 4 个直接 422
  // （PostQuery::TagLimitError）。因此内容 tag 只保留前 2 个。
  let content;
  if (cosplay) {
    // cosplay 是角色换装插画；cosplay_photo 才是实际真人 cos 照片。
    // 真人请求优先保留角色和照片标签，作品名/服装让位。
    content = characterTag ? [characterTag, 'cosplay_photo'] : ['cosplay_photo'];
  } else {
    content = [...tags].slice(0, 2);
  }
  if (!content.length) return { tags: '', rating, empty: true };
  // order:score 也占一个 tag 名额：只有 1 个内容 tag 时才加。
  const parts = content.length === 1 ? [...content, 'order:score'] : content;
  return { tags: [...parts, RATING_TAG[rating]].join(' '), rating, empty: false, cosplay: content.includes('cosplay_photo'), characterTag };
}

function normalizePost(post) {
  const url = post.large_file_url || post.file_url || '';
  if (!url) return null;
  return {
    id: post.id,
    pageUrl: `https://danbooru.donmai.us/posts/${post.id}`,
    url,
    preview: post.preview_file_url || '',
    width: post.image_width || 0,
    height: post.image_height || 0,
    rating: post.rating || '',
    score: post.score || 0,
    character: post.tag_string_character || '',
    copyright: post.tag_string_copyright || '',
  };
}

/** 检索图片。失败抛错，由调用方决定如何提示模型。 */
export async function searchDanbooru({ query, limit = 6, page = 1, rating, cosplay = false, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const built = buildDanbooruQuery(query, rating, { cosplay });
  if (built.empty) {
    return { ok: false, error: '没有识别出可用的英文 tag；请给出角色名或作品名（可为中文）', results: [] };
  }
  const size = Math.min(32, Math.max(1, Number(limit) || 6));
  // cos 结果质量参差，多取几张按 score 排，再把最像样的给模型。
  const fetchSize = built.cosplay ? Math.min(32, Math.max(size, 2)) : size;
  const pageNumber = Math.min(1000, Math.max(1, Math.floor(Number(page) || 1)));
  const url = `${API}?limit=${fetchSize}&page=${pageNumber}&tags=${encodeURIComponent(built.tags)}`;
  let response;
  let lastError = null;
  // Danbooru 在国内线路会间歇性连接超时（UND_ERR_CONNECT_TIMEOUT）；重试一次能救回大部分抖动。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetchImpl(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  if (!response) {
    return { ok: false, unreachable: true, error: `图源连接失败：${lastError?.message ?? lastError}（该图源当前网络不可达，可改用 photo 图源）`, results: [] };
  }
  if (response.status === 429) {
    return { ok: false, error: '图源限流（429），稍后再试，不要连续重试', results: [] };
  }
  if (!response.ok) {
    return { ok: false, error: `图源返回 HTTP ${response.status}`, results: [] };
  }
  let posts;
  try { posts = await response.json(); }
  catch { return { ok: false, error: '图源返回的不是合法 JSON', results: [] }; }
  if (!Array.isArray(posts)) return { ok: false, error: '图源返回结构异常', results: [] };

  let results = posts.map(normalizePost).filter(Boolean);
  if (built.cosplay) results = results.sort((a, b) => b.score - a.score).slice(0, size);
  return {
    ok: results.length > 0,
    tags: built.tags,
    rating: built.rating,
    count: results.length,
    results,
    ...(results.length ? {} : { error: '这个组合没有搜到图，换个角色名或去掉 cosplay 之类的附加词' }),
  };
}
