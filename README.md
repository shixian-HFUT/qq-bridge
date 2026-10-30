# QQ Bridge · 阿米娅维护分支

基于 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的个人维护版本，保留上游版权和贡献历史。当前长期维护分支为 `codex/amiya-production`，原 `main` 和上游 PR 分支保留。

本分支整理当前机器人使用的 SnowLuma → Node 桥接 → Pi 聊天链路，以及 LivingMemory 独立记忆服务。仓库包含源码、角色卡、预设、依赖锁文件、部署模板与离线回归；真实账号、凭据、聊天和记忆库不随源码分发。

## 当前能力

- 群聊/私聊与可信 ownerQQ 绑定、白名单、唤醒与气泡预算、忙碌恢复。
- Pi 运行时、简化工具、上下文预算、图片/表情、语音及工具循环保护。
- LivingMemory 2.8.2：BM25/FAISS/图谱、带来源的记忆、自动召回、主动查询与原话证据、更正和遗忘、中文管理页。
- 阿米娅角色卡，包含博士关系、群私一致的表达及有上下文依据的小情绪。角色示例不代表真实聊天记录。

## 从干净目录启动

需要 Node **22.19 或更新的 22.x**。QQ 网关单独安装并配置 OneBot WebSocket；本仓库不分发 SnowLuma 本体或登录数据。

```sh
git clone --branch codex/amiya-production https://github.com/shixian-HFUT/qq-bridge.git
cd qq-bridge
npm ci
npm run setup:pi
npm run init:amiya
```

编辑生成的 `config.json`：填写 `ownerQQ` 和允许会话，核对网关地址、Pi 提供商地址与模型。空白名单默认拒绝所有会话。`config.amiya.example.json` 是本分支入口；`config.example.json` 保留传统 DSH 示例。

启动前在当前进程环境设置 `APIMART_API_KEY`，或使用 `pi.credentialSource="file"` / `pi.credentialFile` 指定私有 env 文件。凭据文件每行格式为 `APIMART_API_KEY=...`，不提交到仓库。随后执行 `npm start`；控制台默认监听本机 3100 端口。

`init:amiya` 只创建缺少的配置和角色/模式文件，已有文件保留。首次初始化启用阿米娅和 `reserved2`，不连接 QQ，不调用模型。

LivingMemory 在示例中默认关闭，准备好独立服务与令牌后再启用，见 [部署说明](docs/AMIYA_DEPLOYMENT.md)。

## 维护入口

- [架构与当前基线](docs/AMIYA_CURRENT.md)
- [部署、凭据与数据恢复](docs/AMIYA_DEPLOYMENT.md)
- [测试及验证范围](docs/AMIYA_TESTING.md)
- [源码来源与组件许可](docs/AMIYA_UPSTREAM.md)
- [LivingMemory 服务](services/livingmemory/README.md)
- [生产源码哈希与发布调整](docs/production-source-manifest.json)
- [既有功能文档索引](docs/README.md)（包含历史 DSH/本机版本说明，具体启动以本页为准）

桥接代码保留 [MIT](LICENSE)。LivingMemory 及相关服务按其 [NOTICE](services/livingmemory/NOTICE.md) 和 [上游许可证](services/livingmemory/vendor/astrbot_plugin_livingmemory/LICENSE) 分别记录；根 MIT 不替代这些组件的许可。
