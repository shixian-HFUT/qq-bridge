# 来源与组件许可

- 桥接基于 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，本分支从自己的 fork `main` 提取生产后续实现，保留原版权声明及 MIT 文件；不是从本机含私人材料的历史直接推送。
- Pi 使用独立锁定的 `@earendil-works/pi-agent-core` / `pi-ai` 1.3.0，依赖通过 `runtime/pi/package-lock.json` 安装。
- LivingMemory 固定版本 2.8.2、提交 `a1e9c20a8c5fab93d6143f51be26fb1bbf8143ec`，保留 174 个上游文件及 37 个管理页资源。来源、逐文件哈希和获取方式见服务 `vendor/VENDOR_MANIFEST.json`。
- 服务及上游组件的许可见 `services/livingmemory/NOTICE.md` 和 vendored LICENSE，AstrBot 作为锁定依赖安装。根 MIT 文件不替代这些组件声明。
- SnowLuma 作为外部网关互操作使用，不包含本体、安装包、QQ 登录数据或个人语音素材，其许可归原作者。

生产配置、账号、聊天、记忆、向量索引、缓存、日志和备份均不属于源码发布。`production-source-manifest.json` 记录的是源码哈希与公开整理差异，不是个人运行数据。
