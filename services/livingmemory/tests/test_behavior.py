"""Reflection budget/trigger, reconcile semantics, decay, real uvicorn boot.

All against the real upstream engine with scripted/deterministic doubles —
no network, no paid calls, data under the service subtree only.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import httpx
from conftest import SERVICE_ROOT, TMP_ROOT, bridge_headers, cleanup, make_env, operator_headers

from sidecar.app import build_app, reflection_due
from sidecar.config import load_config
from sidecar.engine import SidecarRuntime
from sidecar.scopes import parse_scope

GROUP = {"chatType": "group", "groupId": "100000004"}


def _client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


async def _ingest_many(client, count, start=0, scope=None):
    scope = scope or GROUP
    ids = []
    for i in range(start, start + count):
        reply = await client.post("/v1/ingest", headers=bridge_headers(), json={
            "scope": scope, "messageId": f"t-{i}", "authorUserId": "12345", "authorName": "测试者",
            "role": "user", "text": f"第{i}条：下次聚会定在周五晚上七点的火锅店。", "timestampMs": 1793189892000 + i,
            "provenance": "direct_quote"})
        assert reply.status_code == 200, reply.text
        ids.append(reply.json()["messageId"])
    return ids


async def _test_reflection_and_budget():
    env, data = make_env({"reflection": {"dailyLlmCalls": 2, "triggerMessages": 20, "quietSeconds": 0}})
    cfg = load_config(env)
    runtime = SidecarRuntime(cfg)
    app = build_app(cfg, runtime)
    async with app.router.lifespan_context(app):
        async with _client(app) as client:
            await _ingest_many(client, 21)

            due, reason = await reflection_due(runtime, "livingmemory:qq:group:100000004")
            assert due and reason == "threshold"

            run1 = await client.post("/v1/reflections/run", headers=operator_headers(),
                                     json={"scope": GROUP})
            assert run1.status_code == 200, run1.text
            receipt = run1.json()
            assert receipt["status"] == "ok" and receipt["memoryId"], receipt
            stats = (await client.get("/v1/admin/stats", headers=operator_headers())).json()
            assert stats["llm"]["used"] >= 1 and stats["llm"]["limit"] == 2

            # cursor must have advanced: no pending left
            due2, reason2 = await reflection_due(runtime, "livingmemory:qq:group:100000004")
            assert not due2 and reason2 == "no_pending"

            # recalled digest is provenanced and scope-filtered
            recall = await client.post("/v1/recall", headers=bridge_headers(),
                                       json={"scope": GROUP, "query": "聚会 火锅店"})
            assert any(r["memoryId"] == receipt["memoryId"] for r in recall.json()["results"])

            # exhausted budget: fill remaining (limit 2), then blocked
            await _ingest_many(client, 21, start=100)
            second = await client.post("/v1/reflections/run", headers=operator_headers(),
                                       json={"scope": GROUP})
            assert second.status_code == 200 and second.json()["status"] == "ok"
            assert (await client.get("/v1/admin/stats", headers=operator_headers())).json()["llm"]["used"] == 2
            # window now empty → must have fresh pending to reach the boundary
            await _ingest_many(client, 21, start=200)
            third = await client.post("/v1/reflections/run", headers=operator_headers(),
                                      json={"scope": GROUP})
            assert third.status_code == 429, (third.status_code, third.text)
            assert third.json()["error"]["code"] == "budget_exceeded"
            # pending window retained: cursor was not advanced past it
            stats2 = (await client.get("/v1/admin/stats", headers=operator_headers())).json()
            assert stats2["llm"]["used"] == 2
            assert stats2["llm"]["blocked"] >= 1
    cleanup(data)


async def _test_oversized_defer_and_input_budget():
    env, data = make_env({"reflection": {"dailyLlmCalls": 5, "maxWindowChars": 300, "triggerMessages": 1}})
    cfg = load_config(env)
    runtime = SidecarRuntime(cfg)
    app = build_app(cfg, runtime)
    async with app.router.lifespan_context(app):
        async with _client(app) as client:
            await _ingest_many(client, 3)
            run = await client.post("/v1/reflections/run", headers=operator_headers(), json={"scope": GROUP})
            assert run.status_code == 200
            receipt = run.json()
            assert receipt["status"] == "ok"
            # budget-bounded window: fewer than all 3 messages consumed, cursor
            # only advanced over what was actually summarized
            assert receipt["windowMessages"] <= 3
            assert receipt["cursorAfter"] == receipt["windowMessages"]
            remaining = await client.post("/v1/reflections/run", headers=operator_headers(), json={"scope": GROUP})
            assert remaining.status_code == 200  # remainder still processed later
    cleanup(data)


async def _test_reconcile():
    env, data = make_env({"reflection": {"dailyLlmCalls": 2}})
    cfg = load_config(env)
    runtime = SidecarRuntime(cfg)
    app = build_app(cfg, runtime)
    entries = [
        {"externalId": "src:m-1", "op": "upsert", "kind": "userFact", "subject": "12345",
         "scope": "private:12345", "content": "习惯：周报固定在周二下午提交", "revision": 3,
         "importance": 0.8, "fingerprint": "LEGACYOPAQUEABC123",
         "sourceRefs": [{"sourceId": 101, "externalId": "q-101", "authorUserId": "12345",
                         "scope": "private:12345", "partial": False}], "contentComplete": True},
        {"externalId": "src:m-2", "op": "upsert", "kind": "event", "subject": "12345",
         "scope": "private:12345", "content": "上周与运维一起修复了网关重启", "revision": 1,
         "importance": 0.5, "sourceRefs": [{"sourceId": 102, "externalId": "q-102", "authorUserId": "12345",
                                            "scope": "private:12345", "partial": True}], "contentComplete": False},
        {"externalId": "src:m-3", "op": "upsert", "kind": "userFact", "subject": "99999",
         "scope": "private:12345", "content": "跨归属伪造条目", "revision": 1,
         "sourceRefs": [{"sourceId": 103, "externalId": "q-103", "authorUserId": "88888",
                         "scope": "private:99999", "partial": False}]},
        {"externalId": "src:m-4", "op": "upsert", "kind": "merged", "subject": "12345",
         "scope": "private:12345", "content": "合并家族条目", "revision": 1, "mergeLineage": [1, 2]},
    ]
    payload = {"schemaVersion": 1, "batchId": "b-1", "entries": entries,
               "blocks": {"forgottenSources": [{"sourceId": 55, "scope": "private:12345"}],
                          "forgottenFingerprints": ["LEGACYOPAQUETOMB999"], "excluded": []}}
    async with app.router.lifespan_context(app):
        async with _client(app) as client:
            dry = await client.post("/v1/admin/reconcile?dryRun=true", headers=operator_headers(), json=payload,
                                    )
            assert dry.status_code == 200
            dry_result = dry.json()
            assert dry_result["dryRun"] is True and dry_result["providerCalls"] == 0
            assert len(dry_result["failed"]) >= 1  # m-3 session ownership
            assert any(u["reason"] == "mergeFamily" for u in dry_result["unsupported"])
            check = await client.post("/v1/recall", headers=bridge_headers(),
                                      json={"scope": {"chatType": "private", "userId": "12345"}, "query": "周报"})
            assert check.json()["results"] == []  # dry-run wrote NOTHING

            real = await client.post("/v1/admin/reconcile", headers=operator_headers(), json=payload)
            assert real.status_code == 200
            applied = real.json()
            assert applied["applied"] == 2 and applied["providerCalls"] >= 1

            replay = await client.post("/v1/admin/reconcile", headers=operator_headers(), json=payload)
            assert replay.json()["applied"] == 0
            assert all(s["reason"] == "idempotent" for s in replay.json()["skipped"]), replay.json()

            state = await client.get("/v1/admin/reconcile/state", headers=operator_headers(),
                                     params={"externalId": "src:m-1"})
            assert state.status_code == 200 and state.json()["revision"] == 3

            snap = await client.get("/v1/admin/graph/snapshot", headers=operator_headers())
            assert snap.status_code == 200 and "graph_nodes" in snap.json()["counts"], snap.text

            # partial evidence → unverified, never asserted
            recall = await client.post("/v1/recall", headers=bridge_headers(),
                                       json={"scope": {"chatType": "private", "userId": "12345"}, "query": "运维 网关"})
            hits = recall.json()["results"]
            assert hits and hits[0]["asserted"] is False

            # tombstoned externalId cannot be resurrected at same revision
            forget = await client.post("/v1/admin/reconcile", headers=operator_headers(), json={
                "batchId": "b-2", "entries": [{"externalId": "src:m-1", "op": "forget", "scope": "private:12345"}]})
            assert forget.status_code == 200 and forget.json()["applied"] == 1
            resurrect = await client.post("/v1/admin/reconcile", headers=operator_headers(), json={
                "batchId": "b-3", "entries": [entries[0]]})
            assert resurrect.json()["applied"] == 0
            assert any(s["reason"] == "tombstoned" for s in resurrect.json()["skipped"])
    cleanup(data)


async def _test_forgetting_blocks_reflection_identity():
    """A forgotten explicit fact must not be re-distilled from its evidence."""
    env, data = make_env({"reflection": {"dailyLlmCalls": 2, "triggerMessages": 1}})
    cfg = load_config(env)
    runtime = SidecarRuntime(cfg)
    app = build_app(cfg, runtime)
    async with app.router.lifespan_context(app):
        async with _client(app) as client:
            ids = await _ingest_many(client, 1)
            saved = await client.post("/v1/memories", headers=bridge_headers(), json={
                "scope": GROUP, "content": "花生过敏禁忌确认记录", "assertedBy": "12345",
                "sourceMessageIds": ids})
            memory_id = saved.json()["memoryId"]
            dele = await client.request("DELETE", f"/v1/memories/{memory_id}", headers=bridge_headers(),
                                        json={"scope": GROUP, "expectedRevision": 1})
            assert dele.status_code == 200
            ev = await client.get(f"/v1/memories/{memory_id}/evidence", headers=operator_headers(),
                                  params={"scope": "group:100000004"})
            assert ev.status_code == 404  # memory gone entirely
    cleanup(data)


def test_log_privacy_sanitizer():
    from io import StringIO

    from loguru import logger

    from sidecar.logsafe import install

    install()
    sink = StringIO()
    handler_id = logger.add(sink, format="{message} | {extra}", level="DEBUG")
    try:
        marker = "UNIQUE-PRIVATE-SECRET-MARKER-9f31"
        logger.bind(**{"source_file": "processors.memory_processor"}).info(
            f"[MemoryProcessor] 成功生成结构化记忆: 摘要={marker}, 主题=['{marker}']"
        )
        try:
            raise ValueError(marker)
        except ValueError:
            logger.bind(**{"source_file": "managers.memory_engine"}).exception("boom")
        logger.info(f"provider headers Bearer {marker} and sk-{marker}")
        output = sink.getvalue()
        assert marker not in output, output
        assert "[lm-log]" in output and "redacted" in output
        assert "exc=ValueError" in output
    finally:
        logger.remove(handler_id)


def test_reflection_and_budget():
    asyncio.run(_test_reflection_and_budget())


def test_oversized_defer_and_input_budget():
    asyncio.run(_test_oversized_defer_and_input_budget())


def test_reconcile():
    asyncio.run(_test_reconcile())


def test_forgetting_blocks_reflection_identity():
    asyncio.run(_test_forgetting_blocks_reflection_identity())


# ── real subprocess boot (uvicorn over TCP, loopback) ─────────────────────────


def test_real_uvicorn_subprocess():
    env_map, data = make_env({})
    proc_env = dict(os.environ)
    proc_env.update(env_map)
    proc_env["PYTHONPATH"] = str(SERVICE_ROOT)
    proc_env["LM_PORT"] = "18766"
    proc_env["LM_BIND"] = "127.0.0.1"
    proc = subprocess.Popen(
        [sys.executable, "-X", "utf8", "-B", "-m", "sidecar"],
        env=proc_env, cwd=str(SERVICE_ROOT),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
    )
    try:
        base = "http://127.0.0.1:18766"
        deadline = time.time() + 90
        ready = False
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(base + "/v1/health", timeout=2) as probe:
                    body = json.loads(probe.read().decode("utf-8"))
                    if body.get("status") == "ready":
                        ready = True
                        break
            except Exception:
                time.sleep(1.0)
        assert ready, "sidecar never reached ready over real TCP boot"
        headers = {"Authorization": f"Bearer {env_map['LM_BRIDGE_TOKEN']}"}
        with httpx.Client(base_url=base, timeout=10) as client:
            reply = client.post("/v1/ingest", headers=headers, json={
                "scope": GROUP, "messageId": "tcp-1", "authorUserId": "12345", "role": "user",
                "text": "进程级启动检查：记住这条", "timestampMs": int(time.time() * 1000)})
            assert reply.status_code == 200, reply.text
            saved = client.post("/v1/memories", headers=headers, json={
                "scope": GROUP, "content": "进程级启动检查记录", "assertedBy": "12345",
                "sourceMessageIds": [reply.json()["messageId"]]})
            assert saved.status_code == 201
            recalled = client.post("/v1/recall", headers=headers,
                                   json={"scope": GROUP, "query": "进程 启动"})
            assert recalled.status_code == 200 and len(recalled.json()["results"]) >= 1
            denied = client.get("/v1/admin/stats")
            assert denied.status_code == 401
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        proc.wait(timeout=10)
    cleanup(data)
