import assert from 'node:assert/strict';
import { once } from 'node:events';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
let passed = 0;
async function test(name, run, { background = true, tools = {} } = {}) {
  const network = { onSend: null, sent: 0 };
  const h = await bridgeHarness({ config: { socialV2: {
    tools, sticker: { enabled: false }, proactive: { enabled: false },
    wake: { observationMode: background ? 'background' : 'foreground', preSleepWaitEnabled: true, preSleepWaitMs: 300000 },
    send: { burstEnabled: true, burstIntervalMinMs: 0, burstIntervalMaxMs: 0 },
  } }, globals: { fetch: async (url) => {
    if (/send_(group|private)_msg$/.test(String(url))) {
      network.sent++;
      if (network.onSend) await network.onSend();
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await once(server, 'listening');
  const request = async (route, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/${route}?key=${KEY}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify({ key: KEY, ...body }),
    });
    return { status: r.status, data: await r.json() };
  };
  const append = (text) => h.appendSocialV2Message(KEY, 'fixture', text, text, false, false, `msg-${st.lastUnreadSeq + 1}`, [], '789');
  try { await run({ h, st, request, append, network }); passed++; console.log('PASS', name); }
  finally { await new Promise(r => server.close(r)); await h.close(); }
}

await test('send and acknowledge preserve messages arriving during the send', async ({ st, request, append, network }) => {
  append('already displayed');
  const read = await request('unread');
  network.onSend = async () => { append('arrived during send'); };
  const r = await request('send-message', { messages: ['reply'], throughSeq: read.data.readThroughSeq });
  assert.equal(r.status, 200);
  assert.equal(r.data.markedCount, 1);
  assert.equal(r.data.turnComplete, true);
  assert.equal(r.data.nextAction, 'end-turn');
  assert.deepEqual(Array.from(st.unread, m => m.text), ['arrived during send']);
});

await test('mark-read closes the displayed batch while leaving later arrivals unread', async ({ st, request, append }) => {
  append('displayed batch');
  const read = await request('unread');
  append('later arrival');
  const r = await request('mark-read', { throughSeq: read.data.readThroughSeq });
  assert.equal(r.data.turnComplete, true); assert.equal(r.data.nextAction, 'end-turn');
  assert.deepEqual(Array.from(st.unread, m => m.text), ['later arrival']);
});

await test('all-success send closes without a mark-read or idle-check tool call', async ({ h, st, request, append }) => {
  append('question');
  const read = await request('unread');
  const r = await request('send-message', { messages: ['answer'], throughSeq: read.data.readThroughSeq });
  assert.equal(r.data.turnComplete, true);
  assert.equal(st.unread.length, 0);
  h.scheduleReplyCheckV2(KEY);
  assert.equal(st.replyCheckTimer, null);
  assert.equal(h.evaluateWakeTriggerV2(KEY, st, {}, 'group', 'follow-up', 'follow-up', false), 'continuation');
  st.lastAiReplyAt = Date.now() - 300001;
  st.wakeConfig.triggers = {};
  assert.equal(h.evaluateWakeTriggerV2(KEY, st, {}, 'group', 'unrelated', 'unrelated', false), null);
});

await test('invalid send cursor is rejected before a message can be sent', async ({ st, request, append, network }) => {
  append('not displayed');
  const r = await request('send-message', { messages: ['must not send'], throughSeq: 1 });
  assert.equal(r.status, 400);
  assert.equal(network.sent, 0);
  assert.equal(st.unread.length, 1);
});

await test('send failure does not acknowledge the displayed input', async ({ st, request, append, network }) => {
  append('keep unread');
  const read = await request('unread');
  network.onSend = async () => { throw Error('fixture failure'); };
  const r = await request('send-message', { messages: ['reply'], throughSeq: read.data.readThroughSeq });
  assert.equal(r.data.ok, false);
  assert.equal(st.unread.length, 1);
});

await test('omitting a cursor never clears unread', async ({ st, request, append }) => {
  append('keep unread');
  await request('unread');
  const r = await request('send-message', { messages: ['reply'] });
  assert.equal(r.data.turnComplete, false);
  assert.equal(st.unread.length, 1);
});

await test('a partially successful burst never acknowledges the request', async ({ st, request, append, network }) => {
  append('keep unread after partial failure');
  const read = await request('unread');
  network.onSend = async () => { if (network.sent === 2) throw Error('second send failed'); };
  const r = await request('send-message', { messages: ['first', 'second'], throughSeq: read.data.readThroughSeq, gapMode: 'fixed', gaps: [0] });
  assert.equal(r.data.ok, false);
  assert.equal(network.sent, 2);
  assert.equal(st.unread.length, 1);
});

await test('disabled mark-read cannot be bypassed through send', async ({ st, request, append }) => {
  append('keep unread');
  const read = await request('unread');
  const r = await request('send-message', { messages: ['reply'], throughSeq: read.data.readThroughSeq });
  assert.equal(r.data.turnComplete, false);
  assert.equal(st.unread.length, 1);
}, { tools: { markRead: false } });

await test('background wait returns actual unseen arrivals without waiting or acknowledging', async ({ st, request, append }) => {
  append('new arrival');
  const r = await request('wait', { timeoutMs: 300000 });
  assert.equal(r.data.backgroundObservation, true);
  assert.equal(r.data.waitedMs, 0);
  assert.equal(r.data.newMessages.length, 1);
  assert.equal(r.data.readThroughSeq, 1);
  assert.equal(st.unread.length, 1);
  const close = await request('mark-read', { throughSeq: r.data.readThroughSeq });
  assert.equal(close.status, 200);
  assert.equal(close.data.nextAction, 'end-turn');
});

await test('foreground observation requirement remains in force', async ({ request, append }) => {
  append('still chatting');
  const read = await request('unread');
  const r = await request('mark-read', { throughSeq: read.data.readThroughSeq });
  assert.equal(r.status, 400);
  assert.ok(r.data.preSleepWaitRemainingMs > 0);
}, { background: false });

await test('a group follow-up waits for the shared wake quota instead of bypassing it', async ({ h, st, append }) => {
  h.cfg.socialV2.wake.maxWakePerMinute = 1;
  st.lastAiReplyAt = Date.now();
  st.wakeTimes = [Date.now()];
  append('actual follow-up');
  await h.sendWakePromptV2(KEY, 'continuation');
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(st.wakeTimes.length, 1);
  st.wakeTimes = [];
  await h.sendWakePromptV2(KEY, 'continuation');
  assert.equal(h.calls.prompts.length, 1);
  assert.equal(st.wakeTimes.length, 1);
});

await test('an expired observation window cannot bypass wake limits', async ({ h, st, append }) => {
  h.cfg.socialV2.wake.maxWakePerMinute = 1;
  st.lastAiReplyAt = Date.now() - 300001;
  st.wakeTimes = [Date.now()];
  append('outside reply window');
  await h.sendWakePromptV2(KEY, 'continuation');
  assert.equal(h.calls.prompts.length, 0);
});

console.log(`Reply-flow regressions: ${passed}/12 passed (isolated peers, no paid calls).`);
