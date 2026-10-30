# LivingMemory 独立记忆服务

主分支提供可单独部署的 HTTP 记忆组件，目录为 `services/livingmemory/`。它运行真实 LivingMemory 2.8.2 引擎，包含 BM25/FAISS/图谱、原话来源、修订/遗忘、有界自动整理和上游中文管理页。

现有 `main` 的聊天桥接继续使用当前后端与配置。完整 QQ 接入适配和阿米娅角色在 [`codex/amiya-production`](https://github.com/shixian-HFUT/qq-bridge/tree/codex/amiya-production)；在 `main` 中添加记忆配置字段不会自动安装该适配。

## 接口与授权

接口定义见 [CONTRACT.md](../../services/livingmemory/CONTRACT.md)。宿主负责 QQ 白名单和当前会话授权，通过 bridge token 调用摄入、召回、记忆及证据接口；管理操作使用独立 operator token。记忆请求绑定 scope，来源及归属用于更正、遗忘和跨会话隔离。自动摘要不能恢复已被遗忘的来源。

服务监听本机回环，`GET /v1/health` 返回最小健康状态，`/ui/login` 提供 operator 登录。凭据仅放在环境或私有文件引用中，不放进模型工具参数、URL 或日志。导入的受保护记录由宿主授权编辑器管理。

## Linux Docker 部署

先复制 `services/livingmemory/config/service.example.json` 为同目录的 `service.json`，填写自己的机器人 userId、personaId、提供商地址和模型。embedding 的 `dim` 必须匹配所选模型，后续改变模型需要重建索引。

在仓库根的 `secrets/` 准备四个文件：

- `lm_bridge_token.txt`：宿主服务令牌。
- `lm_operator_token.txt`：不同于 bridge token 的管理令牌。
- `lm_embedding_key.txt`：向量提供商密钥。
- `lm_llm_key.txt`：自动整理提供商密钥。

创建 `state/livingmemory/` 并允许容器 UID/GID 10001 读写。配置文件和令牌需允许该容器用户读取，但不对其他无关用户开放。上述运行配置、凭据和数据均被 Git 忽略。

```sh
docker compose -f deploy/memory-service.yml config --quiet
docker compose -f deploy/memory-service.yml up -d --build
```

模板使用 Linux host 网络、`127.0.0.1:8765`、只读容器根目录、可写运行时 tmpfs、512 MiB 和 1 CPU。服务配置挂载为只读。远程管理使用自己的 SSH 端口转发访问本机管理页。

直接运行需 Python 3.12，安装服务 `requirements.lock.txt`，指定 `LM_MODE=production`、`LM_CONFIG_FILE`、数据目录和四个凭据文件的 `*_FILE` 环境变量，然后在服务目录执行 `python -X utf8 -B -m sidecar`。

## 验证与备份

在服务目录运行：

```sh
python -m pip install -r requirements.lock.txt pytest==9.2.0
python -X utf8 -B -m pytest
```

31 项测试使用真实索引引擎、合成数据与替身提供商，不调用真实 QQ 或付费模型。测试临时文件位于被忽略的 `.test-tmp/`。`Memory service regression` 工作流检查主分支上的服务和部署改动。

侧车的完整备份包括元数据、预算、墓碑、会话、SQLite、刷盘的 FAISS 和受支持设置；通过受保护接口生成并校验。恢复需要离线执行，不能用旧备份覆盖新的遗忘或预算。源码仓库不包含这些数据，本文也不代表完成真实数据恢复演练。

## 来源

上游版本固定为 2.8.2、提交 `a1e9c20a8c5fab93d6143f51be26fb1bbf8143ec`。174 个 vendor 文件及完整管理页随服务保存，逐文件哈希见 `vendor/VENDOR_MANIFEST.json`。保留原引擎字节、来源、AGPL 许可证及 [NOTICE](../../services/livingmemory/NOTICE.md)；根桥接 MIT 文件不替代服务组件的声明。
