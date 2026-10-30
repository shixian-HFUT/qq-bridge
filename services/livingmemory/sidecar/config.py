"""Sidecar configuration.

Secrets are never stored in config files: tokens and provider credentials are
either direct environment variables or ``*_FILE`` references pointing at files
owned by ops. ``mode=test`` is a hard segregation switch (deterministic
provider doubles, loopback only, no outbound provider HTTP).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


class ConfigError(Exception):
    pass


def _read_secret(value: str | None, file_ref: str | None, name: str) -> str | None:
    if file_ref:
        path = Path(file_ref)
        if not path.is_file():
            raise ConfigError(f"{name}: file reference {file_ref!r} is not a readable file")
        return path.read_text(encoding="utf-8").strip() or None
    return value or None


@dataclass(slots=True)
class ProviderConfig:
    kind: str  # deterministic-hash | scripted | openai-compatible
    base_url: str = ""
    creds: str = ""  # bearer secret, env/file-referenced only, never logged
    model: str = ""
    dim: int = 64
    timeout_seconds: float = 30.0
    max_output_tokens: int = 1024


@dataclass(slots=True)
class SidecarConfig:
    mode: str  # test | production
    bind: str
    port: int
    data_dir: Path
    persona_id: str
    bot_user_id: str
    bridge_creds: str  # bearer secret for the bridge role (env/file only)
    operator_creds: str  # bearer secret for the operator role (env/file only)
    embedding: ProviderConfig
    llm: ProviderConfig
    limits: dict[str, Any] = field(default_factory=dict)
    reflection: dict[str, Any] = field(default_factory=dict)
    shared_identity: dict[str, Any] = field(default_factory=dict)
    engine_overrides: dict[str, Any] = field(default_factory=dict)

    @property
    def body_max_bytes(self) -> int:
        return int(self.limits.get("bodyMaxBytes", 2 * 1024 * 1024))

    @property
    def recall_max_chars(self) -> int:
        return int(self.limits.get("recallMaxChars", 1600))

    @property
    def text_max_chars(self) -> int:
        return int(self.limits.get("ingestTextMaxChars", 32000))

    @property
    def daily_llm_limit(self) -> int:
        # Legacy cloud budget: 2 memory-review LLM requests/day, separate from
        # slang. Preserve the default unless explicitly configured otherwise
        # (CONTRACT_REVIEW item 4).
        return int(self.reflection.get("dailyLlmCalls", 2))

    @property
    def trigger_messages(self) -> int:
        return int(self.reflection.get("triggerMessages", 20))

    @property
    def quiet_seconds(self) -> int:
        return int(self.reflection.get("quietSeconds", 600))

    @property
    def reflection_chunk_messages(self) -> int:
        return int(self.reflection.get("chunkMessages", 60))

    @property
    def reflection_max_window_chars(self) -> int:
        # REVIEW item 4: bound the summary *input*, not the retained evidence.
        return int(self.reflection.get("maxWindowChars", 12000))

    @property
    def decay_interval_seconds(self) -> float:
        return float(self.reflection.get("decayIntervalSeconds", 3600.0))


_DEFAULT_LIMITS = {
    "bodyMaxBytes": 2 * 1024 * 1024,
    "ingestTextMaxChars": 32000,
    "recallQueryMaxChars": 2000,
    "kMax": 12,
    "recallMaxChars": 1600,
    "ingestBatchMax": 64,
}


def load_config(env: dict[str, str] | None = None) -> SidecarConfig:
    e = dict(os.environ if env is None else env)
    mode = (e.get("LM_MODE") or "production").strip().lower()
    if mode not in ("test", "production"):
        raise ConfigError("LM_MODE must be 'test' or 'production'")

    cfg_file = e.get("LM_CONFIG_FILE")
    doc: dict[str, Any] = {}
    if cfg_file:
        doc = json.loads(Path(cfg_file).read_text(encoding="utf-8"))

    if mode == "test":
        # Deterministic segregation: no external provider endpoints at all.
        emb = ProviderConfig(kind="deterministic-hash", dim=int(doc.get("embedding", {}).get("dim", 64)))
        llm = ProviderConfig(kind="scripted")
    else:
        emb_doc = doc.get("embedding", {})
        llm_doc = doc.get("llm", {})
        kind = emb_doc.get("kind", "openai-compatible")
        if kind == "openai-compatible":
            key = _read_secret(
                e.get(emb_doc.get("apiKeyEnv", "LM_EMBEDDING_API_KEY")),
                _read_env_name(e, emb_doc.get("apiKeyFileEnv", "LM_EMBEDDING_API_KEY_FILE")),
                "embedding.apiKey",
            )
            emb = ProviderConfig(
                kind,  # ProviderConfig positional: kind, base_url, [creds], model, dim
                e.get(emb_doc.get("baseUrlEnv", "LM_EMBEDDING_BASE_URL"), "") or emb_doc.get("baseUrl", ""),
                key or "",
                e.get(emb_doc.get("modelEnv", "LM_EMBEDDING_MODEL"), "") or emb_doc.get("model", ""),
                int(emb_doc.get("dim", 64)),
                float(emb_doc.get("timeoutSeconds", 30.0)),
            )
        else:
            emb = ProviderConfig(kind=kind, dim=int(emb_doc.get("dim", 64)))
        lkind = llm_doc.get("kind", "openai-compatible")
        if lkind == "openai-compatible":
            lkey = _read_secret(
                e.get(llm_doc.get("apiKeyEnv", "LM_LLM_API_KEY")),
                _read_env_name(e, llm_doc.get("apiKeyFileEnv", "LM_LLM_API_KEY_FILE")),
                "llm.apiKey",
            )
            llm = ProviderConfig(
                lkind,  # positional: kind, base_url, [creds], model
                e.get(llm_doc.get("baseUrlEnv", "LM_LLM_BASE_URL"), "") or llm_doc.get("baseUrl", ""),
                lkey or "",
                e.get(llm_doc.get("modelEnv", "LM_LLM_MODEL"), "") or llm_doc.get("model", ""),
                64,
                float(llm_doc.get("timeoutSeconds", 60.0)),
                int(llm_doc.get("maxOutputTokens", 1024)),
            )
        else:
            llm = ProviderConfig(kind=lkind)

    data_dir = Path(e.get("LM_DATA_DIR") or doc.get("dataDir") or Path(__file__).resolve().parent.parent / "data")
    if mode == "test" and not e.get("LM_DATA_DIR"):
        raise ConfigError("LM_DATA_DIR is required in test mode (keeps data inside the write scope)")

    bridge = _read_secret(
        e.get("LM_BRIDGE_TOKEN"), e.get("LM_BRIDGE_TOKEN_FILE"), "bridge token"
    )
    operator = _read_secret(
        e.get("LM_OPERATOR_TOKEN"), e.get("LM_OPERATOR_TOKEN_FILE"), "operator token"
    )
    if not bridge or not operator:
        raise ConfigError("LM_BRIDGE_TOKEN(_FILE) and LM_OPERATOR_TOKEN(_FILE) are required")
    if bridge == operator:
        raise ConfigError("bridge and operator tokens must differ")

    bind = e.get("LM_BIND") or doc.get("bind") or "127.0.0.1"
    port = int(e.get("LM_PORT") or doc.get("port") or 8765)
    if mode == "test" and bind not in ("127.0.0.1", "localhost", "::1"):
        raise ConfigError("test mode binds loopback only")

    limits = dict(_DEFAULT_LIMITS)
    limits.update(doc.get("limits", {}))

    return SidecarConfig(
        mode,
        bind,
        port,
        data_dir,
        str(doc.get("personaId") or "amiya"),
        str(doc.get("botUserId") or ""),
        bridge,  # SidecarConfig field 7: bearer string for the bridge role
        operator,  # field 8: bearer string for the operator role
        emb,
        llm,
        limits,
        doc.get("reflection", {}),
        doc.get("sharedIdentity", {"enabled": False}),
        doc.get("engine", {}),
    )


def _read_env_name(e: dict[str, str], var: str) -> str | None:
    """``apiKeyFileEnv`` names an env var that *contains a path* to the secret."""
    target = e.get(var)
    return target or None
