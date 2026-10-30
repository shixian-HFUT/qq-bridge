"""MIGRATION_FAILURES item 3: one failed embedding HTTP request consumes
exactly one request count (plus a separate failure counter), never two."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import httpx
from conftest import cleanup, make_env

from sidecar.engine import _RuntimeSink
from sidecar.metastore import MetaStore
from sidecar.providers import CountedEmbeddingProvider, OpenAICompatibleEmbedding


def _mk_sink(data: Path):
    meta = MetaStore(data / "acct.db")
    return meta, _RuntimeSink(SimpleNamespace(meta=meta))


def test_embedding_failure_counts_once():
    env, data = make_env()

    async def _run():
        meta, sink = _mk_sink(data)
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(500, json={"error": {"message": "boom"}})

        inner = OpenAICompatibleEmbedding(
            "http://fake.invalid/v1", "creds", "m", 8,
            transport=httpx.MockTransport(handler))
        counted = CountedEmbeddingProvider(inner, sink)
        try:
            await counted.get_embedding("hello")
            raise AssertionError("expected provider error")
        except Exception as exc:
            if isinstance(exc, AssertionError):
                raise
        snap = meta.usage_snapshot()
        assert snap["embeddings"] == 1, snap
        assert meta.get_kv("embedding_failures") == "1"
        assert calls["n"] == 1

        # a success after the failure counts as its own single request
        def ok(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.1] * 8}],
                                             "usage": {"prompt_tokens": 1, "total_tokens": 1}})

        inner_ok = OpenAICompatibleEmbedding(
            "http://fake.invalid/v1", "creds", "m", 8,
            transport=httpx.MockTransport(ok))
        counted_ok = CountedEmbeddingProvider(inner_ok, sink)
        await counted_ok.get_embedding("hello")
        snap2 = meta.usage_snapshot()
        assert snap2["embeddings"] == 2
        assert snap2["embeddingTokens"] == 1
        assert meta.get_kv("embedding_failures") == "1"

    asyncio.run(_run())
    cleanup(data)
