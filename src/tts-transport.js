import https from 'node:https';
import { Readable } from 'node:stream';

// The server has no IPv6 route. Use one IPv4 request for the paid TTS endpoint;
// never retry or follow redirects with its Authorization header.
export function ipv4HttpsFetch(url, init = {}, requestImpl = https.request) {
  if (new URL(url).protocol !== 'https:') return Promise.reject(new Error('语音接口必须使用 HTTPS'));
  return new Promise((resolve, reject) => {
    const req = requestImpl(url, { method: init.method || 'GET', headers: init.headers,
      family: 4, signal: init.signal }, res => {
      const headers = new Headers();
      for (const [name, values] of Object.entries(res.headers)) {
        for (const value of Array.isArray(values) ? values : [values]) if (value != null) headers.append(name, value);
      }
      resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers }));
    });
    req.once('error', reject);
    req.end(init.body);
  });
}
