"""Provider adapters for the upstream engine (CONTRACT §10, REVIEW items 1/2/6).

Counting protocol (all through a single :class:`UsageSink`):

- LLM: every real request attempt (including MemoryProcessor retries and
  sub-calls such as graph extraction/importance/merge) first performs an
  **atomic reservation** at the request boundary — two concurrent reflections
  can therefore never exceed the durable daily cap. A failed attempt keeps its
  reservation consumed (legacy semantics: failures burn budget) and is also
  recorded in ``llm_failed``.
- Embedding: counted once per actual HTTP batch (chunking happens here, in
  ``get_embeddings_batch``), failures included. Deterministic doubles count
  too, so tests can assert exact request boundaries.

No unbounded output: chat requests send ``max_tokens`` from configuration;
HTTP timeouts honour ``timeoutSeconds``; provider errors are re-raised as
:class:`ProviderError` with status/shape only (never response bodies).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
from dataclasses import dataclass
from typing import Any, Protocol

import httpx


class ProviderError(RuntimeError):
    pass


class BudgetBlockedError(ProviderError):
    """Raised at the request boundary when the durable daily cap is reached."""


class UsageSink(Protocol):
    def reserve_llm(self) -> bool: ...
    def note_llm_failed(self) -> None: ...
    def note_embedding_request(self, failed: bool = False) -> None: ...
    def note_llm_usage(self, usage: dict[str, int]) -> None: ...
    def note_embedding_usage(self, usage: dict[str, int]) -> None: ...


class CountedLLMProvider:
    def __init__(self, inner: Any, sink: UsageSink) -> None:
        self._inner = inner
        self._sink = sink

    @property
    def provider_config(self) -> dict[str, Any]:
        return getattr(self._inner, "provider_config", {"id": "sidecar-llm"})

    async def text_chat(self, prompt: str, system_prompt: str | None = None) -> Any:
        if not self._sink.reserve_llm():
            raise BudgetBlockedError("daily LLM request budget exhausted (reserved at request boundary)")
        try:
            result = await self._inner.text_chat(prompt=prompt, system_prompt=system_prompt)
        except BudgetBlockedError:
            raise
        except Exception:
            self._sink.note_llm_failed()
            raise
        self._forward_usage()
        return result

    def _forward_usage(self) -> None:
        usage = getattr(self._inner, "last_usage", None)
        if usage:
            try:
                self._sink.note_llm_usage(usage)
            except Exception:
                pass  # usage reporting is observational; never breaks the call

    async def text_chat_stream(self, prompt: str, system_prompt: str | None = None):
        if not self._sink.reserve_llm():
            raise BudgetBlockedError("daily LLM request budget exhausted (reserved at request boundary)")
        try:
            async for chunk in self._inner.text_chat_stream(prompt=prompt, system_prompt=system_prompt):
                yield chunk
        except Exception:
            self._sink.note_llm_failed()
            raise


class CountedEmbeddingProvider:
    def __init__(self, inner: Any, sink: UsageSink) -> None:
        self._inner = inner
        self._sink = sink

    def get_dim(self) -> int:
        return self._inner.get_dim()

    async def get_embedding(self, text: str) -> list[float]:
        self._sink.note_embedding_request()
        try:
            result = await self._inner.get_embedding(text)
        except Exception:
            self._sink.note_embedding_request(failed=True)
            raise
        self._forward_usage()
        return result

    def _forward_usage(self) -> None:
        usage = getattr(self._inner, "last_usage", None)
        if usage:
            try:
                self._sink.note_embedding_usage(usage)
            except Exception:
                pass

    async def get_embeddings_batch(
        self,
        texts: list[str],
        *,
        batch_size: int = 10,
        tasks_limit: int = 3,
        max_retries: int = 3,
        progress_callback: Any = None,
    ) -> list[list[float]]:
        return await self._run_batch(texts, batch_size, tasks_limit, max_retries, progress_callback)

    async def _run_batch(self, texts, batch_size, tasks_limit, max_retries, progress_callback):
        result = await self._inner.get_embeddings_batch(
            texts,
            batch_size=batch_size,
            tasks_limit=tasks_limit,
            max_retries=max_retries,
            progress_callback=progress_callback,
            request_hook=self._sink.note_embedding_request,
        )
        self._forward_usage()
        return result


# ── deterministic doubles (test mode only) ────────────────────────────────────


class DeterministicHashEmbedding:
    """Pure local, network-free embedding double (bag-of-tokens projection).

    Similar texts (shared tokens) score close; unrelated texts drift apart —
    enough for deterministic FAISS route tests. Not semantic; production uses
    the configured remote provider.
    """

    def __init__(self, dim: int = 64) -> None:
        self._dim = dim

    def get_dim(self) -> int:
        return self._dim

    def _vector(self, text: str) -> list[float]:
        vec = [0.0] * self._dim
        for token in re.findall(r"[a-zA-Z0-9]+|[\u4e00-\u9fff]", (text or "").lower()):
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            bucket = int.from_bytes(digest[:4], "big") % self._dim
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vec[bucket] += sign
        norm = math.sqrt(sum(v * v for v in vec))
        if norm == 0:
            vec = [0.0] * self._dim
            vec[0] = 1.0
            norm = 1.0
        return [v / norm for v in vec]

    async def get_embedding(self, text: str) -> list[float]:
        return self._vector(text)

    async def get_embeddings_batch(
        self,
        texts: list[str],
        *,
        batch_size: int = 10,
        tasks_limit: int = 3,
        max_retries: int = 3,
        progress_callback: Any = None,
        request_hook: Any = None,
    ) -> list[list[float]]:
        out: list[list[float]] = []
        size = max(1, batch_size)
        for start in range(0, len(texts), size):
            chunk = texts[start : start + size]
            if request_hook:
                request_hook()
            out.extend(self._vector(t) for t in chunk)
            if progress_callback:
                progress_callback(min(start + size, len(texts)), len(texts))
        return out


@dataclass(slots=True)
class ScriptedChatResponse:
    completion_text: str


class ScriptedLLM:
    """Deterministic summariser double emitting the exact JSON shape that
    ``MemoryProcessor._parse_llm_response`` validates (no network)."""

    def __init__(self, payload: dict[str, Any] | None = None) -> None:
        self.payload = payload or {}
        self.calls: list[str] = []

    async def text_chat(self, prompt: str, system_prompt: str | None = None) -> ScriptedChatResponse:
        self.calls.append(prompt)
        summary = self.payload.get("summary")
        if not summary:
            lines = [ln.strip() for ln in prompt.splitlines() if ln.strip()]
            sample = [ln for ln in lines if ln.startswith(("用户", "助手"))][:2]
            summary = "；".join(sample) if sample else (lines[-1] if lines else "对话摘要")
        data = {
            "summary": summary,
            "canonical_summary": self.payload.get("canonical_summary", summary),
            "topics": self.payload.get("topics", ["日常"]),
            "key_facts": self.payload.get("key_facts", [summary]),
            "sentiment": self.payload.get("sentiment", "neutral"),
            "importance": self.payload.get("importance", 0.6),
            "participants": self.payload.get("participants", []),
        }
        return ScriptedChatResponse(json.dumps(data, ensure_ascii=False))

    async def text_chat_stream(self, prompt: str, system_prompt: str | None = None):
        response = await self.text_chat(prompt=prompt, system_prompt=system_prompt)
        yield ScriptedChatResponse(completion_text="")
        yield type("Part", (), {"is_chunk": False, "completion_text": response.completion_text})()


# ── production HTTP providers (OpenAI-compatible, remote-only) ───────────────


class OpenAICompatibleEmbedding:
    def __init__(self, base_url: str, creds: str, model: str, dim: int, timeout: float = 30.0,
                 transport: Any = None) -> None:
        if not base_url or not model:
            raise ProviderError("embedding base_url/model required for openai-compatible")
        self._url = base_url.rstrip("/") + "/embeddings"
        self._auth = f"Bearer {creds}" if creds else ""
        self._model = model
        self._dim = dim
        self._timeout = timeout
        self._transport = transport
        self.last_usage: dict[str, int] | None = None

    def get_dim(self) -> int:
        return self._dim

    async def _post(self, input_texts: list[str]) -> list[float] | list[list[float]]:
        headers = {"Content-Type": "application/json"}
        if self._auth:
            headers["Authorization"] = self._auth
        client_kwargs: dict[str, Any] = {"timeout": self._timeout}
        if self._transport is not None:
            client_kwargs["transport"] = self._transport
        try:
            async with httpx.AsyncClient(**client_kwargs) as client:
                response = await client.post(
                    self._url,
                    headers=headers,
                    json={"model": self._model, "input": input_texts, "encoding_format": "float"},
                )
                if response.status_code >= 400:
                    raise ProviderError(f"embedding HTTP {response.status_code}")
                payload = response.json()
        except httpx.HTTPError as exc:
            raise ProviderError(f"embedding transport error: {type(exc).__name__}") from exc
        usage = payload.get("usage") if isinstance(payload, dict) else None
        if isinstance(usage, dict):
            delta = {k: int(usage.get(k) or 0) for k in
                     ("prompt_tokens", "completion_tokens", "total_tokens")}
            if self.last_usage is None:
                self.last_usage = delta
            else:
                for key, value in delta.items():
                    if key == "total_tokens" and not value:
                        continue
                    self.last_usage[key] = self.last_usage.get(key, 0) + value
        rows = sorted(payload.get("data", []) or [], key=lambda item: item.get("index", 0))
        vectors = [[float(v) for v in row["embedding"]] for row in rows]
        if len(vectors) != len(input_texts):
            raise ProviderError("embedding response count mismatch")
        return vectors

    async def get_embedding(self, text: str) -> list[float]:
        vectors = await self._post([text])
        return vectors[0]

    async def get_embeddings_batch(
        self,
        texts: list[str],
        *,
        batch_size: int = 10,
        tasks_limit: int = 3,
        max_retries: int = 3,
        progress_callback: Any = None,
        request_hook: Any = None,
    ) -> list[list[float]]:
        out: list[list[float]] = []
        size = max(1, batch_size)
        for start in range(0, len(texts), size):
            chunk = texts[start : start + size]
            if request_hook:
                request_hook()
            try:
                out.extend(await self._post(chunk))  # type: ignore[arg-type]
            except Exception:
                if request_hook:
                    request_hook(failed=True)
                raise
            if progress_callback:
                progress_callback(min(start + size, len(texts)), len(texts))
        return out


class OpenAICompatibleLLM:
    """Chat adapter tolerant of BOTH response envelopes (PROVIDER_COMPATIBILITY):

    the live APIMart GLM endpoint answers a non-streaming request with
    ``Content-Type: text/event-stream``. We accept a complete JSON document or
    an SSE stream, accumulate ``delta.content`` (``reasoning_content`` is NOT
    the summary body), require a terminal completion (finish_reason=stop /
    [DONE]) before committing anything, and enforce a TOTAL deadline plus a
    response byte cap — a truncated or errored stream raises a sanitized
    ProviderError (status/class names only, never response text or the key).
    Returned token usage is captured on ``last_usage`` for counted reporting.
    """

    _MAX_RESPONSE_BYTES = 8 * 1024 * 1024

    def __init__(self, base_url: str, creds: str, model: str, timeout: float = 60.0,
                 max_output_tokens: int = 1024, transport: Any = None,
                 max_response_bytes: int | None = None,
                 extra_deadline: float | None = None) -> None:
        if not base_url or not model:
            raise ProviderError("llm base_url/model required for openai-compatible")
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._auth = f"Bearer {creds}" if creds else ""
        self._model = model
        self._timeout = timeout
        self._max_output = max(1, int(max_output_tokens))
        self._transport = transport
        self._max_bytes = int(max_response_bytes or self._MAX_RESPONSE_BYTES)
        self._extra_deadline = 5.0 if extra_deadline is None else float(extra_deadline)
        self.last_usage: dict[str, int] | None = None

    @property
    def provider_config(self) -> dict[str, Any]:
        return {"id": f"sidecar-llm:{self._model}"}

    async def text_chat(self, prompt: str, system_prompt: str | None = None) -> ScriptedChatResponse:
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self._auth:
            headers["Authorization"] = self._auth
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})
        body = {
            "model": self._model,
            "messages": messages,
            "max_tokens": self._max_output,  # finite output bound (REVIEW item 6)
            "temperature": 0.3,
        }
        content = await self._request(headers, body)
        return ScriptedChatResponse(content)

    async def _request(self, headers: dict[str, str], body: dict[str, Any]) -> str:
        self.last_usage = None
        client_kwargs: dict[str, Any] = {"timeout": httpx.Timeout(self._timeout)}
        if self._transport is not None:
            client_kwargs["transport"] = self._transport
        try:
            async with asyncio.timeout(self._timeout + self._extra_deadline):  # TOTAL deadline, not idle-only
                async with httpx.AsyncClient(**client_kwargs) as client:
                    async with client.stream("POST", self._url, headers=headers, json=body) as response:
                        if response.status_code >= 400:
                            raise ProviderError(f"llm HTTP {response.status_code}")
                        content_type = (response.headers.get("content-type") or "").lower()
                        if "text/event-stream" in content_type:
                            return await self._read_sse(response)
                        return self._finish_json(await self._read_bytes_bounded(response))
        except asyncio.TimeoutError as exc:
            raise ProviderError("llm total deadline exceeded") from exc
        except ProviderError:
            raise
        except httpx.HTTPError as exc:
            raise ProviderError(f"llm transport error: {type(exc).__name__}") from exc

    async def _read_bytes_bounded(self, response: httpx.Response) -> bytes:
        total = 0
        chunks: list[bytes] = []
        async for piece in response.aiter_bytes():
            total += len(piece)
            if total > self._max_bytes:
                raise ProviderError("llm response exceeded byte cap")
            chunks.append(piece)
        return b"".join(chunks)

    async def _read_sse(self, response: httpx.Response) -> str:
        buffer = b""
        total = 0
        parts: list[str] = []
        finish_reason: str | None = None
        saw_done = False

        def handle_line(line: bytes) -> bool:
            nonlocal finish_reason
            text = line.decode("utf-8", errors="replace").strip().rstrip("\r")
            if not text.startswith("data:"):
                return False
            payload = text[5:].strip()
            if payload == "[DONE]":
                return True
            try:
                obj = json.loads(payload)
            except ValueError:
                return False
            if not isinstance(obj, dict):
                return False
            usage = obj.get("usage")
            if isinstance(usage, dict):
                self.last_usage = {k: int(usage.get(k) or 0) for k in
                                   ("prompt_tokens", "completion_tokens", "total_tokens")}
            for choice in obj.get("choices") or []:
                if not isinstance(choice, dict):
                    continue
                delta = choice.get("delta") or {}
                content = delta.get("content")
                if isinstance(content, str):
                    parts.append(content)
                if choice.get("finish_reason"):
                    finish_reason = str(choice["finish_reason"])
            return False

        async for piece in response.aiter_bytes():
            total += len(piece)
            if total > self._max_bytes:
                raise ProviderError("llm response exceeded byte cap")
            buffer += piece
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if handle_line(line):
                    saw_done = True
                    break
            if saw_done:
                break
        if not saw_done:
            raise ProviderError("llm stream ended without completion")
        if finish_reason == "length":
            raise ProviderError("llm output truncated by max_tokens")
        if finish_reason is None:
            raise ProviderError("llm stream missing finish_reason")
        if finish_reason != "stop":
            raise ProviderError(f"llm unexpected finish_reason {finish_reason!r}")
        return "".join(parts)

    def _finish_json(self, raw: bytes) -> str:
        try:
            data = json.loads(raw.decode("utf-8", errors="replace"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise ProviderError("llm response invalid json") from exc
        if not isinstance(data, dict):
            raise ProviderError("llm response shape invalid")
        usage = data.get("usage")
        if isinstance(usage, dict):
            self.last_usage = {k: int(usage.get(k) or 0) for k in
                               ("prompt_tokens", "completion_tokens", "total_tokens")}
        try:
            choice = data["choices"][0]
            content = choice["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError("llm response shape invalid") from exc
        finish = choice.get("finish_reason")
        if finish == "length":
            raise ProviderError("llm output truncated by max_tokens")
        if finish not in (None, "stop"):
            raise ProviderError(f"llm unexpected finish_reason {finish!r}")
        if not isinstance(content, str):
            raise ProviderError("llm response shape invalid")
        return content


def build_embedding_provider(config: Any, sink: UsageSink) -> Any:
    emb = config.embedding
    if emb.kind == "deterministic-hash":
        inner: Any = DeterministicHashEmbedding(dim=emb.dim)
    elif emb.kind == "openai-compatible":
        inner = OpenAICompatibleEmbedding(
            emb.base_url, emb.creds, emb.model, emb.dim, emb.timeout_seconds
        )
    else:
        raise ProviderError(f"unknown embedding provider kind {emb.kind!r}")
    return CountedEmbeddingProvider(inner, sink)


def build_llm_provider(config: Any, sink: UsageSink) -> Any:
    llm = config.llm
    if llm.kind == "scripted":
        inner: Any = ScriptedLLM(payload=getattr(config, "scripted_llm_payload", None))
    elif llm.kind == "openai-compatible":
        inner = OpenAICompatibleLLM(
            llm.base_url, llm.creds, llm.model, llm.timeout_seconds, llm.max_output_tokens
        )
    else:
        raise ProviderError(f"unknown llm provider kind {llm.kind!r}")
    return CountedLLMProvider(inner, sink)
