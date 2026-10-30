// Per-turn limits for read-only research. Never retries or executes an effect.
const IMAGE = new Set(['mcp__snowluma__qq_search_images', 'qq_search_images']);
const RESEARCH = new Set([...IMAGE, 'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch']);
const FINAL = new Set(['qq_send_message', 'qq_send_image', 'qq_mark_read']);
const NUMBERS = Object.freeze({
  qq_search_images: ['count'],
  qq_get_recent_messages: ['limit', 'offset'],
  qq_get_my_recent_messages: ['limit', 'offset'],
  qq_get_unread_messages: ['limit', 'afterSeq']
});

export const TOOL_LOOP_FINISH_HINT = '本轮检索已到停止条件。不要继续搜索、抓网页或提交新任务。已有候选只能按原主题核验并发送；无法确认就用 send 发一句简短说明。不要换人物、降低筛选条件或猜图片链接。';
export const TOOL_LOOP_FALLBACK_TEXT = '这次还没能确认好结果，我先停下，免得让你一直等。可以换个条件再试。';

function short(name) {
  return String(name).startsWith('mcp__snowluma__') ? String(name).slice('mcp__snowluma__'.length) : String(name);
}
export function isLoopFinalTool(name) { return FINAL.has(short(name)); }

// Only declared read-only numeric fields accept decimal integer strings.
// IDs, authority fields, booleans, effects, bounds and downstream validation stay intact.
function numericFields(target, schema) {
  return (NUMBERS[target] || []).filter(k => ['number', 'integer'].includes(schema?.properties?.[k]?.type));
}
export function normalizeReadOnlyNumbers(target, args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const result = { ...args };
  for (const k of numericFields(target, schema)) {
    if (typeof result[k] !== 'string' || !/^\d+$/.test(result[k].trim())) continue;
    const value = Number(result[k].trim());
    if (Number.isSafeInteger(value)) result[k] = value;
  }
  return result;
}
export function relaxReadOnlyNumberSchema(target, schema) {
  const fields = numericFields(target, schema);
  if (!fields.length) return schema;
  const properties = { ...schema.properties };
  for (const k of fields) properties[k] = { anyOf: [properties[k], { type: 'string', pattern: '^\\s*\\d+\\s*$' }] };
  return { ...schema, properties };
}

export class ToolLoopGuard {
  constructor(enabled = false) {
    this.enabled = enabled;
    this.research = 0;
    this.images = 0;
    this.failures = new Map();
    this.stopped = null;
    this.closing = false;
    this.visibleAttempted = false;
  }
  stop(reason) {
    if (this.enabled && !this.stopped) this.stopped = reason;
  }
  before(name) {
    if (!this.enabled) return null;
    if (this.closing && !isLoopFinalTool(name)) return this.blocked();
    if (!RESEARCH.has(name)) return null;
    if (this.stopped) return this.blocked();
    if (this.research >= 7 || (IMAGE.has(name) && this.images >= 3)) {
      this.stop('research-budget');
      return this.blocked();
    }
    this.research++;
    if (IMAGE.has(name)) this.images++;
    return null;
  }
  observe(name, result, data) {
    if (!this.enabled || !RESEARCH.has(name)) return;
    if (!result?.isError && data?.ok !== false) return;
    const detail = data?.error || data?.code || data?.message || (result?.content || []).find(x => x.type === 'text')?.text || 'tool-error';
    // This signature stays in memory. Do not log or persist queries or error bodies.
    const key = name + ':' + JSON.stringify(detail);
    const count = (this.failures.get(key) || 0) + 1;
    this.failures.set(key, count);
    if (count >= 2) this.stop('repeated-research-error');
  }
  blocked() {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'RESEARCH_STOP', message: TOOL_LOOP_FINISH_HINT }) }] };
  }
}
