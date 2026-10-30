import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { planGroupVoiceReply, buildGroupVoiceHint } from '../src/group-voice.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { VoiceRequestStore } from '../src/voice-request.js';

function input() {
  const now = Date.now();
  return { key: 'group:456', token: 'fixture', now, messages: ['今天心情真好，和你们聊聊天。'], roleAllowed: true,
    settings: { enabled: true, approved: true, autonomous: true, maxChars: 120 },
    st: { voiceCadence: { textTurns: 4, lastVoiceAt: 0, retryAfter: 0, preference: 'auto' }, recentMessages: [{ isSelf: false, text: '今天心情不错', time: now }] } };
}

test('group routing has its own four-text, five-minute, short-chat policy and never handles private replies', () => {
  const v = input(); assert.equal(planGroupVoiceReply(v).kind, 'voice');
  v.st.voiceCadence.textTurns = 3; assert.equal(planGroupVoiceReply(v).kind, 'text');
  v.st.voiceCadence.textTurns = 4; v.st.voiceCadence.lastVoiceAt = v.now - 299999;
  assert.equal(planGroupVoiceReply(v).kind, 'text'); assert.match(buildGroupVoiceHint(v), /冷却/);
  v.st.voiceCadence.lastVoiceAt = v.now - 300000; assert.equal(planGroupVoiceReply(v).kind, 'voice');
  for (const patch of [{ key: 'private:123' }, { roleAllowed: false }, { replyToMessageId: '1001' }, { atUserId: '123' },
    { settings: { ...v.settings, autonomous: false } }, { messages: ['这是长回答。'.repeat(20)] }, { messages: ['链接：https://example.com'] }]) assert.equal(planGroupVoiceReply({ ...v, ...patch }).kind, 'text');
});

test('current group text requests, technical/media/forward contexts and stale conversations remain text', () => {
  for (const patch of [{ text: '现在不方便听语音，用文字' }, { text: '怎么配置程序' }, { hasForward: true },
    { hasMedia: true }, { kind: 'poke' }, { time: Date.now() - 301000 }]) {
    const v = input(); Object.assign(v.st.recentMessages[0], patch); assert.equal(planGroupVoiceReply(v).kind, 'text', JSON.stringify(patch));
  }
  const v = input(); v.st.recentMessages = []; assert.equal(planGroupVoiceReply(v).kind, 'text');
  v.st.recentMessages = [{ isSelf: false, text: '只用文字回复' }]; assert.match(buildGroupVoiceHint(v), /当前消息要求文字/);
});

async function fixture(t, { failure, hold, maxPerHour = 10 } = {}) {
  let syntheses = 0, voices = 0, texts = 0, release;
  const gate = hold ? new Promise(resolve => { release = resolve; }) : null;
  const settings = { enabled: true, approved: true, autonomous: true, roleName: '守岸人', maxChars: 120 };
  const h = await bridgeHarness({ config: { socialV2: { wake: { observationMode: 'background' }, voice: { maxPerHour } } }, globals: {
    loadTtsConfig: () => settings,
    synthesizeLocal: async root => {
      syntheses++; if (gate) await gate; if (failure === 'synthesis') throw Error('known synthesis failure');
      const file = path.join(root, 'state/fixture.wav'); fs.writeFileSync(file, Buffer.alloc(44)); return { file, detail: { seconds: 2 } };
    }, inspectAudio: async () => ({ ok: true, seconds: 2, bytes: 44, format: 'wav' }),
    fetch: async (url, options = {}) => {
      if (String(url).endsWith('/send_group_msg')) {
        const segments = JSON.parse(options.body).message;
        if (segments.some(s => s.type === 'record')) { voices++; if (failure === 'delivery') throw Error('unknown delivery'); }
        else texts++;
      }
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0,
        data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture.amr' } }] } }) };
    } } });
  h.setMode('reserved2'); fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify({ role: '守岸人' }));
  h.cfg.socialV2.send.maxSendPerMinute = 100; h.cfg.socialV2.send.maxSendPerHour = 100;
  const key = 'group:456', st = h.getSocialV2State(key), server = h.startConsoleServer(); if (!server.listening) await once(server, 'listening');
  st.lastWakeReason = 'atMention'; // Explicit conversation; ambient flood pacing is tested separately.
  t.after(async () => { release?.(); await new Promise(r => server.close(r)); await h.close(); });
  const incoming = text => h.appendSocialV2Message(key, '群友', text, text, false, false, '1001', [], '123');
  incoming('今天心情不错，来聊会儿');
  const send = async (text, extra = {}, token = st.agentToken) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/send-message`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': token },
      body: JSON.stringify({ key, messages: [text], ...extra }) });
    return { status: response.status, data: await response.json() };
  };
  return { h, key, st, settings, send, incoming, release, counts: () => ({ syntheses, voices, texts }),
    due: () => { st.voiceCadence = { textTurns: 4, lastVoiceAt: 0, retryAfter: 0, preference: 'auto' }; } };
}

test('actual group HTTP sends four texts then verified role speech, with read ack and no duplicate text', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) assert.equal((await f.send(`今天真开心，和大家聊一会儿${i}。`)).data.delivery, undefined);
  f.st.modelSeenSeqs.add(f.st.lastUnreadSeq);
  const response = await f.send('好耶，今天也要开开心心的。', { throughSeq: f.st.lastUnreadSeq });
  assert.equal(response.data.delivery, 'voice', JSON.stringify(response.data)); assert.equal(response.data.verified, true);
  assert.equal(response.data.turnComplete, true); assert.equal(f.st.unread.length, 0);
  assert.deepEqual(f.counts(), { syntheses: 1, voices: 1, texts: 4 }); assert.equal(f.st.voiceCadence.textTurns, 0);
  assert.equal(f.st.stickerCadence.repliesWithoutSticker, 5);
});

test('group cooldown and existing voice budget preserve ordinary text delivery', async t => {
  const f = await fixture(t, { maxPerHour: 1 }); f.due();
  await f.send('好耶，今天大家都很开心呢。'); f.st.voiceCadence.textTurns = 4;
  assert.equal((await f.send('我们还可以聊聊刚才的话题。')).data.delivery, undefined);
  f.st.voiceCadence.lastVoiceAt = 0; assert.equal((await f.send('我还在听着，大家慢慢说。')).data.delivery, undefined);
  assert.deepEqual(f.counts(), { syntheses: 1, voices: 1, texts: 2 });
});

test('wrong token, disabled speech and explicit text request cause no group synthesis', async t => {
  const f = await fixture(t); f.due();
  assert.equal((await f.send('不会发送这句话。', {}, 'wrong')).status, 403);
  f.h.cfg.socialV2.tools.speak = false; await f.send('我在这里陪大家聊聊。'); f.h.cfg.socialV2.tools.speak = true;
  f.incoming('现在不方便听语音，只用文字'); await f.send('好，那我们继续打字聊。');
  assert.deepEqual(f.counts(), { syntheses: 0, voices: 0, texts: 2 });
});

test('known group synthesis failure falls back once and starts the existing ten-minute cooldown', async t => {
  const f = await fixture(t, { failure: 'synthesis' }); f.due();
  assert.equal((await f.send('好耶，我们今天都很开心。')).data.ok, true);
  assert(f.st.voiceCadence.retryAfter > Date.now() + 9 * 60000);
  await f.send('先继续聊聊今天的事情吧。'); assert.deepEqual(f.counts(), { syntheses: 1, voices: 0, texts: 2 });
});

test('unknown group delivery never falls back, replays or loses real group identity on restart', async t => {
  const f = await fixture(t, { failure: 'delivery' }); f.due(); const text = '大家都在这里，真好呀。';
  assert.equal((await f.send(text)).data.unknown, true);
  f.st.voiceCadence.textTurns = 0; assert.equal((await f.send(text)).data.unknown, true);
  assert.deepEqual(f.counts(), { syntheses: 1, voices: 1, texts: 0 });
  const store = new VoiceRequestStore(path.join(f.h.temp, 'state/tts-requests.json'));
  assert.equal(planGroupVoiceReply({ key: f.key, token: f.st.agentToken, st: f.st, messages: [text], settings: f.settings, roleAllowed: true, store }).kind, 'unresolved');
  assert(Object.values(store.records).every(row => row.key === 'group:456'));
});

test('concurrent copies of group automatic speech share synthesis and count one actual reply', async t => {
  const f = await fixture(t, { hold: true }); f.due(); const text = '和你们一起聊天，真的很开心。';
  const first = f.send(text); while (!f.counts().syntheses) await new Promise(r => setTimeout(r, 5));
  const second = f.send(text); await new Promise(r => setTimeout(r, 20)); f.release();
  const results = await Promise.all([first, second]); assert(results.every(x => x.data.delivery === 'voice'));
  assert.deepEqual(f.counts(), { syntheses: 1, voices: 1, texts: 0 }); assert.equal(f.st.stickerCadence.repliesWithoutSticker, 1);
});
