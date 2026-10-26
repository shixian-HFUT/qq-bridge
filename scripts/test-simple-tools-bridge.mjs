// 桥接 → Pi 的可信当轮上下文接线回归（VM 版桥接，假 DSH/QQ，不读写生产状态）。
// 验收点：只有开关打开且后端是 Pi 时才附带 turnContext；token 取自会话状态而不是
// 提示文本；水位只取本次展示的快照（没有快照时取已展示过的最大水位）；
// 原消息 ID 只从快照里最后一条非自己发的消息取。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS', name); }

const h = await bridgeHarness();
try {
  h.setMode('reserved2');
  const key = 'group:456';
  await h.ensureSession(key);
  const state = h.getSocialV2State(key);
  const token = state.agentToken;
  assert.ok(/^[a-f0-9]{16,}$/.test(token), 'fixture session should own an agent token');

  const snapshot = {
    messages: [
      { messageId: 11, seq: 1, isSelf: false },
      { messageId: 12, seq: 2, isSelf: true },
      { messageId: 13, seq: 3, isSelf: false }
    ],
    recent: [],
    readThroughSeq: 5,
    partial: false
  };

  check('有快照时绑定快照水位、来源事件与最后一条用户消息 ID', () => {
    const context = h.buildPiTurnContextV2(key, snapshot, { wakeReason: 'question', wakeSeq: 42 });
    // Objects cross the VM boundary; compare fields rather than prototypes.
    assert.equal(context.key, key);
    assert.equal(context.token, token);
    assert.equal(context.mode, 'reserved2');
    assert.equal(context.kind, 'chat-wake');
    assert.equal(context.sourceId, 'wake:42');
    assert.equal(context.readThroughSeq, 5);
    assert.equal(context.requestMessageId, '13');
  });

  check('内部回合显式区分：silent / internal 不带来源事件，也不会被纠正', () => {
    const silent = h.buildPiTurnContextV2(key, snapshot, { silent: true });
    assert.equal(silent.kind, 'silent');
    assert.equal(silent.sourceId, null);
    const internal = h.buildPiTurnContextV2(key, snapshot);
    assert.equal(internal.kind, 'internal');
    assert.equal(internal.sourceId, null);
    const noSeq = h.buildPiTurnContextV2(key, snapshot, { wakeReason: 'proactiveCheck' });
    assert.equal(noSeq.kind, 'chat-wake');
    assert.equal(noSeq.sourceId, 'wake:5', '没有 wakeSeq 时用展示水位作为来源');
  });

  check('没有快照时只取真正展示过的水位，不拿当前全局未读', () => {
    // 只把 seq 5 展示给过模型；unread 里还有 6（更晚到的）不应被确认。
    state.lastReadThroughSeq = 4;
    state.modelSeenSeqs = new Set([5]);
    state.unread = [{ seq: 5 }, { seq: 6 }];
    state.lastUnreadSeq = 6;
    const context = h.buildPiTurnContextV2(key, null);
    assert.equal(context.readThroughSeq, 5, 'must stop at what the model was shown');
    assert.equal(context.requestMessageId, null);
    state.unread = []; state.modelSeenSeqs = new Set(); state.lastUnreadSeq = 0;
  });

  check('会话没有令牌时不构造上下文（不猜身份）', () => {
    const original = state.agentToken;
    state.agentToken = '';
    assert.equal(h.buildPiTurnContextV2(key, snapshot), null);
    state.agentToken = original;
  });

  await checkAsync('开关关闭时请求里不出现 turnContext（默认兼容）', async () => {
    h.api.backend = 'pi';
    h.cfg.pi = { simpleTools: false };
    await h.deliverPrompt(key, 'legacy prompt');
    const params = h.calls.prompts.at(-1);
    assert.equal(params.turnContext, undefined);
  });

  await checkAsync('开关打开时把可信上下文交给 Pi，且提示正文不含令牌', async () => {
    h.api.backend = 'pi';
    h.cfg.pi = { simpleTools: true };
    await h.deliverPrompt(key, 'simple prompt');
    const params = h.calls.prompts.at(-1);
    assert.ok(params.turnContext, 'turnContext must be passed');
    assert.equal(params.turnContext.key, key);
    assert.equal(params.turnContext.token, state.agentToken);
    assert.equal(params.turnContext.mode, 'reserved2');
    assert.equal(params.turnContext.kind, 'internal', 'plain deliverPrompt is not a chat wake');
    assert.ok(Number.isSafeInteger(params.turnContext.readThroughSeq));
    assert.equal(JSON.stringify(params.content).includes(state.agentToken), false, 'token must not ride in prompt text');
  });

  await checkAsync('silent 摘要投喂与真实唤醒在上下文里被区分', async () => {
    h.api.backend = 'pi';
    h.cfg.pi = { simpleTools: true };
    await h.deliverPrompt(key, 'summary feed', { silent: true });
    assert.equal(h.calls.prompts.at(-1).turnContext.kind, 'silent');
    assert.equal(h.calls.prompts.at(-1).turnContext.sourceId, null);
    await h.deliverPrompt(key, 'wake prompt', { wakeReason: 'question' });
    const wake = h.calls.prompts.at(-1).turnContext;
    assert.equal(wake.kind, 'chat-wake');
    assert.match(String(wake.sourceId), /^wake:\d+$/);
  });

  await checkAsync('后端不是 Pi 时不附带上下文（DSH 路径不变）', async () => {
    h.api.backend = undefined;
    h.cfg.pi = { simpleTools: true };
    await h.deliverPrompt(key, 'dsh prompt');
    assert.equal(h.calls.prompts.at(-1).turnContext, undefined);
  });

  await checkAsync('每次投递重新读取当前令牌（轮换后旧令牌不再使用）', async () => {
    h.api.backend = 'pi';
    h.cfg.pi = { simpleTools: true };
    state.agentToken = 'rotated-fixture-token-0123456789';
    await h.deliverPrompt(key, 'after rotation');
    const params = h.calls.prompts.at(-1);
    assert.equal(params.turnContext.token, 'rotated-fixture-token-0123456789');
    assert.notEqual(params.turnContext.token, token);
  });

  console.log(`${checks} bridge wiring checks passed; no real DSH, Pi provider or QQ requests.`);
} finally {
  await h.close();
}

async function checkAsync(name, fn) {
  await fn();
  checks++;
  console.log('PASS', name);
}
