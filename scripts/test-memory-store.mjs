import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/memory-store.js';
import { projectPiContext } from '../src/pi-context.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-test-'));
let store = new MemoryStore({ dir });
const key = 'group:45678', other = 'group:56789', privateKey = 'private:12345';
const author = '12345';
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
try {
  const source = store.archive({ key, messageId: '101', uid: author, text: '我喜欢文字，毕业设计做机器人。' });
  let fact;
  test('source-bound profile, duplicate prevention and restart persistence', () => {
    [fact] = store.apply({ key, shared: true, operations: [{ kind: 'userFact', subject: author, content: '偏好文字交流', sourceMessageId: '101' }] });
    const [dup] = store.apply({ key, shared: true, operations: [{ kind: 'userFact', subject: author, content: '偏好文字交流', sourceMessageId: '101' }] });
    assert.equal(dup.id, fact.id); assert.equal(dup.duplicate, true);
    store.close(); store = new MemoryStore({ dir });
    assert.equal(store.list({ key })[0].content, '偏好文字交流');
    assert.equal(store.source(key, source.id).uid, author);
  });
  test('cannot invent sources, impersonate another person or edit another origin', () => {
    assert.throws(() => store.apply({ key, operations: [{ kind: 'userFact', content: '虚构', sourceMessageId: '404' }] }), /真实收到/);
    assert.throws(() => store.apply({ key, operations: [{ kind: 'userFact', subject: '99999', content: '虚构', sourceMessageId: '101' }] }), /本人/);
    assert.equal(store.list({ key: other }).length, 1);
    assert.throws(() => store.apply({ key: other, operations: [{ action: 'remove', id: fact.id, revision: 1 }] }), /无权/);
  });
  test('versioned correction is atomic and rejects stale revision', () => {
    store.archive({ key, messageId: '102', uid: author, text: '现在我可以听语音了' });
    [fact] = store.apply({ key, shared: true, operations: [{ action: 'patch', id: fact.id, revision: 1, content: '可以听语音', sourceMessageId: '102' }] });
    assert.equal(fact.revision, 2);
    assert.equal(store.list({ key })[0].content, '可以听语音');
    assert.throws(() => store.apply({ key, operations: [{ action: 'patch', id: fact.id, revision: 1, content: '旧修改', sourceMessageId: '102' }] }), /版本冲突/);
    assert.throws(() => store.apply({ key, operations: [{ kind: 'event', content: '事务必须回滚', sourceMessageId: '101' }, { action: 'remove', id: 'missing', revision: 1 }] }), /无权/);
    assert.equal(store.list({ key, query: '事务' }).length, 0);
  });
  test('forget removes from recall and prevents exact automatic resurrection', () => {
    store.apply({ key, operations: [{ action: 'remove', id: fact.id, revision: fact.revision }] });
    assert.equal(store.list({ key }).length, 0);
    assert.throws(() => store.apply({ key, shared: true, operations: [{ kind: 'userFact', subject: author, content: '换个说法恢复旧偏好', sourceMessageId: '101' }] }), /已忘记/);
    assert.equal(store.db.prepare('SELECT content FROM memories WHERE id=?').get(fact.id).content, '');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_revisions').get().n, 0);
    assert.throws(() => store.apply({ key, shared: true, operations: [{ kind: 'userFact', subject: author, content: '可以听语音', sourceMessageId: '102' }] }), /已忘记/);
  });
  test('history two-character Chinese, trigram, literal LIKE and private isolation', () => {
    store.archive({ key: privateKey, messageId: 'p1', uid: author, text: '毕业设计的秘密方案' });
    store.archive({ key, messageId: '103', uid: author, text: '百分比%与下划线_不是通配符' });
    assert.equal(store.history({ key, query: '毕业' }).length, 1);
    assert.equal(store.history({ key, query: '机器人' }).length, 1);
    assert.equal(store.history({ key, query: '%' }).length, 1);
    assert.equal(store.history({ key: other, query: '秘密' }).length, 0);
    const priv = store.history({ key: privateKey, query: '秘密' })[0];
    assert.equal(store.history({ key, messageId: priv.id }).length, 0);
    assert.equal(store.source(key, 'p1'), undefined);
  });
  test('long transcripts can be paged without silent truncation', () => {
    const text = '长'.repeat(2000) + '尾部';
    const record = store.archive({ key, messageId: '104', uid: author, text });
    const head = store.history({ key, messageId: record.id })[0];
    assert.equal(head.truncated, true); assert.equal(head.partialArchive, false);
    const tail = store.history({ key, messageId: record.id, offset: head.nextOffset })[0];
    assert.equal(tail.truncated, false); assert.equal(head.text + tail.text, text);
    store.archive({ key, messageId: '104', uid: author, text });
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_messages WHERE external_id=?').get('104').n, 1);
  });
  test('legacy import is non-destructive, idempotent and not promoted to fact', () => {
    const legacy = { sharedMemory: { activeTopics: [{ text: '旧时共同经历', lastSourceKey: key }] }, conversations: {} };
    const before = JSON.stringify(legacy);
    store.importLegacy(legacy); store.importLegacy(legacy);
    assert.equal(JSON.stringify(legacy), before);
    assert.equal(store.list({ key, query: '旧时' }).length, 0);
    assert.equal(store.list({ key, query: '旧时', candidates: true }).length, 1);
    assert.ok(store.render({ key, query: '我们旧时的事情' }).text.includes('[旧资料待核实]'));
    assert.equal(store.list({ key, query: '旧时' }).length, 0);
  });
  test('bounded snapshot and no irrelevant profiles', () => {
    store.archive({ key, messageId: '105', uid: author, text: '我重新明确说明，偏爱简洁文字' });
    store.apply({ key, shared: true, operations: [{ kind: 'userFact', subject: author, content: '偏爱简洁文字', sourceMessageId: '105' }] });
    const snapshot = store.render({ key, subjects: [author], legacy: '短期话题'.repeat(1000) });
    assert.ok(snapshot.text.includes('偏爱简洁文字')); assert.ok(snapshot.text.length <= 1600);
    assert.equal(store.render({ key, subjects: [] }).text, '');
  });
  test('Pi deduplicates snapshots, restores after cropping and updates immediately', () => {
    const one = { version: 'one', text: '偏好文字' }, two = { version: 'two', text: '可以语音' };
    const user = (n, snapshot) => ({ role: 'user', content: [{ type: 'text', text: 'message ' + n }], bridgeMemory: snapshot });
    const history = [user(1, one), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, user(2, one)];
    const archived = JSON.stringify(history);
    let projection = projectPiContext(history);
    assert.equal(JSON.stringify(projection).split('偏好文字').length - 1, 1);
    assert.equal(JSON.stringify(projection).includes('bridgeMemory'), false);
    assert.equal(JSON.stringify(history), archived);
    projection = projectPiContext([...history, user(3, two)], 1);
    assert.ok(JSON.stringify(projection).includes('可以语音')); assert.ok(!JSON.stringify(projection).includes('偏好文字'));
    projection = projectPiContext([...history, user(3, { version: 'empty', text: '' })]);
    assert.ok(!JSON.stringify(projection).includes('偏好文字'));
  });
  test('learning budget is global, durable and counts failed reservations', () => {
    const a = store.reserveLearning({ input: 500 });
    store.completeLearning(a.id, { inputTokens: 100, outputTokens: 20 });
    store.reserveLearning({ input: 500 });
    store.close(); store = new MemoryStore({ dir });
    assert.equal(store.learningUsage().requests, 2);
    assert.throws(() => store.reserveLearning({ input: 100 }), /预算已用完/);
    assert.throws(() => store.reserveLearning({ input: 4000 }), /单次预算/);
  });
  test('consistent SQLite backup', () => {
    const { file } = store.backup(); assert.ok(fs.statSync(path.join(dir, 'memory-backups', file)).size > 0);
  });
} finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`${passed} memory behavior checks passed`);
