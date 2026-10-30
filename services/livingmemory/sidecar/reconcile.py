"""Authoritative-store reconciliation (CONTRACT §6).

Consumes the shape exported by ``work/src/livingmemory-export.js``
(schemaVersion 1: ``memories``/``sources``/``blocks``/``report``). The legacy
store stays authoritative: this module only *imports* into the sidecar, never
mutates the legacy database. Idempotency, tombstones, session-ownership and
partial-evidence semantics live in :mod:`sidecar.metastore`.
"""

from __future__ import annotations

from typing import Any

from .engine import SidecarRuntime
from .scopes import Scope, identity_fingerprint, legacy_scope_to_key, parse_scope


def _scope_of(entry: dict[str, Any]) -> Scope:
    raw = entry.get("scope")
    if isinstance(raw, dict):
        return parse_scope(raw)
    return _scope_from_label(str(raw or ""))


def _scope_from_label(label: str) -> Scope:
    chat_type, _, ident = label.partition(":")
    if chat_type not in ("group", "private") or not ident:
        raise ValueError(f"unparseable scope label {label!r}")
    return parse_scope({"chatType": chat_type, "groupId": ident if chat_type == "group" else "", "userId": ident if chat_type == "private" else ""})


def _parse_meta(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    import json as _json

    try:
        value = _json.loads(raw or "{}")
    except (ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


async def _load_ledger_message(runtime: SidecarRuntime, message_id: int) -> dict[str, Any] | None:
    """Raw ledger row for evidence persistence (EVIDENCE_ROUNDTRIP)."""
    try:
        cursor = await runtime.conversation.store.connection.execute(
            "SELECT * FROM messages WHERE id = ?", (int(message_id),)
        )
        row = await cursor.fetchone()
    except Exception:
        return None
    return dict(row) if row else None


async def _ledger_provenance(runtime: SidecarRuntime, message_id: int) -> str | None:
    """Provenance recorded in the sidecar's own ingest ledger (trusted source
    of truth, independent of whatever the host payload claims)."""
    try:
        cursor = await runtime.conversation.store.connection.execute(
            "SELECT metadata FROM messages WHERE id = ?", (int(message_id),)
        )
        row = await cursor.fetchone()
    except Exception:
        return None
    if not row:
        return None
    raw = row["metadata"] if hasattr(row, "keys") else row[0]
    if isinstance(raw, str):
        try:
            import json as _json

            raw = _json.loads(raw or "{}")
        except ValueError:
            return None
    if isinstance(raw, dict):
        prov = raw.get("provenance")
        return str(prov) if prov else None
    return None


def _source_blocked(runtime: SidecarRuntime, scope_key: str, source: dict[str, Any]) -> bool:
    for value in (source.get("sourceId"), source.get("externalId")):
        if value is not None and runtime.meta.is_source_blocked(scope_key, str(value)):
            return True
    return False


async def reconcile(
    runtime: SidecarRuntime, payload: dict[str, Any], *, dry_run: bool
) -> dict[str, Any]:
    runtime.require()
    applied = 0
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    unsupported: list[dict[str, Any]] = []
    provider_calls_before = runtime.meta.usage_snapshot()["embeddings"]

    blocks = payload.get("blocks") or {}

    # ── block/tombstone sync first: forgetting precedes import (no resurrection)
    if not dry_run:
        for source in blocks.get("forgottenSources", []) or []:
            try:
                scope_key = (_scope_of(source).session_key if isinstance(source.get("scope"), dict)
                             else legacy_scope_to_key(str(source.get("scope", "*"))) if source.get("scope") else "*")
            except Exception:
                scope_key = "*"
            for name in ("sourceId", "externalId"):
                if source.get(name) is not None:
                    runtime.meta.add_blocked_source(scope_key, str(source[name]), reason="legacy-forgotten-source")
            local_id = runtime.meta.get_dedupe(scope_key, str(source.get("externalId") or ""))
            if local_id is not None:
                runtime.meta.add_blocked_source(scope_key, str(local_id), reason="legacy-forgotten-source")
        for fp in blocks.get("forgottenFingerprints", []) or []:
            runtime.meta.add_blocked_fingerprint(str(fp), reason="legacy-forgotten-fingerprint")
        await runtime.invalidate_automatic_derivatives()
    for item in blocks.get("excluded", []) or []:
        if not dry_run and item.get("fingerprint"):
            runtime.meta.add_blocked_fingerprint(str(item["fingerprint"]), reason=f"legacy-{item.get('status','nonactive')}")
        if not dry_run and item.get("id") is not None:
            runtime.meta.upsert_external(
                external_id=f"lm:legacy:{item.get('id')}",
                memory_id=None,
                scope_key="*",
                kind="tombstone",
                revision=int(item.get("revision") or 0),
                state="forgotten",
                fingerprint=str(item.get("fingerprint") or "") or None,
            )

    for entry in payload.get("entries", []) or []:
        external_id = str(entry.get("externalId") or "")
        op = str(entry.get("op") or "upsert")
        if not external_id:
            failed.append({"externalId": None, "reason": "missing_external_id"})
            continue
        existing = runtime.meta.get_external(external_id)

        # Unsupported semantics are reported, never silently dropped.
        if entry.get("mergeLineage") or entry.get("origin") == "merged-away":
            unsupported.append({"externalId": external_id, "reason": "mergeFamily"})
            continue
        if entry.get("pendingVerification"):
            unsupported.append({"externalId": external_id, "reason": "pendingCandidate"})
            continue

        if op == "forget":
            if existing and existing["state"] == "forgotten":
                skipped.append({"externalId": external_id, "reason": "already_forgotten"})
                continue
            fingerprint = entry.get("tombstoneHash") or entry.get("fingerprint")
            if not dry_run:
                if existing and existing.get("memory_id"):
                    await runtime.invalidate_automatic_derivatives(int(existing["memory_id"]))
                    await runtime.engine.batch_delete_memories([int(existing["memory_id"])])
                runtime.meta.mark_forgotten(external_id, fingerprint)
                if fingerprint:
                    runtime.meta.add_blocked_fingerprint(str(fingerprint), reason=f"tombstone:{external_id}")
            applied += 1
            continue

        # ── upsert / replace ─────────────────────────────────────────────
        try:
            scope = _scope_of(entry)
        except Exception as exc:
            failed.append({"externalId": external_id, "reason": f"invalid_scope: {exc}"})
            continue
        content = str(entry.get("content") or "")
        if not content.strip():
            failed.append({"externalId": external_id, "reason": "empty_content"})
            continue
        revision = int(entry.get("revision") or 1)
        kind = str(entry.get("kind") or "general")
        # Owner of an asserted fact. Accepted spellings are additive aliases
        # of the same concept (host bridge uses `sourceOwner`, explicit writes
        # use `assertedBy`, legacy export uses `subject`); a private scope may
        # still fall back to the peer uid. Missing owner never weakens the
        # authorship check below — it keeps it enforced against empty string.
        subject = str(
            entry.get("subject")
            or entry.get("assertedBy")
            or entry.get("sourceOwner")
            or (scope.user_id if scope.chat_type == "private" else "")
            or ""
        )
        # Import identity uses the SAME scoped formula as explicit writes:
        # userFact → FACT **with its validated owner**, everything else →
        # GENERAL with no subject (group announcements must not become
        # personal facts). Opaque legacy hashes are never reinterpreted.
        identity_kind = "FACT" if kind == "userFact" else "GENERAL"
        identity_subject = subject if kind == "userFact" else ""
        fingerprint = identity_fingerprint(scope.session_key, identity_kind, identity_subject, content)
        legacy_print = str(entry.get("fingerprint") or "")

        # Tombstone / blocklist checks (all writes, imports included):
        # - our scoped identity hashes are matched per scope;
        # - legacy opaque fingerprints are imported verbatim and matched only
        #   by exact value (they already encode kind/subject/scope upstream).
        if existing and existing["state"] == "forgotten":
            if revision <= int(existing["revision"]):
                skipped.append({"externalId": external_id, "reason": "tombstoned"})
                continue
        if runtime.meta.is_fingerprint_blocked(fingerprint, scope.session_key) or (
            legacy_print and runtime.meta.is_fingerprint_blocked(legacy_print)
        ):
            failed.append({"externalId": external_id, "reason": "blocked_fingerprint"})
            continue

        # Idempotent replay (also across restart, keyed by rev+fingerprint).
        if (
            existing
            and existing["state"] == "active"
            and int(existing["revision"]) == revision
            and existing.get("fingerprint") == fingerprint
        ):
            skipped.append({"externalId": external_id, "reason": "idempotent"})
            continue
        if existing and existing["state"] == "active" and revision < int(existing["revision"]):
            skipped.append({"externalId": external_id, "reason": "stale_revision"})
            continue

        # Evidence linkage: session ownership + completeness → unverified.
        source_refs = entry.get("sourceRefs")
        if source_refs is None:
            source_refs = []
            content_complete = False
        else:
            content_complete = bool(entry.get("contentComplete", False))
        ownership_error: str | None = None
        any_partial = False
        # Provenance (FORWARD_ATTRIBUTION): userFact needs at least one
        # directly-authored ground. The payload's provenance field is advisory
        # — when absent, the sidecar's own ingest ledger decides. Unknown
        # provenance (legacy archive rows never ingested here) keeps the
        # existing unverified-import semantics instead of silently asserting.
        prov_grounded = False
        prov_unknown = False
        for source in source_refs:
            try:
                source_scope = _scope_of({"scope": source.get("scope")})
            except Exception:
                ownership_error = "bad_source_scope"
                break
            if source_scope.session_key != scope.session_key:
                ownership_error = "session_ownership"
                break
            if source.get("partial"):
                any_partial = True
            if kind == "userFact" and source.get("authorUserId") and str(source.get("authorUserId")) != subject:
                ownership_error = "author_mismatch"
                break
            if _source_blocked(runtime, scope.session_key, source):
                ownership_error = "blocked_source"
                break
            local = runtime.meta.get_dedupe(
                scope.session_key, str(source.get("externalId") or source.get("sourceId") or ""))
            ledger = await _load_ledger_message(runtime, int(local)) if local is not None else None
            if ledger is None:
                any_partial = True
            elif str(ledger.get("session_id") or "") != scope.session_key:
                ownership_error = "session_ownership"
                break
            elif kind == "userFact" and str(ledger.get("sender_id") or "") != subject:
                ownership_error = "author_mismatch"
                break
            if local is not None and runtime.meta.is_source_blocked(scope.session_key, str(local)):
                ownership_error = "blocked_source"
                break
            if kind == "userFact":
                # Actual ingested provenance outranks any claimed positive
                # attribution in the import. Missing raw evidence can never
                # upgrade a historical record into an asserted personal fact.
                if ledger is not None:
                    prov = ("bot_output" if ledger.get("role") == "assistant" else
                            _parse_meta(ledger.get("metadata")).get("provenance") or "unknown")
                else:
                    claimed = source.get("provenance")
                    prov = claimed if claimed in ("forwarded", "bot_output", "quoted") else "unknown"
                if prov in ("direct", "direct_quote"):
                    prov_grounded = True
                elif prov is None or not str(prov) or str(prov) == "unknown":
                    # MIGRATION_FAILURES item 1: the documented distinction —
                    # unknown/missing provenance imports UNVERIFIED, it is
                    # never proof of forwarding, and it never auto-upgrades.
                    prov_unknown = True
        if not ownership_error and kind == "userFact" and source_refs \
                and not prov_grounded and not prov_unknown:
            # explicit known non-direct evidence (forwarded/quoted/bot-only)
            # cannot establish an asserted personal fact.
            ownership_error = "provenance_insufficient"
        if ownership_error:
            failed.append({"externalId": external_id, "reason": ownership_error})
            continue
        if not source_refs or any_partial or prov_unknown:
            # MIGRATION_FAILURES: unknown/missing provenance forces
            # content_complete=false — imported but unverified, never an
            # asserted personal fact without a direct ground.
            content_complete = False

        if dry_run:
            applied += 1  # counted as "would apply", zero writes/calls
            continue

        # Only a userFact with a verified direct ground and complete evidence
        # is asserted; everything else lands unverified.
        assertion = "asserted" if (kind == "userFact" and prov_grounded and content_complete) else "unverified"
        # Evidence persistence (EVIDENCE_ROUNDTRIP): when refs resolve to
        # same-session ledger rows, capture the ACTUAL source messages with
        # the upstream shape (as the explicit write path already does) so
        # get_memory_source returns real raw evidence. Unresolvable legacy
        # refs stay missing — marked incomplete above, never invented.
        ledger_sources: list[dict[str, Any]] = []
        resolved_ids: list[int] = []
        for source in source_refs:
            # Host source IDs belong to the legacy archive (e.g. src:<hash>),
            # not this ledger's numeric ID namespace. Resolve the stable
            # ingestion identity first, exactly as the ownership check does.
            raw_id = runtime.meta.get_dedupe(
                scope.session_key, str(source.get("externalId") or source.get("sourceId") or ""))
            try:
                local_id = int(raw_id) if raw_id is not None else None
            except (TypeError, ValueError):
                local_id = None
            if local_id is None:
                continue
            row = await _load_ledger_message(runtime, local_id)
            if row is None or str(row.get("session_id") or "") != scope.session_key:
                continue
            resolved_ids.append(local_id)
            ledger_sources.append({
                "id": row["id"],
                "role": row.get("role"),
                "sender_id": row.get("sender_id"),
                "sender_name": row.get("sender_name"),
                "content": row.get("content"),
                "timestamp": row.get("timestamp"),
                "external_id": _parse_meta(row.get("metadata")).get("external_id"),
                "provenance": _parse_meta(row.get("metadata")).get("provenance"),
            })
        memory_metadata = {
            "memory_type": identity_kind,
            "origin": "imported",
            "external_id": external_id,
            "import_kind": kind,
            "asserted_by": identity_subject or None,
            "subject": identity_subject,
            "assertion": assertion,
            "revision": revision,
            "import_batch": payload.get("batchId"),
            "source_message_ids": resolved_ids or [s.get("sourceId") for s in source_refs],
            "legacy_fingerprint": legacy_print or None,
        }
        memory_id = await runtime.add_memory_row(
            scope,
            content=content,
            importance=float(entry.get("importance", 0.7)),
            origin="imported",
            metadata=memory_metadata,
            source_messages=ledger_sources or None,
            preserve_create_time=bool(entry.get("createdAt")),
        )
        runtime.meta.upsert_external(
            external_id=external_id,
            memory_id=memory_id,
            scope_key=scope.session_key,
            kind=kind,
            revision=revision,
            state="active",
            fingerprint=fingerprint,
        )

        if op == "replace":
            for superseded in entry.get("supersedesExternalIds", []) or []:
                old = runtime.meta.get_external(str(superseded))
                if old and old.get("memory_id"):
                    await runtime.engine.batch_delete_memories([int(old["memory_id"])])
                if old:
                    runtime.meta.mark_forgotten(str(superseded), old.get("fingerprint"))
                    if old.get("fingerprint"):
                        # Superseded bodies become scoped block identities: a
                        # later reflection/import cannot resurrect this row in
                        # this scope, without touching identical text owned by
                        # another subject (INTEGRATION_GAPS item 1).
                        runtime.meta.add_blocked_fingerprint(
                            str(old["fingerprint"]),
                            reason=f"superseded-by:{external_id}",
                            scope_key=str(old.get("scope_key") or "*"),
                        )

        applied += 1

    provider_calls = max(0, runtime.meta.usage_snapshot()["embeddings"] - provider_calls_before)
    return {
        "applied": applied,
        "skipped": skipped,
        "failed": failed,
        "unsupported": unsupported,
        "providerCalls": provider_calls,
        "dryRun": dry_run,
        "batchId": payload.get("batchId"),
    }
