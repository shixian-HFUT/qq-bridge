"""Standalone operator UI + native page-API bridge (FINAL_SLICE).

Serves the UNMODIFIED upstream 2.8.2 dashboard (`vendor/.../pages/dashboard`)
through a small compatibility bridge implementing `window.AstrBotPluginView`
(ready/getContext/apiGet/apiPost/onContext) and mounts the real upstream
`core/page_api.py` handlers inside a genuine Quart ASGI request context —
no fake request globals. The Quart app is mounted under the FastAPI service at
`/astrbot_plugin_livingmemory`, so the UI and APIs are same-origin.

Auth: operator-only via a short-lived HttpOnly SameSite=Strict cookie session
(`POST /v1/ui/login` with the operator token once; the token never appears in
URLs, page source or logs). Bridge tokens are rejected here. Mutations are
routed through host-authority semantics (sidecar/host_mutations.py): revisions,
scoped identity tombstones and source invalidation are registered exactly like
the CONTRACT §5/§6 routes; native consolidation/resummarize runs are wrapped
by an external-ledger guard so legacy-imported entries the engine retires
become tombstones and can never be resurrected by reconcile.
"""

from __future__ import annotations

import hmac
import json
import mimetypes
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from quart import Quart
from quart import request as quart_request

from .host_mutations import (
    _PROTECTED_IMPORT_NOTE,
    _meta_of,
    settle_external_guard,
    snapshot_external,
    ui_batch_delete,
    ui_update_memory,
)
from .page_api_facade import UI_ENGINE_FIELDS, build_page_api_facade

PAGE_URL_ROOT = "/astrbot_plugin_livingmemory"
UI_SESSION_COOKIE = "lm_ui_session"
UI_SESSION_TTL_SECONDS = 1800

_dashboard_root_cache: Path | None = None


def dashboard_root() -> Path:
    global _dashboard_root_cache
    if _dashboard_root_cache is None:
        import astrbot_plugin_livingmemory as _pkg

        _dashboard_root_cache = Path(_pkg.__file__).resolve().parent / "pages" / "dashboard"
    return _dashboard_root_cache


# ── operator cookie session (no token in URLs / page source / logs) ──────────


def _ui_login_page(message: str = "") -> str:
    note = f'<p class="m">{message}</p>' if message else ""
    return (
        "<!doctype html><meta charset='utf-8'><title>LivingMemory 控制台登录</title>"
        "<style>body{font-family:system-ui;max-width:32rem;margin:6rem auto;padding:0 1rem}"
        "input{width:100%;padding:.5rem;margin:.5rem 0}button{padding:.5rem 1rem}"
        ".m{color:#a33}</style><h2>LivingMemory 运维控制台</h2>" + note +
        "<form method='post' action='/v1/ui/login'>"
        "<input type='password' name='token' placeholder='操作员令牌' autocomplete='off'>"
        "<button type='submit'>进入</button></form>"
    )


class _UiRoutes:
    """FastAPI side: login/logout + static dashboard + bridge.js injection."""

    def __init__(self, app: FastAPI, config, runtime) -> None:
        self.config = config
        self.runtime = runtime
        self.app = app
        self._register()

    def session_valid(self, request: Request) -> bool:
        sid = request.cookies.get(UI_SESSION_COOKIE, "")
        if sid:
            raw = self.runtime.meta.get_kv(f"ui:session:{sid}")
            if raw and float(raw) > time.time():
                return True
        header = request.headers.get("authorization", "")
        if header.startswith("Bearer "):
            token = header[7:]
            if self.config.operator_creds and hmac.compare_digest(token, self.config.operator_creds):
                return True
        return False

    def create_session(self) -> str:
        import secrets as _secrets

        sid = _secrets.token_urlsafe(24)
        self.runtime.meta.set_kv(f"ui:session:{sid}", str(time.time() + UI_SESSION_TTL_SECONDS))
        return sid

    def destroy_session(self, sid: str) -> None:
        self.runtime.meta.remove_kv(f"ui:session:{sid}")

    def _register(self) -> None:
        app = self.app

        @app.get("/ui/login", response_class=HTMLResponse)
        async def ui_login_form():
            return HTMLResponse(_ui_login_page())

        @app.post("/v1/ui/login")
        async def ui_login(request: Request):
            token = ""
            ctype = (request.headers.get("content-type") or "").lower()
            if "application/json" in ctype:
                try:
                    token = str((await request.json()).get("token", ""))
                except (ValueError, AttributeError):
                    token = ""
            elif "application/x-www-form-urlencoded" in ctype:
                from urllib.parse import parse_qs

                form = parse_qs((await request.body()).decode("utf-8"), max_num_fields=4)
                token = form.get("token", [""])[0]
            if not (self.config.operator_creds and token
                    and hmac.compare_digest(token, self.config.operator_creds)):
                return HTMLResponse(_ui_login_page("令牌无效"), status_code=401)
            sid = self.create_session()
            response = (JSONResponse({"ok": True, "redirect": "/ui/"})
                        if "application/json" in ctype else RedirectResponse("/ui/", status_code=303))
            response.set_cookie(UI_SESSION_COOKIE, sid, max_age=UI_SESSION_TTL_SECONDS,
                                httponly=True, samesite="strict", path="/")
            return response

        @app.post("/v1/ui/logout")
        async def ui_logout(request: Request):
            sid = request.cookies.get(UI_SESSION_COOKIE, "")
            if sid:
                self.destroy_session(sid)
            response = JSONResponse({"ok": True})
            response.delete_cookie(UI_SESSION_COOKIE, path="/")
            return response

        @app.get("/ui")
        @app.get("/ui/")
        async def ui_index(request: Request):
            return self._serve(request, "index.html", inject_bridge=True)

        @app.get("/ui/bridge.js")
        async def ui_bridge(request: Request):
            if not self.session_valid(request):
                return JSONResponse({"error": "unauthorized"}, status_code=401)
            return Response(_BRIDGE_JS, media_type="application/javascript")

        @app.get("/ui/{tail:path}")
        async def ui_static(request: Request, tail: str):
            return self._serve(request, tail, inject_bridge=False)

    def _serve(self, request: Request, tail: str, inject_bridge: bool) -> Response:
        if not self.session_valid(request):
            accept = request.headers.get("accept", "")
            if "text/html" in accept:
                return RedirectResponse("/ui/login", status_code=302)
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        root = dashboard_root().resolve()
        target = (root / tail).resolve() if tail else (root / "index.html")
        if not target.is_relative_to(root) or not target.is_file():
            return JSONResponse({"error": "not found"}, status_code=404)
        body = target.read_bytes()
        media = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if inject_bridge and target.name == "index.html":
            text = body.decode("utf-8")
            import re
            text = re.sub(r'<p class="settings-note"[^>]*>.*?</p>',
                '<p class="settings-note">仅显示此接入支持的检索与图谱参数；保存后重启记忆服务生效。'
                '会话隔离、模型、凭据及整理预算由机器人配置管理。</p>', text, count=1)
            snippet = '<script src="./bridge.js"></script>\n'
            marker = '<script type="module"'
            if marker in text:
                text = text.replace(marker, snippet + marker, 1)
            else:
                text = text.replace("</body>", snippet + "</body>", 1)
            body = text.encode("utf-8")
            media = "text/html"
        return Response(body, media_type=media)


_BRIDGE_JS = """(function () {
  'use strict';
  var BASE = '/astrbot_plugin_livingmemory';
  var context = {
    pluginName: 'astrbot_plugin_livingmemory',
    apiPrefix: BASE + '/page',
    locale: 'zh-CN',
    standalone: true,
    dashboardVersion: '2.8.2',
    features: { agenticRecall: true }
  };
  var listeners = [];
  function call(method, endpoint, params, body) {
    var url = BASE + '/' + String(endpoint).replace(/^\\/+/, '');
    if (params && Object.keys(params).length) {
      url += '?' + new URLSearchParams(params).toString();
    }
    var init = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined && body !== null) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (r) {
      if (r.status === 401) { window.location.href = '/ui/login'; throw new Error('unauthorized'); }
      return r.json();
    });
  }
  window.AstrBotPluginView = {
    ready: function () { return Promise.resolve(context); },
    getContext: function () { return context; },
    onContext: function (fn) { if (typeof fn === 'function') { listeners.push(fn); try { fn(context); } catch (e) {} } },
    apiGet: function (endpoint, params) { return call('GET', endpoint, params || {}, null); },
    apiPost: function (endpoint, body) { return call('POST', endpoint, null, body || {}); },
    logout: function () {
      return fetch('/v1/ui/logout', { method: 'POST', credentials: 'same-origin' }).then(function () {
        window.location.href = '/ui/login';
      });
    }
  };
})();
"""


# ── Quart sub-app: the real upstream page handlers under a real ASGI
#    request context ────────────────────────────────────────────────────────

_DISABLED = {"status": "error",
             "message": "导入已被禁用：记忆写入唯一权威入口是 /v1/admin/reconcile（宿主修订/CAS/tombstone 语义），UI 不允许绕过"}


def build_quart_page_app(runtime) -> Quart:
    from astrbot_plugin_livingmemory.core.page_api import PAGE_API_PREFIX

    suffix = PAGE_API_PREFIX[len(PAGE_URL_ROOT):]  # "/page"
    quart_app = Quart(__name__)
    _plugin, pageapi, config_manager = build_page_api_facade(runtime, runtime.config)
    utils = pageapi.utils
    runtime.page_facade = pageapi

    @quart_app.before_request
    async def _auth():
        if runtime.page_session_valid():
            return None
        return {"status": "error", "message": "未授权"}, 401

    read_get = {
        "stats": lambda: pageapi.get_stats(),
        "memories": lambda: pageapi.list_memories(),
        "memories/detail": lambda: pageapi.get_memory_detail(),
        "graph/overview": lambda: pageapi.get_graph_overview(),
        "backups": lambda: pageapi.list_backups(),
        "prompts": lambda: pageapi.list_prompts(),
        "prompts/detail": lambda: pageapi.get_prompt_detail(),
        "prompts/default": lambda: pageapi.get_prompt_default(),
        "config": lambda: _settings_config(runtime, pageapi),
        "consolidation/status": lambda: pageapi.get_consolidation_status(),
    }
    read_post = {
        "graph/query": lambda: pageapi.query_graph(),
        "memories/export": lambda: pageapi.export_memories(),
    }
    async def _update_payload():
        async with runtime.write_barrier:
            return await ui_update_memory(runtime, utils, await quart_request.get_json(silent=True) or {})

    async def _delete_payload():
        async with runtime.write_barrier:
            return await ui_batch_delete(runtime, utils, await quart_request.get_json(silent=True) or {})

    async def _batch_update_payload():
        async with runtime.write_barrier:
            return await _ui_batch_update(runtime, utils, await quart_request.get_json(silent=True) or {})

    mutation_post = {
        "memories/update": _update_payload,
        "memories/batch-delete": _delete_payload,
        "memories/batch-update": _batch_update_payload,
        "recall/test": lambda: pageapi.test_recall(),
        "consolidation/run": lambda: _guarded_consolidation(runtime, pageapi),
        "memories/resummarize": lambda: _guarded_resummarize(runtime, pageapi),
        "prompts/update": lambda: pageapi.update_prompt(),
        "prompts/reset": lambda: pageapi.reset_prompt(),
        "config/update": lambda: _update_config(runtime, pageapi, config_manager),
    }
    async def _ui_batch_update(runtime_, utils_, payload):
        memory_ids = payload.get("memory_ids", [])
        field = str(payload.get("field", "")).strip()
        value = payload.get("value")
        if not isinstance(memory_ids, list) or not memory_ids or field not in {"importance", "type", "status"}:
            return utils_.error("需要 memory_ids 列表与受支持 field(importance/type/status)")
        updated = 0
        for raw_id in memory_ids:
            result = await ui_update_memory(runtime_, utils_,
                                            {"memory_id": raw_id, "field": field, "value": value,
                                             "reason": payload.get("reason", "")})
            if result.get("status") == "ok":
                updated += 1
        return utils_.ok({"updated_count": updated, "total": len(memory_ids)})

    def _protected_import_present(runtime_) -> bool:
        # UI_AUTHORITY item 3: consolidation merges/deletes engine rows it
        # cannot host-track. While reconcile-imported rows exist (owned by the
        # legacy Node store until cutover) it must fail clearly, not mutate
        # authority-owned rows or silently tombstone them.
        for row in runtime_.meta.list_active_externals():
            if str(row.get("kind") or "") not in ("explicit", "reflection") \
                    and str(row.get("state") or "") == "active" and row.get("memory_id") is not None:
                return True
        return False

    async def _guarded_consolidation(runtime_, pageapi_):
        if _protected_import_present(runtime_):
            return {"status": "error", "message": _PROTECTED_IMPORT_NOTE + "（存在迁移导入记忆时禁止运行合并）"}
        async with runtime_.write_barrier:
            before = await snapshot_external(runtime_)
            result = await pageapi_.run_consolidation()
            settled = await settle_external_guard(runtime_, before, "ui-consolidation")
        if isinstance(result, dict) and result.get("status") == "ok" and isinstance(result.get("data"), dict):
            result["data"]["hostTombstones"] = settled
        return result

    async def _guarded_resummarize(runtime_, pageapi_):
        payload = await quart_request.get_json(silent=True) or {}
        try:
            target_id = int(payload.get("memory_id"))
        except (TypeError, ValueError):
            target_id = 0
        if target_id:
            record = await runtime_.engine.get_memory_record(target_id)
            if record and str((_meta_of(record)).get("origin") or "") == "imported":
                return {"status": "error", "message": _PROTECTED_IMPORT_NOTE}
        async with runtime_.write_barrier:
            before = await snapshot_external(runtime_)
            result = await pageapi_.resummarize_memory()
            settled = await settle_external_guard(runtime_, before, "ui-resummarize")
        if isinstance(result, dict) and result.get("status") == "ok" and isinstance(result.get("data"), dict):
            result["data"]["hostTombstones"] = settled
        return result

    async def _update_config(runtime_, pageapi_, config_manager):
        payload = await quart_request.get_json(silent=True) or {}
        values = payload.get("values")
        allowed = {path for path, key in UI_ENGINE_FIELDS.items()
                   if key not in runtime_.config.engine_overrides}
        if not isinstance(values, dict) or not values or set(values) - allowed:
            return utils.error("仅可修改页面列出的检索与图谱参数；宿主配置项不可在此修改")
        result = await pageapi_.update_settings_config()
        if isinstance(result, dict) and result.get("status") == "ok":
            result["data"]["restartRequired"] = True
        return result

    async def _settings_config(runtime_, pageapi_):
        result = await pageapi_.get_settings_config()
        if result.get("status") != "ok":
            return result
        sections = []
        for section in result.get("data", {}).get("sections", []):
            fields = []
            for field in section.get("fields", []):
                key = UI_ENGINE_FIELDS.get(field["path"])
                if key and key not in runtime_.config.engine_overrides:
                    field["value"] = runtime_.engine.config.get(key, field.get("value"))
                    fields.append(field)
            if fields:
                sections.append({**section, "fields": fields})
        result["data"]["sections"] = sections
        return result

    def _register(app, methods: dict, verb: str):
        for subpath, fn in methods.items():
            rule = f"{suffix}/{subpath}"

            async def handler(_fn=fn):
                payload = await _fn()
                if isinstance(payload, tuple):  # before_request auth short-circuit
                    body, code = payload
                    return quart_app.response_class(json.dumps(body), status=code,
                                                   mimetype="application/json")
                if isinstance(payload, dict):
                    return payload
                return payload

            app.add_url_rule(rule, subpath.replace("/", "_") + verb, handler, methods=[verb])

    _register(quart_app, read_get, "GET")
    _register(quart_app, dict(read_post, **mutation_post), "POST")

    @quart_app.route(f"{suffix}/memories/import", methods=["POST"])
    async def _disabled_import():
        return _DISABLED

    return quart_app


def install_page_layer(app: FastAPI, config, runtime) -> None:
    """Wire UI routes + the mounted Quart page API into the sidecar app."""
    routes = _UiRoutes(app, config, runtime)
    app.state.ui_routes = routes
    # Runtime helper used by the Quart before_request (cookie/Bearer checks run
    # against the Quart request; we translate its headers/cookies locally).
    def _quart_session_valid() -> bool:
        cookie = quart_request.cookies.get(UI_SESSION_COOKIE, "")
        if cookie:
            raw = runtime.meta.get_kv(f"ui:session:{cookie}")
            if raw and float(raw) > time.time():
                return True
        header = quart_request.headers.get("Authorization", "")
        if header.startswith("Bearer ") and config.operator_creds:
            return hmac.compare_digest(header[7:], config.operator_creds)
        return False

    runtime.page_session_valid = _quart_session_valid
    app.mount(PAGE_URL_ROOT, build_quart_page_app(runtime))
