import { autonomousVoiceId, speechPreference, voiceCadenceState } from './voice-cadence.js';

export const GROUP_VOICE_TEXT_TURNS = 4;
export const GROUP_VOICE_INTERVAL_MS = 300000;
const latestIncoming = st => [...(st.recentMessages || [])].reverse().find(m => !m.isSelf);

export function buildGroupVoiceHint({ key, st, settings, roleAllowed, now = Date.now() }) {
  if (!key.startsWith('group:') || !settings.enabled || !settings.approved || !settings.autonomous || !roleAllowed) return '';
  const state = voiceCadenceState(st), incoming = latestIncoming(st);
  const base = '【群聊语音】接梗、祝贺、安慰或简短分享时可主动用角色语音，不必等群友要求。程序累计4次文字回复后可将合适短回复转成语音；最多80字，两次自动语音至少间隔5分钟。资料、长答、需引用或多人指代不清时用文字，不为凑次数额外冒泡。\n';
  if (speechPreference(incoming?.plain || incoming?.text) === 'text') return base + '【群聊语音节奏】当前消息要求文字，这次用文字。\n';
  const remaining = Math.max(Number(state.retryAfter) || 0, state.lastVoiceAt ? Number(state.lastVoiceAt) + GROUP_VOICE_INTERVAL_MS : 0) - now;
  if (remaining > 0) return base + `【群聊语音节奏】冷却还剩约${Math.ceil(remaining / 1000)}秒，当前用文字，不连发语音。\n`;
  if (Number(state.textTurns) < GROUP_VOICE_TEXT_TURNS) return base;
  return base + `【群聊语音节奏】已累计${Math.min(100, Number(state.textTurns) || 0)}次文字回复；若本轮是合适的短闲聊，优先用语音。直接send即可由程序判断切换，或选择qq_speak；同一句只选一种发送方式。\n`;
}

export function planGroupVoiceReply({ key, token, st, messages, settings, roleAllowed, replyToMessageId, atUserId, now = Date.now(), store }) {
  const text = messages.join('\n'), state = voiceCadenceState(st);
  const record = store?.records?.[store.id(key, autonomousVoiceId(token, text))];
  // A pending/unknown delivery must not become a second, text reply.
  if (record && ['processing', 'failed-or-unknown'].includes(record.status) && record.knownNotSent !== true) return { kind: 'unresolved', text };
  if (!key.startsWith('group:') || !settings.enabled || !settings.approved || !settings.autonomous || !roleAllowed) return { kind: 'text' };
  if (record?.status === 'sent') return now - record.at < 60000 ? { kind: 'voice', text, replay: true } : { kind: 'text' };
  if (record || replyToMessageId || atUserId || messages.length > 2 || text.length < 6 || [...text].length > Math.min(80, settings.maxChars || 120)) return { kind: 'text' };
  if (Number(state.textTurns) < GROUP_VOICE_TEXT_TURNS || now < Number(state.retryAfter || 0)
      || (state.lastVoiceAt && now - state.lastVoiceAt < GROUP_VOICE_INTERVAL_MS)) return { kind: 'text' };
  if (!/[\u4e00-\u9fff]/.test(text) || /https?:|www\.|```|[{}\[\]|]|[a-z]:\\|^\s*(?:[-*]|\d+[.)、])\s/im.test(text)) return { kind: 'text' };
  const incoming = latestIncoming(st);
  if (!incoming || incoming.hasForward || incoming.hasMedia || incoming.kind === 'poke'
      || (incoming.time && now - incoming.time > 300000)) return { kind: 'text' };
  const question = incoming.plain || incoming.text || '';
  if (speechPreference(question) === 'text' || /链接|网址|地址|代码|命令|公式|清单|列表|怎么|如何|配置|报错|多少钱|价格|计算|日志|教程|步骤|查一下|搜索|找图|发图|生图|解释|分析|资料/.test(question)) return { kind: 'text' };
  return { kind: 'voice', text };
}
