import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY='group:456';
const plain=value=>JSON.parse(JSON.stringify(value));
async function fixture(t, resolve) {
  class Bot {
    async getMessage(id) { return resolve?.(id); }
    async getGroupMemberInfo(group, uid) { return { card: '同名群友', user_id: uid }; }
  }
  const h=await bridgeHarness({config:{socialV2:{proactive:{enabled:false},sticker:{enabled:false}}},
    globals:{SnowLumaWebSocketClient:Bot}});
  t.after(()=>h.close());h.setMode('reserved2');h.socialV2.paused=true;
  return h;
}
async function incoming(h,uid,id,message,card='同名群友') {
  await h.handleIncoming('group',456,{user_id:uid,group_id:456,self_id:99999,message_id:id,
    sender:{user_id:uid,card},message},h.cfg);
}
const text=value=>({type:'text',data:{text:value}});

test('interleaved same-name members retain authors, own text, quote author and real mentions',async t=>{
  const h=await fixture(t,id=>({group_id:456,sender:{user_id:78901,card:'同名群友'},message:[text('我想抽满链秧秧')]}));
  await incoming(h,78901,501,[text('我想抽满链秧秧')]);
  await incoming(h,12345,502,[{type:'reply',data:{id:501}},{type:'at',data:{qq:'78901'}},text('你刚才说的那个，我还没抽')]);
  const st=h.getSocialV2State(KEY),a=st.recentMessages[0],b=st.recentMessages[1];
  assert.equal(a.userId,'78901');assert.equal(b.userId,'12345');assert.equal(a.sender,b.sender);
  assert.equal(b.reply.userId,'78901');assert.equal(b.reply.messageId,'501');assert.equal(b.reply.isSelf,false);
  assert.deepEqual(plain(b.atUserIds),['78901']);assert.doesNotMatch(b.plain,/满链/);
  const snapshot=h.buildWakeSnapshotV2(KEY);
  assert.equal(snapshot.messages[1].reply.userId,'78901');assert.equal(snapshot.messages[1].userId,'12345');
  assert.deepEqual(plain(snapshot.messages[1].atUserIds),['78901']);
  assert.equal(snapshot.readThroughSeq,2);assert.equal(snapshot.partial,false);
  assert.match(h.buildWakePromptV2(KEY,'atMention'),/userId=12345，messageId=502/);
});

test('same account changing names stays the same person; plain-text @ and all never create a target identity',async t=>{
  const h=await fixture(t);
  await incoming(h,78901,501,[text('我喜欢兔子')],'旧名字');
  await incoming(h,78901,502,[text('@12345 我改名啦'),{type:'at',data:{qq:'all'}}],'新名字');
  const st=h.getSocialV2State(KEY);
  assert.equal(st.recentMessages[0].userId,st.recentMessages[1].userId);
  assert.notEqual(st.recentMessages[0].sender,st.recentMessages[1].sender);
  assert.equal(st.recentMessages[1].atUserIds,undefined);
  assert.equal(st.recentMessages[1].reply,undefined);
});

test('foreign or unavailable quoted messages stay unresolved instead of assigning an author',async t=>{
  const h=await fixture(t,id=>id===501?{group_id:777,sender:{user_id:78901},message:[text('外群私密事实')]}:null);
  for(const id of [501,503])await incoming(h,12345,id+1,[{type:'reply',data:{id}},text('这个呢')]);
  for(const m of h.getSocialV2State(KEY).recentMessages){
    assert.equal(m.userId,'12345');assert.equal(m.reply.resolved,false);assert.equal(m.reply.userId,undefined);
    assert.doesNotMatch(m.text,/外群私密事实/);
  }
});

test('OneBot string messages keep their author without inventing structured reply or mentions',async t=>{
  const h=await fixture(t);
  await incoming(h,12345,502,'@78901 我还没有抽');
  const m=h.getSocialV2State(KEY).recentMessages[0];
  assert.equal(m.userId,'12345');assert.equal(m.plain,'@78901 我还没有抽');
  assert.equal(m.atUserIds,undefined);assert.equal(m.reply,undefined);
});

test('quoting the bot identifies the bot separately from the current author',async t=>{
  const h=await fixture(t,()=>({group_id:456,sender:{user_id:99999,card:'阿米娅'},message:[text('早上好')]}));
  await incoming(h,12345,502,[{type:'reply',data:{id:501}},text('早上好呀')]);
  const m=h.getSocialV2State(KEY).recentMessages[0];
  assert.equal(m.userId,'12345');assert.equal(m.isSelf,false);assert.equal(m.reply.userId,'99999');
  assert.equal(m.reply.isSelf,true);assert.equal(m.quoteTargetIsSelf,true);
});

test('actual send endpoint preserves explicit reply identity when gateway lookup is unavailable',async t=>{
  const h=await fixture(t);h.socialV2.paused=false;
  h.appendSocialV2Message(KEY,'同名群友','我想抽满链秧秧','我想抽满链秧秧',false,false,'-501',[],'78901');
  h.appendSocialV2Message(KEY,'同名群友','我没有抽','我没有抽',false,false,'-502',[],'12345');
  const st=h.getSocialV2State(KEY),server=h.startConsoleServer();
  if(!server.listening)await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/send-message`,{
    method:'POST',headers:{'content-type':'application/json','x-console-token':'fixture-console-token','x-agent-token':st.agentToken},
    body:JSON.stringify({key:KEY,messages:['你这边还没抽呀'],replyToMessageId:'2',atUserId:'12345'})});
  const result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));
  const sent=st.recentMessages.at(-1);
  assert.equal(sent.isSelf,true);assert.equal(sent.replyToMessageId,'-502');assert.equal(sent.replyToUserId,'12345');
  assert.deepEqual(plain(sent.atUserIds),['12345']);assert.equal(result.quoted.userId,'12345');
  const transport=h.calls.http.find(x=>x.url.endsWith('/send_group_msg'));
  assert.equal(transport.body.message[0].type,'reply');assert.equal(transport.body.message[0].data.id,'-502');
  assert.equal(transport.body.message[1].data.qq,'12345');
  h.recordSentMessagesV2(KEY,['第一句','第二句'],{replyToMessageId:'-501',replyToUserId:'78901',atUserId:'78901'});
  assert.equal(st.recentMessages.at(-2).replyToUserId,'78901');
  assert.equal(st.recentMessages.at(-1).replyToMessageId,undefined);assert.equal(st.recentMessages.at(-1).atUserIds,undefined);
});

test('stable preset scopes first-person claims and memory to author without suppressing natural chat',()=>{
  const preset=yaml.load(fs.readFileSync(new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml',import.meta.url),'utf8'));
  const prefix=preset.find(x=>x.id==='persona').config.prefix;
  for(const marker of ['同名不同号','“我/我的”只属于该条发送者','reply.userId','atUserIds','不猜人也不因此冷场','来源userId分别归属','分享','玩笑'])assert.ok(prefix.includes(marker),marker);
});
