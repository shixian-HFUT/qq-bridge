import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { VoiceRequestStore } from '../src/voice-request.js';
import { planVoiceReply, speechPreference } from '../src/voice-cadence.js';

async function fixture(t, { failure, hold, maxPerHour = 10 } = {}) {
  let syntheses = 0, voices = 0, texts = 0, release;
  const gate = hold ? new Promise(resolve => { release = resolve; }) : null;
  const settings = { enabled: true, approved: true, autonomous: true, roleName: '守岸人', maxChars: 120 };
  const h = await bridgeHarness({ config: { socialV2: { tools: { speak: true }, wake: { observationMode: 'background' }, voice: { maxPerHour } } }, globals: {
    loadTtsConfig: () => settings,
    synthesizeLocal: async root => {
      syntheses++;
      if (gate) await gate;
      if (failure === 'synthesis') throw Error('fixture synthesis failure');
      const file = path.join(root, 'state', 'fixture.wav'); fs.writeFileSync(file, Buffer.alloc(44));
      return { file, detail: { seconds: 2 } };
    },
    inspectAudio: async () => ({ ok: true, seconds: 2, bytes: 44, format: 'wav' }),
    fetch: async (url, init = {}) => {
      if (String(url).endsWith('/send_private_msg')) {
        const message = JSON.parse(init.body).message;
        if (Array.isArray(message) && message.some(s => s.type === 'record')) {
          voices++;
          if (failure === 'delivery') throw Error('fixture uncertain delivery');
        } else texts++;
      }
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0,
        data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture.amr' } }] } }) };
    },
  } });
  h.setMode('reserved2'); fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify({ role: '守岸人' }));
  const key = 'private:123', st = h.getSocialV2State(key), server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { release?.(); await new Promise(resolve => server.close(resolve)); await h.close(); });
  const send = async (text, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/send-message`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken },
      body: JSON.stringify({ key, messages: [text], ...extra }),
    });
    return { status: response.status, data: await response.json() };
  };
  const incoming = text => h.appendSocialV2Message(key, 'fixture', text, text, false, true, '1001', [], '123');
  return { h, st, key, settings, send, incoming, release, counts: () => ({ syntheses, voices, texts }),
    due: () => { st.voiceCadence = { textTurns: 4, preference: 'auto', lastVoiceAt: 0, retryAfter: 0 }; } };
}

test('four actual text sends are followed by one role voice, with read cursor and no duplicate text', async t => {
  const f = await fixture(t); f.incoming('今天想和你聊一会儿');
  for (let i = 0; i < 4; i++) assert.equal((await f.send(`我在这里陪着你，慢慢说${i}。`)).data.delivery, undefined);
  const seq = f.st.lastUnreadSeq; f.st.modelSeenSeqs.add(seq);
  const r = await f.send('今天辛苦了，我在这里陪你。', { throughSeq: seq });
  assert.equal(r.status, 200); assert.equal(r.data.delivery, 'voice'); assert.equal(r.data.verified, true);
  assert.equal(r.data.turnComplete, true); assert.equal(f.st.unread.length, 0);
  assert.deepEqual(f.counts(), { syntheses: 1, voices: 1, texts: 4 });
  assert.equal(f.st.voiceCadence.textTurns, 0);
  assert.equal(f.st.recentMessages.filter(m => m.speech).length, 1);
});

test('text preference persists on disk and can be restored to automatic speech', async t => {
  const f = await fixture(t); f.due(); f.incoming('现在不方便听语音，只用文字回复');
  assert.equal((await f.send('好，我会安静地打字陪着你。')).data.delivery, undefined);
  const saved = JSON.parse(fs.readFileSync(path.join(f.h.temp, 'state/social-v2.json')));
  assert.equal(saved.conversations[f.key].voiceCadence.preference, 'text');
  f.incoming('现在可以语音了');
  assert.equal((await f.send('那就让我这样陪着你聊一会儿。')).data.delivery, 'voice');
  assert.equal(speechPreference('他说“不要语音”，我没意见'), null);
  assert.equal(speechPreference('能不能发个语音'), 'auto');
});

test('links, long answers, and technical requests remain text', async t => {
  const f = await fixture(t); f.due();
  await f.send('这是你需要的链接：https://example.com');
  await f.send('这是一段比较长的回答。'.repeat(12));
  f.incoming('怎么配置这个程序？'); await f.send('先打开设置，然后检查你选择的选项。');
  assert.deepEqual(f.counts(), { syntheses: 0, voices: 0, texts: 3 });
});

test('quoted replies, groups, disabled speech, and another role keep text delivery', () => {
  const input = { key: 'private:123', token: 'fixture', st: { voiceCadence: { textTurns: 4, preference: 'auto' } },
    messages: ['今天辛苦了，我在这里陪你。'], settings: { enabled: true, approved: true, autonomous: true }, roleAllowed: true };
  assert.equal(planVoiceReply(input).kind, 'voice');
  for (const change of [{ replyToMessageId: '9001' }, { key: 'group:123' }, { roleAllowed: false },
    { settings: { ...input.settings, enabled: false } }, { settings: { ...input.settings, autonomous: false } }]) {
    assert.equal(planVoiceReply({ ...input, ...change }).kind, 'text');
  }
});

test('known synthesis failure falls back once to text and starts a ten minute cooldown', async t => {
  const f = await fixture(t, { failure: 'synthesis' }); f.due();
  assert.equal((await f.send('今天辛苦了，我陪你慢慢说。')).status, 200);
  assert(f.st.voiceCadence.retryAfter > Date.now() + 9 * 60000);
  await f.send('先坐下来休息一下吧，我还在。');
  assert.deepEqual(f.counts(), { syntheses: 1, voices: 0, texts: 2 });
  const records = JSON.parse(fs.readFileSync(path.join(f.h.temp, 'state/tts-requests.json')));
  assert(Object.values(records).some(r => r.knownNotSent === true));
});

test('unknown delivery never falls back to text, even on repeat or after ledger reload', async t => {
  const f = await fixture(t, { failure: 'delivery' }); f.due();
  const text = '我会一直在这里等你回来。';
  let r = await f.send(text); assert.equal(r.data.unknown, true); assert.equal(r.data.stage, 'delivery');
  f.st.voiceCadence.retryAfter = Date.now() + 600000; f.st.voiceCadence.textTurns = 0;
  r = await f.send(text); assert.equal(r.data.unknown, true);
  assert.deepEqual(f.counts(), { syntheses: 1, voices: 1, texts: 0 });
  const store = new VoiceRequestStore(path.join(f.h.temp, 'state/tts-requests.json'));
  assert.equal(planVoiceReply({ key: f.key, token: f.st.agentToken, st: f.st, messages: [text], settings: f.settings, roleAllowed: true, store }).kind, 'unresolved');
});

test('concurrent copies of an automatic voice share synthesis and never produce text duplicates', async t => {
  const f = await fixture(t, { hold: true }); f.due(); const text = '慢慢来，我会在这里听你说。';
  const first = f.send(text);
  while (f.counts().syntheses === 0) await new Promise(resolve => setTimeout(resolve, 5));
  const second = f.send(text); await new Promise(resolve => setTimeout(resolve, 20)); f.release();
  const results = await Promise.all([first, second]); assert(results.every(r => r.data.delivery === 'voice'));
  assert.deepEqual(f.counts(), { syntheses: 1, voices: 1, texts: 0 });
});

test('voice cooldown and exhausted hourly voice budget keep ordinary replies working', async t => {
  const f = await fixture(t, { maxPerHour: 1 }); f.due();
  await f.send('好久不见，我也很想念你。');
  f.st.voiceCadence.textTurns = 4;
  assert.equal((await f.send('我们还可以继续聊刚才的话题。')).data.delivery, undefined);
  f.st.voiceCadence.lastVoiceAt = 0;
  assert.equal((await f.send('我还在听着，你慢慢告诉我。')).data.delivery, undefined);
  assert.deepEqual(f.counts(), { syntheses: 1, voices: 1, texts: 2 });
});
