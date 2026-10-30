"""Core HTTP flow against the REAL upstream engine (deterministic providers).

Covers REQUIREMENTS item 7: actual engine boot, write/search/restart
persistence, scope isolation, evidence, CAS, auth, body limit, idempotency.
Run: ``.uv-tools/astrbot/Scripts/python.exe -X utf8 -B -m pytest``
"""

from __future__ import annotations

import asyncio
import json

import httpx
from conftest import bridge_headers, cleanup, make_env, operator_headers

from sidecar.app import build_app
from sidecar.config import load_config
from sidecar.engine import SidecarRuntime

GROUP = {"chatType": "group", "groupId": "100000004"}
ALICE = {"chatType": "private", "userId": "12345"}


def _client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


async def _flow(extra_doc=None):
    env, data = make_env(extra_doc)
    cfg = load_config(env)
    runtime = SidecarRuntime(cfg)
    app = build_app(cfg, runtime)
    results: dict[str, object] = {}
    async with app.router.lifespan_context(app):
        assert runtime.state == "ready", runtime.error
        async with _client(app) as client:
            health = await client.get("/v1/health")
            assert health.status_code == 200 and health.json()["status"] == "ready"
            results["engineVersion"] = health.json()["engineVersion"]

            # auth
            assert (await client.get("/v1/capabilities")).status_code == 401
            assert (await client.get("/v1/admin/stats", headers=bridge_headers())).status_code == 403
            caps = await client.get("/v1/capabilities", headers=bridge_headers())
            assert caps.status_code == 200

            # ingest + dedupe
            msg = {"scope": GROUP, "messageId": "q-1", "authorUserId": "12345", "authorName": "爱丽丝",
                   "role": "user", "text": "我对花生过敏，会议餐别点花生。", "timestampMs": 1793189892000,
                   "provenance": "direct_quote"}
            first = await client.post("/v1/ingest", headers=bridge_headers(), json=msg)
            assert first.status_code == 200, first.text
            dup = await client.post("/v1/ingest", headers=bridge_headers(), json=msg)
            assert dup.status_code == 200 and dup.json()["duplicate"] is True
            source_id = first.json()["messageId"]

            # explicit write with evidence
            saved = await client.post("/v1/memories", headers=bridge_headers(), json={
                "scope": GROUP, "content": "用户对花生过敏（会议餐饮禁忌）", "importance": 0.9,
                "assertedBy": "12345", "sourceMessageIds": [source_id]})
            assert saved.status_code == 201, saved.text
            memory_id = saved.json()["memoryId"]

            ev = await client.get(f"/v1/memories/{memory_id}/evidence", headers=operator_headers(),
                                  params={"scope": "group:100000004"})
            assert ev.status_code == 200 and ev.json()["sources"], ev.text
            assert ev.json()["sources"][0]["text"].startswith("我对花生过敏")
            # cross-scope probing denied even for operator
            wrong = await client.get(f"/v1/memories/{memory_id}/evidence", headers=operator_headers(),
                                     params={"scope": "private:12345"})
            assert wrong.status_code == 403, wrong.text

            # scope isolation: same text in Alice's private scope, different record
            msg_p = {"scope": ALICE, "messageId": "q-2", "authorUserId": "12345", "role": "user",
                     "text": "我对花生过敏，会议餐别点花生。", "timestampMs": 1793189893000, "provenance": "direct_quote"}
            ing_p = await client.post("/v1/ingest", headers=bridge_headers(), json=msg_p)
            assert ing_p.status_code == 200
            saved_p = await client.post("/v1/memories", headers=bridge_headers(), json={
                "scope": ALICE, "content": "用户对花生过敏（会议餐饮禁忌）", "assertedBy": "12345",
                "sourceMessageIds": [ing_p.json()["messageId"]]})
            assert saved_p.status_code == 201
            private_id = saved_p.json()["memoryId"]

            # recall: group query sees group memory, not private one's id (and
            # a private session never recalls group-only content by id)
            recall_g = await client.post("/v1/recall", headers=bridge_headers(),
                                         json={"scope": GROUP, "query": "花生 过敏", "k": 6})
            assert recall_g.status_code == 200
            ids_g = {r["memoryId"] for r in recall_g.json()["results"]}
            assert memory_id in ids_g and private_id not in ids_g, ids_g
            assert "参考资料" in recall_g.json()["injectionBlock"]

            # recall with a bogus guessed id from another scope is unreachable
            detail_x = await client.get(f"/v1/memories/{private_id}", headers=bridge_headers(),
                                        params={"scope": "group:100000004"})
            assert detail_x.status_code == 403

            # CAS: wrong revision rejected, right revision applied
            bad = await client.patch(f"/v1/memories/{memory_id}", headers=bridge_headers(), json={
                "scope": GROUP, "expectedRevision": 7, "importance": 0.5})
            assert bad.status_code == 409 and bad.json()["error"]["code"] == "revision_conflict"
            okp = await client.patch(f"/v1/memories/{memory_id}", headers=bridge_headers(), json={
                "scope": GROUP, "expectedRevision": 1, "content": "用户花生过敏——订餐必须标注无花生"})
            assert okp.status_code == 200 and okp.json()["revision"] == 2
            new_id = okp.json()["memoryId"]

            # delete tombstone + replay
            dele = await client.request("DELETE", f"/v1/memories/{new_id}", headers=bridge_headers(),
                                        json={"scope": GROUP, "expectedRevision": 2})
            assert dele.status_code == 200 and dele.json()["deleted"] is True
            replay = await client.request("DELETE", f"/v1/memories/{new_id}", headers=bridge_headers(),
                                         json={"scope": GROUP, "expectedRevision": 2})
            assert replay.status_code == 200 and replay.json()["deleted"] is False

            # blocked identity: re-adding the SAME (scope, subject, content) is refused
            readd = await client.post("/v1/memories", headers=bridge_headers(), json={
                "scope": GROUP, "content": "用户花生过敏——订餐必须标注无花生", "assertedBy": "12345",
                "sourceMessageIds": [source_id]})
            assert readd.status_code == 409 and readd.json()["error"]["code"] == "blocked_source", readd.text
            # while the identical TEXT in Alice's private scope still recalls fine
            recall_p = await client.post("/v1/recall", headers=bridge_headers(),
                                         json={"scope": ALICE, "query": "花生 过敏"})
            assert any("花生" in r["content"] for r in recall_p.json()["results"])
            stats = await client.get("/v1/admin/stats", headers=operator_headers())
            assert stats.status_code == 200 and stats.json()["ingest"]["messages"] >= 2

            body_limit = await client.post("/v1/ingest", headers=bridge_headers(), json={
                "scope": GROUP, "messageId": "big", "authorUserId": "12345", "role": "user",
                "text": "x" * 40000, "timestampMs": 1793189894000})
            assert body_limit.status_code == 413

            # snapshot for restart check
            state = {
                "privateId": private_id,
                "blocklistSources": (await client.get("/v1/admin/blocklist", headers=operator_headers())).json()["counts"],
            }
    # ── restart: brand-new runtime over the same directory ──
    env2, _ = {"LM_MODE": "test", "LM_DATA_DIR": env["LM_DATA_DIR"],
               "LM_BRIDGE_TOKEN": env["LM_BRIDGE_TOKEN"], "LM_OPERATOR_TOKEN": env["LM_OPERATOR_TOKEN"],
               "LM_CONFIG_FILE": env["LM_CONFIG_FILE"]}, None
    cfg2 = load_config(env2)
    runtime2 = SidecarRuntime(cfg2)
    app2 = build_app(cfg2, runtime2)
    async with app2.router.lifespan_context(app2):
        assert runtime2.state == "ready", runtime2.error
        async with _client(app2) as client:
            recall2 = await client.post("/v1/recall", headers=bridge_headers(),
                                        json={"scope": ALICE, "query": "花生 过敏"})
            assert recall2.status_code == 200
            ids2 = {r["memoryId"] for r in recall2.json()["results"]}
            assert state["privateId"] in ids2, "persisted memory must survive restart (FAISS reload)"
            detail2 = await client.get(f"/v1/memories/{state['privateId']}", headers=bridge_headers(),
                                       params={"scope": "private:12345"})
            assert detail2.status_code == 200 and json.loads(json.dumps(detail2.json()))["memoryId"]
            # tombstone identity still enforced after restart
            readd2 = await client.post("/v1/memories", headers=bridge_headers(), json={
                "scope": GROUP, "content": "用户花生过敏——订餐必须标注无花生", "assertedBy": "12345"})
            assert readd2.status_code == 409
    cleanup(data)
    return results


def test_core_flow_and_restart():
    asyncio.run(_flow())
