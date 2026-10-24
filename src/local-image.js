import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class LocalImages {
  constructor(root, config = {}) {
    this.config = config;
    this.root = root;
    this.dir = path.join(root, 'state', 'image-jobs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'jobs.json');
    this.jobs = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    this.submitting = false;
  }
  save() { fs.writeFileSync(this.file + '.pending', JSON.stringify(this.jobs, null, 2)); fs.renameSync(this.file + '.pending', this.file); }
  settings() {
    if (this.config.enabled !== true || !this.config.outputDir || !this.config.templateFile) throw Error('本地生图未配置；请管理员设置 imageGeneration');
    const server = new URL(this.config.server || 'http://127.0.0.1:8188');
    if (server.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(server.hostname)
      || server.username || server.password || server.pathname !== '/' || server.search || server.hash) throw Error('ComfyUI只允许无凭据的本机HTTP地址');
    return { server: server.origin, output: path.resolve(this.root, this.config.outputDir), template: path.resolve(this.root, this.config.templateFile) };
  }
  async api(route, body) {
    const { server } = this.settings();
    const r = await fetch(server + route, { method: body ? 'POST' : 'GET', redirect: 'error', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(body ? 120000 : 10000) });
    const data = await r.json();
    if (!r.ok || data.error) throw Error('ComfyUI 请求失败：' + JSON.stringify(data.error || r.status).slice(0, 300));
    return data;
  }
  get(key, id) { const job = this.jobs[id]; if (!job || job.key !== key) throw Error('没有当前会话的该生图任务'); return job; }
  async submit(key, input) {
    const { template } = this.settings();
    const prompt = String(input.prompt || '').trim();
    if (!prompt || prompt.length > 6000) throw Error('生图提示词限1～6000字');
    const width = Number(input.width || 1024), height = Number(input.height || 1024);
    if (![width, height].every(n => Number.isInteger(n) && n >= 512 && n <= 1536 && n % 32 === 0) || width * height > 1572864) throw Error('尺寸须为512～1536间32倍数，总像素不超过1536×1024');
    const requestId = String(input.requestId || '');
    if (!requestId || requestId.length > 100) throw Error('需要原请求消息ID作为requestId');
    const id = crypto.createHash('sha256').update(key + '\0' + requestId).digest('hex').slice(0, 24);
    if (this.jobs[id]) return this.public(this.jobs[id]);
    if (this.submitting) throw Error('正在提交其他任务，稍后再查，不要重复提交');
    this.submitting = true;
    try {
      const queue = await this.api('/queue');
      if (queue.queue_running?.length || queue.queue_pending?.length) throw Error('ComfyUI正在处理其他任务；当前未提交，请稍后再试');
      const uncertain = Object.values(this.jobs).find(j => ['submitting', 'unknown'].includes(j.status));
      if (uncertain) throw Error('存在提交结果不明的任务，请管理端核对后再提交');
      const job = { id, key, requestId, prompt, width, height, seed: crypto.randomInt(0, 2147483647), status: 'submitting', createdAt: Date.now() };
      const graph = JSON.parse(fs.readFileSync(template, 'utf8'));
      graph['4'].inputs.prompt = prompt;
      graph['5'].inputs.width = width; graph['5'].inputs.height = height;
      Object.assign(graph['6'].inputs, { steps: 25, cfg: 1, sampler_name: 'euler', scheduler: 'simple', seed: job.seed });
      graph['8'].inputs.filename_prefix = 'qqbot/' + id;
      fs.writeFileSync(path.join(this.dir, id + '.prompt.txt'), prompt, 'utf8');
      fs.writeFileSync(path.join(this.dir, id + '.workflow.json'), JSON.stringify(graph, null, 2));
      this.jobs[id] = job; this.save();
      try {
        const result = await this.api('/prompt', { prompt: graph, client_id: 'qqbot-' + id });
        if (!result.prompt_id) throw Error('未返回prompt_id');
        job.promptId = result.prompt_id; job.status = 'queued'; this.save();
      } catch (e) { job.status = 'unknown'; job.error = e.message; this.save(); throw Error('提交结果不明，任务ID=' + id + '；查询原任务，禁止重复提交'); }
      return this.public(job);
    } finally { this.submitting = false; }
  }
  public(j) { return { jobId: j.id, promptId: j.promptId, status: j.status, width: j.width, height: j.height, sent: j.sendStatus, messageId: j.messageId, error: j.error }; }
  async query(key, id) {
    const { output } = this.settings();
    const j = this.get(key, id);
    if (!j.promptId && ['unknown', 'submitting'].includes(j.status)) {
      // Recover a lost submit response by the stable ComfyUI client_id, never resubmit.
      const queue = await this.api('/queue');
      const history = await this.api('/history?max_items=100');
      const candidates = [...(queue.queue_running || []), ...(queue.queue_pending || []), ...Object.values(history).map(h => h.prompt).filter(Boolean)];
      const found = candidates.find(p => p[3]?.client_id === 'qqbot-' + j.id);
      if (found) { j.promptId = found[1]; j.status = 'queued'; this.save(); }
    }
    if (!j.promptId) return this.public(j);
    const all = await this.api('/history/' + encodeURIComponent(j.promptId));
    const h = all[j.promptId];
    if (h) {
      if (h.status?.status_str === 'error') j.status = 'failed';
      else if (h.status?.completed) {
        const images = Object.values(h.outputs || {}).flatMap(o => o.images || []).filter(i => i.type === 'output');
        const img = images[0];
        if (img) {
          const file = path.resolve(output, img.subfolder || '', img.filename);
          const relative = path.relative(output, file);
          if (relative.startsWith('..') || path.isAbsolute(relative) || !file.toLowerCase().endsWith('.png')) throw Error('非法生成结果路径');
          const real = fs.realpathSync(file), realRelative = path.relative(fs.realpathSync(output), real);
          if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw Error('生成结果不在输出目录');
          j.output = real; j.status = 'completed';
        }
      }
      this.save();
    }
    return this.public(j);
  }
}
