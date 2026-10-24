import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { compactModelMessage, compactModelData, serializeModelData } from '../src/qq-model-view.js';
import { containsUnsafeModelText, maskModelText, safeModelDisplayName } from '../src/model-safety.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shortMessage = {
  seq: 21, messageId: '-2026', sender: '小明', userId: '10001',
  text: '刚刚那个梗笑死我了', plain: '刚刚那个梗笑死我了', tail: '刚刚那个梗笑死我了',
  quoteTargetIsSelf: false, isOwner: false, ownerLabel: '', isSelf: false,
  media: [], hasMedia: false, forwardIds: [], hasForward: false, time: 1789680000000
};

test('unsafe display names fall back to stable identity while ordinary names remain unchanged', () => {
  assert.equal(safeModelDisplayName('半瘫少女在线足♀交吗', '2262232408'), '群友(2262232408)');
  assert.equal(safeModelDisplayName('足 交', '42'), '群友(42)');
  assert.equal(safeModelDisplayName('足交', ''), '群友');
  assert.equal(safeModelDisplayName('小明', '10001'), '小明');
  assert.equal(safeModelDisplayName('', '10001'), '群友(10001)');
  assert.equal(containsUnsafeModelText('足♀交'), true);
  assert.equal(maskModelText('他说足♀交'), '他说***');
  assert.equal(maskModelText('这题真牛逼'), '这题真牛逼');
});

test('model messages mask unsafe sender and body without touching stored input', () => {
  const stored = {
    seq: 22, messageId: '-2027', sender: '半瘫少女在线足♀交吗', userId: '2262232408',
    text: '他说足交', plain: '他说足交', tail: '他说足交',
    quote: { sender: '牛至', text: '引用足交' },
    quoteTargetIsSelf: false, isSelf: false, media: [], forwardIds: [], time: 1
  };
  const snapshot = structuredClone(stored);
  const model = compactModelMessage(stored);
  assert.deepEqual(stored, snapshot);
  assert.equal(model.sender, '群友(2262232408)');
  assert.equal(model.text, '他说***');
  assert.equal('plain' in model, false);
  assert.equal('tail' in model, false);
  assert.equal(model.quote.sender, '群友');
  assert.equal(model.quote.text, '引用***');
});

test('recursive model data sanitizes member identities and nested sender objects', () => {
  const data = {
    members: [{ sender: '足交', userId: '1', count: 2 }],
    info: { sender: '牛至', userId: '2', text: '足交' },
    groupMembers: [{ user_id: '3', nickname: '小明', card: '足♀交' }],
    raw: { sender: { user_id: '4', card: '牛至', nickname: '普通' }, message: [{ data: { text: '足交' } }] }
  };
  const model = compactModelData(data);
  assert.equal(model.members[0].sender, '群友(1)');
  assert.equal(model.info.sender, '群友(2)');
  assert.equal(model.info.text, '***');
  assert.equal(model.groupMembers[0].nickname, '小明');
  assert.equal(model.groupMembers[0].card, '群友(3)');
  assert.equal(model.raw.sender.card, '群友(4)');
  assert.equal(model.raw.sender.nickname, '普通');
  assert.equal(model.raw.message[0].data.text, '***');
});

test('short messages retain identity and text once, including zero-valued timestamps', () => {
  assert.deepEqual(compactModelMessage({ ...shortMessage, time: 0 }), {
    seq: 21, messageId: '-2026', sender: '小明', userId: '10001',
    text: shortMessage.text, time: 0
  });
});

test('long messages, resolved quotes and whitespace differences are not truncated or deduplicated', () => {
  const message = {
    seq: 22, text: '群友说：' + '很长的正文'.repeat(100),
    plain: '引用[小明]：上一条消息；' + '很长的正文'.repeat(100),
    tail: '最后的约定：明晚八点再聊', replyToMessageId: '-2026',
    quoteTargetIsSelf: true, quote: { sender: '我', text: '等你回复' }
  };
  assert.deepEqual(compactModelMessage(message), message);
  assert.deepEqual(compactModelMessage({ text: '好', plain: '好 ', tail: ' 好' }), {
    text: '好', plain: '好 ', tail: ' 好'
  });
  assert.deepEqual(compactModelMessage({ plain: '只有 plain', tail: '只有 plain' }), { plain: '只有 plain' });
});

test('local media preserve message handles, ordering, face IDs, captions and forward IDs', () => {
  const message = {
    ...shortMessage, text: '[图片][表情#66][转发消息 id=abc]', plain: '', tail: '',
    media: [
      { kind: 'image', file: 'private-image-id', url: 'https://example.invalid/image?signature=long', caption: '比赛结果' },
      { kind: 'face', faceId: '66', url: 'https://example.invalid/face', file: '' }
    ],
    hasMedia: true, forwardIds: ['abc'], hasForward: true
  };
  const compact = compactModelMessage(message);
  assert.equal(compact.seq, 21);
  assert.equal(compact.messageId, '-2026');
  assert.deepEqual(compact.media, [
    { kind: 'image', caption: '比赛结果', index: 1 },
    { kind: 'face', faceId: '66', index: 2 }
  ]);
  assert.equal(compact.hasMedia, true);
  assert.deepEqual(compact.forwardIds, ['abc']);
  assert.equal(compact.hasForward, true);
});

test('forwarded and legacy messages retain otherwise unresolvable media references', () => {
  const message = {
    index: 1, messageId: 'forward-node-id', messageSeq: 21,
    text: '转发图片', nestedForwardIds: ['nested-id'],
    media: [
      { kind: 'image', url: 'https://example.invalid/1', file: 'https://example.invalid/1' },
      { kind: 'image', url: 'https://example.invalid/2', file: 'different-file-id' }
    ]
  };
  const compact = compactModelMessage(message);
  assert.deepEqual(compact.nestedForwardIds, ['nested-id']);
  assert.equal(compact.media[0].url, message.media[0].url);
  assert.equal('file' in compact.media[0], false);
  assert.deepEqual(compact.media[1], message.media[1]);
});

test('bot messages lose erroneous owner identity; real owner and unrelated fields survive', () => {
  const message = {
    messageId: null, userId: null, text: '我来啦', plain: '我来啦',
    isSelf: true, isOwner: true, ownerLabel: '我', kind: 'poke',
    poke: { targetId: '123', targetIsSelf: false, groupId: null },
    extension: { enabled: false, empty: '', list: [] }, futureFlag: false,
    media: [], forwardIds: [], nestedForwardIds: []
  };
  const compact = compactModelMessage(message);
  assert.deepEqual(compact, {
    text: '我来啦', isSelf: true, kind: 'poke',
    poke: message.poke, extension: message.extension, futureFlag: false
  });
  assert.equal(message.isOwner, true, 'the model view must not rewrite stored input');
  assert.equal(message.ownerLabel, '我');
  const ownerMessage = compactModelMessage({
    userId: '123', text: '这是管理员的消息', isSelf: false, isOwner: true, ownerLabel: '管理员'
  });
  assert.equal(ownerMessage.isOwner, true, 'real owner messages retain their identity');
  assert.equal(ownerMessage.ownerLabel, '管理员');
  for (const item of [null, undefined, 'string', 1, false, []]) {
    assert.equal(compactModelMessage(item), item);
  }
});

test('only messages/newMessages arrays are compacted; envelope fields and input remain intact', () => {
  const original = {
    ok: true, readThroughSeq: 21, timeout: false, note: '',
    config: { disabled: false, names: [] },
    messages: [shortMessage], newMessages: [shortMessage],
    info: shortMessage, recentMessages: [shortMessage],
    nestedPreviews: [{ id: 'nested', messages: [shortMessage], truncated: false }]
  };
  const snapshot = structuredClone(original);
  Object.freeze(shortMessage);
  Object.freeze(shortMessage.media);
  Object.freeze(shortMessage.forwardIds);
  const compact = compactModelData(original);
  assert.deepEqual(original, snapshot);
  assert.equal('plain' in compact.messages[0], false);
  assert.equal('plain' in compact.newMessages[0], false);
  assert.equal('plain' in compact.nestedPreviews[0].messages[0], false);
  assert.deepEqual(compact.info, shortMessage);
  assert.deepEqual(compact.recentMessages, [shortMessage]);
  assert.deepEqual(compact.config, original.config);
  assert.equal(compact.timeout, false);
  assert.equal(compact.note, '');
  assert.equal(compact.readThroughSeq, 21);
  assert.equal(serializeModelData(original), JSON.stringify(compact));
  assert.deepEqual(compactModelData({ messages: ['a', 'b'] }), { messages: ['a', 'b'] });
});

test('synthetic payload size comparison (characters, not measured token usage)', () => {
  const sample = { ok: true, key: 'group:123', readThroughSeq: 40, messages: Array.from({ length: 40 }, (_, i) => ({
    ...shortMessage, seq: i + 1, messageId: String(1000 + i),
    text: `第${i + 1}条：晚上还在群里聊刚刚那个故事`,
    plain: `第${i + 1}条：晚上还在群里聊刚刚那个故事`,
    tail: `第${i + 1}条：晚上还在群里聊刚刚那个故事`
  })) };
  const before = JSON.stringify(sample, null, 2).length;
  const minifiedOnly = JSON.stringify(sample).length;
  const after = serializeModelData(sample).length;
  assert.ok(after < minifiedOnly);
  console.log(`Synthetic 40-message payload: ${before} -> ${after} characters (${(after / before * 100).toFixed(1)}% remaining); minified-only=${minifiedOnly}. This is not a billing/token benchmark.`);
});

test('MCP validates/forwards read watermarks and wait purposes against an isolated local API', async () => {
  const requests = [];
  const api = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, body: raw ? JSON.parse(raw) : null, token: req.headers['x-agent-token'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, readThroughSeq: 21, messages: [shortMessage], accepted: raw ? JSON.parse(raw) : null }));
  });
  await new Promise((resolve, reject) => {
    api.once('error', reject);
    api.listen(0, '127.0.0.1', resolve);
  });
  let fixture;
  let client;
  try {
    // Descendant modules resolve the project's dependencies; no credentials,
    // live config or user runtime state are copied into this test fixture.
    fixture = await fs.mkdtemp(path.join(ROOT, '.tmp-model-view-test-'));
    await fs.mkdir(path.join(fixture, 'src'));
    await Promise.all(['mcp-snowluma-safe.js', 'qq-model-view.js', 'model-safety.js', 'sensitive.js'].map((name) =>
      fs.copyFile(path.join(ROOT, 'src', name), path.join(fixture, 'src', name))));
    await fs.writeFile(path.join(fixture, 'config.json'), JSON.stringify({ consolePort: api.address().port }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(fixture, 'src', 'mcp-snowluma-safe.js')], cwd: fixture, stderr: 'pipe'
    });
    client = new Client({ name: 'qq-model-view-test', version: '1.0.0' });
    await client.connect(transport);
    const listed = await client.listTools();
    for (const name of ['qq_mark_read', 'qq_set_wake_config']) {
      const schema = listed.tools.find((tool) => tool.name === name).inputSchema;
      assert.equal(schema.properties.throughSeq.type, 'integer');
      assert.equal(schema.properties.throughSeq.minimum, 0);
      assert.equal(schema.properties.throughSeq.maximum, Number.MAX_SAFE_INTEGER);
      assert.equal(schema.required.includes('throughSeq'), false);
    }
    const waitSchema = listed.tools.find((tool) => tool.name === 'qq_wait_for_messages').inputSchema;
    assert.deepEqual(waitSchema.properties.purpose.enum, ['messages', 'reply']);
    assert.equal(waitSchema.required.includes('purpose'), false);
    const common = { key: 'group:123', token: 'fixture-token' };
    const read = await client.callTool({ name: 'qq_get_unread_messages', arguments: common });
    const readText = read.content.find((part) => part.type === 'text').text;
    const data = JSON.parse(readText);
    assert.equal(data.readThroughSeq, 21);
    assert.equal('plain' in data.messages[0], false);
    assert.equal(readText, JSON.stringify(data));

    await client.callTool({ name: 'qq_get_unread_messages', arguments: { ...common, afterSeq: 0, limit: 100 } });
    assert.equal(new URL(requests.at(-1).url, 'http://fixture').searchParams.get('afterSeq'), '0');
    await client.callTool({ name: 'qq_get_unread_messages', arguments: { ...common, afterSeq: 21 } });
    assert.equal(new URL(requests.at(-1).url, 'http://fixture').searchParams.get('afterSeq'), '21');
    for (const afterSeq of [-1, 1.5, '21', Number.MAX_SAFE_INTEGER + 1]) {
      const before = requests.length;
      const invalid = await client.callTool({ name: 'qq_get_unread_messages', arguments: { ...common, afterSeq } });
      assert.equal(invalid.isError, true);
      assert.equal(requests.length, before);
    }

    // Omission preserves the old wait contract, while reply explicitly selects
    // the short pre-reply quiet window. Both travel through the real MCP schema.
    await client.callTool({ name: 'qq_wait_for_messages', arguments: common });
    assert.equal(requests.at(-1).url, '/api/socialV2/wait');
    assert.deepEqual(requests.at(-1).body, { key: common.key });
    assert.equal(requests.at(-1).token, common.token);
    for (const purpose of ['messages', 'reply']) {
      await client.callTool({ name: 'qq_wait_for_messages', arguments: {
        ...common, purpose, timeoutMs: 30000, quietMs: 10000, minNewMessages: 1
      } });
      assert.deepEqual(requests.at(-1).body, {
        key: common.key, purpose, timeoutMs: 30000, minNewMessages: 1, quietMs: 10000
      });
    }
    for (const purpose of ['sleep', '', 1, null]) {
      const before = requests.length;
      const invalid = await client.callTool({ name: 'qq_wait_for_messages', arguments: { ...common, purpose } });
      assert.equal(invalid.isError, true);
      assert.equal(requests.length, before, `invalid wait purpose ${purpose} must not reach the API`);
    }

    await client.callTool({ name: 'qq_mark_read', arguments: { ...common, throughSeq: 21 } });
    assert.equal(requests.at(-1).url, '/api/socialV2/mark-read');
    assert.deepEqual(requests.at(-1).body, { key: common.key, throughSeq: 21 });
    assert.equal(requests.at(-1).token, common.token);

    await client.callTool({ name: 'qq_set_wake_config', arguments: { ...common, config: { mode: 'diving' }, throughSeq: 0 } });
    assert.equal(requests.at(-1).url, '/api/socialV2/wake-config');
    assert.deepEqual(requests.at(-1).body, { key: common.key, config: { mode: 'diving' }, throughSeq: 0 });
    await client.callTool({ name: 'qq_set_wake_config', arguments: { ...common, config: { mode: 'active' } } });
    assert.deepEqual(requests.at(-1).body, { key: common.key, config: { mode: 'active' } });

    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '21']) {
      const before = requests.length;
      for (const name of ['qq_mark_read', 'qq_set_wake_config']) {
        const invalid = await client.callTool({ name, arguments: { ...common, throughSeq: value, ...(name === 'qq_set_wake_config' ? { config: {} } : {}) } });
        assert.equal(invalid.isError, true);
      }
      assert.equal(requests.length, before, `invalid throughSeq ${value} must not reach the API`);
    }
  } finally {
    if (client) await client.close();
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
    if (fixture) {
      const resolved = path.resolve(fixture);
      assert.equal(path.dirname(resolved), ROOT);
      assert.ok(path.basename(resolved).startsWith('.tmp-model-view-test-'));
      await fs.rm(resolved, { recursive: true, force: true });
    }
  }
});
