"""Active agentic recall endpoint + consistent sidecar backups."""

from __future__ import annotations

import asyncio
import json

import httpx
from conftest import bridge_headers, cleanup, make_env, operator_headers

from sidecar.app import build_app
from sidecar.config import load_config
from sidecar.engine import SidecarRuntime

GROUP = {"chatType": "group", "groupId": "100000004"}
PAGE = "/astrbot_plugin_livingmemory/page"


def _client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


async def _seed(client):
    ing = await client.post("/v1/ingest", headers=bridge_headers(), json={
        "scope": GROUP, "messageId": "ar-1", "authorUserId": "12345", "authorName": "阿测",
        "role": "user", "text": "我偏好青绿色界面", "timestampMs": 1793189892000,
        "provenance": "direct_quote"})
    mid = ing.json()["messageId"]
    saved = await client.post("/v1/memories", headers=operator_headers(), json={
        "scope": GROUP, "content": "偏好青绿色界面", "assertedBy": "12345",
        "sourceMessageIds": [mid], "externalId": "ar-fact"})
    assert saved.status_code == 201, saved.text
    return mid


async def _test_active_recall():
    env, data = make_env()
    cfg = load_config(env)
    runtime = SidecarRuntime(cfg)
    app = build_app(cfg, runtime)
    try:
        async with app.router.lifespan_context(app):
            async with _client(app) as client:
                await _seed(client)
                stats_before = (await client.get("/v1/admin/stats", headers=operator_headers())).json()

                reply = await client.post("/v1/recall/active", headers=bridge_headers(), json={
                    "scope": GROUP, "query": "青绿色 偏好", "k": 6, "target": "conversation"})
                assert reply.status_code == 200, reply.text
                body = reply.json()
                assert any("青绿色" in item["content"] for item in body["results"])
                first = body["results"][0]
                assert first["kind"] and first["assertion"]  # identity preserved
                assert "hasMore" in body and "nextCursor" in body and "status" in body
                assert body["meta"]["blockedFiltered"] >= 0

                # LLM budget untouched: agentic search is retrieval-only
                stats_after = (await client.get("/v1/admin/stats", headers=operator_headers())).json()
                assert stats_after["llm"]["used"] == stats_before["llm"]["used"]

                # people target binds to a real participant of THIS session
                ok = await client.post("/v1/recall/active", headers=bridge_headers(), json={
                    "scope": GROUP, "query": "偏好", "target": "current_speaker",
                    "identityKey": "12345"})
                assert ok.status_code == 200, ok.text
                assert any(item["subject"] == "12345" and "青绿色" in item["content"]
                           for item in ok.json()["results"]), ok.text
                stranger = await client.post("/v1/recall/active", headers=bridge_headers(), json={
                    "scope": GROUP, "query": "偏好", "target": "current_speaker",
                    "identityKey": "999999999"})
                assert stranger.status_code == 403 and stranger.json()["error"]["code"] == "scope_crossing"

                # bounds and cursor plumbing
                big = await client.post("/v1/recall/active", headers=bridge_headers(), json={
                    "scope": GROUP, "query": "偏好", "k": 50})
                assert big.status_code == 400
                excl_ids = [item["memoryId"] for item in body["results"]]
                excl = await client.post("/v1/recall/active", headers=bridge_headers(), json={
                    "scope": GROUP, "query": "青绿色 偏好", "k": 6, "excludeIds": excl_ids})
                assert excl.status_code == 200
                assert all(item["memoryId"] not in excl_ids for item in excl.json()["results"])

                # deterministic total-deadline behavior
                runtime.config.limits["activeRecallTimeoutSeconds"] = 0.000001
                late = await client.post("/v1/recall/active", headers=bridge_headers(), json={
                    "scope": GROUP, "query": "青绿色", "k": 6})
                assert late.status_code == 503 and late.json()["error"]["code"] == "provider_unavailable"

                # capabilities now advertises the tested feature set
                caps = (await client.get("/v1/capabilities", headers=bridge_headers())).json()
                assert caps["features"]["activeAgenticSearch"] is True
                assert caps["features"]["provenanceEnforced"] is True
                assert caps["features"]["identityInRecall"] is True
                assert caps["limits"]["activeRecallKMax"] == 12
    finally:
        await runtime.close()
        cleanup(data)


async def _test_backup_consistency():
    env, data = make_env()
    cfg = load_config(env)
    runtime = SidecarRuntime(cfg)
    app = build_app(cfg, runtime)
    try:
        async with app.router.lifespan_context(app):
            async with _client(app) as client:
                await _seed(client)
                await client.post("/v1/ui/login", json={"token": env["LM_OPERATOR_TOKEN"]})
                # create a UI-persisted config file too (backup must include it)
                from sidecar.page_api_facade import persist_ui_config
                from pathlib import Path

                persist_ui_config(Path(data), {"summary.batch_size": 8})

                reply = await client.post("/v1/admin/backups/create", headers=operator_headers())
                assert reply.status_code == 200, reply.text
                label = reply.json()["label"]
                assert reply.json()["validated"] is True
                listing = await client.get(PAGE + "/backups")
                assert listing.status_code == 200
                assert label in listing.text  # BackupManager-compatible enumeration

                files = {p.name for p in (data / "backups" / label).iterdir()}
                assert {"backup_info.json", "lm-sidecar.db"} <= files
                assert "livingmemory.db" in files
                assert "conversations.db" in files
                assert "ui_plugin_config.json" in files
                # live WAL sidecars are NEVER part of the snapshot
                assert not any(name.endswith((".db-wal", ".db-shm")) for name in files)
                info = json.loads((data / "backups" / label / "backup_info.json").read_text(encoding="utf-8"))
                val = info["validation"]
                # Real rows in every store, not just a file list.
                assert val["databases"]["conversations.db"]["rows"]["messages"] >= 1
                assert val["databases"]["lm-sidecar.db"]["rows"]["external_memory"] >= 1
                assert val["databases"]["livingmemory.db"]["rows"]  # documents etc.
                assert any(v["ntotal"] >= 1 for v in val["indexes"].values())

                # no credential material ever lands in the snapshot
                for path in (data / "backups" / label).rglob("*"):
                    if path.is_file() and path.suffix in (".json", ".db"):
                        raw = path.read_bytes()
                        assert env["LM_OPERATOR_TOKEN"].encode() not in raw
                        assert env["LM_BRIDGE_TOKEN"].encode() not in raw

                # restore is deliberately not exposed over HTTP
                restore = await client.post("/v1/admin/backups/restore", headers=operator_headers(),
                                            json={"label": label})
                assert restore.status_code == 404

                # barrier busy: while a write section holds the barrier, an
                # immediate snapshot cannot quiesce → explicit retry error
                runtime.config.limits["backupQuiesceSeconds"] = 0.2
                await runtime.write_barrier.acquire()
                try:
                    busy = await client.post("/v1/admin/backups/create", headers=operator_headers())
                    assert busy.status_code == 409 and busy.json()["error"]["code"] == "unavailable"
                finally:
                    runtime.write_barrier.release()
    finally:
        await runtime.close()
        cleanup(data)


def test_active_recall():
    asyncio.run(_test_active_recall())


def test_backup_consistency():
    asyncio.run(_test_backup_consistency())
