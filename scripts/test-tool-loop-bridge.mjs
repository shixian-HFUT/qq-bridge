// Run the complete real-bridge delivery guard matrix for research-stop notices.
// 私聊媒体失败兜底的桥接侧回归（VM 版真实 bridge.js，假 QQ/DSH，不读写生产状态）。
//
// 验收点：固定提示只走既有 sendToQQ 路径（fake bot 记录），
//   · 正常私聊：发一条固定文本；不标记已读、不推进水位；
//   · 发送前复核**当前** simpleTools / sendMessage 开关、暂停、静默、本轮可信令牌；
//   · 同一条用户消息只尝试一次：入队前占位，结果未知/失败也保留占位（不会重入再发）；
//   · 预发送拒绝（限流/静默/模式/开关/令牌）不占位，恢复后同一条消息仍可提示一次；
//   · 真正出队（排在全局 sendChain 之后）临近发送时再复核：排队期间关开关 / 暂停 /
//     静默 / 令牌轮换 / 撤权 → 取消；假 QQ 队列验证；
//   · 群聊 / 静默 / 暂停 / 非 reserved2 / 白名单外 / 会话已换代 / 限流 → 不发；
//   · 发送未确认（发送守卫失败）→ 只尝试一次、回滚限流额度、不误称已送达；
//   · 实际发出后按正常可见回复记账：进入 recentMessages（模型历史）与 lastAiReplyAt 等状态；
//   · 可信令牌只在进程内传递，不写日志、不发进 QQ、不进模型请求。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { TOOL_LOOP_FALLBACK_TEXT } from '../src/pi-tool-loop.js';

let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('PASS', name); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('fixture timeout waiting for the queued send');
    await sleep(5);
  }
}

const h = await bridgeHarness({ config: { allow: { private: ['123', '999'], groups: ['456'] } } });
const setRoleMode = (mode, root = h.temp) => fs.writeFileSync(path.join(root, 'state', 'current-role.json'), JSON.stringify({ role: 'fixture-role', mode }));

try {
  h.setMode('reserved2');
  // 兜底与模型侧共用同一个显式开关：打开后才可能有这条路径。
  h.cfg.pi = { ...(h.cfg.pi || {}), simpleTools: true };
  const key = 'private:123';
  const sessionId = await h.ensureSession(key);
  assert.equal(h.state.sessions[key], sessionId);
  const st = h.getSocialV2State(key);
  const token = st.agentToken;
  // 新到但尚未展示给模型的消息：兜底绝不能把它确认掉。
  st.unread = [{ seq: 3, messageId: 'm-new', userId: '123', sender: '用户', text: '新到未展示的消息', isSelf: false, time: Date.now() }];
  st.lastUnreadSeq = 3;
  st.lastReadThroughSeq = 0;
  const sentFor = (id) => h.calls.sent.filter(entry => entry.kind === 'private' && Number(entry.id) === Number(id));

  await check('正常私聊：发送一条固定安全提示，且不标记已读/不推进水位', async () => {
    const result = await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token, messageId: 'm-1' });
    assert.equal(result.ok, true);
    assert.equal(result.sent, 1);
    assert.equal(sentFor(123).length, 1);
    assert.equal(sentFor(123)[0].text, TOOL_LOOP_FALLBACK_TEXT);
    assert.equal(/https?:\/\//.test(sentFor(123)[0].text), false);
    assert.equal(st.unread.length, 1, 'unread must survive the fallback');
    assert.equal(st.unread[0].messageId, 'm-new');
    assert.equal(st.lastReadThroughSeq, 0, 'the fallback must not advance the read watermark');
  });

  await check('同一条用户消息只提示一次；不同消息可再次提示', async () => {
    const duplicate = await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token, messageId: 'm-1' });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.reason, 'duplicate');
    assert.equal(sentFor(123).length, 1);
    const next = await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token, messageId: 'm-2' });
    assert.equal(next.ok, true);
    assert.equal(sentFor(123).length, 2);
  });

  await check('会话已换代：不发', async () => {
    const stale = await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId: 'fixture-stale-session', token, messageId: 'm-3' });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'stale-session');
    assert.equal(sentFor(123).length, 2);
  });

  await check('群聊：不发', async () => {
    const group = await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key: 'group:456', sessionId, token, messageId: 'm-3' });
    assert.equal(group.reason, 'not-private');
    assert.equal(sentFor(456).length, 0);
  });

  await check('静默模式：非管理员私聊不发，管理员私聊保持原有豁免', async () => {
    setRoleMode('silent');
    const member = await h.ensureSession('private:999');
    const memberToken = h.getSocialV2State('private:999').agentToken;
    const refused = await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key: 'private:999', sessionId: member, token: memberToken, messageId: 'm-3' });
    assert.equal(refused.reason, 'silent');
    assert.equal(sentFor(999).length, 0);
    const owner = await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token, messageId: 'm-3' });
    assert.equal(owner.ok, true, 'owner private chat keeps the historical silent-mode exemption');
    assert.equal(sentFor(123).length, 3);
    setRoleMode('active');
  });

  await check('二代暂停 / 模式不是 reserved2 / 开关关闭：都不发', async () => {
    const before = sentFor(123).length;
    h.socialV2.paused = true;
    assert.equal((await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token, messageId: 'm-4' })).reason, 'paused');
    h.socialV2.paused = false;
    h.setMode('chat');
    assert.equal((await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token, messageId: 'm-4' })).reason, 'mode');
    h.setMode('reserved2');
    h.cfg.socialV2.enabled = false;
    assert.equal((await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token, messageId: 'm-4' })).reason, 'disabled');
    h.cfg.socialV2.enabled = true;
    assert.equal(sentFor(123).length, before);
  });

  await check('白名单外：不发', async () => {
    const before = h.calls.sent.length;
    const result = await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key: 'private:888', sessionId: 'fixture-any', token, messageId: 'm-5' });
    assert.equal(result.reason, 'not-allowed');
    assert.equal(h.calls.sent.length, before);
  });

  await check('发送前复核当前开关：simpleTools / sendMessage 关闭都不发', async () => {
    const before = sentFor(123).length;
    h.cfg.pi = { ...h.cfg.pi, simpleTools: false };
    assert.equal((await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token, messageId: 'm-switch' })).reason, 'simple-tools-off');
    h.cfg.pi = { ...h.cfg.pi, simpleTools: true };
    h.cfg.socialV2.tools.sendMessage = false;
    assert.equal((await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token, messageId: 'm-switch' })).reason, 'send-message-off');
    h.cfg.socialV2.tools.sendMessage = true;
    assert.equal(sentFor(123).length, before, 'neither switch-off may send anything');
    // 预发送拒绝不占位：恢复开关后同一条消息仍可提示一次。
    assert.equal((await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token, messageId: 'm-switch' })).ok, true);
    assert.equal(sentFor(123).length, before + 1);
  });

  await check('可信令牌缺失/伪造：发送前即拒绝，不发送', async () => {
    const before = sentFor(123).length;
    assert.equal((await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, messageId: 'm-notoken' })).reason, 'token-invalid');
    assert.equal((await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token: 'forged-token', messageId: 'm-notoken' })).reason, 'token-invalid');
    assert.equal(sentFor(123).length, before);
  });

  await check('限流：与既有发送端点共用额度，超限不发；预发送拒绝不占位', async () => {
    const before = sentFor(123).length;
    const limitBefore = h.cfg.socialV2.send.maxSendPerMinute;
    h.cfg.socialV2.send.maxSendPerMinute = 1;
    st.sendTimes = [Date.now()];
    const result = await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token, messageId: 'm-6' });
    assert.equal(result.reason, 'rate-limited');
    assert.equal(sentFor(123).length, before);
    h.cfg.socialV2.send.maxSendPerMinute = limitBefore;
    st.sendTimes = [];
    const retry = await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token, messageId: 'm-6' });
    assert.equal(retry.ok, true, 'a pre-send refusal must not claim the message');
    assert.equal(sentFor(123).length, before + 1);
  });

  await check('发送未确认（排队后撤权）：只尝试一次、不重试、回滚额度、不误称已送达', async () => {
    const before = sentFor(123).length;
    const timesBefore = st.sendTimes.length;
    const pending = h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token, messageId: 'm-7' });
    // 让发送守卫在真正出站前失败（模式已切换），模拟网关/权限变化导致的发送未确认。
    h.setMode('chat');
    const result = await pending;
    h.setMode('reserved2');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'send-unconfirmed');
    assert.equal(sentFor(123).length, before, 'a failed fallback must not reach QQ');
    assert.equal(st.sendTimes.length, timesBefore, 'the reserved quota slot must be rolled back');
  });

  await check('未知/失败占位保留：同一消息重入不再尝试，不同消息仍可提示', async () => {
    const before = sentFor(123).length;
    // 上一轮发送未确认（结果未知），占位必须已保留；此刻权限正常，若没有占位会真的再发一次。
    const duplicate = await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token, messageId: 'm-7' });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.reason, 'duplicate');
    assert.equal(sentFor(123).length, before, 'an unknown outcome must not allow a re-entry to send again');
    const next = await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token, messageId: 'm-7b' });
    assert.equal(next.ok, true);
    assert.equal(sentFor(123).length, before + 1);
  });

  await check('实际发出后按正常可见回复记账：进入模型历史与状态', async () => {
    const replyBefore = st.lastAiReplyAt || 0;
    const actionBefore = st.lastActionAt || 0;
    st.wakeConfig.noActionCount = 2;
    const result = await h.sendPrivateMediaFallbackV2({ reason: 'research-stop', key, sessionId, token, messageId: 'm-book' });
    assert.equal(result.ok, true);
    const last = st.recentMessages.at(-1);
    assert.equal(last.isSelf, true, 'the sent notice must be recorded as a self message');
    assert.equal(last.text, TOOL_LOOP_FALLBACK_TEXT);
    assert.ok((st.lastAiReplyAt || 0) >= replyBefore && st.lastAiReplyAt > 0, 'lastAiReplyAt must move');
    assert.ok((st.lastActionAt || 0) >= actionBefore && st.lastActionAt > 0, 'lastActionAt must move');
    assert.equal(st.wakeConfig.noActionCount, 0, 'a delivered reply resets the no-action counter');
    assert.equal(st.unread.length, 1, 'bookkeeping must not acknowledge unread');
    assert.equal(st.lastReadThroughSeq, 0);
    // 模型下一轮拿到的唤醒快照里必须能看到这句话（recentMessages → 提示正文）。
    const snapshot = h.buildWakeSnapshotV2(key);
    assert.ok(JSON.stringify(snapshot || {}).includes(TOOL_LOOP_FALLBACK_TEXT), 'the notice must enter the model-facing history');
  });

  // ── 排队后真正出队前的复核（假 QQ 发送队列，可闸门阻塞） ────────────────────
  const queued = { sent: [], block: null, blocked: false };
  class QueuedBot {
    async sendPrivateMessage(id, textMsg) {
      queued.sent.push({ kind: 'private', id: Number(id), text: textMsg });
      if (queued.block) {
        queued.blocked = true;
        await queued.block;
        queued.blocked = false;
      }
    }
    async sendGroupMessage(id, textMsg) { queued.sent.push({ kind: 'group', id: Number(id), text: textMsg }); }
    async getImage() {
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async request() { return { status: 'ok', retcode: 0, data: [] }; }
  }
  const h2 = await bridgeHarness({
    config: { allow: { private: ['123', '999'], groups: ['456'] }, sendDelayMs: 0 },
    globals: { SnowLumaWebSocketClient: QueuedBot }
  });
  try {
    h2.setMode('reserved2');
    h2.cfg.pi = { ...(h2.cfg.pi || {}), simpleTools: true };
    await h2.ensureSession('private:123');
    await h2.ensureSession('private:999');
    const st2 = h2.getSocialV2State('private:123');
    const queuedToken = st2.agentToken;

    async function queuedFallback({ mutate, messageId, fallbackKey = 'private:123', sendToken = null }) {
      const targetSession = h2.state.sessions[fallbackKey];
      let release;
      queued.block = new Promise(resolve => { release = resolve; });
      queued.blocked = false;
      // 先用一条普通发送占住全局 sendChain，兜底就会排在它后面。
      const blocker = h2.sendToQQ('private:123', '前置排队消息');
      await waitUntil(() => queued.blocked);
      const before = queued.sent.filter(entry => entry.text === TOOL_LOOP_FALLBACK_TEXT).length;
      const pending = h2.sendPrivateMediaFallbackV2({ reason: 'research-stop',
        key: fallbackKey, sessionId: targetSession, messageId,
        token: sendToken ?? h2.getSocialV2State(fallbackKey).agentToken
      });
      await sleep(10); // 预检查 + 占位已完成，请求正停在全局队列里
      mutate();
      queued.block = null;
      release();
      await blocker;
      const result = await pending;
      await sleep(10);
      const after = queued.sent.filter(entry => entry.text === TOOL_LOOP_FALLBACK_TEXT).length;
      return { result, sentDelta: after - before };
    }

    await check('排队期间无变化：出队后正常发送（对照组）', async () => {
      const control = await queuedFallback({ messageId: 'q-control', mutate: () => {} });
      assert.equal(control.result.ok, true);
      assert.equal(control.sentDelta, 1);
    });

    await check('排队期间关闭 simpleTools：出队时取消', async () => {
      const run = await queuedFallback({
        messageId: 'q-simple-off',
        mutate: () => { h2.cfg.pi = { ...h2.cfg.pi, simpleTools: false }; }
      });
      assert.equal(run.result.ok, false);
      assert.equal(run.result.reason, 'send-unconfirmed');
      assert.equal(run.sentDelta, 0);
      h2.cfg.pi = { ...h2.cfg.pi, simpleTools: true };
    });

    await check('排队期间关闭 sendMessage：出队时取消', async () => {
      const run = await queuedFallback({
        messageId: 'q-send-off',
        mutate: () => { h2.cfg.socialV2.tools.sendMessage = false; }
      });
      assert.equal(run.result.ok, false);
      assert.equal(run.result.reason, 'send-unconfirmed');
      assert.equal(run.sentDelta, 0);
      h2.cfg.socialV2.tools.sendMessage = true;
    });

    await check('排队期间暂停：出队时取消，且同消息占位保留', async () => {
      const run = await queuedFallback({
        messageId: 'q-paused',
        mutate: () => { h2.socialV2.paused = true; }
      });
      assert.equal(run.result.ok, false);
      assert.equal(run.result.reason, 'send-unconfirmed');
      assert.equal(run.sentDelta, 0);
      h2.socialV2.paused = false;
      const retry = await h2.sendPrivateMediaFallbackV2({ reason: 'research-stop',
        key: 'private:123', sessionId: h2.state.sessions['private:123'], messageId: 'q-paused',
        token: h2.getSocialV2State('private:123').agentToken
      });
      assert.equal(retry.reason, 'duplicate', 'a cancelled attempt keeps the claim');
      const stillOne = queued.sent.filter(entry => entry.text === TOOL_LOOP_FALLBACK_TEXT).length;
      assert.equal(stillOne, 1);
    });

    await check('排队期间进入静默（非管理员私聊）：出队时取消', async () => {
      const run = await queuedFallback({
        fallbackKey: 'private:999',
        messageId: 'q-silent',
        mutate: () => setRoleMode('silent', h2.temp)
      });
      assert.equal(run.result.ok, false);
      assert.equal(run.result.reason, 'send-unconfirmed');
      assert.equal(run.sentDelta, 0);
      setRoleMode('active', h2.temp);
    });

    await check('排队期间令牌轮换（撤权）：出队时取消', async () => {
      const run = await queuedFallback({
        messageId: 'q-rotate',
        mutate: () => { st2.agentToken = 'rotated-token-0123456789abcdef'; }
      });
      assert.equal(run.result.ok, false);
      assert.equal(run.result.reason, 'send-unconfirmed');
      assert.equal(run.sentDelta, 0);
      st2.agentToken = queuedToken;
    });

    await check('排队期间白名单撤权：出队时取消', async () => {
      const allowBefore = [...h2.cfg.allow.private];
      const run = await queuedFallback({
        messageId: 'q-revoke',
        mutate: () => { h2.cfg.allow.private = ['999']; }
      });
      assert.equal(run.result.ok, false);
      assert.equal(run.result.reason, 'send-unconfirmed');
      assert.equal(run.sentDelta, 0);
      h2.cfg.allow.private = allowBefore;
    });

    await check('可信令牌只在进程内使用：不出现在 QQ 文本或桥接日志', () => {
      const sentText = JSON.stringify(queued.sent);
      assert.equal(sentText.includes(queuedToken), false, 'the trusted token must never be sent to QQ');
      assert.equal(sentText.includes('rotated-token-0123456789abcdef'), false);
      const logFile = path.join(h2.temp, 'state', 'bridge.log');
      const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      assert.equal(logText.includes(queuedToken), false, 'the trusted token must never be logged');
      assert.equal(logText.includes('rotated-token-0123456789abcdef'), false);
    });
  } finally {
    await h2.close();
  }

  await check('固定提示共用一个发送队列，没有绕过既有 sendToQQ 路径', () => {
    // 每一条“成功”的记录都必须来自 sendToQQ（fake bot 只被 sendToQQ 调用）。
    const total = h.calls.sent.filter(entry => entry.text === TOOL_LOOP_FALLBACK_TEXT).length;
    assert.equal(total, 7);
    assert.equal(JSON.stringify(sentFor(123)).includes(sessionId), false, 'session ids never ride in the message');
  });

  console.log(`${checks} private-fallback bridge checks passed; no real DSH, Pi provider or QQ requests.`);
} finally {
  await h.close();
}
