import crypto from 'node:crypto';

// Same normalized identity as runVoiceAction; consult its durable ledger before
// deciding on text, so a pending/unknown voice cannot become a duplicate text.
export function autonomousVoiceId(token, text) {
  const line = String(text).normalize('NFC').trim().replace(/\s+/g, ' ');
  return 'auto:' + crypto.createHash('sha256').update(token + '\0' + line).digest('hex');
}

export function speechPreference(text) {
  const own = String(text || '').replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"|^>.*$/gm, '');
  if (/(?:不要|不用|别|不许|不想|不方便).{0,8}(?:语音|声音|听)|(?:语音|声音).{0,8}(?:不要|不用|别)|(?:只|用|看|发|改成|还是)(?:发)?文字|打字(?:回|聊|说)|文字(?:回复|回答|就好|就行)/.test(own)) return 'text';
  if (/(?:可以|恢复|用|发|想听|喜欢).{0,6}语音|(?:听|发).{0,4}(?:你说话|你的声音)/.test(own)) return 'auto';
  return null;
}

export function voiceCadenceState(st) {
  if (!st.voiceCadence || typeof st.voiceCadence !== 'object') {
    let count = 0, preference = 'auto';
    for (const m of st.recentMessages || []) {
      if (m.isSelf) {
        if (m.speech === true) count = 0;
        else if (m.time && !m.messageId) count++;
      } else if (!m.hasForward) preference = speechPreference(m.plain || m.text) || preference;
    }
    st.voiceCadence = { textTurns: Math.min(4, count), preference, lastVoiceAt: 0, retryAfter: 0 };
  }
  return st.voiceCadence;
}

export function noteSpeechPreference(st, text) {
  const preference = speechPreference(text);
  if (preference) voiceCadenceState(st).preference = preference;
}
export function noteTextReply(st) {
  const state = voiceCadenceState(st);
  state.textTurns = Math.min(100, (Number(state.textTurns) || 0) + 1);
}
export function noteVoiceReply(st, now = Date.now()) {
  Object.assign(voiceCadenceState(st), { textTurns: 0, lastVoiceAt: now, retryAfter: 0 });
}

export function planVoiceReply({ key, token, st, messages, settings, roleAllowed, replyToMessageId, now = Date.now(), store }) {
  const text = messages.join('\n');
  const state = voiceCadenceState(st);
  const record = store?.records?.[store.id(key, autonomousVoiceId(token, text))];
  // This check precedes cadence/cooldown checks. Never fall back to text for an
  // older speech request whose delivery is still unresolved.
  if (record && ['processing', 'failed-or-unknown'].includes(record.status) && record.knownNotSent !== true) return { kind: 'unresolved', text };
  if (!key.startsWith('private:') || !settings.enabled || !settings.approved || !settings.autonomous || !roleAllowed || state.preference === 'text') return { kind: 'text' };
  if (record?.status === 'sent') {
    if (now - record.at < 60000) return { kind: 'voice', text, replay: true };
    return { kind: 'text' }; // Existing speech ledger intentionally deduplicates identical lines.
  }
  if (record || replyToMessageId || messages.length > 3 || text.length < 6 || [...text].length > Math.min(100, settings.maxChars || 120)) return { kind: 'text' };
  if (Number(state.textTurns) < 4 || now < Number(state.retryAfter || 0) || (state.lastVoiceAt && now - state.lastVoiceAt < 180000)) return { kind: 'text' };
  if (!/[\u4e00-\u9fff]/.test(text) || /https?:|www\.|```|[{}\[\]|]|[a-z]:\\|^\s*(?:[-*]|\d+[.)、])\s/im.test(text)) return { kind: 'text' };
  const incoming = [...(st.recentMessages || [])].reverse().find(m => !m.isSelf);
  if (incoming?.hasForward || incoming?.hasMedia || incoming?.kind === 'poke') return { kind: 'text' };
  const question = incoming?.plain || incoming?.text || '';
  if (/链接|网址|地址|代码|命令|公式|清单|列表|怎么|如何|配置|报错|多少钱|价格|计算|日志|教程|步骤|查一下|搜索|找图|发图|生图|解释|分析|资料/.test(question)) return { kind: 'text' };
  return { kind: 'voice', text };
}
