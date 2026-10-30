import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const token = config.consoleToken || fs.readFileSync(path.join(root, 'state', 'console-token'), 'utf8').trim();
const headers = { 'x-console-token': token, 'x-console-admin': '1' };
async function get(route) {
  const response = await fetch(`http://127.0.0.1:${config.consolePort || 3100}${route}`, { headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Error(`Health endpoint HTTP ${response.status}`);
  return response.json();
}
const status = await get('/api/status');
const memory = await get('/api/socialV2/long-memory?key=group:100000003');
const conversations = await get('/api/socialV2/states');
const indexFile = path.join(root, 'state', 'pi', 'index.json');
const activeSessions = [];
if (fs.existsSync(indexFile)) {
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  for (const [id, value] of Object.entries(index.sessions || {})) {
    if (value.archived) continue;
    const file = path.join(root, 'state', 'pi', 'sessions', id + '.json');
    if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).running) activeSessions.push(id);
  }
}
const ok = status.runtimeBackend === 'pi' && status.dshReady && status.snowluma?.connected === true &&
  status.snowluma?.accountOnline === true && status.snowluma?.good === true && memory.ok === true && status.socialV2Paused === false;
console.log(JSON.stringify({ ok, role: status.role, mode: status.mode, backend: status.runtimeBackend,
  model: config.pi.model, thinking: config.pi.thinkingLevel, search: config.webSearch.provider,
  connected: status.snowluma?.connected, online: status.snowluma?.accountOnline, good: status.snowluma?.good,
  memoryOK: memory.ok, memoryStats: memory.stats, activeSessions: activeSessions.length,
  conversations: conversations.conversations?.map(c => ({ key: c.key, unread: c.unreadCount })) }));
if (!ok) process.exitCode = 1;
