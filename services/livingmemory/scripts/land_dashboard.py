"""Land the dashboard frontend from the authorized installed-plugin
reference into the vendored tree and rebuild VENDOR_MANIFEST.json.

Read-only outside the service subtree; idempotent. Run:
    python -X utf8 -B scripts/land_dashboard.py [source_plugin_dir]
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parent.parent
VENDOR = SERVICE_ROOT / "vendor" / "astrbot_plugin_livingmemory"
DEFAULT_SRC = Path(
    r"C:\Users\example\Desktop\ai-bot\astrbot-home\data\plugins\astrbot_plugin_livingmemory"
)

EXCLUDED = [
    "tests/**", "docs/**", ".github/**", "scripts/**", "main.py", "README*.md",
    "IMPLEMENTATION_PLAN.md", "CHANGELOG.md", "package.json", "package-lock.json",
    "pytest.ini", "logo.png", ".gitattributes", ".gitignore", "plugin.json",
    "_conf_schema runtime config, live plugin config/data (never read or copied)",
]


def main() -> int:
    src_root = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    src = src_root / "pages" / "dashboard"
    if not src.is_dir():
        print(f"source dashboard not found: {src}")
        return 1
    dst = VENDOR / "pages" / "dashboard"
    copied = 0
    for path in sorted(p for p in src.rglob("*") if p.is_file()):
        if "__pycache__" in path.parts:
            continue
        target = dst / path.relative_to(src)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        copied += 1
    print(f"copied {copied} dashboard files (read-only source, config/data untouched)")

    manifest_path = SERVICE_ROOT / "vendor" / "VENDOR_MANIFEST.json"
    manifest = json.loads(manifest_path.read_text("utf-8"))
    entries = []
    total = 0
    for path in sorted(VENDOR.rglob("*")):
        if not path.is_file() or path.name == "VENDOR_MANIFEST.json":
            continue
        data = path.read_bytes()
        total += len(data)
        entries.append({
            "path": path.relative_to(VENDOR).as_posix(),
            "sizeBytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        })
    manifest["files"] = entries
    manifest["fileCount"] = len(entries)
    manifest["totalBytes"] = total
    manifest["excludedFromVendoring"] = EXCLUDED
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(f"manifest rebuilt: {len(entries)} files, {total} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
