# Fork 更新：0.3.1（2026-10-24）

本次在此前 Pi 后端版本上整理了后续通用代码。上游项目为 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，继续使用原项目 MIT 许可与署名。这里的版本号属于本 fork；DSH 仍为默认后端，不表示重新验证过最新版 DSH 或所有云端模型。

## 更新内容

- Pi：图片内容按哈希独立落盘，减少会话 JSON 膨胀；空闲时归档较老回合，修复重启后的工具配对和图片拒绝记录；成功发送且确认水位后结束本轮。
- 记忆：SQLite 保存有消息来源的事实、事件和交流经验，支持更新版本、删除、检索及本会话原文查询。自动注入有长度上限；黑话学习受每日请求预算约束。
- 群聊：按真实 userId、引用作者和 @ 目标区分多人身份；增加固定后台观察窗口和忙状态恢复。直接 @ 的身份来自网关实际登录账号，不依赖角色卡名字。
- 图片：按角色/摄影需求路由 Danbooru 与 Bing，发送记录按会话持久化去重，结果不明时阻止重复发送；增加受限 CDN 下载和 DNS 检查。
- 可选语音：阿里云合成、音频限长与 WAV 校验、FFmpeg 规范化、私聊语音节奏控制。语音发送仍受会话令牌、开关和限流控制。
- 联网：保留 Bing，增加 DeepSeek / 阿里云搜索适配，以及可选站点浏览器只读客户端。
- Windows：启动器在退出码 2 时等待后重试，管道环境下也保留真实等待时间。

## 升级与备份

需要 Node.js 22.19 或更新版本（包含 `node:sqlite`），FFmpeg 仅在音频转换时需要。先停止桥接及守护启动器，完整备份自己的 `config.json`、`roles/` 和 `state/`，再安装锁定依赖。Pi 用户另运行 `npm run setup:pi`。本次没有增加根依赖，也不包含 SnowLuma 原生组件。

保持已有配置，以 `config.example.json` 为字段参考，逐项合并。不要用示例覆盖自己的配置。`state/memory.sqlite`、相关 WAL/SHM 文件、`state/pi/` 的会话、历史归档及媒体文件须一起备份；不要在进程写入数据库时只复制主数据库文件。停机完整复制 `state/` 最直接。

### 记忆共享

`socialV2.sharedMemory` 控制跨会话共享。示例设置 `enabled:false, migrate:false`；如需共享，明确设置 `enabled:true` 并用 `keys:["group:123456789"]` 限定共享域。开启且 `keys:[]` 表示所有允许的群和私聊属于共享域。**旧配置缺省时保留原共享实现的全域行为**，升级时请明确设置所需值。

共享内容包括 activeTopic、memberImpression 和标记共享的长期条目；pendingThought 保留在本会话，原始聊天历史只允许在来源会话检索。QQ 用户仍可能通过共享条目了解其他会话中已共享的事实，请按实际使用场景选择共享域。关闭共享会停止共享读写，不会抹除既有存档。

### 图片

`socialV2.tools.searchImages` / `sendImage` 控制找图与发送，`imageSearch.nsfwInPrivate:false` 禁止私聊请求非安全分级，群聊始终使用安全分级。搜索依赖第三方站点可用性；离线通过不代表站点一直可访问。

本地生图另需 `imageGeneration.enabled:true`、`server`（仅本机 HTTP）、`outputDir`、`templateFile` 及 `socialV2.tools.generateImage:true`。兼容的 ComfyUI API 工作流须由管理员提供：节点 4 为文本 prompt、5 为 width/height、6 为采样设置、8 为保存图片，输出须为 PNG。路径相对项目根目录或使用管理员配置的绝对路径。仓库不提供模型、工作流、启动/停止服务或 GPU 调度；未配置时拒绝提交。任务提交结果不明时查询原 jobId，禁止重复提交。

### 语音

实时合成默认关闭，与预录语音独立。管理员在本机 `state/tts-settings.json` 配置 `enabled:true`、`approved:true`、`autonomous`、`region:"cn-beijing"`、`model`、`voiceId`、`workspaceId`、`roleName`（必须与当前角色名一致），同时开启 `socialV2.tools.speak`。音色必须与模型匹配且已由管理员准备；这里不包含音色创建、私人素材或音色 ID。凭据使用 `DASHSCOPE_API_KEY` / `DASHSCOPE_WORKSPACE_ID` 环境变量，或忽略的 `state/tts-secrets.json`（apiKey/workspaceId）。合成可能产生第三方费用，限额以本机配置及服务商为准。

安装 FFmpeg 并加入 PATH，或通过 `FFMPEG_PATH` 指向实际可执行文件。失败会返回具体结果，不能把未验证的语音当作已发送；不自动重发结果不明的消息。

### 搜索与站点浏览器

`webSearch.provider` 默认为 `bing`；`deepseek` 使用 `apiKeyEnv`（默认 DEEPSEEK_API_KEY）及可选 `credentialFile`，本机文件优先于环境；`aliyun` 复用上述百炼凭据及可选 `webSearch.model`。接口和模型支持以服务商实际响应为准，本次仅离线验证适配器。

`state/site-browser.json` 设置 `enabled:true` 才启用站点浏览器客户端。它要求管理员自行提供 `http://127.0.0.1:15110/v1/fetch` 的只读服务及 `state/site-browser-reader-token` 中的 64 位十六进制令牌。请求为 POST JSON `{url}`，带 `x-browser-reader-token`；响应为 `{ok,url,title,body,images:[{url}],fetchedAt}`，失败可返回 `code/error`。只读取支持的 B站/微博公开页面，校验返回站点、清理凭据字段并限制长度。**服务端、登录流程和浏览器环境未包含在仓库中**；没有服务时保持关闭。

## 验证

```sh
npm run test:audit
npm run test:features
npm run test:pi
node scripts/build-agent-preset-patches.mjs --check
npm run privacy-scan
```

新增功能回归使用临时目录、假 QQ/模型/搜索响应及本机模拟服务，不向真实 QQ 发送消息、不请求付费模型。线上模型质量、实际账单、QQ 风控和第三方站点可用性不在离线验证范围内。

仓库只发布通用实现、测试与示例；部署配置、角色备份、聊天、记忆、凭据、音色和机器专属资料留在本机。

DSH 已安装工具目录的核对属于可选集成检查：设置 `DSH_TOOL_PACKAGES` 后单独运行 `node scripts/test-preset-local-tools.mjs`。离线聚合套件不读取宿主 DSH 安装；工具隐藏及执行守卫仍由其余夹具断言覆盖。
