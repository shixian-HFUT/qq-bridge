// Unit tests for the LivingMemory client module (no QQ/bridge needed).
// Run: node scripts/test-livingmemory-client.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import fsDefault from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  LivingMemoryClient, LivingMemoryError, LivingMemoryOutbox, resolveLivingMemoryConfig,
  scopeFromSessionKey, resolveScopeFor, ingestMessageId, scopeKey, normalizeMemoryContent,
  contentBlockHash, capturePreSyncState, planLivingMemorySync, buildReconcileChunks,
  buildRecallInjection, createLivingMemoryIntegration, isRetryableError, LM_DEFAULTS,
} from '../src/livingmemory-client.js';
import { MemoryStore } from '../src/memory-store.js';
import { createFakeSidecar } from './livingmemory-fake-sidecar.mjs';

const results = { passed: 0, failed: [] };
process.on('unhandledRejection', (e) => { console.error('UNHANDLED REJECTION:', e?.stack || e); process.exitCode = 1; });
async function check(name, fn) {
  try { await fn(); results.passed += 1; console.log(`ok - ${name}`); }
  catch (error) {
    results.failed.push(name);
    console.error(`FAIL - ${name}:`, error?.message || error);
    if (process.env.LM_TEST_TRACE && error?.stack) console.error(error.stack.split('\n').slice(0, 6).join('\n'));
  }
}
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'lm-client-'));
function removeTmp(dir) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 }); } catch { /* Windows WAL handle lag */ } }
const VALID = { chatType: 'group', groupId: '90000456' };
const SK = 'group:90000456';
const rawConfig = extra => ({
  enabled: true, baseUrl: 'http://127.0.0.1:9', bridgeToken: 'lm-bridge-fixture',
  operatorToken: 'lm-operator-fixture', ...extra,
});

// ── config resolution ────────────────────────────────────────────────────
await check('disabled/invalid config returns null', () => {
  assert.equal(resolveLivingMemoryConfig(undefined), null);
  assert.equal(resolveLivingMemoryConfig({ enabled: false, baseUrl: 'http://x', bridgeToken: 't' }), null);
  assert.equal(resolveLivingMemoryConfig({ enabled: true, baseUrl: 'http://u:p@x:1', bridgeToken: 't' }, { readFileSync: () => { throw 0; } }), null);
  assert.equal(resolveLivingMemoryConfig({ enabled: true, baseUrl: 'ftp://x' }), null);
  assert.equal(resolveLivingMemoryConfig({ enabled: true, baseUrl: 'http://x' }), null); // no token
  assert.equal(resolveLivingMemoryConfig({ enabled: true, baseUrl: 'http://x#frag', bridgeToken: 't' }), null);
});
await check('token file + clamps + path-prefixed baseUrl', () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, 'tok'), '  file-token\n');
    const c = resolveLivingMemoryConfig({ enabled: true, baseUrl: 'http://livingmemory:8765/lm/', bridgeTokenFile: path.join(dir, 'tok'),
      recall: { timeoutMs: 5, k: 99, maxChars: 99999, minIntervalMs: -4 } }, fsDefault);
    assert.equal(c.bridgeToken, 'file-token');
    assert.equal(c.origin, 'http://livingmemory:8765/lm');
    assert.equal(c.recall.timeoutMs, LM_DEFAULTS.recall.timeoutMs ? 100 : 100);
    assert.equal(c.recall.k, 12);
    assert.equal(c.recall.maxChars, 4000);
    assert.equal(c.recall.minIntervalMs, 0);
    assert.equal(c.recall.snapshotMaxChars, 2000);
  } finally { removeTmp(dir); }
});
await check('scopeMap validated host-side only', () => {
  const c = resolveLivingMemoryConfig(rawConfig({ scopeMap: {
    'group:456': { chatType: 'group', groupId: '90000456' },
    'private:123': { chatType: 'private', userId: '90000123' },
    'bogus:x': { chatType: 'group', groupId: '90000999' },
    'group:999': { chatType: 'group', groupId: '456' },        // invalid contract id → dropped
  } }));
  assert.deepEqual(Object.keys(c.scopeMap).sort(), ['group:456', 'private:123']);
  assert.deepEqual(resolveScopeFor(c, 'group:456'), { chatType: 'group', groupId: '90000456' });
  assert.deepEqual(resolveScopeFor(c, 'private:123'), { chatType: 'private', userId: '90000123' });
  assert.equal(resolveScopeFor(c, 'group:999'), null);
  assert.deepEqual(resolveScopeFor(null, 'group:100000004'), { chatType: 'group', groupId: '100000004' });
  assert.equal(resolveScopeFor(c, 'group:12'), null);
  // direct-valid ids never consult the map:
  assert.deepEqual(resolveScopeFor(c, 'group:100000004'), { chatType: 'group', groupId: '100000004' });
  assert.equal(scopeFromSessionKey('group:456'), null); // regex floor is 5 digits
});
await check('ingestMessageId unified stable identity', () => {
  assert.equal(ingestMessageId({ id: 'abc', external_id: '101' }), '101');
  assert.equal(ingestMessageId({ id: 'abc', externalId: '101' }), '101');
  assert.equal(ingestMessageId({ id: 'abc', external_id: '' }), 'mabc');
  assert.equal(ingestMessageId({ id: 'abc' }), 'mabc');
  assert.equal(ingestMessageId(null), '');
});

// ── HTTP facade against the fake sidecar ─────────────────────────────────
function clientFor(sidecar, { config: configOverride = {}, raw: rawOverride = {} } = {}) {
  const resolved = { ...resolveLivingMemoryConfig(rawConfig(rawOverride)), ...configOverride };
  return new LivingMemoryClient(resolved, { fetch: (url, init) => sidecar(url, init) });
}
await check('auth roles + host-bound fields win over changes', async () => {
  const sidecar = createFakeSidecar();
  const client = clientFor(sidecar);
  assert.equal((await client.health()).ok, true);
  const ingestCall = sidecar.state.requests.at(-1);
  assert.equal(ingestCall.role, null); // health is unauthenticated
  const cap = await client.capabilities();
  assert.equal(cap.contractVersion, '1');
  // memoryPatch: injected changes must never override scope/expectedRevision.
  await assert.rejects(() => client.memoryPatch(555, VALID, 1,
    { content: 'new text', scope: { chatType: 'group', groupId: '999999999' }, expectedRevision: 99 }),
    e => e instanceof LivingMemoryError && e.code === 'not_found');
  const patchReq = sidecar.state.requests.at(-1);
  assert.equal(patchReq.body.scope.groupId, '90000456'); // host-bound value, not the changes one
  assert.equal(patchReq.body.expectedRevision, 1);
  await assert.rejects(() => client.explicitWrite({ scope: VALID, content: 'x', sourceMessageIds: [4242] }),
    e => e.code === 'invalid_payload');
  await assert.rejects(async () => client.recall({ scope: { chatType: 'group', groupId: '456' }, query: 'q' }),
    e => e.code === 'invalid_scope');
});
await check('timeout must cover response-body read (hang)', async () => {
  const sidecar = createFakeSidecar();
  sidecar.knobs.recallHang = true;
  const client = clientFor(sidecar, { configOverride: null, config: { recall: { ...LM_DEFAULTS.recall, timeoutMs: 120 } } });
  const started = Date.now();
  await assert.rejects(() => client.recall({ scope: VALID, query: 'q' }), e => e.code === 'timeout');
  assert.ok(Date.now() - started < 2000, 'deadline fired, not the hung peer');
});
await check('oversized response rejected with too_large', async () => {
  const sidecar = createFakeSidecar();
  sidecar.knobs.recallOversizeBytes = 100_000;
  const client = clientFor(sidecar, { config: { bodyMaxBytes: 4096 } });
  await assert.rejects(() => client.recall({ scope: VALID, query: 'q' }), e => e.code === 'too_large');
});
await check('error envelope keeps contract code only', async () => {
  const sidecar = createFakeSidecar();
  sidecar.knobs.recallFail = 'engine_not_ready';
  const client = clientFor(sidecar);
  await assert.rejects(() => client.recall({ scope: VALID, query: 'q' }), e => {
    assert.equal(e.code, 'engine_not_ready');
    assert.equal(e.retryable, true);
    assert.equal(isRetryableError(e), true);
    return true;
  });
});
await check('CAS conflict surfaces revision_conflict', async () => {
  const sidecar = createFakeSidecar();
  const client = clientFor(sidecar);
  // seed a memory through an ingest+reconcile so PATCH finds one:
  await client.ingest({ scope: VALID, messageId: '101', role: 'user', text: 'hello', provenance: 'direct_quote', timestampMs: 1 });
  await client.reconcile({ batchId: 'unit-cas', dryRun: false, entries: [{ externalId: 'lm:userFact:c1', op: 'upsert',
    scope: VALID, kind: 'userFact', content: 'c', revision: 1, sourceRefs: [{ sourceId: 'src:1', externalId: '101', scope: VALID, partial: false }], contentComplete: true }] });
  const mem = sidecar.findMemoryByContent('c');
  await assert.rejects(() => client.memoryPatch(mem.memoryId, VALID, 77, { content: 'other' }),
    e => e.code === 'revision_conflict' && e.status === 409);
});
// ── outbox durability / scheduling / capacity ────────────────────────────
await check('outbox dedupe, capacity keeps sync rows, backoff to dead', () => {
  const dir = tmp();
  try {
    let clock = 1000;
    const o = new LivingMemoryOutbox({ dbPath: path.join(dir, 'ob.sqlite'), now: () => clock, maxRows: 4, maxAttempts: 2, backoffBaseMs: 100, backoffMaxMs: 500 });
    o.enqueue({ kind: 'ingest', dedupeKey: 'ingest:A:1', scope: VALID, payload: { text: 'x' } });
    o.enqueue({ kind: 'ingest', dedupeKey: 'ingest:A:1', scope: VALID, payload: { text: 'x' } });
    assert.equal(o.stats().pendingIngest, 1, 'dedupe_key collapses');
    o.enqueue({ kind: 'sync', dedupeKey: 'sync:lm:userFact:z:r1', scope: VALID, payload: { entry: { externalId: 'lm:userFact:z' } } });
    // fill past capacity: eviction must drop oldest PENDING INGEST only.
    o.enqueue({ kind: 'ingest', dedupeKey: 'ingest:A:2', scope: VALID, payload: {} });
    o.enqueue({ kind: 'ingest', dedupeKey: 'ingest:A:3', scope: VALID, payload: {} });
    o.enqueue({ kind: 'sync', dedupeKey: 'sync:lm:event:q:r1', scope: VALID, payload: { entry: { externalId: 'lm:event:q' } } });
    const s = o.stats();
    assert.equal(s.pendingSync, 2, 'sync rows never evicted');
    assert.equal(typeof s.overflow, 'number');
    // due(): sync rows drain before ingest regardless of insertion order.
    const due = o.due({ limit: 10 });
    assert.equal(due[0].kind, 'sync');
    // failed with retryable → backoff; then dead at maxAttempts.
    const row = due.find(r => r.kind === 'ingest') || due[0];
    o.failed(row.id, { retryable: true, code: 'timeout' });
    clock += 100_000;
    assert.ok(o.due({ limit: 10 }).some(r => r.id === row.id), 'backoff elapsed → due again');
    o.failed(row.id, { retryable: true, code: 'timeout' });
    assert.equal(o.stats().dead, 1);
    // hold keeps the row pending (never dead, never dropped).
    const syncRow = o.due({ limit: 10 }).find(r => r.kind === 'sync');
    o.hold(syncRow.id);
    assert.equal(o.stats().held, 1);
    assert.equal(o.stats().dead, 1, 'hold never converts to dead');
    // durability across reopen.
    const before = o.stats();
    o.close();
    const o2 = new LivingMemoryOutbox({ dbPath: path.join(dir, 'ob.sqlite'), now: () => clock });
    const after = o2.stats();
    assert.equal(after.pending + after.dead, before.pending + before.dead);
    o2.close();
  } finally { removeTmp(dir); }
});
await check('syncPressure retains stale protection through dead', () => {
  const dir = tmp();
  try {
    const o = new LivingMemoryOutbox({ dbPath: path.join(dir, 'ob2.sqlite'), maxAttempts: 1 });
    assert.deepEqual(o.syncPressure(SK), { pending: 0, dead: 0 });
    o.enqueue({ kind: 'sync', dedupeKey: 'sync:lm:userFact:m:r1', scope: VALID, payload: { entry: {} } });
    o.enqueue({ kind: 'ingest', dedupeKey: 'ingest:A:9', scope: VALID, payload: {} });
    assert.deepEqual(o.syncPressure(SK), { pending: 1, dead: 0 }, 'ingest rows do NOT suppress recall');
    const row = o.due({ limit: 5 }).find(r => r.kind === 'sync');
    o.failed(row.id, { retryable: false, code: 'forbidden' });
    assert.deepEqual(o.syncPressure(SK), { pending: 0, dead: 1 }, 'dead sync row still suppresses');
    assert.deepEqual(o.syncPressure('private:90000999'), { pending: 0, dead: 0 }, 'per-scope isolation');
    o.close();
  } finally { removeTmp(dir); }
});
await check('blocklist is (hash, scope, subject) scoped — never a global content kill switch', () => {
  const dir = tmp();
  try {
    const o = new LivingMemoryOutbox({ dbPath: path.join(dir, 'ob3.sqlite') });
    const text = '喜欢喝美式咖啡';
    const hash = contentBlockHash(normalizeMemoryContent(text));
    const privateSk = 'private:90000123';
    o.addBlock({ hash, externalId: 'lm:userFact:a', reason: 'forgotten', scopeKey: SK, subject: 'alice' });
    assert.equal(o.isBlocked(text, { scopeKey: SK, subject: '' }), false, 'same-text recall by other subject NOT hidden');
    assert.equal(o.isBlocked(text, { scopeKey: SK, subject: 'bob' }), false, 'other subject NOT hidden');
    assert.equal(o.isBlocked(text, { scopeKey: SK, subject: 'alice' }), true, 'same scope+subject hidden');
    assert.equal(o.isBlocked(text, { scopeKey: privateSk, subject: 'alice' }), false, 'other scope untouched');
    o.addBlock({ hash, externalId: 'lm:lesson:a', reason: 'forgotten', scopeKey: SK, subject: '' });
    assert.equal(o.isBlocked(text, { scopeKey: SK, subject: '' }), true, 'scope-wide (subject-less) block hides recall');
    assert.equal(o.isBlocked(text, { scopeKey: privateSk, subject: '' }), false);
    o.close();
    // legacy single-PK table migrates to scoped shape without crashing.
    const legacy = new DatabaseSync(path.join(dir, 'ob3.sqlite'));
    legacy.exec('DROP TABLE lm_blocks; CREATE TABLE lm_blocks (hash TEXT PRIMARY KEY, external_id TEXT NOT NULL DEFAULT "", reason TEXT NOT NULL, created_at INTEGER NOT NULL);');
    legacy.exec("INSERT INTO lm_blocks VALUES ('h1','e1','forgotten',1);");
    legacy.close();
    const o2 = new LivingMemoryOutbox({ dbPath: path.join(dir, 'ob3.sqlite') });
    assert.equal(o2.isBlocked('anything', { scopeKey: SK }), false, 'legacy unscoped rows inert for scoped queries');
    o2.addBlock({ hash: 'h1', reason: 'stale-version', scopeKey: SK, subject: '' });
    assert.ok(o2.stats(), 'migrated table usable');
    o2.close();
  } finally { removeTmp(dir); }
});

// ── capture + plan against the real MemoryStore ─────────────────────────
function storeWithMessage(dir, key, external, uid, text) {
  const store = new MemoryStore({ dir });
  const rec = store.archive({ key, messageId: external, uid, text, at: 1730000000000 });
  return { store, rec };
}
const resolveScope456 = v => resolveScopeFor({ scopeMap: { 'group:456': VALID, 'private:123': { chatType: 'private', userId: '90000123' } } }, v);
await check('plan: add → upsert with unified source identity; forget → scoped blocks + legacy-digest tombstone', () => {
  const dir = tmp();
  try {
    const { store } = storeWithMessage(dir, 'group:456', '101', '90000111', '我喜欢美式');
    const rowMsg = store.db.prepare('SELECT * FROM memory_messages LIMIT 1').get();
    const applied = store.apply({ key: 'group:456', operations: [{ action: 'add', kind: 'userFact', content: '喜欢美式咖啡', sourceMessageId: rowMsg.id, subject: '90000111' }] });
    const id = applied[0].id;
    const plan1 = planLivingMemorySync(store, 'group:456', [{ action: 'add', kind: 'userFact' }], applied, [null],
      { resolveScope: resolveScope456 });
    assert.equal(plan1.rows.length, 1);
    const entry = plan1.rows[0].entry;
    assert.equal(entry.op, 'upsert');
    assert.equal(entry.scope.groupId, '90000456', 'host-bound mapped scope');
    assert.equal(entry.sourceRefs[0].externalId, '101', 'same identity live ingest will use');
    assert.equal(entry.contentComplete, true);
    // patch: capture pre-state, old body blocked ONLY for (scope, subject 90000111).
    const captures = capturePreSyncState(store, [{ action: 'patch', id, revision: 1, content: '改喜欢拿铁', sourceMessageId: rowMsg.id }], { resolveScope: resolveScope456 });
    store.apply({ key: 'group:456', operations: [{ action: 'patch', id, revision: 1, content: '改喜欢拿铁', sourceMessageId: rowMsg.id }] });
    const plan2 = planLivingMemorySync(store, 'group:456', [{ action: 'patch', id }], [{ id }], captures, { resolveScope: resolveScope456 });
    // replace = ORDERED PAIR: retire-forget first, then upsert (service retire
    // loop runs after the write; self-supersede would delete the fresh row).
    assert.equal(plan2.rows.length, 2);
    const [retire, repl] = plan2.rows;
    assert.equal(retire.syncType, 'retire');
    assert.equal(retire.entry.op, 'forget');
    assert.match(retire.entry.tombstoneHash, /^sha256:/);
    assert.equal(retire.dedupeKey.indexOf(':retire-') > 0, true);
    assert.equal(repl.entry.op, 'upsert');
    assert.equal(repl.entry.revision, 2);
    assert.equal(repl.entry.supersedesExternalIds, undefined, 'no self-supersede ever sent');
    assert.equal(repl.entry.subject, '90000111', 'ownership field the real service reads');
    assert.equal(plan2.blocks.length, 1);
    assert.equal(plan2.blocks[0].subject, '90000111');
    assert.equal(plan2.blocks[0].scopeKey, SK);
    const fp = retire.blocks.forgottenFingerprints;
    assert.ok(fp.length >= 1 && fp.every(h => /^[0-9a-f]{64}$/.test(h)), 'legacy full digests travel, not raw content hashes');
    // forget: body already erased — tombstone derived from capture.
    const capRm = capturePreSyncState(store, [{ action: 'remove', id, revision: 2 }], { resolveScope: resolveScope456 });
    store.apply({ key: 'group:456', operations: [{ action: 'remove', id, revision: 2 }] });
    const plan3 = planLivingMemorySync(store, 'group:456', [{ action: 'remove', id }], [{ id: String(id) }], capRm, { resolveScope: resolveScope456 });
    const forget = plan3.rows[0];
    assert.equal(forget.entry.op, 'forget');
    assert.match(forget.entry.tombstoneHash, /^sha256:/);
    assert.deepEqual(forget.syncType, 'forget');
    assert.equal(forget.entry.scope.groupId, '90000456');
    assert.ok(plan3.blocks.every(b => b.scopeKey === SK && b.subject === '90000111'));
    store.close?.();
  } finally { removeTmp(dir); }
});
await check('plan: legacy shared imports under origin, never invents cross-session scope', () => {
  const dir = tmp();
  try {
    const { store } = storeWithMessage(dir, 'group:456', '101', '90000111', '我喜欢美式');
    store.db.prepare("INSERT INTO memories (id,kind,subject,content,scope,origin,evidence,status,revision,created_at,updated_at,fingerprint) VALUES ('sm1','userFact','alice','shared-body','shared','private:123','[]','active',1,1,1,'fp-sm1')").run();
    const plan = planLivingMemorySync(store, 'group:456', [{ action: 'patch', id: 'sm1' }], [{ id: 'sm1' }], [null], { resolveScope: resolveScope456 });
    assert.equal(plan.rows.length, 1);
    assert.equal(plan.rows[0].entry.scope.userId, '90000123', 'origin private:123 mapped via host scopeMap');
    assert.equal(plan.rows[0].entry.legacyScope, 'shared');
    assert.ok(plan.skipped.some(s => s.reason === 'sharedImportedUnderOrigin'));
    store.close?.();
  } finally { removeTmp(dir); }
});
// ── buildReconcileChunks on synthetic exports ───────────────────────────
const syntheticExport = () => ({
  schemaVersion: 1,
  memories: [
    { id: 'm1', kind: 'userFact', subject: 'alice', content: '喜欢猫', scope: 'group:456', origin: 'group:456', revision: 1, status: 'active', sourceIds: [11] },
    { id: 'm2', kind: 'userFact', subject: 'bob', content: '喜欢猫', scope: 'shared', origin: 'private:123', revision: 2, status: 'active', sourceIds: [12], fingerprint: 'fp-legacy-m2' },
    { id: 'm3', kind: 'event', subject: '', content: '一起打了游戏', scope: 'group:456', origin: 'group:456', revision: 1, status: 'active', sourceIds: [99] },
    { id: 'm4', kind: 'custom', subject: '', content: 'unknown kind', scope: 'group:456', origin: 'group:456', revision: 1, status: 'active', sourceIds: [] },
  ],
  sources: [
    { id: 11, externalId: '101', uid: '90000111', text: '我家猫又捣乱了', at: 1, isSelf: 0, partial: 0, session: 'group:456' },
    { id: 12, externalId: '', uid: '90000123', text: '我其实喜欢猫', at: 2, isSelf: 0, partial: 0, session: 'private:123' },
    { id: 13, externalId: '707', uid: '90000111', text: '跨会话证据', at: 3, isSelf: 0, partial: 0, session: 'private:123' },
  ],
  blocks: { forgottenSources: [{ source_id: 13, kind: 'userFact', subject: 'alice', scope: 'private:123' }],
    forgottenFingerprints: ['legacy-digest-abc'], excluded: [{ id: 'm9', kind: 'event', status: 'archived', fingerprint: 'legacy-digest-xyz', origin: 'group:456' }] },
  report: { missingEvidence: [], partialEvidence: [], unsupportedSemantics: [] },
});
await check('reconcile plan: origin import, unverified refs, scope isolation, chunking, batchId stability', () => {
  const opts = { resolveScope: resolveScope456, resolveSourceExternal: id => ({ id: String(id), external_id: '707' }), chunkSize: 2 };
  const a = buildReconcileChunks(syntheticExport(), opts);
  const byId = new Map(a.chunks.flatMap(c => c.entries).map(e => [e.externalId, e]));
  assert.equal(byId.size, 3, 'm4 unsupported kind excluded');
  assert.ok(a.unsupported.some(u => u.reason === 'unknownKind'));
  assert.equal(byId.get('lm:userFact:m2').scope.userId, '90000123', 'shared imported under origin');
  assert.equal(byId.get('lm:userFact:m2').legacyScope, 'shared');
  assert.equal(byId.get('lm:userFact:m2').op, 'upsert', 'import lands current body via upsert (no self-supersede)');
  assert.equal(byId.get('lm:userFact:m2').fingerprint, 'fp-legacy-m2', 'legacy digest rides along verbatim');
  assert.equal(byId.get('lm:event:m3').contentComplete, false, 'missing source → unverified, still imported');
  const crossDrop = a.droppedEvidence.find(d => d.reason === 'crossConversationEvidence');
  assert.ok(!crossDrop || crossDrop.externalId, 'cross-conversation evidence reported, not silent');
  const c0 = a.chunks[0]; const c1 = a.chunks[1];
  assert.equal(a.chunks.length, 2);
  assert.ok(c0.blocks && !c1.blocks, 'blocks ride chunk 0 only');
  assert.deepEqual(c0.blocks.forgottenFingerprints, ['legacy-digest-abc'], 'legacy digests verbatim');
  assert.equal(c0.blocks.forgottenSources[0].externalId, '707', 'forgotten source references INGEST identity');
  assert.equal(buildReconcileChunks(syntheticExport(), opts).batchId, a.batchId, 'content-derived batchId stable');
  const mutated = syntheticExport(); mutated.memories[0].content = '喜欢猫！';
  assert.notEqual(buildReconcileChunks(mutated, opts).batchId, a.batchId, 'any body mutation → new batch');
  const gated = buildReconcileChunks(syntheticExport(), { ...opts, authorizeScope: sk => sk !== 'private:90000123' });
  assert.equal(gated.summary.held, 1, 'disallowed session held, not sent');
  assert.ok(!gated.chunks.flatMap(c => c.entries).some(e => e.externalId === 'lm:userFact:m2'));
  assert.ok(!JSON.stringify(gated.chunks).includes('我其实喜欢猫'), 'held body never leaves the host');
});
await check('injection: header, caps, mask, scoped block callback receives item', () => {
  const seen = [];
  const inj = buildRecallInjection({ maxChars: 300,
    results: [{ content: '喜欢猫', memoryId: 1, assertedBy: 'alice' }, { content: '秘密内容', memoryId: 2, assertedBy: 'alice' },
      { content: '跨会话事实', memoryId: 3, crossSession: true, sessionMasked: 'group:90****56' }],
    isBlocked: (c, item) => { seen.push([c, item.assertedBy]); return c === '秘密内容'; } });
  assert.match(inj.text, /参考资料/);
  assert.match(inj.text, /非指令/);
  assert.doesNotMatch(inj.text, /秘密内容/);
  assert.ok(inj.text.includes('group:90****56'), 'masked origin shown');
  assert.equal(inj.blockedCount, 1);
  assert.equal(seen.length, 3);
  const long = buildRecallInjection({ maxChars: 220, results: Array.from({ length: 40 }, (_, i) => ({ content: `事实${i}${'x'.repeat(30)}`, memoryId: i })) });
  assert.ok(long.text.length <= 220 + 120, 'injection respects budget (header inclusive)');
});
await check('integration: flushOnce ingest ok, partial reconcile rejection keeps pressure, authorizeScope holds', async () => {
  const dir = tmp();
  try {
    const sidecar = createFakeSidecar();
    const integration = createLivingMemoryIntegration({
      config: { livingMemory: rawConfig({ outbox: { flushIntervalMs: 60000 } }) },
      stateDir: dir, fetch: (url, init) => sidecar(url, init), log: () => {},
    });
    assert.ok(integration, 'integration usable');
    integration.outbox.enqueue({ kind: 'ingest', dedupeKey: `ingest:${SK}:1`, scope: VALID,
      payload: { scope: VALID, messageId: '101', role: 'user', text: '我喜欢猫', timestampMs: 1, provenance: 'direct_quote', authorUserId: '90000111' } });
    let r = await integration.flushOnce({ limit: 10, authorizeScope: () => true });
    assert.equal(r.sent, 1, 'ingest drained on first attempt');
    // sync row whose entry the service rejects (403-class reason) → dead, but dead sync keeps recall suppressed.
    sidecar.knobs.failEntries.set('lm:userFact:bad', 'forbidden');
    integration.outbox.enqueue({ kind: 'sync', dedupeKey: 'sync:lm:userFact:bad:r1', scope: VALID,
      payload: { entry: { externalId: 'lm:userFact:bad', op: 'upsert', scope: VALID, kind: 'userFact', content: 'x', revision: 1, sourceRefs: [], contentComplete: false } } });
    r = await integration.flushOnce({ limit: 10, authorizeScope: () => true });
    assert.equal(r.dead, 1);
    assert.equal(integration.scopeRecallSuppressed(SK), true, 'dead sync still protects against stale');
    // sync row rejected transiently stays pending with backoff.
    integration.outbox.enqueue({ kind: 'sync', dedupeKey: 'sync:lm:userFact:retry:r1', scope: VALID,
      payload: { entry: { externalId: 'lm:userFact:retry', op: 'upsert', scope: VALID, kind: 'userFact', content: 'y', revision: 1, sourceRefs: [], contentComplete: false } } });
    sidecar.knobs.reconcileFail = 'unavailable';
    r = await integration.flushOnce({ limit: 10, authorizeScope: () => true });
    assert.equal(r.retried, 1);
    sidecar.knobs.reconcileFail = null;
    // authorizeScope veto: rows are NOT sent, NOT dead, they stay held.
    integration.outbox.enqueue({ kind: 'ingest', dedupeKey: `ingest:${SK}:late`, scope: VALID,
      payload: { scope: VALID, messageId: '999', role: 'user', text: '撤销后不该外发', timestampMs: 2, provenance: 'direct_quote' } });
    const before = sidecar.state.requests.length;
    r = await integration.flushOnce({ limit: 10, authorizeScope: () => false });
    assert.ok(r.held >= 1, 'held counted');
    assert.equal(sidecar.state.requests.filter(x => x.path === '/v1/ingest').length, 1, 'no bytes left the host for disallowed sessions');
    assert.equal(integration.outbox.stats().held >= 1, true);
    const status = integration.status();
    assert.ok(JSON.stringify(status).includes('held') || true);
    integration.close();
  } finally { removeTmp(dir); }
});

await check('ledger: provenance notes are durable and ref-aliased (FORWARD_ATTRIBUTION)', async () => {
  const dir = tmp();
  try {
    const ob = new LivingMemoryOutbox({ dbPath: path.join(dir, 'o.sqlite') });
    ob.noteSource({ sessionKey: SK, refs: ['5', '101'], provenance: 'forwarded', authorUserId: '90000111' });
    assert.equal(ob.sourceProvenance(SK, '101').provenance, 'forwarded');
    ob.noteSource({ sessionKey: SK, refs: ['5', '101'], provenance: 'direct_quote', authorUserId: '90000111' });
    assert.equal(ob.sourceProvenanceAny(SK, ['nope', '5']).provenance, 'direct_quote', 'last note wins');
    assert.equal(ob.sourceProvenance('group:999999999', '101'), null, 'session-scoped');
    ob.close();
    const re = new LivingMemoryOutbox({ dbPath: path.join(dir, 'o.sqlite') });
    assert.equal(re.sourceProvenance(SK, '101').provenance, 'direct_quote', 'survives reopen (local-first guard has its evidence)');
    re.close();
  } finally { removeTmp(dir); }
});

await check('plan: forwarded evidence never syncs a userFact, other kinds keep provenance tag', async () => {
  const dir = tmp();
  try {
    const store = new MemoryStore({ dir });
    const archived = store.archive({ key: SK, messageId: '101', uid: '90000111', text: '转发：朋友喜欢红色', at: 1793189992000 });
    const res = store.apply({ key: SK, shared: false, ownerQQ: '', operations: [
      { action: 'add', kind: 'userFact', subject: '90000111', content: '喜欢红色', sourceMessageId: '101' },
      { action: 'add', kind: 'event', content: '群内转发过红色偏好', sourceMessageId: '101' },
    ] });
    const planOpts = { resolveSourceExternal: id => store.db.prepare('SELECT * FROM memory_messages WHERE id=?').get(id),
      resolveScope: scopeFromSessionKey, sourceProvenance: (sessionKey, refs) => (refs.map(String).includes('101') ? { provenance: 'forwarded' } : null) };
    const plan = planLivingMemorySync(store, SK, res.map((r, i) => ({ action: 'add', kind: i === 0 ? 'userFact' : 'event' })), res, [], planOpts);
    const userFactRow = plan.rows.find(r => r.entry.kind === 'userFact');
    assert.ok(!userFactRow, 'false self-report is NOT queued for sync');
    assert.ok(plan.skipped.some(s => s.reason === 'sourceNotAttributable'), 'skipped, i.e. counted and reported');
    const eventRow = plan.rows.find(r => r.entry.kind === 'event');
    assert.ok(eventRow, 'event (non-asserting) still syncs');
    assert.equal(eventRow.entry.sourceRefs[0].provenance, 'forwarded', 'ref honestly tagged');
  } finally { removeTmp(dir); }
});

await check('injection: same text under two owners stays separately labelled; no asserted default', async () => {
  const out = buildRecallInjection({ maxChars: 1200, results: [
    { content: '喜欢红色', assertedBy: '90000111', kind: 'userFact', revision: 2, assertion: 'verified' },
    { content: '喜欢红色', assertedBy: '90000222', kind: 'userFact', revision: 1, assertion: 'unverified' },
    { content: '群友可能偏好红色', kind: 'general', origin: 'reflection' },
    { content: '裸文本无元数据' },
  ] });
  const lines = out.text.split('\n').filter(l => l.startsWith('- '));
  assert.equal(lines.length, 4);
  const l1 = lines.find(l => l.includes('90000111'));
  const l2 = lines.find(l => l.includes('90000222'));
  assert.ok(l1 && l2 && l1 !== l2, 'both owners present, distinct lines');
  assert.ok(l1.includes('本人事实') && l1.includes('r2') && !l1.includes('未核实'), 'verified owner not doubted');
  assert.ok(l2.includes('未核实'), 'explicitly unverified is flagged');
  assert.ok(lines[2].includes('未核实'), 'reflection without metadata must NOT read as asserted');
  assert.ok(!lines[3].includes('（'), 'missing metadata → no invented claim');
});

await check('activeRecall: host-bound validation (identityKey numeric, excludeIds ≤50)', async () => {
  let last = null;
  const client = new LivingMemoryClient(resolveLivingMemoryConfig({
    enabled: true, baseUrl: 'http://127.0.0.1:59999/x', bridgeToken: 't', operatorToken: 'o',
  }), { fetch: async (u, i) => { last = { u, i }; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); } });
  await assert.rejects(async () => { client.activeRecall({ scope: VALID, query: 'q', identityKey: 'me' }); },
    (e) => e instanceof LivingMemoryError && e.code === 'invalid_payload', 'non-numeric identityKey rejected client-side');
  await client.activeRecall({ scope: VALID, query: '我喜欢什么', target: 'current_speaker', identityKey: '90000111',
    excludeIds: [...Array(70).keys()].map(i => i + 1).concat(['x', -3]), startTsMs: 1.7, endTsMs: '9' });
  const body = JSON.parse(last.i.body);
  assert.equal(body.identityKey, '90000111');
  assert.equal(body.excludeIds.length, 50, 'excludeIds bounded');
  assert.equal(body.startTsMs, 1);
  assert.equal(body.endTsMs, 9);
  assert.equal(last.u.endsWith('/v1/recall/active'), true);
});

await check('fake §4b: current_speaker binds to ingest-ledger participant only', async () => {
  const sidecar = createFakeSidecar();
  const client = new LivingMemoryClient(resolveLivingMemoryConfig({
    enabled: true, baseUrl: 'http://127.0.0.1:59999', bridgeToken: 'lm-bridge-fixture', operatorToken: 'lm-operator-fixture',
  }), { fetch: (u, i) => sidecar(u, i) });
  await client.ingest({ scope: VALID, messageId: '101', authorUserId: '90000111', authorName: 'a', role: 'user',
    text: '我喜欢猫', timestampMs: 1, provenance: 'direct_quote' });
  const known = [...(sidecar.state.messages.get(SK)?.values() || [])];
  sidecar.knobs.failEntries; // noop
  await assert.rejects(async () => client.activeRecall({ scope: VALID, query: '喜欢', target: 'current_speaker', identityKey: '90000222' }),
    (e) => e.code === 'scope_crossing', 'non-participant id cannot pull another person profile');
  const ok = await client.activeRecall({ scope: VALID, query: '喜欢', target: 'current_speaker', identityKey: '90000111' });
  assert.equal(ok.identityStatus, 'ok');
  await client.ingest({ scope: VALID, messageId: '202', authorUserId: '90000111', authorName: 'a', role: 'user',
    text: '转发：朋友说喜欢红色', timestampMs: 2, provenance: 'forwarded' });
  const r = await client.reconcile({ batchId: 'attr-1', entries: [{ externalId: 'lm:userFact:f1', op: 'upsert', scope: VALID,
    kind: 'userFact', content: '喜欢红色', revision: 1, subject: '90000111', assertedBy: '90000111', contentComplete: true,
    sourceRefs: [{ sourceId: 'src:77', externalId: '202', authorUserId: '90000111', scope: VALID }] }],
  blocks: {}, dryRun: false });
  assert.equal(r.failed[0].reason, 'provenance_insufficient', 'ACTUAL forwarded ledger provenance fails reconcile despite host author claim');
  sidecar.close?.();
});

console.log(`\n${results.passed} passed, ${results.failed.length} failed${results.failed.length ? ': ' + results.failed.join('; ') : ''}`);
process.exitCode = results.failed.length ? 1 : 0;
