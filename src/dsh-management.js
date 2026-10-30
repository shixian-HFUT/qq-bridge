// The DSH delegate's complete capability surface. No shell or arbitrary HTTP.
import fs from 'node:fs';
import path from 'node:path';

const FILE_DIRS = new Set(['src', 'docs', 'roles']);
const EXTENSIONS = new Set(['.md', '.js', '.mjs', '.ts', '.txt']);
// 允许按日志读取的文件。qq-activity 是交流摘要；bridge.log 才有发图/下载/超时这类运行期报错。
const LOGS = new Set(['state/qq-activity.log', 'state/bridge.log']);
export function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('参数必须为对象');
  if (Object.keys(value).some(k => !keys.includes(k))) throw Error('包含未开放的字段');
  return value;
}
function number(value, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw Error('数值超出允许范围');
  return value;
}
export function redact(text, secrets = []) {
  let output = String(text);
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 6) output = output.replaceAll(secret, '[REDACTED]');
  return output.split('\n').map(line => /(?:authorization\s*[:=]|bearer\s+|(?:api[_-]?key|access[_-]?token|password|secret|consoleToken|authToken)\s*["']?\s*[:=]|\bsk-[a-zA-Z0-9_-]{12,}|BEGIN .*PRIVATE KEY)/i.test(line) ? '[REDACTED: credential-like line]' : line).join('\n');
}
export class DshManagement {
  constructor({ root, request, getSecrets = () => [] }) {
    this.root = fs.realpathSync(root); this.request = request; this.getSecrets = getSecrets;
  }
  config() { return JSON.parse(fs.readFileSync(path.join(this.root, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); }
  allowedKey(key) {
    if (typeof key !== 'string' || !/^(group|private):[1-9]\d*$/.test(key)) throw Error('需要明确的 group:群号 或 private:QQ号');
    const [kind, id] = key.split(':'); const c = this.config();
    if ((c.deny?.[kind === 'group' ? 'groups' : 'private'] || []).some(x => String(x) === id)) throw Error('目标已被拒绝');
    if (!(c.allow?.[kind === 'group' ? 'groups' : 'private'] || []).some(x => String(x) === id)) throw Error('目标不在当前白名单');
    return key;
  }
  resolveFile(relative, directory = false, log = false) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || relative.includes('\0') || path.posix.isAbsolute(relative)) throw Error('仅接受项目相对路径');
    const parts = relative.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) throw Error('路径不允许');
    if (log ? !LOGS.has(relative) : (!FILE_DIRS.has(parts[0]) || (!directory && !EXTENSIONS.has(path.extname(relative))))) throw Error('文件不在开放范围');
    let file = this.root;
    for (const part of parts) {
      file = path.join(file, part);
      if (fs.lstatSync(file).isSymbolicLink()) throw Error('不允许符号链接');
    }
    const real = fs.realpathSync(file);
    if (!real.startsWith(this.root + path.sep)) throw Error('路径越界');
    const stat = fs.statSync(real);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw Error('文件类型不符');
    return real;
  }
  readFile(relative, log = false, { tail = 200, grep = '' } = {}) {
    const file = this.resolveFile(relative, false, log);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const size = fs.fstatSync(fd).size; const limit = 65536;
      const start = log ? Math.max(0, size - limit) : 0;
      const buffer = Buffer.alloc(Math.min(size, limit));
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytes).toString('utf8');
      if (text.includes('\0')) throw Error('不读取二进制文件');
      if (start) text = text.slice(text.indexOf('\n') + 1);
      if (!log && size > bytes) text = text.slice(0, Math.max(0, text.lastIndexOf('\n')));
      text = redact(text, this.getSecrets());
      let lines = text.split('\n');
      // 日志常要按关键词找，否则只能靠模型自己扫 200 行。
      const needle = String(grep || '').trim().slice(0, 60).toLowerCase();
      if (needle) lines = lines.filter(line => line.toLowerCase().includes(needle));
      const want = Math.max(1, Math.min(500, Number(tail) || 200));
      const selected = log ? lines.slice(-want) : lines.slice(0, 400);
      return { path: relative, text: selected.join('\n').slice(0, 24000), matched: needle ? selected.length : undefined,
        truncated: size > bytes || lines.length > selected.length || selected.join('\n').length > 24000 };
    } finally { fs.closeSync(fd); }
  }
  async settings(key) {
    if (key) this.allowedKey(key);
    const status = await this.request('GET', '/api/status');
    const social = await this.request('GET', '/api/socialV2/config');
    const result = { role: status.role, roleMode: status.roleMode, send: social.config?.send };
    if (key) {
      const state = await this.request('GET', '/api/socialV2/state?key=' + encodeURIComponent(key));
      result.key = key; result.wake = (state.state || state).wakeConfig;
    }
    return result;
  }
  async perform(action, args, { check, audit }) {
    check();
    if (action === 'read_settings') { object(args, ['key']); return this.settings(args.key); }
    if (action === 'list_files') {
      object(args, ['path']); const relative = args.path || 'src';
      const dir = this.resolveFile(relative, true);
      const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith('.') && !e.isSymbolicLink() && (e.isDirectory() || EXTENSIONS.has(path.extname(e.name))));
      return { path: relative, entries: entries.slice(0, 150).map(e => ({ name: e.name, directory: e.isDirectory() })), truncated: entries.length > 150 };
    }
    if (action === 'read_file' || action === 'read_log') {
      // 日志读取放宽到 path/tail/grep：只给 path 会让模型自己编 tail/lines/since 等字段，
      // 而多余字段会被 object() 直接拒掉（线上表现为连续「包含未开放的字段」）。
      object(args, ['path', 'tail', 'lines', 'grep', 'keyword']);
      const tail = args.tail ?? args.lines;
      const grep = args.grep ?? args.keyword ?? '';
      return this.readFile(args.path || (action === 'read_log' ? 'state/qq-activity.log' : ''), action === 'read_log', { tail, grep });
    }
    if (action !== 'patch_settings') throw Error('未知操作');
    object(args, ['scope', 'key', 'patch']);
    const patch = args.patch; let route, body, before, readBack;
    if (args.scope === 'roleMode') {
      object(patch, ['mode']); if (!['active', 'silent'].includes(patch.mode)) throw Error('mode 必须为 active 或 silent');
      before = { mode: (await this.settings()).roleMode };
      route = '/api/role-mode'; body = patch; readBack = async () => ({ mode: (await this.settings()).roleMode });
    } else if (args.scope === 'send') {
      object(patch, ['maxSendPerMinute', 'maxSendPerHour']);
      for (const [key, value] of Object.entries(patch)) number(value, 1, key === 'maxSendPerMinute' ? 30 : 600, true);
      before = (await this.settings()).send;
      route = '/api/socialV2/config'; body = { send: patch }; readBack = async () => (await this.settings()).send;
    } else if (args.scope === 'wake') {
      this.allowedKey(args.key); object(patch, ['observationMs', 'observationPolicy', 'batchWindowMs', 'triggers']);
      for (const key of ['observationMs', 'batchWindowMs']) if (key in patch) number(patch[key], 1000, 3600000, true);
      if ('observationPolicy' in patch && (!args.key.startsWith('group:') || !['fixed', 'sliding'].includes(patch.observationPolicy))) throw Error('群聊窗口策略无效');
      if ('triggers' in patch) {
        object(patch.triggers, ['probability', 'atMention', 'nameMention']);
        if ('probability' in patch.triggers) number(patch.triggers.probability, 0, 1);
        for (const key of ['atMention', 'nameMention']) if (key in patch.triggers && typeof patch.triggers[key] !== 'boolean') throw Error('触发开关必须为布尔值');
      }
      before = (await this.settings(args.key)).wake;
      route = '/api/socialV2/wake-config'; body = { key: args.key, config: patch }; readBack = async () => (await this.settings(args.key)).wake;
    } else throw Error('未开放此设置类别');
    if (!Object.keys(patch).length) throw Error('修改不能为空');
    // Persist intent before dispatch. An uncertain write must never be replayed.
    const entry = { action, scope: args.scope, key: args.key, before, patch, status: 'dispatching' }; audit(entry);
    check();
    try {
      await this.request('POST', route, body);
      const after = await readBack();
      const contains = (actual, expected) => Object.entries(expected).every(([k, v]) => v && typeof v === 'object' ? contains(actual?.[k] || {}, v) : actual?.[k] === v);
      if (!contains(after || {}, patch)) throw Error('管理接口回读与请求不一致');
      entry.status = 'verified'; entry.after = after; audit();
      return { verified: true, before, after };
    } catch (error) { entry.status = 'unknown'; audit(); throw Error('修改结果未确认，请先查询当前设置，不要自动重试'); }
  }
}
