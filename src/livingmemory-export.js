// Read-only, consistent export of legacy memory. No provider or QQ calls.
import { DatabaseSync } from 'node:sqlite';

export function exportLivingMemory(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('BEGIN');
    const rows = db.prepare('SELECT * FROM memories ORDER BY created_at,id').all();
    const evidence = db.prepare('SELECT memory_id,source_id FROM memory_evidence ORDER BY memory_id,source_id').all();
    const byMemory = new Map();
    for (const row of evidence) {
      if (!byMemory.has(row.memory_id)) byMemory.set(row.memory_id, new Set());
      byMemory.get(row.memory_id).add(row.source_id);
    }
    const active = rows.filter(row => row.status === 'active');
    const wanted = new Set();
    const memories = active.map(row => {
      const ids = byMemory.get(row.id) || new Set();
      if (row.source_id) ids.add(row.source_id);
      for (const id of ids) wanted.add(id);
      return { id: row.id, kind: row.kind, subject: row.subject, content: row.content,
        scope: row.scope, origin: row.origin, revision: row.revision,
        sourceId: row.source_id, sourceIds: [...ids].sort(), evidence: row.evidence,
        fingerprint: row.fingerprint, createdAt: row.created_at, updatedAt: row.updated_at };
    });
    const lookup = db.prepare('SELECT * FROM memory_messages WHERE id=?');
    const sources = [];
    for (const id of [...wanted].sort()) {
      const row = lookup.get(id);
      if (row) sources.push({ id: row.id, session: row.conversation, externalId: row.external_id,
        uid: row.uid, text: row.text, at: row.at, isSelf: !!row.is_self, partial: !!row.partial });
    }
    const sourceIds = new Set(sources.map(row => row.id));
    const forgottenSources = db.prepare('SELECT source_id,kind,subject,scope FROM memory_forget_sources ORDER BY source_id,kind,subject,scope').all();
    const forgottenFingerprints = db.prepare('SELECT fingerprint FROM memory_forget_fingerprints ORDER BY fingerprint').all().map(row => row.fingerprint);
    // Non-active bodies/revisions are deliberately omitted. Tombstones are kept
    // independently so an importer cannot turn an archived body into a new fact.
    const excluded = rows.filter(row => row.status !== 'active').map(row => ({ id: row.id,
      status: row.status, origin: row.origin, revision: row.revision, fingerprint: row.fingerprint }));
    const missingEvidence = memories.filter(row => !row.sourceIds.length || row.sourceIds.some(id => !sourceIds.has(id)))
      .map(row => row.id);
    const partialEvidence = memories.filter(row => row.sourceIds.some(id => sources.find(source => source.id === id)?.partial))
      .map(row => row.id);
    db.exec('COMMIT');
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), memories, sources,
      blocks: { forgottenSources, forgottenFingerprints, excluded },
      report: { active: memories.length, sources: sources.length,
        statuses: Object.fromEntries([...new Set(rows.map(row => row.status))].map(status => [status, rows.filter(row => row.status === status).length])),
        missingEvidence, partialEvidence,
        unsupportedSemantics: ['Cross-session sharing requires the bridge policy; origin is retained and is not an access grant.',
          'Legacy revisions and merge lineage remain in the original database; non-active bodies are not imported.',
          'No raw history backfill is performed; only evidence for active entries is exported.'] } };
  } finally { db.close(); }
}
