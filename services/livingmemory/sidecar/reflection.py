"""Background reflection (REVIEW items 3/4 corrected).

Cursor semantics match the upstream range API exactly:
``ConversationManager.get_messages_range(session_id, start_index, end_index)``
uses **0-based per-session message indexes**, and the per-session total is
``get_session_info(session_id).message_count``. The sidecar cursor therefore
stores “messages processed from the start of this session” (an index count),
never global message ids.

Windows are taken from the EARLIEST pending message forward (never
``window[-60:]``), bounded by BOTH a message-count chunk and a total-input
character budget. Messages pushed out of the summary input by the budget are
explicitly deferred to the next run (raw evidence itself stays complete in
the conversation store). A single oversized message that no future window
could ever fit is skipped once with an observable record — never silently
truncated into “full evidence”.

LLM budget is enforced at the request boundary (see
:mod:`sidecar.providers`); this module reacts to
``BudgetBlockedError`` rather than double-gating.
"""

from __future__ import annotations

from typing import Any

from .engine import SidecarRuntime
from .providers import BudgetBlockedError
from .scopes import Scope, identity_fingerprint


async def run_reflection(
    runtime: SidecarRuntime,
    scope: Scope,
    *,
    force: bool = False,
    manual: bool = False,
) -> dict[str, Any]:
    runtime.require()
    session_id = scope.session_key

    info = await runtime.conversation.get_session_info(session_id)
    total = int(info.message_count) if info else 0
    cursor = runtime.meta.get_cursor(session_id)  # per-session index count
    pending = total - cursor
    if pending <= 0:
        return {"status": "noop", "reason": "no_new_messages", "memoryId": None}
    if not manual and not force and pending < runtime.config.trigger_messages:
        return {"status": "noop", "reason": "below_trigger", "pending": pending}

    # ── take the earliest chunk, then trim by the input character budget ──
    chunk = await runtime.conversation.get_messages_range(
        session_id, start_index=cursor, end_index=cursor + runtime.config.reflection_chunk_messages
    )
    if not chunk:
        return {"status": "noop", "reason": "empty_window", "memoryId": None}

    max_chars = runtime.config.reflection_max_window_chars
    window: list[Any] = []
    deferred: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    used = 0
    for index, message in enumerate(chunk):
        text = message.content or ""
        if runtime.source_blocked(scope, message):
            window.append(message)  # consumed by the cursor, dropped from input
            continue
        if used + len(text) > max_chars:
            if not window:
                # First pending message alone exceeds every future budget:
                # skip once, observably; evidence row itself is retained.
                skipped.append(
                    {
                        "index": cursor + index,
                        "externalId": (message.metadata or {}).get("external_id"),
                        "chars": len(text),
                        "reason": "oversized_source_skipped",
                    }
                )
                window.append(message)
                continue
            deferred = [
                {
                    "index": cursor + position,
                    "externalId": (m.metadata or {}).get("external_id"),
                    "chars": len(m.content or ""),
                }
                for position, m in enumerate(chunk[index:], start=index)
            ]
            break
        window.append(message)
        used += len(text)
    eligible = [m for m in window if not runtime.source_blocked(scope, m)]
    dropped_blocked = len(window) - len(eligible)
    advance = len(window)  # index messages consumed by this run

    if not eligible:
        runtime.meta.set_cursor(session_id, cursor + advance)
        return {
            "status": "noop",
            "reason": "all_blocked" if not skipped else "oversized_skipped_only",
            "memoryId": None,
            "droppedByBlocklist": dropped_blocked,
            "skipped": skipped,
        }

    revision_before = await runtime.conversation.get_session_revision(session_id)

    from astrbot_plugin_livingmemory.core.memory_source import serialize_source_messages

    source_messages = serialize_source_messages(eligible)
    is_group = scope.chat_type == "group"
    try:
        content, metadata, importance = await runtime.processor.process_conversation(
            eligible, is_group_chat=is_group, persona_id=runtime.config.persona_id
        )
    except BudgetBlockedError:
        # Reservation failed at the request boundary. Propagate so the manual
        # endpoint answers the documented 429 (CONTRACT §8/§10); the cursor is
        # untouched and the same pending window retries next budget day.
        runtime.meta.put_job(
            f"reflect:{session_id}:{cursor}", "reflection", session_id,
            "budget_blocked", {"pending": pending, "deferred": len(deferred)},
        )
        raise

    revision_after = await runtime.conversation.get_session_revision(session_id)
    if revision_after != revision_before:
        # Upstream revision semantics: the session moved during summarising.
        # Do NOT advance the cursor past changed history; discard result.
        raise RuntimeError("stale_window: session revision changed during reflection")

    fingerprint = identity_fingerprint(session_id, "REFLECTION", "", content)
    if runtime.meta.is_fingerprint_blocked(fingerprint, session_id):
        runtime.meta.set_cursor(session_id, cursor + advance)
        return {"status": "blocked", "reason": "blocked_source", "memoryId": None}

    atoms = runtime.processor.classify_atoms_from_metadata(
        metadata, float(importance), session_id, runtime.config.persona_id
    )
    memory_id = await runtime.add_memory_row(
        scope,
        content=content,
        importance=float(importance),
        origin="reflection",
        metadata={
            "memory_type": "REFLECTION",
            "origin": "reflection",
            "summary_quality": metadata.get("summary_quality", "normal"),
            "topics": metadata.get("topics", []),
            "participants": metadata.get("participants", []),
            "atom_types": metadata.get("atom_types", []),
            "revision": 1,
            "inputDeferred": len(deferred),
            "inputSkipped": len(skipped),
        },
        source_messages=source_messages,
        atoms=atoms,
    )
    runtime.meta.set_cursor(session_id, cursor + advance)
    runtime.meta.upsert_external(
        external_id=f"reflection:{memory_id}",
        memory_id=memory_id,
        scope_key=session_id,
        kind="reflection",
        revision=1,
        state="active",
        fingerprint=fingerprint,
    )
    if deferred or skipped:
        runtime.meta.put_job(
            f"reflect:{session_id}:{cursor}", "reflection", session_id, "done",
            {"memoryId": memory_id, "deferred": deferred, "skipped": skipped},
        )
    return {
        "status": "ok",
        "memoryId": memory_id,
        "windowMessages": len(window),
        "inputChars": used,
        "droppedByBlocklist": dropped_blocked,
        "deferredMessages": len(deferred),
        "skippedOversized": len(skipped),
        "cursorAfter": cursor + advance,
        "llmReserved": runtime.meta.usage_snapshot()["llmReserved"],
    }
