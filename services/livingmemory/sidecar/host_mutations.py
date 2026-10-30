"""Host-authority mutations and read guards shared by the operator UI.

FINAL_SLICE rule: the dashboard must not bypass the HTTP contract semantics
(revisions, tombstones, scoped identity blocks, source invalidation). Read
paths additionally filter forgotten identities/sources so a legacy tombstone
can never show its body again in the UI or be restored by an edit.
"""

from __future__ import annotations

import json
import time
from typing import Any

from .scopes import identity_fingerprint


def _meta_of(record: dict[str, Any]) -> dict[str, Any]:
    meta = record.get("metadata")
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except (TypeError, ValueError):
            meta = {}
    return meta if isinstance(meta, dict) else {}


def record_identity(runtime, record: dict[str, Any]) -> str | None:
    """Scoped identity fingerprint of an engine record, computed with the
    SAME derivation as the reconcile/HTTP write paths (kind + subject + text)
    so a forgotten userFact cannot re-enter the UI — or be laundered into a
    different owner — by an edit. Records without session metadata predate
    the sidecar and stay opaque."""
    meta = _meta_of(record)
    session = str(meta.get("session_id") or "")
    if not session:
        return None
    kind = str(meta.get("memory_type") or meta.get("origin") or "GENERAL")
    if kind == "REFLECTION" or meta.get("origin") == "reflection":
        fp_kind, subject = "REFLECTION", ""
    else:
        # Same formula as asserted_identity(): any stored owner — even on a
        # legacy GENERAL-typed row — means FACT semantics, so edit/forget
        # fingerprints match what the write path recorded (UI_AUTHORITY 2).
        subject = str(meta.get("asserted_by") or meta.get("subject") or "")
        fp_kind = "FACT" if subject else "GENERAL"
    return identity_fingerprint(session, fp_kind, subject, str(record.get("text") or ""))


_PROTECTED_IMPORT_NOTE = (
    "迁移导入记忆在权威切换前为只读：原文由旧版授权编辑器维护，reconcile 会重新同步；"
    "此处编辑/遗忘会造成双写分叉。"
)


def _authority_readonly(meta: dict[str, Any]) -> str | None:
    """UI_AUTHORITY item 3: before the authority cutover, entries imported by
    reconcile remain owned by the legacy host store (Node MemoryStore was not
    updated). The dashboard must not edit, forget, resummarize or merge them."""
    if str(meta.get("origin") or "") == "imported":
        return _PROTECTED_IMPORT_NOTE
    return None


def record_blocked(runtime, record: dict[str, Any]) -> bool:
    meta = _meta_of(record)
    session = str(meta.get("session_id") or "")
    fp = record_identity(runtime, record)
    if fp and session and runtime.meta.is_fingerprint_blocked(fp, session):
        return True
    legacy = str(meta.get("legacy_fingerprint") or "")
    if legacy and runtime.meta.is_fingerprint_blocked(legacy):
        return True
    ext = runtime.meta.find_external_by_memory(int(record.get("id") or 0))
    return bool(ext and ext["state"] == "forgotten")


class GuardedEngine:
    """Attribute proxy over the real MemoryEngine that enforces tombstone
    semantics on every read the dashboard performs. Writes are NOT routed
    through here (host mutation functions own those paths)."""

    def __init__(self, runtime) -> None:
        self._runtime = runtime
        self._engine = runtime.engine

    def __getattr__(self, name):
        return getattr(self._engine, name)

    async def search_memories(self, *args, **kwargs):
        results = await self._engine.search_memories(*args, **kwargs)
        kept = []
        for item in results:
            meta = getattr(item, "metadata", None) or {}
            record = {"id": getattr(item, "doc_id", 0), "text": getattr(item, "content", ""), "metadata": meta}
            if not self._blocked_item(record):
                kept.append(item)
        return kept

    async def get_memory_record(self, memory_id: int):
        record = await self._engine.get_memory_record(memory_id)
        if not record or self._blocked_item(record):
            return None
        return record

    async def list_memories_page(self, *args, **kwargs):
        page = await self._engine.list_memories_page(*args, **kwargs)
        if isinstance(page, dict):
            rows = page.get("memories") or page.get("items") or []
            kept = [row for row in rows if not isinstance(row, dict) or not self._blocked_item(row)]
            for key in ("memories", "items"):
                if key in page:
                    page[key] = kept
            if "total" in page:
                page["total"] = max(0, int(page.get("total", 0)) - (len(rows) - len(kept)))
        return page

    async def get_memory_source(self, memory_id: int):
        sources = await self._engine.get_memory_source(memory_id)
        session_hint = ""
        record = await self._engine.get_memory_record(memory_id)
        if record:
            session_hint = str(_meta_of(record).get("session_id") or "")
        for source in sources:
            blocked = False
            for key in (source.get("external_id"), source.get("id")):
                if key is not None and session_hint and self._runtime.meta.is_source_blocked(session_hint, str(key)):
                    blocked = True
            if blocked:
                source["content"] = ""
                source["blocked"] = True
        return sources

    def _blocked_item(self, record: dict[str, Any]) -> bool:
        try:
            return record_blocked(self._runtime, record)
        except Exception:
            return False


async def ui_update_memory(runtime, utils, payload: dict[str, Any]) -> dict[str, Any]:
    """Host-authority version of the upstream memories/update route.

    Content-class edits go through engine.replace_memory and register the
    replacement on the host ledger (old identity blocked in-scope, external
    row remapped, revision bumped) — identical semantics to CONTRACT §5 PATCH.
    """
    try:
        memory_id = int(payload.get("memory_id"))
    except (TypeError, ValueError):
        return utils.error("memory_id 必须是整数")
    field = str(payload.get("field", "")).strip()
    value = payload.get("value")
    reason = str(payload.get("reason", "")).strip()
    if not field or value is None:
        return utils.error("需要指定 field 和 value")

    record = await runtime.engine.get_memory_record(memory_id)
    if not record:
        return utils.error("记忆不存在（或已被遗忘）")
    meta = _meta_of(record)
    readonly = _authority_readonly(meta)
    if readonly:
        return utils.error(readonly)
    session_key = str(meta.get("session_id") or "")
    if field in {"content", "topics", "key_facts", "structured"}:
        structured = value if field == "structured" else {field: value}
        if field == "structured" and not isinstance(structured, dict):
            return utils.error("structured value 必须是对象")
        new_content = str(structured.get("content", record.get("text", ""))).strip()
        if not new_content:
            return utils.error("记忆内容不能为空")
        importance = (
            float(structured["importance"])
            if isinstance(structured, dict) and "importance" in structured
            else float(meta.get("importance") or 0.5)
        )
        replacement = dict(meta)
        # Provenance is host-owned: an edit can never move a memory to another
        # session or re-attribute who asserted a fact (Codex real-HTTP check:
        # forwarded text must not become the forwarder's own preference).
        for protected in ("asserted_by", "subject", "session_id", "persona_id",
                          "user_id", "chat_type", "group_id", "source_message_ids",
                          "legacy_fingerprint"):
            structured.pop(protected, None)
        replacement.update(structured)
        replacement.update({k: meta.get(k) for k in
                            ("asserted_by", "subject", "session_id", "persona_id",
                             "user_id", "chat_type", "group_id") if k in meta})
        ts = time.time()
        if new_content != str(record.get("text") or ""):
            replacement["update_history"] = utils.append_update_history(
                meta, field="content", old_value=str(record.get("text", ""))[:100],
                new_value=new_content[:100], reason=reason or "ui-edit", timestamp=ts)
            replacement["previous_content"] = str(record.get("text", ""))[:100]
        replacement["updated_at"] = ts
        if reason:
            replacement["update_reason"] = reason

        new_fp = None
        if session_key:
            new_fp = record_identity(runtime, {"id": 0, "text": new_content,
                                               "metadata": replacement})
            if new_fp and runtime.meta.is_fingerprint_blocked(new_fp, session_key):
                return utils.error("新内容与已遗忘的身份指纹冲突（禁止复活）")
        try:
            await runtime.invalidate_automatic_derivatives(memory_id)
            new_id = await runtime.engine.replace_memory(
                memory_id, content=new_content, importance=importance, metadata=replacement)
        except Exception as exc:
            return utils.error(f"重建记忆失败: {exc}")
        # Host ledger: retire the old identity and remap external bookkeeping.
        old_fp = record_identity(runtime, record)
        external = runtime.meta.find_external_by_memory(memory_id)
        external_id = (external or {}).get("external_id") or f"lm:{memory_id}"
        kind = (external or {}).get("kind") or "explicit"
        revision = int((external or {}).get("revision") or meta.get("revision") or 1) + 1
        if session_key and old_fp:
            runtime.meta.add_blocked_fingerprint(
                old_fp, reason=f"ui-edit:{external_id}", scope_key=session_key)
        resolved_fp = new_fp or (record_identity(runtime, {
            "id": new_id, "text": new_content, "metadata": replacement}) or "")
        # The external identity continues on the new memory row (same
        # semantics as CONTRACT §5 PATCH remap).
        runtime.meta.upsert_external(external_id, int(new_id), session_key or "*", kind,
                                     revision, "active", resolved_fp)
        return utils.ok({"message": f"记忆已更新（ID: {memory_id} → {new_id}）",
                         "old_memory_id": memory_id, "new_memory_id": int(new_id),
                         "hostRemapped": True,
                         "field": field, "revision": revision})

    updates: dict[str, Any] = {}
    if field == "importance":
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return utils.error("importance 必须是数字")
        updates["importance"] = parsed / 10.0 if parsed > 1.0 else parsed
    elif field == "type":
        if not str(value).strip():
            return utils.error("类型不能为空")
        target_type = str(value).strip()
        # Provenance boundary (FORWARD_ATTRIBUTION): the UI may never launder a
        # GENERAL/observation record into an asserted personal fact — FACT may
        # only be established through a source-validated write path.
        if target_type == "FACT" and str(meta.get("memory_type") or "") != "FACT":
            return utils.error("不能经 UI 将记录提升为 userFact：asserted 个人事实只能由带直接来源证据的写入路径建立")
        updates["metadata"] = {**meta, "memory_type": target_type}
    elif field == "status":
        status_value = str(value).strip()
        if status_value not in {"active", "archived", "deleted"}:
            return utils.error("状态必须是 active、archived 或 deleted")
        if status_value == "deleted":
            result = await ui_batch_delete(runtime, utils, {"memory_ids": [memory_id]})
            return result
        if status_value == "archived":
            archived = await runtime.engine.archive_memories([memory_id])
            return utils.ok({"message": "记忆已归档", "memory_id": memory_id}) if archived == 1 else utils.error("归档失败")
        if not await runtime.engine.restore_memory(memory_id):
            return utils.error("恢复失败")
        return utils.ok({"message": "记忆已恢复", "memory_id": memory_id})
    else:
        return utils.error(f"不支持编辑字段: {field}")

    updates.setdefault("metadata", dict(meta))
    updates["metadata"]["update_history"] = utils.append_update_history(
        meta, field=field, old_value=meta.get(field), new_value=value,
        reason=reason or "ui-edit", timestamp=time.time())
    updates["metadata"]["updated_at"] = time.time()
    if not await runtime.engine.update_memory(memory_id, updates):
        return utils.error("更新失败")
    external = runtime.meta.find_external_by_memory(memory_id)
    if external:
        runtime.meta.bump_revision(external["external_id"])
    return utils.ok({"message": f"记忆 {memory_id} 的 {field} 已更新",
                     "memory_id": memory_id, "field": field})


async def ui_batch_delete(runtime, utils, payload: dict[str, Any]) -> dict[str, Any]:
    """Host-authority forget (tombstone semantics = CONTRACT §5 DELETE)."""
    memory_ids = payload.get("memory_ids", [])
    if not isinstance(memory_ids, list) or not memory_ids:
        return utils.error("需要提供记忆 ID 列表")
    deleted = 0
    failed_ids: list[Any] = []
    for raw_id in memory_ids:
        try:
            memory_id = int(raw_id)
        except (TypeError, ValueError):
            failed_ids.append(raw_id)
            continue
        record = await runtime.engine.get_memory_record(memory_id)
        if not record:
            failed_ids.append(raw_id)
            continue
        meta = _meta_of(record)
        readonly = _authority_readonly(meta)
        if readonly:
            failed_ids.append(raw_id)
            continue
        session_key = str(meta.get("session_id") or "")
        fp = record_identity(runtime, record)
        external = runtime.meta.find_external_by_memory(memory_id)
        external_id = (external or {}).get("external_id") or f"lm:{memory_id}"
        if session_key and fp:
            runtime.meta.add_blocked_fingerprint(fp, reason=f"ui-delete:{external_id}",
                                                 scope_key=session_key)
        for source in await runtime.engine.get_memory_source(memory_id):
            for source_key in (source.get("external_id"), source.get("id")):
                if source_key is not None and session_key:
                    runtime.meta.add_blocked_source(session_key, str(source_key), reason="memory_deleted")
        await runtime.invalidate_automatic_derivatives(memory_id)
        await runtime.engine.batch_delete_memories([memory_id])
        if external:
            runtime.meta.mark_forgotten(external_id, fp or "")
        else:
            runtime.meta.upsert_external(external_id, None, session_key or "*", "tombstone",
                                         int((meta.get("revision") or 1)), "forgotten", fp or "")
        deleted += 1
    return utils.ok({"deleted_count": deleted, "failed_count": len(failed_ids),
                     "total": len(memory_ids), "failed_ids": failed_ids})


async def snapshot_external(runtime) -> dict[int, dict[str, Any]]:
    """Book external rows before a native upstream mutation (consolidation)."""
    out: dict[int, dict[str, Any]] = {}
    rows = runtime.meta.list_active_externals()
    for row in rows:
        if row.get("memory_id") is not None:
            out[int(row["memory_id"])] = row
    return out


async def settle_external_guard(runtime, before: dict[int, dict[str, Any]], reason: str) -> int:
    """After an upstream merge/cleanup: any legacy-external memory that the
    engine removed is tombstoned in the host ledger (never resurrectable)."""
    settled = 0
    for memory_id, row in before.items():
        record = await runtime.engine.get_memory_record(memory_id)
        if record is not None:
            continue
        current = runtime.meta.get_external(row["external_id"])
        if not current or current["state"] != "active" or int(current["memory_id"] or 0) != memory_id:
            continue
        fingerprint = row.get("fingerprint") or ""
        runtime.meta.mark_forgotten(row["external_id"], fingerprint)
        scope_key = row.get("scope_key") or "*"
        if fingerprint and scope_key != "*":
            runtime.meta.add_blocked_fingerprint(fingerprint, reason=f"{reason}:{row['external_id']}",
                                                 scope_key=scope_key)
        settled += 1
    return settled
