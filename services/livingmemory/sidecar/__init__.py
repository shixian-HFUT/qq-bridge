"""LivingMemory sidecar for the cloud Amiya QQ bridge.

Hosts the pinned upstream LivingMemory engine (v2.8.2, AGPL-3.0, vendored under
``vendor/astrbot_plugin_livingmemory``) behind a private, versioned HTTP
contract (see ../CONTRACT.md). This package is original integration glue:
no upstream file is modified; upstream code is imported unchanged.
"""

CONTRACT_VERSION = 1
ENGINE_VERSION = "2.8.2"
