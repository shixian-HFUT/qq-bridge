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

function estimate(value) {
  if (value?.type === 'image') return 1024;
  if (typeof value === 'string') return Math.ceil(value.length / 2);
  if (Array.isArray(value)) return value.reduce((n, x) => n + estimate(x), 0);
  if (value && typeof value === 'object') return Object.entries(value).reduce((n, [k, v]) => n + estimate(k) + estimate(v), 0);
  return 2;
}

export function projectPiContext(messages, budgetTokens = 24000) {
  const system = messages.filter(m => m.role === 'system');
  const history = repairToolPairs(messages);
  const groups = [];
  for (const m of history) {
    if (m.role === 'user' || !groups.length) groups.push([]);
    groups.at(-1).push(m);
  }
  let used = estimate(system);
  const kept = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const n = estimate(groups[i]);
    if (kept.length && used + n > budgetTokens) break;
    kept.unshift(groups[i]); used += n;
  }
  // Never split a user turn through a tool-call/result pair to fit a budget.
  return [...system, ...kept.flat()];
}

export function terminalToolResult(name, result, args = {}) {
  if (result?.isError) return false;
  const texts = (result?.content || []).filter(c => c.type === 'text').map(c => c.text);
  let data;
  for (const text of texts) { try { data = JSON.parse(text); break; } catch {} }
  if (!data || data.ok !== true) return false;
  if (name.endsWith('__qq_send_message')) return data.turnComplete === true && data.failed === 0;
  if (name.endsWith('__qq_mark_read') || name.endsWith('__qq_set_wake_config')) {
    return Number.isSafeInteger(args.throughSeq) && data.unreadCount === 0;
  }
  return false;
}
