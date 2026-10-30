# 离线验证

使用 Node 22.19+ 的 22.x 安装根依赖与 Pi 运行时依赖：

```sh
npm ci
npm run setup:pi
npm run test:production
```

入口依次运行 12 组已有测试，覆盖原记忆、LivingMemory 客户端/桥接/导出、共享记忆、忙碌恢复、回复等待、token 账本、群预算及真实 Pi SDK 的简化工具与工具循环。每组限时 60 秒，非零退出或超时判为失败。

LivingMemory 使用 Python 3.12：

```sh
cd services/livingmemory
python -m pip install -r requirements.lock.txt pytest==9.2.0
python -X utf8 -B -m pytest
```

侧车测试使用真实 FAISS/BM25/图谱引擎、合成数据与替身提供商，写入 `.test-tmp/`，不读取生产聊天，不调用真实模型或 QQ。

GitHub 工作流 `.github/workflows/amiya-offline.yml` 分别执行 Node 和 Python 检查，使用只读仓库权限，不需要部署密钥或提供商凭据。工作流是否被 fork 启用、运行结果以 GitHub 实际状态为准。

本次整理的验证结果（2026-10-31）：

| 范围 | 结果 |
| --- | --- |
| Linux / Node 22.23.3 | 12 组通过；共享记忆因缺配套文档首次失败，补齐后 160 条断言通过 |
| Windows / Node 22.19.0 | 11 组通过；看门狗组在 60 秒上限超时，Linux 同组通过 |
| Python 3.12 / 真实记忆引擎 | 31 项通过，5 条上游警告 |
| 干净安装 | 根 npm ci 与 Pi 锁文件安装完成；本机默认 Node 22.14 有 engine 提示，正式回归使用上述支持版本 |
| 初始化 | 新目录创建配置/角色/模式成功，重复执行保留已有配置 |
| 部署模板 | Compose 的 memory profile 配置检查通过；未重新构建镜像或部署实例 |

Python 警告为 audioop 弃用及取消检索协程的 RuntimeWarning，未修改上游源码以隐藏警告。Linux 测试使用临时容器、断网和只读的现有锁定依赖，不访问生产配置或真实 QQ；新机按锁文件从头安装的检查另由 CI 执行。

模板不等于已在新主机完成真实 QQ、语音或付费模型验证；运行这些检查需要使用部署者自己的配置和授权。
