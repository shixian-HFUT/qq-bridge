# LivingMemory sidecar

Hosts the real LivingMemory 2.8.2 engine behind the scoped HTTP API in [CONTRACT.md](CONTRACT.md). The bridge remains the authority for source edits and forgetting; the sidecar provides retrieval, graph/vector indexes, bounded reflection and the upstream Chinese operator dashboard.

The upstream engine and dashboard are pinned and vendored without changes. See [NOTICE.md](NOTICE.md), [the vendor manifest](vendor/VENDOR_MANIFEST.json) and [LICENSE](vendor/astrbot_plugin_livingmemory/LICENSE).

Use Python 3.12. Install `requirements.lock.txt`; production configuration comes from `LM_CONFIG_FILE` and credential file environment references. Start with `python -X utf8 -B -m sidecar`. Host-network deployments bind `127.0.0.1:8765`; `/v1/health` is the health endpoint and `/ui/login` is the operator login page. Bridge and operator credentials are distinct.

Run `python -X utf8 -B -m pytest` after installing `pytest==9.2.0`. The 31 tests use real FAISS, FTS5, graph and atom engines with deterministic provider doubles; no production data or paid requests. Test files are created only in `.test-tmp/`.

Deployment examples and private file locations are documented in [the repository deployment guide](../../docs/AMIYA_DEPLOYMENT.md). The container uses UID 10001; initialize a writable data mount for that user. The root Compose template supplies a read-only root filesystem and writable runtime tmpfs.

The native dashboard supports records/evidence, recall diagnostics, graph, prompts, supported settings and validated full backups. Protected imported records remain edited through the bridge's authorized editor. Restore is an offline operation, not a dashboard action. Upstream runtime warnings are retained rather than hidden by vendor changes.
