# LivingMemory Sidecar — HTTP Contract v1

- contractVersion: **1**（冻结字段名见 §9；v1 内不做破坏性变更）
- 服务名：`lm-sidecar`，本切片实现目录 `work/livingmemory-service/`
- 读者：Codex（Node 桥接客户端实现方）。路由、字段、错误码以本文件为准。
- 上游引擎：LivingMemory（AstrBot 插件）**v2.8.2**，AGPL-3.0，pin 见 `vendor/VENDOR_MANIFEST.json`。本 sidecar 是对上游引擎的独立宿主，不是 AstrBot 迁移。

## 0. 总则（不变式）

1. **Scope 由宿主绑定**。`scope` 字段由 QQ 桥（Node 侧，受信宿主）生成；模型/LLM 永远不能伪造 scope。服务端用正则校验并规范化，任何未知字段/格式 → `400 invalid_scope`。
2. **会话隔离**。群与私聊、不同群的原始证据（消息全文）永不跨 scope 返回。长期“人物事实”仅可按 §7 的 `sharedIdentity` 机制在同一自然人（host 断言的 userId）之间共享提炼文本，且只以“引用摘要 + 会话掩码 ID”形式出现，不携带原文。
3. **记忆服务不可用不得阻塞 QQ 回复**。桥接客户端超时（建议 recall 1500ms / ingest 3000ms，异步 fire-and-forget）后必须直接放行回复；本服务故障时桥接行为不变。
4. **现有存储权威**。§6 的 reconcile 以现有 `memory-store.js` 语义为准（revision / sourceOwnership / forgotten tombstone）；幂等、可 dry-run、报告 unsupported；迁移前先对副本验证。未验证前本服务不回灌旧数据。
5. **注入文本有界并标注**。§4 recall 返回的 `injectionBlock` ≤ `recall.maxChars`（默认 1600），带 `referenceOnly=true` 与来源标记；桥接每回合只注入一次，由桥保证。
6. **不记录凭证/原文到日志**。状态/统计端点不返回 provider key、不返回他会话原文。

## 1. 传输与鉴权

- 仅绑定 `127.0.0.1:8765`（可配 `LM_BIND`/`LM_PORT`）。跨主机部署需反代 TLS，本契约不支持公网直连。
- 鉴权头：`Authorization: Bearer <token>`。两档角色：
  - `bridge` token：`/v1/health`, `/v1/capabilities`, `/v1/ingest`, `/v1/recall`, `/v1/memories*`（显式写/详情/修订/删除/证据——**QQ 会话授权后的宿主派生调用，视为受信 host calls**）
  - `operator` token：以上全部 + `/v1/admin/*`（reconcile、blocklist、stats、maintenance）+ `/v1/reflections/run`（管理面）
- **凭证边界**：两个 token 都只存在于桥进程环境/文件；绝不进入模型工具参数、请求 URL 或日志。operator 凭据不下发给 agent 工具层。
- **scope 强制**：所有按 memoryId 的操作（detail/PATCH/DELETE/evidence）必须携带请求 `scope`；服务端比对记忆的 `metadata.session_id`，不一致（包括猜 id）→ `403 scope_crossing`；不存在 → `404`。
- token 来源：环境变量 `LM_BRIDGE_TOKEN` / `LM_OPERATOR_TOKEN`，或文件引用 `LM_BRIDGE_TOKEN_FILE` / `LM_OPERATOR_TOKEN_FILE`（读取文件内容，文件权限归运维）。服务端使用常量时间比较。
- 未鉴权 → `401`；角色不足 → `403`；`GET /v1/health`（liveness 级）允许无鉴权但只返回 `state`。
- 所有写端点支持 `Idempotency-Key` 头（§8）。
- `Content-Type: application/json; charset=utf-8`，请求体上限默认 2 MiB（超限 `413`）。

## 2. 错误信封（所有非 2xx）

```json
{
  "error": {
    "code": "recall_failed",
    "message": "recall route threw; replies must not be blocked",
    "requestId": "01J...",
    "retryable": true
  }
}
```

`code` 枚举（v1 冻结，允许向后兼容追加）：`bad_json | invalid_scope | invalid_payload | idempotency_conflict | unauthorized | forbidden | not_found | unavailable | engine_not_ready | provider_unavailable | budget_exceeded | too_large | tombstoned | blocked_source | revision_conflict | scope_crossing | internal_error`；additive 追加：`invalid_input | payload_too_large`（既有实现别名）与 `provenance_insufficient`（§5 来源证据不足，HTTP 409）。HTTP 映射：400/401/403/404/503/429/413/409/500；`engine_not_ready`/`unavailable`/`provider_unavailable`→503，`budget_exceeded`→429，`tombstoned`/`blocked_source`/`revision_conflict`/`idempotency_conflict`/`provenance_insufficient`→409。

## 3. 健康 / 能力

### `GET /v1/health`（无鉴权，liveness）
```json
{ "status": "ready", "contractVersion": 1, "engineVersion": "2.8.2", "mode": "production|test" }
```

### `GET /v1/capabilities`（bridge）
```json
{
  "contractVersion": 1,
  "engineVersion": "2.8.2",
  "features": {
    "ingest": true, "recall": true, "explicitWrite": true, "evidence": true,
    "graph": true, "atoms": true, "reconcile": true,
    "blocklistAllWrites": true, "revisionCas": true, "idempotencyAcrossRestart": true,
    "operatorDashboard": "native-ui", "activeAgenticSearch": true
  },
  "limits": { "bodyMaxBytes": 2097152, "ingestTextMaxChars": 32000, "recallQueryMaxChars": 2000, "kMax": 12, "recallMaxCharsDefault": 1600 },
  "providers": { "embedding": "openai-compatible|deterministic-hash", "llm": "openai-compatible|scripted" },
  "contractFreeze": { "frozenSections": ["scope", "errorCodes"], "note": "scope 规范化与错误码 v1 冻结；features 位只增不改" },
  "adminUiNote": "此为能力示意；实际响应以服务为准。原生 dashboard、page API 与主动追忆已接入，见 §13。"
}
```

## 4. 消息摄入与召回（bridge）

### `POST /v1/ingest`
宿主在消息到达（含未唤醒群消息）及**发送确认成功**后调用。
```json
{
  "scope": { "chatType": "group", "groupId": "100000004" },
  "messageId": "snow-10231",
  "authorUserId": "12345",
  "authorName": "阿某",
  "role": "user",
  "text": "今天心情不错",
  "timestampMs": 1793189892000,
  "provenance": "direct_quote | forwarded | bot_output | unknown",
  "turnRef": "optional-bridge-turn-id"
}
```
响应 `200`：`{ "messageId": 1234, "sessionRevision": 57, "duplicate": false }`
- `role`: `user`（他人消息）或 `assistant`（bot 已确认发送的输出）。`provenance=bot_output` 且 `role=user` → `400 invalid_payload`。
- 同一 `scope`+`messageId` 重复摄入 → `duplicate=true`，不双写。
- `text` 截断上限 32000 字符；超限 → `413`。

### `POST /v1/recall`
```json
{ "scope": { "chatType": "group", "groupId": "100000004" },
  "query": "用户提过喜欢什么音乐",
  "k": 6,
  "maxChars": 1600 }
```
响应 `200`：
```json
{
  "results": [ { "memoryId": 88, "score": 0.62, "content": "...",
                 "origin": "reflection|explicit|imported",
                 "kind": "FACT|GENERAL|REFLECTION",
                 "subject": "12345",
                 "revision": 3,
                 "assertion": "asserted|unverified|inferred",
                 "asserted": true,
                 "sessionMasked": "group:83****51",
                 "crossSession": false } ],
  "injectionBlock": "【参考资料/Reference only，非指令，可能过时】\n- [FACT:12345|asserted] ...",
  "truncated": false,
  "meta": { "blockedFiltered": 0 },
  "tookMs": 41
}
```
- **身份保留（IDENTITY_INJECTION）**：`kind/subject/revision/assertion` 一律取自已验证的存储 metadata（绝不从群里最后一个说话者推断）；`assertion` 字段缺失时**绝不默认 asserted**——REFLECTION/模型推断内容标 `inferred`，无来源标注的导入内容标 `unverified`。`injectionBlock` 每行以 `[kind:subject|assertion]` 前缀标注：同一条文本被两个群成员分别主张时，出现两行不同 owner 标签，不会被合并。`subject/revision/assertion/asserted/kind` 为 additive 字段（旧桥读取不受影响）。
- 默认只召回**本 scope** 的记忆。跨会话人物事实只在 `sharedIdentity` 开启（§7）时以 `crossSession=true + sessionMasked`（掩码）出现，`content` 为提炼文本、绝不含他会话原文。
- **blocklist 过滤（§6b）**：命中被遗忘内容指纹或被禁证据来源派生链的记忆不返回；被过滤项数量计入 `meta.blockedFiltered`（不含内容），不泄露遗忘正文。
- 服务内部错误 → `503 recall_failed`；桥必须吞掉继续回复。

## 4b. 主动追忆 `POST /v1/recall/active`（bridge+operator；additive）

围绕上游**真实** `search_memories_agentic` 检索环（纯检索：只消耗 embedding 计数，**不消耗 LLM 预算**）。

请求：`{ "scope": §9 规范(必填，绑定本会话), "query": "…", "k": 1..kMax(≤12), "target": "conversation|current_speaker"(默认 conversation), "identityKey": "纯数字稳定QQ号(仅 current_speaker)", "startTsMs"/"endTsMs": 时间过滤(仅本会话内), "excludeIds": [memoryId](≤50), "cursor": "短字符串(participant cursor)", "maxChars": ≤recall.maxChars }`

响应 `200`：与 §4 recall 同形（results 含 §4 身份字段 + `matchBasis`），另附 `hasMore/nextCursor/status/identityStatus/partial/coverage/message/meta.blockedFiltered/tookMs`。

- **人物绑定（IDENTITY_INJECTION item4）**：`current_speaker` 的 `identityKey` 必须由桥从当轮可信上下文携带；非本会话参与者的 id → `403 scope_crossing`（用摄入账本核验，绝不凭通用措辞抓他人画像）；private 会话默认绑定对端。
- **有界**：单次调用总时限 `limits.activeRecallTimeoutSeconds`（默认 20s），超时 → `503 provider_unavailable`；k/excludeIds/query 长度同 §4 界限。
- **遗忘一致**：§6b 阻断集合在结果上同样过滤（scoped identity + legacy 指纹 + external tombstone）。
- capabilities：`features.activeAgenticSearch=true` 仅在实现+测试通过后上报；`limits` 块公布实际上限。

## 5. 显式写入 / 证据 / 修订（bridge 受信宿主调用；operator 同样可用）

- **来源证据（FORWARD_ATTRIBUTION，全写路径）**：被主张的个人事实（带 `assertedBy`，或私聊默认对端自述）必须至少有**一条该作者直接发言**（provenance `direct_quote|direct`）作为证据；`forwarded|quoted|bot_output|admin_attested` 来源不能建立本人偏好 → `409 provenance_insufficient`。转发/admin 文本仍可作为**非主张观察**存储（不带 assertedBy）。ingest 持久化 `provenance` 字段（默认 `direct_quote`；`bot_output` 证据一律拒绝）。reconcile 对 `userFact` 条目同样核验：payload `sourceRefs[].provenance`（additive，桥建议携带）缺省时以 **sidecar 自己的 ingest 账本**为准（宿主声称的 author 字符串不能绕过）；档案里从未在本账本出现的 legacy 条目维持 `unverified` 语义。UI 变更路径保持同一 source/subject 边界（§13）。

### `POST /v1/memories`（显式记忆写入）
```json
{
  "scope": { "chatType": "private", "userId": "12345" },
  "content": "偏好文字交流，不喜欢语音",
  "importance": 0.8,
  "assertedBy": "12345",
  "sourceMessageIds": [1234, 1240]
}
```
- `sourceMessageIds` 必须是**同 scope** 内已摄入消息 id；否则 `400 invalid_payload`。
- `assertedBy` ≠ scope 自然人 且 scope 为私聊 → `403 forbidden`（防止把别人转述写成本人事实）。
- 引语/转发源消息不能独立作为 `assertedBy` 依据，否则 → `409 provenance_insufficient`。bot 输出不能作为 userFact 依据。
- 任一 `sourceMessageIds` 命中 blocklist（§6b）→ `409 blocked_source`，整请求拒绝，不部分写入。
- 响应 `200`：`{ "memoryId": 91, "revision": 1 }`。

### `GET /v1/memories/{id}` `{ "scope": ... }`（query 参数携带 scope）→ 详情（含 metadata、revision、evidence 摘要）
### `PATCH /v1/memories/{id}`
```json
{ "scope": { "chatType": "private", "userId": "12345" },
  "expectedRevision": 3,
  "content": "...", "importance": 0.7 }
```
- **CAS**：`expectedRevision` 必填，且服务端当前 revision 不匹配 → `409 revision_conflict`（响应含 `currentRevision`）。
- 内容更新走上游 `update_memory`（重建 embedding/BM25/原子/图谱派生数据），响应 `{ "memoryId": .., "revision": 4, "reindexed": true }`；新内容命中遗忘指纹 → `409 blocked_source`。
### `DELETE /v1/memories/{id}` `{ "scope": ..., "expectedRevision": 4 }` — 硬删引擎记录、清理派生原子/图谱、写本地 tombstone（memoryId + 内容指纹 + externalId 若有）；重放 DELETE 幂等返回 `200 {deleted:false}`；他 scope 或猜 id → `403 scope_crossing`。
### `GET /v1/memories/{id}/evidence?scope=...` — 仅同 scope；他 scope 请求 → `403 scope_crossing`；命中 blocklist 的来源 `text` 置空并 `blocked=true`（不返回被遗忘原文）。来源项同时给出 canonical 名与旧别名：`messageId`(=`id`)、`authorUserId`(=`senderId`)、`timestampMs`（毫秒；即 `timestamp` 秒×1000）、`externalId`、`role`、`text`、`blocked`（additive；Node mapper 消费 canonical 名）。reconcile 导入的事实在引用可解析到本会话账本行时持久化**真实原文**证据（与显式写入同形）——`get_memory_source` 对桥保存/同步的事实返回原始证据；解析不到的旧条目保持缺失（`contentComplete=false`），绝不虚构。
### `GET /v1/memories?scope=...&page=1&pageSize=20` — 列表分页（上游 `list_memories_page` 能力）；scope 必填（bridge 只可见自身 scope；operator 可 `scope=all`）。

## 6. 权威数据 reconcile（operator，幂等，重启持久）

导入源：Codex 的只读导出 `work/src/livingmemory-export.js`（`schemaVersion:1`，字段 `memories/sources/blocks/report`）。reconcile 载荷与其对齐，**现有存储权威**直到迁移演练完成。

### `POST /v1/admin/reconcile`
```json
{
  "batchId": "memstore-20261029-01",
  "dryRun": true,
  "entries": [
    { "externalId": "lm:userFact:9f3c..", "op": "upsert",
      "scope": { "chatType": "private", "userId": "12345" },
      "kind": "userFact", "content": "偏好文字交流", "revision": 3,
      "sourceRefs": [ { "sourceId": "src:101", "externalId": "msg:101", "authorUserId": "12345",
                        "scope": { "chatType": "private", "userId": "12345" }, "partial": false } ],
      "contentComplete": true },
    { "externalId": "lm:userFact:9f3c..", "op": "replace",
      "supersedesExternalIds": ["lm:userFact:7a2b.."], "revision": 4, "…": "同 upsert 其余字段" },
    { "externalId": "lm:event:a11b..", "op": "forget", "tombstoneHash": "sha256:.." }
  ],
  "blocks": {
    "forgottenSources": [ { "sourceId": "src:88", "kind": "userFact", "subject": "12345", "scope": { "chatType": "private", "userId": "12345" } } ],
    "forgottenFingerprints": [ "legacy-fp-1", "sha256-normalized-2" ],
    "excluded": [ { "id": "lm:archived:x", "status": "archived", "fingerprint": "fp" } ]
  }
}
```
响应：`{ "applied": 12, "skipped": 34, "failed": [ { "externalId": "..", "reason": "session_ownership" } ], "unsupported": [ { "externalId": "..", "reason": "mergeFamily" } ], "providerCalls": 0, "dryRun": true }`
- 幂等键 = `externalId`+`revision`+内容指纹；重放同一 batch（含服务重启后）不产生第二条，也不重复计数。幂等映射与 tombstone/blocklist 全部落在 sidecar 本地 SQLite，重启存活。
- **证据链接约束**：`upsert/replace` 必须带 `sourceRefs`（可为空数组但需显式）。任一 `sourceRef` 缺失导入的消息原文（`partial=true` 或本机从未摄入该 `sourceId`）→ 条目仍写入但 `contentComplete=false`，记忆标记 `assertion:"unverified"`：参与召回但结果带 `asserted=false`，**绝不升级为断言性稳定事实**、不进入 sharedIdentity 通道。缺省/遗漏 sourceRefs 视为 `partial`，不做静默转换。
- **会话归属校验**：每条 `sourceRef.scope` 必须与 entry.scope 一致且 authorUserId 匹配 kind 规则（userFact→subject 本人）；违规 → `failed[{reason:"session_ownership"}]`，整条跳过（即使 dryRun 也执行同样的全套校验——见下）。条目 owner 字段名接受向后兼容别名（同一语义）：`subject` / `assertedBy` / `sourceOwner`（桥侧现行拼写）；均缺失时 private 回退对端 QQ，group 无 owner 则 userFact 判 `author_mismatch`（不放松）。
- `op=replace`：新条目写入成功后，对 `supersedesExternalIds` 的每条旧记忆执行**完整退役**：引擎硬删 + 派生原子/图谱清理 + 旧 externalId tombstone + 旧内容指纹入 blocklist，杜绝“新摘要同步后旧独立原子/图事实仍可召回”。
- `op=forget` / `blocks.*`：写入 §6b blocklist（tombstone 语义）；阻断项带 `reason`。`excluded`（非 active 条目）只登记 tombstone/fingerprint，**不导入正文**。
- **dryRun**：执行与真实写入相同的全部校验（scope、归属、blocklist 冲突、CAS、unsupported 判定），但零写入、零 provider 调用（响应 `providerCalls: 0`）。
- `unsupported`：现有存储有而 v1 无法表达的语义（整理器 merge 家族派生正文、待核实导入资料、原 revision 线谱），**逐条报告，不静默丢弃**；语义参照 export 的 `report.unsupportedSemantics`。

### `GET /v1/admin/reconcile/state?externalId=...` → `{ "externalId": "..", "memoryId": 91, "revision": 3, "state": "active|forgotten|unknown" }`
- **导入事实的来源证据（MIGRATION_FAILURES）**：`sourceRefs[].provenance` 显式为 `forwarded/quoted/bot_output` 且无直接 ground → `failed: provenance_insufficient`；显式 `unknown` 或缺失且本账本无该来源记录 → **允许导入但标记 `unverified` 并强制 `contentComplete=false`**，绝不自动升格为 asserted。validated owner 随记录写入引擎 metadata（`asserted_by`/`subject`；`userFact`→FACT 身份），recall/delete/UI/遗忘路径共用同一 `asserted_identity` 推导，指纹全链路一致。

## 6b. Blocklist / tombstone（全写路径强制）

服务端本地表持久化三类阻断（与引擎数据同目录、独立文件 `lm-sidecar.db`）：
1. `source`：被遗忘来源 id（legacy `source_id` 与 `external_id` 双键）——命中来源不得作为**任何**写入路径的证据：反射总结、显式 `POST /v1/memories`、reconcile 导入；证据读取端点对其脱敏（`blocked=true`）。
2. `fingerprint`：**作用域身份指纹**（INTEGRATION_GAPS item 1 修订）。规范化内容（NFKC → 空白折叠）参与哈希，但阻断身份 = SHA-256(`session_key \x1f kind \x1f subject \x1f 规范化内容`)——同一句话分属不同用户/会话时互不阻断（group 内两用户同文本、跨 private 同文本均独立）；`kind` 归一 userFact→FACT 其余→GENERAL，`subject` 取 `assertedBy`/`subject`，private 缺省为对端 QQ。legacy 导出携带的不透明指纹（上游已按 kind/subject/scope 编码）以 scope_key=`*` **原样导入、仅精确匹配**，sidecar 绝不重新解释。命中身份指纹的记忆正文在**召回与注入块中被过滤**；新写入命中 → `409 blocked_source`。上游“换说法自动重提炼”的指纹阻断由本层实现（引擎仅有来源阻断标记，不含跨库遗忘语义）。
3. `memory`：tombstoned externalId / memoryId + 其内容指纹——防止再导入复活；DELETE/replace 退役时自动登记。

- 反射任务在组装载入窗口前先按 source/fingerprint 过滤原始消息（有界过滤，不阻塞回复路径）。
- `GET /v1/admin/blocklist?limit=...&cursor=...`（operator）：只读分页计数与键（不返回被遗忘原文；legacy fingerprint 原样返回，sha256 指纹返回）。
- 同步 blocklist 的通道就是 §6 `blocks` 对象（幂等 upsert，无删除通道——遗忘不可逆；撤销需人工走 reconcile 新 revision 并重新授权证据）。

## 7. 共享身份（可选，默认关闭）

配置 `sharedIdentity.enabled=false`（v1 默认）。开启后 host 在配置里显式登记别名组（`{"qq": ["12345"], "label": "owner"}`）；只有登记过的 scope 对之间，`userFact` 类条目参与互相召回，且仅返回提炼 `content`，`sessionMasked` 掩码显示来源。模型不能开启或操纵该机制。

## 8. 反射（后台总结）与幂等

- 摄入满 N 条消息 / 静默超时由服务端后台任务触发（`reflection.triggerMessages` 默认 20，`reflection.quietSeconds` 默认 600），也可 `POST /v1/reflections/run { "scope": ... }`（operator）手动跑一轮。
- 后台调用 LLM 提炼 → `add_memory`（含原子分类/图谱派生），`metadata.origin="reflection"`，附 `sourceMessageIds`；装载窗口前按 §6b 过滤被遗忘来源/指纹。
- 桥不等待反射；反射失败不影响任何同步端点；反射产生的 LLM/embedding 消耗计入 §10 预算（**每次真实 provider 请求单独计数，含重试与失败**，见 §10）。
- 会话修订号：反射写入前校验 ConversationManager 的 session revision（上游能力），窗口在总结期间被回滚/编辑 → 本次结果丢弃，不写入过期内容。
- `Idempotency-Key`：ingest 以 `messageId` 天然幂等；memorize 与 reconcile 支持该头，重复键相同体 → 回放首次响应（重启后仍有效，键与响应存 SQLite）；不同体 → `409 idempotency_conflict`。

## 9. Scope 规范化（冻结）

```
group:  chatType="group",  groupId=^[1-9][0-9]{4,11}$     → internal session key "livingmemory:qq:group:{groupId}"
private:chatType="private", userId  =^[1-9][0-9]{4,11}$     → internal session key "livingmemory:qq:private:{userId}"
```
`personaId` 由服务端配置固定（如 `amiya`），不接受请求覆写。内部 key 传上游 `MemoryEngine` 的 `session_id` 参数。

## 10. 配额与用量（重启持久）

- **预算语义与现有桥的“每日 2 次记忆整理”对齐**：`reflection.dailyLlmCalls` 默认 **2**（与 slang 预算分离，独立计数；显式配置可改）。**按真实 provider 请求计数**：一次反射里 summary 调用、失败重试、图谱抽取/重要性/原子等产生的每次 LLM 请求都单独计数——不把多请求反射记为 1 次；**预占即扣**，失败仍占用（同现有语义）。embedding 单独计数（`embeddingDailyLimit` 默认不限，仅观测）。
- 计数持久化在 `lm-sidecar.db`（按 Asia/Shanghai 日切），重启不清零、不重放。超限后台反射直接跳过并记 `blocked+1`，API `POST /v1/reflections/run` → `429 budget_exceeded`。recall/ingest 同步路径不消耗反射预算（其 embedding 仍计数）。
- `GET /v1/admin/stats`（operator）：`{ "llm": {"used":2,"reserved":0,"failed":1,"limit":2,"blocked":3,"day":"2026-10-29","tokens":{"prompt":62,"completion":352,"total":414}}, "embeddings": {"requests": 41, "tokens": 5}, "ingest": {"messages": 120, "duplicates": 2}, "engine": {...上游 get_statistics() 计数...} }` — 不含凭证、不含任何会话原文。`used` 语义 = 当日已预留的请求总数（失败同样计入，预占即扣）。`tokens*` 为 additive 观测字段（provider 返回的 usage 数字聚合；响应正文绝不入台账）。
- **Chat provider 信封兼容（PROVIDER_COMPATIBILITY）**：生产 APIMart GLM（模型不变 `glm-5.3-flash`）对非流式请求实际返回 `Content-Type: text/event-stream`。适配器同时接受完整 JSON 文档与 SSE 流；SSE 只累计 `delta.content`（`reasoning_content` 不算正文），必须见到终局（finish_reason=stop + [DONE]）才提交结果；流中断、缺终局、`length` 截断、超出字节帽（默认 8 MiB）或总时限（timeoutSeconds + 5s，非仅单次读空闲）一律抛**脱敏** provider 错误（不含响应正文/凭证），且该次请求按“失败请求”完整计数（预占已扣）。返回的 token usage 记入上述统计。
- 兼容性追加：`capabilities.liveness.{decayTask,autoReflectionTask}` ∈ `running|stopped|disabled` 报告调度器真实状态（disabled 的调度器不虚报 ready）；`capabilities.features.forgetIsolation="scoped-identity"`。
- 服务器资源约束：宿主机约 1.5 GiB 可用内存、7.2 GiB 磁盘。sidecar **不使用本地模型/torch**，embedding 与总结一律走远程 API（§12 限额）；FAISS 索引为内存 Flat 索引，数据量级（数千条）内存占用可控。

## 11. 完成状态与支持范围

2026-10-30 已完成正式迁移与切流。原生 dashboard/module API、全部静态资源、主动追忆/原话证据、Node 持久队列、一次注入、故障回退和权限复核均已接通，并完成真实引擎与浏览器验收。正式范围按发布时最新白名单，见 `qqbot/docs/AMIYA_LIVINGMEMORY_2026-10-30.md`。

原 `memory-store.js` 继续管理导入记忆的修订和遗忘，UI 对这些行只读。旧整理器 merge 家族与历史 revision 线谱仍留在原库，导出逐项报告不支持语义；不生成虚假的对应关系。共享身份和自动清理默认关闭。

## 12. 部署与网络（容器）

- 默认绑定 `127.0.0.1:8765`（`LM_BIND`/`LM_PORT`）。**实际部署采用 Docker `network_mode: host`（LINUX_CHECKS 决定）**：桥的 baseUrl `http://127.0.0.1:8765` 直连；此时 sidecar 必须 `LM_BIND=127.0.0.1`（host 网络下 0.0.0.0 会暴露公网接口）。`deploy/docker-compose.sidecar.yml` 即该形态。历史方案 A（私有 `lm-net` + 容器名互访）保留为备选，若桥改用共享网络。运行时 WORKDIR 为可写的 `/srv/livingmemory/run`（import astrbot.core 会在工作目录建相对 `data/`；见 LINUX_CHECKS 非 root 修复），模块经 `PYTHONPATH=/app` 解析。
- compose/Dockerfile 示例在 `deploy/`；资源限额建议 `mem_limit≈512m, cpus≈1.0`（服务器约 1.5 GiB 空闲内存、7.2 GiB 磁盘），**不下载本地模型**（embedding/LLM 全远程 HTTP；测试用确定性双件，无网络）。
- 数据卷：`/data`（引擎 SQLite/FAISS + `lm-sidecar.db`）单独挂载并纳入现有私有备份。`POST /v1/admin/backups/create`（operator，BACKUP_CONSISTENCY 语义）：先取得**运行时写屏障**（ingest/记忆 CRUD/UI 变更/反射持久化/decay 全部让路；15s 内无法静默 → `409 unavailable` 明确重试，不假装成功），随后 `save_index()` flush 向量态、每个 SQLite 一律走 **backup API**（绝不复制 live `-wal/-shm`）、其余状态文件（prompts/decay/UI config/索引）在静默窗口内复制；快照在返回前**验证**：每库 `integrity_check=ok` + 必需表存在 + 真实行数（messages/documents/external_memory/usage_day…）+ FAISS `read_index` reload（ntotal/dim），结果写入 `backup_info.json.validation`（上游备份面板枚举兼容）。验证失败自动删除快照并 `503`。**restore 不通过 HTTP 暴露**（仅离线人工操作，恢复须保留现行凭证/tombstone）；快照永不含凭证文件。

## 13. 运维 UI 与原生 page API（operator-only；additive 面）

- **入口**：`GET /ui/`（未登录 302 → `/ui/login`）。登录：`POST /v1/ui/login`（JSON `{"token": operator}` 或表单），校验用常数时间比较；成功发放 **HttpOnly + SameSite=Strict + Path=/** 会话 cookie（TTL 1800s，账本内存储过期时间）。操作员令牌**从不**出现在 URL、页面源码、日志或 cookie 值里；`POST /v1/ui/logout` 注销。bridge token 对 `/ui/**` 与 `/astrbot_plugin_livingmemory/**` 一律 401。
- **page API 前缀**：`/astrbot_plugin_livingmemory/page/*`——真上游 `core/page_api.py` 处理链挂载在同进程 Quart 子应用（真实 ASGI request 上下文，`quart.request` 全局可用；非伪造 globals）。信封为上游格式 `{status:'ok'|'error', data|message}`（§2 信封不适用于该前缀；§2 权威面仍归 `/v1/*`）。
- **前端**：vendored 未修改的上游 2.8.2 `pages/dashboard/` 资源 + `bridge.js` 实现 `window.AstrBotPluginView`（ready/getContext/apiGet/apiPost/onContext，同源 fetch + same-origin credentials，401 自动跳登录）。
- **写语义（宿主权威，等同 §5/§6）**：`memories/update|batch-delete|batch-update` 路由到 sidecar 实现——content 类编辑 = `replace_memory` + 旧身份 scoped block + external 重映射 + revision bump（编辑后旧内容即刻不可召回，reconcile 重放不会复活）；删除 = 完整 tombstone 语义（§6b）；`field=type` 提升为 `FACT` **一律拒绝**（asserted 个人事实只能经 §5 来源校验路径建立）；provenance/ownership metadata（asserted_by/session_id/user_id 等）在编辑中被强制保留，UI 无法改归属或跨 scope 搬家。
- **读面守卫**：dashboard 的搜索/列表/详情经 `GuardedEngine` 代理——命中遗忘身份/来源的记录不展示、原文置空；被遗忘证据的原文在 `get_memory_source` 上同样屏蔽。
- **仍走上游的能力**：recall/test、图谱（含 3D）、prompts 编辑、settings、consolidation、backups 列表。`memories/import` **禁用**（错误信封指向 §6 reconcile 作为唯一批量写入权威）。consolidation/resummarize 运行带 external 账本 guard：被引擎退役的导入条目自动 tombstone（响应含 `hostTombstones` 计数），绝不复活。
- **迁移导入条目在权威切换前只读（UI_AUTHORITY item3）**：`origin=="imported"` 的条目（reconcile 同步自旧 Node MemoryStore）在 dashboard 的编辑/批量删除/resummarize 一律返回错误并指向旧授权编辑器；存在此类条目时 `consolidation/run` 明确失败（不静默改动宿主权威行、不误 tombstone）。原生 explicit/reflection/UI 创建条目功能完整。切换后此限制随契约移除。
- **设置边界**：仅允许受支持的检索/图谱设置，经真实 ConfigManager 持久化，完整生效需重启服务；模型、白名单与预算仍由宿主配置管理。UI 编辑不提供 §5 的 expectedRevision CAS（操作员为最终权威，revision 仍单调递增并持久）；restore 离线专用。所有 dashboard 资源已逐字节补齐，manifest 已刷新，浏览器渲染及 3D 图谱已通过合成数据验收。
- **派生摘要遗忘一致性**：更正/遗忘会退役同 scope 中引用旧来源的自动 reflection，清除其向量、原子和图谱，持久化身份阻断；其他会话同名来源不受影响。写屏障内再次核验来源，遗忘前开始、遗忘后返回的后台摘要不得落库。独立的显式或导入事实不会被此派生清理误删。
