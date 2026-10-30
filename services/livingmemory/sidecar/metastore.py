"""Sidecar-local persistent state (``lm-sidecar.db``).

This is deliberately separate from the upstream engine databases
(``livingmemory.db``/FAISS/``conversations.db``): tombstones, revisions,
dedupe, budgets and idempotency are *host* semantics that upstream 2.8.2 does
not model (its docs: forgetting tombstones live in the legacy bridge store).
Counters and tombstones survive restarts (CONTRACT §6, §8, §10).
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

SHANGHAI = timezone(timedelta(hours=8))

_SCHEMA = """
CREATE TABLE IF NOT EXISTS block_source(
  scope_key TEXT NOT NULL, value TEXT NOT NULL, reason TEXT DEFAULT '',
  created_at REAL NOT NULL, PRIMARY KEY(scope_key, value));
CREATE TABLE IF NOT EXISTS block_fingerprint(
  fingerprint TEXT NOT NULL, scope_key TEXT NOT NULL DEFAULT '*',
  reason TEXT DEFAULT '', created_at REAL NOT NULL,
  PRIMARY KEY(scope_key, fingerprint));
CREATE TABLE IF NOT EXISTS external_memory(
  external_id TEXT PRIMARY KEY, memory_id INTEGER, scope_key TEXT, kind TEXT,
  revision INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'active',
  fingerprint TEXT, content_hash_key TEXT, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS ingest_dedupe(
  scope_key TEXT NOT NULL, external_id TEXT NOT NULL, message_id INTEGER NOT NULL,
  created_at REAL NOT NULL, PRIMARY KEY(scope_key, external_id));
CREATE TABLE IF NOT EXISTS reflection_cursor(
  scope_key TEXT PRIMARY KEY, last_message_id INTEGER NOT NULL DEFAULT 0,
  last_run_at REAL);
CREATE TABLE IF NOT EXISTS usage_day(
  day TEXT PRIMARY KEY, llm_reserved INTEGER NOT NULL DEFAULT 0,
  llm_failed INTEGER NOT NULL DEFAULT 0, embeddings INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  llm_prompt INTEGER NOT NULL DEFAULT 0, llm_completion INTEGER NOT NULL DEFAULT 0,
  llm_total INTEGER NOT NULL DEFAULT 0, embed_total INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS idempotency(
  key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response_json TEXT NOT NULL,
  created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(
  job_id TEXT PRIMARY KEY, kind TEXT, scope_key TEXT, state TEXT,
  detail TEXT, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS kv(
  key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def today_shanghai() -> str:
    return datetime.now(SHANGHAI).strftime("%Y-%m-%d")


class MetaStore:
    def __init__(self, path: Path | str) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode = WAL")
        self._db.execute("PRAGMA busy_timeout = 10000")
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(_SCHEMA)
        for column in ("llm_prompt", "llm_completion", "llm_total", "embed_total"):
            try:
                self._db.execute(
                    f"ALTER TABLE usage_day ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0"
                )
            except sqlite3.OperationalError:
                pass  # already present (fresh schema or migrated before)
        self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ── block list (source / fingerprint) ────────────────────────────────

    def add_blocked_source(self, scope_key: str, value: str, reason: str = "") -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR IGNORE INTO block_source(scope_key,value,reason,created_at) VALUES(?,?,?,?)",
                (scope_key, str(value), reason, time.time()),
            )
            self._db.commit()

    def is_source_blocked(self, scope_key: str, value: str) -> bool:
        with self._lock:
            row = self._db.execute(
                "SELECT 1 FROM block_source WHERE scope_key IN (?,?) AND value=?",
                (scope_key, "*", str(value)),
            ).fetchone()
        return row is not None

    def add_blocked_fingerprint(
        self, fingerprint: str, reason: str = "", scope_key: str = "*"
    ) -> None:
        if not fingerprint:
            return
        with self._lock:
            self._db.execute(
                "INSERT OR IGNORE INTO block_fingerprint(fingerprint,scope_key,reason,created_at) VALUES(?,?,?,?)",
                (fingerprint, scope_key, reason, time.time()),
            )
            self._db.commit()

    def is_fingerprint_blocked(self, fingerprint: str, scope_key: str = "") -> bool:
        """Match identity fingerprints for this scope plus opaque global ones."""
        if not fingerprint:
            return False
        with self._lock:
            if scope_key:
                row = self._db.execute(
                    "SELECT 1 FROM block_fingerprint WHERE fingerprint=? AND scope_key IN (?, '*')",
                    (fingerprint, scope_key),
                ).fetchone()
            else:
                row = self._db.execute(
                    "SELECT 1 FROM block_fingerprint WHERE fingerprint=?", (fingerprint,)
                ).fetchone()
        return row is not None

    def fingerprint_blockset(self, scope_key: str) -> set[str]:
        """Scope-bound entries + imported opaque (legacy) values."""
        with self._lock:
            return {
                str(row["fingerprint"])
                for row in self._db.execute(
                    "SELECT fingerprint FROM block_fingerprint WHERE scope_key IN (?, '*')",
                    (scope_key,),
                )
            }

    def blocked_fingerprint_set(self) -> set[str]:
        with self._lock:
            return {row["fingerprint"] for row in self._db.execute("SELECT fingerprint FROM block_fingerprint")}

    def blocklist_page(self, limit: int = 100, cursor: int = 0) -> dict:
        with self._lock:
            sources = self._db.execute(
                "SELECT scope_key,value,reason,created_at FROM block_source ORDER BY created_at LIMIT ? OFFSET ?",
                (limit, cursor),
            ).fetchall()
            prints = self._db.execute(
                "SELECT fingerprint,reason,created_at FROM block_fingerprint ORDER BY created_at LIMIT ? OFFSET ?",
                (limit, cursor),
            ).fetchall()
            total_s = self._db.execute("SELECT COUNT(*) c FROM block_source").fetchone()["c"]
            total_f = self._db.execute("SELECT COUNT(*) c FROM block_fingerprint").fetchone()["c"]
        return {
            "sources": [dict(row) for row in sources],
            "fingerprints": [dict(row) for row in prints],
            "counts": {"sources": total_s, "fingerprints": total_f},
            "nextCursor": cursor + limit if (cursor + limit) < max(total_s, total_f) else None,
        }

    # ── external id map / tombstones / CAS revisions ─────────────────────

    def upsert_external(
        self,
        external_id: str,
        memory_id: int | None,
        scope_key: str,
        kind: str,
        revision: int,
        state: str,
        fingerprint: str | None = None,
    ) -> None:
        with self._lock:
            self._db.execute(
                """INSERT INTO external_memory(external_id,memory_id,scope_key,kind,revision,state,fingerprint,updated_at)
                   VALUES(?,?,?,?,?,?,?,?)
                   ON CONFLICT(external_id) DO UPDATE SET
                     memory_id=excluded.memory_id, revision=excluded.revision,
                     state=excluded.state, fingerprint=excluded.fingerprint,
                     updated_at=excluded.updated_at""",
                (external_id, memory_id, scope_key, kind, revision, state, fingerprint, time.time()),
            )
            self._db.commit()

    def get_external(self, external_id: str) -> dict | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM external_memory WHERE external_id=?", (external_id,)
            ).fetchone()
        return dict(row) if row else None

    def find_external_by_memory(self, memory_id: int) -> dict | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM external_memory WHERE memory_id=?", (memory_id,)
            ).fetchone()
        return dict(row) if row else None

    def list_active_externals(self) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM external_memory WHERE state='active'"
            ).fetchall()
        return [dict(row) for row in rows]

    def bump_revision(self, external_id: str, fingerprint: str | None = None) -> int:
        with self._lock:
            row = self._db.execute(
                "SELECT revision FROM external_memory WHERE external_id=?", (external_id,)
            ).fetchone()
            revision = int(row["revision"]) + 1 if row else 1
            self._db.execute(
                "UPDATE external_memory SET revision=?, fingerprint=COALESCE(?,fingerprint), updated_at=? WHERE external_id=?",
                (revision, fingerprint, time.time(), external_id),
            )
            self._db.commit()
        return revision

    def mark_forgotten(self, external_id: str, fingerprint: str | None) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE external_memory SET state='forgotten', fingerprint=COALESCE(?,fingerprint), updated_at=? WHERE external_id=?",
                (fingerprint, time.time(), external_id),
            )
            self._db.commit()

    # ── ingest dedupe ────────────────────────────────────────────────────

    def get_dedupe(self, scope_key: str, external_id: str) -> int | None:
        with self._lock:
            row = self._db.execute(
                "SELECT message_id FROM ingest_dedupe WHERE scope_key=? AND external_id=?",
                (scope_key, external_id),
            ).fetchone()
        return int(row["message_id"]) if row else None

    def put_dedupe(self, scope_key: str, external_id: str, message_id: int) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR IGNORE INTO ingest_dedupe(scope_key,external_id,message_id,created_at) VALUES(?,?,?,?)",
                (scope_key, external_id, message_id, time.time()),
            )
            self._db.commit()

    # ── reflection cursor ────────────────────────────────────────────────

    def get_cursor(self, scope_key: str) -> int:
        with self._lock:
            row = self._db.execute(
                "SELECT last_message_id FROM reflection_cursor WHERE scope_key=?", (scope_key,)
            ).fetchone()
        return int(row["last_message_id"]) if row else 0

    def set_cursor(self, scope_key: str, last_message_id: int) -> None:
        with self._lock:
            self._db.execute(
                """INSERT INTO reflection_cursor(scope_key,last_message_id,last_run_at) VALUES(?,?,?)
                   ON CONFLICT(scope_key) DO UPDATE SET last_message_id=excluded.last_message_id,
                     last_run_at=excluded.last_run_at""",
                (scope_key, last_message_id, time.time()),
            )
            self._db.commit()

    # ── usage budget (per Asia/Shanghai day, survives restart) ───────────

    def add_llm_tokens(self, usage: dict) -> None:
        day = today_shanghai()
        with self._lock:
            self._db.execute(
                "INSERT INTO usage_day(day) VALUES(?) ON CONFLICT(day) DO NOTHING", (day,)
            )
            self._db.execute(
                "UPDATE usage_day SET llm_prompt=llm_prompt+?, llm_completion=llm_completion=?,"
                " llm_total=llm_total+? WHERE day=?",
                (int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0),
                 int(usage.get("total_tokens") or 0), day),
            )
            self._db.commit()

    def add_embedding_tokens(self, usage: dict) -> None:
        day = today_shanghai()
        with self._lock:
            self._db.execute(
                "INSERT INTO usage_day(day) VALUES(?) ON CONFLICT(day) DO NOTHING", (day,)
            )
            self._db.execute(
                "UPDATE usage_day SET embed_total=embed_total+? WHERE day=?",
                (int(usage.get("total_tokens") or usage.get("prompt_tokens") or 0), day),
            )
            self._db.commit()

    def usage_snapshot(self, day: str | None = None) -> dict:
        day = day or today_shanghai()
        with self._lock:
            row = self._db.execute("SELECT * FROM usage_day WHERE day=?", (day,)).fetchone()
        row = dict(row) if row else {}
        return {
            "llmReserved": int(row.get("llm_reserved", 0)),
            "llmFailed": int(row.get("llm_failed", 0)),
            "embeddings": int(row.get("embeddings", 0)),
            "blocked": int(row.get("blocked", 0)),
            "llmTokens": {
                "prompt": int(row.get("llm_prompt", 0)),
                "completion": int(row.get("llm_completion", 0)),
                "total": int(row.get("llm_total", 0)),
            },
            "embeddingTokens": int(row.get("embed_total", 0)),
            "day": day,
        }

    def record_request(self, kind: str, start: bool, failed: bool = False) -> dict:
        day = today_shanghai()
        with self._lock:
            self._db.execute(
                "INSERT INTO usage_day(day) VALUES(?) ON CONFLICT(day) DO NOTHING", (day,)
            )
            if kind == "embedding" and start:
                self._db.execute("UPDATE usage_day SET embeddings=embeddings+1 WHERE day=?", (day,))
            elif kind == "llm" and start:
                self._db.execute("UPDATE usage_day SET llm_reserved=llm_reserved+1 WHERE day=?", (day,))
            elif kind == "llm" and failed:
                self._db.execute("UPDATE usage_day SET llm_failed=llm_failed+1 WHERE day=?", (day,))
            self._db.commit()
            row = self._db.execute("SELECT * FROM usage_day WHERE day=?", (day,)).fetchone()
        return dict(row)

    def record_blocked(self) -> None:
        day = today_shanghai()
        with self._lock:
            self._db.execute(
                "INSERT INTO usage_day(day) VALUES(?) ON CONFLICT(day) DO NOTHING", (day,)
            )
            self._db.execute("UPDATE usage_day SET blocked=blocked+1 WHERE day=?", (day,))
            self._db.commit()

    def try_reserve_llm(self, limit: int, embed_call: bool = False) -> bool:
        """Atomic reserve-before-send at the request boundary (REVIEW item 2).

        Increments ``llm_reserved`` only while below the durable daily cap;
        increments ``embeddings`` unconditionally when counting an embedding
        request. Concurrency-safe under the store lock; survives restart.
        """
        day = today_shanghai()
        with self._lock:
            self._db.execute(
                "INSERT INTO usage_day(day) VALUES(?) ON CONFLICT(day) DO NOTHING", (day,)
            )
            if embed_call:
                self._db.execute("UPDATE usage_day SET embeddings=embeddings+1 WHERE day=?", (day,))
                self._db.commit()
                return True
            cursor = self._db.execute(
                "UPDATE usage_day SET llm_reserved=llm_reserved+1 WHERE day=? AND llm_reserved<?",
                (day, int(limit)),
            )
            self._db.commit()
            return cursor.rowcount == 1

    def note_llm_failed(self) -> None:
        day = today_shanghai()
        with self._lock:
            self._db.execute(
                "INSERT INTO usage_day(day) VALUES(?) ON CONFLICT(day) DO NOTHING", (day,)
            )
            self._db.execute("UPDATE usage_day SET llm_failed=llm_failed+1 WHERE day=?", (day,))
            self._db.commit()

    def get_kv(self, key: str) -> str | None:
        with self._lock:
            row = self._db.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return str(row["value"]) if row else None

    def set_kv(self, key: str, value: str) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )
            self._db.commit()

    def remove_kv(self, key: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM kv WHERE key=?", (key,))
            self._db.commit()

    def checkpoint(self) -> None:
        with self._lock:
            self._db.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    # ── idempotency ──────────────────────────────────────────────────────

    def get_idempotent(self, key: str) -> tuple[str, dict] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT request_hash,response_json FROM idempotency WHERE key=?", (key,)
            ).fetchone()
        if not row:
            return None
        return str(row["request_hash"]), json.loads(row["response_json"])

    def put_idempotent(self, key: str, request_hash: str, response: dict) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR IGNORE INTO idempotency(key,request_hash,response_json,created_at) VALUES(?,?,?,?)",
                (key, request_hash, json.dumps(response, ensure_ascii=False), time.time()),
            )
            self._db.commit()

    # ── jobs ─────────────────────────────────────────────────────────────

    def put_job(self, job_id: str, kind: str, scope_key: str, state: str, detail: dict) -> None:
        with self._lock:
            self._db.execute(
                """INSERT INTO jobs(job_id,kind,scope_key,state,detail,created_at) VALUES(?,?,?,?,?,?)
                   ON CONFLICT(job_id) DO UPDATE SET state=excluded.state, detail=excluded.detail""",
                (job_id, kind, scope_key, state, json.dumps(detail, ensure_ascii=False), time.time()),
            )
            self._db.commit()

    def get_job(self, job_id: str) -> dict | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
        if not row:
            return None
        out = dict(row)
        out["detail"] = json.loads(out["detail"] or "{}")
        return out

    _ALLOWED_TABLES = {"ingest_dedupe", "reflection_cursor", "block_source", "block_fingerprint", "external_memory"}

    def count_rows(self, table: str) -> int:
        if table not in self._ALLOWED_TABLES:
            raise ValueError(f"table {table!r} not allowed")
        with self._lock:
            return int(self._db.execute(f"SELECT COUNT(*) c FROM {table}").fetchone()["c"])
