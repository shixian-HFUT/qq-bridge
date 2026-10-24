import assert from 'node:assert/strict';
import { once } from 'node:events';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const h = await bridgeHarness({ config: { socialV2: {
  sticker: { enabled: false }, proactive: { enabled: false }, wake: { observationMode: 'background' },
  send: { burstIntervalMinMs: 0, burstIntervalMaxMs: 0 }
} } });
h.setMode('reserved2');
const st = h.getSocialV2State(KEY), privateKey = 'private:123';
const pst = h.getSocialV2State(privateKey);
const server = h.startConsoleServer();
if (!server.listening) await once(server, 'listening');
const request = async (route, body, { admin = false, key = KEY, token = st.agentToken } = {}) => {
  const result = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/${route}${route.includes('?') ? '&' : '?'}key=${key}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
      ...(admin ? { 'x-console-admin': '1' } : { 'x-agent-call': '1', 'x-agent-token': token }) },
    body: body === undefined ? undefined : JSON.stringify({ key, ...body })
  });
  return { status: result.status, data: await result.json() };
};
try {
  const full = '我偏好文字交流，毕业设计的内容很长。' + '全文'.repeat(200);
  h.appendSocialV2Message(KEY, '测试昵称', full, full, false, false, '101', [], '12345');
  const unread = await request('unread');
  const send = await request('send-message', { messages: ['记下了'], throughSeq: unread.data.readThroughSeq,
    memoryOps: [{ kind: 'userFact', subject: '12345', content: '偏好文字交流', sourceMessageId: '101' }] });
  assert.equal(send.status, 200); assert.equal(send.data.turnComplete, true);
  assert.equal(send.data.memoryResult.ok, true); assert.equal(st.unread.length, 0);
  console.log('PASS memory save + final send keeps successful terminal close');
  assert.ok(h.memoryContextV3(KEY).text.includes('偏好文字交流'));
  const found = await request('memory-history?q=毕业');
  assert.ok(found.data.messages[0].text.length > 200);
  assert.equal(found.data.messages[0].partialArchive, false);
  console.log('PASS live full text is archived before short social-view truncation');

  h.appendSocialV2Message(privateKey, 'private', '只在私聊里的秘密', '只在私聊里的秘密', false, true, 'p1', [], '123');
  assert.equal((await request('memory-history?q=秘密')).data.messages.length, 0);
  assert.equal((await request('memory-history', undefined, { key: privateKey })).status, 403);
  const ownPrivate = await request('memory-history?q=秘密', undefined, { key: privateKey, token: pst.agentToken });
  assert.equal(ownPrivate.data.messages.length, 1);
  console.log('PASS real HTTP session token binding and raw private-history isolation');

  const adminView = await request('long-memory', undefined, { admin: true });
  const fact = adminView.data.entries[0];
  assert.ok(adminView.data.stats); assert.ok(adminView.data.preview.chars <= 1600);
  const noAdmin = await request('long-memory');
  assert.equal(noAdmin.data.stats, undefined); assert.equal(noAdmin.data.entries[0].origin, undefined);
  const badToken = await request('long-memory', undefined, { token: 'invalid' });
  assert.equal(badToken.status, 403);
  assert.equal((await request('long-memory', { backup: true })).status, 403);
  assert.equal((await request('long-memory', { backup: true }, { admin: true })).data.ok, true);
  console.log('PASS admin stats/consistent backup stay outside agent surface');

  const sends = () => h.calls.http.filter(c => /send_group_msg$/.test(c.url)).length;
  const beforeSends = sends();
  h.appendSocialV2Message(KEY, '测试昵称', '第二条', '第二条', false, false, '102', [], '12345');
  const nextRead = await request('unread');
  const badMemory = await request('send-message', { messages: ['正常回复'], throughSeq: nextRead.data.readThroughSeq,
    memoryOps: [{ kind: 'userFact', subject: '99999', content: '冒名资料', sourceMessageId: '102' }] });
  assert.equal(badMemory.data.ok, true); assert.equal(badMemory.data.memoryResult.ok, false);
  assert.equal(badMemory.data.turnComplete, true); assert.equal(sends(), beforeSends + 1);
  console.log('PASS failed memory is reported separately and cannot make QQ delivery retryable');

  h.socialV2.sharedMemory.memberImpressions['12345'] = { uid: '12345', name: '旧昵称', traits: ['偏好文字'], lastSeenAt: Date.now() - 100000 };
  h.appendSocialV2Message(KEY, '新昵称', '重新发言', '重新发言', false, false, '103', [], '12345');
  assert.ok(Date.now() - h.socialV2.sharedMemory.memberImpressions['12345'].lastSeenAt < 2000);
  console.log('PASS existing member impression renews by uid after nickname change');

  await request('long-memory', { operations: [{ action: 'remove', id: fact.id, revision: fact.revision }] });
  assert.ok(!h.memoryContextV3(KEY).text.includes('userFact/12345'));
  console.log('PASS forgotten long-term fact leaves automatic snapshot immediately');
} finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
