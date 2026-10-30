import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { buildToolExposure } from '../src/simple-tools.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('historical sticker tool publishes its real required ID, and combined sends keep trusted binding', () => {
  const str = { type: 'string' };
  const definitions = [
    { name: 'mcp__snowluma__qq_send_sticker', parameters: { type: 'object', properties: { key: str, token: str, stickerId: str }, required: ['key','token','stickerId'] } },
    { name: 'mcp__snowluma__qq_send_message', parameters: { type: 'object', properties: { key: str, token: str, messages: str, stickerId: str }, required: ['key','token','messages'] } },
  ];
  const tools = buildToolExposure(definitions, { enabled: true, turn: { key: 'group:456', token: 'trusted-fixture', readThroughSeq: 3 } });
  for (const name of ['qq_send_sticker','mcp__snowluma__qq_send_sticker']) {
    const schema = tools.find(t => t.name === name).parameters;
    assert.deepEqual(schema.required, ['stickerId']); assert.equal(schema.properties.stickerId.type, 'string');
    assert.equal(Object.hasOwn(schema.properties, 'token'), false);
  }
  for (const name of ['send','qq_send_message','mcp__snowluma__qq_send_message']) {
    const tool = tools.find(t => t.name === name);
    assert(tool.parameters.properties.stickerId);
    const args = tool.bindArgs({ text: '好耶', stickerId: 'fixture-sticker', key: 'private:999', token: 'forged', throughSeq: 999 });
    assert.equal(args.key, 'group:456'); assert.equal(args.token, 'trusted-fixture');
    assert.equal(args.throughSeq, 3); assert.equal(args.stickerId, 'fixture-sticker');
    assert.deepEqual(JSON.parse(args.messages), ['好耶']);
  }
});

test('real MCP combined reply forwards optional sticker and preserves old text-only body', async () => {
  const source = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf("server.tool(\n  'qq_send_message',"), end = source.indexOf("if (cfg.socialV2?.tools?.sendPoke", start);
  assert(start > 0 && end > start);
  let handler, schema, sent;
  const chain = new Proxy({}, { get: () => () => chain });
  const z = new Proxy({}, { get: () => () => chain });
  vm.runInNewContext(source.slice(start,end), { z, memoryOperation: chain, serializeModelData: JSON.stringify,
    server: { tool: (_n,_d,s,fn) => { schema = s; handler = fn; } },
    agentApi: async (_r, options) => { sent = JSON.parse(options.body); return { ok: true }; },
  });
  assert(schema.stickerId);
  await handler({ key: 'group:456', token: 'fixture', messages: '好耶', stickerId: 'fixture-sticker' });
  assert.equal(sent.stickerId, 'fixture-sticker'); assert.equal(sent.messages, '好耶');
  await handler({ key: 'group:456', token: 'fixture', messages: '旧调用' });
  assert.equal(Object.hasOwn(sent,'stickerId'), false);
});

test('actual HTTP reply sends two separate bubbles; optional sticker failure never repeats text', async t => {
  let imageAttempts = 0, failImage = false;
  const order = [], sentTexts = [];
  const h = await bridgeHarness({ globals: {
    safeFetchBuffer: async () => ({ buffer: Buffer.from('fixture-image') }),
    fetch: async (url, init) => {
      const action = String(url).split('/').pop();
      if (action === 'send_group_msg' || action === 'send_private_msg') {
        const segments = JSON.parse(init.body).message;
        if (segments.some(s => s.type === 'image')) {
          imageAttempts++; order.push('sticker');
          if (failImage) throw Error('fixture response lost after possible delivery');
        } else {
          order.push('text'); sentTexts.push(segments.filter(s => s.type === 'text').map(s => s.data.text).join(''));
        }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9010 } }) };
    },
  } });
  t.after(() => h.close()); h.setMode('reserved2');
  const st = h.getSocialV2State('group:456');
  h.cfg.socialV2.send.maxSendPerMinute = 100; h.cfg.socialV2.send.maxSendPerHour = 100;
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(r => server.once('listening',r));
  t.after(() => new Promise(r => server.close(r)));
  const request = async (body, token = st.agentToken) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/send-message`, {
      method: 'POST', headers: { 'content-type':'application/json', 'x-console-token':'fixture-console-token','x-agent-token':token },
      body: JSON.stringify({ key:'group:456',messages:'好耶',...body }),
    });
    return { status:res.status,data:await res.json() };
  };
  const first = await request({ stickerId:'fixture-sticker' });
  assert.equal(first.status,200,JSON.stringify(first.data)); assert.equal(first.data.sent,1); assert.equal(first.data.stickerResult.sent,1);
  assert.equal(sentTexts.length,1); assert.equal(sentTexts[0],'好耶'); assert.equal(imageAttempts,1);assert.deepEqual(order,['text','sticker']);
  assert.equal(st.sendTimes.length,2,'each bubble consumes quota');
  assert.equal(st.recentMessages.filter(m => m.sticker).length,1);
  failImage = true;
  const second = await request({ stickerId:'fixture-sticker', messages:'下一句话' });
  assert.equal(second.data.ok,true); assert.equal(second.data.failed,0); assert.equal(second.data.sent,1);
  assert.equal(second.data.stickerResult.status,'unknown'); assert.equal(second.data.stickerResult.retry,false);
  assert.equal(sentTexts.length,2); assert.equal(imageAttempts,2); assert.equal(st.sendTimes.length,4,'unknown image keeps its reservation');
  assert.equal(st.recentMessages.filter(m => m.sticker).length,1,'must not claim an unverified image was sent');
  await request({ messages:'纯文字兼容' }); assert.equal(imageAttempts,2); assert.equal(sentTexts.length,3);
  for (const stickerId of ['',42,'does-not-exist']) {
    const reply = await request({ stickerId });
    assert.equal(reply.data.ok,true); assert.equal(reply.data.stickerResult.status,'skipped');
  }
  assert.equal(imageAttempts,2); assert.equal(st.sendTimes.length,8);
  h.cfg.socialV2.tools.sendSticker = false;
  assert.equal((await request({ stickerId:'fixture-sticker' })).data.stickerResult.status,'skipped');
  h.cfg.socialV2.tools.sendSticker = true;
  st.sendTimes=[];h.cfg.socialV2.send.maxSendPerMinute=1;
  const limited=await request({ stickerId:'fixture-sticker' });
  assert.equal(limited.data.ok,true);assert.equal(limited.data.stickerResult.status,'skipped');assert.equal(st.sendTimes.length,1);
  st.sendTimes=[];h.cfg.socialV2.send.maxSendPerMinute=100;
  const before=sentTexts.length;
  assert.equal((await request({ stickerId:'fixture-sticker' },'wrong-token')).status,403);
  assert.equal((await request({ key:'group:999',stickerId:'fixture-sticker' })).status,403);
  h.cfg.socialV2.tools.sendMessage=false;
  assert.equal((await request({ stickerId:'fixture-sticker' })).status,403);h.cfg.socialV2.tools.sendMessage=true;
  fs.writeFileSync(path.join(h.temp,'state/current-role.json'),JSON.stringify({role:'fixture-role',mode:'silent'}));
  assert.equal((await request({ stickerId:'fixture-sticker' })).status,403);
  assert.equal(sentTexts.length,before);assert.equal(imageAttempts,2);assert.equal(st.sendTimes.length,0);
});
