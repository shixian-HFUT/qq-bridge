// Pi 运行时 × 工具简写适配的隔离回归：用真实 Pi SDK + 本地假 provider，
// 不连 QQ、不读生产配置、不消耗真实模型额度。
//
// 覆盖：短名工具暴露与参数裁剪、可信绑定（跨群/伪造令牌/超前水位）、
// 长名兼容、未知工具不被改写、纯文本有界纠正、失败/未知发送不触发纠正、
// 媒体/记忆/DSH 工具保留、关闭开关后行为完全不变。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PiApiClient } from '../src/pi-client.js';
import { unwrap } from '../src/dsh-client.js';
import { terminalToolResult } from '../src/pi-context.js';
import { SIMPLE_TOOLS_PROMPT_NOTE, SIMPLE_CONTEXT_ERROR, sanitizeTurnContext } from '../src/simple-tools.js';

const project = fileURLToPath(new URL('..', import.meta.url));
let checks = 0;
async function acheck(name, fn) { await fn(); checks++; console.log('PASS', name); }

// ── 假 provider：按剧本返回文本或工具调用，并记录每个请求体 ──────────────
const requests = [];
let plan = [];
let callSeq = 0;
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  assert.equal(req.headers.authorization, 'Bearer fixture-only-no-real-key');
  const step = plan.shift();
  const emit = (delta, finish) => {
    res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  };
  if (!step) { emit({ role: 'assistant', content: '' }, 'stop'); return; }
  if (step.type === 'text') { emit({ role: 'assistant', content: step.text }, 'stop'); return; }
  const calls = (step.calls ?? [step]).map(call => ({
    index: callSeq, id: 'call_' + (++callSeq), type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }
  }));
  emit({ role: 'assistant', tool_calls: calls }, 'tool_calls');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pi-simple-'));
const clients = [];
const config = {
  provider: 'apimart', model: 'qwen3.8-flash', baseURL: `http://127.0.0.1:${server.address().port}/v1`,
  apiKeyEnv: 'QQ_PI_SIMPLE_KEY', credentialSource: 'file', credentialFile: path.join(temp, 'fixture.env'),
  maxTokens: 256, thinkingLevel: 'off', simpleTools: true
};
process.env.QQ_PI_SIMPLE_KEY = 'fixture-inherited-key';
fs.writeFileSync(config.credentialFile, 'QQ_PI_SIMPLE_KEY=fixture-only-no-real-key\n');

// ── 假 MCP 工具：schema 与 mcp-snowluma-safe.js 的关键形状一致 ─────────────
const executions = [];
const str = { type: 'string' };
const idSchema = { anyOf: [{ type: 'string' }, { type: 'number' }] };
function tool(name, properties, required, outcome = () => ({ ok: true })) {
  return {
    name, label: name, description: `${name} fixture`,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    execute: async (_callId, args) => {
      executions.push({ name, args });
      const data = outcome(args);
      const content = [{ type: 'text', text: JSON.stringify(data) }];
      const isError = data.ok === false;
      // Mirror the real MCP wrapper so terminal (send/mark_read) semantics are
      // exercised rather than assumed.
      const result = { content, details: { bridgeTerminal: terminalToolResult(name, { content, isError }, args) }, isError };
      return result;
    }
  };
}
const sendTool = tool('mcp__snowluma__qq_send_message', {
  key: str, token: str, messages: { anyOf: [{ type: 'string' }, { type: 'array', items: str }] },
  throughSeq: { type: 'integer' }, memoryOps: { type: 'array', items: { type: 'object' } },
  replyToMessageId: idSchema, atUserId: idSchema
}, ['key', 'token', 'messages'], () => ({ ok: true, turnComplete: true, failed: 0, sent: 1 }));
const markReadTool = tool('mcp__snowluma__qq_mark_read', { key: str, token: str, throughSeq: { type: 'integer' } }, ['key', 'token'], () => ({ ok: true, unreadCount: 0 }));
// read 每次返回一个“真正交给模型”的水位；用来验证边界只按返回值前进。
let cursorResults = [];
const unreadTool = tool('mcp__snowluma__qq_get_unread_messages', { key: str, token: str, afterSeq: { type: 'integer' } }, ['key', 'token'],
  () => ({ ok: true, messages: [], readThroughSeq: cursorResults.length ? cursorResults.shift() : 9 }));
const waitTool = tool('mcp__snowluma__qq_wait_for_messages', { key: str, token: str, purpose: str, timeoutMs: { type: 'number' } }, ['key', 'token'], () => ({ ok: true, newMessages: [], readThroughSeq: 12 }));
const imageTool = tool('mcp__snowluma__qq_send_image', {
  key: str, token: str, requestId: str, url: str, throughSeq: { type: 'integer' }
}, ['key', 'token', 'requestId'], () => ({ ok: true, sent: 'sent' }));
const memoryTool = tool('mcp__snowluma__qq_memory_append', { key: str, token: str, content: str }, ['key', 'token', 'content'], () => ({ ok: true }));
const dshTool = tool('dsh_request', { request: str }, ['request'], () => ({ ok: true }));
const webSearchTool = tool('mcp__web-search-safe__web_search', { query: str }, ['query'], () => ({ ok: true }));
const generateTool = tool('mcp__snowluma__qq_generate_image', {
  key: str, token: str, requestId: str, prompt: str
}, ['key', 'token', 'requestId', 'prompt'], () => ({ ok: true, jobId: 'job-1', status: 'running' }));
const fixtureTools = [sendTool, markReadTool, unreadTool, waitTool, imageTool, generateTool, memoryTool, dshTool];

const turn = { key: 'group:456', token: 'fixture-agent-token-0123456789', mode: 'reserved2', kind: 'chat-wake',
  sourceId: 'wake:1', readThroughSeq: 7, requestMessageId: 'm-1' };

function client(overrides = {}) {
  const instance = new PiApiClient({ root: temp, config, tools: fixtureTools, rolePrompt: () => 'fixture persona',
    ...overrides });
  clients.push(instance);
  return instance;
}
async function create(instance) {
  const workspace = unwrap(await instance.workspace.create({ path: path.join(temp, 'agents') }), 'workspace').workspace;
  return unwrap(await instance.sessions.create({ workspaceId: workspace.workspaceId, agentPreset: 'qq-chat-v2' }), 'create').sessionId;
}
async function prompt(instance, sessionId, text, turnContext = turn) {
  unwrap(await instance.sessions.prompt({ sessionId, content: [{ type: 'text', text }], turnContext }), 'prompt');
  await instance.loadSession(sessionId).runPromise;
  const session = instance.loadSession(sessionId);
  assert.equal(session.records.at(-1)?.data?.reason?.kind, 'completed', session.records.at(-1)?.data?.reason?.error?.message);
  return session;
}
const toolNames = body => (body.tools ?? []).map(entry => entry.function?.name ?? entry.name);
const toolByName = (body, name) => (body.tools ?? []).find(entry => (entry.function?.name ?? entry.name) === name);

try {
  fs.mkdirSync(path.join(temp, 'runtime', 'pi'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'runtime', 'pi', 'package.json'), '{"type":"module"}');
  // The sandbox denies creating junctions in the OS temp dir, so the runtime SDK
  // entry re-exports the pinned packages by absolute file URL instead of copying
  // or linking dependencies.
  const sdkEntry = path.join(temp, 'runtime', 'pi', 'sdk.js');
  const piCore = pathToFileURL(path.join(project, 'runtime', 'pi', 'node_modules', '@earendil-works', 'pi-agent-core', 'dist', 'index.js')).href;
  const piModels = pathToFileURL(path.join(project, 'runtime', 'pi', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'models.js')).href;
  const piApi = pathToFileURL(path.join(project, 'runtime', 'pi', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-completions.lazy.js')).href;
  fs.writeFileSync(sdkEntry, [
    `export { Agent } from ${JSON.stringify(piCore)};`,
    `export { createModels } from ${JSON.stringify(piModels)};`,
    `export { openAICompletionsApi } from ${JSON.stringify(piApi)};`,
    ''
  ].join('\n'));
  const presetDir = path.join(temp, 'dsh', 'agent-presets', 'qq-chat-v2');
  fs.mkdirSync(presetDir, { recursive: true });
  fs.writeFileSync(path.join(presetDir, 'agent.cordis.yml'), '- id: persona\n  config:\n    prefix: fixture safe preset\n');

  const instance = client();
  await instance.initialize();
  const sessionId = await create(instance);

  // 1) 普通文字回复只需 send(text=...) + 可信绑定（发送成功即终结回合，只花一次请求）
  plan = [{ type: 'call', name: 'send', args: { text: '你好' } }];
  const beforeSend = executions.length;
  const beforeRequests = requests.length;
  let session = await prompt(instance, sessionId, '群友：在吗');
  const sent = executions[beforeSend];  await acheck('短名 send(text) 一次模型请求就完成发送', () => {
    assert.equal(requests.length - beforeRequests, 1, 'terminal send must end the turn without another request');
    assert.equal(sent.name, 'mcp__snowluma__qq_send_message');
    assert.deepEqual(sent.args.messages, ['你好']);
    assert.equal(sent.args.key, 'group:456');
    assert.equal(sent.args.token, turn.token);
    assert.equal(sent.args.throughSeq, 7);
    const first = requests.at(-1);
    assert.ok(toolNames(first).includes('send'), 'short name must be exposed');
    assert.ok(toolNames(first).includes('mcp__snowluma__qq_send_message'), 'historical long name must stay callable');
    const short = toolByName(first, 'send');
    const long = toolByName(first, 'mcp__snowluma__qq_send_message');
    for (const entry of [short, long]) {
      const properties = entry.function?.parameters?.properties ?? entry.parameters?.properties ?? {};
      for (const field of ['key', 'token', 'throughSeq']) assert.equal(field in properties, false, `${entry.function?.name ?? entry.name} exposes ${field}`);
    }
    assert.ok(JSON.stringify(first).includes('工具简写'), 'prompt note should teach short names');
    const calls = session.records.filter(record => record.type === 'tool/call');
    assert.equal(calls.at(-1).data.name, 'mcp__snowluma__qq_send_message', 'records keep the canonical name for bridge send detection');
    assert.equal('token' in calls.at(-1).data.arguments, false, 'the shortcut never makes the model supply a token');
  });

  // 2) 模型传的跨群 key / 伪造 token / 超前水位一律被覆盖
  plan = [{ type: 'call', name: 'send', args: { text: ['一', '二'], key: 'group:999', token: 'forged', throughSeq: 9999 } }];
  const beforeForged = executions.length;
  session = await prompt(instance, sessionId, '群友：发两条');
  await acheck('跨会话/伪造令牌/超前水位不能生效', () => {
    const bound = executions[beforeForged];
    assert.deepEqual(bound.args.messages, ['一', '二']);
    assert.equal(bound.args.key, 'group:456');
    assert.equal(bound.args.token, turn.token);
    assert.equal(bound.args.throughSeq, 7);
    const recorded = session.records.filter(record => record.type === 'tool/call').at(-1);
    assert.equal(recorded.data.arguments.token, '***', 'forged token must not be archived');
    assert.equal(recorded.data.arguments.key, '***');
  });

  // 3) 历史长名仍可用，text 也能自动适配
  plan = [{ type: 'call', name: 'mcp__snowluma__qq_send_message', args: { text: '长名也行', reply_to: '-42' } }];
  const beforeLong = executions.length;
  await prompt(instance, sessionId, '群友：用旧名字');
  await acheck('历史长名兼容且引用参数被适配', () => {
    const bound = executions[beforeLong];
    assert.deepEqual(bound.args.messages, ['长名也行']);
    assert.equal(bound.args.replyToMessageId, '-42');
    assert.equal(bound.args.token, turn.token);
  });

  // 3b) 私聊路径与群聊走同一套绑定，没有私聊专属分支
  const privateTurn = { ...turn, key: 'private:123', token: 'fixture-private-token-0123456789', sourceId: 'wake:3' };
  plan = [{ type: 'call', name: 'send', args: { text: '私聊回复' } }];
  const beforePrivate = executions.length;
  await prompt(instance, sessionId, '私聊：在吗', privateTurn);
  await acheck('私聊 send 同样一次请求完成并绑定私聊 key/token', () => {
    const bound = executions[beforePrivate];
    assert.deepEqual(bound.args.messages, ['私聊回复']);
    assert.equal(bound.args.key, 'private:123');
    assert.equal(bound.args.token, privateTurn.token);
    assert.equal(bound.args.throughSeq, 7);
  });

  // 4) 未知名称不会被改写成有副作用的调用
  plan = [{ type: 'call', name: 'send_message', args: { text: '不该发出去' } }, { type: 'text', text: 'done' }];
  const beforeUnknown = executions.length;
  session = await prompt(instance, sessionId, '群友：拼错工具名');
  await acheck('拼错的工具名只得到“未找到”，不会触发发送', () => {
    assert.equal(executions.length, beforeUnknown);
    const result = session.records.filter(record => record.type === 'tool/result').at(-1);
    assert.equal(result.data.message.isError, true);
    assert.equal(session.records.some(record => record.type === 'turn/correction'), false);
  });

  // 5) 只输出文字 → 一次有界纠正，随后可正常发送
  executions.length = 0;
  plan = [{ type: 'text', text: '在的呀' }, { type: 'call', name: 'send', args: { text: '在的呀' } }];
  const beforeCorrection = requests.length;
  session = await prompt(instance, sessionId, '群友：你怎么不回');
  await acheck('纯文本回合得到一次格式纠正并转成发送', () => {
    assert.equal(requests.length - beforeCorrection, 2);
    const followUp = requests[beforeCorrection + 1].messages.at(-1);
    assert.equal(followUp.role, 'user');
    assert.match(JSON.stringify(followUp.content), /格式提醒/);
    const correction = session.records.filter(record => record.type === 'turn/correction');
    assert.equal(correction.length, 1);
    assert.equal(executions.filter(entry => entry.name === 'mcp__snowluma__qq_send_message').length, 1);
    assert.equal(session.simpleCorrections.streak, 0, 'a successful action resets the streak');
  });

  // 6) 纠正不会无限循环；预算按来源收敛，新来源重新获得一次有界机会
  plan = [{ type: 'text', text: '草稿一' }, { type: 'text', text: '草稿二' }];
  let before = requests.length;
  await prompt(instance, sessionId, '群友：第一轮');
  await acheck('纠正只在同一回合内用一次', () => assert.equal(requests.length - before, 2));
  plan = [{ type: 'text', text: '草稿三' }, { type: 'text', text: '草稿四' }];
  before = requests.length;
  session = await prompt(instance, sessionId, '群友：第二轮');
  await acheck('连续第二次仍会纠正，但同一来源第三轮起暂停', async () => {
    assert.equal(requests.length - before, 2);
    assert.equal(session.simpleCorrections.streak, 2);
  });
  plan = [{ type: 'text', text: '草稿五' }];
  before = requests.length;
  await prompt(instance, sessionId, '群友：第三轮');
  await acheck('同一来源纠正额度用尽后不再额外加模型请求', () => assert.equal(requests.length - before, 1));
  plan = [{ type: 'text', text: '新@的草稿' }, { type: 'call', name: 'send', args: { text: '来了' } }];
  before = requests.length;
  const correctionsBefore = instance.loadSession(sessionId).records.filter(record => record.type === 'turn/correction').length;
  const freshSource = { ...turn, sourceId: 'wake:2' };
  session = await prompt(instance, sessionId, '群友：@你', freshSource);
  await acheck('新来源（新真实@）重新获得一次有界纠正机会', () => {
    assert.equal(requests.length - before, 2);
    assert.equal(session.simpleCorrections.source, 'wake:2');
    assert.equal(session.records.filter(record => record.type === 'turn/correction').length, correctionsBefore + 1);
  });

  // 6b) 内部摘要/后台回合（silent/internal）永远不纠正成发送或已读
  for (const kind of ['silent', 'internal']) {
    plan = [{ type: 'text', text: '内部回合的文字' }];
    before = requests.length;
    const internalBefore = instance.loadSession(sessionId).records.filter(record => record.type === 'turn/correction').length;
    const internalTurn = { ...turn, kind, sourceId: null };
    session = await prompt(instance, sessionId, `系统：${kind}`, internalTurn);
    await acheck(`${kind} 回合不触发格式纠正`, () => {
      assert.equal(requests.length - before, 1, 'no follow-up request for internal turns');
      assert.equal(session.records.filter(record => record.type === 'turn/correction').length, internalBefore);
    });
  }

  // 6c) 历史 pendingImageJobs 不阻断无关新聊天；只有本轮真正继续的任务才算
  const jobClient = client({ tools: [sendTool, generateTool] });
  const jobId = await create(jobClient);
  const withOldJob = jobClient.loadSession(jobId);
  withOldJob.pendingImageJobs = { 'legacy-job': { lastQueryAt: 0 } };
  jobClient.saveSession(withOldJob);
  plan = [{ type: 'call', name: 'send', args: { text: '旧任务不影响这轮' } }];
  before = requests.length;
  await prompt(jobClient, jobId, '群友：在吗');
  await acheck('历史生图任务不阻止新回合正常终结', () => assert.equal(requests.length - before, 1));
  plan = [{ type: 'text', text: '草稿' }, { type: 'call', name: 'send', args: { text: '补发' } }];
  before = requests.length;
  await prompt(jobClient, jobId, '群友：回我');
  await acheck('历史生图任务不阻断无关聊天的格式纠正', () => assert.equal(requests.length - before, 2));
  plan = [{ type: 'call', name: 'qq_generate_image', args: { prompt: '画一只猫' } }, { type: 'text', text: '画好了' }];
  before = requests.length;
  const jobCorrectionsBefore = jobClient.loadSession(jobId).records.filter(record => record.type === 'turn/correction').length;
  const jobExecutions = executions.length;
  session = await prompt(jobClient, jobId, '群友：画图');
  await acheck('本轮真正在继续的生图任务仍然抑制纠正', () => {
    assert.equal(requests.length - before, 2);
    assert.equal(executions[jobExecutions].args.requestId, 'm-1');
    assert.equal(session.records.filter(record => record.type === 'turn/correction').length, jobCorrectionsBefore);
  });

  // 7) 发送失败/结果未知不会触发纠正，也不会卡住新聊天
  executions.length = 0;
  const failing = [tool('mcp__snowluma__qq_send_message', {
    key: str, token: str, messages: { anyOf: [{ type: 'string' }, { type: 'array', items: str }] }, throughSeq: { type: 'integer' }
  }, ['key', 'token', 'messages'], () => ({ ok: false, unknown: true, error: '发送结果不明' }))];
  const failingClient = client({ tools: failing });
  const failingId = await create(failingClient);
  plan = [{ type: 'call', name: 'send', args: { text: '试试' } }, { type: 'text', text: '发送未确认' }];
  before = requests.length;
  session = await prompt(failingClient, failingId, '群友：在吗');
  await acheck('发送失败/结果未知只报告错误，不加纠正请求', () => {
    assert.equal(requests.length - before, 2);
    assert.equal(session.records.some(record => record.type === 'turn/correction'), false);
    assert.equal(session.records.filter(record => record.type === 'tool/result').at(-1).data.message.isError, true);
  });

  // 8) 裸 qq_* 名（预设里真实出现过的写法）可直接调用；mark_read 绑定水位后直接结束
  const cleanup = client({ tools: [sendTool, markReadTool, unreadTool, waitTool] });
  const cleanupId = await create(cleanup);
  plan = [{ type: 'call', name: 'qq_mark_read', args: {} }];
  before = requests.length;
  await prompt(cleanup, cleanupId, '群友：没事');
  await acheck('裸 qq_mark_read 可直接调用，绑定水位后只花一次请求', () => {
    assert.equal(requests.length - before, 1);
    assert.equal(executions.at(-1).name, 'mcp__snowluma__qq_mark_read');
    assert.equal(executions.at(-1).args.throughSeq, 7);
    assert.ok(toolNames(requests.at(-1)).includes('qq_mark_read'));
  });

  // 8b) 读未读/等待返回的新快照：后续 send/mark_read 按真正返回的 readThroughSeq 推进
  cursorResults = [9];
  plan = [{ type: 'call', name: 'read', args: { afterSeq: 0 } }, { type: 'call', name: 'send', args: { text: '看到新消息了' } }];
  before = requests.length;
  const cursorExecutions = executions.length;
  await prompt(cleanup, cleanupId, '群友：有新消息');
  await acheck('读未读后按返回的 readThroughSeq 确认已读', () => {
    assert.equal(requests.length - before, 2);
    const [readCall, sendCall] = executions.slice(cursorExecutions);
    assert.equal(readCall.name, 'mcp__snowluma__qq_get_unread_messages');
    assert.equal(readCall.args.key, 'group:456');
    assert.equal(sendCall.args.throughSeq, 9, 'cursor advances only to the returned watermark');
  });
  plan = [{ type: 'call', name: 'wait', args: { purpose: 'messages' } }, { type: 'call', name: 'qq_mark_read', args: {} }];
  const waitExecutions = executions.length;
  await prompt(cleanup, cleanupId, '群友：等待');
  await acheck('等待返回的新水位可用于收尾', () => {
    const [, mark] = executions.slice(waitExecutions);
    assert.equal(mark.name, 'mcp__snowluma__qq_mark_read');
    assert.equal(mark.args.throughSeq, 12);
  });
  cursorResults = [9, 3];
  plan = [
    { type: 'call', name: 'read', args: { afterSeq: 0 } },
    { type: 'call', name: 'read', args: { afterSeq: 9 } },
    { type: 'call', name: 'send', args: { text: '水位不倒退' } }
  ];
  const staleExecutions = executions.length;
  await prompt(cleanup, cleanupId, '群友：旧水位');
  await acheck('返回更小的水位不会让同一回合的已读边界倒退', () => {
    const calls = executions.slice(staleExecutions);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].args.throughSeq, 9);
  });

  // 9) 媒体/记忆工具保留自身参数；requestId 由可信来源覆盖；非 snowluma 工具完全不动
  const media = client({ tools: [imageTool, memoryTool, dshTool] });
  const mediaId = await create(media);
  plan = [{ type: 'call', name: 'qq_send_image', args: { url: 'https://public.invalid/a.png', requestId: 'bypass' } }, { type: 'text', text: 'done' }];
  before = requests.length;
  await prompt(media, mediaId, '群友：发图');
  await acheck('图片工具保留 url，requestId 不能被模型换成新标识', () => {
    const bound = executions.at(-1).args;
    assert.equal(bound.url, 'https://public.invalid/a.png');
    assert.equal(bound.requestId, 'm-1');
    const list = requests[before].tools.map(entry => entry.function?.name ?? entry.name);
    assert.ok(list.includes('qq_send_image'), 'media tool exposes the preset-style name');
    assert.ok(list.includes('dsh_request'), 'DSH management tool must stay available');
    const dshEntry = toolByName(requests[before], 'dsh_request');
    assert.deepEqual(dshEntry.function?.parameters?.required ?? dshEntry.parameters?.required, ['request']);
  });

  // 10) 关闭开关：清单与行为完全不变，纯文本不纠正
  const legacy = client({ config: { ...config, simpleTools: false }, tools: fixtureTools });
  const legacyId = await create(legacy);
  plan = [{ type: 'text', text: '普通回复' }];
  before = requests.length;
  session = await prompt(legacy, legacyId, '群友：在吗', null);
  await acheck('关闭开关后不暴露短名、不绑定、不纠正（默认兼容）', () => {
    assert.equal(requests.length - before, 1);
    const list = toolNames(requests.at(-1));
    assert.equal(list.includes('send'), false);
    assert.equal(list.includes('qq_send_message'), false);
    assert.ok(list.includes('mcp__snowluma__qq_send_message'));
    const longEntry = toolByName(requests.at(-1), 'mcp__snowluma__qq_send_message');
    const properties = longEntry.function?.parameters?.properties ?? longEntry.parameters?.properties ?? {};
    assert.ok('key' in properties && 'token' in properties && 'throughSeq' in properties, 'old schema must be untouched');
    assert.equal(session.records.some(record => record.type === 'turn/correction'), false);
  });

  // 11) 开关打开但缺可信上下文：简化工具面照常暴露，但调用一律拒绝（不回退旧流程）
  const noContext = client();
  const noContextId = await create(noContext);
  plan = [{ type: 'call', name: 'send', args: { text: '不该发', key: 'group:999', token: 'forged' } }, { type: 'text', text: '被拒绝' }];
  before = requests.length;
  const noContextExecutions = executions.length;
  session = await prompt(noContext, noContextId, '群友：在吗', null);
  await acheck('缺可信上下文时工具面仍简化，但调用被拒绝且不会执行', () => {
    assert.equal(requests.length - before, 2);
    assert.equal(executions.length, noContextExecutions, 'no underlying tool may run');
    const list = toolNames(requests.at(-2));
    assert.ok(list.includes('send'), 'simplified tool list must not fall back to the old flow');
    const sendEntry = toolByName(requests.at(-2), 'send');
    const properties = sendEntry.function?.parameters?.properties ?? sendEntry.parameters?.properties ?? {};
    assert.equal('key' in properties, false);
    const result = session.records.filter(record => record.type === 'tool/result').at(-1);
    assert.equal(result.data.message.isError, true);
    assert.match(JSON.stringify(result.data.message.content), /缺少可信的当轮会话上下文/);
    assert.equal(session.records.some(record => record.type === 'turn/correction'), false);
  });
  plan = [{ type: 'call', name: 'mcp__snowluma__qq_send_message', args: { messages: ['旧名也不该发'], key: 'group:999', token: 'forged' } }, { type: 'text', text: '被拒绝' }];
  const beforeHistoric = executions.length;
  session = await prompt(noContext, noContextId, '群友：旧名呢', null);
  await acheck('缺上下文时历史长名同样被拒绝（没有旧流程后门）', () => {
    assert.equal(executions.length, beforeHistoric);
    const result = session.records.filter(record => record.type === 'tool/result').at(-1);
    assert.match(JSON.stringify(result.data.message.content), /缺少可信的当轮会话上下文/);
  });

  // 12) 学习回合完全保留旧行为：无简写、无绑定、无纠正
  const learner = client({ tools: [webSearchTool, sendTool] });
  const learnerWorkspace = unwrap(await learner.workspace.create({ path: path.join(temp, 'slang-agent') }), 'workspace').workspace;
  const learnerId = unwrap(await learner.sessions.create({ workspaceId: learnerWorkspace.workspaceId, agentPreset: 'qq-chat-v2' }), 'create').sessionId;
  plan = [{ type: 'text', text: '{"entries":[]}' }];
  before = requests.length;
  unwrap(await learner.sessions.prompt({ sessionId: learnerId, content: [{ type: 'text', text: '学习资料' }], learningTask: 'slang-research', turnContext: turn }), 'prompt');
  await learner.loadSession(learnerId).runPromise;
  await acheck('学习回合仍只有搜索工具、不受简写与纠正影响', () => {
    assert.equal(requests.length - before, 1);
    const list = toolNames(requests.at(-1));
    assert.deepEqual(list, ['mcp__web-search-safe__web_search']);
    const body = requests.at(-1);
    assert.equal(JSON.stringify(body).includes('工具简写'), false);
    assert.equal(learner.loadSession(learnerId).records.some(record => record.type === 'turn/correction'), false);
  });

  // 13) 非法上下文被收敛为 null（不会进入绑定）
  await acheck('非法上下文被收敛为 null', async () => {
    const sanitized = sanitizeTurnContext({ key: 'group:456', token: 'x', readThroughSeq: -1 });
    assert.equal(sanitized.readThroughSeq, null);
    assert.ok(SIMPLE_CONTEXT_ERROR.length > 0 && SIMPLE_TOOLS_PROMPT_NOTE.includes('send('));
  });

  // 14) 真实 qq_send_message schema 的消息协议仍是数组（能收数组就不转 JSON 字符串）
  await acheck('真实 MCP schema 下 messages 保持数组', () => {
    const send = executions.find(entry => entry.name === 'mcp__snowluma__qq_send_message');
    assert.ok(Array.isArray(send.args.messages));
  });

  console.log(`${checks} Pi simple-tool checks passed; no real provider or QQ requests.`);
} finally {
  await Promise.allSettled(clients.map(instance => instance.dispose()));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  delete process.env.QQ_PI_SIMPLE_KEY;
  fs.rmSync(temp, { recursive: true, force: true });
}
