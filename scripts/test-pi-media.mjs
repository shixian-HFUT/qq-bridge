import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PiMediaStore } from '../src/pi-media-store.js';
import { PiApiClient } from '../src/pi-client.js';
import { projectPiContext } from '../src/pi-context.js';

const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9RwAAAAASUVORK5CYII=' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pi-media-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), 'qq-pi-media-')));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, media: new PiMediaStore(path.join(root, 'state', 'pi', 'media')) };
}

test('image bytes are deduplicated across messages/events and restore without changing MIME or text', t => {
  const { root, media } = fixture(t);
  const session = { messages: [{ role: 'user', content: [{ type: 'text', text: 'keep this' }, { ...image }] }],
    records: [{ type: 'tool/result', data: { message: { content: [{ ...image }] } } }] };
  const original = structuredClone(session.messages);
  assert.equal(media.externalizeSession(session), true);
  assert.equal(media.externalizeSession(session), false);
  assert.equal(fs.readdirSync(path.join(root, 'state', 'pi', 'media')).length, 1);
  assert.equal(session.messages[0].content[1].data, undefined);
  assert.equal(session.messages[0].content[1].bridgeImageRef, session.records[0].data.message.content[0].bridgeImageRef);
  assert.deepEqual(media.hydrateMessages(session.messages), original);
  assert.equal(session.messages[0].content[1].data, undefined);
});

test('only the retained projection reads image blobs; old pruned images need not enter memory', t => {
  const { media } = fixture(t);
  const history = [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', bridgeImageRef: 'a'.repeat(64) }] },
    { role: 'user', content: [{ type: 'text', text: 'new message '.repeat(100) }] }];
  assert.equal(media.hydrateMessages(projectPiContext(history, 20)).length, 1);
  assert.throws(() => media.hydrateMessages(history), /ENOENT/);
});

test('invalid, missing, oversized and corrupted media references fail closed', t => {
  const { root, media } = fixture(t);
  const session = { messages: [{ role: 'user', content: [{ ...image }] }] };
  media.externalizeSession(session);
  const reference = session.messages[0].content[0];
  assert.throws(() => media.hydrateMessages([{ content: [{ ...reference, bridgeImageRef: '../private' }] }]), /Invalid/);
  assert.throws(() => media.hydrateMessages([{ content: [{ ...reference, bridgeImageRef: 'b'.repeat(64) }] }]), /ENOENT/);
  fs.writeFileSync(path.join(root, 'state', 'pi', 'media', reference.bridgeImageRef + '.b64'), 'corrupt');
  assert.throws(() => media.hydrateMessages(session.messages), /checksum/);
  assert.throws(() => media.externalizeContent([{ ...image, data: 'a'.repeat(24 * 1024 * 1024 + 1) }]), /size limit/);
});

test('actual Pi SDK sends hydrated image bytes while checkpoints/restarts retain small references', async t => {
  const { root } = fixture(t);
  const project = fileURLToPath(new URL('..', import.meta.url));
  const sdkDir = path.join(root, 'runtime', 'pi');
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.writeFileSync(path.join(sdkDir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(sdkDir, 'sdk.js'), `export * from ${JSON.stringify(pathToFileURL(path.join(project, 'runtime/pi/sdk.js')).href)};`);
  const preset = path.join(root, 'dsh/agent-presets/qq-chat-v2');
  fs.mkdirSync(preset, { recursive: true });
  fs.writeFileSync(path.join(preset, 'agent.cordis.yml'), '- id: persona\n  config:\n    prefix: fixture\n');
  const requests = [];
  const toolName = 'mcp__snowluma__qq_get_message_images';
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    const second = requests.length > 1;
    const delta = second ? { role: 'assistant', content: 'image seen' } : { role: 'assistant', tool_calls: [{ index: 0, id: 'media-call', type: 'function', function: { name: toolName, arguments: '{}' } }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [part, finish_reason] of [[delta, null], [{}, second ? 'stop' : 'tool_calls']]) {
      res.write('data: ' + JSON.stringify({ id: 'media-test', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: part, finish_reason }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = { provider: 'apimart', model: 'qwen3.8-flash', baseURL: `http://127.0.0.1:${server.address().port}/v1`, thinkingLevel: 'off', maxTokens: 64, maxCallsPerTurn: 3,
    apiKeyEnv: 'MEDIA_FIXTURE_KEY', credentialSource: 'file', credentialFile: path.join(root, 'fixture.env') };
  fs.writeFileSync(config.credentialFile, 'MEDIA_FIXTURE_KEY=fixture-only\n');
  const tools = [{ name: toolName, label: 'fixture image', description: 'fixture', parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }, { ...image }] }) }];
  const client = new PiApiClient({ root, config, tools, rolePrompt: () => 'fixture' });
  let restored;
  try {
    const workspaceId = (await client.workspace.create({ path: path.join(root, 'agent') })).result.value.workspace.workspaceId;
    const sessionId = (await client.sessions.create({ workspaceId, agentPreset: 'qq-chat-v2' })).result.value.sessionId;
    await client.sessions.prompt({ sessionId, content: [{ type: 'text', text: 'look at image' }] });
    await client.loadSession(sessionId).runPromise;
    const session = client.loadSession(sessionId);
    assert.equal(session.records.at(-1).data.reason.kind, 'completed');
    assert.equal(requests.length, 2);
    assert.ok(JSON.stringify(requests[1]).includes('data:image/png;base64,' + image.data));
    const archiveFile = path.join(root, 'state/pi/sessions', sessionId + '.json');
    const archived = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
    assert.ok(!JSON.stringify(archived).includes(image.data));
    assert.ok(JSON.stringify(archived).includes('bridgeImageRef'));
    await client.dispose();
    restored = new PiApiClient({ root, config, tools });
    assert.equal(restored.loadSession(sessionId).messages.length, session.messages.filter(m => m.role !== 'system').length);
    assert.ok(JSON.stringify(restored.mediaStore.hydrateMessages(projectPiContext(restored.loadSession(sessionId).messages))).includes(image.data));
    // Also migrate a legacy inline archive without changing message/event counts.
    const legacy = structuredClone(archived);
    for (const m of legacy.messages) if (m.role === 'toolResult') m.content = [{ ...image }];
    const beforeRecords = legacy.records.length;
    fs.writeFileSync(archiveFile, JSON.stringify(legacy));
    await restored.dispose(); restored = new PiApiClient({ root, config, tools });
    const migrated = restored.loadSession(sessionId);
    assert.equal(migrated.records.length, beforeRecords);
    assert.equal(migrated.messages.length, legacy.messages.filter(m => m.role !== 'system').length);
    assert.ok(!fs.readFileSync(archiveFile, 'utf8').includes(image.data));
  } finally {
    await client.dispose(); await restored?.dispose();
    await new Promise(resolve => server.close(resolve));
  }
});
