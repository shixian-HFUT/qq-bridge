"""FastAPI application: HTTP surface of CONTRACT.md v1.

Thin layer only; all durable state lives in :mod:`sidecar.metastore` and the
vendored engine databases. Error envelope: ``{"error": {"code", "message", …}}``
with stable machine codes (§2). Auth roles: ``bridge`` (session-scoped data
plane after host-side QQ authorization) and ``operator`` (adds admin plane).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import CONTRACT_VERSION, ENGINE_VERSION
from .config import SidecarConfig, load_config
from .engine import EngineUnavailable, SidecarRuntime
from .reflection import run_reflection
from .reconcile import reconcile
from .scopes import Scope, ScopeError, asserted_identity, identity_fingerprint, parse_scope, subject_of
from .providers import BudgetBlockedError


def envelope(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, **extra}})


class HttpError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra


def scope_from_label(label: str) -> Scope:
    text = (label or "").strip()
    if text.startswith("{"):
        # Accept a JSON-encoded scope object in query parameters too.
        return parse_scope(json.loads(text))
    chat_type, _, ident = text.partition(":")
    if chat_type == "group":
        return parse_scope({"chatType": "group", "groupId": ident})
    if chat_type == "private":
        return parse_scope({"chatType": "private", "userId": ident})
    raise ScopeError("scope label must look like group:12345 or private:12345")


def _dashboard_feature(config, runtime) -> str:
    try:
        from .page_bridge import dashboard_root

        return "native-ui" if dashboard_root().is_dir() else "api-only"
    except Exception:
        return "api-only"


def build_app(config: SidecarConfig, runtime: SidecarRuntime) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        try:
            if runtime.state == "starting":
                try:
                    await runtime.boot()
                except Exception:
                    pass  # health shows failed; endpoints answer 503
            if config.mode == "production":
                task = asyncio.create_task(_auto_reflect_loop(runtime))
                runtime._tasks.add(task)
                runtime.reflect_task = task
                runtime.decay_task = getattr(runtime, "decay_task", None)
            if runtime.state == "ready":
                # Page API + operator UI mount only after the engine booted —
                # the facade wraps runtime.engine, which boot() creates.
                try:
                    from .page_bridge import install_page_layer

                    install_page_layer(_app, config, runtime)
                    runtime.ui_installed = True
                except Exception as exc:
                    runtime.ui_installed = False
                    runtime.ui_error = type(exc).__name__  # sanitized: class name
            yield
        finally:
            # HTTP_FAILURES item 2: cleanup must run even when a request
            # raised or the context is cancelled, otherwise SQLite handles
            # stay open and Windows temp-dir teardown fails.
            await runtime.close()

    app = FastAPI(title="livingmemory-sidecar", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.runtime = runtime
    app.state.config = config

    @app.middleware("http")
    async def guards(request: Request, call_next: Callable[[], Awaitable[Any]]):
        # Declared-size guard here; actual byte cap enforced in json_body()
        # (reading the stream in middleware would starve the route handler).
        declared = request.headers.get("content-length")
        if declared and int(declared) > config.body_max_bytes:
            return envelope(413, "payload_too_large", f"body exceeds {config.body_max_bytes} bytes")
        return await call_next(request)

    # ── auth ─────────────────────────────────────────────────────────────

    def authenticate(request: Request, need_operator: bool = False) -> str | None:
        header = request.headers.get("authorization", "")
        if not header.lower().startswith("bearer "):
            raise HttpError(401, "unauthorized", "bearer credential required")
        provided = header[7:].strip().encode()
        roles = {"bridge": config.bridge_creds, "operator": config.operator_creds}
        matched = [name for name, value in roles.items() if value and hmac.compare_digest(provided, value.encode())]
        if not matched:
            raise HttpError(401, "unauthorized", "invalid credential")
        if need_operator and "operator" not in matched:
            raise HttpError(403, "forbidden", "operator role required")
        return "operator" if "operator" in matched else "bridge"

    async def json_body(request: Request) -> dict[str, Any]:
        raw = await request.body()
        if len(raw) > config.body_max_bytes:
            raise HttpError(413, "payload_too_large", f"body exceeds {config.body_max_bytes} bytes")
        if not raw:
            return {}
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HttpError(400, "invalid_json", str(exc)) from exc
        if not isinstance(parsed, dict):
            raise HttpError(400, "invalid_json", "body must be a JSON object")
        return parsed

    def require_engine() -> None:
        if runtime.state != "ready":
            raise HttpError(503, "engine_not_ready", runtime.error or "engine unavailable")

    # ── public ───────────────────────────────────────────────────────────

    @app.get("/v1/health")
    async def health() -> JSONResponse:
        return JSONResponse(
            {
                "status": "ready" if runtime.state == "ready" else runtime.state,
                "mode": config.mode,
                "contractVersion": CONTRACT_VERSION,
                "engineVersion": ENGINE_VERSION,
            }
        )

    def _task_live(task) -> str:
        if task is None:
            return "disabled"
        if task.done():
            return "stopped"
        return "running"

    @app.get("/v1/capabilities")
    async def capabilities(request: Request) -> JSONResponse:
        authenticate(request)
        return JSONResponse(
            {
                "contractVersion": CONTRACT_VERSION,
                "engineVersion": ENGINE_VERSION,
                "engine": "astrbot_plugin_livingmemory (vendored, unmodified)",
                "mode": config.mode,
                "features": {
                    "stores": ["sqlite-documents", "fts5-bm25", "faiss-vectors", "graph", "atoms"],
                    "dualRouteFusion": True,
                    "decayScheduler": True,
                    "atomMaintenance": True,
                    "consolidation": "manual-only",
                    "autoCleanup": False,
                    "blocklistAllWrites": True,
                    "forgetIsolation": "scoped-identity",
                    "revisionCas": True,
                    "idempotencyAcrossRestart": True,
                    "reflectionBudgetBoundary": "per-request-atomic",
                    "operatorDashboard": _dashboard_feature(config, runtime),
                    "provenanceEnforced": True,
                    "identityInRecall": True,
                    "activeAgenticSearch": bool(getattr(config, "active_recall_enabled", True)),
                    "backupsCreate": True,
                    "sharedIdentity": bool(config.shared_identity.get("enabled", False)),
                },
                "limits": {
                    "activeRecallKMax": int(config.limits.get("kMax", 12)),
                    "activeRecallTimeoutSeconds": float(config.limits.get("activeRecallTimeoutSeconds", 20)),
                    "activeRecallExcludeIdsMax": 50,
                    "recallQueryMaxChars": int(config.limits.get("recallQueryMaxChars", 2000)),
                },
                "liveness": {
                    "decayTask": _task_live(getattr(runtime, "decay_task", None)),
                    "autoReflectionTask": _task_live(getattr(runtime, "reflect_task", None)),
                    "autoReflectionNote": "production mode only; manual POST /v1/reflections/run always available",
                    "operatorUi": {
                        "installed": bool(getattr(runtime, "ui_installed", False)),
                        "error": getattr(runtime, "ui_error", None),
                    },
                },
                "frozenSections": {"scope": "§4 normalization", "errorCodes": "§2"},
            }
        )

    @app.post("/v1/ingest")
    async def ingest(request: Request) -> JSONResponse:
        authenticate(request)
        require_engine()
        body = await json_body(request)
        try:
            scope = parse_scope(body.get("scope"))
        except ScopeError as exc:
            return envelope(400, "invalid_scope", str(exc))
        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            return envelope(400, "invalid_input", "text is required")
        if len(text) > config.text_max_chars:
            return envelope(413, "payload_too_large", f"text exceeds {config.text_max_chars} chars")
        if body.get("role") not in ("user", "assistant"):
            return envelope(400, "invalid_input", "role must be user|assistant")
        result = await runtime.ingest(
            scope,
            {
                "messageId": body.get("messageId"),
                "authorUserId": body.get("authorUserId"),
                "authorName": body.get("authorName"),
                "role": body.get("role"),
                "text": text,
                "timestampMs": body.get("timestampMs"),
                "provenance": body.get("provenance"),
            },
        )
        runtime.meta.set_kv(f"ingest:last:{scope.session_key}", str(time.time()))
        if result.get("duplicate"):
            runtime.meta.set_kv("ingest:duplicates", str(int(runtime.meta.get_kv("ingest:duplicates") or 0) + 1))
        return JSONResponse(result)

    @app.post("/v1/recall")
    async def recall(request: Request) -> JSONResponse:
        authenticate(request)
        require_engine()
        body = await json_body(request)
        try:
            scope = parse_scope(body.get("scope"))
        except ScopeError as exc:
            return envelope(400, "invalid_scope", str(exc))
        query = str(body.get("query") or "")
        if not query.strip():
            return envelope(400, "invalid_input", "query is required")
        if len(query) > int(config.limits.get("recallQueryMaxChars", 2000)):
            return envelope(413, "payload_too_large", "query too long")
        size = int(body.get("k") or 6)
        if not 1 <= size <= int(config.limits.get("kMax", 12)):
            return envelope(400, "invalid_input", f"k must be 1..{config.limits.get('kMax')}")
        cap = min(int(body.get("maxChars") or config.recall_max_chars), config.recall_max_chars)
        try:
            outcome = await runtime.recall(scope, query, size, cap)
        except BudgetBlockedError:
            return envelope(429, "budget_exceeded", "embedding budget exhausted")
        return JSONResponse(
            {
                "results": outcome["results"],
                "injectionBlock": outcome["injectionBlock"],
                "truncated": outcome["truncated"],
                "meta": outcome["meta"],
                "tookMs": outcome["tookMs"],
            }
        )

    # ── memory CRUD (bridge role allowed; §5) ────────────────────────────

    @app.post("/v1/recall/active")
    async def recall_active(request: Request) -> JSONResponse:
        """Bounded agentic recall around the real upstream retrieval loop."""
        authenticate(request)
        require_engine()
        if not bool(getattr(config, "active_recall_enabled", True)):
            return envelope(503, "unavailable", "active recall disabled")
        body = await json_body(request)
        try:
            scope = parse_scope(body.get("scope"))
        except ScopeError as exc:
            return envelope(400, "invalid_scope", str(exc))
        query = str(body.get("query") or "").strip()
        if not query:
            return envelope(400, "invalid_input", "query is required")
        if len(query) > int(config.limits.get("recallQueryMaxChars", 2000)):
            return envelope(413, "payload_too_large", "query too long")
        size = int(body.get("k") or 6)
        if not 1 <= size <= int(config.limits.get("kMax", 12)):
            return envelope(400, "invalid_input", f"k must be 1..{config.limits.get('kMax')}")
        target = str(body.get("target") or "conversation")
        if target not in ("conversation", "current_speaker"):
            return envelope(400, "invalid_input", "target must be conversation|current_speaker")
        identity_key = body.get("identityKey")
        identity_key = str(identity_key) if identity_key not in (None, "") else None
        if identity_key is not None and not identity_key.isdigit():
            return envelope(400, "invalid_input", "identityKey must be numeric (stable QQ id)")
        if target == "current_speaker":
            if scope.chat_type == "private":
                identity_key = identity_key or scope.user_id
            if not identity_key:
                return envelope(400, "invalid_input",
                                "current_speaker target requires identityKey bound to the host turn speaker")
            if identity_key != scope.user_id:
                # Bind people-targets to the trusted session: the identity must
                # be an actual participant of this session, never a stranger id.
                cursor = await runtime.conversation.store.connection.execute(
                    "SELECT 1 FROM messages WHERE session_id = ? AND sender_id = ? LIMIT 1",
                    (scope.session_key, identity_key),
                )
                if await cursor.fetchone() is None:
                    return envelope(403, "scope_crossing", "identityKey is not a participant of this session")
        exclude_raw = body.get("excludeIds") or []
        if not isinstance(exclude_raw, list) or len(exclude_raw) > 50:
            return envelope(400, "invalid_input", "excludeIds must be a list of at most 50 memory ids")
        try:
            exclude_ids = [int(x) for x in exclude_raw]
        except (TypeError, ValueError):
            return envelope(400, "invalid_input", "excludeIds must be integers")
        cursor_token = body.get("cursor")
        if cursor_token is not None and (not isinstance(cursor_token, str) or len(cursor_token) > 256):
            return envelope(400, "invalid_input", "cursor must be a short string")
        start_ts = float(body["startTsMs"]) / 1000.0 if body.get("startTsMs") else None
        end_ts = float(body["endTsMs"]) / 1000.0 if body.get("endTsMs") else None
        cap = min(int(body.get("maxChars") or config.recall_max_chars), config.recall_max_chars)
        timeout = float(config.limits.get("activeRecallTimeoutSeconds", 20))
        try:
            outcome = await runtime.search_active(
                scope, query, size, target, identity_key=identity_key,
                start_ts=start_ts, end_ts=end_ts, exclude_ids=exclude_ids or None,
                cursor=cursor_token, max_chars=cap, timeout_seconds=timeout)
        except asyncio.TimeoutError:
            return envelope(503, "provider_unavailable", "active recall exceeded its deadline")
        except BudgetBlockedError:
            return envelope(429, "budget_exceeded", "embedding budget exhausted")
        return JSONResponse(outcome)

    async def load_message(message_id: int) -> dict[str, Any] | None:
        cursor = await runtime.conversation.store.connection.execute(
            "SELECT id, session_id, role, sender_id, sender_name, content, metadata, timestamp"
            " FROM messages WHERE id = ?",
            (int(message_id),),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    def parse_meta(raw: Any) -> dict[str, Any]:
        if isinstance(raw, dict):
            return raw
        try:
            value = json.loads(raw or "{}")
        except (json.JSONDecodeError, TypeError):
            return {}
        return value if isinstance(value, dict) else {}

    @app.post("/v1/memories")
    async def memorize(request: Request) -> JSONResponse:
        authenticate(request)
        require_engine()
        body = await json_body(request)
        try:
            scope = parse_scope(body.get("scope"))
        except ScopeError as exc:
            return envelope(400, "invalid_scope", str(exc))
        content = str(body.get("content") or "").strip()
        if not content:
            return envelope(400, "invalid_input", "content is required")
        if len(content) > config.text_max_chars:
            return envelope(413, "payload_too_large", "content too long")
        asserted_by = body.get("assertedBy")
        asserted_by = str(asserted_by) if asserted_by is not None else None
        # ONE identity derivation for the whole service (asserted_identity):
        # any owned preference — private or group — is FACT with its subject;
        # un-asserted group content is GENERAL. The stored memory_type matches
        # the fingerprint kind so replay/UI/forget paths agree everywhere.
        subject = asserted_by or (scope.user_id or "" if scope.chat_type == "private" else "")
        default_kind = "FACT" if subject else "GENERAL"
        fingerprint = identity_fingerprint(scope.session_key, default_kind, subject, content)
        if runtime.meta.is_fingerprint_blocked(fingerprint, scope.session_key):
            return envelope(409, "blocked_source", "content matches a forgotten identity")

        source_ids = [int(x) for x in (body.get("sourceMessageIds") or [])]
        importance = float(body.get("importance", 0.8))
        sources: list[dict[str, Any]] = []
        for message_id in source_ids:
            row = await load_message(message_id)
            if row is None:
                return envelope(404, "not_found", f"source message {message_id} not found")
            if row["session_id"] != scope.session_key:
                return envelope(403, "scope_crossing", "source message belongs to another session")
            meta = parse_meta(row["metadata"])
            if meta.get("provenance") == "bot_output" or row["role"] == "assistant":
                return envelope(409, "invalid_input", "bot output cannot ground an explicit memory")
            if runtime.source_blocked(scope, _RowProxy(row)):
                return envelope(409, "blocked_source", f"source message {message_id} is forgotten")
            sources.append(
                {
                    "id": row["id"],
                    "role": row["role"],
                    "sender_id": row["sender_id"],
                    "sender_name": row["sender_name"],
                    "content": row["content"],
                    "timestamp": row["timestamp"],
                    "external_id": meta.get("external_id"),
                    "provenance": meta.get("provenance") or "direct_quote",
                }
            )
        if asserted_by is not None:
            asserted_by = str(asserted_by)
            if scope.chat_type == "private" and asserted_by != scope.user_id:
                return envelope(403, "scope_crossing", "assertedBy must be the private peer")
            if sources and str(sources[0]["sender_id"]) != asserted_by:
                return envelope(409, "invalid_input", "assertedBy must match a direct source speaker")
        # Provenance gate (FORWARD_ATTRIBUTION): an asserted personal fact
        # must be grounded in at least one directly-authored source message.
        # Forwarded/quoted/admin-observed text may still be stored as a
        # non-asserted observation, never as the sender's own preference.
        asserting_actor = asserted_by or (scope.user_id if scope.chat_type == "private" else None)
        if asserting_actor is not None and sources:
            grounded = any(
                s.get("provenance") in ("direct", "direct_quote") and str(s["sender_id"]) == str(asserting_actor)
                for s in sources
            )
            if not grounded:
                return envelope(
                    409, "provenance_insufficient",
                    "asserted personal fact requires at least one directly-authored source message; "
                    "forwarded/quoted text cannot establish the sender's own preference",
                )
        external_id = str(
            body.get("externalId")
            or f"explicit:{scope.session_key}:{hashlib.sha256(content.encode()).hexdigest()[:12]}"
        )
        existing = runtime.meta.get_external(external_id)
        if existing and existing["state"] == "forgotten":
            return envelope(409, "tombstoned", f"{external_id} is tombstoned; use a new explicitId")
        if existing and existing["state"] == "active" and existing.get("fingerprint") == fingerprint:
            return JSONResponse({"memoryId": existing["memory_id"], "externalId": external_id, "revision": existing["revision"], "duplicate": True})

        memory_id = await runtime.add_memory_row(
            scope,
            content=content,
            importance=importance,
            origin="explicit",
            metadata={
                "memory_type": default_kind,
                "origin": "explicit",
                "external_id": external_id,
                "asserted_by": asserted_by,
                "subject": subject,
                "assertion": "asserted",
                "revision": 1,
                "source_message_ids": source_ids,
            },
            source_messages=sources,
        )
        runtime.meta.upsert_external(
            external_id=external_id,
            memory_id=memory_id,
            scope_key=scope.session_key,
            kind="explicit",
            revision=1,
            state="active",
            fingerprint=fingerprint,
        )
        return JSONResponse({"memoryId": memory_id, "externalId": external_id, "revision": 1}, status_code=201)

    async def guarded_detail(memory_id: int, scope: Scope) -> tuple[dict[str, Any], dict[str, Any]]:
        record = await runtime.engine.get_memory_record(memory_id)
        if record is None:
            raise HttpError(404, "not_found", "memory not found")
        meta = parse_meta(record.get("metadata"))
        if meta.get("session_id") not in (None, scope.session_key):
            raise HttpError(403, "scope_crossing", "memory belongs to another scope")
        return record, meta

    def revision_of(meta: dict[str, Any], memory_id: int) -> int:
        ext = runtime.meta.find_external_by_memory(memory_id)
        return int(ext["revision"]) if ext else int(meta.get("revision") or 1)

    @app.get("/v1/memories/{memory_id}")
    async def memory_detail(request: Request, memory_id: int, scope: str) -> JSONResponse:
        authenticate(request)
        require_engine()
        try:
            wanted = scope_from_label(scope)
        except ScopeError as exc:
            return envelope(400, "invalid_scope", str(exc))
        record, meta = await guarded_detail(memory_id, wanted)
        return JSONResponse(
            {
                "memoryId": int(record["id"]),
                "content": record["text"],
                "metadata": meta,
                "revision": revision_of(meta, memory_id),
                "createdAt": record.get("created_at"),
                "updatedAt": record.get("updated_at"),
            }
        )

    @app.patch("/v1/memories/{memory_id}")
    async def memory_patch(request: Request, memory_id: int) -> JSONResponse:
        authenticate(request)
        require_engine()
        body = await json_body(request)
        try:
            scope = parse_scope(body.get("scope"))
        except ScopeError as exc:
            return envelope(400, "invalid_scope", str(exc))
        expected = body.get("expectedRevision")
        record, meta = await guarded_detail(memory_id, scope)
        current = revision_of(meta, memory_id)
        if expected is None or int(expected) != current:
            return envelope(409, "revision_conflict", f"current revision is {current}", currentRevision=current)
        new_content = body.get("content")
        new_importance = body.get("importance")
        if new_content is None and new_importance is None:
            return envelope(400, "invalid_input", "content or importance required")
        external = runtime.meta.find_external_by_memory(memory_id)
        external_id = (external or {}).get("external_id") or f"lm:{memory_id}"
        kind, subject = asserted_identity(meta, scope)

        def ident_of(text: str) -> str:
            return identity_fingerprint(scope.session_key, kind, subject, text)

        if new_content is not None:
            new_content = str(new_content)
            if runtime.meta.is_fingerprint_blocked(ident_of(new_content), scope.session_key):
                return envelope(409, "blocked_source", "content matches a forgotten identity")
        updated_meta = {**meta, "revision": current + 1}
        final_id = memory_id
        if new_content is not None:
            # Content changes create a new document id (upstream replace path).
            async with runtime.write_barrier:
                await runtime.invalidate_automatic_derivatives(memory_id)
                final_id = await runtime.engine.replace_memory(
                    memory_id,
                    content=new_content,
                    metadata=updated_meta,
                    importance=(
                        float(new_importance)
                        if new_importance is not None
                        else float(meta.get("importance") or 0.8)
                    ),
                )
                if final_id is None or int(final_id) == 0:
                    return envelope(409, "revision_conflict", "replace failed under current revision")
                final_id = int(final_id)
        else:
            async with runtime.write_barrier:
                ok = await runtime.engine.update_memory(memory_id, {"importance": float(new_importance)})
                if not ok:
                    return envelope(409, "revision_conflict", "update rejected by engine")
            final_id = memory_id
        runtime.meta.upsert_external(
            external_id=external_id,
            memory_id=final_id,
            scope_key=scope.session_key,
            kind=(external or {}).get("kind") or "explicit",
            revision=current + 1,
            state="active",
            fingerprint=ident_of(str(new_content if new_content is not None else record["text"])),
        )
        return JSONResponse({"memoryId": final_id, "revision": current + 1})

    @app.delete("/v1/memories/{memory_id}")
    async def memory_delete(request: Request, memory_id: int) -> JSONResponse:
        authenticate(request)
        require_engine()
        body = await json_body(request)
        try:
            scope = parse_scope(body.get("scope"))
        except ScopeError as exc:
            return envelope(400, "invalid_scope", str(exc))
        expected = body.get("expectedRevision")
        try:
            record, meta = await guarded_detail(memory_id, scope)
        except HttpError:
            # Replay-safe: already deleted → 200 with deleted=false (§5).
            return JSONResponse({"deleted": False, "reason": "already_absent"})
        current = revision_of(meta, memory_id)
        if expected is None or int(expected) != current:
            return envelope(409, "revision_conflict", f"current revision is {current}", currentRevision=current)
        content = str(record["text"])
        forget_kind, forget_subject = asserted_identity(meta, scope)
        fingerprint = identity_fingerprint(scope.session_key, forget_kind, forget_subject, content)
        external = runtime.meta.find_external_by_memory(memory_id)
        external_id = (external or {}).get("external_id") or f"lm:{memory_id}"
        # Forget is scoped identity (INTEGRATION_GAPS item 1): identical text
        # held by another subject/session keeps flowing. Source ids are blocked
        # exactly; the reflection/output path obeys the identity block.
        async with runtime.write_barrier:
            runtime.meta.add_blocked_fingerprint(fingerprint, reason=f"deleted:{external_id}", scope_key=scope.session_key)
            for source in await runtime.engine.get_memory_source(memory_id):
                for source_key in (source.get("external_id"), source.get("id")):
                    if source_key is not None:
                        runtime.meta.add_blocked_source(scope.session_key, str(source_key), reason="memory_deleted")
            await runtime.invalidate_automatic_derivatives(memory_id)
            await runtime.engine.batch_delete_memories([memory_id])
            runtime.meta.mark_forgotten(external_id, fingerprint)
            runtime.meta.upsert_external(external_id, None, scope.session_key, "tombstone", current, "forgotten", fingerprint)
        return JSONResponse({"deleted": True, "revision": current})

    @app.get("/v1/memories/{memory_id}/evidence")
    async def memory_evidence(request: Request, memory_id: int, scope: str) -> JSONResponse:
        authenticate(request)
        require_engine()
        try:
            wanted = scope_from_label(scope)
        except ScopeError as exc:
            return envelope(400, "invalid_scope", str(exc))
        await guarded_detail(memory_id, wanted)
        sources = await runtime.engine.get_memory_source(memory_id)
        entries = []
        for source in sources:
            body_text = str(source.get("content") or "")
            blocked_flag = (
                runtime.meta.is_source_blocked(wanted.session_key, str(source.get("external_id") or ""))
                or runtime.meta.is_source_blocked(wanted.session_key, str(source.get("id") or ""))
            )
            entries.append(
                {
                    "id": source.get("id"),
                    "externalId": source.get("external_id"),
                    "role": source.get("role"),
                    "senderId": source.get("sender_id"),
                    "timestamp": source.get("timestamp"),
                    # EVIDENCE_ROUNDTRIP: contract-canonical aliases consumed
                    # by the Node mapper (additive; originals kept).
                    "messageId": source.get("id"),
                    "authorUserId": source.get("sender_id"),
                    "timestampMs": int(float(source.get("timestamp") or 0) * 1000),
                    "text": "" if blocked_flag else body_text[:400],
                    "blocked": bool(blocked_flag),
                }
            )
        return JSONResponse({"memoryId": memory_id, "sources": entries})

    @app.get("/v1/memories")
    async def memory_list(request: Request, scope: str | None = None, keyword: str = "", page: int = 1, pageSize: int = 20) -> JSONResponse:
        role = authenticate(request)
        require_engine()
        session_filter: str | None = None
        if scope:
            try:
                session_filter = scope_from_label(scope).session_key
            except ScopeError as exc:
                return envelope(400, "invalid_scope", str(exc))
        elif role != "operator":
            return envelope(400, "invalid_input", "scope is required for bridge role")
        outcome = await runtime.engine.list_memories_page(
            session_id=session_filter, keyword=keyword, page=page, page_size=min(int(pageSize), 100)
        )
        return JSONResponse(outcome)

    # ── reflections (§8) ─────────────────────────────────────────────────

    @app.post("/v1/reflections/run")
    async def reflections_run(request: Request) -> JSONResponse:
        authenticate(request, need_operator=True)
        require_engine()
        body = await json_body(request)
        try:
            scope = parse_scope(body.get("scope"))
        except ScopeError as exc:
            return envelope(400, "invalid_scope", str(exc))
        try:
            receipt = await run_reflection(runtime, scope, force=bool(body.get("force")), manual=True)
        except BudgetBlockedError:
            return envelope(429, "budget_exceeded", "daily LLM request budget exhausted")
        except RuntimeError as exc:
            if str(exc).startswith("stale_window"):
                return envelope(409, "revision_conflict", str(exc))
            raise
        return JSONResponse(receipt)

    # ── admin plane (§6, §6b, §10) ───────────────────────────────────────

    @app.post("/v1/admin/reconcile")
    async def admin_reconcile(request: Request) -> JSONResponse:
        authenticate(request, need_operator=True)
        require_engine()
        body = await json_body(request)
        dry_run = bool(body.get("dryRun")) or request.query_params.get("dryRun", "").lower() in ("1", "true")
        idem_key = request.headers.get("idempotency-key")
        request_hash = hashlib.sha256(await request.body()).hexdigest()
        if idem_key:
            cached = runtime.meta.get_idempotent(idem_key)
            if cached:
                if cached[0] != request_hash:
                    return envelope(409, "idempotency_conflict", "key reused with a different body")
                return JSONResponse(cached[1])
        result = await reconcile(runtime, body, dry_run=dry_run)
        if idem_key:
            runtime.meta.put_idempotent(idem_key, request_hash, result)
        return JSONResponse(result)

    @app.get("/v1/admin/reconcile/state")
    async def reconcile_state(request: Request, externalId: str) -> JSONResponse:
        authenticate(request, need_operator=True)
        row = runtime.meta.get_external(externalId)
        if row is None:
            return envelope(404, "not_found", "unknown externalId")
        return JSONResponse({"externalId": row["external_id"], "memoryId": row["memory_id"],
                             "kind": row["kind"], "revision": int(row["revision"]),
                             "state": row["state"], "scope": row.get("scope_key"),
                             "fingerprint": row.get("fingerprint")})

    @app.get("/v1/admin/blocklist")
    async def blocklist(request: Request, limit: int = 100, cursor: int = 0) -> JSONResponse:
        authenticate(request, need_operator=True)
        return JSONResponse(runtime.meta.blocklist_page(min(int(limit), 500), int(cursor)))

    @app.get("/v1/admin/graph/snapshot")
    async def graph_snapshot(request: Request) -> JSONResponse:
        """Read-only graph counts (operator). The 3D/management UI itself is
        remaining work (CONTRACT §11)."""
        authenticate(request, need_operator=True)
        require_engine()
        conn = runtime.engine.db_connection
        counts = {}
        for table in ("graph_nodes", "graph_edges", "graph_entries", "graph_entry_nodes"):
            try:
                cursor = await conn.execute(f"SELECT COUNT(*) AS c FROM {table}")
                row = await cursor.fetchone()
                counts[table] = int(row["c"])
            except Exception:
                counts[table] = 0
        top: list[dict[str, Any]] = []
        try:
            cursor = await conn.execute("SELECT * FROM graph_nodes ORDER BY id DESC LIMIT 20")
            for row in await cursor.fetchall():
                item = dict(row)
                # keep short labels only; drop any long payload columns
                top.append({k: (str(v)[:80] if isinstance(v, str) else v)
                            for k, v in item.items() if k in ("id", "name", "type", "entity_type", "label")})
        except Exception:
            pass
        return JSONResponse({"counts": counts, "recentNodes": top, "limit": 20})

    @app.post("/v1/admin/backups/create")
    async def backups_create(request: Request) -> JSONResponse:
        """Consistent snapshot under the runtime write barrier (BACKUP_
        CONSISTENCY): every sidecar write path — ingest, memory CRUD, UI
        mutations, reflection persistence, decay — quiesces first; SQLite
        stores go through the backup API (never raw copies of live -wal/
        -shm); vector state is flushed with save_index first. Validation
        opens every captured store and checks integrity, schema, rows and
        vector reload before the snapshot is declared. If writes do not
        settle the call fails explicitly with retry guidance."""
        authenticate(request, need_operator=True)
        require_engine()
        import shutil
        import sqlite3
        from datetime import datetime, timezone
        from uuid import uuid4

        data_dir = Path(config.data_dir)
        target: Path | None = None
        quiesce_seconds = float(config.limits.get("backupQuiesceSeconds", 15))
        try:
            async with asyncio.timeout(quiesce_seconds):
                await runtime.write_barrier.acquire()
        except (asyncio.TimeoutError, RuntimeError):
            return envelope(409, "unavailable",
                            "backup barrier busy: write traffic did not quiesce; retry")
        try:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            label = f"lm-sidecar-{stamp}-{uuid4().hex[:6]}"
            target = data_dir / "backups" / label
            target.mkdir(parents=True, exist_ok=False)

            for db in (runtime.faiss_db, runtime.graph_db):
                storage = getattr(db, "embedding_storage", None)
                if storage is not None:
                    await storage.save_index()

            captured: list[str] = []
            total_bytes = 0
            for db_file in sorted(data_dir.glob("*.db")):
                dst = target / db_file.name
                src = sqlite3.connect(str(db_file))
                out = sqlite3.connect(str(dst))
                try:
                    src.backup(out)
                finally:
                    out.close()
                    src.close()
                captured.append(db_file.name)
                total_bytes += dst.stat().st_size

            for path in sorted(data_dir.rglob("*")):
                rel = path.relative_to(data_dir)
                if not path.is_file() or rel.parts[0] == "backups":
                    continue
                if rel.suffix in (".db", ".db-wal", ".db-shm"):
                    continue  # -wal/-shm replaced by the backup API above
                dest = target / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, dest)
                captured.append(str(rel))
                total_bytes += dest.stat().st_size

            validation = _validate_backup(target)
            if not validation["ok"]:
                shutil.rmtree(target, ignore_errors=True)
                return envelope(503, "unavailable",
                                "backup validation failed: " + "; ".join(validation["failures"][:3]))
            info = {"label": label, "createdAt": stamp, "tool": "lm-sidecar",
                    "fileCount": len(captured), "bytes": total_bytes,
                    "files": captured, "validation": validation["summary"]}
            (target / "backup_info.json").write_text(
                json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
            return JSONResponse({"label": label, "files": len(captured),
                                 "bytes": total_bytes, "validated": True})
        except Exception as exc:
            if target is not None:
                shutil.rmtree(target, ignore_errors=True)
            return envelope(503, "unavailable", f"backup failed: {type(exc).__name__}")
        finally:
            runtime.write_barrier.release()

    def _validate_backup(snapshot: Path) -> dict[str, Any]:
        import sqlite3

        required = {
            "lm-sidecar.db": {"external_memory", "block_fingerprint", "block_source",
                               "usage_day", "ingest_dedupe", "reflection_cursor", "kv",
                               "idempotency", "jobs"},
            "conversations.db": {"messages"},
        }
        failures: list[str] = []
        summary: dict[str, Any] = {"databases": {}, "indexes": {}}
        for db in sorted(snapshot.glob("*.db")):
            try:
                conn = sqlite3.connect(str(db))
                try:
                    integrity = str(conn.execute("PRAGMA integrity_check").fetchone()[0])
                    if integrity != "ok":
                        failures.append(f"{db.name}: integrity_check={integrity}")
                    tables = {r[0] for r in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'")}
                    rows = {}
                    for table in sorted(tables):
                        if table.startswith("sqlite_"):
                            continue
                        try:
                            rows[table] = conn.execute(
                                f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
                        except sqlite3.Error:
                            pass
                    missing = required.get(db.name, set()) - tables
                    if missing:
                        failures.append(f"{db.name}: missing tables {sorted(missing)}")
                    summary["databases"][db.name] = {"integrity": integrity, "rows": rows}
                finally:
                    conn.close()
            except Exception as exc:
                failures.append(f"{db.name}: unreadable {type(exc).__name__}")
        for index in sorted(snapshot.rglob("*.index")):
            try:
                import faiss

                loaded = faiss.read_index(str(index))
                summary["indexes"][index.name] = {
                    "ntotal": int(loaded.ntotal), "dim": int(loaded.d)}
            except Exception as exc:
                failures.append(f"{index.name}: reload failed {type(exc).__name__}")
        if "lm-sidecar.db" not in summary["databases"]:
            failures.append("snapshot missing lm-sidecar.db ledger")
        return {"ok": not failures, "failures": failures, "summary": summary}

    @app.get("/v1/admin/stats")
    async def stats(request: Request) -> JSONResponse:
        authenticate(request, need_operator=True)
        require_engine()
        usage = runtime.meta.usage_snapshot()
        engine_stats = await runtime.engine.get_statistics()
        return JSONResponse(
            {
                "llm": {
                    # CONTRACT §10 frozen names plus legacy aliases:
                    # used counts every reserved request (failures included —
                    # legacy semantics: a failure still burns budget).
                    "used": usage["llmReserved"],
                    "reserved": usage["llmReserved"],
                    "failed": usage["llmFailed"],
                    "limit": config.daily_llm_limit,
                    "blocked": usage["blocked"],
                    "day": usage["day"],
                    "tokens": usage["llmTokens"],
                },
                "embeddings": {"requests": usage["embeddings"], "tokens": usage["embeddingTokens"],
                               "failuresTotal": int(runtime.meta.get_kv("embedding_failures") or 0)},
                "ingest": {
                    "messages": runtime.meta.count_rows("ingest_dedupe"),
                    "duplicates": int(runtime.meta.get_kv("ingest:duplicates") or 0),
                    "distinctSessions": runtime.meta.count_rows("reflection_cursor"),
                },
                "engine": engine_stats,
                "mode": config.mode,
                "lifecycle": {"decayLastDay": runtime.meta.get_kv("decay:last_day"), "decayLastError": runtime.meta.get_kv("decay:last_error")},
            }
        )

    # ── error plumbing ───────────────────────────────────────────────────

    @app.exception_handler(HttpError)
    async def http_error_handler(_request: Request, exc: HttpError) -> JSONResponse:
        return envelope(exc.status, exc.code, exc.message, **exc.extra)

    @app.exception_handler(EngineUnavailable)
    async def engine_error_handler(_request: Request, exc: EngineUnavailable) -> JSONResponse:
        return envelope(503, "engine_not_ready", str(exc))

    @app.exception_handler(ScopeError)
    async def scope_error_handler(_request: Request, exc: ScopeError) -> JSONResponse:
        return envelope(400, "invalid_scope", str(exc))

    @app.exception_handler(BudgetBlockedError)
    async def budget_error_handler(_request: Request, exc: BudgetBlockedError) -> JSONResponse:
        return envelope(429, "budget_exceeded", str(exc))

    @app.exception_handler(ValueError)
    async def value_error_handler(_request: Request, exc: ValueError) -> JSONResponse:
        return envelope(400, "invalid_input", str(exc))


    runtime.ui_installed = False
    return app


async def reflection_due(runtime: SidecarRuntime, scope_key: str) -> tuple[bool, str]:
    """Pure trigger decision, testable without the timer (GAP item 2).

    Fires when pending >= triggerMessages OR the session has pending messages
    and has been quiet for >= quietSeconds (host must have ingested messages;
    we track last-ingest time per session).
    """
    info = await runtime.conversation.get_session_info(scope_key)
    if not info:
        return False, "unknown_session"
    pending = int(info.message_count) - runtime.meta.get_cursor(scope_key)
    if pending <= 0:
        return False, "no_pending"
    if pending >= runtime.config.trigger_messages:
        return True, "threshold"
    last_raw = runtime.meta.get_kv(f"ingest:last:{scope_key}")
    if last_raw:
        idle = time.time() - float(last_raw)
        if idle >= runtime.config.quiet_seconds:
            return True, "quiet"
    return False, f"waiting({pending})"


async def _auto_reflect_loop(runtime: SidecarRuntime) -> None:
    """Production auto-trigger; per-session errors never kill the loop."""
    while True:
        try:
            await asyncio.sleep(15)
            if runtime.state != "ready":
                continue
            for info in await runtime.conversation.get_recent_sessions(500):
                scope_key = str(info.session_id)
                due, _reason = await reflection_due(runtime, scope_key)
                if not due:
                    continue
                scope = _scope_from_key(scope_key)
                if scope is None:
                    runtime.meta.set_kv(f"reflect:error:{scope_key}", "unreconstructible_scope_key")
                    continue
                try:
                    await run_reflection(runtime, scope)
                except BudgetBlockedError:
                    break  # daily cap hit; retry next cycle
                except Exception as exc:  # loop must survive per-session errors
                    runtime.meta.set_kv(f"reflect:error:{scope_key}", str(exc)[:200])
        except asyncio.CancelledError:
            raise
        except Exception:
            await asyncio.sleep(5)


def _scope_from_key(session_key: str) -> Scope | None:
    parts = session_key.split(":")
    if len(parts) == 4 and parts[0] == "livingmemory":
        try:
            return parse_scope({"chatType": parts[2], "groupId": parts[3], "userId": parts[3]})
        except ScopeError:
            return None
    return None


class _RowProxy:
    """Expose a messages-table row with Message-like attrs for block checks."""

    __slots__ = ("id", "content", "metadata")

    def __init__(self, row: dict[str, Any]) -> None:
        self.id = row["id"]
        self.content = row["content"]
        raw = row.get("metadata")
        if isinstance(raw, dict):
            self.metadata = raw
        else:
            try:
                self.metadata = json.loads(raw or "{}")
            except (json.JSONDecodeError, TypeError):
                self.metadata = {}


def _default_config(env: dict[str, str] | None = None) -> SidecarConfig:  # wrapper for tests
    return load_config(env)


# ---- HELPER-IMPORTS ----

