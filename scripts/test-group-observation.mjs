import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('group continuation expires at three minutes while private/default conversations retain five', async t => {
  const h = await bridgeHarness({ config: { socialV2: { proactive: { enabled: false }, wake: { observationMode: 'background', preSleepWaitMs: 300000 } } } });
  t.after(() => h.close()); h.setMode('reserved2');
  const group=h.getSocialV2State('group:456'),privateChat=h.getSocialV2State('private:123');
  group.wakeConfig.observationMs=180000;group.wakeConfig.triggers={atMention:true};privateChat.wakeConfig.triggers={};
  const trigger=(key,st,event={},quote=false)=>h.evaluateWakeTriggerV2(key,st,event,key.split(':')[0],'fixture','fixture',quote);
  group.lastAiReplyAt=Date.now()-179000;assert.equal(trigger('group:456',group),'continuation');
  group.lastAiReplyAt=Date.now()-181000;assert.equal(trigger('group:456',group),null);
  assert.equal(trigger('group:456',group,{self_id:999,message:[{type:'at',data:{qq:'999'}}]}),'atMention');
  privateChat.lastAiReplyAt=Date.now()-181000;assert.equal(trigger('private:123',privateChat),'continuation');
  privateChat.lastAiReplyAt=Date.now()-301000;assert.equal(trigger('private:123',privateChat),'private');
  const other=h.getSocialV2State('group:789');other.wakeConfig.triggers={};other.lastAiReplyAt=Date.now()-181000;
  assert.equal(trigger('group:789',other),'continuation');
});

test('admin can persist a group observation override without changing probability/batch or private settings; agent cannot overwrite it', async t => {
  const h=await bridgeHarness({config:{socialV2:{proactive:{enabled:false},wake:{observationMode:'background',preSleepWaitMs:300000}}}});
  h.setMode('reserved2');const key='group:456',st=h.getSocialV2State(key);st.wakeConfig.triggers.probability=0.02;st.wakeConfig.batchWindowMs=20000;
  const privateChat=h.getSocialV2State('private:123'),privateBefore=JSON.stringify(privateChat.wakeConfig),server=h.startConsoleServer();
  if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await h.close();});
  const update=async(admin,ms)=>{
    const r=await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/wake-config`,{method:'POST',headers:{'content-type':'application/json','x-console-token':'fixture-console-token',...(admin?{'x-console-admin':'1'}:{'x-agent-token':st.agentToken})},body:JSON.stringify({key,config:{observationMs:ms}})});
    assert.equal(r.status,200);return r.json();
  };
  const r=await update(true,180000);assert.equal(r.wakeConfig.observationMs,180000);assert.equal(r.markedCount,0);
  assert.equal(r.wakeConfig.triggers.probability,0.02);assert.equal(r.wakeConfig.batchWindowMs,20000);assert.equal(JSON.stringify(privateChat.wakeConfig),privateBefore);
  await update(false,300000);assert.equal(st.wakeConfig.observationMs,180000);
  const fs=await import('node:fs');const saved=JSON.parse(fs.readFileSync(h.temp+'/state/social-v2.json'));assert.equal(saved.conversations[key].wakeConfig.observationMs,180000);
  h.appendSocialV2Message(key,'fixture','hello','hello',false,false,'1',[],'123');
  const prompt=h.buildWakePromptV2(key,'continuation');assert.match(prompt,/后台监听3分钟/);
  const capability=await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/prompt?key=${key}`,{headers:{'x-console-token':'fixture-console-token','x-agent-token':st.agentToken}});
  const detail=await capability.json();assert.equal(capability.status,200);assert.equal(detail.workflow.observationMs,180000);
});

test('an expired three minute continuation cannot bypass wake quotas', async t => {
  const h=await bridgeHarness({config:{socialV2:{proactive:{enabled:false},wake:{observationMode:'background',preSleepWaitMs:300000,maxWakePerMinute:1}}}});
  t.after(()=>h.close());h.setMode('reserved2');const key='group:456',st=h.getSocialV2State(key);
  st.wakeConfig.observationMs=180000;st.wakeTimes=[Date.now()];st.lastAiReplyAt=Date.now()-181000;
  h.appendSocialV2Message(key,'fixture','hello','hello',false,false,'1',[],'123');
  await h.sendWakePromptV2(key,'continuation');assert.equal(h.calls.prompts.length,0);
  st.lastAiReplyAt=Date.now()-179000;await h.sendWakePromptV2(key,'continuation');assert.equal(h.calls.prompts.length,1);
});
