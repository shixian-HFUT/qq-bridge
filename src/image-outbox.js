import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { imageHash, imageUrlFingerprint } from './image-identity.js';

const hash = text => crypto.createHash('sha256').update(text).digest('hex');

// Persist before dispatch. A timeout or a restart after dispatch is never
// interpreted as permission to resend an image.
export class ImageOutbox {
  constructor(file) {
    this.file = file;
    this.pending = new Map();
    try {
      this.rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      if (!this.rows || typeof this.rows !== 'object' || Array.isArray(this.rows)) throw Error('invalid outbox');
      for (const row of Object.values(this.rows)) if (row.status === 'sending') row.status = 'unknown';
    } catch { this.unavailable = true; }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.rows), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  protectedRows() {
    return Object.entries(this.rows).filter(([id, row]) =>
      ['sent', 'sending', 'unknown'].includes(row.status) || this.pending.has(id));
  }
  hasUrl(key, url) {
    if (this.unavailable) throw Error('图片发送记录不可读，暂不能排除已发送图片');
    const scope = imageHash(key), urlFingerprint = imageUrlFingerprint(url);
    return this.protectedRows().some(([, row]) => row.scope === scope
      && (row.urlFingerprint === urlFingerprint || row.urlFingerprints?.includes(urlFingerprint) || row.urlAliases?.includes(urlFingerprint)));
  }
  assertFresh(scope, fields, exceptId) {
    const duplicate = this.protectedRows().find(([id, row]) => id !== exceptId && row.scope === scope
      && Object.entries(fields).some(([name, value]) => value
        && (row[name] === value || (name === 'urlFingerprint' && (row.urlFingerprints?.includes(value) || row.urlAliases?.includes(value)))
          || (name === 'contentFingerprint' && row.contentFingerprints?.includes(value)))));
    if (!duplicate) return;
    const row = duplicate[1];
    // A byte-identical alias is also excluded from future search results.
    if (fields.contentFingerprint && (row.contentFingerprint === fields.contentFingerprint || row.contentFingerprints?.includes(fields.contentFingerprint)) && fields.urlFingerprint
      && row.urlFingerprint !== fields.urlFingerprint && !row.urlFingerprints?.includes(fields.urlFingerprint) && !row.urlAliases?.includes(fields.urlFingerprint)) {
      row.urlAliases = [...(row.urlAliases || []), fields.urlFingerprint].slice(-256);
      this.save();
    }
    const unknown = ['sending', 'unknown'].includes(duplicate[1].status);
    const error = Error(unknown ? '同一图片之前的发送结果不明，不可重发；请先在QQ确认'
      : '本会话已发送过这张图片，本次没有发送；请重新搜索并换一张，不要反复尝试同一图片');
    error.duplicate = true;
    error.unknown = unknown;
    throw error;
  }
  async send({ key, requestId, source, prepare, dispatch }) {
    if (this.unavailable) throw Error('图片发送记录不可读，已暂停图片发送以免重复');
    const id = hash(JSON.stringify([key, requestId]));
    const fingerprint = hash(JSON.stringify(source));
    const previous = this.rows[id];
    if (previous && previous.fingerprint !== fingerprint) throw Error('该请求已绑定另一张图片，请勿换图重试');
    if (previous?.status === 'sent') return { messageId: previous.messageId, alreadySent: true };
    if (previous?.status === 'unknown' || previous?.status === 'sending') {
      const error = Error('这张图片发送结果不明，不可重发；请先在QQ确认');
      error.unknown = true; error.alreadyAttempted = true; throw error;
    }
    if (this.pending.has(id)) {
      try { return { ...(await this.pending.get(id)), alreadySent: true }; }
      catch (error) { throw Object.assign(Error(error.message), error, { alreadyAttempted: true }); }
    }
    if (!previous && Object.keys(this.rows).length >= 10000) throw Error('图片发送记录已满，请管理员整理');
    const scope = imageHash(key);
    const urlFingerprints = source.url ? [imageUrlFingerprint(source.url)]
      : Array.isArray(source.urls) ? source.urls.map(imageUrlFingerprint) : [];
    if (new Set(urlFingerprints).size !== urlFingerprints.length) throw Error('同一组图片包含重复网址');
    for (const urlFingerprint of urlFingerprints) this.assertFresh(scope, { urlFingerprint }, id);
    // Reserve synchronously before any await, including a download.
    const row = this.rows[id] = { fingerprint, scope,
      ...(urlFingerprints.length === 1 ? { urlFingerprint: urlFingerprints[0] } : urlFingerprints.length ? { urlFingerprints, urlAliases: [...urlFingerprints] } : {}),
      status: 'prepared', at: Date.now() };
    const work = (async () => {
      let dispatched = false;
      const shadows = [];
      try {
        const image = await prepare();
        if (urlFingerprints.length) {
          const images = Array.isArray(image?.images) ? image.images : [image];
          if (images.length !== urlFingerprints.length) throw Error('图片来源和下载数量不一致');
          const fingerprints = images.map(item => {
            const buffer = Buffer.isBuffer(item) ? item : item.buffer;
            if (!Buffer.isBuffer(buffer)) throw Error('图片内容不可用');
            return imageHash(buffer);
          });
          if (new Set(fingerprints).size !== fingerprints.length) throw Error('同一组图片内容重复');
          for (let i = 0; i < fingerprints.length; i++) this.assertFresh(scope, { urlFingerprint: urlFingerprints[i], contentFingerprint: fingerprints[i] }, id);
          row.contentFingerprint = fingerprints[0];
          if (fingerprints.length > 1) {
            row.contentFingerprints = fingerprints;
            // Scalar shadow rows let an older reader retain URL/byte dedup even
            // after a source rollback. All refer to the same QQ message.
            if (Object.keys(this.rows).length + fingerprints.length > 10000) throw Error('图片发送记录已满，请管理员整理');
            const ids = fingerprints.map((_, i) => hash(JSON.stringify([key, requestId, 'media-item', i])));
            if (ids.some(itemId => this.rows[itemId])) throw Error('批量图片发送记录冲突，已暂停发送');
            for (let i = 0; i < ids.length; i++) {
              const item = this.rows[ids[i]] = { fingerprint: hash(fingerprint + ':' + i), scope,
                urlFingerprint: urlFingerprints[i], contentFingerprint: fingerprints[i], status: 'prepared', at: row.at };
              shadows.push([ids[i], item]);
            }
          }
        }
        const messageId = await dispatch(image, () => {
          row.status = 'sending'; for (const [, item] of shadows) item.status = 'sending';
          this.save(); dispatched = true;
        });
        if (!/^-?[1-9]\d*$/.test(String(messageId ?? ''))) throw Error('QQ未返回有效图片消息ID');
        row.status = 'sent'; row.messageId = String(messageId);
        for (const [, item] of shadows) { item.status = 'sent'; item.messageId = row.messageId; }
        this.save();
        return { messageId: row.messageId, alreadySent: false };
      } catch (error) {
        if (dispatched) {
          row.status = 'unknown'; for (const [, item] of shadows) item.status = 'unknown';
          try { this.save(); } catch {}
          const failure = Error('图片发送结果不明，不可重发；请先在QQ确认');
          failure.unknown = true; throw failure;
        }
        delete this.rows[id];
        for (const [itemId] of shadows) delete this.rows[itemId];
        try { this.save(); } catch { this.unavailable = true; }
        if (error.unknown !== true) error.unknown = false;
        throw error;
      }
    })();
    this.pending.set(id, work);
    try { return await work; } finally { this.pending.delete(id); }
  }
}
