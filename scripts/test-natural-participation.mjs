import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('actual wake prompts allow ongoing conversation without demanding a speaking quota', async () => {
  const h = await bridgeHarness();
  try {
    const st = h.getSocialV2State('group:456');
    st.lastAiReplyAt = Date.now();
    st.recentMessages = [1, 2, 3].map(seq => ({ seq, isSelf: true, time: Date.now() }));
    for (const reason of ['continuation', 'bootstrap', 'proactiveCheck']) {
      const prompt = h.buildWakePromptV2('group:456', reason);
      assert.doesNotMatch(prompt, /不要习惯性潜水|大胆开口|别潜水|别直接消失|不要一上来就划走|插不上再潜水|优先主动开个话题/);
      assert.match(prompt, /有趣的接话点，就自然继续聊/);
      assert.doesNotMatch(prompt, /先让别人说|你刚说过话，先听一会儿|发言偏多.*只看不说/);
    }
    assert.match(h.buildWakePromptV2('group:456', 'proactiveCheck'), /不是发言任务/);
    assert.match(h.buildWakePromptV2('group:456', 'continuation'), /分享与玩笑也值得回应/);
  } finally { await h.close(); }
});

test('busy-group participation carries no instruction to fill a speaking quota', async () => {
  const h = await bridgeHarness();
  try {
    const st = h.getSocialV2State('group:456');
    st.recentMessages = Array.from({ length: 12 }, (_, seq) => ({ seq, isSelf: false, sender: seq % 3, time: Date.now() }));
    const prompt = h.buildWakePromptV2('group:456', 'continuation');
    assert.match(prompt, /可以挑感兴趣的一点自然加入，不必等点名/);
    assert.doesNotMatch(prompt, /挑最值得接的一句主动参与|别潜水|不要一上来就划走/);
  } finally { await h.close(); }
});

test('five or more earlier replies do not turn ordinary sharing into a silence instruction', async () => {
  const h = await bridgeHarness();
  try {
    const st = h.getSocialV2State('group:456');
    st.lastAiReplyAt = Date.now() - 180000;
    st.recentMessages = Array.from({ length: 7 }, (_, seq) => ({ seq, isSelf: true, time: Date.now() - 180000 - seq * 60000 }));
    st.recentMessages.push(...[20, 21, 22].map(seq => ({ seq, isSelf: false, sender: '群友', time: Date.now() - 600000, text: '之前的聊天' })));
    st.unread = [{ seq: 8, text: '我新买的键盘到了', plain: '我新买的键盘到了', quoteTargetIsSelf: true, time: Date.now() }];
    const prompt = h.buildWakePromptV2('group:456', 'continuation');
    assert.match(prompt, /回应、接梗、好奇地问一句都可以/);
    assert.match(prompt, /不按发言次数决定该不该说/);
    assert.doesNotMatch(prompt, /发言偏多|先听一会儿|先让别人说|没有新内容可直接标记已读/);
  } finally { await h.close(); }
});
