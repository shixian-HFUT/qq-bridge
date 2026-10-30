import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadTtsConfig, validateSpeech, inspectPcmWav } from './aliyun-tts.js';

export async function synthesizeLocal(root, text) {
  const cfg = loadTtsConfig(root);
  text = validateSpeech(text, cfg);
  const result = await new Promise((resolve, reject) => {
    const child = spawn('D:\\Ai_video\\tools\\xtts_env\\Scripts\\python.exe', [path.join(root, 'scripts', 'aliyun-tts-worker.py')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 150000);
    child.stdout.on('data', b => { output += b.toString(); if (output.length > 32768) child.kill(); });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法启动本机语音运行环境')); });
    child.on('close', code => {
      clearTimeout(timer);
      try { const r = JSON.parse(output); if (timedOut || code !== 0 || !r.ok) throw new Error(); resolve(r); }
      catch { reject(new Error('阿里云合成未完成，请核对本机合成记录，勿自动重试')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ text }));
  });
  const file = fs.realpathSync(result.file);
  const base = fs.realpathSync(path.join(root, 'state', 'tts-python'));
  if (!file.startsWith(base + path.sep)) throw new Error('合成输出目录无效');
  const detail = inspectPcmWav(fs.readFileSync(file), { maxBytes: 4194304, maxSeconds: Math.min(30, cfg.maxSeconds || 30) });
  return { file, detail, model: cfg.model };
}
