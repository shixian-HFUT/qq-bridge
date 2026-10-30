// Opt-in live provider check, with only a fake QQ sender and temporary sessions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PiApiClient } from '../src/pi-client.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
if (!process.argv.includes('--live')) throw Error('Pass --live to authorize four isolated model turns');
const project = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(project, 'config.json'), 'utf8'));
const role = JSON.parse(fs.readFileSync(path.join(project, 'state', 'current-role.json'), 'utf8')).role;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-chat-style-'));
const sent = [];
let marked = false;
const tool = { name: 'mcp__snowluma__qq_send_message', label: 'reply', description: '回复本次消息，发送成功即结束。',
  parameters: { type: 'object', properties: { key: { type: 'string' }, token: { type: 'string' }, messages: { type: 'string' }, throughSeq: { type: 'number' } }, required: ['key', 'token', 'messages'] },
  execute: async (_id, args) => {
    const messages = typeof args.messages === 'string' ? JSON.parse(args.messages) : args.messages;
    if (!Array.isArray(messages) || !messages.every(t => typeof t === 'string')) throw Error('Invalid messages');
    sent.push(...messages);
    return { content: [{ type: 'text', text: '{"ok":true,"turnComplete":true}' }], details: { bridgeTerminal: true } };
  } };
const markTool = { name: 'mcp__snowluma__qq_mark_read', label: 'read', description: '本轮不发言时确认已读并结束。',
  parameters: { type: 'object', properties: { key: { type: 'string' }, token: { type: 'string' }, throughSeq: { type: 'number' } }, required: ['key', 'token', 'throughSeq'] },
  execute: async () => { marked = true; return { content: [{ type: 'text', text: '{"ok":true,"nextAction":"end-turn"}' }], details: { bridgeTerminal: true } }; } };
let client, bridge;
try {
  fs.mkdirSync(path.join(temp, 'runtime', 'pi'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'runtime', 'pi', 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(temp, 'runtime', 'pi', 'sdk.js'), `export * from ${JSON.stringify(pathToFileURL(path.join(project, 'runtime', 'pi', 'sdk.js')).href)};`);
  const preset = path.join('dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
  fs.mkdirSync(path.dirname(path.join(temp, preset)), { recursive: true });
  fs.copyFileSync(path.join(project, preset), path.join(temp, preset));
  const card = fs.readFileSync(path.join(project, 'roles', role + '.md'), 'utf8').slice(0, config.role?.maxInjectChars || 7500);
  client = new PiApiClient({ root: temp, config: { ...config.pi, credentialFile: config.pi.credentialFile || path.join(os.homedir(), '.dsh', '.env'), maxCallsPerTurn: 2, maxTokens: 1200 },
    tools: [tool, markTool], rolePrompt: () => card });
  if (process.argv.includes('--natural')) {
    bridge = await bridgeHarness({ config: { ownerQQ: config.ownerQQ, role: config.role, socialV2: config.socialV2 } });
    bridge.setMode('reserved2');
    fs.mkdirSync(path.join(bridge.temp, 'roles'), { recursive: true });
    fs.writeFileSync(path.join(bridge.temp, 'roles', role + '.md'), card);
    fs.writeFileSync(path.join(bridge.temp, 'state', 'current-role.json'), JSON.stringify({ role }));
  }
  const workspace = (await client.workspace.create({ path: path.join(temp, 'agent') })).result.value.workspace;
  const results = [];
  const cases = ['我先去吃饭了', '这破游戏又连跪了，烦死', '今天买了杯奶茶，味道还行', '我想少在游戏里冲动花钱，有什么办法？'];
  const selected = process.argv.includes('--responsive') ? [
    { text: `${role}，我新买的键盘到了，声音比想象中好听`, group: true, sharing: true },
    { text: '刚试了，真的顺手多了', group: true, sharing: true, replyToBot: true },
    { text: '哈哈确实', group: true },
  ] : process.argv.includes('--natural') ? [
    { text: '我刚买了个机械键盘' }, { text: '今天终于把那关过了' },
    { text: '哈哈确实', group: true }, { text: '这个报错 ECONNRESET 是什么意思？' },
  ] : (process.argv.includes('--casual-only') ? cases.slice(0, 3) : cases).map(text => ({ text }));
  for (const { text, group, sharing, replyToBot } of process.argv.includes('--brief') ? selected.slice(0, 2) : selected) {
    const id = (await client.sessions.create({ workspaceId: workspace.workspaceId, agentPreset: 'qq-chat-v2' })).result.value.sessionId;
    sent.length = 0;
    marked = false;
    let prompt = `【会话】private:${config.ownerQQ}，key=private:${config.ownerQQ}，token=isolated-test。backgroundObservation=true，readThroughSeq=1。当前用户为ownerQQ本人，isOwner=true，isSelf=false。\n【本次消息快照】messageId=style-fixture，seq=1，用户说：${text}\n直接回应这句话，使用qq_send_message，throughSeq=1。`;
    if (bridge) {
      const key = group ? 'group:456' : `private:${config.ownerQQ}`;
      const st = bridge.getSocialV2State(key);
      st.lastAiReplyAt = Date.now() - 10000;
      st.recentMessages = group ? (sharing
        ? Array.from({ length: 7 }, (_, seq) => ({ seq, isSelf: true, time: Date.now() - 180000 - seq * 60000, text: replyToBot && seq === 6 ? '你试试换个握法，看看顺不顺手。' : '之前聊的其他内容' }))
        : [1, 2, 3].map(seq => ({ seq, isSelf: true, time: Date.now() - 10000, text: '之前已经聊过这个了' }))) : [];
      st.unread = [{ seq: 8, time: Date.now(), text, plain: text, quoteTargetIsSelf: !!replyToBot, isSelf: false }];
      const context = sharing ? (replyToBot ? '群友在回复你刚才问的使用感受，回复对象就是你。' : '群友在点名向你分享新买键盘的日常，没有向你求建议。') : group ? '群友甲和群友乙在互相聊游戏，你刚已经发过几条；这句没有点你，也不是回复你。' : '私聊，ownerQQ本人在对你说话。';
      prompt = bridge.buildWakePromptV2(key, 'continuation') + `\n【本次消息快照】readThroughSeq=8，messageId=style-fixture。${context}\n最新消息：${text}\n可用工具qq_send_message和qq_mark_read，throughSeq=8，按参与分寸自行决定。`;
    }
    await client.sessions.prompt({ sessionId: id, content: [{ type: 'text', text: prompt }] });
    await client.loadSession(id).runPromise;
    const end = client.loadSession(id).records.at(-1)?.data?.reason;
    if (end?.kind !== 'completed' || (!sent.length && !marked)) throw Error(`Isolated style turn failed: ${end?.error?.message || 'no action'}`);
    results.push({ input: text, group: !!group, action: sent.length ? 'reply' : 'silent', reply: [...sent] });
  }
  console.log(JSON.stringify({ role, isolated: true, realQQSends: 0, results }));
} finally {
  await client?.dispose();
  await bridge?.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
