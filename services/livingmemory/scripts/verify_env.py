"""Verify the interpreter can host the sidecar: astrbot + faiss + web stack
+ vendored engine import, without touching any credentials/config.

Usage: python -X utf8 scripts/verify_env.py
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVICE_ROOT))

REQUIRED = [
    ("astrbot", None), ("faiss", None), ("aiosqlite", None), ("jieba", None),
    ("networkx", None), ("pytz", None), ("aiofiles", None), ("fastapi", None),
    ("uvicorn", None), ("httpx", None), ("sqlmodel", None),
]


def main() -> int:
    print(f"python {sys.version.split()[0]} @ {sys.executable}")
    failures = []
    for name, _ in REQUIRED:
        try:
            module = importlib.import_module(name)
            version = getattr(module, "__version__", "?")
            print(f"  ok  {name} {version}")
        except Exception as exc:
            failures.append(f"{name}: {exc}")
            print(f"  FAIL {name}: {exc}")
    try:
        from sidecar.engine import VENDOR_DIR, install_vendor_package

        install_vendor_package()
        import astrbot_plugin_livingmemory  # noqa: F401
        from astrbot_plugin_livingmemory.core.managers.memory_engine import MemoryEngine
        from astrbot_plugin_livingmemory.storage.conversation_store import ConversationStore
        print(f"  ok  vendored engine importable from {VENDOR_DIR.name} "
              f"({MemoryEngine.__module__}, {ConversationStore.__module__})")
    except Exception as exc:
        failures.append(f"vendor: {exc}")
        print(f"  FAIL vendor: {exc}")
    import sqlite3
    conn = sqlite3.connect(":memory:")
    try:
        conn.execute("CREATE VIRTUAL TABLE t USING fts5(x)")
        print("  ok  sqlite FTS5 available")
    except Exception as exc:
        failures.append(f"fts5: {exc}")
        print(f"  FAIL fts5: {exc}")
    finally:
        conn.close()
    if failures:
        print(f"\nNOT READY: {len(failures)} problem(s)")
        return 1
    print("\nREADY: environment supports the LivingMemory sidecar")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
