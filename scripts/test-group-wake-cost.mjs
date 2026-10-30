import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function fixture(t, passive = false, extra = {}) {
  const h = await bridgeHarness({ config: {
    socialV2: { wake: { observationMode: 'background', groupPassiveWakes: passive }, proactive: { enabled: true } },
    ...extra,
  } });
  t.after(() => h.close());
  h.setMode('reserved2');
  return h;
}
function append(h, key = 'group:456') {
  return h.appendSocialV2Message(key, 'fixture', 'new message', 'new message', false, false, '100', [], '789');
}

test('empty automatic group wakes never invoke the model or consume wake credits, including old queued checks', async t => {
  for (const passive of [false, true]) {
    const h = await fixture(t, passive), key = 'group:456', st = h.getSocialV2State(key);
    st.lastAiReplyAt = Date.now();
    for (const reason of ['probability', 'proactiveCheck', 'replyCheck', 'timeout', 'continuation']) {
      await h.sendWakePromptV2(key, reason);
    }
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(h.calls.created.length, 0);
    assert.equal(st.wakeTimes.length, 0);
    assert.equal(st.unread.length, 0);
    assert.equal(st.pendingWakeReasons?.length || 0, 0);
    assert.equal(st.lastReadThroughSeq || 0, 0);
  }
});

test('passive wakes disabled: ordinary messages remain local and unread without charging or queuing', async t => {
  const h = await fixture(t), key = 'group:456', st = h.getSocialV2State(key);
  st.wakeConfig.triggers = { probability: 1 };
  append(h);
  const unreadBefore = JSON.stringify(st.unread);
  assert.equal(h.evaluateWakeTriggerV2(key, st, {}, 'group', 'hello', 'hello', false), null);
  h.pendingWakeKeys.add(key); // A busy turn must not enqueue these skipped candidates either.
  await h.sendWakePromptV2(key, 'probability');
  await h.sendWakePromptV2(key, 'proactiveCheck');
  h.pendingWakeKeys.clear();
  await h.sendWakePromptV2(key, 'probability');
  await h.sendWakePromptV2(key, 'proactiveCheck');
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(st.wakeTimes.length, 0);
  assert.equal(st.pendingWakeReasons?.length || 0, 0);
  assert.equal(st.quotaWakeTimer, undefined);
  assert.equal(JSON.stringify(st.unread), unreadBefore);
  assert.equal(st.lastReadThroughSeq || 0, 0);
});

test('disabled passive checks arm no group timer while private proactive behavior stays available', async t => {
  const h = await fixture(t);
  assert.equal(h.getSocialV2State('group:456').proactiveTimer, null);
  assert.ok(h.getSocialV2State('private:123').proactiveTimer);
  assert.equal(h.calls.prompts.length, 0);
});

test('mentions, self-quotes, names and ongoing conversations still select and deliver a wake', async t => {
  for (const [expected, event, text, quote, continuing] of [
    ['atMention', { self_id: 999, message: [{ type: 'at', data: { qq: '999' } }] }, 'hello', false, false],
    ['atMention', {}, 'hello', true, false],
    ['nameMention', {}, 'deepseek hello', false, false],
    ['continuation', {}, 'follow up', false, true],
  ]) {
    const h = await fixture(t), key = 'group:456', st = h.getSocialV2State(key);
    st.wakeConfig.triggers = { atMention: true, nameMention: true, probability: 1 };
    if (continuing) st.lastAiReplyAt = Date.now();
    append(h);
    const reason = h.evaluateWakeTriggerV2(key, st, event, 'group', text, text, quote);
    assert.equal(reason, expected);
    await h.sendWakePromptV2(key, reason);
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(st.wakeTimes.length, 1);
    assert.equal(st.unread.length, 1); // Delivery is not acknowledgement.
    assert.equal(h.calls.sent.length, 0);
  }
});

test('operator and bootstrap wakes remain available without unread messages', async t => {
  for (const reason of ['bootstrap', 'admin', 'manual']) {
    const h = await fixture(t);
    await h.sendWakePromptV2('group:456', reason);
    assert.equal(h.calls.prompts.length, 1);
  }
});

test('private model decisions retain their existing behavior including empty proactive checks', async t => {
  const h = await fixture(t), key = 'private:123', st = h.getSocialV2State(key);
  assert.equal(h.evaluateWakeTriggerV2(key, st, {}, 'private', 'hello', 'hello', false), 'private');
  await h.sendWakePromptV2(key, 'proactiveCheck');
  assert.equal(h.calls.prompts.length, 1);
});

test('an empty group allowlist blocks every wake and cannot create a model session', async t => {
  const h = await fixture(t, false, { allow: { groups: [], private: ['123'] }, allowAllWhenEmpty: false });
  for (const reason of ['atMention', 'continuation', 'bootstrap', 'admin', 'probability']) {
    await h.sendWakePromptV2('group:456', reason);
  }
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(h.calls.created.length, 0);
  assert.equal(Object.keys(h.state.sessions).filter(k => k.startsWith('group:')).length, 0);
  append(h, 'private:123');
  await h.sendWakePromptV2('private:123', 'private');
  assert.equal(h.calls.prompts.length, 1);
  assert.equal(h.calls.sent.length, 0);
});
