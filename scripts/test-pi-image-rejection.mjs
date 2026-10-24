import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PiApiClient } from '../src/pi-client.js';
import { ImageInputGuard, isInputImageRejection, IMAGE_REJECTION_NOTICE } from '../src/pi-image-rejection.js';

const ERROR = '400: {"message":"DataInspectionFailed: Input image data may contain inappropriate content.","code":"data_inspection_failed"}';
const config = { provider: 'fixture', baseURL: 'http://127.0.0.1/v1', model: 'fixture' };
const image = data => ({ type: 'image', mimeType: 'image/png', data });
const imageCount = messages => messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(b => b.type === 'image').length : 0), 0);

test('only input-image inspection failures trigger quarantine', () => {
  assert.equal(isInputImageRejection(ERROR), true);
  assert.equal(isInputImageRejection(Error(ERROR)), true);
  for (const error of ['400: invalid request', 'request timeout', 'data_inspection_failed: input text rejected']) {
    assert.equal(isInputImageRejection(error), false);
  }
});

test('rejection changes model projection while preserving archive and image bytes', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'fixture' }, image('image-one')] }];
  const original = JSON.stringify(messages);
  const s = { messages };
  const guard = new ImageInputGuard(s, config);
  guard.project(messages);
  assert.equal(guard.rememberFailure(ERROR), 1);
  const restored = JSON.parse(JSON.stringify(s));
  restored.messages[0].content[1] = { type: 'image', mimeType: 'image/png', bridgeImageRef: createHash('sha256').update('image-one').digest('hex') };
  const projected = new ImageInputGuard(restored, config).project(restored.messages);
  assert.equal(imageCount(projected), 0);
  assert.match(projected[0].content[1].text, /不要猜测/);
  assert.equal(JSON.stringify(s.messages), original);
});

test('quarantine is session/provider/model scoped and other errors preserve images', () => {
  const messages = [{ role: 'user', content: [image('one')] }];
  const s = { messages };
  const guard = new ImageInputGuard(s, config);
  guard.project(messages);
  assert.equal(guard.rememberFailure('timeout'), 0);
  assert.equal(s.imageInputRejections, undefined);
  guard.rememberFailure(ERROR);
  assert.equal(imageCount(new ImageInputGuard(s, { ...config, model: 'other' }).project(messages)), 1);
  assert.equal(imageCount(new ImageInputGuard({ messages }, config).project(messages)), 1);
  assert.equal(imageCount(new ImageInputGuard(s, config).project([{ role: 'user', content: [image('new')] }])), 1);
});

test('only images in the last submitted projection are quarantined', () => {
  const s = {};
  const guard = new ImageInputGuard(s, config);
  guard.project([{ role: 'user', content: [image('older')] }]);
  guard.project([{ role: 'user', content: [image('submitted')] }]);
  guard.rememberFailure(ERROR);
  const visible = new ImageInputGuard(s, config).project([{ role: 'user', content: [image('older'), image('submitted')] }]);
  assert.equal(imageCount(visible), 1);
  assert.equal(visible[0].content[0].data, 'older');
});

test('actual SDK: no retry; legacy failure recovers across restart; text and fresh images continue', async () => {
  const project = fileURLToPath(new URL('..', import.meta.url));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-rejection-'));
  const calls = [];
  const clients = [];
  const rejectedData = Buffer.from('rejected fixture').toString('base64');
  const newData = Buffer.from('fresh fixture').toString('base64');
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const urls = body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'image_url').map(b => b.image_url.url) : []);
    calls.push(urls);
    if (urls.some(url => url.endsWith(rejectedData))) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'DataInspectionFailed: Input image data may contain inappropriate content.', type: 'data_inspection_failed', code: 'data_inspection_failed' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'fixture response' }, null], [{}, 'stop']]) {
      res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    fs.mkdirSync(path.join(temp, 'runtime', 'pi'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'runtime', 'pi', 'package.json'), '{"type":"module"}');
    fs.copyFileSync(path.join(project, 'runtime', 'pi', 'sdk.js'), path.join(temp, 'runtime', 'pi', 'sdk.js'));
    fs.symlinkSync(path.join(project, 'runtime', 'pi', 'node_modules'), path.join(temp, 'runtime', 'pi', 'node_modules'), 'junction');
    const preset = path.join(temp, 'dsh', 'agent-presets', 'qq-chat-v2');
    fs.mkdirSync(preset, { recursive: true });
    fs.writeFileSync(path.join(preset, 'agent.cordis.yml'), '- id: persona\n  config:\n    prefix: fixture\n');
    const credentialFile = path.join(temp, 'fixture.env');
    fs.writeFileSync(credentialFile, 'QQ_IMAGE_FIXTURE_KEY=fixture-not-real\n');
    const cfg = { ...config, baseURL: `http://127.0.0.1:${server.address().port}/v1`, maxTokens: 128, thinkingLevel: 'off', apiKeyEnv: 'QQ_IMAGE_FIXTURE_KEY', credentialSource: 'file', credentialFile, maintenance: { enabled: false } };
    const client = () => { const c = new PiApiClient({ root: temp, config: cfg, tools: [] }); clients.push(c); return c; };
    const c = client();
    const workspace = (await c.workspace.create({ path: path.join(temp, 'agents') })).result.value.workspace;
    const id = (await c.sessions.create({ workspaceId: workspace.workspaceId, agentPreset: 'qq-chat-v2' })).result.value.sessionId;
    const prompt = async (api, content) => {
      await api.sessions.prompt({ sessionId: id, content });
      await api.loadSession(id).runPromise;
      return api.loadSession(id);
    };
    const rejected = await prompt(c, [{ type: 'text', text: 'fixture image question' }, image(rejectedData)]);
    assert.equal(calls.length, 1, 'failed request must not be retried');
    assert.equal(rejected.records.at(-1).data.reason.error.message, IMAGE_REJECTION_NOTICE);
    assert.equal(imageCount(rejected.messages), 1, 'original archived image must remain');
    await c.dispose();

    // Simulate the on-disk state from before this fix: failure, no guard metadata.
    const file = path.join(temp, 'state', 'pi', 'sessions', id + '.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete saved.imageInputRejections;
    saved.records.at(-1).data.reason.error.message = ERROR;
    fs.writeFileSync(file, JSON.stringify(saved));
    const restored = client();
    const recovered = restored.loadSession(id);
    assert.equal(calls.length, 1, 'startup recovery must not call provider');
    assert.equal(Object.values(recovered.imageInputRejections)[0].hashes.length, 1);
    assert.equal(imageCount(recovered.messages), 1);

    const continued = await prompt(restored, [{ type: 'text', text: 'new text question' }]);
    assert.equal(continued.records.at(-1).data.reason.kind, 'completed');
    assert.deepEqual(calls[1], []);
    const fresh = await prompt(restored, [{ type: 'text', text: 'new image question' }, image(newData)]);
    assert.equal(fresh.records.at(-1).data.reason.kind, 'completed');
    assert.equal(calls[2].length, 1);
    assert.ok(calls[2][0].endsWith(newData));
    assert.equal(calls.length, 3);
    assert.equal(imageCount(fresh.messages), 2);
  } finally {
    await Promise.allSettled(clients.map(c => c.dispose()));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const link = path.join(temp, 'runtime', 'pi', 'node_modules');
    if (fs.existsSync(link)) fs.unlinkSync(link);
    if (path.dirname(temp) !== path.resolve(os.tmpdir())) throw Error('Unexpected fixture cleanup path');
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
