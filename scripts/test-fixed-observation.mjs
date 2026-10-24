import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function fixture(t) {
  let now=Date.now();class Clock extends Date { static now(){return now;} }
  const h=await bridgeHarness({config:{socialV2:{proactive:{enabled:false},wake:{observationMode:'background',preSleepWaitMs:300000}}},globals:{Date:Clock}});
  h.setMode('reserved2');const key='group:456',st=h.getSocialV2State(key);
  Object.assign(st.wakeConfig,{observationMs:180000,observationPolicy:'fixed',batchWindowMs:20000,confirmedBy:'set_wake_config'});st.wakeConfig.triggers={atMention:true,probability:0.02};
  const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await new Promise(r=>server.close(r));await h.close();});
  const request=async(route,body,admin=false,requestKey=key)=>{
    const target=h.getSocialV2State(requestKey);const res=await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/${route}?key=${requestKey}`,{
      method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-console-token':'fixture-console-token',...(admin?{'x-console-admin':'1'}:{'x-agent-token':target.agentToken})},
      body:body===undefined?undefined:JSON.stringify({key:requestKey,...body})});
    return {status:res.status,data:await res.json()};
  };
  const append=()=>h.appendSocialV2Message(key,'fixture','hello','hello',false,false,String(st.lastUnreadSeq+1),[],'123');
  const trigger=()=>h.evaluateWakeTriggerV2(key,st,{},'group','fixture','fixture',false);
  return {h,key,st,request,append,trigger,advance:ms=>{now+=ms;},now:()=>now};
}

test('real group replies never extend the fixed deadline and persisted start survives reload',async t=>{
  const f=await fixture(t);f.append();await f.h.sendWakePromptV2(f.key,'atMention');const start=f.st.observationStartedAt;
  assert.equal(start,f.now());f.h.pendingWakeKeys.delete(f.key);f.advance(120000);
  assert.equal((await f.request('send-message',{messages:['fixture reply']})).status,200);
  assert.equal(f.st.observationStartedAt,start);assert.equal(f.st.lastAiReplyAt,f.now());assert.equal(f.trigger(),'continuation');
  f.advance(61000);assert.equal(f.trigger(),null);
  await f.request('send-message',{messages:['in-flight completion']});assert.equal(f.trigger(),null);assert.equal(f.st.observationStartedAt,start);
  const saved=JSON.parse(fs.readFileSync(f.h.temp+'/state/social-v2.json'));assert.equal(saved.conversations[f.key].observationStartedAt,start);
  // Recreate a bridge from the actual serialized state to exercise load, not a hand-built object.
  const restored=await bridgeHarness({savedSocialState:saved,config:{socialV2:{wake:{observationMode:'background',preSleepWaitMs:300000},proactive:{enabled:false}}},globals:{Date:class extends Date {static now(){return f.now();}}}});
  t.after(()=>restored.close());const original=restored.getSocialV2State(f.key);assert.equal(original.observationStartedAt,start);assert.equal(original.wakeConfig.observationPolicy,'fixed');
  assert.equal(restored.evaluateWakeTriggerV2(f.key,original,{},'group','fixture','fixture',false),null);
});

test('queued continuation expires without reopening; a new explicit mention opens the next round',async t=>{
  const f=await fixture(t);f.st.observationStartedAt=f.now();f.st.lastAiReplyAt=f.now();f.advance(179000);f.append();assert.equal(f.trigger(),'continuation');
  f.advance(20000);const old=f.st.observationStartedAt;await f.h.sendWakePromptV2(f.key,'continuation');
  assert.equal(f.h.calls.prompts.length,0);assert.equal(f.st.observationStartedAt,old);
  await f.h.sendWakePromptV2(f.key,'atMention');assert.equal(f.h.calls.prompts.length,1);assert.equal(f.st.observationStartedAt,f.now());
});

test('automatic opportunities cool down after expiry, but direct mentions and private sliding windows work',async t=>{
  const f=await fixture(t);f.st.observationStartedAt=f.now()-181000;f.st.lastAiReplyAt=f.now()-1000;f.st.wakeConfig.triggers.anyMessage=true;f.st.wakeConfig.triggers.probability=1;
  assert.equal(f.trigger(),null);f.append();await f.h.sendWakePromptV2(f.key,'proactiveCheck');assert.equal(f.h.calls.prompts.length,0);
  const event={self_id:999,message:[{type:'at',data:{qq:'999'}}]};assert.equal(f.h.evaluateWakeTriggerV2(f.key,f.st,event,'group','hello','hello',false),'atMention');
  const privateChat=f.h.getSocialV2State('private:123');privateChat.lastAiReplyAt=f.now()-181000;
  assert.equal(f.h.evaluateWakeTriggerV2('private:123',privateChat,{},'private','hello','hello',false),'continuation');
  f.advance(180000);assert.equal(f.trigger(),'probability');await f.h.sendWakePromptV2(f.key,'probability');assert.equal(f.h.calls.prompts.length,1);
});

test('busy or quota-blocked candidates cannot open or extend a fixed round',async t=>{
  const f=await fixture(t);f.append();f.st.observationStartedAt=f.now()-200000;
  f.h.pendingWakeKeys.add(f.key);await f.h.sendWakePromptV2(f.key,'atMention');assert.equal(f.st.observationStartedAt,f.now()-200000);
  f.h.pendingWakeKeys.delete(f.key);f.h.cfg.socialV2.wake.maxWakePerMinute=1;f.st.wakeTimes=[f.now()];
  await f.h.sendWakePromptV2(f.key,'atMention');assert.equal(f.st.observationStartedAt,f.now()-200000);assert.equal(f.h.calls.prompts.length,0);
});

test('failed dispatch rolls back the opened window without losing unread messages',async t=>{
  const f=await fixture(t);f.append();f.h.api.sessions.prompt=async()=>({result:{ok:false,error:{message:'fixture failure'}}});
  const old=f.st.observationStartedAt;await f.h.sendWakePromptV2(f.key,'atMention');
  assert.equal(f.st.observationStartedAt,old||0);assert.equal(f.st.unread.length,1);
});

test('only the admin can enable the fixed group policy and capability/prompt describe it',async t=>{
  const f=await fixture(t);delete f.st.wakeConfig.observationPolicy;
  await f.request('wake-config',{config:{observationPolicy:'fixed'}});assert.equal(f.st.wakeConfig.observationPolicy,undefined);
  let r=await f.request('wake-config',{config:{observationPolicy:'fixed'}},true);assert.equal(r.status,200);assert.equal(r.data.wakeConfig.observationPolicy,'fixed');
  await f.request('wake-config',{config:{observationPolicy:'fixed'}},true,'private:123');assert.equal(f.h.getSocialV2State('private:123').wakeConfig.observationPolicy,undefined);
  r=await f.request('prompt');assert.equal(r.data.workflow.observationPolicy,'fixed');assert.equal(r.data.workflow.observationMs,180000);
  f.append();assert.match(f.h.buildWakePromptV2(f.key,'atMention'),/固定窗口，回复不续期/);
});

test('wake safety resets preserve the admin fixed policy, duration, frequency, and original anchor',async t=>{
  const f=await fixture(t);f.st.observationStartedAt=f.now()-181000;f.st.lastAiReplyAt=f.now();
  const start=f.st.observationStartedAt;f.st.wakeConfig.triggers={probability:0};
  f.h.ensureWakeableV2(f.st,{key:f.key});
  assert.equal(f.st.wakeConfig.observationPolicy,'fixed');assert.equal(f.st.wakeConfig.observationMs,180000);
  assert.equal(f.st.wakeConfig.batchWindowMs,20000);assert.equal(f.st.observationStartedAt,start);
  assert.equal(f.trigger(),null);assert.equal(f.st.wakeConfig.triggers.probability,0);
});
