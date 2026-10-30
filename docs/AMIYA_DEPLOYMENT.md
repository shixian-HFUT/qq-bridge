# 部署与数据

## 本机进程

按根 README 安装两套 Node 依赖并运行 `npm run init:amiya`。该命令不会覆盖已有 `config.json`、`state/current-role.json`、`state/mode.json` 或服务配置。填写真实 ownerQQ、允许会话与网关地址，在当前进程提供 `APIMART_API_KEY`，然后 `npm start`。

`roles/` 和 `dsh/agent-presets/` 保持根布局，以免改变运行时相对路径。旧 Windows 启动脚本可能面向传统 DSH，请以 `npm start` 为当前入口。

## Linux Docker 模板

Compose 使用宿主网络。QQ 网关由部署者单独启动；控制台与记忆服务使用回环地址。

先在主机执行初始化，创建 `secrets/`，将 `deploy/provider.env.example` 复制到 `secrets/provider.env` 并填写自己的提供商密钥。该目录被 Git 和 Docker 构建上下文排除。根 `config.json`、`state/`、`secrets/` 通过挂载提供：

```sh
docker compose -f deploy/compose.yml up -d --build bridge
```

这份 Compose 是新部署模板，未替换现有服务器 Compose。部署前核对端口、路径、资源和网关兼容性；不要把现有运行目录直接覆盖成示例。

## 启用 LivingMemory

初始化已复制 `services/livingmemory/config/service.example.json` 到被忽略的 `service.json`。填写机器人 userId、embedding 模型/维度及聊天模型；改变 embedding 模型需要匹配维度并重建索引。

在 `secrets/` 中准备四个文件：`lm_bridge_token.txt`、`lm_operator_token.txt`、`lm_embedding_key.txt`、`lm_llm_key.txt`。前两者用不同的随机值，后两者为相应提供商密钥。仅将凭据文件路径写入配置。

创建 `state/livingmemory/` 并让容器用户 UID/GID 10001 可写。在根 `config.json` 的 `socialV2.memory.livingMemory` 开启服务，保留回环地址和正确的令牌文件引用。侧车由 `memory` profile 启动：

```sh
docker compose -f deploy/compose.yml --profile memory up -d --build
```

侧车监听 `127.0.0.1:8765`，健康接口 `/v1/health`，管理页 `/ui/login`。远程管理通过自己的 SSH 本机端口转发，使用 operator 令牌登录；bridge 令牌不能访问管理面。服务失败时桥接回退本地记忆，并保留有界持久队列。

## 更新与恢复

源码版本不能替代数据备份。更新前分别保存当前 commit/镜像、私有配置、桥接 `state/`，以及通过侧车受保护备份接口生成的完整数据包。运行中的 SQLite 和 FAISS 不应仅靠随手复制目录取得一致备份。

侧车备份包含元数据、预算、墓碑、会话、SQLite、已刷盘的 FAISS 及受支持设置；恢复在停止服务后按验证过的完整流程进行。更正/遗忘会撤回相关自动摘要，旧备份不能自动覆盖新的遗忘或预算状态。

回退源码时保留现有账号、白名单、模型、会话和记忆；不要整份恢复过时配置。此源码整理没有对真实数据执行备份恢复演练。
