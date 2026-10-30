"""PROVIDER_COMPATIBILITY: JSON + SSE envelopes against a local fake HTTP
transport (httpx.MockTransport — no sockets, no credentials, no paid calls).

Covers: normal JSON, SSE content fragments + reasoning_content exclusion,
finish/usage, stream truncation, byte cap, HTTP error sanitization, total
deadline, and exact once-per-real-request accounting (failures included).
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from sidecar.providers import (
    BudgetBlockedError,
    CountedEmbeddingProvider,
    CountedLLMProvider,
    OpenAICompatibleEmbedding,
    OpenAICompatibleLLM,
    ProviderError,
)

SECRET_MARKER = "SEKRET-NOT-IN-ERRORS-913c"
BODY_MARKER = "PRIVATE-COMPLETION-MARKER-4fa2"


class RecordingSink:
    def __init__(self, llm_limit: int = 100) -> None:
        self.limit = llm_limit
        self.reserved = 0
        self.failed = 0
        self.embedding_requests = 0
        self.embedding_failures = 0
        self.llm_usage: list[dict] = []
        self.embedding_usage: list[dict] = []

    def reserve_llm(self) -> bool:
        if self.reserved >= self.limit:
            return False
        self.reserved += 1
        return True

    def note_llm_failed(self) -> None:
        self.failed += 1

    def note_embedding_request(self, failed: bool = False) -> None:
        self.embedding_requests += 1
        if failed:
            self.embedding_failures += 1

    def note_llm_usage(self, usage: dict) -> None:
        self.llm_usage.append(dict(usage))

    def note_embedding_usage(self, usage: dict) -> None:
        self.embedding_usage.append(dict(usage))


def sse_bytes(events: list[dict], done: bool = True) -> bytes:
    out = []
    for ev in events:
        out.append(f"data: {json.dumps(ev, ensure_ascii=False)}\n\n")
    if done:
        out.append("data: [DONE]\n\n")
    return "".join(out).encode("utf-8")


def content_event(text: str) -> dict:
    return {"choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]}


def reasoning_event(text: str) -> dict:
    return {"choices": [{"index": 0, "delta": {"reasoning_content": text}, "finish_reason": None}]}


def finish_event(reason: str = "stop") -> dict:
    return {"choices": [{"index": 0, "delta": {}, "finish_reason": reason}]}


def usage_event() -> dict:
    return {"choices": [], "usage": {"prompt_tokens": 62, "completion_tokens": 352,
                                     "total_tokens": 414}}


def make_llm(handler, **kwargs) -> OpenAICompatibleLLM:
    kwargs.setdefault("timeout", 2.0)
    kwargs.setdefault("extra_deadline", 0.5)
    return OpenAICompatibleLLM("http://fake.test/v1", SECRET_MARKER, "glm-5.3-flash",
                               transport=httpx.MockTransport(handler), **kwargs)


def run(coro):
    return asyncio.run(coro)


def test_normal_json_envelope():
    body = {"choices": [{"message": {"content": f"JSON-{BODY_MARKER}"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}}

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "application/json"}, json=body)

    provider = make_llm(handler)
    out = run(provider.text_chat("hi"))
    assert "JSON-" in out.completion_text
    assert provider.last_usage == {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}


def test_sse_fragments_reasoning_ignored_and_usage():
    events = [
        reasoning_event(f"{SECRET_MARKER} reasoning must not appear"),
        content_event('{"summary": "聚会'),
        content_event(f'定在周五", "body_marker": "{BODY_MARKER}"}}'),
        finish_event("stop"),
        usage_event(),
    ]
    stream = out = sse_bytes(events)

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=stream)

    provider = make_llm(handler)
    out = run(provider.text_chat("hi"))
    assert json.loads(out.completion_text)["summary"] == "聚会定在周五"
    assert SECRET_MARKER not in out.completion_text  # reasoning excluded from body
    assert provider.last_usage == {"prompt_tokens": 62, "completion_tokens": 352, "total_tokens": 414}


def test_sse_chunked_delivery_split_lines():
    # bytes arrive split mid-line: the parser must reassemble
    payload = sse_bytes([content_event("AB"), content_event("CD"), finish_event(), usage_event()])
    halves = [payload[i:i + 7] for i in range(0, len(payload), 7)]

    class _Stream(httpx.AsyncByteStream):
        def __init__(self):
            pass

        async def __aiter__(self):
            for piece in halves:
                yield piece

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=_Stream())

    provider = make_llm(handler)
    out = run(provider.text_chat("hi"))
    assert out.completion_text == "ABCD"


def test_truncated_stream_never_commits():
    payload = sse_bytes([content_event(BODY_MARKER)], done=False)  # no [DONE], no finish

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=payload)

    provider = make_llm(handler)
    with pytest.raises(ProviderError) as exc:
        run(provider.text_chat("hi"))
    assert "without completion" in str(exc.value)
    assert BODY_MARKER not in str(exc.value)
    assert SECRET_MARKER not in str(exc.value)


def test_finish_length_is_error_not_partial_summary():
    payload = sse_bytes([content_event('{"summary": "半'), finish_event("length")])

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=payload)

    provider = make_llm(handler)
    with pytest.raises(ProviderError, match="truncated by max_tokens"):
        run(provider.text_chat("hi"))


def test_byte_cap_enforced():
    big = content_event("x" * 4000)
    payload = sse_bytes([big, big, big, finish_event(), usage_event()])

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=payload)

    provider = make_llm(handler, max_response_bytes=6000)
    with pytest.raises(ProviderError, match="byte cap"):
        run(provider.text_chat("hi"))


def test_total_deadline_fires():
    slow_payload = sse_bytes([content_event("a") for _ in range(30)] + [finish_event()])
    pieces = [slow_payload[i:i + 40] for i in range(0, len(slow_payload), 40)]

    class _Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            for piece in pieces:
                await asyncio.sleep(0.08)  # each read within read-timeout
                yield piece

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=_Stream())

    provider = make_llm(handler, timeout=0.2, extra_deadline=0.25)  # total = 0.45s
    with pytest.raises(ProviderError) as exc:
        run(provider.text_chat("hi"))
    assert "deadline" in str(exc.value) or "transport error" in str(exc.value)


def test_http_error_sanitized_and_counted_once():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text=f"upstream blew up near {SECRET_MARKER}")

    sink = RecordingSink()
    provider = CountedLLMProvider(make_llm(handler), sink)
    with pytest.raises(ProviderError, match="llm HTTP 500") as exc:
        run(provider.text_chat("hi"))
    assert SECRET_MARKER not in str(exc.value)
    assert sink.reserved == 1 and sink.failed == 1  # failures consume budget once


def test_budget_blocked_makes_no_request():
    calls = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": "x"}, "finish_reason": "stop"}]})

    sink = RecordingSink(llm_limit=0)
    provider = CountedLLMProvider(make_llm(handler), sink)
    with pytest.raises(BudgetBlockedError):
        run(provider.text_chat("hi"))
    assert calls == []
    assert sink.failed == 0  # a denial is not a failed provider call


def test_counted_success_usage_forwarded():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/event-stream"},
                              content=sse_bytes([content_event("ok"), finish_event(), usage_event()]))

    sink = RecordingSink(llm_limit=2)
    provider = CountedLLMProvider(make_llm(handler), sink)
    out = run(provider.text_chat("hi"))
    assert out.completion_text == "ok"
    assert sink.reserved == 1 and sink.failed == 0
    assert sink.llm_usage == [{"prompt_tokens": 62, "completion_tokens": 352, "total_tokens": 414}]


def test_embedding_usage_and_counting():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "data": [{"index": 0, "embedding": [0.1, 0.2]}, {"index": 1, "embedding": [0.3, 0.4]}],
            "usage": {"prompt_tokens": 5, "total_tokens": 5}})

    sink = RecordingSink()
    inner = OpenAICompatibleEmbedding("http://fake.test/v1", SECRET_MARKER, "text-embedding-3-small",
                                      2, transport=httpx.MockTransport(handler))
    provider = CountedEmbeddingProvider(inner, sink)
    vectors = run(provider.get_embeddings_batch(["a", "b"], batch_size=2))
    assert len(vectors) == 2
    assert sink.embedding_requests == 1  # per actual HTTP batch
    assert sink.embedding_usage == [{"prompt_tokens": 5, "completion_tokens": 0, "total_tokens": 5}]
