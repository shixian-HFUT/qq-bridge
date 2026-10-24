// Keep image bytes on disk, not in every in-memory history/event/checkpoint copy.
// References are private archive metadata and are resolved only after projection.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_CHARS = 24 * 1024 * 1024;
const digest = data => createHash('sha256').update(data).digest('hex');

export class PiMediaStore {
  constructor(directory) { this.directory = directory; }

  externalizeContent(content) {
    if (!Array.isArray(content)) return false;
    let changed = false;
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (block?.type !== 'image' || typeof block.data !== 'string' || !block.data.length) continue;
      if (block.data.length > MAX_CHARS) throw Error('Pi image archive exceeds the media size limit');
      const hash = digest(block.data);
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, hash + '.b64');
      if (!fs.existsSync(file)) {
        const temp = file + '.' + randomUUID() + '.tmp';
        fs.writeFileSync(temp, block.data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        fs.renameSync(temp, file);
      }
      const { data, bridgeImageRef, ...metadata } = block;
      content[i] = { ...metadata, bridgeImageRef: hash };
      changed = true;
    }
    return changed;
  }

  externalizeSession(session) {
    let changed = false;
    for (const message of session.messages || []) changed = this.externalizeContent(message.content) || changed;
    for (const event of session.records || []) {
      if (event.type === 'tool/result') changed = this.externalizeContent(event.data?.message?.content) || changed;
    }
    return changed;
  }

  hydrateMessages(messages) {
    const loaded = new Map();
    return messages.map(message => {
      if (!Array.isArray(message.content) || !message.content.some(b => b?.type === 'image' && b.bridgeImageRef !== undefined)) return message;
      return { ...message, content: message.content.map(block => {
        if (block?.type !== 'image' || block.bridgeImageRef === undefined) return block;
        const hash = block.bridgeImageRef;
        if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid Pi image archive reference');
        if (!loaded.has(hash)) {
          const file = path.join(this.directory, hash + '.b64');
          const info = fs.lstatSync(file);
          if (!info.isFile() || info.size > MAX_CHARS) throw Error('Invalid Pi image archive file');
          const data = fs.readFileSync(file, 'utf8');
          if (digest(data) !== hash) throw Error('Pi image archive checksum mismatch');
          loaded.set(hash, data);
        }
        const { bridgeImageRef, ...metadata } = block;
        return { ...metadata, data: loaded.get(hash) };
      }) };
    });
  }
}
