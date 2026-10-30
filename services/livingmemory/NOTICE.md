# NOTICE — third-party components

## LivingMemory engine (vendored, unmodified)

- Component: `vendor/astrbot_plugin_livingmemory/**`
- Project: LivingMemory — “为 AstrBot 打造的、拥有完整记忆生命周期的智能长期记忆插件”
- Upstream: https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory
- Author: lxfight
- Version: **2.8.2**, pinned commit **a1e9c20a8c5fab93d6143f51be26fb1bbf8143ec**
  (verified against upstream `master` HEAD of the 2.8.2 release merge
  https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory/commit/a1e9c20a8c5fab93d6143f51be26fb1bbf8143ec,
  `metadata.yaml` version field, and `CHANGELOG.md` `[2.8.2] - 2026-10-28`).
- License: **GNU Affero General Public License v3.0 only** (`LICENSE` is vendored alongside).
- Acquisition: reproducible steps recorded in `vendor/VENDOR_MANIFEST.json`
  (`reproducibleFetch`), per-file SHA-256 for all 174 vendored files.
- Modifications: **none.** Files are loaded at runtime via a namespace-package
  alias (`astrbot_plugin_livingmemory` with `__path__` pointing at the vendor
  directory), the same technique used by upstream’s own test harness
  (`tests/conftest.py` `_ensure_plugin_package_alias`). `main.py` (AstrBot
  Star entry) is deliberately excluded; this sidecar is an independent host for
  the engine layer (`core/`, `storage/`, prompts, static stopwords).

## Runtime dependencies

The engine imports `astrbot` (for `astrbot.api.logger`, the FAISS
`FaissVecDB` vector database under `astrbot.core.db.vec_db`, and provider type
names). AstrBot is **AGPL-3.0**, https://github.com/AstrBotDevs/AstrBot —
used as an installed library (`4.29.3` in the local `.uv-tools/astrbot`
environment; pinned floor in `requirements.txt`). No AstrBot configuration,
credentials, plugin data, or databases are read by this sidecar.

`faiss-cpu`, `sqlmodel`/`SQLAlchemy`, `aiosqlite`, `jieba`, `networkx`, `pytz`,
`fastapi`, `uvicorn`, `httpx` are separate open-source projects under their own
licenses (MIT/BSD/Apache-2.0); see their PyPI pages.

## Sidecar code (this directory, excluding `vendor/`)

`sidecar/`, `tests/`, `deploy/`, `scripts/`, `CONTRACT.md` and accompanying
docs are original integration work for the cloud Amiya QQ bridge, created for
this task. They are licensed as part of a combined work with the AGPL-3.0
vendored engine: any distribution of this service must comply with AGPL-3.0
(network use included) for the whole. No credentials or production data are
embedded.
