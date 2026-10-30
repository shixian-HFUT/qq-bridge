import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { buildStickerCadenceHint, noteReplyWithoutSticker, noteStickerSent, normalizeStickerCadence } from '../src/sticker-cadence.js';
import { planVoiceReply } from '../src/voice-cadence.js';
import { buildGroupVoiceHint } from '../src/group-voice.js';

test('sticker reminder starts after three replies, resets on confirmed sticker and stays conversation-local', () => {
  const st = {}, other = {};
  for (let n = 0; n < 3; n++) { assert.equal(buildStickerCadenceHint(st), ''); noteReplyWithoutSticker(st); }
  assert.match(buildStickerCadenceHint(st), /连续3次实际回复/);
  assert.match(buildStickerCadenceHint(st), /若本轮是轻松闲聊/);
  assert.match(buildStickerCadenceHint(st), /严肃话题/);
  assert.equal(buildStickerCadenceHint(other), '');
  noteStickerSent(st, 1000); assert.equal(buildStickerCadenceHint(st), ''); assert.equal(st.stickerCadence.lastStickerAt, 1000);
  assert.equal(normalizeStickerCadence({ repliesWithoutSticker: -8 }).repliesWithoutSticker, 0);
  assert.equal(normalizeStickerCadence({ repliesWithoutSticker: 1000 }).repliesWithoutSticker, 100);
});

test('private routing is restored to four texts, three-minute spacing and its original text preference', () => {
  const now = 1000000, st = { voiceCadence: { textTurns: 2, preference: 'auto', lastVoiceAt: 0, retryAfter: 0 } };
  const input = { key: 'private:123', token: 'fixture', st, messages: ['今天辛苦了，我在这里陪你。'],
    settings: { enabled: true, approved: true, autonomous: true }, roleAllowed: true, now };
  assert.equal(planVoiceReply(input).kind, 'text'); assert.equal(buildGroupVoiceHint(input), '');
  st.voiceCadence.textTurns = 3; assert.equal(planVoiceReply(input).kind, 'text');
  st.voiceCadence.textTurns = 4; assert.equal(planVoiceReply(input).kind, 'voice');
  st.voiceCadence.lastVoiceAt = now - 179999;
  assert.equal(planVoiceReply(input).kind, 'text');
  st.voiceCadence.lastVoiceAt = now - 180000; assert.equal(planVoiceReply(input).kind, 'voice');
  st.voiceCadence.preference = 'text'; assert.equal(planVoiceReply(input).kind, 'text');
  assert.equal(buildGroupVoiceHint({ ...input, key: 'group:456', roleAllowed: false }), '');
  assert.equal(buildGroupVoiceHint({ ...input, key: 'group:456', settings: { ...input.settings, autonomous: false } }), '');
});

async function fixture(t) {
  let failImage = false, sends = 0;
  const h = await bridgeHarness({ globals: {
    loadTtsConfig: () => ({ enabled: true, approved: true, autonomous: true, roleName: '阿米娅', maxChars: 120 }),
    safeFetchBuffer: async () => ({ buffer: Buffer.from('fixture-image') }),
    fetch: async (_url, options) => {
      if (options?.body && JSON.parse(options.body).message?.some(s => s.type === 'image') && failImage) throw Error('unknown delivery');
      sends++; return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
    } } });
  h.setMode('reserved2'); fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify({ role: '阿米娅' }));
  const key = 'group:456', st = h.getSocialV2State(key), server = h.startConsoleServer();
  // This suite exercises repeated explicit replies; ambient pacing has its own suite.
  st.lastWakeReason = 'atMention';
  h.cfg.socialV2.send.maxSendPerMinute = 100; h.cfg.socialV2.send.maxSendPerHour = 100;
  if (!server.listening) await once(server, 'listening');
  t.after(async () => { await new Promise(r => server.close(r)); await h.close(); });
  const request = async (route, body, token = st.agentToken, targetKey = key) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/${route}?key=${targetKey}`, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': token },
      ...(body ? { body: JSON.stringify({ key: targetKey, ...body }) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  return { h, st, key, request, failImage() { failImage = true; }, sends: () => sends };
}

test('actual HTTP counts reply calls once per multi-text batch; confirmed attachments reset the reminder', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) {
    const response = await f.request('send-message', { messages: ['好耶', '今天真开心'] });
    assert.equal(response.data.ok, true, JSON.stringify(response.data)); assert.equal(f.st.stickerCadence.repliesWithoutSticker, i + 1);
  }
  for (const reason of ['bootstrap', 'continuation', 'atMention']) assert.match(f.h.buildWakePromptV2(f.key, reason), /连续3次实际回复/);
  const prompt = await f.request('prompt'); assert.equal(prompt.data.stickers.cadence.repliesWithoutSticker, 3);
  assert.match(prompt.data.stickers.cadenceHint, /优先配1张/);
  const attached = await f.request('send-message', { messages: '好耶', stickerId: 'fixture-sticker' });
  assert.equal(attached.data.stickerResult.sent, 1); assert.equal(f.st.stickerCadence.repliesWithoutSticker, 0);
  assert.doesNotMatch(f.h.buildWakePromptV2(f.key, 'continuation'), /【表情节奏】/);
});

test('failed optional sticker and blocked sends cannot falsely clear or increment reply cadence', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) f.h.recordSentMessagesV2(f.key, ['好耶']);
  const before = f.sends();
  const blocked = await f.request('send-message', { messages: '不会发出' }, 'wrong-token');
  assert.equal(blocked.status, 403); assert.equal(f.st.stickerCadence.repliesWithoutSticker, 3); assert.equal(f.sends(), before);
  f.failImage();
  const response = await f.request('send-message', { messages: '正文仍在', stickerId: 'fixture-sticker' });
  assert.equal(response.data.ok, true); assert.equal(response.data.stickerResult.status, 'unknown');
  assert.equal(f.st.stickerCadence.repliesWithoutSticker, 4);
  f.h.recordSentMessagesV2(f.key, ['[图片×2]'], { mediaOnly: true }); assert.equal(f.st.stickerCadence.repliesWithoutSticker, 4);
});

test('sticker counts survive restart and reminders honor sticker/tool/prompt switches', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) f.h.recordSentMessagesV2(f.key, ['开心']);
  const saved = JSON.parse(fs.readFileSync(path.join(f.h.temp, 'state/social-v2.json')));
  const h2 = await bridgeHarness({ savedSocialState: saved }); t.after(() => h2.close()); h2.setMode('reserved2');
  assert.equal(h2.getSocialV2State(f.key).stickerCadence.repliesWithoutSticker, 3);
  assert.match(h2.buildWakePromptV2(f.key, 'continuation'), /连续3次实际回复/);
  for (const field of ['enabled', 'includeInPrompt']) {
    h2.cfg.socialV2.sticker = { enabled: true, includeInPrompt: true, [field]: false };
    assert.doesNotMatch(h2.buildWakePromptV2(f.key, 'continuation'), /【表情节奏】/);
  }
  h2.cfg.socialV2.sticker = { enabled: true, includeInPrompt: true }; h2.cfg.socialV2.tools.sendSticker = false;
  assert.doesNotMatch(h2.buildWakePromptV2(f.key, 'continuation'), /【表情节奏】/);
});

test('live group voice cadence appears in wakes and capabilities while private hints return to the old policy', async t => {
  const f = await fixture(t), privateKey = 'private:123', privateState = f.h.getSocialV2State(privateKey);
  privateState.voiceCadence = { textTurns: 4, preference: 'auto', lastVoiceAt: 0, retryAfter: 0 };
  f.st.voiceCadence = { textTurns: 4, preference: 'auto', lastVoiceAt: 0, retryAfter: 0 };
  for (const reason of ['bootstrap', 'continuation', 'atMention']) assert.match(f.h.buildWakePromptV2(f.key, reason), /【群聊语音节奏】已累计4次文字回复/);
  const response = await f.request('prompt', undefined, privateState.agentToken, privateKey);
  assert.equal(response.data.speech.cadenceHint, ''); assert.match(response.data.speech.hint, /每3～5次/);
  assert.doesNotMatch(f.h.buildWakePromptV2(privateKey, 'continuation'), /【群聊语音/);
  const group = await f.request('prompt'); assert.match(group.data.speech.cadenceHint, /已累计4次文字回复/);
  assert.match(group.data.speech.hint, /至少间隔5分钟/);
  f.h.cfg.socialV2.tools.speak = false; assert.doesNotMatch(f.h.buildWakePromptV2(f.key, 'continuation'), /【群聊语音/);
});
