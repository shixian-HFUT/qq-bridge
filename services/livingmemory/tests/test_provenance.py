"""FORWARD_ATTRIBUTION: provenance gates on every asserted-personal-fact path
(explicit write / reconcile / UI), without weakening ownership checks."""

from __future__ import annotations

import asyncio

from conftest import bridge_headers, cleanup, make_env, operator_headers

from sidecar.app import build_app
from sidecar.config import load_config
from sidecar.engine import SidecarRuntime

GROUP = {"chatType": "group", "groupId": "100000004"}
PAGE = "/astrbot_plugin_livingmemory/page"


def _client(app):
    import httpx

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


async def _test_forwarded_cannot_assert():
    env, data = make_env()
    cfg = load_config(env)
    runtime = SidecarRuntime(cfg)
    app = build_app(cfg, runtime)
    try:
        async with app.router.lifespan_context(app):
            async with _client(app) as client:
                fwd = await client.post("/v1/ingest", headers=bridge_headers(), json={
                    "scope": GROUP, "messageId": "fwd-1", "authorUserId": "12345",
                    "authorName": "转发者", "role": "user", "text": "转发：朋友说自己喜欢红色",
                    "timestampMs": 1793189992000, "provenance": "forwarded"})
                assert fwd.status_code == 200
                fwd_id = fwd.json()["messageId"]

                bad = await client.post("/v1/memories", headers=operator_headers(), json={
                    "scope": GROUP, "content": "喜欢红色", "assertedBy": "12345",
                    "sourceMessageIds": [fwd_id]})
                assert bad.status_code == 409 and bad.json()["error"]["code"] == "provenance_insufficient"

                # admin-attested observation is still storable (non-asserted)
                obs = await client.post("/v1/memories", headers=operator_headers(), json={
                    "scope": GROUP, "content": "群内转发内容提到有人喜欢红色"})
                assert obs.status_code == 201, obs.text

                # one direct ground from the same author legitimizes the fact
                direct = await client.post("/v1/ingest", headers=bridge_headers(), json={
                    "scope": GROUP, "messageId": "dir-1", "authorUserId": "12345",
                    "authorName": "本人", "role": "user", "text": "我自己说过我喜欢红色",
                    "timestampMs": 1793189995000, "provenance": "direct_quote"})
                ok = await client.post("/v1/memories", headers=operator_headers(), json={
                    "scope": GROUP, "content": "喜欢红色（自述）", "assertedBy": "12345",
                    "sourceMessageIds": [fwd_id, direct.json()["messageId"]]})
                assert ok.status_code == 201, ok.text

                # reconcile: host-claimed author must not bypass the ingest ledger
                entry_fwd = {
                    "schemaVersion": 1, "batchId": "prov-1", "dryRun": False,
                    "entries": [{
                        "externalId": "lv-prov-1", "scope": GROUP, "kind": "userFact", "content": "爱喝美式",
                        "revision": 1, "sourceOwner": "12345", "contentComplete": True,
                        "sourceRefs": [{"scope": GROUP, "externalId": "fwd-1",
                                        "authorUserId": "12345", "provenance": "direct_quote", "partial": False}],
                    }],
                }
                res = await client.post("/v1/admin/reconcile", headers=operator_headers(),
                                         json=entry_fwd)
                assert res.status_code == 200
                body = res.json()
                assert body["applied"] == 0
                assert body["failed"][0]["reason"] == "provenance_insufficient"

                # UI cannot launder a GENERAL observation into an asserted FACT
                obs_id = obs.json()["memoryId"]
                await client.post("/v1/ui/login", json={"token": env["LM_OPERATOR_TOKEN"]})
                promote = await client.post(PAGE + "/memories/update", json={
                    "memory_id": obs_id, "field": "type", "value": "FACT"})
                assert promote.json().get("status") == "error"
    finally:
        await runtime.close()
        cleanup(data)


async def _test_reconcile_evidence_and_owners():
    """EVIDENCE_ROUNDTRIP + MIGRATION_FAILURES item 2 against the real engine:
    reconciled facts persist actual ledger evidence and per-owner identity."""
    env, data = make_env()
    cfg = load_config(env)
    runtime = SidecarRuntime(cfg)
    app = build_app(cfg, runtime)
    try:
        async with app.router.lifespan_context(app):
            async with _client(app) as client:
                ing = await client.post("/v1/ingest", headers=bridge_headers(), json={
                    "scope": GROUP, "messageId": "ev-1", "authorUserId": "12345",
                    "authorName": "小A", "role": "user", "text": "我说过我爱喝椰子拿铁",
                    "timestampMs": 1793189992000, "provenance": "direct_quote"})
                assert ing.status_code == 200
                ing_b = await client.post("/v1/ingest", headers=bridge_headers(), json={
                    "scope": GROUP, "messageId": "ev-2", "authorUserId": "67890",
                    "role": "user", "text": "我也爱喝椰子拿铁",
                    "timestampMs": 1793189992000, "provenance": "direct_quote"})
                assert ing_b.status_code == 200
                res = await client.post("/v1/admin/reconcile", headers=operator_headers(), json={
                    "schemaVersion": 1, "batchId": "ev-1", "dryRun": False,
                    "entries": [
                        {"externalId": "ev-a", "scope": GROUP, "kind": "userFact", "content": "爱喝椰子拿铁",
                         "revision": 1, "sourceOwner": "12345", "contentComplete": True,
                         "sourceRefs": [{"scope": GROUP, "externalId": "ev-1",
                                         "authorUserId": "12345", "provenance": "direct_quote",
                                         "partial": False}]},
                        {"externalId": "ev-b", "scope": GROUP, "kind": "userFact", "content": "爱喝椰子拿铁",
                         "revision": 1, "sourceOwner": "67890", "contentComplete": True,
                         "sourceRefs": [{"scope": GROUP, "externalId": "ev-2",
                                         "authorUserId": "67890", "provenance": "direct_quote",
                                         "partial": False}]},
                        {"externalId": "ev-c", "scope": GROUP, "kind": "userFact", "content": "爱喝燕麦奶",
                         "revision": 1, "sourceOwner": "12345", "contentComplete": True,
                         "sourceRefs": [{"scope": GROUP, "externalId": "ev-3",
                                         "authorUserId": "12345", "provenance": "unknown",
                                         "partial": False}]},
                    ]})
                assert res.status_code == 200, res.text
                body = res.json()
                # ev-a applies (ledger-grounded), ev-b has no local evidence yet,
                # ev-c unknown provenance applies UNVERIFIED, never rejected,
                # never auto-upgraded.
                assert body["applied"] == 3 and not body["failed"], body
                a_state = await client.get("/v1/admin/reconcile/state", headers=operator_headers(),
                                            params={"externalId": "ev-a"})
                assert a_state.status_code == 200
                mem_a = a_state.json()["memoryId"]
                evw = await client.get(f"/v1/memories/{mem_a}/evidence", headers=operator_headers(),
                                       params={"scope": "group:100000004"})
                sources = evw.json()["sources"]
                assert sources, "reconciled fact must carry real persisted evidence"
                s0 = sources[0]
                assert s0["messageId"] == ing.json()["messageId"]
                assert s0["authorUserId"] == "12345"
                assert s0["timestampMs"] == 1793189992000
                assert "椰子拿铁" in s0["text"] and s0["blocked"] is False

                # two owners, same text: distinct subjects, forget one only
                rec = await client.post("/v1/recall/active", headers=bridge_headers(), json={
                    "scope": GROUP, "query": "椰子拿铁", "k": 8})
                owners = {item["subject"] for item in rec.json()["results"]
                          if "椰子拿铁" in item["content"]}
                assert {"12345", "67890"} <= owners
                detail = await client.get(f"/v1/memories/{mem_a}", headers=operator_headers(),
                                           params={"scope": "group:100000004"})
                assert detail.json()["metadata"]["asserted_by"] == "12345"
                assert detail.json()["metadata"]["subject"] == "12345"

                # unknown provenance: imported unverified, content incomplete
                c_state = await client.get("/v1/admin/reconcile/state", headers=operator_headers(),
                                            params={"externalId": "ev-c"})
                if c_state.status_code == 200:
                    mem_c = c_state.json()["memoryId"]
                    det_c = await client.get(f"/v1/memories/{mem_c}", headers=operator_headers(),
                                              params={"scope": "group:100000004"})
                    assert det_c.json()["metadata"]["assertion"] == "unverified"

                # forgetting ev-a blocks only its own identity/text in scope
                dele = await client.request("DELETE", f"/v1/memories/{mem_a}", headers=operator_headers(),
                                            json={"scope": GROUP, "expectedRevision": 1})
                assert dele.status_code == 200
                replay = await client.post("/v1/admin/reconcile", headers=operator_headers(), json={
                    "schemaVersion": 1, "batchId": "ev-2", "dryRun": False,
                    "entries": [{"externalId": "ev-a-new", "scope": GROUP, "kind": "userFact",
                                  "content": "爱喝椰子拿铁", "revision": 2,
                                  "sourceOwner": "12345", "contentComplete": True,
                                  "sourceRefs": [{"scope": GROUP, "externalId": "ev-1",
                                                  "authorUserId": "12345",
                                                  "provenance": "direct_quote", "partial": False}]}]})
                assert replay.json()["failed"], "forgotten identity must block re-import"
                assert replay.json()["failed"][0]["reason"] == "blocked_fingerprint"
    finally:
        await runtime.close()
        cleanup(data)


def test_forwarded_cannot_assert():
    asyncio.run(_test_forwarded_cannot_assert())


def test_reconcile_evidence_and_owners():
    asyncio.run(_test_reconcile_evidence_and_owners())
