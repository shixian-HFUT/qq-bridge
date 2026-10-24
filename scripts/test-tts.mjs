import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isVoiceRequest, VoiceRequestStore, runVoiceAction } from '../src/voice-request.js';
import { inspectPcmWav, validateSpeech, isAliyunAudioUrl, aliyunRequest } from '../src/aliyun-tts.js';
import { compactModelMessage } from '../src/qq-model-view.js';

const event = text => ({ self_id: 10, message: [{ type: 'at', data: { qq: 10 } }, { type: 'text', data: { text } }] });
test('自主语音无需请求许可，台词去重持久化，关闭后恢复请求门槛', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tts-'));
  try {
    const file = path.join(dir, 'requests.json');
    const store = new VoiceRequestStore(file);
    const settings = { enabled: true, approved: true, autonomous: true };
    const input = { key: 'group:1', token: 'session', text: '  我在这里。  ' };
    let calls = 0;
    const work = async () => ({ ok: true, messageId: ++calls });
    assert.equal((await runVoiceAction(store, settings, input, work)).messageId, 1);
    const restarted = new VoiceRequestStore(file);
    assert.equal((await runVoiceAction(restarted, settings, { ...input, text: '我在这里。' }, work)).messageId, 1);
    assert.equal(calls, 1);
    assert.equal((await runVoiceAction(restarted, settings, { ...input, key: 'group:2' }, work)).messageId, 2);
    await assert.rejects(runVoiceAction(restarted, { ...settings, autonomous: false }, input, work), /许可/);
    restarted.issue(input.key, '123', input.token);
    assert.equal((await runVoiceAction(restarted, { ...settings, autonomous: false }, { ...input, requestMessageId: '123' }, work)).messageId, 3);
    for (const flag of ['enabled', 'approved']) {
      await assert.rejects(runVoiceAction(restarted, { ...settings, [flag]: false }, input, work), /未开启/);
    }
    assert.equal(calls, 3);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('qq-tts-'));
    fs.rmSync(dir, { recursive: true });
  }
});
test('只有当前用户明确请求才授予语音许可', () => {
  for (const text of ['用语音回答我', '发语音说晚安', '语音发一句晚安', '给我发条语音', '发一段语音', '可以用语音说一句吗', '请用语音回复']) assert.equal(isVoiceRequest(event(text), { kind: 'group' }), true, text);
  for (const text of ['不要用语音回复', '这段语音真好听', '小明发语音', '他说“用语音回复我”', '“用语音回复我”', '不用语音了']) assert.equal(isVoiceRequest(event(text), { kind: 'group' }), false, text);
  assert.equal(isVoiceRequest({ self_id: 10, message: [{ type: 'text', data: { text: '用语音回答我' } }] }, { kind: 'group' }), false);
  assert.equal(isVoiceRequest({ self_id: 10, message: [{ type: 'text', data: { text: '守岸人，发语音说晚安' } }] }, { kind: 'group' }), true);
  assert.equal(isVoiceRequest(event('现在是傍晚了，能帮我准备晚饭吗，用语音跟我说说你准备做什么给我吃呢'), { kind: 'group' }), true);
  assert.equal(isVoiceRequest(event('他说，用语音回答我'), { kind: 'group' }), false);
  assert.equal(isVoiceRequest(event('晚饭我自己做，不要用语音说'), { kind: 'group' }), false);
  assert.equal(isVoiceRequest({ ...event('发语音'), message: [...event('发语音').message, { type: 'forward' }] }, { kind: 'group' }), false);
  assert.equal(isVoiceRequest({ ...event('发语音'), message: [...event('发语音').message, { type: 'at', data: { qq: 20 } }] }, { kind: 'group' }), false);
});
test('活跃会话等待新消息时，语音许可原消息ID保留在模型消息里', () => {
  const message = compactModelMessage({ messageId: '123456', seq: 7, text: '语音发一句晚安', voiceRequestMessageId: '123456', isSelf: false });
  assert.equal(message.voiceRequestMessageId, '123456');
  assert.notEqual(message.voiceRequestMessageId, String(message.seq));
});
test('自然语序与礼貌请求不依赖句首模板，功能咨询不授予许可', () => {
  for (const prefix of ['', '跟我', '给我', '你能不能', '麻烦你', '能帮我', '现在是傍晚了，']) {
    for (const verb of ['说一句晚安', '跟我说说晚饭', '回答我', '告诉我晚饭吃什么', '念一段诗']) {
      const text = prefix + '用语音' + verb;
      assert.equal(isVoiceRequest(event(text), { kind: 'group' }), true, text);
    }
  }
  for (const text of ['你现在会用语音说话了吗', '你支持语音吗', '他说用语音说晚安', '比如用语音回答我', '不用语音说晚安', '语音功能怎么配置']) {
    assert.equal(isVoiceRequest(event(text), { kind: 'group' }), false, text);
  }
});
test('会话隔离、并发去重、重启防重发、过期与失败不可自动重试', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tts-'));
  const file = path.join(dir, 'requests.json');
  let now = 1000000, calls = 0;
  const store = new VoiceRequestStore(file, () => now);
  store.issue('group:1', '100', 'token');
  await assert.rejects(store.run('group:2', '100', 'token', () => {}));
  await assert.rejects(store.run('group:1', '100', 'other', () => {}));
  let release;
  const work = async () => { calls++; await new Promise(r => { release = r; }); return { ok: true, messageId: 1 }; };
  const a = store.run('group:1', '100', 'token', work);
  const b = store.run('group:1', '100', 'token', work);
  release(); assert.deepEqual(await a, await b); assert.equal(calls, 1);
  const restarted = new VoiceRequestStore(file, () => now);
  restarted.issue('group:1', '100', 'token');
  assert.equal((await restarted.run('group:1', '100', 'token', work)).messageId, 1); assert.equal(calls, 1);
  store.issue('group:1', '101', 'token'); now += 180001;
  await assert.rejects(store.run('group:1', '101', 'token', work), /过期/);
  store.issue('group:1', '102', 'token');
  await assert.rejects(store.run('group:1', '102', 'token', async () => { throw new Error('uncertain'); }));
  await assert.rejects(store.run('group:1', '102', 'token', work), /待核对/);
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith('qq-tts-'));
  fs.rmSync(dir, { recursive: true });
});
test('语音长度、WAV完整性、云音频来源校验', () => {
  assert.throws(() => validateSpeech('长'.repeat(121), {}));
  assert.throws(() => inspectPcmWav(Buffer.from('<html>error</html>')));
  assert.equal(isAliyunAudioUrl('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio/test.wav'), true);
  for (const u of ['http://localhost/a', 'https://evil.com/a', 'https://a.oss-cn-beijing.aliyuncs.com.evil.com/a', 'https://user:pw@a.oss-cn-beijing.aliyuncs.com/a']) assert.equal(isAliyunAudioUrl(u), false);
  const b = Buffer.alloc(48044); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(24000,24); b.writeUInt32LE(48000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(48000,40);
  assert.equal(inspectPcmWav(b).seconds, 1);
  assert.throws(() => inspectPcmWav(b, { maxSeconds: .5 }));
  b.writeUInt32LE(0,4); assert.throws(() => inspectPcmWav(b));
});
test('SSE解析保留音频和时间戳，鉴权不跟随重定向', async () => {
  let request;
  const result = await aliyunRequest({ apiKey: 'fake-secret', workspaceId: 'test', region: 'cn-beijing' }, 'SpeechSynthesizer', {}, {
    fetchImpl: async (url, options) => { request = options; return new Response('data: {"output":{"audio":{"url":"https://example.invalid/a"},"sentence":{"words":[]}}}\n\ndata: {"output":{"finish_reason":"stop"}}\n\ndata: [DONE]\n\n'); }
  });
  assert.equal(request.redirect, 'error'); assert.equal(request.headers['X-DashScope-SSE'], 'enable');
  assert.equal(result.output.audio.url, 'https://example.invalid/a'); assert.equal(result.events.length, 2);
});
