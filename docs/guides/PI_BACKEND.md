# 可选 Pi 后端：缩短回复链路与控制 token 用量

本 fork 在保留 DSH 默认后端的基础上，新增进程内 Pi Agent 后端。适合希望减少常规聊天额外模型调用、尝试二代仿真模式后台观察的使用者。Pi Desktop 无需安装或保持运行。

本地使用的主观体验是回复明显更快、token 消耗下降；目前没有同模型、同上下文的完整线上耗时和账单对照，不提供百分比或“所有场景都会更快”的保证。下面的离线对照可以验证一次具体的调用省略。

## 为什么可以少一次调用

常见 agent 循环在收到工具结果后，会再请求模型生成收尾文本。对于已经通过 QQ 发送工具完成回复的回合，这次请求仍会携带上下文，即使用户不需要那段收尾文本。

Pi 适配器使用 `finishTurn`：桥接先验证已展示的消息水位，全部消息成功发送后再确认已读；工具返回 `turnComplete=true`、零发送失败，且同批所有工具结果都成功时，适配器直接结束。未发言但已确认当前已展示未读的回合也能结束。部分失败、发送结果不明、后来到达的新消息、缺少水位或仍有图片任务时不采用这一捷径。

后台观察模式让本地监听器处理回复后的窗口，新消息才触发后续处理。原有权限、消息游标、会话隔离、发送限流和主动唤醒调度仍由桥接负责。静默时不再为了“查看有没有人回复”不断请求模型；显式主动机会、有限睡眠唤醒等原有定时触发仍可能调用模型。

Pi 使用单独的精简系统说明，每轮注入当前角色卡。近期上下文按完整轮次投影，默认预算约 24000 token；完整存档留在本地。字符估算不包含所有工具 schema，最新完整轮次过大时可能超预算，不能视作硬性计费上限。单轮模型调用默认最多 12 次，输出最多 4096 token。

## 安装

需要 Node.js 22.19 或更新版本。复用本项目已有的 SnowLuma 与 OneBot 配置。

```sh
npm ci --legacy-peer-deps --no-audit --no-fund
npm run setup:pi
```

Pi 依赖锁定在 `runtime/pi/package-lock.json`，Agent Core 和 Pi AI 均为 1.3.0，不会升级或修改 Pi Desktop。DSH 后端无需安装这一可选运行库。

## 配置

先停止桥接及其守护启动器，备份 `config.json` 和 `state/`。保留已有 QQ、角色、白名单和访问配置，把以下字段合并到 `config.json`，并将桥接模式设为二代仿真（`reserved2` / `simulation`）。

```json
{
  "runtime": { "backend": "pi" },
  "dsh": {
    "provider": "apimart",
    "model": "qwen3.8-flash",
    "reasoningEffort": "off"
  },
  "pi": {
    "provider": "apimart",
    "model": "qwen3.8-flash",
    "baseURL": "https://api.apimart.ai/v1",
    "apiKeyEnv": "QQ_PI_API_KEY",
    "credentialSource": "file",
    "credentialFile": ".env",
    "thinkingLevel": "off",
    "maxTokens": 4096,
    "contextBudgetTokens": 24000,
    "maxCallsPerTurn": 12
  },
  "socialV2": {
    "wake": { "observationMode": "background", "preSleepWaitMs": 300000 }
  }
}
```

这是一段配置补丁，不是完整配置文件，不要直接替换整份配置。`dsh` 内三个模型字段仍供共享控制台和会话模型选择使用，需要与 `pi` 的设置一致；Pi 不连接 `dsh.baseUrl`。

在项目根目录的本机 `.env` 写入自己创建的 Key：

```dotenv
QQ_PI_API_KEY=<你自己的 API Key>
```

`.env` 已忽略，不要提交凭据。`credentialSource: file` 强制从指定文件读取，避免启动器继承的另一把全局 Key 意外覆盖本项目 Key。也可选择 `environment-first` 并在启动环境配置同名变量；必须明确自己使用了哪一把 Key。

```sh
npm start
```

Pi 模式无需启动 DSH 3080；桥接控制台仍在配置的本地端口（默认 3100）。这里只复用已在运行的 SnowLuma，不自动安装或部署 QQ 网关。附带示例在 APIMart Qwen 上使用；其他 OpenAI-compatible provider 的模型、思考参数、图像支持和计费需要另行验证，不能仅改模型名就视为兼容。

## 会话与能力边界

- Pi 使用 `state/sessions.pi.json`、`state/slang-session.pi.json` 和 `state/pi/`；DSH 原来的映射与工具历史保留，不直接导入 Pi。桥接已有的本地记忆、角色、近期与未读消息仍可使用。
- 每个会话独立串行。进程重启时修复缺失工具结果并关闭过期忙状态，不重放未完成的发送。损坏索引拒绝覆盖；结果不明的发送不能靠自动重试恢复。
- 注册的都是现有安全 QQ、网关状态和联网 MCP，没有任意命令行、文件读写、子代理或宿主审批工具。`closed-agent` 模式不受支持。
- 本次公开的是 Pi 与回复流程优化，没有发布本机私人角色、语音素材、云端音色 ID、聊天、记忆、Key 或特定电脑的生图路径。现有预录语音工具照常按配置注册；本机自定义的实时 TTS 和生图扩展不在这次提交范围内。
- 普通输出在二代模式仍不会自动发到 QQ，必须经发送工具。调用较长工具、继续处理新消息、失败恢复或读取更多资料时，一轮仍可能需要多次模型请求。
- 模型请求仍是无状态 API；没有消除所有重复输入，也没有保证 provider 的缓存命中。账单以 provider 为准。Pi 内部未填单价时 `cost=0` 只是缺少估价，控制台未登记模型的兜底价同样不是实际账单。

## 离线验证

```sh
npm run test:pi
node scripts/test-token-economy.mjs
node scripts/test-in-flight-turns.mjs
```

Pi 测试使用真实 SDK 和本地 OpenAI SSE 模拟服务，不连接云端或真实 QQ。相同的成功发送工具，允许结束时只需 1 次 provider 请求；关闭结束决定的对照需要 2 次。这验证的是循环行为，不是线上耗时或账单的测量。其余检查覆盖失败续处理、消息水位、新到消息、会话隔离、重启、取消、队列、坏索引、图片格式及凭据优先级。

## 回滚

停止桥接与守护启动器，将 `runtime.backend` 改回 `dsh`，恢复自己的 DSH 模型配置并启动对应 DSH，再启动桥接。旧 `state/sessions.json` 会重新生效，Pi 存档仍保留。后端切换需要重启；普通回滚不需要清空记忆或恢复旧社交状态。

如果你是人类使用者，或正在帮助使用者维护该项目的 AI，可以从这份文档尝试 Pi，在自己的模型和群聊负载下比较请求次数、输入/输出 token、响应时间及实际账单，再决定是否采用。先确认备份和真实凭据来源，避免只看本地 `cost=0` 就误判免费。
