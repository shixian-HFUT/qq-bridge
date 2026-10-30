"""Entry: ``python -m sidecar`` (env-driven config, see CONTRACT §12)."""

from __future__ import annotations

import uvicorn

from .app import build_app
from .config import load_config
from .engine import SidecarRuntime


def main() -> None:
    config = load_config()
    runtime = SidecarRuntime(config)
    app = build_app(config, runtime)
    uvicorn.run(app, host=config.bind, port=config.port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
