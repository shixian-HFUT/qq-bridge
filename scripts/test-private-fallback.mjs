// 私聊「媒体发送确定失败 + 无可见回复」兜底的隔离回归。
//
// 两部分：
//   1) 纯函数断言：失败分类（确定未发 / 未知 / 重复 / 部分成功 / 成功）、
//      生效条件（私聊 chat-wake / 群聊 / 内部回合 / 开关关闭 / 无上下文 / 取消 /
//      生图任务进行中）、桥接侧运行时放行判定。
//   2) 真实 Pi SDK + 本地假 provider + 假工具执行器：整轮跑完后再判定，
//      验证「失败 + 同批 mark_read + 空回复」只提示一次且不额外请求模型，
//      以及先成功后失败 / 未知 / 重复 / 部分成功 / 取消 / 静默 / 群聊 / 开关关闭
//      都不提示、fallback 失败不重试、只有展示过的水位被确认。
//
// 不连 QQ、不读生产配置/状态、不消耗真实模型额度。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PiApiClient } from '../src/pi-client.js';
import { unwrap } from '../src/dsh-client.js';
import { terminalToolResult } from '../src/pi-context.js';
import {
  PRIVATE_MEDIA_FALLBACK_TEXT,
  createPrivateMediaTurnFacts,
  notePrivateFallbackToolResult,
  shouldNotifyPrivateMediaFailure,
  evaluatePrivateFallbackDelivery
} from '../src/private-fallback.js';

const project = fileURLToPath(new URL('..', import.meta.url));
let checks = 0;
async function acheck(name, fn) { await fn(); checks++; console.log('PASS', name); }
function check(name, fn) { fn(); checks++; console.log('PASS', name); }

// ── 1) 纯函数：结果分类与生效条件 ────────────────────────────────────────────
const definiteFailure = { ok: false, unknown: false, duplicate: false, retryable: true, error: 'file too large' };

check('确定未发送的图片失败被记为媒体确定失败', () => {
  const facts = createPrivateMediaTurnFacts();
  notePrivateFallbackToolResult(facts, 'mcp__snowluma__qq_send_image', { data: definiteFailure });
  assert.equal(facts.mediaDefiniteFailure, true);
  assert.equal(facts.mediaUnclear, false);
  assert.equal(facts.visibleSucceeded, false);
});

check('结果未知 / 重复 / 部分成功 / 成功都按“不能补发”处理', () => {
  const unknown = createPrivateMediaTurnFacts();
  notePrivateFallbackToolResult(unknown, 'qq_send_image', { data: { ok: false, unknown: true, retryable: false } });
  assert.equal(unknown.mediaDefiniteFailure, false);
  assert.equal(unknown.mediaUnclear, true);

  const duplicate = createPrivateMediaTurnFacts();
  notePrivateFallbackToolResult(duplicate, 'qq_send_image', { data: { ok: false, duplicate: true, unknown: false } });
  assert.equal(duplicate.mediaDefiniteFailure, false, 'duplicate must never authorize a notice');

  const partial = createPrivateMediaTurnFacts();
  notePrivateFallbackToolResult(partial, 'mcp__snowluma__qq_send_message', { data: { ok: true, sent: 1, failed: 1, turnComplete: false } });
  assert.equal(partial.visibleSucceeded, true, 'a partially delivered reply already reached the user');

  const success = createPrivateMediaTurnFacts();
  notePrivateFallbackToolResult(success, 'mcp__snowluma__qq_send_image', { data: { ok: true, sent: 1, failed: 0 } });
  assert.equal(success.visibleSucceeded, true);
  assert.equal(success.mediaUnclear, false, 'a successful send must not look ambiguous');
});

check('非 JSON / 网络错误类失败不会被当成“确定未发送”', () => {
  const facts = createPrivateMediaTurnFacts();
  notePrivateFallbackToolResult(facts, 'mcp__snowluma__qq_send_image', { data: null });
  assert.equal(facts.mediaDefiniteFailure, false);
  assert.equal(facts.mediaUnclear, true);
});

check('mark_read / read / wake 等非发送工具不参与“可见回复”判定', () => {
  const facts = createPrivateMediaTurnFacts();
  notePrivateFallbackToolResult(facts, 'qq_mark_read', { data: { ok: true, unreadCount: 0 } });
  notePrivateFallbackToolResult(facts, 'qq_get_unread_messages', { data: { ok: true, messages: [] } });
  notePrivateFallbackToolResult(facts, 'qq_set_wake_config', { data: { ok: true } });
  assert.equal(facts.visibleSucceeded, false);
  assert.equal(facts.sendUnclear, false);
});

check('只有私聊 chat-wake + 确定媒体失败 + 无可见回复才提示', async () => {
  const facts = createPrivateMediaTurnFacts();
  notePrivateFallbackToolResult(facts, 'qq_send_image', { data: definiteFailure });
  const base = {
    notifierAvailable: true, backend: 'pi', simpleTools: true, mode: 'reserved2', kind: 'chat-wake',
    key: 'private:123', requestMessageId: 'm-1'
  };
  assert.equal(shouldNotifyPrivateMediaFailure(facts, base).notify, true);
  const reject = (patch, reason) => {
    const fresh = createPrivateMediaTurnFacts();
    notePrivateFallbackToolResult(fresh, 'qq_send_image', { data: definiteFailure });
    const result = shouldNotifyPrivateMediaFailure(fresh, { ...base, ...patch });
    assert.equal(result.notify, false, `expected no notice for ${reason}`);
    assert.equal(result.reason, reason);
  };
  reject({ key: 'group:456' }, 'not-private');
  reject({ kind: 'silent' }, 'kind');
  reject({ kind: 'internal' }, 'kind');
  reject({ kind: null }, 'kind');
  reject({ mode: 'chat' }, 'mode');
  reject({ simpleTools: false }, 'switch-off');
  reject({ backend: 'dsh' }, 'backend');
  reject({ requestMessageId: null }, 'no-user-message');
  reject({ learningTurn: true }, 'learning');
  reject({ turnFailed: true }, 'turn-failed');
  reject({ cancelled: true }, 'cancelled');
  reject({ disposed: true }, 'disposed');
  reject({ pendingMediaJobs: true }, 'pending-media-job');
  reject({ notifierAvailable: false }, 'no-notifier');
  const all = { ...base };
  assert.equal(shouldNotifyPrivateMediaFailure(null, all).notify, false);
});

check('已成功 / 不明 的发送会抑制提示', () => {
  const visible = createPrivateMediaTurnFacts();
  notePrivateFallbackToolResult(visible, 'qq_send_image', { data: definiteFailure });
  notePrivateFallbackToolResult(visible, 'qq_send_message', { data: { ok: true, sent: 1, failed: 0, turnComplete: true } });
  assert.equal(shouldNotifyPrivateMediaFailure(visible, { ...{ notifierAvailable: true, backend: 'pi', simpleTools: true, mode: 'reserved2', kind: 'chat-wake', key: 'private:123', requestMessageId: 'm-1' } }).reason, 'visible-reply');

  const unclear = createPrivateMediaTurnFacts();
  notePrivateFallbackToolResult(unclear, 'qq_send_image', { data: definiteFailure });
  notePrivateFallbackToolResult(unclear, 'qq_send_message', { data: { ok: false, error: '网络中断' } });
  assert.equal(shouldNotifyPrivateMediaFailure(unclear, { ...{ notifierAvailable: true, backend: 'pi', simpleTools: true, mode: 'reserved2', kind: 'chat-wake', key: 'private:123', requestMessageId: 'm-1' } }).reason, 'unclear-outcome');
});

check('同一回合已提示过就不再提示（至多一条）', () => {
  const facts = createPrivateMediaTurnFacts();
  notePrivateFallbackToolResult(facts, 'qq_send_image', { data: definiteFailure });
  const opts = { notifierAvailable: true, backend: 'pi', simpleTools: true, mode: 'reserved2', kind: 'chat-wake', key: 'private:123', requestMessageId: 'm-1' };
  assert.equal(shouldNotifyPrivateMediaFailure(facts, opts).notify, true);
  facts.notified = true;
  assert.equal(shouldNotifyPrivateMediaFailure(facts, opts).reason, 'already-notified');
});

check('桥接侧放行判定：模式/开关/暂停/私聊/会话/白名单/静默/限流/令牌/去重', () => {
  const base = { mode: 'reserved2', enabled: true, simpleTools: true, sendMessageEnabled: true,
    paused: false, key: 'private:123', sessionBound: true, allowed: true, silent: false,
    rateLimited: false, tokenValid: true, duplicate: false };
  assert.equal(evaluatePrivateFallbackDelivery(base).deliver, true);
  const refuse = (patch, reason) => assert.equal(evaluatePrivateFallbackDelivery({ ...base, ...patch }).reason, reason);
  refuse({ mode: 'chat' }, 'mode');
  refuse({ enabled: false }, 'disabled');
  refuse({ simpleTools: false }, 'simple-tools-off');
  refuse({ sendMessageEnabled: false }, 'send-message-off');
  refuse({ paused: true }, 'paused');
  refuse({ key: 'group:456' }, 'not-private');
  refuse({ key: 'private:0' }, 'not-private');
  refuse({ allowed: false }, 'not-allowed');
  refuse({ sessionBound: false }, 'stale-session');
  refuse({ silent: true }, 'silent');
  refuse({ rateLimited: true }, 'rate-limited');
  refuse({ tokenValid: false }, 'token-invalid');
  refuse({ duplicate: true }, 'duplicate');
  assert.equal(evaluatePrivateFallbackDelivery({ ...base, simpleTools: undefined }).reason, 'simple-tools-off', 'missing switch must fail closed');
  assert.equal(evaluatePrivateFallbackDelivery({ ...base, tokenValid: undefined }).reason, 'token-invalid', 'missing token proof must fail closed');
});

check('固定提示本身不含链接/路径/令牌字段', () => {
  assert.equal(typeof PRIVATE_MEDIA_FALLBACK_TEXT, 'string');
  assert.ok(PRIVATE_MEDIA_FALLBACK_TEXT.length > 0 && PRIVATE_MEDIA_FALLBACK_TEXT.length <= 120);
  assert.equal(/https?:\/\//.test(PRIVATE_MEDIA_FALLBACK_TEXT), false);
  assert.equal(/[A-Za-z]:\\|\/(?:home|root|users)\//i.test(PRIVATE_MEDIA_FALLBACK_TEXT), false);
});

// ── 2) 真实 Pi SDK × 假 provider × 假执行器 ─────────────────────────────────
const requests = [];
let plan = [];
let callSeq = 0;
const gates = new Map();
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  const step = plan.shift();
  const emit = (delta, finish) => {
    res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  };
  if (!step) { emit({ role: 'assistant', content: '' }, 'stop'); return; }
  if (step.gate) {
    const gate = gates.get(step.gate);
    if (gate) { gate.reached = true; await gate.promise; }
  }
  if (step.delayMs) await delay(step.delayMs);
  if (step.type === 'text') { emit({ role: 'assistant', content: step.text }, 'stop'); return; }
  const calls = (step.calls ?? [step]).map(call => ({
    index: callSeq, id: 'call_' + (++callSeq), type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }
  }));
  emit({ role: 'assistant', tool_calls: calls }, 'tool_calls');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-private-fallback-'));
const clients = [];
const config = {
  provider: 'apimart', model: 'qwen3.8-flash', baseURL: `http://127.0.0.1:${server.address().port}/v1`,
  apiKeyEnv: 'QQ_PI_FALLBACK_KEY', credentialSource: 'file', credentialFile: path.join(temp, 'fixture.env'),
  maxTokens: 256, thinkingLevel: 'off', simpleTools: true
};
process.env.QQ_PI_FALLBACK_KEY = 'fixture-inherited-key';
fs.writeFileSync(config.credentialFile, 'QQ_PI_FALLBACK_KEY=fixture-only-no-real-key\n');

const str = { type: 'string' };
const idSchema = { anyOf: [{ type: 'string' }, { type: 'number' }] };
const executions = [];

function tool(name, properties, required, run) {
  return {
    name, label: name, description: `${name} fixture`,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    execute: async (_callId, args) => {
      executions.push({ name, args });
      const data = await run(args);
      const content = [{ type: 'text', text: JSON.stringify(data) }];
      const isError = data.ok === false;
      return { content, details: { bridgeTerminal: terminalToolResult(name, { content, isError }, args) }, isError };
    }
  };
}

const AGENT_TOKEN = 'fixture-agent-token-0123456789';
function turnContext(overrides = {}) {
  return { key: 'private:123', token: AGENT_TOKEN, mode: 'reserved2', kind: 'chat-wake',
    sourceId: 'wake:1', readThroughSeq: 7, requestMessageId: 'm-1', ...overrides };
}

function makeClient({ simpleTools = true, withNotifier = true, outcomes = {} } = {}) {
  const state = {
    notified: [],
    notifierResult: { ok: true },
    notifierThrows: false,
    notifierHook: null,
    send: outcomes.send ?? { ok: true, sent: 1, failed: 0, turnComplete: false },
    image: outcomes.image ?? { ok: false, unknown: false, duplicate: false, retryable: true, error: '文件超过大小限制' },
    generate: outcomes.generate ?? { ok: true, jobId: 'job-1', status: 'running' }
  };
  const tools = [
    tool('mcp__snowluma__qq_send_message', {
      key: str, token: str, messages: { anyOf: [{ type: str }, { type: 'array', items: str }] },
      throughSeq: { type: 'integer' }, replyToMessageId: idSchema, atUserId: idSchema
    }, ['key', 'token', 'messages'], () => state.send),
    tool('mcp__snowluma__qq_send_image', {
      key: str, token: str, requestId: str, url: str, throughSeq: { type: 'integer' }
    }, ['key', 'token', 'requestId'], () => state.image),
    tool('mcp__snowluma__qq_mark_read', { key: str, token: str, throughSeq: { type: 'integer' } }, ['key', 'token'],
      () => ({ ok: true, unreadCount: 0 })),
    tool('mcp__snowluma__qq_generate_image', {
      key: str, token: str, requestId: str, prompt: str
    }, ['key', 'token', 'requestId', 'prompt'], () => state.generate)
  ];
  const instance = new PiApiClient({
    root: temp, config: simpleTools ? config : { ...config, simpleTools: false }, tools, rolePrompt: () => 'fixture persona',
    ownerTools: () => [],
    ...(withNotifier ? {
      notifyPrivateMediaFailure: async request => {
        state.notified.push(request);
        if (state.notifierHook) await state.notifierHook(request);
        if (state.notifierThrows) throw new Error('fixture notifier failure');
        return state.notifierResult;
      }
    } : {})
  });
  clients.push(instance);
  return { instance, state };
}

async function create(instance, dirName) {
  const workspace = unwrap(await instance.workspace.create({ path: path.join(temp, dirName) }), 'workspace').workspace;
  return unwrap(await instance.sessions.create({ workspaceId: workspace.workspaceId, agentPreset: 'qq-chat-v2' }), 'create').sessionId;
}

async function runTurn(client, sessionId, steps, context, { expectCompleted = true } = {}) {
  plan.push(...steps);
  const before = requests.length;
  unwrap(await client.instance.sessions.prompt({ sessionId, content: [{ type: 'text', text: '私聊：帮我发张图' }], turnContext: context }), 'prompt');
  await client.instance.loadSession(sessionId).runPromise;
  const session = client.instance.loadSession(sessionId);
  if (expectCompleted) assert.equal(session.records.at(-1)?.data?.reason?.kind, 'completed', session.records.at(-1)?.data?.reason?.error?.message);
  return { session, modelRequests: requests.length - before };
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('fixture timeout waiting for gate');
    await delay(5);
  }
}

try {
  fs.mkdirSync(path.join(temp, 'runtime', 'pi'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'runtime', 'pi', 'package.json'), '{"type":"module"}');
  // 沙箱不允许在系统临时目录建 junction，所以 SDK 入口用绝对 file URL 引用同一份锁定依赖。
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

  // 主场景客户端：失败 + 同批 mark_read + 空回复
  const main = makeClient();
  await main.instance.initialize();
  const mainId = await create(main.instance, 'agents');

  // 1) 事故形态：确定失败的图片 + 同批 mark_read + 空回复 → 只提示一次，且不加模型请求
  executions.length = 0;
  const beforeSent = main.state.notified.length;
  let result = await runTurn(main, mainId, [
    { type: 'call', calls: [
      { name: 'qq_send_image', args: { url: 'https://public.invalid/a.png' } },
      { name: 'qq_mark_read', args: {} }
    ] },
    { type: 'text', text: '' }
  ], turnContext());
  await acheck('失败+同批mark_read+空回复：补发一条固定说明且不额外请求模型', () => {
    assert.equal(main.state.notified.length - beforeSent, 1);
    assert.equal(result.modelRequests, 2, 'the fallback must not add a model request');
    const request = main.state.notified.at(-1);
    assert.equal(request.key, 'private:123');
    assert.equal(request.sessionId, mainId);
    assert.equal(request.messageId, 'm-1');
    assert.equal(request.token, AGENT_TOKEN, 'the bridge needs the trusted token for dequeue-time revalidation');
    assert.equal('throughSeq' in request, false);
    assert.equal(JSON.stringify(requests).includes(AGENT_TOKEN), false, 'the trusted token must never reach the model');
    assert.equal(JSON.stringify(result.session.records).includes(AGENT_TOKEN), false, 'the trusted token must never enter the archive');
    assert.equal(JSON.stringify(main.state.notified).includes('文件超过大小限制'), false, 'raw tool errors must not be forwarded');
  });
  await acheck('同批 mark_read 只确认展示过的水位，兜底本身不再标记已读', () => {
    const markReads = executions.filter(entry => entry.name === 'mcp__snowluma__qq_mark_read');
    assert.equal(markReads.length, 1, 'the fallback must not send another mark_read');
    assert.equal(markReads[0].args.throughSeq, 7);
    assert.equal(markReads[0].args.token, AGENT_TOKEN);
    assert.equal(executions.filter(entry => entry.name === 'mcp__snowluma__qq_send_image').at(-1).args.requestId, 'm-1');
  });

  // 2) 先成功后失败 → 不提示（用户已经看到文字）
  main.state.send = { ok: true, sent: 1, failed: 0, turnComplete: false };
  main.state.image = { ok: false, unknown: false, duplicate: false, retryable: true, error: 'file too large' };
  const beforeAfterSuccess = main.state.notified.length;
  await runTurn(main, mainId, [
    { type: 'call', calls: [{ name: 'send', args: { text: '先回你一句' } }] },
    { type: 'call', calls: [{ name: 'qq_send_image', args: { url: 'https://public.invalid/b.png' } }] },
    { type: 'text', text: '' }
  ], turnContext({ sourceId: 'wake:2' }));
  await acheck('先成功后失败：已有可见回复，不再补失败说明', () => {
    assert.equal(main.state.notified.length, beforeAfterSuccess);
  });

  // 3) 未知 / 重复 / 部分成功 → 都不提示
  for (const [label, outcome, expectation] of [
    ['结果未知', { ok: false, unknown: true, retryable: false }, 0],
    ['重复可能已发送', { ok: false, duplicate: true, unknown: false }, 0],
    ['空回复但只有确定失败', { ok: false, unknown: false, duplicate: false, retryable: true }, 1]
  ]) {
    main.state.image = outcome;
    const before = main.state.notified.length;
    await runTurn(main, mainId, [
      { type: 'call', calls: [{ name: 'qq_send_image', args: { url: 'https://public.invalid/c.png' } }] },
      { type: 'text', text: '' }
    ], turnContext({ sourceId: `wake:${Math.random()}` }));
    await acheck(`${label}：通知次数 ${expectation}`, () => {
      assert.equal(main.state.notified.length - before, expectation);
    });
  }
  main.state.image = { ok: false, unknown: false, duplicate: false, retryable: true };
  main.state.send = { ok: true, sent: 1, failed: 1, turnComplete: false };
  const beforePartial = main.state.notified.length;
  await runTurn(main, mainId, [
    { type: 'call', calls: [{ name: 'send', args: { text: ['一', '二'] } }] },
    { type: 'call', calls: [{ name: 'qq_send_image', args: { url: 'https://public.invalid/d.png' } }] },
    { type: 'text', text: '' }
  ], turnContext({ sourceId: 'wake:partial' }));
  await acheck('部分发送：用户已收到部分内容，不补失败说明', () => {
    assert.equal(main.state.notified.length, beforePartial);
  });

  // 4) 多个错误 / 多次收尾 → 至多一条
  main.state.send = { ok: true, sent: 1, failed: 0, turnComplete: false };
  main.state.image = { ok: false, unknown: false, duplicate: false, retryable: true };
  const beforeMulti = main.state.notified.length;
  await runTurn(main, mainId, [
    { type: 'call', calls: [
      { name: 'qq_send_image', args: { url: 'https://public.invalid/e.png' } },
      { name: 'qq_send_image', args: { url: 'https://public.invalid/f.png' } },
      { name: 'qq_mark_read', args: {} },
      { name: 'qq_mark_read', args: {} }
    ] },
    { type: 'text', text: '' }
  ], turnContext({ sourceId: 'wake:multi' }));
  await acheck('多个错误 + 多次收尾：只提示一条', () => {
    assert.equal(main.state.notified.length - beforeMulti, 1);
  });

  // 5) 媒体任务只按“本轮触碰且仍进行中”判断：历史旧任务不能永久抑制提示
  main.state.image = { ok: false, unknown: false, duplicate: false, retryable: true };
  const jobSession = main.instance.loadSession(mainId);
  jobSession.pendingImageJobs = { 'job-legacy': { lastQueryAt: Date.now() - 3600_000 } };
  main.instance.saveSession(jobSession);
  const beforeLegacyJob = main.state.notified.length;
  await runTurn(main, mainId, [
    { type: 'call', calls: [{ name: 'qq_send_image', args: { url: 'https://public.invalid/g.png' } }] },
    { type: 'text', text: '' }
  ], turnContext({ sourceId: 'wake:legacy-job' }));
  await acheck('历史遗留的未完成生图任务不再永久抑制本轮提示', () => {
    assert.equal(main.state.notified.length - beforeLegacyJob, 1);
  });

  // 5b) 本轮新建、仍未完成的任务：本轮先不提示（任务还要继续跑）
  main.state.generate = { ok: true, jobId: 'job-this-turn', status: 'running' };
  const beforeTurnJob = main.state.notified.length;
  await runTurn(main, mainId, [
    { type: 'call', calls: [{ name: 'qq_generate_image', args: { prompt: '画一只猫' } }] },
    { type: 'call', calls: [{ name: 'qq_send_image', args: { url: 'https://public.invalid/g2.png' } }] },
    { type: 'text', text: '' }
  ], turnContext({ sourceId: 'wake:turn-job' }));
  await acheck('本轮触碰且仍未完成的媒体任务：本轮不提示', () => {
    assert.equal(main.state.notified.length - beforeTurnJob, 0);
  });

  // 5c) 本轮触碰后已经结束（失败）的任务不再抑制提示
  main.state.generate = { ok: true, jobId: 'job-this-turn', status: 'failed' };
  const beforeFinishedJob = main.state.notified.length;
  await runTurn(main, mainId, [
    { type: 'call', calls: [{ name: 'qq_generate_image', args: { prompt: '再画一只' } }] },
    { type: 'call', calls: [{ name: 'qq_send_image', args: { url: 'https://public.invalid/g3.png' } }] },
    { type: 'text', text: '' }
  ], turnContext({ sourceId: 'wake:finished-job' }));
  await acheck('本轮任务已结束（失败）：确定失败的媒体发送仍会提示', () => {
    assert.equal(main.state.notified.length - beforeFinishedJob, 1);
  });
  const cleaned = main.instance.loadSession(mainId);
  cleaned.pendingImageJobs = {};
  main.instance.saveSession(cleaned);

  // 6) 跨回合去重由桥接负责；运行时只保证每回合一次：notifier 失败也只调一次
  main.state.notifierResult = { ok: false, reason: 'send-unconfirmed' };
  const beforeFailure = main.state.notified.length;
  result = await runTurn(main, mainId, [
    { type: 'call', calls: [{ name: 'qq_send_image', args: { url: 'https://public.invalid/h.png' } }] },
    { type: 'text', text: '' }
  ], turnContext({ sourceId: 'wake:notifier-fail' }));
  await acheck('fallback 发送失败：只尝试一次，不重试也不影响回合', () => {
    assert.equal(main.state.notified.length - beforeFailure, 1);
    assert.equal(result.modelRequests, 2);
  });
  main.state.notifierResult = { ok: true };
  main.state.notifierThrows = true;
  const beforeThrow = main.state.notified.length;
  result = await runTurn(main, mainId, [
    { type: 'call', calls: [{ name: 'qq_send_image', args: { url: 'https://public.invalid/i.png' } }] },
    { type: 'text', text: '' }
  ], turnContext({ sourceId: 'wake:notifier-throw' }));
  await acheck('fallback 抛错被吞掉：只尝试一次，回合仍是 completed', () => {
    assert.equal(main.state.notified.length - beforeThrow, 1);
    assert.equal(result.session.records.at(-1)?.data?.reason?.kind, 'completed');
  });
  main.state.notifierThrows = false;

  // 6b) 生命周期顺序：兜底尝试期间回合仍算进行中；turn/end 与 running=false
  //     必须在兜底尝试完成之后才落下（桥接不会在异步兜底期间接入下一轮）。
  const order = makeClient();
  const orderId = await create(order.instance, 'agents-order');
  let releaseFallback;
  const fallbackGate = new Promise(resolve => { releaseFallback = resolve; });
  const midFallback = [];
  let fallbackReleased = false;
  order.state.notifierHook = async () => {
    const live = order.instance.loadSession(orderId);
    midFallback.push({
      running: live.running,
      turnStarts: live.records.filter(record => record.type === 'turn/start').length,
      turnEnds: live.records.filter(record => record.type === 'turn/end').length
    });
    await fallbackGate;
    fallbackReleased = true;
  };
  plan.push(
    { type: 'call', calls: [{ name: 'qq_send_image', args: { url: 'https://public.invalid/lifecycle.png' } }] },
    { type: 'text', text: '' }, // 第一轮结束
    { type: 'text', text: '' }  // 第二轮（无工具）
  );
  const firstAccepted = order.instance.sessions.prompt({
    sessionId: orderId, content: [{ type: 'text', text: '私聊：发图' }], turnContext: turnContext({ sourceId: 'wake:order-1' })
  });
  await waitUntil(() => midFallback.length === 1);
  await acheck('兜底尝试进行中：回合仍标记 running，且尚未广播 turn/end', () => {
    assert.equal(midFallback[0].running, true);
    assert.equal(midFallback[0].turnStarts, 1);
    assert.equal(midFallback[0].turnEnds, 0, 'turn/end must not be published before the fallback attempt finishes');
    assert.equal(order.instance.loadSession(orderId).running, true);
  });
  const secondAccepted = order.instance.sessions.prompt({
    sessionId: orderId, content: [{ type: 'text', text: '第二条' }],
    turnContext: turnContext({ sourceId: 'wake:order-2', requestMessageId: 'm-2' })
  });
  await delay(30);
  await acheck('兜底尚未完成时，下一轮不会开始', () => {
    const live = order.instance.loadSession(orderId);
    assert.equal(live.records.filter(record => record.type === 'turn/start').length, 1);
    assert.equal(live.records.filter(record => record.type === 'turn/end').length, 0);
  });
  releaseFallback();
  await firstAccepted; await secondAccepted;
  await waitUntil(() => order.instance.loadSession(orderId).records.filter(record => record.type === 'turn/end').length === 2);
  await acheck('兜底完成后才落 turn/end、running 复位，两轮顺序正确', () => {
    const live = order.instance.loadSession(orderId);
    assert.equal(fallbackReleased, true);
    assert.equal(live.running, false);
    assert.equal(live.records.filter(record => record.type === 'turn/start').length, 2);
    assert.equal(live.records.filter(record => record.type === 'turn/end').length, 2);
    assert.equal(live.records.at(-1)?.type, 'turn/end');
    assert.equal(order.state.notified.length, 1, 'only the media-failure turn notifies');
  });

  // 7) 静默 / 内部 / 群聊 / 无可信上下文 / 过期模式：都不提示
  const quiet = makeClient();
  const quietId = await create(quiet.instance, 'agents-quiet');
  const variants = [
    ['silent 摘要回合', turnContext({ kind: 'silent', sourceId: null }), 'silent'],
    ['internal 内部回合', turnContext({ kind: 'internal', sourceId: null }), 'internal'],
    ['群聊 chat-wake', turnContext({ key: 'group:456' }), 'group'],
    ['无可信上下文', null, 'null context'],
    ['过期模式（chat）', turnContext({ mode: 'chat' }), 'stale mode'],
    ['无原用户消息', turnContext({ requestMessageId: null }), 'no request message']
  ];
  for (const [label, context, tag] of variants) {
    const before = quiet.state.notified.length;
    await runTurn(quiet, quietId, [
      { type: 'call', calls: [{ name: 'qq_send_image', args: { url: `https://public.invalid/${encodeURIComponent(tag)}.png` } }] },
      { type: 'text', text: '' }
    ], context);
    await acheck(`${label}：不补发`, () => {
      assert.equal(quiet.state.notified.length - before, 0);
    });
  }

  // 8) 开关关闭：旧行为完全不变（同样有确定失败，但不提示）
  const legacy = makeClient({ simpleTools: false });
  const legacyId = await create(legacy.instance, 'agents-legacy');
  const beforeLegacy = legacy.state.notified.length;
  await runTurn(legacy, legacyId, [
    { type: 'call', calls: [{ name: 'mcp__snowluma__qq_send_image', args: { key: 'private:123', token: AGENT_TOKEN, requestId: 'm-1', url: 'https://public.invalid/j.png' } }] },
    { type: 'text', text: '' }
  ], null);
  await acheck('simpleTools 关闭：确定失败也不补发（默认兼容）', () => {
    assert.equal(legacy.state.notified.length - beforeLegacy, 0);
  });

  // 9) 取消中的回合：不补发
  const cancelled = makeClient();
  const cancelledId = await create(cancelled.instance, 'agents-cancelled');
  gates.set('cancel-gate', (() => {
    let release; const promise = new Promise(resolve => { release = resolve; });
    return { promise, release, reached: false };
  })());
  plan.push(
    { type: 'call', calls: [{ name: 'qq_send_image', args: { url: 'https://public.invalid/k.png' } }] },
    { type: 'text', text: '', gate: 'cancel-gate' }
  );
  const gate = gates.get('cancel-gate');
  const cancelledBefore = cancelled.state.notified.length;
  unwrap(await cancelled.instance.sessions.prompt({ sessionId: cancelledId, content: [{ type: 'text', text: '私聊：发图' }], turnContext: turnContext() }), 'prompt');
  await waitUntil(() => gate.reached);
  const liveSession = cancelled.instance.loadSession(cancelledId);
  liveSession.cancelEpoch = (liveSession.cancelEpoch || 0) + 1; // 模拟取消/过期上下文
  gate.release();
  await cancelled.instance.loadSession(cancelledId).runPromise;
  await acheck('回合被取消（上下文已过期）：不补发', () => {
    assert.equal(cancelled.state.notified.length - cancelledBefore, 0);
  });

  // 10) 没有注入 notifier：行为与旧版一致，不抛错
  const bare = makeClient({ withNotifier: false });
  const bareId = await create(bare.instance, 'agents-bare');
  await runTurn(bare, bareId, [
    { type: 'call', calls: [{ name: 'qq_send_image', args: { url: 'https://public.invalid/l.png' } }] },
    { type: 'text', text: '' }
  ], turnContext());
  await acheck('没有桥接回调时静默跳过（不抛错、不改回合结果）', () => {
    assert.equal(bare.instance.loadSession(bareId).records.at(-1)?.data?.reason?.kind, 'completed');
  });

  console.log(`${checks} private-fallback checks passed; no real provider or QQ requests.`);
} finally {
  await Promise.allSettled(clients.map(instance => instance.dispose()));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  delete process.env.QQ_PI_FALLBACK_KEY;
  fs.rmSync(temp, { recursive: true, force: true });
}
