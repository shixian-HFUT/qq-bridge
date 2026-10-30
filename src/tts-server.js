import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { synthesizeSpeech } from './aliyun-tts.js';
import { safeFetchAudioBuffer } from './safe-fetch.js';
import { ipv4HttpsFetch } from './tts-transport.js';

// Reuse Aliyun synthesis and caching; Linux ffmpeg replaces workstation Python.
export async function synthesizeLocal(root, text, { emotion } = {}) {
  const dir = path.join(root, 'state', 'tts-normalize');
  fs.mkdirSync(dir, { recursive: true });
  return synthesizeSpeech(root, text, {
    emotion,
    fetchImpl: ipv4HttpsFetch,
    download: async (url, maxBytes, allow) => {
      const { buffer } = await safeFetchAudioBuffer(url, maxBytes, allow);
      const id = crypto.randomUUID();
      const source = path.join(dir, id + '.source.wav');
      const output = path.join(dir, id + '.wav');
      try {
        fs.writeFileSync(source, buffer, { mode: 0o600 });
        await new Promise((resolve, reject) => {
          const child = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', output], { stdio: 'ignore' });
          const timer = setTimeout(() => child.kill(), 30000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('语音格式转换未完成')); });
        });
        return { buffer: fs.readFileSync(output) };
      } finally {
        fs.rmSync(source, { force: true });
        fs.rmSync(output, { force: true });
      }
    }
  });
}
