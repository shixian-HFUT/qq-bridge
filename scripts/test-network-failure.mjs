import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const h = await bridgeHarness({ config: { socialV2: { proactive: { enabled: false }, sticker: { enabled: false }, wake: { observationMode: 'background' } } } });
let stopped = false, wake, processed = 0;
const frames = [];
h.api.events.mux = async function* () {
  while (!stopped) {
    if (frames.length) { yield frames.shift(); processed++; }
    else await new Promise(resolve => { wake = resolve; });
  }
};
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); }
  throw new Error('Fixture event processing timed out');
}
try {
  h.setMode('reserved2');
  const sid = await h.ensureSession(KEY);
  const st = h.getSocialV2State(KEY);
  h.appendSocialV2Message(KEY, 'fixture', 'question', 'question', false, false, 'msg-1', [], '789');
  h.appendSocialV2Message(KEY, 'fixture', 'follow-up', 'follow-up', false, false, 'msg-2', [], '789');
  st.pendingWakeReasons = [{ reason: 'continuation', seq: st.lastUnreadSeq }];
  const unread = st.unread.length;
  const pump = h.pumpMux(); void pump;
  let seq = 0;
  async function end(reason) {
    h.pendingWakeKeys.add(KEY);
    const before = processed;
    const turn = 'fixture-' + seq;
    for (const [type, data] of [['turn/start', { turn }], ['turn/end', { turn, reason }]]) {
      frames.push({ payload: { type: 'session/event', sessionId: sid, event: { type, seq: ++seq, time: Date.now(), data } } });
    }
    wake?.(); wake = null;
    await waitFor(() => processed >= before + 2);
  }
  await end({ kind: 'error', error: { message: 'Connection error.' } });
  assert.equal(h.calls.prompts.length, 0, 'failed request must not create a close reminder');
  assert.equal(h.pendingWakeKeys.has(KEY), false, 'failed wake releases its busy lease');
  assert.equal(h.wakeConfigMissCount.has(KEY), false, 'failed request is not a missing close');
  assert.equal(st.unread.length, unread, 'unprocessed input is retained');
  assert.equal(st.pendingWakeReasons.length, 1, 'buffered wake is not automatically replayed');
  assert.equal(st.pendingWakeTimer, null);
  assert.equal(h.calls.sent.length, 1);
  assert.match(h.calls.sent[0].text, /网络连接暂时中断/);
  console.log('PASS network failure releases busy state without reminders, replay or read receipts');

  await end({ kind: 'error', error: { message: 'Request timed out.' } });
  assert.equal(h.calls.sent.length, 1, 'repeat network notice is coalesced');
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(st.unread.length, unread);
  console.log('PASS repeated connection/timeout errors do not spam QQ');

  await end({ kind: 'error', error: { message: 'Model request rejected: 400' } });
  assert.equal(h.calls.sent.length, 2, 'other errors remain visible');
  assert.equal(h.calls.prompts.length, 0);
  console.log('PASS non-network errors remain visible without an automatic retry');
} finally {
  stopped = true; wake?.();
  await delay(10);
  await h.close();
}
