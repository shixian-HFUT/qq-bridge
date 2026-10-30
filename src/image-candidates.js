import { imageSubjectTermGroups } from './danbooru-search.js';

export function supportedImageUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && !/\.(?:mp4|webm|mov|mkv|avi|zip|swf|svg|avif|html?)(?:$)/i.test(url.pathname);
  } catch { return false; }
}

const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[_\s-]+/g, ' ');
export function candidateMatchesQuery(candidate, query) {
  let evidence = [candidate.title, candidate.pageUrl, candidate.character, candidate.copyright, candidate.tags].filter(Boolean).join(' ');
  try { evidence = decodeURIComponent(evidence); } catch {}
  evidence = normalize(evidence);
  const groups = imageSubjectTermGroups(query);
  if (!groups.length || !groups.every(terms => terms.some(term => evidence.includes(normalize(term))))) return false;
  if (/(cosplay|coser|\bcos\b|cos\s*图)/i.test(query)
    && !/(cosplay|coser|\bcos\b|cos 写真|角色扮演)/i.test(evidence)) return false;
  if (/(cosplay|coser|\bcos\b|cos\s*图)/i.test(query) && !/服装|假发|道具|cos服|购买|costume|shop/i.test(query)
    && /淘宝|天猫|京东|现货|定制|假发|道具|全套|商品|商城|cosplay\s*服|cos服|taobao\.com|tmall\.com|item\.jd\.com|aliexpress|buy now|for sale/i.test(evidence)) return false;
  for (const group of [['泳装', '泳衣', 'swimsuit', 'swimwear'], ['比基尼', 'bikini'],
    ['婚纱', 'wedding dress'], ['女仆', 'maid'], ['黑丝', 'black thighhighs'], ['白丝', 'white thighhighs']]) {
    if (group.some(term => normalize(query).includes(term)) && !group.some(term => evidence.includes(term))) return false;
  }
  return true;
}

export function acceptableImageDimensions(dimensions, query) {
  if (!dimensions || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)) return false;
  const small = Math.min(dimensions.width, dimensions.height), large = Math.max(dimensions.width, dimensions.height);
  if (small <= 0 || large * small > 64_000_000 || large / small > 6) return false;
  const meme = /表情|梗图|meme|sticker/i.test(query);
  return meme ? small >= 128 && large >= 256 : small >= 512 && large >= 768;
}

// Keep only a small, expiring, session-scoped copy of bytes already checked by
// the safe downloader. Sending uses the exact checked bytes, not a second URL GET.
export class ImageCandidateCache {
  constructor({ maxBytes = 32 * 1024 * 1024, ttlMs = 120000, now = Date.now } = {}) {
    this.maxBytes = maxBytes; this.ttlMs = ttlMs; this.now = now; this.rows = new Map(); this.bytes = 0;
  }
  prune() {
    for (const [id, row] of this.rows) if (row.expires <= this.now()) this.drop(id);
  }
  drop(id) {
    const row = this.rows.get(id);
    if (row) { this.bytes -= row.image.buffer.length; this.rows.delete(id); }
  }
  put(key, url, image) {
    this.prune();
    if (!Buffer.isBuffer(image.buffer) || image.buffer.length > this.maxBytes) return;
    const id = JSON.stringify([key, url]); this.drop(id);
    while (this.rows.size && (this.bytes + image.buffer.length > this.maxBytes || this.rows.size >= 24)) this.drop(this.rows.keys().next().value);
    this.rows.set(id, { image, expires: this.now() + this.ttlMs }); this.bytes += image.buffer.length;
  }
  get(key, url) {
    this.prune(); return this.rows.get(JSON.stringify([key, url]))?.image;
  }
}
