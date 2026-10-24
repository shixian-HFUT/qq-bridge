import { createHash } from 'node:crypto';

export const imageHash = value => createHash('sha256').update(value).digest('hex');

// Keep query parameters that may select different images; discard only tracking
// and fragments. Byte hashes at dispatch catch identical files on other URLs.
export function imageUrlFingerprint(value) {
  const url = new URL(String(value));
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid)$/i.test(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  return imageHash(url.href);
}
