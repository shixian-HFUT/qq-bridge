"""Upstream logging privacy sanitizer (REFLECTION_FAILURES final item).

The native MemoryProcessor/engine/retriever modules log summary prefixes,
topics and full request structures at INFO, and loguru's default exception
rendering includes diagnostic locals — private conversation text could leak
into container logs. We attach a loguru patcher (global to this process) that:

- replaces messages from upstream LivingMemory modules with a structured
  ``[lm-log] module:level (content redacted)`` stub, keeping codes/counters
  on sidecar-owned paths (stats/endpoints) intact;
- strips exception payloads (traceback + locals) from upstream records,
  keeping only the exception class name;
- masks ``Bearer …`` and obvious ``sk-…`` secrets in ANY log record.

No upstream file is modified; this is host-side emission policy.
"""

from __future__ import annotations

import re

_UPSTREAM_PREFIXES = (
    "managers.", "processors.", "retrieval.", "storage.", "core.",
    "validators.", "fusion.", "graph.",
)

_SECRET_PATTERNS = (
    re.compile(r"Bearer\s+[^\s'\"]+"),
    re.compile(r"sk-[A-Za-z0-9._-]{8,}"),
)


def _is_upstream(record) -> bool:
    source = (record["extra"] or {}).get("source_file") if isinstance(record.get("extra"), dict) else None
    if isinstance(source, str):
        return source.startswith(_UPSTREAM_PREFIXES)
    # fallback: astrbot plugin namespace in record name/module
    return str(record.get("name", "")).startswith("astrbot_plugin_livingmemory")


def _mask_secrets(text: str) -> str:
    out = text
    out = _SECRET_PATTERNS[0].sub("Bearer ***", out)
    return _SECRET_PATTERNS[1].sub("sk-***", out)


def _sanitize(record) -> None:
    if _is_upstream(record):
        module = (record["extra"] or {}).get("source_file", record["name"])
        if record["level"].no >= 20:
            record["message"] = f"[lm-log] {module} {record['level'].name} (content redacted)"
        exc = record.get("exception")
        if exc is not None and exc.type is not None:
            record["exception"] = None
            record["message"] += f" [exc={exc.type.__name__} locals omitted]"
    else:
        record["message"] = _mask_secrets(str(record["message"]))


_installed = False


def install() -> None:
    """Idempotent: combine the process' existing patchers with ours.

    loguru's ``configure(patcher=...)`` accepts ONE callable; the internal
    storage is a list, so we fold the previously-installed patchers and ours
    into a single combined patcher (and never re-wrap our own output).
    """
    global _installed
    if _installed:
        return
    try:
        from loguru import logger
    except Exception:
        return
    core = getattr(logger, "_core", None)
    existing = list(getattr(core, "patchers", []) or [])
    ours = [p for p in existing if getattr(p, "__name__", "") != "_combined_patcher"]

    def _combined_patcher(record) -> None:
        for p in ours:
            try:
                p(record)
            except Exception:
                pass
        _sanitize(record)

    logger.configure(patcher=_combined_patcher)
    _installed = True
