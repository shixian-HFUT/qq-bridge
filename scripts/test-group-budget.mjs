import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { groupSendBudget, groupWakeBudget, groupBudgetPolicy } from '../src/group-budget.js';
import { projectPiContext, estimateContextTokens } from '../src/pi-context.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('PASS', name); };
const now = 1800000000000;
const cfg = { maxSendPerMinute: 10, maxSendPerHour: 40 };
const key = 'group:456';
check('the requested one-third increase scales refill and burst allowance while preserving rolling caps', () => {
  const limits = { maxSendPerMinute: 10, maxSendPerHour: 53 }, wakes = { maxWakePerMinute: 1, maxWakePerHour: 16 };
  assert.deepEqual(groupBudgetPolicy(limits), { hourly: 53, ambientHourly: 32, ambientTenMinutes: 5, burst: 5, ambientBurst: 3 });
  assert.equal(groupSendBudget(key, { sendTimes: Array(5).fill(now) }, limits, 1, now, 'atMention').retryAt, now + Math.ceil(3600000 / 53));
  assert.equal(groupWakeBudget({ wakeTimes: [now, now] }, wakes, now + 60000, 'probability').retryAt, now + 225000);
  assert.equal(groupWakeBudget({ wakeTimes: [now, now] }, wakes, now + 60000, 'atMention').ok, true);
  const st = { sendTimes: [], wakeTimes: [] };
  for (let at = now; at < now + 2 * 3600000; at += 1000) {
    if (groupSendBudget(key, st, limits, 1, at, 'atMention').ok) {
      st.sendTimes.push(at); assert.ok(st.sendTimes.filter(t => t > at - 3600000).length <= 53);
    }
    if (groupWakeBudget(st, wakes, at, 'atMention').ok) {
      st.wakeTimes.push(at); assert.ok(st.wakeTimes.filter(t => t > at - 3600000).length <= 16);
    }
  }
});
check('continuous send refill leaves an immediate reserve for explicit calls', () => {
  const st = { sendTimes: [] };
  assert.equal(groupSendBudget(key, st, cfg, 1, now, 'probability').remaining, 2);
  assert.equal(groupSendBudget(key, st, cfg, 1, now, 'atMention').remaining, 4);
  st.sendTimes.push(now, now);
  assert.equal(groupSendBudget(key, st, cfg, 1, now, 'probability').ok, false);
  assert.equal(groupSendBudget(key, st, cfg, 1, now, 'atMention').remaining, 2);
  const pending = groupSendBudget(key, st, cfg, 1, now, 'probability');
  assert.equal(pending.retryAt, now + 150000);
  assert.equal(groupSendBudget(key, st, cfg, 1, pending.retryAt, 'probability').ok, true);
  st.sendTimes.push(now, now);
  assert.equal(groupSendBudget(key, st, cfg, 1, now, 'atMention').retryAt, now + 90000);
});
check('ordinary wakes remain paced while direct wakes obey the same hard caps', () => {
  const st = { wakeTimes: [now] }, limits = { maxWakePerMinute: 1, maxWakePerHour: 12 };
  assert.equal(groupWakeBudget(st, limits, now + 60000, 'atMention').ok, true);
  assert.equal(groupWakeBudget(st, limits, now + 60000, 'probability').ok, true);
  st.wakeTimes.push(now + 60000);
  assert.equal(groupWakeBudget(st, limits, now + 60000, 'probability').retryAt, now + 300000);
});
check('four-hour ordinary saturation stays within every rolling cap and refills after restart from the same receipts', () => {
  const send = { sendTimes: [] }, wake = { wakeTimes: [] }, limits = { maxWakePerMinute: 1, maxWakePerHour: 12 };
  const acceptedWakes = [];
  for (let offset = 0; offset < 4 * 3600000; offset += 1000) {
    const at = now + offset;
    if (groupSendBudget(key, send, cfg, 1, at, 'atMention').ok) {
      send.sendTimes.push(at);
      assert.ok(send.sendTimes.filter(t => t > at - 3600000).length <= 40);
      assert.ok(send.sendTimes.filter(t => t > at - 60000).length <= 10);
    }
    if (groupWakeBudget(wake, limits, at, 'probability').ok) {
      wake.wakeTimes.push(at); acceptedWakes.push(at);
      assert.ok(wake.wakeTimes.filter(t => t > at - 3600000).length <= 12);
      assert.ok(wake.wakeTimes.filter(t => t > at - 60000).length <= 1);
    }
  }
  assert.ok(acceptedWakes.length >= 40);
  assert.ok(acceptedWakes.slice(1).every((t, i) => t - acceptedWakes[i] <= 600000));
  const restart = JSON.parse(JSON.stringify(send));
  assert.deepEqual(groupSendBudget(key, restart, cfg, 1, now + 4 * 3600000, 'atMention'), groupSendBudget(key, send, cfg, 1, now + 4 * 3600000, 'atMention'));
});
check('ordinary participation can use the shared remaining hourly allowance after direct activity', () => {
  const st = { wakeTimes: Array(10).fill(now - 900000) }, limits = { maxWakePerMinute: 1, maxWakePerHour: 16 };
  assert.equal(groupWakeBudget(st, limits, now, 'probability').ok, true);
  assert.equal(groupWakeBudget(st, limits, now, 'probability').remaining, 1);
});
check('ambient bursts stop at four bubbles; explicit calls retain the reserved capacity', () => {
  const st = { sendTimes: Array(4).fill(now - 120000) };
  const ambient = groupSendBudget(key, st, cfg, 1, now, 'continuation');
  assert.equal(ambient.ok, false); assert.equal(ambient.retryAt, now + 480000);
  assert.equal(groupSendBudget(key, st, cfg, 1, now, 'atMention').remaining, 1);
  st.sendTimes = Array(24).fill(now - 700000);
  assert.equal(groupSendBudget(key, st, cfg, 1, now, 'probability').ok, false);
  assert.equal(groupSendBudget(key, st, { maxSendPerHour: 40 }, 1, now, 'atMention').remaining, 4);
});
check('hard hourly/minute caps, exact expiry and private behavior stay enforced', () => {
  assert.equal(groupSendBudget(key, { sendTimes: Array(40).fill(now - 120000) }, cfg, 1, now, 'atMention').ok, false);
  assert.equal(groupSendBudget(key, { sendTimes: Array(10).fill(now - 1000) }, cfg, 1, now, 'atMention').retryAt, now + 89000);
  assert.equal(groupSendBudget(key, { sendTimes: Array(4).fill(now - 600000) }, cfg, 1, now, 'probability').ok, true);
  assert.equal(groupSendBudget('private:123', { sendTimes: Array(8).fill(now - 1000) }, cfg, 2, now, 'private').ok, true);
});

const h = await bridgeHarness({ config: { socialV2: { wake: { observationMode: 'background', maxWakePerMinute: 1, maxWakePerHour: 12 }, proactive: { enabled: false } } } });
h.setMode('reserved2');
const st = h.getSocialV2State(key);
h.cfg.socialV2.send.maxSendPerMinute = 10; h.cfg.socialV2.send.maxSendPerHour = 40;
try {
  st.sendTimes = Array(4).fill(Date.now() - 120000);
  h.appendSocialV2Message(key, 'fixture', 'current message', 'current message', false, false, '1', [], '789');
  for (let i = 0; i < 1000; i++) await h.sendWakePromptV2(key, 'probability', { seq: 1 });
  check('a flood at zero ambient quota makes no model calls and never acknowledges unread', () => {
    assert.equal(h.calls.prompts.length, 0); assert.equal(st.unread.length, 1); assert.equal(st.lastReadThroughSeq, 0);
    assert.equal(st.wakeTimes.length, 0); assert.ok(st.quotaWakeTimer); assert.equal(st.quotaWakeItem.seq, 1);
  });
  st.lastAiReplyAt = Date.now(); st.observationStartedAt = Date.now();
  check('true @ and self-quotes keep their priority during continuation', () => {
    const event = { self_id: 999, message: [{ type: 'at', data: { qq: '999' } }] };
    assert.equal(h.evaluateWakeTriggerV2(key, st, event, 'group', '@bot', '@bot', false), 'atMention');
    assert.equal(h.evaluateWakeTriggerV2(key, st, { message: [] }, 'group', 'reply', 'reply', true), 'atMention');
  });
  await h.sendWakePromptV2(key, 'atMention', { seq: 1 });
  check('a fresh explicit call can wake while ambient quota is exhausted', () => assert.equal(h.calls.prompts.length, 1));
  h.pendingWakeKeys.clear(); st.sendTimes = []; st.wakeTimes = Array(12).fill(Date.now() - 120000);
  await h.sendWakePromptV2(key, 'continuation', { seq: 1 });
  check('continuation cannot bypass the hourly wake budget', () => assert.equal(h.calls.prompts.length, 1));
  st.wakeTimes = Array(10).fill(Date.now() - 900000);
  await h.sendWakePromptV2(key, 'probability', { seq: 1 });
  check('ordinary wakes are not denied while the shared quota still has room', () => assert.equal(h.calls.prompts.length, 2));
  h.pendingWakeKeys.clear(); st.wakeTimes = Array(11).fill(Date.now() - 900000);
  await h.sendWakePromptV2(key, 'atMention', { seq: 1 });
  check('direct calls retain queue priority within the same shared hourly cap', () => {
    assert.equal(h.calls.prompts.length, 3); assert.equal(st.wakeTimes.length, 12);
  });
  h.pendingWakeKeys.clear(); st.sendTimes = []; st.wakeTimes = [];
  st.wakeConfig.observationPolicy = 'fixed'; st.wakeConfig.observationMs = 180000;
  st.observationStartedAt = Date.now() - 240000;
  const anchor = st.observationStartedAt, beforeResume = h.calls.prompts.length;
  await h.sendWakePromptV2(key, 'continuation', { seq: 1, quotaResume: true });
  check('a still-unread paced follow-up can finish after expiry without reopening the observation window', () => {
    assert.equal(h.calls.prompts.length, beforeResume + 1); assert.equal(st.observationStartedAt, anchor);
  });
  h.pendingWakeKeys.clear(); st.wakeTimes = [];
  const savedUnread = st.unread; st.unread = [];
  await h.sendWakePromptV2(key, 'continuation', { seq: 1, quotaResume: true });
  check('an already-read follow-up cannot be resurrected by a pacing timer', () => assert.equal(h.calls.prompts.length, beforeResume + 1));
  st.unread = savedUnread;
  st.quotaWakeItem = { reason: 'atMention', seq: 999999 };
  h.deferQuotaWakeV2(key, st, 'probability', 1, Date.now() + 60000);
  check('an obsolete direct candidate cannot suppress a fresh ordinary candidate', () => {
    assert.equal(st.quotaWakeItem.reason, 'probability'); assert.equal(st.quotaWakeItem.seq, 1);
  });
  st.quotaWakeItem = { reason: 'atMention', seq: 1 };
  h.deferQuotaWakeV2(key, st, 'probability', 1, Date.now() + 60000);
  check('a still-unread direct candidate keeps its priority over ordinary participation', () => assert.equal(st.quotaWakeItem.reason, 'atMention'));
  st.pendingWakeReasons = Array.from({ length: 1000 }, (_, i) => ({ reason: i % 2 ? 'probability' : 'atMention', seq: i + 1 }));
  h.coalesceGroupWakesV2(key, st);
  check('busy floods coalesce to two priorities with explicit calls first', () => {
    assert.equal(st.pendingWakeReasons.length, 2); assert.equal(st.pendingWakeReasons[0].reason, 'atMention');
  });

  const server = h.startConsoleServer(); if (!server.listening) await once(server, 'listening');
  const post = body => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/send-message', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken } }, res => {
      let text = ''; res.on('data', x => text += x); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
    }); req.on('error', reject); req.end(JSON.stringify({ key, ...body }));
  });
  try {
    st.lastWakeReason = 'probability'; st.sendTimes = Array(3).fill(Date.now() - 480000);
    const rejected = await post({ messages: ['one', 'two'] });
    check('HTTP rejects an over-budget batch before QQ effects with an exact quota receipt', () => {
      assert.equal(rejected.status, 429); assert.equal(rejected.data.remaining, 1); assert.equal(rejected.data.unknown, false);
      assert.equal(rejected.data.code, 'SEND_RATE_LIMIT'); assert.equal(st.sendTimes.length, 3); assert.ok(st.quotaStop);
    });
    const sent = await post({ messages: 'one complete reply', stickerId: 'fixture-sticker' });
    check('optional sticker cannot spend the last reserved bubble or suppress delivered text', () => {
      assert.equal(sent.data.ok, true); assert.equal(sent.data.sent, 1); assert.equal(sent.data.stickerResult.status, 'skipped'); assert.equal(st.sendTimes.length, 4);
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
} finally { await h.close(); }

check('history projection keeps conversations/unknown receipts while removing repeated bridge instructions', () => {
  const packet = { messages: [{ text: 'old directed question', messageId: '123' }], recent: [], readThroughSeq: 1 };
  const old = { role: 'user', bridgeWake: { key, snapshot: packet }, content: [{ type: 'text', text: 'repeated bridge instructions'.repeat(400) }] };
  const receipt = { role: 'toolResult', toolName: 'mcp__snowluma__qq_send_message', toolCallId: 'send1', isError: true,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, unknown: true, retryable: false, messageId: '-123', error: 'uncertain delivery', unrelated: 'verbose'.repeat(1000) }) }] };
  const history = [old, { role: 'assistant', content: [{ type: 'toolCall', id: 'send1', name: receipt.toolName, arguments: {} }] }, receipt,
    { role: 'user', content: [{ type: 'text', text: 'fresh question' }], bridgeMemory: { version: 'v2', text: 'current durable memory' } }];
  const before = JSON.stringify(history), result = projectPiContext(history, 24000), text = JSON.stringify(result);
  assert.equal(JSON.stringify(history), before); assert.ok(text.includes('old directed question')); assert.ok(text.includes('fresh question'));
  assert.ok(text.includes('uncertain delivery')); assert.ok(text.includes('-123')); assert.ok(text.includes('unknown'));
  assert.ok(!text.includes('repeated bridge instructions')); assert.ok(!text.includes('verboseverbose'));
  assert.equal(text.split('current durable memory').length - 1, 1); assert.ok(!text.includes('bridgeWake'));
});
check('system prompt and tool schemas reduce the history budget without breaking active pairs', () => {
  const history = [{ role: 'user', content: [{ type: 'text', text: 'old'.repeat(1000) }] },
    { role: 'user', content: [{ type: 'text', text: 'current' }] }, { role: 'assistant', content: [{ type: 'toolCall', id: 'pending', name: 'send', arguments: {} }] }];
  assert.equal(projectPiContext(history, 5000).filter(m => m.role === 'user').length, 2);
  const result = projectPiContext(history, 5000, { systemPrompt: '人设'.repeat(1800), tools: [{ description: 'tool schema' }] });
  assert.equal(result.filter(m => m.role === 'user').length, 1); assert.equal(result.at(-1).toolCallId, 'pending');
  assert.ok(result.at(-1).isError); assert.ok(estimateContextTokens('群聊消息') > 4);
});
check('existing archives with time/slang prefixes lose repeated wake instructions without losing message IDs', () => {
  const packet = { messages: [{ messageId: '-555', text: 'legacy directed message' }], recent: [] };
  const history = [{ role: 'user', content: [{ type: 'text', text: `【当前时间】yesterday\n\n【黑话】fixture\n\n【当前角色】fixture\n【会话令牌】fixture\nrepeated legacy instructions\n\n【本次消息快照】\n${JSON.stringify(packet)}\n先用快照，不重复查询；partial=true 才补读。` }] },
    { role: 'user', content: [{ type: 'text', text: 'current message' }] }];
  const text = JSON.stringify(projectPiContext(history));
  assert.ok(text.includes('legacy directed message')); assert.ok(text.includes('-555')); assert.ok(!text.includes('repeated legacy instructions'));
});
check('official reasoning replay preserves only the selected model and keeps full archives intact', () => {
  const model = { provider: 'deepseek-official', api: 'openai-completions', id: 'deepseek-flash' };
  const assistant = (provider, id) => ({ role: 'assistant', provider, api: model.api, model: id, content: [
    { type: 'thinking', thinking: 'synthetic fixture reasoning', thinkingSignature: 'reasoning_content' }, { type: 'text', text: 'fixture reply' }] });
  const history = [{ role: 'user', content: [{ type: 'text', text: 'first' }] }, assistant('deepseek-official', 'deepseek-flash'),
    assistant('apimart', 'glm-5.3-flash'), assistant('deepseek-official', 'other-model'), { role: 'user', content: [{ type: 'text', text: 'next' }] }];
  const original = JSON.stringify(history);
  const retained = projectPiContext(history, 24000, { reasoningModel: model }).filter(m => m.role === 'assistant');
  assert.equal(retained[0].content.filter(c => c.type === 'thinking').length, 1);
  assert.equal(retained[1].content.filter(c => c.type === 'thinking').length, 0);
  assert.equal(retained[2].content.filter(c => c.type === 'thinking').length, 0);
  assert.ok(projectPiContext(history).filter(m => m.role === 'assistant').every(m => m.content.every(c => c.type !== 'thinking')));
  assert.equal(JSON.stringify(history), original);
});
console.log(`${checks} group budget/context checks passed; no paid calls or QQ sends.`);
