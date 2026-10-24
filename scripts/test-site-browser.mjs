import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readerSite, publicImageUrl } from '../src/site-browser-policy.js';
import { readWithSiteBrowser } from '../src/site-browser-client.js';

test('reader accepts only public Bili/Weibo content and search routes', () => {
  for (const u of ['https://www.bilibili.com/opus/123456','https://www.bilibili.com/read/cv123',
    'https://www.bilibili.com/video/BV123abc','https://search.bilibili.com/all?keyword=test',
    'https://space.bilibili.com/123/dynamic','https://t.bilibili.com/123']) assert.equal(readerSite(u),'bilibili');
  for (const u of ['https://weibo.com/123/abc123','https://weibo.com/u/123',
    'https://s.weibo.com/weibo?q=test','https://m.weibo.cn/detail/123']) assert.equal(readerSite(u),'weibo');
  for (const u of ['http://weibo.com/123/a','https://weibo.com.evil.test/123/a','https://weibo.com:8443/123/a',
    'https://u:p@weibo.com/123/a','https://127.0.0.1/123/a','https://www.bilibili.com/account',
    'https://message.bilibili.com/','https://passport.bilibili.com/login','https://weibo.com/messages',
    'https://weibo.com/compose','https://api.weibo.com/2/statuses/update.json','https://weibo.com/123/../messages',
    'file:///etc/passwd']) assert.equal(readerSite(u),null,u);
});
test('image candidates stay on exact site CDNs without embedded credentials', () => {
  assert.equal(publicImageUrl('http://i0.hdslb.com/a.jpg','bilibili','https://www.bilibili.com/opus/123'),'https://i0.hdslb.com/a.jpg');
  assert.equal(publicImageUrl('https://wx1.sinaimg.cn/large/a.jpg','weibo','https://weibo.com/123/a'),'https://wx1.sinaimg.cn/large/a.jpg');
  for(const u of ['https://hdslb.com.evil.test/a.jpg','https://u:p@i0.hdslb.com/a.jpg','https://127.0.0.1/a.jpg','data:image/png,abc'])
    assert.equal(publicImageUrl(u,'bilibili','https://www.bilibili.com/opus/123'),null);
});
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'site-reader-test-'));fs.mkdirSync(path.join(root,'state'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('site-reader-test-'));fs.rmSync(root,{recursive:true,force:true});});
  fs.writeFileSync(path.join(root,'state/site-browser.json'),'{"enabled":true}');
  fs.writeFileSync(path.join(root,'state/site-browser-reader-token'),'a'.repeat(64));return root;
}
test('unsupported URLs and disabled reader never call the broker or read credentials',async t=>{
  const root=fixture(t),fetchImpl=()=>assert.fail('No broker call expected');
  assert.equal(await readWithSiteBrowser(root,'https://example.com/',{fetchImpl}),null);
  fs.writeFileSync(path.join(root,'state/site-browser.json'),'{"enabled":false}');
  assert.equal(await readWithSiteBrowser(root,'https://weibo.com/123/a',{fetchImpl}),null);
});
test('broker uses separate reader auth, returns bounded public data and strips credentials',async t=>{
  const root=fixture(t),token='a'.repeat(64);
  const data=await readWithSiteBrowser(root,'https://weibo.com/123/a',{fetchImpl:async(url,init)=>{
    assert.equal(url,'http://127.0.0.1:15110/v1/fetch');assert.equal(init.method,'POST');
    assert.equal(init.headers['x-browser-reader-token'],token);assert.equal(init.headers['x-browser-admin-token'],undefined);
    assert.deepEqual(JSON.parse(init.body),{url:'https://weibo.com/123/a'});
    return {ok:true,json:async()=>({ok:true,url:'https://weibo.com/123/a',title:'public',body:token+' SUB=private-value '+'x'.repeat(20000),
      cookies:{secret:'must-not-project'},images:[{url:'https://wx1.sinaimg.cn/large/a.jpg'},{url:'https://evil.test/a.jpg'}]})};
  }});
  assert.equal(data.images.length,1);assert.ok(data.body.length<=16000);
  assert.ok(!JSON.stringify(data).includes(token));assert.ok(!JSON.stringify(data).includes('private-value'));assert.equal(data.cookies,undefined);
});
test('login/verification errors stay explicit and redirects cannot expose private pages',async t=>{
  const root=fixture(t);
  const login=await readWithSiteBrowser(root,'https://weibo.com/123/a',{fetchImpl:async()=>({ok:true,json:async()=>({ok:false,code:'login_required',error:'需要扫码'})})});
  assert.equal(login.code,'login_required');assert.equal(login.ok,false);
  await assert.rejects(readWithSiteBrowser(root,'https://weibo.com/123/a',{fetchImpl:async()=>({ok:true,json:async()=>({ok:true,url:'https://weibo.com/messages',body:'private'})})}),/公开读取/);
  await assert.rejects(readWithSiteBrowser(root,'https://weibo.com/123/a',{fetchImpl:async()=>{throw Error('connection failure secret');}}),/暂未连接/);
});

test('actual MCP web_fetch uses the reader and preserves the existing public HTTP path',async()=>{
  const source=fs.readFileSync(new URL('../src/mcp-web-search-safe.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
  const start=source.indexOf("server.tool(\n  'web_fetch',"),end=source.indexOf('\nawait server.connect',start);
  assert.ok(start>=0&&end>start);
  let handler,browser={ok:true,url:'https://weibo.com/123/a',body:'fixture-public'},ordinary=0;
  const chain=new Proxy({},{get:()=>()=>chain});
  const context=vm.createContext({ROOT:'fixture',z:{string:()=>chain},
    server:{tool:(_name,_desc,_schema,fn)=>{handler=fn;}},
    readWithSiteBrowser:async()=>browser,
    safeFetch:async()=>{ordinary++;return{statusCode:200,url:'https://example.test/article',body:'x'.repeat(200)};},
    readableWebText:value=>value,extractWebImages:()=>[],Date});
  vm.runInContext(source.slice(start,end),context);
  let result=await handler({url:'https://weibo.com/123/a'});
  assert.equal(result.isError,false);assert.equal(JSON.parse(result.content[0].text).body,'fixture-public');assert.equal(ordinary,0);
  browser={ok:false,code:'login_required',error:'扫码后再读'};
  result=await handler({url:'https://weibo.com/123/a'});assert.equal(result.isError,true);assert.equal(ordinary,0);
  browser=null;result=await handler({url:'https://example.test/article'});
  assert.equal(ordinary,1);assert.equal(JSON.parse(result.content[0].text).body.length,200);
});
