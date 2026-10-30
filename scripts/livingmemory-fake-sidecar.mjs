// In-memory fake of the LivingMemory sidecar for bridge/client tests ONLY.
// It implements CONTRACT v1 semantics honestly enough to catch real wiring
// bugs: auth roles, scope validation, ingest dedupe, recall blocklist
// filtering, reconcile source-linking (unverified when the host references a
// message identity it never ingested), per-entry failures, CAS, tombstones,
// batch idempotency replay, and dryRun zero-writes. Knobs drive timeouts,
// oversized bodies, and injected failures.
import { createHash } from 'node:crypto';
import { contentBlockHash, normalizeMemoryContent, scopeKey, scopeFromSessionKey } from '../src/livingmemory-client.js';

const sha = s => createHash('sha256').update(String(s)).digest('hex');
const err = (code, extra = {}) => ({ ok: false, error: { code, requestId: 'fake-req', retryable: code === 'unavailable', ...extra } });

export function createFakeSidecar({ bridgeToken = 'lm-bridge-fixture', operatorToken = 'lm-operator-fixture' } = {}) {
  const state = {
    messages: new Map(),          // scopeKey -> Map(messageId -> rec)
    memories: new Map(),          // externalId -> memory record
    fingerprints: new Set(),      // blocklist content keys (legacy digests / normalized hashes)
    sources: new Set(),           // forgotten source keys (src:id or msgId)
    excluded: new Set(),
    batches: new Map(),           // batchId -> response snapshot (idempotent replay)
    seenKeys: new Map(),          // externalId|revision|fp -> applied response part
    requests: [],                 // {method, path, role, body}
    counters: { writes: 0, providerCalls: 0, ingestMessages: 0, ingestDuplicates: 0 },
  };
  const knobs = {
    recallDelayMs: 0, recallHang: false, recallFail: null, recallOversizeBytes: 0,
    ingestFail: null, reconcileFail: null, failEntries: new Map(), // externalId -> reason
    scopeMap: null,                                                  // fake-side scope alias map (same as host)
  };
  const seedRecall = new Map(); // scopeKey -> [{memoryId, content, assertedBy?, origin?...}]
  let nextMemoryId = 900;
  let nextMessageId = 1200;

  const resolveScopeKey = s => {
    const direct = scopeFromSessionKey(scopeKey(s));
    if (direct) return scopeKey(direct);
    return scopeKey(s); // fixture scopes may be synthetic; identity is what we store under
  };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const roleOf = req => {
    const t = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (t === bridgeToken) return 'bridge';
    if (t === operatorToken) return 'operator';
    return null;
  };
  const fullDigestLike = (kind, subject, content, scope) => sha(JSON.stringify([kind, subject || '', content || '', scope || '']));

  function recallFor(scopeKeyStr) {
    const seeded = seedRecall.get(scopeKeyStr) || [];
    // Reconciled memories are recallable too — exactly like the real service.
    const live = [...state.memories.values()]
      .filter(m => m.status === 'active' && m.scopeKey === scopeKeyStr)
      .map(m => ({ memoryId: m.memoryId, externalId: m.externalId, content: m.content, score: 0.9,
        origin: scopeKeyStr, kind: m.kind, revision: m.revision,
        assertedBy: m.assertedBy || undefined, asserted: m.assertion === 'verified' || m.assertion === 'asserted',
        assertion: m.assertion, crossSession: false, sessionMasked: false }));
    let blocked = 0;
    const filterItem = item => {
      const mem = item.externalId ? state.memories.get(item.externalId) : null;
      const forgotten = (mem && mem.status === 'forgotten') || state.excluded.has(item.externalId || '');
      const subject = mem ? mem.assertedBy : item.assertedBy;
      const normHit = state.fingerprints.has(contentBlockHash(normalizeMemoryContent(item.content)));
      const digestHit = state.fingerprints.has(fullDigestLike(mem?.kind || item.kind, subject, item.content, scopeKeyStr));
      if (forgotten || normHit || digestHit) { blocked += 1; return false; }
      return true;
    };
    const results = [...live, ...seeded].filter(filterItem);
    return { results, blocked };
  }

  async function handle(url, init = {}) {
    const u = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    const role = roleOf(init);
    const body = init.body ? JSON.parse(init.body) : null;
    state.requests.push({ method, path: u.pathname, search: u.search, role, body });
    const path = u.pathname;
    if (path === '/v1/health') return json(200, { ok: true, state: 'ready', version: 'fake-1' });
    if (!role) return json(401, err('unauthorized'));

    if (method === 'GET' && path === '/v1/capabilities') {
      return json(200, { contractVersion: '1', roles: ['bridge', 'operator'],
        features: ['ingest', 'recall', 'reconcile', 'tombstone', 'blocklist', 'cas', 'idempotency'],
        limits: { textMaxChars: 32000, recallKMax: 12, recallMaxCharsMax: 4000, reconcileChunkMax: 500 } });
    }

    if (method === 'POST' && path === '/v1/ingest') {
      if (role !== 'bridge') return json(403, err('forbidden'));
      if (knobs.ingestFail) return json(503, err(knobs.ingestFail));
      const scope = body?.scope; const sk = resolveScopeKey(scope);
      if (!scope || !sk || !body?.messageId || !body?.text) return json(400, err('invalid_payload'));
      if (body.provenance === 'bot_output' && body.role === 'user') return json(400, err('invalid_payload'));
      if (String(body.text).length > 32000) return json(413, err('too_large'));
      if (!state.messages.has(sk)) state.messages.set(sk, new Map());
      const bucket = state.messages.get(sk);
      if (bucket.has(String(body.messageId))) {
        state.counters.ingestDuplicates += 1;
        return json(200, { messageId: bucket.get(String(body.messageId)).id, sessionRevision: bucket.size, duplicate: true });
      }
      const id = nextMessageId++;
      bucket.set(String(body.messageId), { id, rec: body });
      state.counters.ingestMessages += 1;
      return json(200, { messageId: id, sessionRevision: bucket.size, duplicate: false });
    }

    if (method === 'POST' && path === '/v1/recall') {
      if (!['bridge', 'operator'].includes(role)) return json(403, err('forbidden'));
      if (knobs.recallHang) return new Promise(() => {}); // never settles; host deadline must fire
      if (knobs.recallDelayMs) await new Promise(r => setTimeout(r, knobs.recallDelayMs));
      if (knobs.recallFail) return json(503, err(knobs.recallFail));
      const sk = resolveScopeKey(body?.scope);
      if (!sk) return json(400, err('invalid_scope'));
      const { results, blocked } = recallFor(sk);
      if (knobs.recallOversizeBytes) {
        return json(200, { results: [{ memoryId: 1, content: 'x'.repeat(knobs.recallOversizeBytes) }], injectionBlock: '', truncated: false, meta: { blockedFiltered: 0 } });
      }
      return json(200, { results, injectionBlock: '', truncated: false, meta: { blockedFiltered: blocked }, tookMs: 3 });
    }
    if (method === 'POST' && path === '/v1/recall/active') {
      if (!['bridge', 'operator'].includes(role)) return json(403, err('forbidden'));
      if (knobs.recallFail) return json(503, err(knobs.recallFail));
      const sk = resolveScopeKey(body?.scope);
      if (!sk) return json(400, err('invalid_scope'));
      const { results, blocked } = recallFor(sk);
      const exclude = new Set((body?.excludeIds || []).map(Number));
      let out = results.filter(r => !exclude.has(r.memoryId));
      let identityStatus = 'none';
      if (body?.target === 'current_speaker') {
        // §4b: identityKey must be verifiable as a participant of THIS scope's
        // ingest ledger — a generic wording can never grab another person.
        const idKey = String(body?.identityKey || '');
        const bucket = state.messages.get(sk) || new Map();
        const known = [...bucket.values()].some(x => String(x.rec?.authorUserId || '') === idKey);
        if (!known) return json(403, err('scope_crossing', { detail: 'identityKey not a participant of this session' }));
        out = out.filter(r => String(r.assertedBy || '') === idKey || String(r.subject || '') === idKey);
        identityStatus = 'ok';
      }
      const k = Math.min(12, Math.max(1, Number(body?.k) || 8));
      out = out.slice(0, k);
      out = out.map(r => ({ ...r, matchBasis: r.assertedBy ? 'owner' : 'semantic' }));
      return json(200, { results: out, hasMore: false, nextCursor: '', status: 'ok',
        identityStatus, partial: false, coverage: 1, message: '', meta: { blockedFiltered: blocked }, tookMs: 4 });
    }
    const detail = path.match(/^\/v1\/memories\/([^/]+)(\/evidence)?$/);
    if (detail) {
      if (!['bridge', 'operator'].includes(role)) return json(403, err('forbidden'));
      {
        const id = decodeURIComponent(detail[1]);
        const scopeQ = u.searchParams.get('scope') || (body?.scope ? scopeKey(body.scope) : '');
        const mem = [...state.memories.values()].find(m => String(m.memoryId) === id);
        if (method === 'GET' && detail[2]) { // evidence
          if (!mem || scopeKey(mem.scope) !== scopeQ) return json(403, err('scope_crossing'));
          const sources = (mem.sourceRefs || []).map(ref => {
            const bucket = state.messages.get(resolveScopeKey(ref.scope || mem.scope));
            const hit = bucket?.get(String(ref.externalId));
            const blockedSrc = state.sources.has(ref.sourceId || '') || (hit && state.sources.has(`src:${hit.id}`));
            return { messageId: hit?.id ?? null, role: hit?.rec?.role || 'user', authorUserId: hit?.rec?.authorUserId || ref.authorUserId,
              text: blockedSrc ? '' : (hit?.rec?.text || ''), timestampMs: hit?.rec?.timestampMs || 0, blocked: !!blockedSrc };
          });
          return json(200, { sources });
        }
        if (method === 'GET') {
          if (!mem) return json(404, err('not_found'));
          if (scopeKey(mem.scope) !== scopeQ) return json(403, err('scope_crossing'));
          return json(200, { memoryId: mem.memoryId, externalId: mem.externalId, kind: mem.kind, content: mem.content,
            revision: mem.revision, status: mem.status, assertion: mem.assertion });
        }
        if (method === 'PATCH') {
          if (!mem) return json(404, err('not_found'));
          if (scopeKey(mem.scope) !== scopeQ) return json(403, err('scope_crossing'));
          if (body?.expectedRevision === undefined) return json(400, err('invalid_payload'));
          if (body.expectedRevision !== mem.revision) return json(409, err('revision_conflict', { currentRevision: mem.revision }));
          if (state.fingerprints.has(contentBlockHash(normalizeMemoryContent(body.content)))) return json(409, err('blocked_source'));
          mem.revision += 1; mem.content = String(body.content || mem.content);
          state.counters.writes += 1;
          return json(200, { memoryId: mem.memoryId, revision: mem.revision, reindexed: true });
        }
        if (method === 'DELETE') {
          if (!mem) return json(200, { deleted: false, reason: 'unknown_or_already' }); // replays are 200
          if (scopeKey(mem.scope) !== scopeQ) return json(403, err('scope_crossing'));
          state.fingerprints.add(fullDigestLike(mem.kind, mem.assertedBy, mem.content, mem.scope));
          state.fingerprints.add(contentBlockHash(normalizeMemoryContent(mem.content)));
          mem.status = 'forgotten';
          state.counters.writes += 1;
          return json(200, { deleted: true, memoryId: mem.memoryId });
        }
      }
    }
    if (method === 'GET' && path === '/v1/memories') {
        const scopeQ = u.searchParams.get('scope') || '';
        if (!scopeQ) return json(400, err('invalid_scope'));
        const page = Math.max(1, Number(u.searchParams.get('page') || 1));
        const pageSize = Math.min(100, Math.max(1, Number(u.searchParams.get('pageSize') || 20)));
        const all = role === 'operator' && scopeQ === 'all'
          ? [...state.memories.values()] : [...state.memories.values()].filter(m => scopeKey(m.scope) === scopeQ);
        return json(200, { items: all.slice((page - 1) * pageSize, page * pageSize).map(m => ({ memoryId: m.memoryId, externalId: m.externalId, kind: m.kind, content: m.content, revision: m.revision, status: m.status })), total: all.length });
      }
      if (method === 'POST' && path === '/v1/memories') {
        if (role !== 'bridge') return json(403, err('forbidden'));
        const sk = resolveScopeKey(body?.scope);
        if (!sk || !body?.content) return json(400, err('invalid_payload'));
        const bucket = state.messages.get(sk) || new Map();
        const refs = (body.sourceMessageIds || []).map(mid => [...bucket.values()].find(x => x.id === mid));
        if ((body.sourceMessageIds || []).length !== refs.length || refs.some(x => !x)) return json(400, err('invalid_payload'));
        // app.py provenance gate (409 provenance_insufficient): an asserted
        // personal fact needs ≥1 direct source BY that author; forwarded/quoted/
        // admin/bot evidence may only back non-asserted observations.
        const assertingActor = body.assertedBy || (body.scope?.chatType === 'private' ? String(body.scope.userId) : null);
        if (assertingActor && refs.length) {
          const grounded = refs.some(x => (x.rec?.provenance === 'direct' || x.rec?.provenance === 'direct_quote') && String(x.rec?.authorUserId ?? '') === String(assertingActor));
          if (!grounded) return json(409, err('provenance_insufficient'));
        }
        if (refs.some(x => state.sources.has(`src:${x.id}`))) return json(409, err('blocked_source'));
        if (state.fingerprints.has(contentBlockHash(normalizeMemoryContent(body.content)))) return json(409, err('blocked_source'));
        const memoryId = nextMemoryId++;
        const externalId = `svc:${memoryId}`;
        state.memories.set(externalId, { memoryId, externalId, scope: body.scope, scopeKey: resolveScopeKey(body.scope), kind: 'userFact', content: body.content,
          revision: 1, status: 'active', assertedBy: assertingActor || null, assertion: assertingActor && refs.length ? 'asserted' : 'unverified', sourceRefs: [] });
        state.counters.writes += 1;
        return json(200, { memoryId, revision: 1 });
    }

    if (path === '/v1/admin/reconcile' && method === 'POST') {
      if (role !== 'operator') return json(403, err('forbidden'));
      if (knobs.reconcileFail) return json(503, err(knobs.reconcileFail));
      const dryRun = body?.dryRun === true;
      if (!body?.batchId || !Array.isArray(body.entries)) return json(400, err('invalid_payload'));
      const replay = state.batches.get(String(body.batchId));
      if (replay && !dryRun) return json(200, { ...replay, replayed: true }); // restart-surviving idempotency
      const failed = []; const unsupported = []; const appliedList = [];
      let applied = 0; let skipped = 0;
      const registerBlocks = () => {
        const blocks = body.blocks || {};
        for (const fp of blocks.forgottenFingerprints || []) state.fingerprints.add(String(fp));
        for (const src of blocks.forgottenSources || []) { state.sources.add(String(src.sourceId)); if (src.externalId) state.sources.add(String(src.externalId)); }
        for (const ex of blocks.excluded || []) state.excluded.add(String(ex.id));
      };
      if (!dryRun) registerBlocks();
      for (const entry of body.entries) {
        if (!entry?.externalId || !['upsert', 'replace', 'forget'].includes(entry.op)) { unsupported.push({ externalId: entry?.externalId, reason: 'mergeFamily' }); continue; }
        if (entry.op === 'forget') {
          const mem = state.memories.get(entry.externalId);
          const idem = `${entry.externalId}|forget|${entry.tombstoneHash || ''}`;
          if (state.seenKeys.has(idem)) { skipped += 1; continue; }
          if (!dryRun) {
            state.seenKeys.set(idem, true);
            if (mem) { state.fingerprints.add(fullDigestLike(mem.kind, mem.assertedBy, mem.content, mem.scope)); mem.status = 'forgotten'; }
            state.fingerprints.add(String(entry.tombstoneHash || '').replace(/^sha256:/, ''));
            for (const h of entry.tombstoneHashes || []) state.fingerprints.add(String(h).replace(/^sha256:/, ''));
            for (const sid of entry.forgottenSourceExternalIds || []) state.sources.add(String(sid));
            state.counters.writes += 1;
          }
          applied += 1; continue;
        }
        if (entry.kind && !['userFact', 'event', 'lesson'].includes(entry.kind)) { unsupported.push({ externalId: entry.externalId, reason: 'unknownKind' }); continue; }
        if (!entry.scope || !scopeKey(entry.scope)) { failed.push({ externalId: entry.externalId, reason: 'invalid_scope' }); continue; }
        const entrySk = scopeKey(entry.scope);
        const ownershipBad = (entry.sourceRefs || []).some(ref => ref.scope && scopeKey(ref.scope) !== entrySk);
        if (ownershipBad) { failed.push({ externalId: entry.externalId, reason: 'session_ownership' }); continue; }
        // Mirror sidecar/reconcile.py:172 — userFact source author must equal
        // entry.subject (private default: the peer QQ). No field-name slack here.
        const ownerSubject = entry.subject || (entry.scope.chatType === 'private' ? entry.scope.userId : '');
        const authorBad = entry.kind === 'userFact'
          && (entry.sourceRefs || []).some(ref => ref.authorUserId && String(ref.authorUserId) !== String(ownerSubject || ''));
        if (authorBad) { failed.push({ externalId: entry.externalId, reason: 'author_mismatch' }); continue; }
        if (entry.fingerprint && state.fingerprints.has(String(entry.fingerprint))) {
          failed.push({ externalId: entry.externalId, reason: 'blocked_fingerprint' }); continue;
        }
        // reconcile.py:222 — same grounded rule on imports, verified against the
        // ACTUAL ingested ledger (host-claimed author strings cannot bypass it);
        // refs never seen in the ledger stay unknown → unverified, not failed.
        if (entry.kind === 'userFact' && (entry.sourceRefs || []).length) {
          const attrBucket = state.messages.get(entrySk) || new Map();
          let g = false; let b = false;
          for (const ref of entry.sourceRefs) {
            const hit = ref.externalId != null ? attrBucket.get(String(ref.externalId)) : null;
            const prov = hit?.rec?.provenance || ref.provenance;
            if (prov === 'direct' || prov === 'direct_quote') g = true;
            else if (prov) { b = true; ref.provenance = prov; }
          }
          if (b && !g) { failed.push({ externalId: entry.externalId, reason: 'provenance_insufficient' }); continue; }
        }
        if (knobs.failEntries.has(entry.externalId)) { failed.push({ externalId: entry.externalId, reason: String(knobs.failEntries.get(entry.externalId)) }); continue; }
        const fp = sha([entry.kind, entry.content, entry.revision]);
        const idem = `${entry.externalId}|${entry.revision}|${fp}`;
        if (state.seenKeys.has(idem)) { skipped += 1; continue; }
        // true source validation (BRIDGE_BLOCKERS t2): a ref naming an identity
        // this fake never ingested makes the entry unverified — never silently asserted.
        const bucket = state.messages.get(entrySk) || new Map();
        const linked = (entry.sourceRefs || []).map(ref => ref.externalId ? bucket.get(String(ref.externalId)) : null);
        const unverified = !entry.sourceRefs?.length || entry.contentComplete === false || linked.some(x => !x)
          || (entry.sourceRefs || []).some((ref, i) => ref.partial || !linked[i]);
        if (dryRun) { appliedList.push({ externalId: entry.externalId, wouldVerify: !unverified }); continue; }
        const existing = state.memories.get(entry.externalId);
        if (existing && existing.status === 'forgotten' && (entry.revision || 1) <= (existing.revision || 0)) {
          skipped += 1; continue; // tombstoned at same/lower revision (service parity)
        }
        if (existing && existing.status === 'active' && existing.revision === entry.revision && existing.content === entry.content) { skipped += 1; continue; }
        const memoryId = existing?.status === 'forgotten' ? nextMemoryId++ : (existing?.memoryId || nextMemoryId++);
        state.memories.set(entry.externalId, { memoryId, externalId: entry.externalId, scope: entry.scope, scopeKey: resolveScopeKey(entry.scope), kind: entry.kind,
          content: entry.content, revision: entry.revision, status: 'active', assertedBy: entry.subject || entry.assertedBy || null,
          assertion: unverified ? 'unverified' : 'verified', sourceRefs: entry.sourceRefs || [] });
        if (entry.op === 'replace') {
          for (const oldId of entry.supersedesExternalIds || []) {
            // faithful to reconcile.py: retire runs AFTER the new write — a
            // self-supersede therefore deletes the fresh row. The host must
            // never send one (retire→upsert pair instead).
            const old = state.memories.get(oldId);
            if (old) { state.fingerprints.add(fullDigestLike(old.kind, old.assertedBy, old.content, old.scope)); old.status = 'forgotten'; }
          }
        }
        state.seenKeys.set(idem, true);
        state.counters.writes += 1;
        applied += 1;
      }
      const response = { applied: dryRun ? appliedList.length : applied, skipped, failed, unsupported, providerCalls: 0, dryRun };
      if (!dryRun) state.batches.set(String(body.batchId), response);
      return json(200, response);
    }

    const st = path === '/v1/admin/reconcile/state' && method === 'GET';
    if (st) {
      if (role !== 'operator') return json(403, err('forbidden'));
      const mem = state.memories.get(u.searchParams.get('externalId') || '');
      return json(200, { externalId: mem?.externalId || null, memoryId: mem?.memoryId ?? null, revision: mem?.revision ?? null,
        state: !mem ? 'unknown' : (mem.status === 'active' ? 'active' : 'forgotten') });
    }
    if (path === '/v1/admin/stats') {
      if (role !== 'operator') return json(403, err('forbidden'));
      return json(200, { llm: { used: 0, reserved: 0, failed: 0, limit: 2, blocked: 0 }, embeddings: { requests: 0 },
        ingest: { messages: state.counters.ingestMessages, duplicates: state.counters.ingestDuplicates }, writes: state.counters.writes });
    }
    if (path === '/v1/admin/blocklist') {
      if (role !== 'operator') return json(403, err('forbidden'));
      return json(200, { fingerprints: [...state.fingerprints].slice(0, 200), sources: [...state.sources].slice(0, 200), cursor: null });
    }
    if (path === '/v1/reflections/run') {
      if (role !== 'operator') return json(403, err('forbidden'));
      return json(200, { ran: true, scope: body?.scope || null });
    }
    return json(404, err('invalid_payload'));
  }
  handle.state = state; handle.knobs = knobs;
  handle.seedRecall = (sk, items) => seedRecall.set(sk, items);
  handle.messagesFor = sk => state.messages.get(sk) || new Map();
  handle.findMemoryByContent = content => [...state.memories.values()].find(m => m.content === content) || null;
  return handle;
}
