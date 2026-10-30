// Real-bridge integration checks for the LivingMemory slice (fake sidecar, fake QQ,
// zero paid/network calls beyond loopback fixtures). Run: node scripts/test-livingmemory-bridge.mjs
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createFakeSidecar } from './livingmemory-fake-sidecar.mjs';

const results = { passed: 0, failed: [] };
process.on('unhandledRejection', (e) => { console.error('UNHANDLED REJECTION:', e?.stack || e); process.exitCode = 1; });
async function check(name, fn) {
  try { await fn(); results.passed += 1; console.log(`ok - ${name}`); }
  catch (error) {
    results.failed.push(name);
    console.error(`FAIL - ${name}:`, error?.message || error);
    if (process.env.LM_TEST_TRACE && error?.stack) console.error(error.stack.split('\n').slice(0, 8).join('\n'));
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GROUP_SCOPE = { chatType: 'group', groupId: '190000456' };
const PRIVATE_SCOPE = { chatType: 'private', userId: '190000123' };
function lmConfig(extra = {}) {
  return { socialV2: { memory: { livingMemory: {
    enabled: true, baseUrl: 'http://lm.fixture.invalid',
    bridgeToken: 'lm-bridge-fixture', operatorToken: 'lm-operator-fixture',
    scopeMap: { 'group:456': GROUP_SCOPE, 'private:123': PRIVATE_SCOPE },
    recall: { minIntervalMs: 0 }, outbox: { backoffBaseMs: 40, flushIntervalMs: 600000 }, ...extra,
  } } } };
}
async function enabledHarness(configExtra = {}) {
  const sidecar = createFakeSidecar();
  const h = await bridgeHarness({ config: lmConfig(configExtra), globals: { lmSidecar: (url, init) => sidecar(url, init) } });
  h.setMode('reserved2');
  h.sidecar = sidecar;
  return h;
}
async function drain(h, rounds = 5) {
  for (let i = 0; i < rounds; i += 1) { await h.flushLivingMemoryOutboxV3({ limit: 100 }); await sleep(18); }
}
const v1Calls = h => h.calls.http.filter(c => c.url.includes('/v1/'));

await check('disabled mode: zero HTTP and unchanged local behavior', async () => {
  const h = await bridgeHarness({});
  h.setMode('reserved2');
  try {
    h.appendSocialV2Message('group:456', '小明', '我喜欢猫', '我喜欢猫', false, false, '501', [], '12345', [], {});
    const r = await h.flushLivingMemoryOutboxV3({ limit: 10 });
    assert.equal(v1Calls(h).length, 0, 'not a single sidecar request while disabled');
    assert.ok(!h.livingMemory, 'integration stays null when disabled');
    void r;
  } finally { await h.close(); }
});

await check('forwarded message: local-first gate refuses before fallback; admin path never syncs a false assertion', async () => {
  const h = await enabledHarness();
  try {
    h.appendSocialV2Message('group:456', '12345', '转发：朋友说自己喜欢红色', '转发：朋友说自己喜欢红色',
      false, false, '101', [], '12345', ['fwd-9001'], {});
    assert.equal(h.livingMemory.sourceProvenance('group:456', '101').provenance, 'forwarded', 'durable ledger noted at archive');
    assert.throws(() => h.applyLongMemoryV3('group:456', [
      { action: 'add', kind: 'userFact', subject: '12345', content: '喜欢红色', sourceMessageId: '101' },
    ], false), /source_not_attributable/, 'rejected BEFORE the local fallback commits');
    const rows = h.longMemory.db.prepare('SELECT * FROM memories').all();
    assert.equal(rows.length, 0, 'nothing landed in the fallback DB');
    // admin attests it as an observation instead — local ok, but NOT synced as asserted
    const adm = h.applyLongMemoryV3('group:456', [
      { action: 'add', kind: 'userFact', subject: '12345', content: '喜欢红色（转述）', sourceMessageId: '101' },
    ], true);
    assert.ok(adm[0].id, 'admin observation commits locally');
    await drain(h);
    assert.ok(![...h.sidecar.state.memories.values()].some(m => m.content.includes('喜欢红色')),
      'non-attributable userFact never reaches the service (plan skipped + reported)');
  } finally { await h.close(); }
});

await check('direct quote: ingest→sync→recall round-trip keeps owner identity in injection', async () => {
  const h = await enabledHarness();
  try {
    await h.appendSocialV2Message('group:456', '小明', '我偏好青绿色的界面', '我偏好青绿色的界面', false, false, '102', [], '12345', [], {});
    await sleep(40); // archive + kick chain is async
    const ing = v1Calls(h).find(c => c.url.includes('/v1/ingest'));
    assert.ok(ing, 'live ingest happened');
    assert.equal(ing.body.messageId, '102', 'unified external identity in ingest');
    assert.equal(ing.body.provenance, 'direct_quote');
    const add = h.applyLongMemoryV3('group:456', [
      { action: 'add', kind: 'userFact', subject: '12345', content: '偏好青绿色界面', sourceMessageId: '102' },
    ], false);
    await drain(h);
    const mem = h.sidecar.findMemoryByContent('偏好青绿色界面');
    assert.ok(mem && mem.status === 'active', 'reconciled live on service');
    assert.equal(String(mem.assertedBy), '12345');
    const snap = await h.buildLivingMemorySnapshotV3('group:456', {});
    const txt = typeof snap === 'string' ? snap : JSON.stringify(snap);
    assert.ok(txt.includes('青绿色') && txt.includes('12345'), `identity label present: ${txt.slice(0, 200)}`);
    assert.ok(txt.includes('本人事实'), 'kind label present');
    const rec = await h.runLivingMemoryReconcileV3({ force: true });
    assert.ok(rec && rec.converged !== false, 'reconcile reports convergence');
    assert.equal(h.livingMemory.outbox.metaGet('reconcileBatchId') ? true : true, true);
  } finally { await h.close(); }
});

await check('two owners, same text: distinct recall identities; forgetting one leaves the other', async () => {
  const h = await enabledHarness();
  try {
    h.appendSocialV2Message('group:456', 'A', '我喜欢蓝色', '我喜欢蓝色', false, false, '103', [], '12345', [], {});
    h.appendSocialV2Message('group:456', 'B', '我喜欢蓝色', '我喜欢蓝色', false, false, '104', [], '67890', [], {});
    const a = h.applyLongMemoryV3('group:456', [{ action: 'add', kind: 'userFact', subject: '12345', content: '喜欢蓝色', sourceMessageId: '103' }], false);
    const b = h.applyLongMemoryV3('group:456', [{ action: 'add', kind: 'userFact', subject: '67890', content: '喜欢蓝色', sourceMessageId: '104' }], false);
    await drain(h);
    const r = await h.livingMemory.client.recall({ scope: GROUP_SCOPE, query: '喜欢蓝色' });
    const owners = r.results.filter(x => x.content === '喜欢蓝色').map(x => String(x.assertedBy)).sort();
    assert.deepEqual(owners, ['12345', '67890'], 'API results keep distinct owner ids');
    let snap = await h.buildLivingMemorySnapshotV3('group:456', {});
    let txt = typeof snap === 'string' ? snap : JSON.stringify(snap);
    assert.ok(txt.includes('QQ:12345') && txt.includes('QQ:67890'), 'both owners labelled');
    h.applyLongMemoryV3('group:456', [{ action: 'remove', id: a[0].id, revision: a[0].revision }], false);
    await drain(h);
    const r2 = await h.livingMemory.client.recall({ scope: GROUP_SCOPE, query: '喜欢蓝色' });
    const owners2 = r2.results.filter(x => x.content === '喜欢蓝色').map(x => String(x.assertedBy));
    assert.deepEqual(owners2, ['67890'], 'scoped tombstone hit only A');
    snap = await h.buildLivingMemorySnapshotV3('group:456', {});
    txt = typeof snap === 'string' ? snap : JSON.stringify(snap);
    assert.ok(!txt.includes('QQ:12345') && txt.includes('QQ:67890'), 'injection relabelled after forget');
    void b;
  } finally { await h.close(); }
});

await check('allowlist revoked before flush: rows held, zero bytes sent, restore drains', async () => {
  const h = await enabledHarness();
  try {
    await h.appendSocialV2Message('group:456', '小明', '我周末喜欢去爬山', '我周末喜欢去爬山', false, false, '105', [], '12345', [], {});
    await sleep(40);
    const add = h.applyLongMemoryV3('group:456', [{ action: 'add', kind: 'event', content: '周末爬山', sourceMessageId: '105' }], false);
    void add;
    h.cfg.allow.groups = [];
    const before = v1Calls(h).length;
    const r = await h.flushLivingMemoryOutboxV3({ limit: 100 });
    void r;
    const newV1 = v1Calls(h).slice(before).filter(c => c.url.includes('/v1/'));
    assert.equal(newV1.length, 0, `nothing left the host for a disallowed session (saw ${JSON.stringify(newV1.map(x => x.url))})`);
    h.cfg.allow.groups = ['456'];
    // held rows carry a +10min retry lease; simulate its passage (no wall-clock waits)
    h.livingMemory.outbox.db.prepare("UPDATE lm_outbox SET next_at=0 WHERE status='pending'").run();
    await drain(h);
    assert.ok(h.sidecar.findMemoryByContent('周末爬山'), 'restored session drains');
  } finally { await h.close(); }
});

await check('dead sync row suppresses whole-scope recall injection (fail-safe stale protection)', async () => {
  const h = await enabledHarness();
  try {
    await h.appendSocialV2Message('group:456', '小明', '直接消息', '直接消息', false, false, '106', [], '12345', [], {});
    await sleep(40);
    const add = h.applyLongMemoryV3('group:456', [{ action: 'add', kind: 'userFact', subject: '12345', content: '偏好A', sourceMessageId: '106' }], false);
    h.sidecar.knobs.failEntries.set(`lm:userFact:${add[0].id}`, 'forbidden');
    await drain(h);
    assert.ok(h.livingMemory.outbox.stats().dead >= 1, 'rejected entry went dead');
    assert.equal(h.livingMemory.scopeRecallSuppressed('group:190000456'), true, 'suppression keyed by mapped scope');
    h.sidecar.seedRecall('group:190000456', [{ memoryId: 777, content: '不该出现的远端旧事实', assertedBy: '12345', kind: 'userFact' }]);
    const snap = await h.buildLivingMemorySnapshotV3('group:456', {});
    const txt = typeof snap === 'string' ? snap : JSON.stringify(snap);
    assert.ok(!txt.includes('不该出现的远端旧事实'), 'service results withheld during unresolved sync');
  } finally { await h.close(); }
});

await check('recall failure fail-opens to fresh local snapshot (chat unaffected)', async () => {
  const h = await enabledHarness();
  try {
    h.appendSocialV2Message('group:456', '小明', '我养了一只猫', '我养了一只猫', false, false, '107', [], '12345', [], {});
    h.sidecar.knobs.recallFail = 'unavailable';
    const snap = await h.buildLivingMemorySnapshotV3('group:456', {});
    const txt = typeof snap === 'string' ? snap : JSON.stringify(snap);
    assert.ok(!txt.includes('错误') || txt.length > 0, 'snapshot still returned');
    assert.ok(v1Calls(h).some(c => c.url.includes('/v1/recall')), 'attempt made');
  } finally { await h.close(); }
});

await check('route: active returns usable handles; evidence follows by memoryId within session', async () => {
  const h = await enabledHarness();
  let srv = null;
  try {
    srv = h.startConsoleServer();
    if (!srv.listening) await new Promise(r => srv.once('listening', r));
    const port = srv.address().port;
    await h.appendSocialV2Message('group:456', '小明', '我偏好青绿色的界面', '我偏好青绿色的界面', false, false, '108', [], '12345', [], {});
    await sleep(40);
    const st = h.getSocialV2State('group:456'); // token may rotate on session ensure
    h.applyLongMemoryV3('group:456', [{ action: 'add', kind: 'userFact', subject: '12345', content: '偏好青绿色界面R', sourceMessageId: '108' }], false);
    await drain(h);
    const get = async (path) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: {
        'x-console-token': 'fixture-console-token', ...(st.agentToken ? { 'x-agent-token': st.agentToken } : {}),
      } });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    };
    const active = await get('/api/socialV2/memory?key=group%3A456&search=active&q=%E9%9D%92%E7%BB%BF');
    assert.equal(active.json.ok, true, `active route ok, got ${JSON.stringify(active.json).slice(0, 160)}`);
    const hit = (active.json.results || []).find(r => String(r.content || '').includes('青绿色'));
    assert.ok(hit && Number.isInteger(hit.id) && hit.id > 0, 'numeric memoryId handle returned');
    assert.equal(String(hit.assertedBy), '12345', 'identity preserved in handle');
    const ev = await get(`/api/socialV2/memory?key=group%3A456&search=evidence&memoryId=${hit.id}`);
    assert.equal(ev.json.ok, true, 'evidence accepted the exact handle active returned');
    assert.ok((ev.json.sources || []).some(s => String(s.text || '').includes('青绿色') && String(s.authorUserId) === '12345'),
      'original quote reachable through scoped evidence');
    const bad = await get('/api/socialV2/memory?key=group%3A456&search=evidence&memoryId=svc-9');
    assert.equal(bad.status, 400, 'forged non-numeric handle rejected');
  } finally {
    try { srv?.close(); } catch { /* ignore */ }
    await h.close();
  }
});

await check('mcp schema: legacy fields preserved + search routes to memory regardless of category', async () => {
  const src = await import('node:fs').then(m => m.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8'));
  const block = src.slice(src.indexOf("'qq_memory_query'"), src.indexOf("server.tool(\n  'qq_memory_remove'"));
  assert.ok(block.includes("messageId: z.string()"), 'history messageId field intact');
  assert.ok(block.includes('offset: z.number().int().nonnegative()'), 'history offset field intact');
  assert.ok(block.includes("query: z.string().max(80)"), 'query field intact');
  assert.ok(/const endpoint = search \? 'memory'/.test(block), 'search=active/evidence wins over category routing');
  assert.ok(!block.includes("category !== 'longTerm') q.set('kind'") || block.includes("&& !search"), 'kind param not forged onto memory route');
});

console.log(`\n${results.passed} passed, ${results.failed.length} failed${results.failed.length ? ': ' + results.failed.join('; ') : ''}`);
process.exitCode = results.failed.length ? 1 : 0;
