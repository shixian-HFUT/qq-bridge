import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../src/memory-store.js';
import { exportLivingMemory } from '../src/livingmemory-export.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-lmem-export-'));
let store;
try {
  store = new MemoryStore({ dir });
  const key = 'group:100000004';
  const add = (messageId, content) => {
    store.archive({ key, messageId, uid: '12345', text: content });
    return store.apply({ key, operations: [{ kind: 'userFact', subject: '12345', content, sourceMessageId: messageId }] })[0];
  };
  const active = add('one', '偏好文字交流');
  const forgotten = add('two', '一个必须忘记的旧偏好');
  store.apply({ key, operations: [{ action: 'remove', id: forgotten.id, revision: forgotten.revision }] });
  store.archive({ key: 'private:12345', messageId: 'secret', uid: '12345', text: '不应导出的无关私聊历史' });
  const dbPath = path.join(dir, 'memory.sqlite');
  store.close(); store = null;
  const hash = () => createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
  const before = hash();
  const result = exportLivingMemory(dbPath);
  assert.equal(hash(), before, 'export must not modify source database');
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].id, active.id);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].session, key);
  assert.ok(result.blocks.forgottenSources.length);
  assert.ok(result.blocks.forgottenFingerprints.length);
  assert.equal(result.blocks.excluded[0].status, 'forgotten');
  assert.ok(!JSON.stringify(result).includes('不应导出'));
  assert.ok(!JSON.stringify(result).includes('必须忘记'));
  assert.deepEqual(result.report.missingEvidence, []);
  const again = exportLivingMemory(dbPath);
  delete result.generatedAt; delete again.generatedAt;
  assert.deepEqual(again, result, 'repeat export is deterministic');
  console.log('PASS read-only consistent export, source isolation, tombstones, omitted bodies, repeatability');
} finally { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
