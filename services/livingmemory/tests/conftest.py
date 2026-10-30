"""Shared fixtures: deterministic test-mode runtime, all data under the
service subtree (never outside the write scope), UTF-8-safe.
"""

from __future__ import annotations

import json
import shutil
import sys
import time
import uuid
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parent.parent
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

TMP_ROOT = SERVICE_ROOT / ".test-tmp"

BRIDGE = "bridge-test-secret-aaaa"
OPERATOR = "operator-test-secret-bbbb"


def make_env(extra_doc: dict | None = None) -> dict:
    """Fresh data dir + env dict for load_config; returns (env, data_dir, doc_file)."""
    data = TMP_ROOT / f"run-{uuid.uuid4().hex[:10]}"
    data.mkdir(parents=True, exist_ok=True)
    doc = {"reflection": {}, "limits": {}}
    if extra_doc:
        for key, value in extra_doc.items():
            if isinstance(value, dict) and isinstance(doc.get(key), dict):
                doc[key].update(value)
            else:
                doc[key] = value
    doc_file = data / "service.json"
    doc_file.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    env = {
        "LM_MODE": "test",
        "LM_DATA_DIR": str(data),
        "LM_BRIDGE_TOKEN": BRIDGE,
        "LM_OPERATOR_TOKEN": OPERATOR,
        "LM_CONFIG_FILE": str(doc_file),
    }
    return env, data


def bridge_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {BRIDGE}"}


def operator_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {OPERATOR}"}


def cleanup(data: Path) -> None:
    for _attempt in range(3):
        try:
            shutil.rmtree(data, ignore_errors=False)
            return
        except PermissionError:
            time.sleep(0.3)
    # Windows handle lag: leave the dir; .test-tmp is disposable and scoped.
