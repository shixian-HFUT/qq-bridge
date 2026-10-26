// 简化 QQ 聊天工具的模型侧适配层（纯函数，无 I/O、无网络、不读配置）。
//
// 目标（用户可感知）：普通文字回复只需要短工具名和自然文字参数；会话 key、
// 会话令牌、已读水位、原消息 ID 由 Pi 运行时从**当轮可信会话上下文**绑定，
// 模型不必复制这些字段，也就不会因为漏传/传错而在 QQ 上沉默。
//
// 安全边界（不许放松）：
// - 只在明确开关（config.pi.simpleTools === true）下启用；默认完全沿用旧行为。
// - 名称映射只用**精确表**：不做前缀/包含/大小写/模糊匹配，未知名称不会被
//   改写成任何有副作用的调用。
// - 绑定总是**覆盖**模型传入的 key / token / throughSeq，而不是填空：
//   群里拿到的旧 token、伪造 token、超前水位都不可能通过这里提权。
// - 没有可信上下文时 fail closed（抛错），不回退到模型给的 key。
// - 本模块不发送任何东西；真正的权限/白名单/限流/会话有效性仍由桥接在
//   执行时逐次校验（同一 token 换群或不存在的会话都会被 403）。
//
// 说明：Pi 后端从 mcp-snowluma-safe.js 读工具清单，工具名形如
// `mcp__snowluma__qq_send_message`。本模块把这些工具暴露成短名 + 短参数，
// 同时保留原长名作为兼容入口（历史会话/预设里仍写着长名）。

/** Pi 配置里的开关名：config.pi.simpleTools === true 才启用本适配层。 */
export const SIMPLE_TOOLS_FLAG = 'simpleTools';

/** 连续触发多少次“只有文字没有动作”的纠正后暂停纠正，避免反复加请求。 */
export const SIMPLE_CORRECTION_MAX_STREAK = 2;

const SNOWLUMA_PREFIX = 'mcp__snowluma__';

/** 可信上下文缺失时的统一错误（fail closed，不回退到模型传的 key/token）。 */
export const SIMPLE_CONTEXT_ERROR = '缺少可信的当轮会话上下文，已拒绝这次工具调用；请等待下一次唤醒后再试';

const ID_SCHEMA = {
  anyOf: [{ type: 'string' }, { type: 'number' }],
  description: '消息 id（非零整数，可为负数）'
};

const TEXT_SCHEMA = {
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  description: '要发送的文字：字符串=一条；字符串数组=多条'
};

/**
 * 模型侧短工具名 → MCP 工具名（精确表，顺序无关）。只列“回复/收尾”这条主链路；
 * 图片、语音、表情、记忆等工具保持原有名字，只去掉不再需要的 key/token 参数。
 */
export const SIMPLE_TOOL_ALIASES = Object.freeze({
  send: {
    target: 'qq_send_message',
    description: '发送QQ文字（推荐）。text 传字符串=一条，传字符串数组=多条；要引用某条消息传 reply_to=消息id，要@某人传 at=QQ号。例如 send(text="在的")。会话 key、令牌、已读水位由程序自动绑定，不要自己传。'
  },
  read: {
    target: 'qq_get_unread_messages',
    description: '查看未读消息（不会自动标记已读）。积压时用 afterSeq=上次返回的 readThroughSeq 继续补读；从最早未读开始传 0。'
  },
  recent: {
    target: 'qq_get_recent_messages',
    description: '查看最近消息（只读）；可用 limit / offset 往前翻。'
  },
  mark_read: {
    target: 'qq_mark_read',
    description: '收尾：确认已看到当前快照并结束本回合。不需要参数，已读水位由程序自动绑定（只会确认真正展示过的消息）。'
  },
  wait: {
    target: 'qq_wait_for_messages',
    description: '等待消息。purpose="reply" 用于回复前的短静默；沉睡前观察用 timeoutMs=300000。收到新消息后直接使用返回的 newMessages。'
  },
  wake: {
    target: 'qq_set_wake_config',
    description: '设置下一次唤醒条件（config 对象：mode=active/diving、infinite、sleepMs、triggers 等）。已读水位由程序自动绑定，不必传 throughSeq。'
  },
  role: {
    target: 'qq_get_prompt',
    description: '重读当前角色卡与推荐配置（角色变化、摘要后缺人设时用）。不需要参数。'
  },
  state: {
    target: 'qq_social_state',
    description: '查看当前会话状态：未读数、唤醒配置、上次唤醒原因、上次发言时间。不需要参数。'
  }
});

/** 这些动作工具一旦被调用过，就不再做“只输出文字”的格式纠正（避免旧错误反复加请求）。 */
const ACTION_TOOL_NAMES = new Set([
  'qq_send_message',
  'qq_send_burst',
  'qq_send_group_message',
  'qq_send_private_message',
  'qq_reply',
  'qq_send_image',
  'qq_generate_image',
  'qq_image_job',
  'qq_send_generated_image',
  'qq_send_sticker',
  'qq_send_voice',
  'qq_speak',
  'qq_send_poke',
  'qq_mark_read',
  'qq_set_wake_config'
]);

/** 目标工具里“发送成功即确认已读”的参数名。 */
const ACK_TARGETS = new Set(['qq_send_message', 'qq_mark_read', 'qq_set_wake_config', 'qq_send_image']);

/** 需要原消息 ID 做防重标识的工具（缺省时由可信上下文补齐，显式传入不覆盖）。 */
const REQUEST_ID_TARGETS = new Set(['qq_send_image', 'qq_generate_image']);

/** 长名工具的参数微调：把旧协议必需、但运行时可以自动绑定的字段改成可选。 */
const SCHEMA_HINTS = {
  qq_send_message: {
    dropRequired: ['messages'],
    addProperties: {
      text: TEXT_SCHEMA,
      reply_to: ID_SCHEMA,
      at: ID_SCHEMA
    }
  },
  qq_send_image: { dropRequired: ['requestId'] },
  qq_generate_image: { dropRequired: ['requestId'] }
};

const ALIAS_SCHEMAS = {
  send: {
    type: 'object',
    properties: { text: TEXT_SCHEMA, messages: TEXT_SCHEMA, reply_to: ID_SCHEMA, at: ID_SCHEMA },
    required: [],
    additionalProperties: true
  },
  read: {
    type: 'object',
    properties: {
      afterSeq: { type: 'integer', minimum: 0, description: '读取本地 seq 大于此水位的最早一页' },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    },
    required: [],
    additionalProperties: true
  },
  recent: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      offset: { type: 'integer', minimum: 0 }
    },
    required: [],
    additionalProperties: true
  },
  mark_read: { type: 'object', properties: {}, required: [], additionalProperties: true },
  wait: {
    type: 'object',
    properties: {
      purpose: { type: 'string', enum: ['messages', 'reply'] },
      timeoutMs: { type: 'number' },
      minNewMessages: { type: 'number' },
      quietMs: { type: 'number' }
    },
    required: [],
    additionalProperties: true
  },
  wake: {
    type: 'object',
    properties: { config: { type: 'object', additionalProperties: true } },
    required: [],
    additionalProperties: true
  },
  role: { type: 'object', properties: {}, required: [], additionalProperties: true },
  state: { type: 'object', properties: {}, required: [], additionalProperties: true }
};

/** 追加到系统提示里的短说明（只在开关打开且有可信上下文时用）。 */
export const SIMPLE_TOOLS_PROMPT_NOTE = '\n【工具简写】文字回复直接调 send(text="要发的话")，多条用 text=["第一条","第二条"]，引用传 reply_to=消息id；不发言用 mark_read()；等待用 wait()；设唤醒用 wake(config={...})。会话 key、令牌、已读水位由程序自动绑定，不要自己传 key/token/throughSeq。原有长名工具仍然可用，但优先用这些简写。';

/** “只输出文字、没有执行动作”时给模型的一次有界格式纠正。 */
export const FORMAT_CORRECTION_TEXT = '【格式提醒】你刚才只输出了文字，没有调用发送工具，所以这段话不会发到 QQ。如果要回复，请调用 send(text="...")（多条用数组）；如果决定不发言，请调用 mark_read() 收尾；要改唤醒条件就用 wake(config={...})。不要复述这条提醒。';

/** 是否启用本适配层（只认显式 true）。 */
export function simpleToolsEnabled(config) {
  return config?.[SIMPLE_TOOLS_FLAG] === true;
}

/** `mcp__snowluma__qq_x` → `qq_x`；只剥已知命名空间，其他名字原样返回。 */
export function stripSnowlumaPrefix(name) {
  const raw = String(name ?? '');
  return raw.startsWith(SNOWLUMA_PREFIX) ? raw.slice(SNOWLUMA_PREFIX.length) : raw;
}

/** 精确解析短名；不是别名就返回 null（不做模糊匹配）。 */
export function resolveSimpleAlias(name) {
  const raw = String(name ?? '');
  return Object.prototype.hasOwnProperty.call(SIMPLE_TOOL_ALIASES, raw) ? SIMPLE_TOOL_ALIASES[raw] : null;
}

/** 动作工具判定：接受短名、`qq_*`、`mcp__snowluma__qq_*` 三种精确形式。 */
export function canonicalActionName(name) {
  const alias = resolveSimpleAlias(name);
  if (alias) return alias.target;
  return stripSnowlumaPrefix(name);
}

export function isActionToolName(name) {
  return ACTION_TOOL_NAMES.has(canonicalActionName(name));
}

/**
 * 校验并收敛桥接传来的当轮上下文。非法输入一律返回 null（简化工具拒绝调用），
 * 不抛错、不猜测、不把任意对象字段带进工具参数。
 *
 * kind 必须显式来自桥接：chat-wake（普通聊天唤醒）才允许格式纠正；
 * silent（摘要投喂/后台提醒）与 internal（其它系统提示）永远不纠正。
 */
export function sanitizeTurnContext(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  const token = typeof raw.token === 'string' ? raw.token.trim() : '';
  if (!/^(group|private):[1-9]\d*$/.test(key)) return null;
  if (!token || token.length > 512) return null;
  const seq = raw.readThroughSeq;
  const readThroughSeq = Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
  const mode = ['reserved2', 'chat', 'closed-agent'].includes(raw.mode) ? raw.mode : null;
  const kind = ['chat-wake', 'silent', 'internal'].includes(raw.kind) ? raw.kind : null;
  const sourceId = typeof raw.sourceId === 'string' && raw.sourceId && raw.sourceId.length <= 128
    ? raw.sourceId : null;
  const requestMessageId = raw.requestMessageId === undefined || raw.requestMessageId === null
    ? null : String(raw.requestMessageId);
  return { key, token, readThroughSeq, mode, kind, sourceId, requestMessageId };
}

/** 工具清单里带 `key` 参数的 snowluma 工具才适配（老式 send_group/reply 不动）。 */
function adaptableTarget(def) {
  if (!def || typeof def.name !== 'string' || !def.name.startsWith(SNOWLUMA_PREFIX)) return null;
  const properties = def.parameters?.properties;
  if (!properties || typeof properties !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(properties, 'key')) return null;
  return stripSnowlumaPrefix(def.name);
}

/** 去掉模型不再需要传的字段，并按目标工具放宽旧协议里的必填项。 */
export function pruneToolSchema(target, original) {
  const schema = original && typeof original === 'object' ? original : { type: 'object', properties: {} };
  const properties = { ...(schema.properties || {}) };
  const dropped = ['key', 'token', 'throughSeq'];
  for (const field of dropped) delete properties[field];
  const hint = SCHEMA_HINTS[target];
  if (hint?.addProperties) Object.assign(properties, hint.addProperties);
  let required = Array.isArray(schema.required) ? schema.required : [];
  required = required.filter((field) => !dropped.includes(field));
  if (hint?.dropRequired) required = required.filter((field) => !hint.dropRequired.includes(field));
  const next = { ...schema, properties };
  if (required.length) next.required = required;
  else delete next.required;
  return next;
}

/** 把 text 归一成消息数组：接受字符串、字符串数组、以及被序列化成 JSON 的字符串。 */
export function normalizeMessageValue(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  if (typeof value !== 'string') throw new Error('text 必须是字符串或字符串数组');
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item ?? '').trim()).filter(Boolean);
    } catch {}
  }
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return [parsed.trim()].filter(Boolean);
    } catch {}
  }
  return [trimmed];
}

function requireTurnContext(turn) {
  if (!turn || typeof turn !== 'object') throw new Error(SIMPLE_CONTEXT_ERROR);
  const key = typeof turn.key === 'string' ? turn.key.trim() : '';
  const token = typeof turn.token === 'string' ? turn.token.trim() : '';
  if (!/^(group|private):[1-9]\d*$/.test(key) || !token) throw new Error(SIMPLE_CONTEXT_ERROR);
  return turn;
}

/**
 * 底层工具接受的消息形状：老工具可能只收 JSON 字符串数组。
 * 自然数组不能直接塞给“只收字符串”的工具，否则会在 zod 校验处失败。
 */
export function messagePayloadMode(schema) {
  const property = schema?.properties?.messages;
  if (!property || typeof property !== 'object') return 'array';
  const types = [];
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string') types.push(node.type);
    if (Array.isArray(node.type)) types.push(...node.type);
    for (const branch of [...(node.anyOf || []), ...(node.oneOf || [])]) collect(branch);
  };
  collect(property);
  // 能收数组就保持数组（JSON 字符串也能被桥接解析，但数组更直接）。
  if (types.includes('array')) return 'array';
  if (types.includes('string')) return 'json';
  return 'array';
}

/** 可信水位推进：只允许前进到模型真正拿到过的 readThroughSeq。 */
export function advanceTurnCursor(turn, readThroughSeq) {
  if (!turn || typeof turn !== 'object') return false;
  if (!Number.isSafeInteger(readThroughSeq) || readThroughSeq < 0) return false;
  const current = Number.isSafeInteger(turn.readThroughSeq) && turn.readThroughSeq >= 0 ? turn.readThroughSeq : 0;
  if (readThroughSeq <= current) return false;
  turn.readThroughSeq = readThroughSeq;
  return true;
}

/** 读未读/最近/等待：它们返回给模型的 readThroughSeq 可以推进本回合水位。 */
const CURSOR_SOURCE_TARGETS = new Set(['qq_get_unread_messages', 'qq_get_recent_messages', 'qq_wait_for_messages']);

export function isCursorSourceTarget(target) {
  return CURSOR_SOURCE_TARGETS.has(String(target ?? ''));
}

/**
 * 把模型参数改写成底层 MCP 工具真正需要的形状，并绑定可信字段。
 * 模型传的 key/token/throughSeq/requestId 一律丢弃后重填；缺可信上下文直接抛错。
 */
export function bindSimpleArguments(target, rawArgs, turn, { messageMode = 'array' } = {}) {
  const context = requireTurnContext(turn);
  const input = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  const args = { ...input };
  delete args.key;
  delete args.token;
  delete args.throughSeq;

  if (target === 'qq_send_message') {
    for (const from of ['reply_to', 'replyTo']) {
      if (!Object.prototype.hasOwnProperty.call(args, from)) continue;
      if (args.replyToMessageId === undefined) args.replyToMessageId = args[from];
      delete args[from];
    }
    if (Object.prototype.hasOwnProperty.call(args, 'at') && args.atUserId === undefined) {
      args.atUserId = args.at;
    }
    delete args.at;
    if (Object.prototype.hasOwnProperty.call(args, 'text')) {
      if (Object.prototype.hasOwnProperty.call(args, 'messages')) throw new Error('send 的 text 与 messages 只能传一个');
      const messages = normalizeMessageValue(args.text);
      delete args.text;
      if (!messages.length) throw new Error('send 需要非空的 text');
      args.messages = messageMode === 'json' ? JSON.stringify(messages) : messages;
    } else if (!Object.prototype.hasOwnProperty.call(args, 'messages')) {
      throw new Error('send 需要 text（字符串或字符串数组）');
    }
  }

  args.key = context.key;
  if (context.token) args.token = context.token;

  if (ACK_TARGETS.has(target)) {
    if (!Number.isSafeInteger(context.readThroughSeq) || context.readThroughSeq < 0) {
      throw new Error('缺少可信的已读水位，本轮不能确认已读；请先查看未读消息再收尾');
    }
    // 永远覆盖：模型传的 0 / 旧水位 / 超前水位都不会生效。
    args.throughSeq = context.readThroughSeq;
  }

  if (REQUEST_ID_TARGETS.has(target)) {
    // 永远由可信来源绑定：模型不能换一个新标识绕过同一源消息的发送防重。
    if (!context.requestMessageId) {
      throw new Error('缺少可信的原消息ID，本轮不能发送图片；请先读取消息再试');
    }
    args.requestId = String(context.requestMessageId);
  }
  return args;
}

function plainExposure(def) {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    canonical: def.name,
    target: null,
    execute: def.execute,
    bindArgs: null
  };
}

function adaptedExposure(def, target, turn, { name, description, parameters }) {
  // 按**原始** MCP schema 决定消息给数组还是 JSON 字符串，模型永远只给自然参数。
  const messageMode = messagePayloadMode(def.parameters);
  return {
    name,
    label: def.label ?? name,
    description,
    parameters,
    canonical: def.name,
    target,
    execute: def.execute,
    bindArgs: rawArgs => bindSimpleArguments(target, rawArgs, turn, { messageMode })
  };
}

/** 历史 `mcp__snowluma__*` 名称的兼容入口：参数宽松，真正形状由底层 zod 校验。 */
const COMPAT_SCHEMA = { type: 'object', properties: {}, additionalProperties: true };

/**
 * 生成本轮交给模型的工具清单。
 * - enabled=false：原样返回（默认行为，零变化）。
 * - enabled=true：
 *   · 带 key 的 snowluma 工具改用与预设文案一致的裸 `qq_*` 名称（真实出现过的
 *     qq_send_message / qq_mark_read / qq_get_prompt 等都能直接调用），
 *     去掉 key/token/throughSeq 并由运行时绑定；
 *   · 同时保留历史 `mcp__snowluma__*` 名称作为兼容入口；
 *   · 再追加精确的短名别名（send/read/mark_read/wait/wake/...）。
 * 只映射**清单里真实存在**的工具；任何重名都不覆盖已有工具，冲突目标也不再加短名。
 */
export function buildToolExposure(definitions, { enabled = false, turn = null } = {}) {
  const defs = Array.isArray(definitions) ? definitions.filter((def) => def && typeof def.name === 'string') : [];
  if (!enabled) return defs.map(plainExposure);
  const used = new Set(defs.map((def) => def.name));
  const blocked = new Set();
  const out = [];
  for (const def of defs) {
    const target = adaptableTarget(def);
    if (!target) { out.push(plainExposure(def)); continue; }
    // Another definition already owns the bare short name: keep that tool and
    // its contract untouched, and do not add aliases pointing at this target.
    if (used.has(target) && target !== def.name) {
      blocked.add(target);
      // A name collision must not bypass the trusted binding on the original
      // canonical entry. Keep the foreign bare tool untouched, but protect this
      // snowluma tool exactly as in the normal compatibility path.
      out.push(adaptedExposure(def, target, turn, {
        name: def.name,
        description: `${def.description ?? ''}（会话和已读水位由程序绑定。）`,
        parameters: pruneToolSchema(target, def.parameters)
      }));
      continue;
    }
    used.add(target);
    out.push(adaptedExposure(def, target, turn, {
      name: target,
      description: `${def.description ?? ''}（会话 key、令牌、已读水位由程序自动绑定，不必传。）`,
      parameters: pruneToolSchema(target, def.parameters)
    }));
    out.push(adaptedExposure(def, target, turn, {
      name: def.name,
      description: `历史名称，等价于 ${target}；参数相同，key、令牌、已读水位由程序自动绑定。优先用简写。`,
      parameters: COMPAT_SCHEMA
    }));
  }
  for (const [alias, spec] of Object.entries(SIMPLE_TOOL_ALIASES)) {
    if (used.has(alias) || blocked.has(spec.target)) continue; // 冲突：保留已有工具，绝不覆盖
    const def = defs.find((candidate) => candidate.name === SNOWLUMA_PREFIX + spec.target);
    if (!def || !adaptableTarget(def)) continue;
    used.add(alias);
    out.push(adaptedExposure(def, spec.target, turn, {
      name: alias,
      description: spec.description,
      parameters: ALIAS_SCHEMAS[alias] ?? COMPAT_SCHEMA
    }));
  }
  return out;
}

/** 记录 tool/call 时脱敏：模型若仍塞 key/token，只留占位，不把令牌写进存档。 */
export function redactToolArgumentsForRecord(args) {
  if (!args || typeof args !== 'object') return args ?? null;
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = key === 'key' || key === 'token' ? '***' : value;
  }
  return out;
}

/** 有界格式纠正的判定（纯函数，便于单测）。 */
export function shouldOfferFormatCorrection({
  actionAttempted = false,
  hadToolError = false,
  usedThisTurn = false,
  text = '',
  streak = 0,
  maxStreak = SIMPLE_CORRECTION_MAX_STREAK,
  callsLeft = 1
} = {}) {
  if (usedThisTurn) return false;
  if (actionAttempted) return false;
  if (hadToolError) return false;
  if (typeof text !== 'string' || !text.trim()) return false;
  if (!Number.isFinite(streak) || streak < 0 || streak >= maxStreak) return false;
  return Number.isFinite(callsLeft) && callsLeft >= 1;
}
