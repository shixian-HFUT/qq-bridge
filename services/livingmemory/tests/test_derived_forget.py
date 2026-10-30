"""A forgotten source cannot survive inside another automatic summary."""
import asyncio
import httpx
import pytest
from conftest import bridge_headers, cleanup, make_env, operator_headers
from sidecar.app import build_app
from sidecar.config import load_config
from sidecar.engine import SidecarRuntime
from sidecar.scopes import parse_scope


def test_forget_invalidates_automatic_summary_from_same_source():
    async def run():
        env, data = make_env()
        runtime = SidecarRuntime(load_config(env))
        app = build_app(runtime.config, runtime)
        scope = {"chatType": "private", "userId": "12345"}
        try:
            async with app.router.lifespan_context(app):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as client:
                    source = await client.post("/v1/ingest", headers=bridge_headers(), json={
                        "scope": scope, "messageId": "derived-source", "authorUserId": "12345",
                        "role": "user", "text": "我喜欢蓝色", "provenance": "direct_quote"})
                    saved = await client.post("/v1/memories", headers=operator_headers(), json={
                        "scope": scope, "content": "喜欢蓝色", "assertedBy": "12345",
                        "sourceMessageIds": [source.json()["messageId"]]})
                    memory_id = saved.json()["memoryId"]
                    evidence = await runtime.engine.get_memory_source(memory_id)
                    derived = await runtime.add_memory_row(parse_scope(scope),
                        content="自动摘要：这位成员偏爱蓝色系界面", importance=0.7, origin="reflection",
                        metadata={"origin": "reflection", "memory_type": "REFLECTION"}, source_messages=evidence)
                    other_scope = {"chatType": "private", "userId": "67890"}
                    other_source = await client.post("/v1/ingest", headers=bridge_headers(), json={
                        "scope": other_scope, "messageId": "derived-source", "authorUserId": "67890",
                        "role": "user", "text": "我也喜欢蓝色", "provenance": "direct_quote"})
                    other_evidence = [{**evidence[0], "id": other_source.json()["messageId"], "sender_id": "67890"}]
                    other_derived = await runtime.add_memory_row(parse_scope(other_scope),
                        content="另一会话的蓝色偏好摘要", importance=0.7, origin="reflection",
                        metadata={"origin": "reflection", "memory_type": "REFLECTION"}, source_messages=other_evidence)
                    deleted = await client.request("DELETE", f"/v1/memories/{memory_id}", headers=operator_headers(),
                        json={"scope": scope, "expectedRevision": 1})
                    assert deleted.status_code == 200
                    assert await runtime.engine.get_memory_record(derived) is None, "automatic derivative of forgotten source survived"
                    assert await runtime.engine.get_memory_record(other_derived) is not None
                    before = runtime.meta.usage_snapshot()["embeddings"]
                    with pytest.raises(ValueError, match="blocked_source"):
                        await runtime.add_memory_row(parse_scope(scope), content="迟到的旧摘要", importance=0.7,
                            origin="reflection", metadata={"origin": "reflection"}, source_messages=evidence)
                    assert runtime.meta.usage_snapshot()["embeddings"] == before
        finally:
            await runtime.close()
            cleanup(data)
    asyncio.run(run())
