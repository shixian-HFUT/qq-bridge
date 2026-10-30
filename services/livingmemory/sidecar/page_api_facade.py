"""Facade that lets the REAL upstream page handlers run against the sidecar
runtime: a duck-typed `plugin` object exposing `initializer`,
`config_manager` and `_ensure_plugin_ready`, plus the upstream
PluginPageApi whose handlers are reused unmodified for the read-side routes.

Nothing here fabricates Quart request globals — handlers are invoked inside
the mounted Quart app's genuine request context (sidecar/page_bridge.py).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .engine import install_vendor_package
from .host_mutations import GuardedEngine

# Expose only settings consumed by this runtime. Access, providers, injection
# policy and budgets stay host-bound, outside the operator page.
UI_ENGINE_FIELDS = {
    **{f"recall_engine.{key}": key for key in (
        "importance_weight", "min_importance_for_retrieval", "min_similarity_for_retrieval",
        "recent_memory_count", "recent_memory_max_age_hours", "memory_type_filter",
        "fusion_mode", "fusion_bm25_weight", "fusion_agreement_bonus", "recall_candidate_multiplier",
        "search_cache_enabled", "search_cache_ttl_seconds", "search_cache_max_size")},
    "recall_engine.fallback_to_vector": "fallback_enabled",
    "graph_memory.enabled": "graph_memory_enabled",
    "graph_memory.document_route_weight": "document_route_weight",
    "graph_memory.graph_route_weight": "graph_route_weight",
    "graph_memory.cross_route_bonus": "cross_route_bonus",
    "graph_memory.expansion_limit": "graph_expansion_limit",
    "graph_memory.expansion_hops": "graph_expansion_hops",
    "graph_memory.second_hop_weight": "graph_second_hop_weight",
    "graph_memory.dynamic_route_weighting": "dynamic_route_weighting",
    "graph_memory.max_topics_per_memory": "graph_max_topics",
    "graph_memory.max_participants_per_memory": "graph_max_participants",
    "graph_memory.max_facts_per_memory": "graph_max_facts",
    "graph_memory.atom_enabled": "atom_enabled",
    "graph_memory.atom_maintenance_interval_hours": "atom_maintenance_interval_hours",
    "graph_memory.atom_forget_delay_days": "atom_forget_delay_days",
    "graph_memory.atom_purge_delay_days": "atom_purge_delay_days",
}


def engine_ui_overrides(data_dir: Path) -> dict[str, Any]:
    saved = load_persisted_ui_config(data_dir)
    result = {}
    for path, target in UI_ENGINE_FIELDS.items():
        value: Any = saved
        for part in path.split("."):
            value = value.get(part) if isinstance(value, dict) else None
        if value is not None:
            result[target] = value
    if "atom_enabled" in result:
        result["graph_memory_atom_enabled"] = result["atom_enabled"]
    return result


class _PersistedPluginConfig(dict):
    def __init__(self, data_dir: Path):
        super().__init__(load_persisted_ui_config(data_dir))
        self.path = Path(data_dir) / "ui_plugin_config.json"

    def save_config(self):
        temporary = self.path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(self, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.path)


class _InitializerFacade:
    def __init__(self, runtime) -> None:
        from astrbot_plugin_livingmemory.core.validators.index_validator import IndexValidator

        self._runtime = runtime
        self.memory_engine = GuardedEngine(runtime)
        self.conversation_manager = runtime.conversation
        self.memory_processor = runtime.processor
        self.index_validator = IndexValidator(
            str(Path(runtime.config.data_dir) / "livingmemory.db"), runtime.engine.db_connection)
        self.data_dir = str(runtime.config.data_dir)
        self._consolidation = None

    @property
    def consolidation_manager(self):
        if self._consolidation is None:
            from astrbot_plugin_livingmemory.core.managers.consolidation_manager import (
                MemoryConsolidationManager,
            )

            self._consolidation = MemoryConsolidationManager(
                self._runtime.engine,
                self._runtime.processor,
                self.config_manager,
            )
        return self._consolidation

    config_manager: Any = None  # set by build_page_api_facade


class _PluginFacade:
    def __init__(self, runtime, config_manager) -> None:
        self.initializer = _InitializerFacade(runtime)
        self.config_manager = config_manager
        self.initializer.config_manager = config_manager

    async def _ensure_plugin_ready(self):
        if self.initializer._runtime.state != "ready":
            return False, "引擎尚未就绪"
        return True, None


def load_persisted_ui_config(data_dir: Path) -> dict[str, Any]:
    path = Path(data_dir) / "ui_plugin_config.json"
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                return loaded
        except (ValueError, OSError):
            pass
    return {}


def persist_ui_config(data_dir: Path, values: dict[str, Any]) -> None:
    path = Path(data_dir) / "ui_plugin_config.json"
    merged = load_persisted_ui_config(Path(data_dir))
    for dotted, value in values.items():
        cursor: dict[str, Any] = merged
        parts = str(dotted).split(".")
        for part in parts[:-1]:
            child = cursor.get(part)
            if not isinstance(child, dict):
                child = {}
                cursor[part] = child
            cursor = child
        cursor[parts[-1]] = value
    path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")


def build_page_api_facade(runtime, config):
    """Returns (plugin, page_api, config_manager). Import is deferred so the
    vendor namespace package is installed first."""
    install_vendor_package()
    from astrbot_plugin_livingmemory.core.base.config_manager import ConfigManager
    from astrbot_plugin_livingmemory.core.page_api import PluginPageApi

    config_manager = ConfigManager(_PersistedPluginConfig(Path(config.data_dir)))
    plugin = _PluginFacade(runtime, config_manager)
    page_api = PluginPageApi(plugin)
    return plugin, page_api, config_manager
