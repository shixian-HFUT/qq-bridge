// Read-only production check: download through the real send endpoint, never dispatch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
if (!process.argv.includes('--dry-run')) throw Error('Only --dry-run is supported; this script never sends QQ messages');
const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const social = JSON.parse(fs.readFileSync(path.join(root, 'state/social-v2.json'), 'utf8'));
const key = 'group:100000003', st = social.conversations[key];
const messages = [...(st.unread || []), ...(st.recentMessages || [])];
const original = [...messages].reverse().find(m => !m.isSelf && m.messageId);
const source = [...messages].reverse().find(m => m.messageId && m.media?.some(i => i.kind === 'image'));
if (!original) throw Error('No source request is available for the dry run');
const token = config.consoleToken || fs.readFileSync(path.join(root, 'state/console-token'), 'utf8').trim();
async function probe(args) {
  const response = await fetch(`http://127.0.0.1:${config.consolePort || 3100}/api/socialV2/send-image`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': token, 'x-agent-token': st.agentToken, 'x-agent-call': '1' },
    body: JSON.stringify({ key, requestId: String(original.messageId), dryRun: true, ...args }), signal: AbortSignal.timeout(90000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) return { ok: false, error: result.error };
  return { ok: true, bytes: result.bytes, mimeType: result.mimeType, dryRun: result.dryRun };
}
const online = await probe({ url: 'https://www.gstatic.com/webp/gallery/1.png' });
const chat = source ? await probe({ sourceMessageId: String(source.messageId), imageIndex: source.media.findIndex(i => i.kind === 'image') + 1 }) : { skipped: 'No recent image source' };
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/mcp-snowluma-safe.js')], cwd: root });
const client = new Client({ name: 'image-send-check', version: '1.0.0' });
let toolRegistered;
try { await client.connect(transport); toolRegistered = (await client.listTools()).tools.some(t => t.name === 'qq_send_image'); }
finally { await client.close(); await transport.close(); }
console.log(JSON.stringify({ ok: online.ok === true && chat.ok !== false && toolRegistered, publicImage: online, chatImage: chat, toolRegistered, realQQSends: 0 }));
if (!online.ok || chat.ok === false || !toolRegistered) process.exitCode = 1;
