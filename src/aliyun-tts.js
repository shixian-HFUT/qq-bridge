import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeFetchAudioBuffer } from './safe-fetch.js';

export function loadTtsConfig(root) {
  const file = path.join(root, 'state', 'tts-settings.json');
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const secrets = path.join(root, 'state', 'tts-secrets.json');
  const local = fs.existsSync(secrets) ? JSON.parse(fs.readFileSync(secrets, 'utf8')) : {};
  return { enabled: false, approved: false, autonomous: false, region: 'cn-beijing', model: 'qwen-audio-3.1-tts-flash',
    maxChars: 120, maxSeconds: 30, maxBytes: 4 * 1024 * 1024, timeoutMs: 60000,
    ...settings, apiKey: process.env.DASHSCOPE_API_KEY || local.apiKey || '',
    workspaceId: process.env.DASHSCOPE_WORKSPACE_ID || local.workspaceId || settings.workspaceId || '' };
}

export function ttsEndpoint(config) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(config.workspaceId || '')) throw new Error('请先在本机设置百炼业务空间 ID');
  if (config.region !== 'cn-beijing') throw new Error('当前流程仅配置北京地域');
  return `https://${config.workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/`;
}

export function validateSpeech(text, config) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('朗读文字不能为空');
  if ([...text].length > Math.min(120, Number(config.maxChars) || 120)) throw new Error('朗读文字超过长度上限');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('朗读文字包含无效控制字符');
  return text.trim();
}

export function inspectPcmWav(buffer, { maxBytes = 4194304, maxSeconds = 30 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.length > maxBytes ||
      buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('合成结果不是有效的限额内 WAV');
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) throw new Error('WAV 数据长度不匹配');
  let fmt, data;
  for (let at = 12; at + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(at + 4), end = at + 8 + size;
    if (end > buffer.length) throw new Error('WAV 数据被截断');
    const id = buffer.toString('ascii', at, at + 4);
    if (id === 'fmt ' && size >= 16) fmt = buffer.subarray(at + 8, end);
    if (id === 'data') { if (data) throw new Error('WAV 存在重复数据段'); data = buffer.subarray(at + 8, end); }
    at = end + (size % 2);
  }
  if (!fmt || !data || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(14) !== 16) throw new Error('WAV 必须为 PCM 16-bit');
  const channels = fmt.readUInt16LE(2), sampleRate = fmt.readUInt32LE(4), byteRate = fmt.readUInt32LE(8);
  if (![1, 2].includes(channels) || sampleRate < 16000 || sampleRate > 96000 || byteRate !== sampleRate * channels * 2 || fmt.readUInt16LE(12) !== channels * 2 || data.length % (channels * 2)) throw new Error('WAV 音频参数无效');
  const seconds = data.length / byteRate;
  if (seconds < 0.1 || seconds > maxSeconds) throw new Error('WAV 时长超限');
  return { seconds, sampleRate, channels, bytes: buffer.length };
}

export function isAliyunAudioUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') &&
      /^[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(u.hostname);
  } catch { return false; }
}

export async function aliyunRequest(config, operation, body, { fetchImpl = fetch } = {}) {
  if (!config.apiKey) throw new Error('尚未配置 DASHSCOPE_API_KEY，请在本机填写');
  if (!['customization', 'SpeechSynthesizer'].includes(operation)) throw new Error('不支持的语音接口');
  let response;
  try {
    response = await fetchImpl(ttsEndpoint(config) + operation, {
      method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', ...(operation === 'SpeechSynthesizer' ? { 'X-DashScope-SSE': 'enable' } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(Math.min(90000, config.timeoutMs || 60000))
    });
  } catch (error) {
    const code = ['TimeoutError', 'AbortError'].includes(error?.name) ? 'TIMEOUT' : error?.cause?.code || error?.code;
    const safeCode = ['TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code) ? code : '';
    throw new Error('阿里云语音请求失败或超时' + (safeCode ? '（' + safeCode + '）' : ''));
  }
  if (!response.ok) throw new Error(`阿里云语音接口返回 HTTP ${response.status}，请核对凭据、权限与额度`);
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > 16 * 1024 * 1024) throw new Error('阿里云响应过大'); chunks.push(Buffer.from(value)); }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trimStart().startsWith('data:') && !raw.trimStart().startsWith('event:') && !raw.trimStart().startsWith('id:')) return JSON.parse(raw);
    let last = {}, audio = null;
    const events = [];
    for (const block of raw.replace(/\r\n/g, '\n').split(/\n\n/)) {
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data || data.trim() === '[DONE]') continue;
      const event = JSON.parse(data);
      if (event.code || event.error) throw new Error('语音服务返回错误');
      if (event.output?.audio?.url) audio = event.output.audio;
      if (event.output) events.push(Object.fromEntries(Object.entries(event.output).filter(([k]) => k !== 'audio')));
      last = event;
    }
    return { ...last, output: { ...last.output, ...(audio ? { audio } : {}) }, events };
  } catch (error) {
    await reader.cancel().catch(() => {});
    const msg = String((error && error.message) || '');
    // 已知错误不要被这个 catch 吞成"响应无效"，否则排查时看不到真因。
    if (/阿里云响应过大|语音服务返回错误|阿里云响应过大/.test(msg)) throw error;
    throw new Error(`阿里云响应无效或读取超时${msg ? '：' + msg : ''}`);
  }
}

export async function synthesizeSpeech(root, text, { config = loadTtsConfig(root), fetchImpl, download = safeFetchAudioBuffer } = {}) {
  text = validateSpeech(text, config);
  if (!config.voiceId || !String(config.voiceId).startsWith(`${config.model}-`)) throw new Error('请先创建与合成模型匹配的音色');
  const cacheDir = path.join(root, 'state', 'tts-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const payload = { model: config.model, input: { text, voice: config.voiceId, format: 'wav', sample_rate: 24000, rate: 1, language_hints: ['zh'], word_timestamp_enabled: true } };
  const cacheId = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const cacheFile = path.join(cacheDir, `${cacheId}.json`);
  let result;
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (!cached.result) throw new Error('该合成请求先前未完成，需核对结果后再重试');
    result = cached.result;
  } else {
    fs.writeFileSync(cacheFile, JSON.stringify({ status: 'submitted', at: Date.now() }), { flag: 'wx', mode: 0o600 });
    result = await aliyunRequest(config, 'SpeechSynthesizer', payload, { fetchImpl });
    fs.writeFileSync(cacheFile, JSON.stringify({ status: 'generated', result }), { mode: 0o600 });
  }
  let url = result.output?.audio?.url;
  // 部分模型（如 qwen-audio-3.1-tts-flash）返回的音频直链是 http；同域名 OSS 支持 https，
  // 这里强制升级协议，保持"只走 https + 严格域名白名单"的策略，而不是放宽白名单。
  if (typeof url === 'string' && /^http:\/\//i.test(url)) url = 'https://' + url.slice(7);
  if (!isAliyunAudioUrl(url)) throw new Error('音频下载地址不在允许的阿里云 OSS 域名内');
  let buffer;
  try { ({ buffer } = await download(url, Math.min(config.maxBytes || 4194304, 4194304), isAliyunAudioUrl)); }
  catch { throw new Error('合成音频下载失败'); }
  const detail = inspectPcmWav(buffer, { maxBytes: Math.min(config.maxBytes || 4194304, 4194304), maxSeconds: Math.min(config.maxSeconds || 30, 30) });
  const dir = path.join(root, 'state', 'tts-generated');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomUUID()}.wav`);
  fs.writeFileSync(file, buffer, { flag: 'wx', mode: 0o600 });
  // 只清理本模块创建的 UUID WAV；不触碰原始语音库。
  for (const name of fs.readdirSync(dir)) {
    if (!/^[a-f0-9-]{36}\.wav$/.test(name)) continue;
    const old = path.join(dir, name);
    try { if (Date.now() - fs.statSync(old).mtimeMs > 24 * 3600000) fs.unlinkSync(old); } catch {}
  }
  return { file, detail, model: config.model };
}
