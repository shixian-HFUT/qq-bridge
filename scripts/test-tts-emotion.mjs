import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { synthesizeSpeech } from '../src/aliyun-tts.js';
import { normalizeSpeechEmotion, SPEECH_EMOTIONS } from '../src/speech-emotion.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-emotion-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('qq-emotion-'));
    fs.rmSync(root, { recursive: true });
  });
  return root;
}

function wav() {
  const b = Buffer.alloc(48044);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(48000, 40);
  return b;
}

test('default request is unchanged; emotion is separate from text and distinguishes paid synthesis cache entries', async t => {
  const root = temporary(t), requests = [];
  const config = { model: 'qwen-audio-3.1-tts-flash', voiceId: 'qwen-audio-3.1-tts-flash-fixture', apiKey: 'fixture', workspaceId: 'fixture', region: 'cn-beijing' };
  const options = { config, fetchImpl: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ output: { audio: { url: 'https://fixture.oss-cn-beijing.aliyuncs.com/test.wav' } } }));
  }, download: async () => ({ buffer: wav() }) };
  const text = '博士，你来啦。';
  assert.equal((await synthesizeSpeech(root, text, options)).emotion, 'neutral');
  await synthesizeSpeech(root, text, { ...options, emotion: 'neutral' });
  assert.equal(requests.length, 1, 'neutral must reuse the old/default cache');
  assert.deepEqual(requests[0], { model: config.model, input: { text, voice: config.voiceId, format: 'wav', sample_rate: 24000, rate: 1, language_hints: ['zh'], word_timestamp_enabled: true } });
  await synthesizeSpeech(root, text, { ...options, emotion: 'happy' });
  await synthesizeSpeech(root, text, { ...options, emotion: 'shy' });
  await synthesizeSpeech(root, text, { ...options, emotion: 'happy' });
  assert.equal(requests.length, 3);
  assert(requests.every(r => r.input.text === text && r.input.voice === config.voiceId));
  assert.match(requests[1].input.instruction, /开心/);
  assert.match(requests[2].input.instruction, /羞涩/);
  assert.notEqual(requests[1].input.instruction, requests[2].input.instruction);
});

test('invalid emotions and unsupported models are rejected before paid synthesis', async t => {
  const root = temporary(t); let requests = 0;
  const config = { model: 'qwen-audio-3.1-tts-flash', voiceId: 'qwen-audio-3.1-tts-flash-fixture' };
  const options = { config, fetchImpl: async () => { requests++; throw Error('must not call'); } };
  for (const emotion of ['anything', '__proto__', '', null, {}, 1]) {
    await assert.rejects(synthesizeSpeech(root, '你好。', { ...options, emotion }), /不支持的语音情绪/);
  }
  await assert.rejects(synthesizeSpeech(root, '你好。', { ...options, config: { model: 'legacy', voiceId: 'legacy-fixture' }, emotion: 'happy' }), /未接入情绪/);
  assert.equal(requests, 0);
  assert.equal(fs.existsSync(path.join(root, 'state/tts-cache')), false);
  assert.equal(normalizeSpeechEmotion(undefined), 'neutral');
  assert.equal(SPEECH_EMOTIONS.length, 13);
});

test('actual HTTP speech route forwards emotion, preserves send verification, and cannot bypass dedup by changing emotion', async t => {
  const syntheses = [];
  const h = await bridgeHarness({ globals: {
    loadTtsConfig: () => ({ enabled: true, approved: true, autonomous: true, roleName: '守岸人', maxChars: 120 }),
    synthesizeLocal: async (_root, text, options) => { syntheses.push({ text, options }); return { file: '/fixture.wav', detail: { seconds: 1 } }; },
    inspectAudio: async () => ({ ok: true, seconds: 1, bytes: 44, format: 'wav' }),
  } });
  t.after(() => h.close()); h.setMode('reserved2');
  fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), '{"role":"守岸人"}');
  const st = h.getSocialV2State('group:456'), server = h.startConsoleServer();
  if (!server.listening) await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const request = async (text, emotion, token = st.agentToken) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/speak`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': token },
      body: JSON.stringify({ key: 'group:456', text, ...(emotion === undefined ? {} : { emotion }) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const first = await request('今天真高兴。', 'happy');
  assert.equal(first.status, 200); assert.equal(first.data.emotion, 'happy'); assert.equal(first.data.verified, true);
  assert.equal(syntheses[0].options.emotion, 'happy');
  const duplicate = await request('今天真高兴。', 'sad');
  assert.equal(duplicate.data.emotion, 'happy', 'must report the cached actual delivery rather than claim a different emotion');
  assert.equal(syntheses.length, 1);
  const invalid = await request('无效情绪不会付费。', 'anything');
  assert.equal(invalid.status, 400); assert.equal(syntheses.length, 1);
  const rejected = await request('没有令牌不会付费。', 'happy', 'wrong-token');
  assert(rejected.status >= 400); assert.equal(syntheses.length, 1);
  const fallback = await request('这次没有指定情绪。');
  assert.equal(fallback.status, 200); assert.equal(fallback.data.emotion, 'neutral');
  assert.equal(syntheses[1].options.emotion, 'neutral');
});

test('actual MCP tool exposes bounded emotions and forwards the optional value without speaking it', async () => {
  const source = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf("server.tool(\n  'qq_speak',"), end = source.indexOf('if (cfg.socialV2?.voice?.enabled', start);
  assert(start > 0 && end > start);
  let handler, enumValues, sent;
  const chain = new Proxy({}, { get: () => () => chain });
  const context = vm.createContext({ SPEECH_EMOTIONS, server: { tool: (_n, _d, _s, fn) => { handler = fn; } },
    z: { string: () => chain, enum: values => { enumValues = values; return chain; } }, serializeModelData: JSON.stringify,
    agentApi: async (_route, options) => { sent = JSON.parse(options.body); return { ok: true }; },
  });
  vm.runInContext(source.slice(start, end), context);
  assert.deepEqual([...enumValues], [...SPEECH_EMOTIONS]);
  await handler({ key: 'group:456', token: 'fixture', text: '博士，你来啦。', emotion: 'shy' });
  assert.equal(sent.emotion, 'shy'); assert.equal(sent.text, '博士，你来啦。');
  await handler({ key: 'group:456', token: 'fixture', text: '你好。' });
  assert.equal(Object.hasOwn(sent, 'emotion'), false);
});
