// 工具简写适配层的纯函数回归：不连 QQ、不连模型、不读生产状态。
// 覆盖：文字参数归一、长短名兼容、精确匹配（未知名称不被改写）、可信绑定、
// 跨会话/伪造令牌/超前水位、只确认展示过的快照、媒体/记忆/DSH 保留、关闭开关。
import assert from 'node:assert/strict';
import {
  SIMPLE_CONTEXT_ERROR,
  SIMPLE_TOOLS_PROMPT_NOTE,
  FORMAT_CORRECTION_TEXT,
  SIMPLE_TOOL_ALIASES,
  advanceTurnCursor,
  bindSimpleArguments,
  buildToolExposure,
  canonicalActionName,
  isActionToolName,
  isCursorSourceTarget,
  messagePayloadMode,
  normalizeMessageValue,
  pruneToolSchema,
  redactToolArgumentsForRecord,
  resolveSimpleAlias,
  sanitizeTurnContext,
  shouldOfferFormatCorrection,
  simpleToolsEnabled,
  stripSnowlumaPrefix
} from '../src/simple-tools.js';

let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS', name); }
function throwsMessage(fn, pattern) {
  try { fn(); } catch (error) { assert.match(String(error?.message ?? error), pattern); return; }
  assert.fail('expected a throw');
}

const turn = { key: 'group:456', token: 'secret-token-0123456789', mode: 'reserved2', readThroughSeq: 7, requestMessageId: 'm-1' };

const tool = (name, properties, required = [], execute = async () => ({ content: [] })) => ({
  name, label: name, description: `${name} fixture`,
  parameters: { type: 'object', properties, required, additionalProperties: false },
  execute
});

const definitions = [
  tool('mcp__snowluma__qq_send_message', {
    key: { type: 'string' }, token: { type: 'string' },
    messages: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    throughSeq: { type: 'integer' },
    replyToMessageId: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    atUserId: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    memoryOps: { type: 'array', items: { type: 'object' } }
  }, ['key', 'token', 'messages']),
  tool('mcp__snowluma__qq_mark_read', { key: { type: 'string' }, token: { type: 'string' }, throughSeq: { type: 'integer' } }, ['key', 'token']),
  tool('mcp__snowluma__qq_set_wake_config', { key: { type: 'string' }, token: { type: 'string' }, config: { type: 'object' }, throughSeq: { type: 'integer' } }, ['key', 'token']),
  tool('mcp__snowluma__qq_get_unread_messages', { key: { type: 'string' }, token: { type: 'string' }, afterSeq: { type: 'integer' } }, ['key', 'token']),
  tool('mcp__snowluma__qq_get_recent_messages', { key: { type: 'string' }, token: { type: 'string' }, limit: { type: 'integer' } }, ['key', 'token']),
  tool('mcp__snowluma__qq_wait_for_messages', { key: { type: 'string' }, token: { type: 'string' }, purpose: { type: 'string' } }, ['key', 'token']),
  tool('mcp__snowluma__qq_get_prompt', { key: { type: 'string' }, token: { type: 'string' } }, ['key', 'token']),
  tool('mcp__snowluma__qq_social_state', { key: { type: 'string' }, token: { type: 'string' } }, ['key', 'token']),
  tool('mcp__snowluma__qq_send_image', {
    key: { type: 'string' }, token: { type: 'string' }, requestId: { type: 'string' }, url: { type: 'string' }, throughSeq: { type: 'integer' }
  }, ['key', 'token', 'requestId']),
  tool('mcp__snowluma__qq_memory_append', { key: { type: 'string' }, token: { type: 'string' }, content: { type: 'string' } }, ['key', 'token', 'content']),
  tool('mcp__snowluma__qq_reply', { groupId: { type: 'string' }, message: { type: 'string' }, token: { type: 'string' } }, ['groupId', 'message']),
  tool('dsh_request', { request: { type: 'string' } }, ['request'])
];

check('开关只认显式 true（默认关闭）', () => {
  assert.equal(simpleToolsEnabled({}), false);
  assert.equal(simpleToolsEnabled({ simpleTools: 'true' }), false);
  assert.equal(simpleToolsEnabled({ simpleTools: 1 }), false);
  assert.equal(simpleToolsEnabled({ simpleTools: true }), true);
});

check('关闭开关时工具清单逐字不变（含 schema 引用）', () => {
  const exposed = buildToolExposure(definitions, { enabled: false, turn });
  assert.equal(exposed.length, definitions.length);
  for (let i = 0; i < definitions.length; i++) {
    assert.equal(exposed[i].name, definitions[i].name);
    assert.equal(exposed[i].parameters, definitions[i].parameters);
    assert.equal(exposed[i].bindArgs, null);
  }
});

const enabled = buildToolExposure(definitions, { enabled: true, turn });
const byName = name => enabled.find(entry => entry.name === name);

check('短名与历史长名同时可用，短名不与现有工具重名', () => {
  for (const alias of Object.keys(SIMPLE_TOOL_ALIASES)) {
    const entry = byName(alias);
    assert.ok(entry, `missing alias ${alias}`);
    assert.equal(entry.canonical, `mcp__snowluma__${SIMPLE_TOOL_ALIASES[alias].target}`);
  }
  assert.ok(byName('qq_send_message'), 'preset-style short name must be exposed');
  assert.ok(byName('mcp__snowluma__qq_send_message'), 'historical long name must stay callable');
  assert.equal(new Set(enabled.map(entry => entry.name)).size, enabled.length);
});

check('名称解析是精确表：大小写、拼写、模糊后缀都不改写', () => {
  assert.equal(resolveSimpleAlias('send')?.target, 'qq_send_message');
  for (const unknown of ['send_message', 'Send', 'SEND', 'send ', 'qq_send_message', 'reply', 'mark-read', 'wakeConfig']) {
    assert.equal(resolveSimpleAlias(unknown), null, `${unknown} must not be aliased`);
  }
  assert.equal(stripSnowlumaPrefix('mcp__snowluma__qq_send_message'), 'qq_send_message');
  assert.equal(stripSnowlumaPrefix('qq_send_message'), 'qq_send_message');
  assert.equal(stripSnowlumaPrefix('mcp__snowluma-host__snowluma_status'), 'mcp__snowluma-host__snowluma_status');
  assert.equal(isActionToolName('send'), true);
  assert.equal(isActionToolName('mcp__snowluma__qq_mark_read'), true);
  assert.equal(isActionToolName('SEND'), false);
  assert.equal(canonicalActionName('SEND'), 'SEND');
});

check('模型不再需要传 key/token/throughSeq', () => {
  for (const name of ['send', 'mark_read', 'wake', 'read', 'recent', 'wait', 'role', 'state']) {
    const entry = byName(name);
    const properties = entry.parameters.properties || {};
    for (const field of ['key', 'token', 'throughSeq']) assert.equal(field in properties, false, `${name} exposes ${field}`);
    assert.equal((entry.parameters.required || []).includes('key'), false);
    assert.equal((entry.parameters.required || []).includes('token'), false);
  }
  const long = byName('mcp__snowluma__qq_send_message');
  for (const field of ['key', 'token', 'throughSeq']) assert.equal(field in long.parameters.properties, false);
  assert.ok(byName('qq_send_message').parameters.properties.text, 'preset-style name also accepts natural text');
});

check('裸 qq_* 名（预设里真实出现过的写法）都能直接调用并绑定', () => {
  for (const bare of ['qq_send_message', 'qq_mark_read', 'qq_get_prompt', 'qq_get_unread_messages', 'qq_wait_for_messages']) {
    const entry = byName(bare);
    assert.ok(entry, `bare ${bare} must be exposed`);
    assert.equal(entry.target, bare);
  }
  const mark = byName('qq_mark_read').bindArgs({ key: 'group:999', token: 'forged', throughSeq: 9999 });
  assert.equal(mark.key, 'group:456');
  assert.equal(mark.token, 'secret-token-0123456789');
  assert.equal(mark.throughSeq, 7);
  const prompt = byName('qq_get_prompt').bindArgs({ key: 'group:999', token: 'forged' });
  assert.deepEqual(prompt, { key: 'group:456', token: 'secret-token-0123456789' });
  const send = byName('qq_send_message').bindArgs({ text: '你好' });
  assert.deepEqual(send.messages, ['你好']);
});

check('只映射清单里真实存在的工具', () => {
  const withoutMarkRead = definitions.filter(def => def.name !== 'mcp__snowluma__qq_mark_read');
  const exposed = buildToolExposure(withoutMarkRead, { enabled: true, turn });
  assert.equal(exposed.some(entry => entry.name === 'mark_read'), false);
  assert.equal(exposed.some(entry => entry.name === 'qq_mark_read'), false);
  assert.ok(exposed.some(entry => entry.name === 'send'));
});

check('裸名冲突时保留已有工具，且不为该目标新增短名', () => {
  const foreign = tool('qq_send_message', { something: { type: 'string' } }, []);
  const exposed = buildToolExposure([...definitions, foreign], { enabled: true, turn });
  const bare = exposed.filter(entry => entry.name === 'qq_send_message');
  assert.equal(bare.length, 1, 'existing bare name must not be replaced or duplicated');
  assert.equal(bare[0].parameters, foreign.parameters);
  assert.equal(bare[0].target, null);
  assert.equal(exposed.some(entry => entry.name === 'send'), false, 'conflicting target must not get an alias');
  assert.ok(exposed.some(entry => entry.name === 'mcp__snowluma__qq_send_message'), 'historical name keeps the snowluma tool reachable');
  const canonical = exposed.find(entry => entry.name === 'mcp__snowluma__qq_send_message');
  assert.equal(canonical.bindArgs({ text: 'x', key: 'group:999', token: 'forged' }).key, turn.key);
  const missing = buildToolExposure([...definitions, foreign], { enabled: true, turn: null })
    .find(entry => entry.name === 'mcp__snowluma__qq_send_message');
  throwsMessage(() => missing.bindArgs({ text: 'x', key: 'group:999', token: 'forged' }), /可信/);
});

check('自然数组按底层 schema 适配：只收字符串的工具拿到 JSON 字符串数组', () => {
  assert.equal(messagePayloadMode({ properties: { messages: { type: 'string' } } }), 'json');
  assert.equal(messagePayloadMode({ properties: { messages: { anyOf: [{ type: 'string' }] } } }), 'json');
  assert.equal(messagePayloadMode({ properties: { messages: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } } }), 'array');
  assert.equal(messagePayloadMode({ properties: { messages: { type: ['string', 'array'] } } }), 'array');
  assert.equal(messagePayloadMode({ properties: {} }), 'array');
  const stringOnly = tool('mcp__snowluma__qq_send_message', {
    key: { type: 'string' }, token: { type: 'string' }, messages: { type: 'string' }
  }, ['key', 'token', 'messages']);
  const entry = buildToolExposure([stringOnly], { enabled: true, turn }).find(item => item.name === 'send');
  const bound = entry.bindArgs({ text: ['一条', '另一条'] });
  assert.equal(bound.messages, JSON.stringify(['一条', '另一条']), 'legacy string-only tool must receive JSON text');
  assert.equal(typeof bound.messages, 'string');
});

check('requestId 由可信来源绑定，模型不能换标识绕过防重', () => {
  const image = byName('qq_send_image');
  assert.equal(image.bindArgs({ url: 'https://public.invalid/a.png', requestId: 'bypass' }).requestId, 'm-1');
  assert.equal(image.bindArgs({ url: 'https://public.invalid/a.png' }).requestId, 'm-1');
  const noSource = { ...turn, requestMessageId: null };
  const exposed = buildToolExposure(definitions, { enabled: true, turn: noSource }).find(item => item.name === 'qq_send_image');
  throwsMessage(() => exposed.bindArgs({ url: 'https://public.invalid/a.png' }), /可信的原消息ID/);
});

check('开关打开但缺可信上下文时仍然简化工具面，调用一律拒绝', () => {
  const exposed = buildToolExposure(definitions, { enabled: true, turn: null });
  assert.ok(exposed.some(entry => entry.name === 'send'), 'tools stay simplified');
  const send = exposed.find(entry => entry.name === 'send');
  for (const field of ['key', 'token', 'throughSeq']) assert.equal(field in send.parameters.properties, false);
  throwsMessage(() => send.bindArgs({ text: 'hi' }), new RegExp(SIMPLE_CONTEXT_ERROR));
  const legacy = exposed.find(entry => entry.name === 'mcp__snowluma__qq_send_message');
  throwsMessage(() => legacy.bindArgs({ messages: ['hi'], key: 'group:999', token: 'forged' }), new RegExp(SIMPLE_CONTEXT_ERROR));
});

check('读未读/等待返回的新快照只按返回的 readThroughSeq 前进', () => {
  assert.equal(isCursorSourceTarget('qq_get_unread_messages'), true);
  assert.equal(isCursorSourceTarget('qq_wait_for_messages'), true);
  assert.equal(isCursorSourceTarget('qq_get_recent_messages'), true);
  assert.equal(isCursorSourceTarget('qq_send_message'), false);
  const live = { ...turn };
  assert.equal(advanceTurnCursor(live, 9), true);
  assert.equal(live.readThroughSeq, 9);
  assert.equal(advanceTurnCursor(live, 8), false, 'cursor never goes backwards');
  assert.equal(live.readThroughSeq, 9);
  assert.equal(advanceTurnCursor(live, 9999), true, 'trusted upstream value; the bridge re-validates at execution');
  assert.equal(advanceTurnCursor(live, -1), false);
  assert.equal(advanceTurnCursor(live, '9'), false);
  assert.equal(advanceTurnCursor(null, 9), false);
  const send = byName('send');
  assert.equal(send.bindArgs({ text: 'x' }).throughSeq, 7, 'other turns keep their own cursor');
  assert.equal(bindSimpleArguments('qq_send_message', { text: 'x' }, live).throughSeq, 9999);
});

check('普通文字回复参数简化：text 字符串/数组、JSON 字符串数组与引用', () => {
  assert.deepEqual(normalizeMessageValue('你好'), ['你好']);
  assert.deepEqual(normalizeMessageValue(['一条', '另一条']), ['一条', '另一条']);
  assert.deepEqual(normalizeMessageValue('["一条","另一条"]'), ['一条', '另一条']);
  assert.deepEqual(normalizeMessageValue('"你好"'), ['你好']);
  assert.deepEqual(normalizeMessageValue('   '), []);
  throwsMessage(() => normalizeMessageValue(42), /字符串或字符串数组/);
  const bind = byName('send').bindArgs;
  assert.deepEqual(bind({ text: '你好' }).messages, ['你好']);
  assert.deepEqual(bind({ text: ['a', 'b'] }).messages, ['a', 'b']);
  assert.equal(bind({ text: 'x', reply_to: '7' }).replyToMessageId, '7');
});

check('可信上下文覆盖模型传入的 key/token/throughSeq（跨群/伪造令牌/超前水位）', () => {
  const args = byName('send').bindArgs({ text: '你好', key: 'group:999', token: 'forged', throughSeq: 9999 });
  assert.equal(args.key, 'group:456');
  assert.equal(args.token, 'secret-token-0123456789');
  assert.equal(args.throughSeq, 7);
  assert.deepEqual(args.messages, ['你好']);
});

check('只确认本次展示过的水位，重复调用不会推进水位', () => {
  const bind = byName('mark_read').bindArgs;
  assert.equal(bind({}).throughSeq, 7);
  assert.equal(bind({ throughSeq: 0 }).throughSeq, 7);
  assert.equal(bind({ throughSeq: 9999 }).throughSeq, 7);
  assert.equal(bind({}).throughSeq, bind({}).throughSeq);
  throwsMessage(() => bindSimpleArguments('qq_mark_read', {}, { ...turn, readThroughSeq: null }), /可信的已读水位/);
});

check('缺少可信上下文时 fail closed（不回退到模型给的 key）', () => {
  throwsMessage(() => bindSimpleArguments('qq_send_message', { text: 'hi', key: 'group:999', token: 'forged' }, null), new RegExp(SIMPLE_CONTEXT_ERROR));
  throwsMessage(() => buildToolExposure(definitions, { enabled: true, turn: null }).find(entry => entry.name === 'send').bindArgs({ text: 'hi' }),
    new RegExp(SIMPLE_CONTEXT_ERROR));
  assert.equal(sanitizeTurnContext(null), null);
  assert.equal(sanitizeTurnContext({ key: 'group:0', token: 'x' }), null);
  assert.equal(sanitizeTurnContext({ key: 'channel:1', token: 'x' }), null);
  assert.equal(sanitizeTurnContext({ key: 'group:456', token: '' }), null);
  assert.equal(sanitizeTurnContext({ key: 'group:456', token: 'x'.repeat(600) }), null);
  assert.deepEqual(sanitizeTurnContext({ key: ' group:456 ', token: ' tok ', readThroughSeq: 3, mode: 'reserved2', kind: 'chat-wake', sourceId: 'wake:9', requestMessageId: 9 }),
    { key: 'group:456', token: 'tok', readThroughSeq: 3, mode: 'reserved2', kind: 'chat-wake', sourceId: 'wake:9', requestMessageId: '9' });
  // 内部回合必须显式标注；缺失或非法 kind 一律不纠正（不猜成聊天唤醒）。
  assert.equal(sanitizeTurnContext({ key: 'group:456', token: 'tok' }).kind, null);
  assert.equal(sanitizeTurnContext({ key: 'group:456', token: 'tok', kind: 'chat' }).kind, null);
  assert.equal(sanitizeTurnContext({ key: 'group:456', token: 'tok', kind: 'chat-wake', sourceId: 'x'.repeat(200) }).sourceId, null);
  assert.equal(sanitizeTurnContext({ key: 'group:456', token: 'tok', kind: 'silent' }).kind, 'silent');
});

check('引用/@ 的自然参数映射到底层协议', () => {
  const bind = byName('send').bindArgs;
  const args = bind({ text: '回你', reply_to: '-42', at: 12345 });
  assert.equal(args.replyToMessageId, '-42');
  assert.equal(args.atUserId, 12345);
  assert.equal('reply_to' in args, false);
  assert.equal('at' in args, false);
  assert.equal(bind({ text: 'x', replyTo: '7' }).replyToMessageId, '7');
  throwsMessage(() => bind({}), /text/);
  throwsMessage(() => bind({ text: 'x', messages: ['y'] }), /只能传一个/);
});

check('媒体/记忆工具保留自身参数，只去掉 key/token/throughSeq', () => {
  const image = byName('qq_send_image');
  assert.ok(image.parameters.properties.url);
  assert.equal('key' in image.parameters.properties, false);
  assert.equal('token' in image.parameters.properties, false);
  const bound = image.bindArgs({ url: 'https://public.invalid/a.png' });
  assert.equal(bound.requestId, 'm-1');
  assert.equal(bound.key, 'group:456');
  assert.equal(bound.token, 'secret-token-0123456789');
  assert.equal(bound.throughSeq, 7);
  const explicit = image.bindArgs({ url: 'https://public.invalid/a.png', requestId: 'other' });
  assert.equal(explicit.requestId, 'm-1', 'model-supplied requestId must not bypass trusted dedup');
  const memory = byName('qq_memory_append');
  assert.ok(memory.parameters.properties.content);
  assert.equal('key' in memory.parameters.properties, false);
  // 历史名保留为宽松兼容入口，绑定行为相同。
  assert.deepEqual(byName('mcp__snowluma__qq_send_image').bindArgs({ url: 'https://public.invalid/a.png' }),
    image.bindArgs({ url: 'https://public.invalid/a.png' }));
});

check('DSH 管理与老式发送工具不被改写（授权仍由运行时控制）', () => {
  const dsh = byName('dsh_request');
  assert.equal(dsh.parameters, definitions[definitions.length - 1].parameters);
  assert.equal(dsh.bindArgs, null);
  const legacy = byName('mcp__snowluma__qq_reply');
  assert.equal(legacy.parameters, definitions[definitions.length - 2].parameters);
  assert.equal(legacy.bindArgs, null);
  const withoutKey = buildToolExposure([definitions[definitions.length - 2]], { enabled: true, turn });
  assert.equal(withoutKey.some(entry => entry.target === 'qq_reply'), false);
});

check('别名冲突不覆盖已有工具，未知工具原样保留', () => {
  const collision = [...definitions, tool('send', { note: { type: 'string' } }, [])];
  const exposed = buildToolExposure(collision, { enabled: true, turn });
  const sends = exposed.filter(entry => entry.name === 'send');
  assert.equal(sends.length, 1, 'existing send must not be duplicated or replaced');
  assert.equal(sends[0].target, null);
  assert.equal(sends[0].parameters, collision.at(-1).parameters);
  const unknown = tool('totally_unknown_tool', { anything: { type: 'string' } }, []);
  const kept = buildToolExposure([unknown], { enabled: true, turn });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].name, 'totally_unknown_tool');
  assert.equal(kept[0].parameters, unknown.parameters);
});

check('pruneToolSchema 不动原对象，只放宽可自动绑定的必填项', () => {
  const original = definitions[0].parameters;
  const pruned = pruneToolSchema('qq_send_message', original);
  assert.notEqual(pruned, original);
  assert.ok(original.properties.key, 'original schema must stay untouched');
  assert.deepEqual(pruned.required ?? [], []);
  assert.ok(pruned.properties.text);
});

check('工具调用记录会脱敏 key/token', () => {
  const redacted = redactToolArgumentsForRecord({ text: 'hi', key: 'group:456', token: 'secret' });
  assert.deepEqual(redacted, { text: 'hi', key: '***', token: '***' });
});

check('纯文本无动作才纠正，且有上限', () => {
  const base = { actionAttempted: false, hadToolError: false, usedThisTurn: false, text: '草稿', streak: 0, maxStreak: 2, callsLeft: 3 };
  assert.equal(shouldOfferFormatCorrection(base), true);
  assert.equal(shouldOfferFormatCorrection({ ...base, actionAttempted: true }), false);
  assert.equal(shouldOfferFormatCorrection({ ...base, hadToolError: true }), false);
  assert.equal(shouldOfferFormatCorrection({ ...base, usedThisTurn: true }), false);
  assert.equal(shouldOfferFormatCorrection({ ...base, text: '   ' }), false);
  assert.equal(shouldOfferFormatCorrection({ ...base, text: undefined }), false);
  assert.equal(shouldOfferFormatCorrection({ ...base, streak: 2 }), false);
  assert.equal(shouldOfferFormatCorrection({ ...base, streak: 5 }), false);
  assert.equal(shouldOfferFormatCorrection({ ...base, callsLeft: 0 }), false);
  assert.equal(shouldOfferFormatCorrection({ ...base, callsLeft: 1 }), true);
  assert.ok(FORMAT_CORRECTION_TEXT.includes('send('));
  assert.ok(SIMPLE_TOOLS_PROMPT_NOTE.includes('mark_read'));
});

console.log(`${checks} simple-tool checks passed; no QQ or model requests.`);
