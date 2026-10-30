import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { aliyunRequest } from '../src/aliyun-tts.js';
import { SPEECH_EMOTIONS } from '../src/speech-emotion.js';

async function fixture(t,{failure='synthesis'}={}) {
  let syntheses=0,sends=0;
  const h=await bridgeHarness({globals:{
    loadTtsConfig:()=>({enabled:true,approved:true,autonomous:true,roleName:'守岸人',maxChars:120}),
    synthesizeLocal:async root=>{syntheses++;if(failure==='synthesis')throw Error('阿里云语音请求失败或超时（ECONNRESET）');
      const file=path.join(root,'state','fixture.wav');fs.writeFileSync(file,Buffer.alloc(44));return{file,detail:{seconds:1}};},
    inspectAudio:async()=>({ok:true,seconds:1,bytes:44,format:'wav'}),
    fetch:async url=>{if(String(url).endsWith('/send_group_msg')){sends++;throw Error('fixture QQ response unknown');}
      throw Error('Unexpected fixture request');},
  }});
  t.after(()=>h.close());h.setMode('reserved2');
  fs.writeFileSync(path.join(h.temp,'state/current-role.json'),'{"role":"守岸人"}');
  const st=h.getSocialV2State('group:456'),server=h.startConsoleServer();
  if(!server.listening)await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>server.close(r)));
  return {counts:()=>({syntheses,sends}),request:async()=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/speak`,{method:'POST',
      headers:{'content-type':'application/json','x-console-token':'fixture-console-token','x-agent-token':st.agentToken},
      body:JSON.stringify({key:'group:456',text:'我在这里。'})});return{status:response.status,data:await response.json()};
  }};
}

test('actual synthesis failure is known not sent; old failed request cannot trigger another paid synthesis',async t=>{
  const f=await fixture(t),r=await f.request();
  assert.equal(r.status,400);assert.equal(r.data.stage,'synthesis');assert.equal(r.data.unknown,false);
  assert.equal(r.data.retryable,false);assert.match(r.data.error,/ECONNRESET/);assert.match(r.data.hint,/尚未发送/);
  assert.deepEqual(f.counts(),{syntheses:1,sends:0});
  const duplicate=await f.request();assert.equal(duplicate.data.unknown,true);assert.match(duplicate.data.error,/待核对/);
  assert.deepEqual(f.counts(),{syntheses:1,sends:0});
});

test('uncertain QQ delivery remains unknown and cannot be repeated',async t=>{
  const f=await fixture(t,{failure:'delivery'}),r=await f.request();
  assert.equal(r.status,400);assert.equal(r.data.stage,'delivery');assert.equal(r.data.unknown,true);assert.equal(r.data.retryable,false);
  await f.request();assert.deepEqual(f.counts(),{syntheses:1,sends:1});
});

test('actual MCP speech wrapper exposes safe failure cause and preserves unknown-delivery protection',async()=>{
  const source=fs.readFileSync(new URL('../src/mcp-snowluma-safe.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
  const apiStart=source.indexOf('async function agentApi(path, init = {}) {'),apiEnd=source.indexOf('async function authorizeRead(',apiStart);
  const apiContext=vm.createContext({readConsoleToken:()=> 'fixture',agentApiBase:()=> 'http://fixture.test',AbortSignal,
    fetch:async()=>({ok:false,status:400,json:async()=>({error:'fixture synthesis failure',stage:'synthesis',unknown:false,retryable:false})})});
  vm.runInContext(source.slice(apiStart,apiEnd)+'\nglobalThis.fixtureApi=agentApi;',apiContext);
  await assert.rejects(apiContext.fixtureApi('/api/socialV2/speak'),e=>e.stage==='synthesis'&&e.unknown===false&&e.retryable===false);
  const start=source.indexOf("server.tool(\n  'qq_speak',"),end=source.indexOf('if (cfg.socialV2?.voice?.enabled',start);
  assert.ok(start>0&&end>start);
  let handler,known=true;const chain=new Proxy({},{get:()=>()=>chain});
  const context=vm.createContext({server:{tool:(_n,_d,_s,fn)=>handler=fn},z:{string:()=>chain,enum:()=>chain},SPEECH_EMOTIONS,serializeModelData:JSON.stringify,
    agentApi:async()=>{const e=Error('阿里云语音请求失败或超时（ECONNRESET）');if(known){e.unknown=false;e.stage='synthesis';}throw e;}});
  vm.runInContext(source.slice(start,end),context);
  let result=JSON.parse((await handler({key:'group:456',token:'fixture',text:'你好'})).content[0].text);
  assert.equal(result.unknown,false);assert.equal(result.stage,'synthesis');assert.match(result.error,/ECONNRESET/);assert.match(result.hint,/不代表语音功能关闭/);
  known=false;result=JSON.parse((await handler({key:'group:456',token:'fixture',text:'你好'})).content[0].text);
  assert.equal(result.unknown,true);assert.equal(result.retryable,false);assert.match(result.hint,/不要重发/);
});

test('network diagnostics reveal only allowlisted codes, never credential-bearing raw exception text',async()=>{
  const config={apiKey:'fixture-secret-key',workspaceId:'fixture',region:'cn-beijing'};
  await assert.rejects(aliyunRequest(config,'SpeechSynthesizer',{}, {fetchImpl:async()=>{
    throw Object.assign(Error('Authorization Bearer fixture-secret-key'),{cause:{code:'ECONNRESET'}});
  }}),e=>e.message.includes('ECONNRESET')&&!e.message.includes(config.apiKey));
  await assert.rejects(aliyunRequest(config,'SpeechSynthesizer',{}, {fetchImpl:async()=>{
    throw Object.assign(Error('private URL'),{cause:{code:'NOT_A_REAL_CODE'}});
  }}),e=>e.message==='阿里云语音请求失败或超时');
});
