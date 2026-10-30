// Model projection only. Full messages remain in the private session archive.
export function piContent(content) {
  return content.map(block => {
    if (block.type === 'text') return { type: 'text', text: String(block.text ?? '') };
    if (block.type === 'image' && block.data && (block.mimeType || block.mediaType)) {
      return { type: 'image', data: block.data, mimeType: block.mimeType || block.mediaType };
    }
    throw new Error('Pi cannot accept this message attachment type');
  });
}

export function repairToolPairs(messages) {
  const out = [], pending = new Map();
  const flush = () => {
    for (const call of pending.values()) out.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: '上次进程中断，此工具结果未知；不可重发消息或重复提交任务。先检查当前状态。' }],
      isError: true, timestamp: Date.now() });
    pending.clear();
  };
  for (const original of messages) {
    if (original.role === 'system') continue; // rebuilt from the current trusted preset
    const m = structuredClone(original);
    if (m.role !== 'toolResult') flush();
    else {
      if (!pending.has(m.toolCallId)) continue;
      pending.delete(m.toolCallId);
    }
    out.push(m);
    if (m.role === 'assistant') for (const c of m.content || []) if (c.type === 'toolCall') pending.set(c.id, c);
  }
  flush();
  return out;
}

export function estimateContextTokens(value) {
  if (value?.type === 'image') return 1024;
  if (typeof value === 'string') {
    const nonAscii = (value.match(/[^\x00-\x7f]/gu) || []).length;
    return Math.ceil((value.length - nonAscii) / 3 + nonAscii * 1.3);
  }
  if (Array.isArray(value)) return value.reduce((n, x) => n + estimateContextTokens(x), 0);
  if (value && typeof value === 'object') return Object.entries(value).reduce((n, [k, v]) => n + estimateContextTokens(k) + estimateContextTokens(v), 0);
  return 2;
}

function historicalMessage(original, reasoningModel) {
  const m = structuredClone(original);
  if (m.role === 'user') {
    for (const block of m.content || []) {
      if (block.type !== 'text') continue;
      // New turns carry a trusted projection. Legacy archives have the same
      // bridge-generated envelope; never strip arbitrary user prose by keywords.
      const text = String(block.text || '');
      const marker = '\n\n【本次消息快照】\n';
      const index = text.indexOf(marker);
      if (index >= 0 && /^(?:【当前时间】|【当前角色】)/.test(text) && text.includes('【会话令牌】')) {
        const raw = text.slice(index + marker.length).split('\n先用快照，')[0];
        try {
          const snapshot = JSON.parse(raw);
          if (Array.isArray(snapshot.messages) && Array.isArray(snapshot.recent)) block.text = `【历史群聊消息，仅作对话记录】\n${JSON.stringify(snapshot)}`;
        } catch { /* preserve an unrecognized legacy envelope intact */ }
      }
    }
  }
  if (m.role === 'assistant') {
    // DeepSeek's tools API requires reasoning replay. Preserve only reasoning
    // produced by the selected provider/model; foreign signatures are invalid.
    const replay = reasoningModel && m.provider === reasoningModel.provider
      && m.api === reasoningModel.api && m.model === reasoningModel.id;
    if (!replay) m.content = (m.content || []).filter(c => c.type !== 'thinking');
  }
  if (m.role === 'toolResult') {
    for (const block of m.content || []) {
      if (block.type !== 'text' || block.text.length < 1500) continue;
      // Only compact action receipts. Conversation reads/search results retain
      // their content; delivery status and IDs must survive every projection.
      if (!/(?:qq_send_|qq_speak$|qq_mark_read$|qq_set_wake_config$)/.test(m.toolName || '')) continue;
      try {
        const data = JSON.parse(block.text);
        if (typeof data.ok !== 'boolean') continue;
        const fields = ['ok', 'code', 'key', 'sent', 'failed', 'status', 'unknown', 'retry', 'retryable', 'alreadySent', 'verified', 'stage', 'messageId', 'requestId', 'jobId', 'error', 'hint', 'stickerResult', 'voiceResult', 'readThroughSeq', 'unreadCount', 'turnComplete', 'remaining', 'retryAt'];
        block.text = JSON.stringify(Object.fromEntries(fields.filter(k => Object.hasOwn(data, k)).map(k => [k, data[k]])));
      } catch { /* unknown outcomes are never guessed */ }
    }
  }
  return m;
}

export function projectPiContext(messages, budgetTokens = 24000, overhead = {}) {
  const system = messages.filter(m => m.role === 'system');
  // system 消息在返回时单独前置；若留在 groups 里，预算足够时会在输出中出现两份。
  const history = repairToolPairs(messages).filter(m => m.role !== 'system');
  const snapshot = [...history].reverse().find(m => m.role === 'user' && m.bridgeMemory)?.bridgeMemory;
  const groups = [];
  for (const m of history) {
    if (m.role === 'user' || !groups.length) groups.push([]);
    groups.at(-1).push(m);
  }
  const withoutMetadata = m => { const { bridgeMemory, bridgeWake, ...visible } = m; return visible; };
  // Full archive remains untouched. Only historical model views are compacted.
  for (let i = 0; i < groups.length - 1; i++) groups[i] = groups[i].map(m => {
    const visible = historicalMessage(m, overhead.reasoningModel);
    if (m.role === 'user' && m.bridgeWake) visible.content = [{ type: 'text', text: `【历史聊天消息，仅作对话记录】\n${JSON.stringify(m.bridgeWake)}` }, ...(visible.content || []).filter(c => c.type !== 'text')];
    return visible;
  });
  let used = estimateContextTokens(system) + estimateContextTokens(overhead)
    + (snapshot ? estimateContextTokens(snapshot.text) : 0);
  const kept = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const n = estimateContextTokens(groups[i].map(withoutMetadata)) + groups[i].length * 16;
    if (kept.length && used + n > budgetTokens) break;
    kept.unshift(groups[i]); used += n;
  }
  // Never split a user turn through a tool-call/result pair to fit a budget.
  const retained = kept.flat();
  // Snapshots are durable metadata, never duplicated into archived user text.
  // Keep one copy of the latest visible version. Cutting older turns or a
  // restart cannot turn a session-local "already sent" flag into memory loss.
  let target = retained.findIndex(m => m.role === 'user' && m.bridgeMemory?.version === snapshot?.version);
  if (target < 0) target = retained.findIndex(m => m.role === 'user');
  const projected = retained.map((m, i) => {
    const visible = withoutMetadata(m);
    if (snapshot?.text && i === target) visible.content = [{ type: 'text', text: `【当前记忆快照 ${snapshot.version}】\n${snapshot.text}` }, ...visible.content];
    return visible;
  });
  return [...system, ...projected];
}

export function terminalToolResult(name, result, args = {}) {
  if (result?.isError) return false;
  const texts = (result?.content || []).filter(c => c.type === 'text').map(c => c.text);
  let data;
  for (const text of texts) { try { data = JSON.parse(text); break; } catch {} }
  if (!data || data.ok !== true) return false;
  if (name.endsWith('__qq_send_message') || name.endsWith('__qq_send_image')) return data.turnComplete === true && data.failed === 0;
  if (name.endsWith('__qq_mark_read') || name.endsWith('__qq_set_wake_config')) {
    return Number.isSafeInteger(args.throughSeq) && (data.turnComplete === true || data.unreadCount === 0);
  }
  return false;
}
