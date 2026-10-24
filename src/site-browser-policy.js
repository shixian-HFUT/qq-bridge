export const SITES = {
  bilibili: { name: 'B站', login: 'https://passport.bilibili.com/login', home: 'https://www.bilibili.com/',
    hosts: ['www.bilibili.com', 'search.bilibili.com', 'space.bilibili.com', 't.bilibili.com'] },
  weibo: { name: '微博', login: 'https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog', home: 'https://weibo.com/',
    hosts: ['weibo.com', 'www.weibo.com', 's.weibo.com', 'm.weibo.cn'] },
};

export function readerSite(value) {
  let u; try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.href.length > 4000) return null;
  const h = u.hostname, p = u.pathname;
  if (h === 'www.bilibili.com' && /^\/(?:video\/BV[A-Za-z0-9]+\/?|opus\/\d+\/?|read\/cv\d+\/?)$/.test(p)) return 'bilibili';
  if (h === 'search.bilibili.com' && /^\/(?:all|photo|article|video)\/?$/.test(p)) return 'bilibili';
  if (h === 'space.bilibili.com' && /^\/\d+(?:\/dynamic)?\/?$/.test(p)) return 'bilibili';
  if (h === 't.bilibili.com' && /^\/\d+\/?$/.test(p)) return 'bilibili';
  if (['weibo.com', 'www.weibo.com'].includes(h) && /^\/(?:u\/\d+|\d+\/[A-Za-z0-9]+)\/?$/.test(p)) return 'weibo';
  if (h === 's.weibo.com' && /^\/weibo\/?$/.test(p)) return 'weibo';
  if (h === 'm.weibo.cn' && /^\/(?:detail|status|u)\/[A-Za-z0-9]+\/?$/.test(p)) return 'weibo';
  return null;
}

export function publicImageUrl(value, site, base) {
  try {
    const u = new URL(value, base);
    if (u.protocol === 'http:') u.protocol = 'https:';
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.href.length > 3000) return null;
    const suffix = site === 'bilibili' ? 'hdslb.com' : 'sinaimg.cn';
    if (u.hostname !== suffix && !u.hostname.endsWith('.' + suffix)) return null;
    return u.href;
  } catch { return null; }
}
