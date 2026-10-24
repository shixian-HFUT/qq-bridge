import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const DAY = 86400000;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const SESSION = /^pi-session-[a-f0-9-]+$/;
const HASH = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback;

export class PiMaintenance {
  constructor({ directory, config = {}, index, live, saveSession, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.directory = path.resolve(directory);
    this.index = index; this.live = live; this.saveSession = saveSession;
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.options = {
      enabled: config.enabled !== false,
      intervalMs: bounded(config.intervalMs, 6 * 3600000, 60000, 30 * DAY),
      startupDelayMs: bounded(config.startupDelayMs, 60000, 1000, DAY),
      maxHotTurns: bounded(config.maxHotTurns, 24, 2, 200),
      maxHotMessages: bounded(config.maxHotMessages, 400, 4, 10000),
      maxHotBytes: bounded(config.maxHotBytes, 2 * 1024 * 1024, 4096, MAX_SCAN_BYTES),
      orphanGraceMs: bounded(config.orphanGraceMs, 7 * DAY, DAY, 365 * DAY),
      tempGraceMs: bounded(config.tempGraceMs, DAY, 3600000, 30 * DAY),
    };
    this.timer = null; this.stopped = false; this.running = false; this.nextRunAt = null;
    this.lastReport = null;
  }

  start() { if (this.options.enabled && !this.timer && !this.stopped) this.schedule(this.options.startupDelayMs); }
  schedule(delay) {
    if (this.timer) this.clearTimer(this.timer);
    this.nextRunAt = this.now() + delay;
    this.timer = this.setTimer(() => {
      this.timer = null;
      const report = this.run();
      if (!this.stopped) this.schedule(report.skippedBusy ? Math.min(300000, this.options.intervalMs) : this.options.intervalMs);
    }, delay);
    this.timer?.unref?.();
  }
  stop() { this.stopped = true; if (this.timer) this.clearTimer(this.timer); this.timer = null; this.nextRunAt = null; }
  status() { return { enabled: this.options.enabled, options: this.options, nextRunAt: this.nextRunAt, lastReport: this.lastReport }; }

  // All writes/deletes are confined to these private Pi subdirectories. Reject
  // symlinked parents rather than following them outside the intended tree.
  directoryAt(...parts) {
    const target = path.resolve(this.directory, ...parts);
    if (target !== this.directory && !target.startsWith(this.directory + path.sep)) throw Error('Maintenance path outside Pi directory');
    let current = this.directory;
    for (const part of ['', ...path.relative(this.directory, target).split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      if (fs.existsSync(current)) {
        const info = fs.lstatSync(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Unsafe Pi maintenance directory');
      } else fs.mkdirSync(current, { recursive: true, mode: 0o700 });
    }
    return target;
  }
  readJson(file) {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > MAX_SCAN_BYTES) throw Error('Unsafe or oversized Pi session archive');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  atomicWrite(file, data) {
    const temp = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  }
  archive(sessionId, messages) {
    const body = Buffer.from(JSON.stringify({ schema: 1, sessionId, messages }));
    if (body.length > MAX_CHUNK_BYTES) throw Error('Pi archive chunk exceeds maintenance size limit');
    const digest = hash(body);
    const file = path.join(this.directoryAt('history', sessionId), digest + '.json.gz');
    if (fs.existsSync(file)) {
      if (hash(this.readChunk(file)) !== digest) throw Error('Existing Pi history chunk checksum mismatch');
    } else this.atomicWrite(file, gzipSync(body));
    return file;
  }
  readChunk(file) {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > MAX_CHUNK_BYTES) throw Error('Unsafe Pi history chunk');
    return gunzipSync(fs.readFileSync(file), { maxOutputLength: MAX_CHUNK_BYTES });
  }

  compact(session) {
    const messages = session.messages;
    if (!Array.isArray(messages)) throw Error('Invalid Pi message archive');
    const groups = [];
    for (const message of messages) {
      if (message.role === 'user' || !groups.length) groups.push([]);
      groups.at(-1).push(message);
    }
    let count = 0, bytes = 0, first = groups.length;
    for (let i = groups.length - 1; i >= 0; i--) {
      const size = Buffer.byteLength(JSON.stringify(groups[i]));
      if (first < groups.length && (groups.length - i > this.options.maxHotTurns || count + groups[i].length > this.options.maxHotMessages || bytes + size > this.options.maxHotBytes)) break;
      first = i; count += groups[i].length; bytes += size;
    }
    if (!first) return { archivedMessages: 0, chunks: 0, oversizedLatestTurn: bytes > this.options.maxHotBytes };
    const removed = groups.slice(0, first);
    // Chunk on complete user turns; never split a tool call/result pair.
    let batch = [], size = 0, chunks = 0;
    for (const group of removed) {
      const n = Buffer.byteLength(JSON.stringify(group));
      if (batch.length && size + n > MAX_CHUNK_BYTES / 2) { this.archive(session.sessionId, batch.flat()); chunks++; batch = []; size = 0; }
      batch.push(group); size += n;
    }
    if (batch.length) { this.archive(session.sessionId, batch.flat()); chunks++; }
    const kept = groups.slice(first).flat();
    const snapshot = [...messages].reverse().find(m => m.role === 'user' && m.bridgeMemory)?.bridgeMemory;
    if (snapshot && !kept.some(m => m.role === 'user' && m.bridgeMemory)) {
      const i = kept.findIndex(m => m.role === 'user');
      if (i >= 0) kept[i] = { ...kept[i], bridgeMemory: snapshot };
    }
    session.messages = kept;
    try { this.saveSession(session); }
    catch (error) { session.messages = messages; throw error; }
    return { archivedMessages: messages.length - kept.length, chunks, oversizedLatestTurn: bytes > this.options.maxHotBytes };
  }

  collectReferences() {
    const refs = new Set(); let scanned = 0;
    const mark = value => {
      if (!value || typeof value !== 'object') return;
      if (Object.hasOwn(value, 'bridgeImageRef')) {
        if (!HASH.test(value.bridgeImageRef)) throw Error('Invalid image reference during Pi maintenance');
        refs.add(value.bridgeImageRef);
      }
      for (const child of Object.values(value)) if (child && typeof child === 'object') mark(child);
    };
    const sessionDir = this.directoryAt('sessions');
    for (const id of Object.keys(this.index().sessions)) {
      if (!SESSION.test(id) || !fs.existsSync(path.join(sessionDir, id + '.json'))) throw Error('Pi index references a missing or invalid session');
    }
    for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
      if (entry.name.endsWith('.tmp')) continue;
      if (!entry.isFile() || !SESSION.test(entry.name.replace(/\.json$/, '')) || !entry.name.endsWith('.json')) throw Error('Unexpected Pi session file; media cleanup stopped');
      if (++scanned > 10000) throw Error('Pi maintenance reference scan limit exceeded');
      mark(this.readJson(path.join(sessionDir, entry.name)));
    }
    const history = this.directoryAt('history');
    for (const folder of fs.readdirSync(history, { withFileTypes: true })) {
      if (!folder.isDirectory() || !SESSION.test(folder.name)) throw Error('Unexpected Pi history directory');
      const dir = this.directoryAt('history', folder.name);
      for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
        if (file.name.endsWith('.tmp')) continue;
        if (!file.isFile() || !/^[a-f0-9]{64}\.json\.gz$/.test(file.name)) throw Error('Unexpected Pi history file');
        if (++scanned > 10000) throw Error('Pi maintenance reference scan limit exceeded');
        const body = this.readChunk(path.join(dir, file.name));
        if (hash(body) !== file.name.slice(0, 64)) throw Error('Pi history checksum mismatch; media cleanup stopped');
        const chunk = JSON.parse(body.toString('utf8'));
        if (chunk.schema !== 1 || chunk.sessionId !== folder.name || !Array.isArray(chunk.messages)) throw Error('Invalid Pi history chunk');
        mark(chunk.messages);
      }
    }
    return refs;
  }
  cleanFiles(refs) {
    const now = this.now(); let deletedMedia = 0, deletedTemps = 0, freedBytes = 0;
    const media = this.directoryAt('media');
    for (const entry of fs.readdirSync(media, { withFileTypes: true })) {
      if (deletedMedia >= 256) break;
      if (!entry.isFile() || !/^[a-f0-9]{64}\.b64$/.test(entry.name) || refs.has(entry.name.slice(0, 64))) continue;
      const file = path.join(media, entry.name), info = fs.lstatSync(file);
      if (now - info.mtimeMs < this.options.orphanGraceMs) continue;
      fs.unlinkSync(file); deletedMedia++; freedBytes += info.size;
    }
    const dirs = [media, this.directoryAt('sessions')];
    for (const folder of fs.readdirSync(this.directoryAt('history'), { withFileTypes: true })) if (folder.isDirectory() && SESSION.test(folder.name)) dirs.push(this.directoryAt('history', folder.name));
    for (const dir of dirs) for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (deletedTemps >= 256) break;
      if (!entry.isFile() || !/^(?:[a-f0-9]{64}\.b64|[a-f0-9]{64}\.json\.gz|pi-session-[a-f0-9-]+\.json)\.[a-f0-9-]+\.tmp$/.test(entry.name)) continue;
      const file = path.join(dir, entry.name), info = fs.lstatSync(file);
      if (now - info.mtimeMs < this.options.tempGraceMs) continue;
      fs.unlinkSync(file); deletedTemps++; freedBytes += info.size;
    }
    return { deletedMedia, deletedTemps, freedBytes };
  }

  run() {
    const report = { at: this.now(), compactedSessions: 0, archivedMessages: 0, chunks: 0, skippedBusy: 0, deletedMedia: 0, deletedTemps: 0, freedBytes: 0, errors: [] };
    if (!this.options.enabled || this.running || this.stopped) return { ...report, disabled: !this.options.enabled, skippedBusy: this.running ? 1 : 0 };
    this.running = true;
    try {
      const index = this.index();
      for (const [id, metadata] of Object.entries(index.sessions)) {
        if (!SESSION.test(id)) throw Error('Invalid Pi session id');
        const loaded = this.live.get(id);
        if (loaded && (loaded.running || loaded.runPromise || loaded.queue?.length)) { report.skippedBusy++; continue; }
        if (metadata.archived) continue;
        const session = loaded || this.readJson(path.join(this.directoryAt('sessions'), id + '.json'));
        if (session.running) { report.skippedBusy++; continue; }
        if (session.sessionId !== id) throw Error('Pi session id mismatch');
        const result = this.compact(session);
        if (result.archivedMessages) report.compactedSessions++;
        report.archivedMessages += result.archivedMessages; report.chunks += result.chunks;
      }
      // A running turn can be about to checkpoint a new image reference. Do not
      // perform any file collection until every session is idle.
      if (!report.skippedBusy) Object.assign(report, this.cleanFiles(this.collectReferences()));
    } catch (error) { report.errors.push(error.message); }
    finally {
      this.running = false; this.lastReport = report;
      try { this.atomicWrite(path.join(this.directoryAt(), 'maintenance.json'), JSON.stringify(report)); }
      catch (error) { report.errors.push('Could not save maintenance report: ' + error.message); }
    }
    return report;
  }
}
