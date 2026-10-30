// Actual pinned Pi SDK, fake SSE provider, fake tools and fixed-notice callback.
// No production state, QQ, real searches, model credentials or paid calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PiApiClient } from '../src/pi-client.js';
import { unwrap } from '../src/dsh-client.js';
import { terminalToolResult } from '../src/pi-context.js';
import { ToolLoopGuard, normalizeReadOnlyNumbers } from '../src/pi-tool-loop.js';
import { createPrivateMediaTurnFacts, shouldNotifyPrivateMediaFailure } from '../src/private-fallback.js';

const project = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tool-loop-'));
const clients = [], requests = [], effects = [], notices = [];
let plan = [], sequence = 0, imageOutcome, sendOutcome, checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log('PASS', name); };
const rawCall = (name, args = {}) => ({ name, args });
const calls = (...entries) => ({ calls: entries });
const imageName = 'mcp__snowluma__qq_search_images';
const webName = 'mcp__web-search-safe__web_search';
const search = () => rawCall(imageName, { query: 'synthetic subject', count: '3' });
const web = () => rawCall(webName, { query: 'synthetic reference' });
const send = () => rawCall('send', { text: '合成回复' });
const read = () => rawCall('read');
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
  assert.equal(req.headers.authorization, 'Bearer fixture-only');
  const step = plan.shift() || { text: '' };
  const delta = step.calls ? { role: 'assistant', tool_calls: step.calls.map((c, index) => ({
    index, id: 'call_' + (++sequence), type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) }
  })) } : { role: 'assistant', content: step.text };
  res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model,
    choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model,
    choices: [{ index: 0, delta: {}, finish_reason: step.calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const text = { type: 'string' }, number = { type: 'integer', minimum: 1, maximum: 8 };
function tool(name, properties, required, result) {
  return { name, label: name, description: 'Synthetic fixture only', parameters: { type: 'object', properties, required },
    execute: async (_id, args) => {
      effects.push({ name, args });
      const data = await result(args);
      const content = [{ type: 'text', text: JSON.stringify(data) }];
      const isError = data.ok === false;
      return { content, isError, details: { bridgeTerminal: terminalToolResult(name, { content, isError }, args) } };
    } };
}
const definitions = [
  tool(imageName, { key: text, token: text, query: text, count: number }, ['key', 'token', 'query'], args => {
    if (args.count !== undefined) { assert.equal(typeof args.count, 'number'); assert(args.count >= 1 && args.count <= 8); }
    return imageOutcome(args);
  }),
  tool(webName, { query: text }, ['query'], () => ({ ok: true, results: [] })),
  tool('mcp__snowluma__qq_send_message', { key: text, token: text, throughSeq: number,
    messages: { type: 'array', items: text } }, ['key', 'token', 'messages'], args => sendOutcome(args)),
  tool('mcp__snowluma__qq_get_unread_messages', { key: text, token: text }, ['key', 'token'], () => ({ ok: true, messages: [], readThroughSeq: 7 })),
  tool('mcp__snowluma__qq_mark_read', { key: text, token: text, throughSeq: number }, ['key', 'token'], () => ({ ok: true, unreadCount: 0 })),
  tool('mcp__snowluma__qq_generate_image', { key: text, token: text, requestId: text, prompt: text }, ['key', 'token', 'prompt'], () => ({ ok: true, jobId: 'job-1', status: 'running' }))
];
const turn = { key: 'private:123', token: 'fixture-scope-token', mode: 'reserved2', kind: 'chat-wake',
  sourceId: 'wake:1', readThroughSeq: 7, requestMessageId: 'message-1' };
const cfg = { provider: 'fixture', model: 'fixture-model', baseURL: `http://127.0.0.1:${server.address().port}/v1`,
  apiKeyEnv: 'FIXTURE_KEY', credentialSource: 'file', credentialFile: path.join(temp, 'fixture.env'),
  simpleTools: true, thinkingLevel: 'off', maxTokens: 128, maxCallsPerTurn: 20, maintenance: { enabled: false } };
fs.writeFileSync(cfg.credentialFile, 'FIXTURE_KEY=fixture-only\n');
async function run(script, { context = turn, config = {}, noticeFails = false } = {}) {
  plan = [...script]; effects.length = 0; notices.length = 0; requests.length = 0;
  const client = new PiApiClient({ root: temp, config: { ...cfg, ...config }, tools: definitions,
    notifyPrivateMediaFailure: request => {
      assert.equal(client.loadSession(id).running, true);
      notices.push(request); if (noticeFails) throw Error('fixture QQ unavailable'); return { ok: true };
    } });
  clients.push(client);
  const workspace = unwrap(await client.workspace.create({ path: path.join(temp, 'agent') }), 'workspace').workspace;
  const id = unwrap(await client.sessions.create({ workspaceId: workspace.workspaceId, agentPreset: 'qq-chat-v2' }), 'session').sessionId;
  unwrap(await client.sessions.prompt({ sessionId: id, content: [{ type: 'text', text: 'Synthetic task' }], turnContext: context }), 'prompt');
  await client.loadSession(id).runPromise;
  const session = client.loadSession(id);
  assert.equal(session.records.at(-1).data.reason.kind, 'completed', session.records.at(-1).data.reason.error?.message);
  return { client, session, id };
}
try {
  const sdk = path.join(temp, 'runtime/pi'); fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(sdk, 'sdk.js'), `export * from ${JSON.stringify(pathToFileURL(path.join(project, 'runtime/pi/sdk.js')).href)};`);
  const preset = path.join(temp, 'dsh/agent-presets/qq-chat-v2'); fs.mkdirSync(preset, { recursive: true });
  fs.writeFileSync(path.join(preset, 'agent.cordis.yml'), '- id: persona\n  config:\n    prefix: fixture persona\n');
  imageOutcome = () => ({ ok: true, results: [{ downloadVerified: true }] });
  sendOutcome = () => ({ ok: true, sent: 1, failed: 0, turnComplete: true });

  await check('numeric strings normalize only on declared read-only fields; authority and bounds remain intact', () => {
    const schema = { properties: { count: number, token: text } };
    const args = { count: '3', token: '2', requestId: '9007199254740993' };
    assert.deepEqual(normalizeReadOnlyNumbers('qq_search_images', args, schema), { ...args, count: 3 });
    for (const v of ['1e2', 'NaN', '2.5', '9007199254740993']) assert.equal(normalizeReadOnlyNumbers('qq_search_images', { count: v }, schema).count, v);
    assert.equal(normalizeReadOnlyNumbers('qq_send_message', args, schema).count, '3');
    assert.equal(normalizeReadOnlyNumbers('qq_search_images', { count: '9' }, schema).count, 9, 'no silent clamping');
  });
  await check('short-name numeric string survives SDK validation and reaches MCP as number', async () => {
    await run([calls(rawCall('qq_search_images', { query: 'fixture', count: '3', key: 'private:999', token: 'forged' })), calls(send())]);
    assert.equal(effects[0].args.count, 3); assert.equal(effects[0].args.key, turn.key); assert.equal(effects[0].args.token, turn.token);
    assert.equal(requests.length, 2); assert.equal(notices.length, 0);
  });
  await check('historical long-name numeric strings are also normalized', async () => {
    await run([calls(search()), calls(send())]); assert.equal(effects[0].args.count, 3); assert.equal(requests.length, 2);
  });
  imageOutcome = () => ({ ok: false, error: 'unmapped synthetic subject' });
  await check('two identical research failures lead to one closing request and a normal send', async () => {
    await run([calls(search()), calls(search()), calls(send())]);
    assert.equal(effects.filter(x => x.name === imageName).length, 2); assert.equal(requests.length, 3); assert.equal(notices.length, 0);
    const names = requests.at(-1).tools.map(t => t.function.name);
    assert(names.includes('send')); assert(!names.includes(imageName)); assert(!names.includes(webName));
  });
  await check('closing request cannot restart research; silent private result gets one guarded fixed notice', async () => {
    await run([calls(search()), calls(search()), calls(web())], { noticeFails: true });
    assert.equal(effects.filter(x => x.name === imageName).length, 2); assert.equal(effects.some(x => x.name === webName), false);
    assert.equal(requests.length, 3); assert.equal(notices.length, 1); assert.equal(notices[0].reason, 'research-stop');
  });
  imageOutcome = () => ({ ok: true, results: [{ downloadVerified: true }] });
  await check('parallel batches execute at most three image searches', async () => {
    await run([calls(search(), search(), search(), search(), search()), calls(send())]);
    assert.equal(effects.filter(x => x.name === imageName).length, 3); assert.equal(requests.length, 2);
  });
  await check('combined read-only research executes at most seven calls across search tools', async () => {
    await run([calls(...Array.from({ length: 10 }, web)), calls(send())]);
    assert.equal(effects.filter(x => x.name === webName).length, 7); assert.equal(requests.length, 2);
  });
  await check('last model slot is reserved for a closing reply without raising the configured cap', async () => {
    await run([calls(read()), calls(read()), calls(send())], { config: { maxCallsPerTurn: 3 } });
    assert.equal(requests.length, 3); assert.equal(notices.length, 0);
  });
  await check('at cap one no second model request is made; private notice still completes the turn', async () => {
    await run([calls(read())], { config: { maxCallsPerTurn: 1 } });
    assert.equal(requests.length, 1); assert.equal(notices.length, 1);
  });
  imageOutcome = () => ({ ok: false, error: 'same fixture error' });
  await check('a successful send in a mixed research-error batch never causes a second closing send', async () => {
    await run([calls(search(), search(), send())]);
    assert.equal(requests.length, 1); assert.equal(notices.length, 0);
    assert.equal(effects.filter(x => x.name.endsWith('__qq_send_message')).length, 1);
  });
  await check('an unknown send outcome suppresses automatic notice even after research stops', async () => {
    sendOutcome = () => { throw Error('unknown transport outcome'); };
    await run([calls(search(), search(), send()), { text: '' }]); assert.equal(notices.length, 0);
    sendOutcome = () => ({ ok: true, sent: 1, failed: 0, turnComplete: true });
  });
  await check('group closing is bounded but does not auto-publish a private failure sentence', async () => {
    await run([calls(search(), search()), { text: '' }], { context: { ...turn, key: 'group:456' } });
    assert.equal(requests.length, 2); assert.equal(notices.length, 0);
  });
  imageOutcome = () => ({ ok: true, results: [] });
  await check('silent and disabled paths keep historical behavior without new research limits', async () => {
    await run([calls(...Array.from({ length: 5 }, search)), { text: '' }], { context: { ...turn, kind: 'silent', silent: true } });
    assert.equal(effects.length, 5); assert.equal(notices.length, 0);
    const guard = new ToolLoopGuard(false); for (let i = 0; i < 30; i++) assert.equal(guard.before(imageName), null);
  });
  await check('closing blocks new generation and still admits only reply/end tools', () => {
    const guard = new ToolLoopGuard(true); guard.stop('fixture'); guard.closing = true;
    assert(guard.before('mcp__snowluma__qq_generate_image')?.isError);
    assert.equal(guard.before('mcp__snowluma__qq_send_message'), null);
  });
  await check('fixed research notice respects private-mode, cancellation, disposal and pending-job gates', () => {
    const base = { notifierAvailable: true, backend: 'pi', simpleTools: true, mode: 'reserved2', kind: 'chat-wake', key: turn.key, requestMessageId: 'm', researchStopped: true };
    assert.equal(shouldNotifyPrivateMediaFailure(createPrivateMediaTurnFacts(), base).notify, true);
    for (const override of [{ key: 'group:456' }, { cancelled: true }, { disposed: true }, { pendingMediaJobs: true }, { turnFailed: true }, { simpleTools: false }, { kind: 'silent' }]) {
      assert.equal(shouldNotifyPrivateMediaFailure(createPrivateMediaTurnFacts(), { ...base, ...override }).notify, false);
    }
  });
  await check('limits reset on the next wake instead of blocking a session permanently', async () => {
    imageOutcome = () => ({ ok: false, error: 'same fixture error' });
    const { client, id } = await run([calls(search(), search()), { text: '' }]);
    assert.equal(notices.length, 1);
    imageOutcome = () => ({ ok: true, results: [] }); plan = [calls(search()), calls(send())];
    const before = requests.length;
    unwrap(await client.sessions.prompt({ sessionId: id, content: [{ type: 'text', text: 'New synthetic wake' }], turnContext: { ...turn, sourceId: 'wake:2', requestMessageId: 'message-2' } }), 'prompt');
    await client.loadSession(id).runPromise;
    assert.equal(requests.length - before, 2); assert.equal(notices.length, 1);
  });
  await check('current-turn generation jobs suppress research closing notices while running', async () => {
    imageOutcome = () => ({ ok: false, error: 'same fixture error' });
    const { session } = await run([calls(rawCall('qq_generate_image', { prompt: 'synthetic image' }), search(), search()), { text: '' }]);
    assert(session.pendingImageJobs['job-1']); assert.equal(notices.length, 0);
  });
  console.log(`${checks} tool-loop checks passed; no real model, QQ or search calls.`);
} finally {
  await Promise.allSettled(clients.map(c => c.dispose()));
  server.close(); await once(server, 'close');
  fs.rmSync(temp, { recursive: true, force: true });
}
