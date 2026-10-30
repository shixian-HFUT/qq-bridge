"""Operator UI / native page-API integration (FINAL_SLICE dashboard).

Requires the vendored dashboard copy for static assertions; the page-API and
auth checks work regardless. All data under the service subtree.
"""

from __future__ import annotations

import asyncio

import httpx
from conftest import bridge_headers, cleanup, make_env, operator_headers

from sidecar.app import build_app
from sidecar.config import load_config
from sidecar.engine import SidecarRuntime

GROUP = {"chatType": "group", "groupId": "100000004"}
PAGE = "/astrbot_plugin_livingmemory/page"


def _client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


async def _boot(env):
    cfg = load_config(env)
    runtime = SidecarRuntime(cfg)
    app = build_app(cfg, runtime)
    return cfg, runtime, app


async def _test_ui_auth_and_page_api():
    env, data = make_env()
    cfg, runtime, app = await _boot(env)
    try:
        async with app.router.lifespan_context(app):
            assert runtime.state == "ready"
            async with _client(app) as anon:
                # login page is public HTML, no secrets in it
                reply = await anon.get("/ui/login")
                assert reply.status_code == 200 and "text/html" in reply.headers["content-type"]
                assert "operator-test-secret" not in reply.text

                # anonymous + bridge-token are rejected on page API
                reply = await anon.get(PAGE + "/stats")
                assert reply.status_code == 401
                reply = await anon.get(PAGE + "/stats", headers=bridge_headers())
                assert reply.status_code == 401  # bridge token can never drive the UI

                # wrong operator token via login
                reply = await anon.post("/v1/ui/login", json={"token": "wrong"})
                assert reply.status_code == 401
                assert "lm_ui_session" not in reply.cookies

                # correct login → HttpOnly SameSite cookie (token never in URL)
                reply = await anon.post("/v1/ui/login", json={"token": env["LM_OPERATOR_TOKEN"]})
                assert reply.status_code == 200, reply.text
                cookie_header = reply.headers.get("set-cookie", "").lower()
                assert "httponly" in cookie_header and "samesite=strict" in cookie_header
                form_login = await anon.post("/v1/ui/login", data={"token": env["LM_OPERATOR_TOKEN"]})
                assert form_login.status_code == 303 and form_login.headers["location"] == "/ui/"

                # session cookie drives the native upstream handlers
                reply = await anon.get(PAGE + "/stats")
                assert reply.status_code == 200, reply.text
                assert reply.json().get("status") == "ok"
                reply = await anon.get(PAGE + "/memories")
                assert reply.json().get("status") == "ok"

                # operator Bearer works on page API too (headless admin)
                reply = await anon.get(PAGE + "/stats", headers=operator_headers())
                assert reply.status_code == 200

                # import stays disabled: reconcile is the only write authority
                reply = await anon.post(PAGE + "/memories/import", json={"items": []})
                body = reply.json()
                assert body.get("status") == "error" and "reconcile" in body.get("message", "")

                # logout kills the session
                reply = await anon.post("/v1/ui/logout")
                assert reply.status_code == 200
                reply = await anon.get(PAGE + "/stats")
                assert reply.status_code == 401
    finally:
        await runtime.close()
        cleanup(data)


async def _test_ui_mutations_obey_host_authority():
    env, data = make_env()
    cfg, runtime, app = await _boot(env)
    try:
        async with app.router.lifespan_context(app):
            async with _client(app) as client:
                await client.post("/v1/ui/login", json={"token": env["LM_OPERATOR_TOKEN"]})
                ing = await client.post("/v1/ingest", headers=bridge_headers(), json={
                    "scope": GROUP, "messageId": "pm-1", "authorUserId": "12345",
                    "authorName": "阿测", "role": "user", "text": "我偏好青绿色界面",
                    "timestampMs": 1793189892000, "provenance": "direct_quote"})
                mid = ing.json()["messageId"]
                saved = await client.post("/v1/memories", headers=operator_headers(), json={
                    "scope": GROUP, "content": "偏好青绿色界面", "assertedBy": "12345",
                    "sourceMessageIds": [mid], "externalId": "pm-fact"})
                assert saved.status_code == 201, saved.text
                memory_id = saved.json()["memoryId"]

                # UI content edit: host remap + revision bump + old identity blocked
                upd = await client.post(PAGE + "/memories/update", json={
                    "memory_id": memory_id, "field": "content", "value": "现在偏好深紫色界面",
                    "reason": "ui改"})
                assert upd.status_code == 200 and upd.json().get("status") == "ok", upd.text
                assert upd.json()["data"]["hostRemapped"] is True
                new_id = upd.json()["data"]["new_memory_id"]
                assert upd.json()["data"]["revision"] == 2
                state = await client.get("/v1/admin/reconcile/state", headers=operator_headers(),
                                         params={"externalId": "pm-fact"})
                ext = state.json()
                assert ext["memoryId"] == new_id and ext["revision"] == 2 and ext["state"] == "active"

                # forgotten old identity must not resurrect via the write path
                replay = await client.post("/v1/memories", headers=operator_headers(), json={
                    "scope": GROUP, "content": "偏好青绿色界面", "assertedBy": "12345",
                    "sourceMessageIds": [mid]})
                assert replay.status_code == 409 and replay.json()["error"]["code"] == "blocked_source"

                # UI edit labels non-asserted promotion attempts as errors
                other = await client.post("/v1/memories", headers=operator_headers(), json={
                    "scope": GROUP, "content": "群公告：周五停水", "sourceMessageIds": [mid]})
                oid = other.json()["memoryId"]
                promote = await client.post(PAGE + "/memories/update", json={
                    "memory_id": oid, "field": "type", "value": "FACT"})
                assert promote.json().get("status") == "error" and "userFact" in promote.json().get("message", "")

                # UI batch-delete obeys full forget semantics (tombstone + blocks)
                dele = await client.post(PAGE + "/memories/batch-delete", json={"memory_ids": [new_id]})
                assert dele.json().get("status") == "ok"
                again = await client.get(f"/v1/memories/{new_id}", headers=operator_headers(),
                                         params={"scope": "group:100000004"})
                assert again.status_code in (404, 410)
                replay2 = await client.post("/v1/memories", headers=operator_headers(), json={
                    "scope": GROUP, "content": "现在偏好深紫色界面", "assertedBy": "12345",
                    "sourceMessageIds": [mid]})
                assert replay2.status_code == 409
                recall = await client.post("/v1/recall", headers=bridge_headers(), json={
                    "scope": GROUP, "query": "紫色 偏好", "k": 6})
                assert all("深紫色" not in item["content"] for item in recall.json()["results"])
    finally:
        await runtime.close()
        cleanup(data)


def test_ui_auth_and_page_api():
    asyncio.run(_test_ui_auth_and_page_api())


def test_ui_mutations_obey_host_authority():
    asyncio.run(_test_ui_mutations_obey_host_authority())


def test_supported_settings_persist_and_apply_after_restart():
    async def run():
        env, data = make_env()
        cfg = load_config(env)
        runtime = SidecarRuntime(cfg)
        app = build_app(cfg, runtime)
        try:
            async with app.router.lifespan_context(app):
                async with _client(app) as client:
                    await client.post("/v1/ui/login", json={"token": env["LM_OPERATOR_TOKEN"]})
                    settings = (await client.get(PAGE + "/config")).json()
                    paths = {f["path"] for s in settings["data"]["sections"] for f in s["fields"]}
                    assert "recall_engine.importance_weight" in paths
                    assert not any(p.startswith(("filtering_settings.", "provider_settings.")) for p in paths)
                    response = await client.post(PAGE + "/config/update", json={"values": {
                        "recall_engine.importance_weight": 1.5, "graph_memory.expansion_limit": 12}})
                    assert response.json()["status"] == "ok", response.text
                    assert response.json()["data"]["restartRequired"] is True
                    denied = await client.post(PAGE + "/config/update", json={"values": {
                        "filtering_settings.memory_scope_mode": "global"}})
                    assert denied.json()["status"] == "error"
            restarted = SidecarRuntime(load_config(env))
            try:
                await restarted.boot()
                assert restarted.engine.config["importance_weight"] == 1.5
                assert restarted.engine.config["graph_expansion_limit"] == 12
            finally:
                await restarted.close()
        finally:
            await runtime.close()
            cleanup(data)
    asyncio.run(run())
