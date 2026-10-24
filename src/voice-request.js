import fs from 'node:fs';
import crypto from 'node:crypto';

export function isVoiceRequest(event, { kind, role = '守岸人', replyToSelf = false } = {}) {
  const segments = Array.isArray(event.message) ? event.message : [];
  if (segments.some(s => ['forward', 'node', 'record'].includes(s.type))) return false;
  const ats = segments.filter(s => s.type === 'at').map(s => String(s.data?.qq));
  if (ats.some(id => id !== String(event.self_id))) return false;
  let text = segments.filter(s => s.type === 'text').map(s => String(s.data?.text || '')).join('').trim();
  // 引号、代码和引用行内的请求不发放许可。
  text = text.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"|^>.*$/gm, '').trim();
  const negativeText = text.replace(/能不能/g, '能');
  if (/(?:不要|不用|别|不许|无需|不想|不能).{0,8}(?:语音|声音)|(?:语音|声音).{0,8}(?:不要|不用|别)/.test(negativeText)) return false;
  const named = role && text.startsWith(role);
  if (kind !== 'private' && !ats.includes(String(event.self_id)) && !named && !replyToSelf) return false;
  if (named) text = text.slice(role.length).replace(/^[，,：:、\s]+/, '');
  text = text.replace(/^[，,：:、!！?？\s]+/, '');
  if (/(?:他说|她说|有人说|比如|例如|假如|如果|举例)/.test(text)) return false;
  // 语音功能咨询不是要求本轮发送，避免“你现在会用语音说话了吗”消耗许可。
  if (/(?:会不会|会|是否支持|支不支持|支持)(?:用)?(?:语音|声音)|(?:语音|声音)(?:功能|能力|怎么)/.test(text)) return false;
  // 直接向机器人提出的“跟我/给我/能不能…用语音说…”不要求命令位于句首。
  if (/(?:用语音|用声音)(?:(?:跟|对|给|向)我)?(?:说|回答|回复|讲|读|念|聊|告诉)/.test(text)) return true;
  const command = /^(?:你)?(?:能不能|可不可以|可以|能|请|麻烦)?(?:你)?(?:给我)?(?:用语音|用声音|语音(?:回复|回答|发|说|来)|发(?:一条|一段|一句|一小段|个|条|段)?语音|说句语音)/;
  if (command.test(text)) return true;
  // 同一条直接发给机器人的消息允许先交代背景，再单独提出语音请求。
  // 转述或举例中的命令不产生许可。
  return text.split(/[，,。！？!?；;\n]/).some(clause => command.test(clause.trim()));
}

export class VoiceRequestStore {
  constructor(file, now = Date.now) {
    this.file = file; this.now = now; this.inflight = new Map();
    this.records = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }
  save() {
    const temp = this.file + '.pending';
    fs.writeFileSync(temp, JSON.stringify(this.records), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  id(key, messageId) { return crypto.createHash('sha256').update(key + '\0' + messageId).digest('hex'); }
  issue(key, messageId, token) {
    if (!messageId || !token) return;
    for (const [id, r] of Object.entries(this.records)) if (this.now() - r.at > 86400000) delete this.records[id];
    const id = this.id(key, String(messageId));
    if (this.records[id]) return;
    this.records[id] = { at: this.now(), key, messageId: String(messageId), tokenHash: crypto.createHash('sha256').update(token).digest('hex'), status: 'ready' };
    this.save();
  }
  pending(key) {
    return Object.values(this.records).filter(r => r.key === key && r.status === 'ready' && this.now() - r.at < 180000).map(r => r.messageId);
  }
  async run(key, messageId, token, work) {
    const id = this.id(key, String(messageId));
    const r = this.records[id];
    if (!r || r.tokenHash !== crypto.createHash('sha256').update(token).digest('hex')) throw new Error('该消息没有当前会话的语音请求许可');
    if (this.inflight.has(id)) return this.inflight.get(id);
    if (r.status === 'sent') return r.result;
    if (r.status !== 'ready') throw new Error('该语音请求已经处理或结果待核对，请勿重复发送');
    if (this.now() - r.at >= 180000) throw new Error('语音请求已过期，请用户重新请求');
    r.status = 'processing'; this.save();
    const task = (async () => {
      try { const result = await work(() => { if (this.now() - r.at >= 180000) throw new Error('语音请求已过期'); });
        r.status = 'sent'; r.result = result; this.save(); return result;
      } catch (error) { r.status = 'failed-or-unknown'; this.save(); throw error; }
      finally { this.inflight.delete(id); }
    })();
    this.inflight.set(id, task);
    return task;
  }
}

// 管理员开启自主语音后，AI 可为当前会话选择朗读内容。
// 用会话令牌和台词生成稳定标识，保留并发、重启和发送结果不明时的去重。
export async function runVoiceAction(store, settings, { key, token, text, requestMessageId }, work) {
  if (!settings.enabled || !settings.approved) throw new Error('实时角色语音未开启');
  let id = String(requestMessageId || '');
  if (settings.autonomous === true) {
    const line = String(text).normalize('NFC').trim().replace(/\s+/g, ' ');
    id = 'auto:' + crypto.createHash('sha256').update(token + '\0' + line).digest('hex');
    store.issue(key, id, token);
  }
  return store.run(key, id, token, work);
}
