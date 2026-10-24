import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { LocalImages } from '../src/local-image.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-config-'));
let server;
try {
  await assert.rejects(new LocalImages(root).submit('private:123', { prompt: 'test', requestId: '1' }), /未配置/);
  for (const endpoint of ['https://example.com', 'http://192.168.1.1', 'http://user:pass@localhost', 'http://localhost/path']) {
    const image = new LocalImages(root, { enabled: true, outputDir: 'output', templateFile: 'workflow.json', server: endpoint });
    await assert.rejects(image.submit('private:123', { prompt: 'test', requestId: '1' }), /本机HTTP/);
  }
  fs.mkdirSync(path.join(root, 'output'));
  fs.writeFileSync(path.join(root, 'output', 'fixture.png'), 'fixture');
  fs.writeFileSync(path.join(root, 'escape.png'), 'outside output');
  fs.writeFileSync(path.join(root, 'workflow.json'), JSON.stringify(Object.fromEntries(['4', '5', '6', '8'].map(id => [id, { inputs: {} }]))));
  let submitted = 0, unsafe = true;
  server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/queue') return res.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
    if (req.url === '/prompt') {
      let body = ''; for await (const chunk of req) body += chunk;
      assert.equal(JSON.parse(body).prompt['4'].inputs.prompt, 'test');
      submitted++; return res.end(JSON.stringify({ prompt_id: 'fixture' }));
    }
    res.end(JSON.stringify({ fixture: { status: { completed: true }, outputs: {
      '8': { images: [{ type: 'output', subfolder: unsafe ? '..' : '', filename: unsafe ? 'escape.png' : 'fixture.png' }] },
    } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const image = new LocalImages(root, { enabled: true, outputDir: 'output', templateFile: 'workflow.json', server: `http://127.0.0.1:${server.address().port}` });
  const input = { prompt: 'test', requestId: '1' };
  const first = await image.submit('private:123', input);
  assert.equal((await image.submit('private:123', input)).jobId, first.jobId);
  assert.equal(submitted, 1);
  await assert.rejects(image.query('private:456', first.jobId), /当前会话/);
  await assert.rejects(image.query('private:123', first.jobId), /非法生成结果路径/);
  unsafe = false;
  assert.equal((await image.query('private:123', first.jobId)).status, 'completed');
  assert.equal((await new LocalImages(root, image.config).submit('private:123', input)).jobId, first.jobId);
  assert.equal(submitted, 1, 'restart retains request deduplication');
  console.log('PASS local image configuration, session isolation, traversal rejection and restart deduplication');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
