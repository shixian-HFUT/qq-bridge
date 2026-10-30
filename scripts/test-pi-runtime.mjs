import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PiApiClient } from '../src/pi-client.js';
import { MemoryStore } from '../src/memory-store.js';
import { repairToolPairs, projectPiContext, terminalToolResult, piContent } from '../src/pi-context.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const project = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pi-test-'));
const clients = [];
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS', name); }
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const toolName = 'mcp__snowluma__qq_send_message';
const calls = [];
let failSend = false;
let quotaSend = false;
let markReadMode = false;
let sends = 0;
let paused;
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body);
  assert.equal(req.headers.authorization, 'Bearer fixture-only-no-real-key');
  if (body.model === 'gemini-3.8-flash') {
    assert.equal(Object.hasOwn(body, 'enable_thinking'), false);
    assert.equal(body.reasoning_effort, 'low');
  } else assert.equal(body.enable_thinking, false);
  const learning = body.model === 'learning-fixture';
  assert.equal(body.max_tokens, learning ? 500 : 256);
  const isFollowUp = body.messages.at(-1)?.role === 'tool';
  const batch = Array.from({ length: quotaSend ? 2 : 1 }, (_, index) => ({ index, id: 'call_' + calls.length + '_' + index, type: 'function', function: { name: markReadMode ? 'mcp__snowluma__qq_mark_read' : toolName, arguments: '{}' } }));
  const delta = learning ? { role: 'assistant', content: '[]' } : isFollowUp ? { role: 'assistant', content: 'done' } : { role: 'assistant', tool_calls: batch };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (delta, finish_reason, usage) => res.write('data: ' + JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + '\n\n');
  emit(delta, null);
  emit({}, learning || isFollowUp ? 'stop' : 'tool_calls', { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 });
  res.end('data: [DONE]\n\n');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const config = { provider: 'apimart', model: 'qwen3.8-flash', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'QQ_PI_FIXTURE_KEY', credentialSource: 'file', credentialFile: path.join(temp, 'fixture.env'), maxTokens: 256, thinkingLevel: 'off' };
process.env.QQ_PI_FIXTURE_KEY = 'fixture-other-project-key';
fs.writeFileSync(config.credentialFile, 'QQ_PI_FIXTURE_KEY=fixture-only-no-real-key\n');
const tool = { name: toolName, label: 'send', description: 'fixture tool', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => {
  sends++; if (paused) await paused;
  if (quotaSend) return { ...result({ ok: false, code: 'SEND_RATE_LIMIT', unknown: false, remaining: 0, retryAt: Date.now() + 60000 }), isError: true };
  return { ...result({ ok: !failSend, failed: failSend ? 1 : 0, turnComplete: !failSend }), details: { bridgeTerminal: !failSend }, isError: failSend };
} };
function client(root = temp, overrides = {}) {
  const c = new PiApiClient({ root, config, tools: [tool], rolePrompt: () => 'fixture persona', ...overrides }); clients.push(c); return c;
}
async function create(c) {
  const workspace = unwrap(await c.workspace.create({ path: path.join(temp, 'agents') }), 'workspace').workspace;
  return unwrap(await c.sessions.create({ workspaceId: workspace.workspaceId, agentPreset: 'qq-chat-v2' }), 'create').sessionId;
}
async function prompt(c, id) {
  unwrap(await c.sessions.prompt({ sessionId: id, content: [{ type: 'text', text: 'fixture question' }] }), 'prompt');
  await c.loadSession(id).runPromise;
  const s = c.loadSession(id);
  assert.equal(s.records.at(-1)?.data?.reason?.kind, 'completed', s.records.at(-1)?.data?.reason?.error?.message);
  return s;
}
try {
  const bridge = await bridgeHarness({ config: { dsh: { provider: 'apimart', model: 'qwen3.8-flash', reasoningEffort: 'off' } } });
  try { check('bridge configuration preserves disabled thinking', () => assert.equal(bridge.cfg.dsh.reasoningEffort, 'off')); }
  finally { await bridge.close(); }
  fs.mkdirSync(path.join(temp, 'runtime', 'pi'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'runtime', 'pi', 'package.json'), '{"type":"module"}');
  // 本沙箱禁止在临时目录创建 junction；改为让临时 sdk.js 用绝对 file URL 引用
  // 同一份锁定依赖。断言与运行时行为不变，只是不再复制/链接 node_modules。
  const piRoot = path.join(project, 'runtime', 'pi', 'node_modules', '@earendil-works');
  fs.writeFileSync(path.join(temp, 'runtime', 'pi', 'sdk.js'), [
    `export { Agent } from ${JSON.stringify(pathToFileURL(path.join(piRoot, 'pi-agent-core', 'dist', 'index.js')).href)};`,
    `export { createModels } from ${JSON.stringify(pathToFileURL(path.join(piRoot, 'pi-ai', 'dist', 'models.js')).href)};`,
    `export { openAICompletionsApi } from ${JSON.stringify(pathToFileURL(path.join(piRoot, 'pi-ai', 'dist', 'api', 'openai-completions.lazy.js')).href)};`,
    ''
  ].join('\n'));
  const presetDir = path.join(temp, 'dsh', 'agent-presets', 'qq-chat-v2'); fs.mkdirSync(presetDir, { recursive: true });
  fs.writeFileSync(path.join(presetDir, 'agent.cordis.yml'), '- id: persona\n  config:\n    prefix: fixture safe preset\n');
  check('terminal finish requires successful send and no unread messages', () => {
    assert.equal(terminalToolResult(toolName, result({ ok: true, failed: 0, turnComplete: true })), true);
    for (const value of [{ ok: false, failed: 0, turnComplete: true }, { ok: true, failed: 1, turnComplete: true }, { ok: true, failed: 0, turnComplete: false }]) assert.equal(terminalToolResult(toolName, result(value)), false);
    assert.equal(terminalToolResult('mcp__snowluma__qq_mark_read', result({ ok: true, unreadCount: 0 }), {}), false);
  });
  const history = [{ role: 'user', content: [{ type: 'text', text: 'old'.repeat(400) }] }, { role: 'assistant', content: [{ type: 'toolCall', id: 'old', name: 'noop', arguments: {} }] }, { role: 'user', content: [{ type: 'text', text: 'new' }] }, { role: 'assistant', content: [{ type: 'toolCall', id: 'new', name: 'noop', arguments: {} }] }];
  check('interrupted tool pairs repaired without replay; orphan results removed', () => {
    const fixed = repairToolPairs([...history, { role: 'toolResult', toolCallId: 'orphan', content: [] }]);
    assert.equal(fixed.filter(m => m.role === 'toolResult').length, 2);
    assert.equal(fixed.at(-1).isError, true);
  });
  check('context projection preserves newest whole turn and tool pairs', () => {
    const projected = projectPiContext(history, 200);
    assert.equal(projected[0].content[0].text, 'new');
    assert.equal(projected.at(-1).toolCallId, 'new');
    assert.equal(history.length, 4);
  });
  check('QQ image attachments retain their MIME type through Pi conversion', () => {
    assert.deepEqual(piContent([{ type: 'image', mediaType: 'image/png', data: 'fixture' }]), [{ type: 'image', mimeType: 'image/png', data: 'fixture' }]);
  });
  const c = client(); await c.initialize();
  const workspace = Object.values(c.index.workspaces)[0];
  assert.equal((await c.sessions.create({ workspaceId: workspace?.workspaceId, agentPreset: 'standard' })).result.ok, false);
  check('untrusted default preset cannot create a local execution session', () => assert.equal(c.index.sessions && Object.keys(c.index.sessions).length, 0));
  const id = await create(c);
  const before = calls.length; const s = await prompt(c, id);
  check('actual Pi SDK + OpenAI wire ends after one successful tool request', () => { assert.equal(calls.length - before, 1); assert.equal(sends, 1); });
  check('explicit project key overrides a different inherited environment key', () => assert.equal(calls.length > 0 && process.env.QQ_PI_FIXTURE_KEY !== 'fixture-only-no-real-key', true));
  check('bridge collector and token usage receive completed turn events', () => {
    const collector = createTurnCollector(); let end;
    for (const event of s.records) end = collector.push(event) || end;
    assert.equal(end.reason.kind, 'completed');
    assert.equal(s.records.find(e => e.type === 'assistant/message').data.usage.inputTokens, 30);
  });
  failSend = true; const beforeFailure = calls.length;
  await prompt(c, id);
  check('failed send is not treated as a completed reply', () => assert.equal(calls.length - beforeFailure, 2));
  failSend = false;
  quotaSend = true;
  const quotaId = await create(c), beforeQuota = calls.length, beforeQuotaSends = sends;
  await prompt(c, quotaId);
  check('a known quota rejection ends without another model call and blocks the remaining batch', () => {
    assert.equal(calls.length - beforeQuota, 1); assert.equal(sends - beforeQuotaSends, 1);
    assert.ok(c.loadSession(quotaId).records.some(r => r.type === 'turn/quota-stop'));
    assert.equal(c.loadSession(quotaId).messages.filter(m => m.role === 'toolResult').length, 2);
  });
  quotaSend = false;
  markReadMode = true;
  const markName = 'mcp__snowluma__qq_mark_read';
  const busyMark = client(temp, { tools: [{ ...tool, name: markName, execute: async () => {
    const response = result({ ok: true, markedCount: 1, unreadCount: 30, readThroughSeq: 1, turnComplete: true });
    return { ...response, details: { bridgeTerminal: terminalToolResult(markName, response, { throughSeq: 1 }) } };
  } }] });
  const busyMarkId = await create(busyMark), beforeMark = calls.length;
  await prompt(busyMark, busyMarkId);
  check('busy-group mark-read ends after one request even when newer messages remain unread', () => {
    assert.equal(calls.length - beforeMark, 1);
    const receipt = busyMark.loadSession(busyMarkId).messages.find(m => m.role === 'toolResult');
    assert.equal(JSON.parse(receipt.content.find(c => c.type === 'text').text).unreadCount, 30);
  });
  markReadMode = false;
  const other = await create(c); await prompt(c, other);
  check('conversation histories are isolated', () => assert.equal(c.loadSession(other).messages.filter(m => m.role === 'user').length, 1));
  const recovered = client();
  const savedPath = path.join(temp, 'state', 'pi', 'sessions', id + '.json');
  const saved = JSON.parse(fs.readFileSync(savedPath)); saved.running = true; saved.messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: 'interrupted', name: toolName, arguments: {} }] }); fs.writeFileSync(savedPath, JSON.stringify(saved));
  const count = sends; const restored = recovered.loadSession(id);
  check('restart closes stale busy state and never re-executes external effects', () => {
    assert.equal(restored.running, false); assert.equal(sends, count);
    assert.equal(restored.records.at(-1).type, 'session/end-seed');
    assert.equal(restored.messages.at(-1).toolCallId, 'interrupted');
  });
  await c.workspace.archiveSession({ sessionId: other });
  assert.equal((await c.sessions.prompt({ sessionId: other, content: [] })).result.ok, false);
  check('archived sessions reject new prompts', () => assert.equal(c.index.sessions[other].archived, true));
  let releaseInitialization;
  const gate = new Promise(resolve => { releaseInitialization = resolve; });
  const slow = client(); const slowId = await create(slow);
  const originalInitialize = slow.initialize.bind(slow);
  slow.initialize = async () => { await gate; return originalInitialize(); };
  const beforeCancel = calls.length;
  await slow.sessions.prompt({ sessionId: slowId, content: [{ type: 'text', text: 'cancelled before start' }] });
  const stopped = slow.stopSessionWork(slowId); releaseInitialization(); await stopped;
  check('cancellation during initialization prevents a later send', () => {
    assert.equal(calls.length, beforeCancel); assert.equal(slow.loadSession(slowId).running, false);
  });
  const serial = await create(c); let releaseSend;
  paused = new Promise(resolve => { releaseSend = resolve; });
  const beforeSerial = calls.length;
  await c.sessions.prompt({ sessionId: serial, content: [{ type: 'text', text: 'first queued question' }] });
  await c.sessions.prompt({ sessionId: serial, content: [{ type: 'text', text: 'second queued question' }] });
  releaseSend(); await c.loadSession(serial).runPromise; paused = undefined;
  check('queued messages run sequentially without dropping the second admission', () => {
    assert.equal(calls.length - beforeSerial, 2);
    assert.equal(c.loadSession(serial).messages.filter(m => m.role === 'user').length, 2);
  });
  const gemini = client(temp, { config: { ...config, model: 'gemini-3.8-flash', thinkingLevel: 'low', compat: { thinkingFormat: 'openai' } } });
  const geminiId = await create(gemini); const beforeGemini = calls.length;
  await prompt(gemini, geminiId);
  check('Gemini uses low reasoning without Qwen-specific request parameters', () => assert.equal(calls.length - beforeGemini, 1));
  const memoryId = await create(c);
  for (let n = 0; n < 2; n++) {
    await c.sessions.prompt({ sessionId: memoryId, content: [{ type: 'text', text: 'remember fixture' }], bridgeMemory: { version: 'v1', text: 'fixture durable preference' } });
    await c.loadSession(memoryId).runPromise;
  }
  check('actual SDK/wire keeps one memory snapshot across successive turns', () => {
    assert.equal(JSON.stringify(calls.at(-1)).split('fixture durable preference').length - 1, 1);
    assert.ok(c.loadSession(memoryId).messages.find(m => m.bridgeMemory?.version === 'v1'));
    assert.equal(JSON.stringify(calls.at(-1)).includes('bridgeMemory'), false);
  });
  await c.sessions.prompt({ sessionId: memoryId, content: [{ type: 'text', text: 'correct fixture' }], bridgeMemory: { version: 'v2', text: 'fixture updated preference' } });
  await c.loadSession(memoryId).runPromise;
  check('actual SDK/wire immediately replaces outdated memory snapshot', () => {
    assert.ok(JSON.stringify(calls.at(-1)).includes('fixture updated preference'));
    assert.ok(!JSON.stringify(calls.at(-1)).includes('fixture durable preference'));
  });
  const learningStore = new MemoryStore({ dir: path.join(temp, 'learning-budget') });
  try {
    const learner = client(temp, { config: { ...config, model: 'learning-fixture' }, learningBudget: learningStore });
    const workspace = unwrap(await learner.workspace.create({ path: path.join(temp, 'slang-agent') }), 'workspace').workspace;
    const learnerId = unwrap(await learner.sessions.create({ workspaceId: workspace.workspaceId, agentPreset: 'qq-chat-v2' }), 'create').sessionId;
    const beforeLearning = calls.length;
    await prompt(learner, learnerId); await prompt(learner, learnerId);
    await learner.sessions.prompt({ sessionId: learnerId, content: [{ type: 'text', text: 'over budget' }] });
    await learner.loadSession(learnerId).runPromise;
    check('actual SDK learner is stateless, output-capped and stopped before third paid request', () => {
      assert.equal(calls.length - beforeLearning, 2);
      assert.equal(calls.at(-1).messages.filter(m => m.role === 'user').length, 1);
      assert.equal(calls.at(-1).max_tokens, 500);
      assert.equal(learningStore.learningUsage().requests, 2);
      assert.equal(learner.loadSession(learnerId).records.at(-1).data.reason.kind, 'error');
    });
  } finally { learningStore.close(); }
  const brokenRoot = path.join(temp, 'broken'); fs.mkdirSync(path.join(brokenRoot, 'state', 'pi'), { recursive: true });
  const brokenIndex = path.join(brokenRoot, 'state', 'pi', 'index.json'); fs.writeFileSync(brokenIndex, '{broken');
  check('corrupt history index fails closed without overwriting the archive', () => {
    assert.throws(() => new PiApiClient({ root: brokenRoot, config }), /refusing to overwrite/);
    assert.equal(fs.readFileSync(brokenIndex, 'utf8'), '{broken');
  });
  console.log(`${checks} Pi checks passed; no real provider or QQ requests.`);
} finally {
  await Promise.allSettled(clients.map(c => c.dispose()));
  server.closeAllConnections(); await new Promise(r => server.close(r));
  delete process.env.QQ_PI_FIXTURE_KEY;
  // temp was created under the OS temp directory above; unlink junction first.
  const link = path.join(temp, 'runtime', 'pi', 'node_modules'); if (fs.existsSync(link)) fs.unlinkSync(link);
  fs.rmSync(temp, { recursive: true, force: true });
}
