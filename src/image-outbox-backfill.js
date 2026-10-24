import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { imageHash, imageUrlFingerprint } from './image-identity.js';

// Recover only identities corroborated by an existing outbox row. Do not infer
// delivery from a model's text, download old URLs, or alter Pi archives/statuses.
export function backfillImageOutbox(file, piDir, { apply = false } = {}) {
  const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw Error('Invalid image outbox');
  const updated = new Set();
  let scanned = 0;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.name === 'string' && /(?:^|__)qq_send_image$/.test(value.name)) {
      let args = value.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
      if (args && /^(private|group):[1-9]\d*$/.test(args.key) && typeof args.requestId === 'string'
        && typeof args.url === 'string' && /^https?:\/\//i.test(args.url)) {
        const id = imageHash(JSON.stringify([args.key, args.requestId]));
        const row = rows[id];
        if (row && row.fingerprint === imageHash(JSON.stringify({ url: args.url })) && !row.urlFingerprint) {
          row.scope = imageHash(args.key);
          row.urlFingerprint = imageUrlFingerprint(args.url);
          updated.add(id);
        }
      }
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  const scan = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error('Unexpected symlink in Pi archives');
      if (entry.isDirectory()) scan(item);
      else if (entry.isFile() && /\.json(?:\.gz)?$/.test(entry.name)) {
        if (fs.statSync(item).size > 64 * 1024 * 1024) throw Error('Oversized Pi archive');
        let data = fs.readFileSync(item);
        if (entry.name.endsWith('.gz')) data = gunzipSync(data, { maxOutputLength: 64 * 1024 * 1024 });
        visit(JSON.parse(data.toString('utf8'))); scanned++;
      }
    }
  };
  scan(path.join(piDir, 'sessions'));
  scan(path.join(piDir, 'history'));
  if (apply && updated.size) {
    fs.writeFileSync(file + '.backfill.tmp', JSON.stringify(rows), { mode: 0o600 });
    fs.renameSync(file + '.backfill.tmp', file);
  }
  const sentIdentities = new Set();
  let duplicateUrlRows = 0;
  for (const row of Object.values(rows)) {
    if (row.status !== 'sent' || !row.scope || !row.urlFingerprint) continue;
    const identity = row.scope + ':' + row.urlFingerprint;
    if (sentIdentities.has(identity)) duplicateUrlRows++;
    sentIdentities.add(identity);
  }
  return { scanned, matchedRows: updated.size, applied: apply && updated.size > 0,
    rows: Object.keys(rows).length, duplicateUrlRows };
}
