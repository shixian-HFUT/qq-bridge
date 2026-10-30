import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupWakeBudget } from '../src/group-budget.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const NOW = 1800000000000;
const limits = { maxWakePerMinute: 1, maxWakePerHour: 16 };
const key = 'group:456';

async function fixture(t) {
  let now = NOW;
  const h = await bridgeHarness({
    config: { socialV2: { wake: { observationMode: 'background', groupPassiveWakes: true, ...limits }, proactive: { enabled: false }, send: { maxSendPerMinute: 10, maxSendPerHour: 53 } } },
    globals: {
      Date: class extends Date { static now() { return now; } },
      setTimeout(fn, ms) { return { fn, ms, unref() {} }; },
      clearTimeout(timer) { if (timer) timer.cancelled = true; },
    },
  });
  t.after(() => h.close()); h.setMode('reserved2');
  const st = h.getSocialV2State(key);
  const append = text => {
    h.appendSocialV2Message(key, 'fixture', text, text, false, false, String(st.lastUnreadSeq + 1), [], '789');
    return st.lastUnreadSeq;
  };
  return { h, st, append, advance(ms) { now += ms; } };
}

test('a real direct call bypasses an empty smoothing pool while ordinary wakes remain paced', () => {
  const st = { wakeTimes: [NOW - 120000, NOW - 60000] };
  const ordinary = groupWakeBudget(st, limits, NOW, 'probability');
  assert.equal(ordinary.ok, false); assert.ok(ordinary.retryAt > NOW);
  for (const reason of ['atMention', 'nameMention', 'keyword:fixture', 'question']) {
    assert.equal(groupWakeBudget(st, limits, NOW, reason).ok, true);
  }
});

test('direct calls still obey exact minute expiry and the unchanged rolling hourly ceiling', () => {
  assert.equal(groupWakeBudget({ wakeTimes: [NOW - 10000] }, limits, NOW, 'atMention').retryAt, NOW + 50000);
  assert.equal(groupWakeBudget({ wakeTimes: [NOW - 60000] }, limits, NOW, 'atMention').ok, true);
  const st = { wakeTimes: Array(16).fill(NOW - 120000) };
  assert.equal(groupWakeBudget(st, limits, NOW, 'atMention').ok, false);
  assert.equal(groupWakeBudget(st, limits, NOW, 'atMention').retryAt, NOW + 3480000);
  assert.equal(groupWakeBudget(st, limits, NOW + 3480000, 'atMention').ok, true);
  const history = { wakeTimes: [] };
  for (let now = NOW; now < NOW + 4 * 3600000; now += 1000) {
    if (!groupWakeBudget(history, limits, now, 'atMention').ok) continue;
    history.wakeTimes.push(now);
    assert.ok(history.wakeTimes.filter(t => t > now - 60000).length <= 1);
    assert.ok(history.wakeTimes.filter(t => t > now - 3600000).length <= 16);
  }
});

test('the bridge delivers a fresh @ without waiting for ordinary refill and does not acknowledge unread', async t => {
  const { h, st, append } = await fixture(t);
  const seq = append('explicit question'); st.wakeTimes = [NOW - 120000, NOW - 60000];
  await h.sendWakePromptV2(key, 'atMention', { seq });
  assert.equal(h.calls.prompts.length, 1); assert.equal(st.wakeTimes.length, 3);
  assert.equal(st.unread.length, 1); assert.equal(st.lastReadThroughSeq || 0, 0);
  assert.equal(st.quotaWakeTimer, undefined); assert.equal(h.calls.sent.length, 0);
});

test('busy queue preserves a pending real @ ahead of later name references and ordinary activity', async t => {
  const { h, st, append } = await fixture(t);
  const direct = append('actual @ question'), name = append('someone mentions the bot'), ordinary = append('other conversation');
  st.pendingWakeReasons = [{ reason: 'atMention', seq: direct }, { reason: 'nameMention', seq: name }, { reason: 'continuation', seq: ordinary }];
  h.coalesceGroupWakesV2(key, st);
  assert.equal(st.pendingWakeReasons.length, 2);
  assert.equal(st.pendingWakeReasons[0].reason, 'atMention');
  assert.equal(st.pendingWakeReasons[0].seq, direct);
  assert.equal(st.pendingWakeReasons[1].reason, 'continuation');
});

test('rate-delayed @ cannot be replaced by a name reference and dispatches at minute expiry', async t => {
  const { h, st, append, advance } = await fixture(t);
  const direct = append('actual @ question'); st.wakeTimes = [NOW - 10000];
  await h.sendWakePromptV2(key, 'atMention', { seq: direct });
  assert.equal(h.calls.prompts.length, 0); assert.equal(st.wakeTimes.length, 1);
  const timer = st.quotaWakeTimer, name = append('bot name in ordinary conversation');
  await h.sendWakePromptV2(key, 'nameMention', { seq: name });
  assert.equal(st.quotaWakeItem.reason, 'atMention'); assert.equal(st.quotaWakeItem.seq, direct);
  assert.equal(st.quotaWakeTimer, timer); assert.equal(timer.cancelled, undefined);
  advance(50021); timer.fn(); await new Promise(setImmediate);
  assert.equal(h.calls.prompts.length, 1); assert.equal(st.lastWakeReason, 'atMention');
  assert.equal(st.unread.length, 2); assert.equal(st.wakeTimes.length, 2);
  assert.equal(h.calls.sent.length, 0);
});

test('an acknowledged @ never blocks a newer eligible candidate', async t => {
  const { h, st, append } = await fixture(t);
  const direct = append('old question'); st.quotaWakeItem = { reason: 'atMention', seq: direct };
  st.unread = []; st.lastReadThroughSeq = direct;
  const name = append('new question');
  h.deferQuotaWakeV2(key, st, 'nameMention', name, NOW + 60000);
  assert.equal(st.quotaWakeItem.reason, 'nameMention'); assert.equal(st.quotaWakeItem.seq, name);
});
