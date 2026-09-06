# 任务上下文隔离与原生历史生命周期方案

日期：2026-09-06。审阅基线：`1413457c`。状态：方案设计，尚未实施。

## 1. 建议结论

采用「任务间隔离、任务内稳定追加」：MultiCC 正式历史保存用户消息、助手结果、工具执行证据与用量；CLI 原生历史是可恢复的执行缓存。新任务先确定身份，再创建原生上下文；同一任务的讨论、等待、重试继续使用同一上下文。任务完成并满足持久化、运行排空条件后，封存并解除原生绑定；后续追问从该任务正式历史创建新的上下文阶段。

这是一项跨任务身份、消息准入、历史存储、CLI 生命周期和记忆注入的中等规模改造。只在完成事件里移动 JSONL 文件，无法实现目标。

推荐分四步落地：统一历史读取与审计 → 确定任务边界并切断跨任务 resume → 统一上下文筛选和快照 → 接管原生归档与回收。前两步先运行于身份明确的任务专属会话，再覆盖普通聊天。

## 2. 当前代码的真实情况

| 能力 | 当前实现与证据 | 对方案的意义 |
| --- | --- | --- |
| 消息归属 | `src/task-context-host.js` 的 `beginTurn()`；`src/chat/turn-engine.js` 在准入时生成 provisional ID，消息持久化后异步调用 `runClassifyNow()` | provisional ID 变化不能直接触发原生重建；最终身份必须在执行前明确 |
| 任务关联 | `src/classify/task-attribution.js` 的 `relatedTaskId`；`src/task-board.js` 的 `groupRelatedTasks()` / `taskGroups` | 已有主题分组，可作为检索候选；没有等价的「明确依赖，可自动注入全文」契约 |
| 任务专属会话 | `src/routes/task-board.js` 的 `ensureBoundChatSessionUnlocked()`，任务 `chatSessionId` 对应记录 `taskBoundTaskId` | 现行主要路径是一任务一个隐藏聊天会话，继续复用 |
| 冷启动上下文 | 同文件 `coldStartSeed()` 从 task-run 台账及历史 refs 组装；有 `cliSessionId` 时不注入；`sendBoundSessionFollowupUnlocked()` 发送原文及独立 seed | 已有首轮注入接缝；异常目前会被吞掉并返回空 seed，不能作为严格恢复契约 |
| 上下文编译 | `src/task-run-context.js` 的 `buildTaskRunContext()`，默认 v1、12000 字符；`normalizeMessages()` 主要保留文本 | 有确定性、脱敏、来源 hash，可演进；传入版本号本身不等于已有完整 v2 工具回放 |
| 正式历史来源 | 普通/隐藏聊天走 `src/session/chat-history-service.js`；旧执行槽走 `src/task-run-store.js`、`src/task-transcript-repository.js` | 当前不是所有消息都只存同一份台账，应统一读取契约，避免先做全量搬库 |
| 工具证据 | `src/task-run-host.js:recordMessage()` 当前 metadata 写入 lease、delivery、clientMsgId、wrapper、partial；台账读取方支持 tools/usage 等，但该写入点未完整写入这些字段 | 必须先补写入和覆盖验证，才能声称删除原生文件后仍可恢复 |
| JSONL 回收 | `src/task-run-host.js:finalizeTerminal()` 仅在 `taskExecutionSlot === true` 时调用专用清理；新隐藏聊天不是执行槽 | 旧槽位清理不能直接代表现行任务会话完成即清理 |
| Codex / Claude 保留 | `src/chat/codex-rollout-guard.js` 按大小归档、按 mtime 做 TTL；`src/chat/transcript-prune.js` 生成 `.pruned.jsonl` | 新策略要统一托管，避免另一清理器提前删除；裁剪副本仍可能承担用量读取职责 |
| 交接和记忆 | `src/cli-switch.js:buildHandoffCheckpoint()` 取最近会话消息；`src/memory/folder-service.js:buildBlock()` 注入私有/共享记忆 | 这些路径没有统一按任务过滤，会重新带回无关历史 |
| 请求转换 | `src/model-history-converter.js` 处理 Responses 历史格式；中继保留底层异常 | 继续作为协议出口处理；它不负责决定哪些历史属于当前任务 |

旧设计文档包含已退役的池化路径和尚未在当前写入点体现的能力描述；本方案以以上代码及现有测试为准。

## 3. 身份与生命周期

### 3.1 区分四种身份

| 身份 | 含义 | 何时变化 |
| --- | --- | --- |
| `taskId` | 独立交付目标；使用 existing canonical taskId / alias 解析 | 真正的新任务 |
| `contextEpochId`（新增） | 一段可连续恢复的任务执行上下文 | 完成后追问、显式重置、不可恢复的上下文轮换 |
| `taskRunId` | 现有任务执行记录及用量归属 | 按现有执行规则，不能拿它替代上下文阶段 |
| 原生 handle | 某 CLI / Provider 实际使用的线程、文件或数据库会话 | 新建、CLI 切换、失败后 fresh attempt；同 epoch 可有多个受控 generation |

绑定至少包含 `sessionId + canonicalTaskId + contextEpochId + cli + nativeGeneration + invocationFingerprint`。resume 前逐项校验。原生 ID 和文件路径只保存在宿主侧；不注入模型、不对普通客户端公开。

同任务续聊不因新建 turn/run 或 provisional ID 而换上下文。已完成任务重新追问可沿用 taskId，但必须新建 epoch。任务合并只改变 canonical 身份解析，绝不把两份原生历史直接拼接或互相 resume。

### 3.2 执行前确定边界

```text
消息准入、去重、持久化（可保留 provisional ID 供 UI 展示）
        ↓
确定 canonical taskId + contextEpochId
        ↓
校验旧原生绑定 / 挂起旧上下文
        ↓
读取正式历史 → 生成或复用快照 → 持久化执行绑定
        ↓
composeMessage → CLI adapter → Provider
```

优先级：任务卡 / 明确任务引用 → 结构化等待回答、重试、回调的既有任务身份 → 普通自然语言的执行前归集。

身份校验、原生 fresh/resume 决策和 seed 生成放在 FIFO 出队后的执行准备阶段。API 收到消息时可以预计算候选，但不能把排队前的 `cliSessionId` / seed 当执行时事实；当前 `coldStartSeed()` 的路由层判断，以及 turn-engine 中早于任务身份确认的原生 guard，需要一起调整顺序。

复用 `src/classify/task-attribution.js` 的模型与解析能力，但分离可 await 的身份判定与任务状态判定。当前解析对缺失 relation 会回退 same；新的执行门必须拒绝格式不完整或目标越界的判定，不能把这种回退当隔离证明。无需第二套任务分类器。

普通消息只把必要的近期任务标题、决定摘要、当前消息及有界指代上下文发给归集器；不需要为判断任务边界把整个历史注入工作模型。同一准入结果持久化，重试复用，迟到结果用 turnId/revision 校验后应用。主模型执行后不允许异步归集偷偷改变该执行的隔离身份；纠正以可追溯的归属修订记录呈现，必要时下一轮建新 epoch。

归集失败允许有界重试，保留原始错误码和原因。无法判断时暂停主模型执行并显示可恢复错误；特别是「继续」「按上面做」不能默认为全新任务后丢掉指代依据。只有确实存在用户选择歧义时才要求选择任务。身份已明确的等待回答不走这段归集延迟。

### 3.3 完成、等待、切换

| 场景 | 处理 |
| --- | --- |
| 同一任务普通追问、修订 | 复用 epoch，快照不变，消息追加 |
| 等用户回答 / 外部回调 / 派发结果 | 保持归属和原生绑定，不因一轮结束封存；pending 请求必须携带 taskId / epoch |
| classify 确认 D 且结果持久化 | 进入封存流程；runner、后台生产者和未结算用量需全部核验 |
| 失败 / 取消 | 保存错误、partial 和用量；新任务必须 fresh。原任务重试按恢复证明决定 resume 或新 generation |
| A 尚未完成，明确切到 B | 在会话串行边界将 A 挂起并解除活动指针；B 新建自己的上下文。A 仍有等待/依赖时保留原生资料 |
| B 进行中收到 A 的迟到回调 | 按 A 的身份排队/恢复，不得追加到 B；已封存 epoch 不能被旧回调直接重新激活 |
| 完成后的 A 被重新提问 | A 的正式历史生成新 epoch；保留关联任务名和历史展示 |
| CLI / Provider 切换或大文件轮换 | 经同一生命周期入口；同任务筛选后的 checkpoint，验证目标能力；不取全会话最近 N 条 |

`active / suspended / sealing / sealed` 是新增资源生命周期，不替代 classify 的 P/D/W/B/E。只有 classify 负责业务完成判定；资源未释放通过独立字段表示。工作区有未提交修改时保留原工作区；上下文隔离不代表 Git 或工具环境已隔离。

## 4. 相关上下文如何选择

### 4.1 先限定范围，再排序

1. 校验会话、目录、任务访问范围，解析合并 alias，定位当前任务原文。
2. 当前任务起因、最新要求、有效决定、未完成事项作为必选集合。
3. 显式引用的消息、文档、产物按稳定 ID 加入候选；`taskGroups` 仅扩充候选范围。
4. 对候选按模块、路径、明确引用、当前问题相关性排序，只选片段。初期规则检索即可，不引入向量数据库。
5. 过期、被替代、相互矛盾的决定带状态和来源；已替代内容不作为当前事实。历史代码信息附基线，必要时读取当前代码核实。
6. 同一数据源按 messageId / toolCallId / artifact hash 去重；包装器、系统重试提示不能伪装成用户历史。

| 内容来源 | 默认策略 |
| --- | --- |
| 当前任务消息 / 决定 | 必选关键项，有预算地保留历史；工具调用和结果成组处理 |
| 同组任务 | 仅作为候选；同主题不足以允许全文注入 |
| 明确引用或依赖 | 只取引用指向的决定/结果/文件；冻结来源版本 |
| 项目与用户强制规则 | 保留适用规则并固定顺序；不能为了相似度或缓存过滤必要指令 |
| 私有/共享经验记忆 | 增加 taskId、module、sourceRef、supersedes 等索引元数据，筛选有效片段 |
| 技能 | 保留必需能力说明；按任务加载正文。CLI 强制加载的工具/技能目录列为实际能力边界 |
| 跨 agent 留言 / gateway 上下文 | 绑定任务或明确项目全局范围；无范围的历史留言不自动混入当前工作 |

初期复用已有 `taskGroups` 与消息/产物 refs；只为明确引用补 `contextRefs`（如 sourceTaskId、messageIds、artifactIds、reason）。若后续确实需要调度依赖，再独立扩展 `dependsOn`，不把主题分组改成依赖图。

### 4.2 可验证的快照

每个 epoch 初次启动时保存不可变 `ContextSnapshot`：

```json
{
  "schemaVersion": 1,
  "taskId": "canonical-task-id",
  "contextEpochId": "epoch-id",
  "policyVersion": 1,
  "sourceRevision": "durable-source-revision",
  "stablePrefixHash": "sha256:...",
  "snapshotHash": "sha256:...",
  "included": [
    {
      "sourceType": "message",
      "sourceId": "message-id",
      "sourceTaskId": "canonical-task-id",
      "reason": "current-task-decision",
      "contentHash": "sha256:...",
      "tokenCount": 320,
      "tokenCountKind": "estimated"
    }
  ],
  "excluded": [{"sourceId": "candidate-id", "reason": "unrelated-task"}]
}
```

此为建议数据契约，不是现有 API。`excluded` 仅记录本次有界候选，不扫描全库。审核时间、随机 snapshot ID、计数等保存在 manifest；不插入公共模型前缀。manifest 只存脱敏摘要、引用与 hash；敏感路径/原生句柄另存宿主记录。

内容快照应保存实际编译字节或内容寻址副本，不能只有可变源文件的 hash。新增检索和用户决定追加到后续消息；已注入内容不会因为新记忆而每轮改写。必要规则发生关键变化时显式增加受控补充，必要时轮换 epoch，并记录缓存变化原因。

预算按目标模型上下文上限，扣除系统/工具、输出预留、历史增长空间后分配；无法精确计数时标注估算，发送后以实际 usage 校准。当前需求和必要约束不能被静默截掉；超预算时明确报告，工具结果用完整持久化引用加摘要降载。

### 4.3 CLI 自动读文件是独立入口

`CLAUDE.md / AGENTS.md`、父目录规则、CLI 自动记忆、插件工具描述可能绕过 `composeMessage`。只做组装器不能保证它们全部受控。

逐 CLI 记录 `fresh / resume / instructionSources / requestVisibility / nativeArchive` 能力。保留仓库适用规则；MultiCC 管理的经验记忆改为快照投影；如 CLI 支持官方配置，使用经过验证的作用域开关或投影机制。不得修改主工作区的规则文件，也不能为隔离绕过高优先级指令。不能观测/控制的 CLI 标注为部分覆盖，不宣称严格模式通过。

## 5. 缓存与历史格式

请求排列为「稳定公共规则和工具定义 → 不变的任务快照 → 同任务追加消息」。CLI 协议不同，实际顺序由 adapter 映射并在请求出口验证。公共层内的会话专属路径、动态任务列表、时间戳等应能后移就后移；无法后移的原生 CLI 前缀差异需如实计入测量。

缓存收益分开评估：公共前缀跨任务的可复用部分、同任务追加历史、首次重建成本。新原生 ID 可能改变缓存键；不强行跨任务复用 thread ID / provider cache key。Provider / 模型 / 工具 schema 变化也可能导致失效。前缀 hash 一样只证明字节稳定，不保证服务商缓存命中。

冷启动优先用结构化事实、决定、工具结果摘要与完整证据引用，不伪造各厂商 JSONL，也不重放工具动作。相同 CLI 的任务内继续使用原生 resume；已存在的 `src/model-history-converter.js` 继续负责 API 字段与调用配对兼容。新的 snapshot builder 决定取哪些内容，converter 决定目标协议如何表示；两者不混合。

对照基线记录未缓存输入 token、cacheRead/cacheCreation、输出 token、实际价格口径费用、首字延迟、任务质量和重复调查次数。用两类实验分别测「同任务多轮」与「独立任务切换」，控制模型、Provider、工具 schema 和时间窗口；不能只看总命中率或承诺固定降本比例。

## 6. 原生归档与回收

### 6.1 先证明可以恢复

正式存档的必要覆盖包括：用户原文、最终/partial 助手结果、工具名/参数/结果及配对、错误、产物引用、用量结算。大工具结果应单独保存完整 blob/hash，摘要不是唯一副本。原生内部 bookkeeping 或不可移植推理字段不作为重建工作上下文所需数据；对未知、不能确认属于可丢弃项的记录保留原文件并标记覆盖不足。

两条当前事实源通过统一 repository 提供带来源和稳定 ID 的数据，补全缺失字段和原始结果引用。快照是可重建投影，不新增第三份可编辑对话事实源。归档时检查源记录仍可读、引用/附件存在、工具配对完整、终稿/用量已提交，并保存 coverage revision；删除前再次核验 revision 与引用 pin。

### 6.2 分阶段提交，重启可恢复

```text
确认任务完成 / 当前 epoch 可关闭
  → sealing 意图持久化（附 taskId、epoch、revision）
  → 停止并排空对应原生进程、工具及用量生产者
  → flush 正式历史，验证 coverage / 引用
  → 将绑定置为不可 resume，持久化解除活动指针
  → 归档对应原生文件并保存 manifest（路径、hash、archivedAt）
  → sealed
  → 保留期到达且无任何 pin，GC 删除
```

采用现有 SQLite 和生命周期基础设施实现 CAS、幂等 operation key 与恢复扫描；JSON 历史、SQLite 和文件移动不能假定在一个数据库事务内完成。每一步记录意图与结果，重启后续做。宿主未完成绑定解除时不能启动新任务；文件移动失败但旧绑定已可靠隔离时可启动新的原生上下文，同时保留待处理归档告警。归档失败不能被吞成成功。

保留期建议先用 **30 天，按 archivedAt 计算**；这是新设计默认值，不是当前实现。它只是回收条件之一。任何 active/suspended epoch、待处理外部结果、未封存用量或恢复任务的引用都会阻止物理删除。保留期内也不得自动 resume 已 sealed 的旧线程。

统一托管 Codex rollout、Claude `.jsonl/.pruned.jsonl`；OpenCode 等数据库型原生历史用 adapter 支持的会话隔离/归档能力，不按扩展名删除整个数据库。复用 `src/task-run-cleanup.js` 的 ownership、allowlist、realpath、symlink、permit 检查，避免建立第二套宽松文件删除器。GC 与旧 TTL 清理器对同一文件只能有一个所有者。

关闭上下文不自动清理工作区、删除任务卡或正式聊天历史。用户“清理显示”“重置模型上下文”“任务归档”的语义保持分离。

## 7. 建议模块结构与数据落点

```text
src/context/                           # 新增的共享能力目录
  boundary.js                          # 执行前身份确认、epoch 选择与校验
  repository.js                        # 正式历史/台账/记忆/refs 的有界读取与去重
  snapshot.js                          # 候选筛选、预算、稳定编译、manifest
  lifecycle.js                         # native 绑定、挂起、封存、恢复和 GC 编排
  store.js                             # epoch / snapshot / native manifest 持久化
src/routes/context.js                  # 状态/注入清单读取，沿用现有鉴权
```

`src/task-run-context.js` 保留现有入口，把通用编译部分委托给 snapshot；`src/task-context-host.js` 继续承担任务元数据和消息宿主接线。`message-composer` 消费已确定的 snapshot/delta，不承担检索或文件删除。`server.js` 仅增加有限接线，遵守 3000 行治理；有预算压力时先抽宿主接线，不堆业务分支。

建议在现有 `task-runs.sqlite` 增加独立 `context_epochs / context_snapshots / context_native_manifests` 表及自身版本迁移，复用连接和事务基础设施，由 `context/store.js` 封装；普通聊天无需伪造 taskRun。session record 仅保存活动 epoch 引用和兼容原生指针。大结果和快照正文存 MultiCC 数据目录的内容寻址文件，新增 `src/paths.js` 路径，纳入备份/恢复与 GC pin 检查，禁止放到 7 天过期的临时 artifacts。

迁移由现有数据库初始化入口统一调用，不能由两个模块独立覆盖同一个 `user_version`。上下文表以 taskId/epoch 建索引，旧 JSON 消息按稳定 refs 定位并增量缓存；避免在每次发送时全库扫描或反复序列化整份会话。

正式历史字段只增补必要的 source、epoch、tool/blob refs；缺少旧字段的历史照常可读，但未证明完整覆盖之前不给旧原生文件自动删除许可。不全量改写原生历史、不重写旧 taskId。

## 8. 改动范围与影响矩阵

以下为实施范围估算，列出的新增模块/API 均尚不存在。文件数量随接线拆分调整，不是工期承诺。

| 层 | 主要既有文件 / 新增点 | 改动 | 风险 |
| --- | --- | --- | --- |
| 准入与任务边界 | `src/chat/turn-engine.js`、`src/task-context-host.js`、`src/classify/task-attribution.js`、`src/classify/state-machine.js`、新增 boundary | 执行前等待身份结果、锁定 epoch、拒绝过期回调 | 高：延迟、归集竞态、误判续聊 |
| 任务关系与冷启动 | `src/task-board.js`、`src/routes/task-board.js`、`src/task-run-context.js`、新增 repository/snapshot | 复用 aliases/groups/refs；删除吞错裸启动；受控任务引用 | 中高：任务合并、历史去重 |
| 持久化 | `src/session/chat-history-service.js`、`src/task-run-host.js`、`src/task-run-store.js`、`src/task-transcript-repository.js`、`src/session-persistence.js`、`src/paths.js`、新增 store | 字段补齐、coverage、epoch/snapshot 迁移、blob 生命周期 | 高：缺失证据、跨存储崩溃一致性 |
| 原生执行 | `src/cli-switch.js`、`src/chat/native-session-state.js`、`src/cli-adapters/*` | 任务绑定校验、fresh/resume、能力声明、按任务交接 | 高：多 CLI 行为不一 |
| 回收与恢复 | `src/chat/finalize-host.js`、`src/task-run-production.js`、`src/task-run-cleanup.js`、`src/task-run-recovery.js`、两个 context/rollout guard、`src/chat/transcript-prune.js`、新增 lifecycle | 完成钩子、旧清理器统一委托、幂等封存与 GC | 高：并发回调、误删、用量漏账 |
| 所有注入入口 | `src/message-composer.js`、`src/memory/folder-service.js`、`src/memory/runtime.js`、`src/notes-store.js` 及 CLI 指令加载 | 必需规则与经验事实分流；快照与 task-scoped delta | 高：漏约束、缓存前缀变化 |
| 异步续接 | `src/session-delivery.js`、`src/wait-service.js`、`src/classify/user-input-host.js`、dispatch/outbox 宿主 | 补 taskId/epoch 来源校验，保留既有直投与去重语义 | 高：等待回答串任务、迟到事件 |
| Web | `public/chat-context-controls.js`、必要的 chat 事件接线、i18n | 复用上下文入口显示任务/封存状态、查看来源清单 | 低中：不重做聊天/任务详情页 |
| App | `app/lib/services/chat_service.dart`、`app/lib/widgets/chat_runtime_panels.dart` 等现有上下文入口 | 可选状态/来源明细展示，沿用聊天 transport | 中：新增字段及渲染适配 |
| API / 治理 | 新增 `src/routes/context.js`、`server.js`、bootstrap/备份接线、契约测试 | 查询快照清单；同目录/会话授权、错误透传、行数约束 | 中 |

最小闭环预计新增约 6 个服务端模块，改动约 15–20 个既有核心文件；覆盖全部 CLI、所有注入入口、Web/App 和清理器后约 25–35 个既有文件，测试另计。

建议只新增只读端点：`GET /api/sessions/:id/context` 和 `GET /api/task-board/tasks/:taskId/context-snapshots`，支持分页，返回 epoch、归档/coverage 状态和脱敏来源清单；不返回凭据、原生路径或完整私有提示。历史详情通过已有授权历史接口定位。上下文重置继续复用现有 reset/rotate 路由，新生命周期接管其实现。严密检查 task/session 归属，不能因为知道 snapshot ID 就读取跨目录内容。

## 9. 分阶段交付

| 阶段 | 可独立验收的交付 | 放行条件 |
| --- | --- | --- |
| P0 历史与审计 | 两类正式历史统一读取、工具证据补齐、shadow manifest、CLI 能力清单、费用基线 | 原始消息/工具/产物可回查；此阶段不切换、不删除原生文件 |
| P1 任务边界 | 任务专属会话先接 epoch；普通聊天加入执行前归集；所有 resume 校验绑定 | A→B 无 A 私有标记，A→A 保持连续，回答/回调归属正确 |
| P2 上下文选择 | 固定 snapshot、groups 候选、contextRefs、记忆与交接统一入口、Web/App 查看来源 | 同任务快照字节稳定，已知注入入口有覆盖证据，隐含约束测试通过 |
| P3 封存与回收 | 普通/隐藏聊天完成封存、旧清理接管、重启恢复、archivedAt TTL | coverage/producer/pin 检查通过，故障注入不丢数据，实际缓存与费用对照完成 |

按目录或会话启用新策略，先测试身份明确的任务，随后普通聊天；已有运行中的 native 不在半轮切换。迁移时旧 epoch 标 `legacy-unverified`，到安全边界从正式存档新建，原件保留；不要把已混入多任务内容的线程直接改标签宣称隔离。

回滚只影响下一次准入策略，保留已创建 epoch / snapshot / manifest；旧原生绑定不得自动复活。发布旧二进制前必须核验它不会绕过新绑定规则；单独关开关不能代表安全降级。默认先暂停 GC，数据保持可恢复。实现完成后 commit/merge，服务由用户手动重启。

## 10. 验收与影响控制

| 验证场景 | 必须观察到的结果 |
| --- | --- |
| A 内置唯一私有标记，切换无关 B | 实际工作模型请求中无该标记；覆盖 history、handoff、memory、notes、CLI 自动加载入口 |
| 同任务连续三轮、临时 ID 每次变化 | canonical task/epoch 不变，第一轮 seed 仅注入一次，后续追加 |
| 完成 A 后重新追问 A | 新 epoch，从正式历史恢复必要决定，旧原生 thread 不 resume |
| 明确引用 A 中一个决定 | B 仅得到指定片段和来源，不带 A 的其他内容 |
| classify 慢、失败、回包迟到 | 主模型不提前使用未确定的旧上下文；原始错误可见；过期结果不能改当前绑定 |
| 等待回答在 idle/busy 两种时序到达 | 复用原 task/epoch，保留现有回答直投语义，不落到普通暂存队列 |
| A 回调在 B 运行时到达 | 调度到 A，B 请求无回调正文；sealed epoch 的旧回调不直接恢复线程 |
| 工具结果大、附件缺失、调用缺结果 | 完整证据可回查；有缺口不给物理删除许可，错误指出缺失的来源 |
| 写历史失败 / 意图落盘后崩溃 / 文件移动后崩溃 | 重启按日志续做；无重复 user 消息、无错误 resume、无误删 |
| 同一归档操作重复投递 / stale permit | 幂等，过期 revision 不删除；关联任务合并仍能定位原证据 |
| Codex 切模型、Claude 切 CLI、Auto fresh retry | 不串任务；原工具关联保持；底层异常经过转换/中继仍能展示 |
| 原生存档达 TTL 但仍有依赖 | 不删；所有 pin 释放后才回收；`.pruned.jsonl` 用量先封存 |
| 隐藏历史 / 归档卡片 / 任务合并 | 显示操作不改变模型恢复事实源，引用和 alias 不丢 |
| Web/App 新状态、旧数据缺字段 | 聊天 DTO/渲染保持可读；错误和等待卡正常，来源明细按授权访问 |
| 同任务与跨任务的成本对照 | 分别报告缓存 token、未缓存 token、费用、首字延迟和质量，不只报命中率 |

扩展现有 `tests/test-task-context-host.js`、`tests/test-task-bound-session.js`、`tests/test-task-run-context.js`、`tests/test-cli-switch.js`、`tests/test-task-run-cleanup.js`、`tests/test-task-run-recovery.js`、`tests/test-user-input-answer-delivery.js`、`tests/test-memory-runtime.js`、`tests/test-chat-context-controls.js`；为 boundary、snapshot、native lifecycle 增加少量有实质故障场景的测试。实现阶段运行对应 core/security/state/provider-router/contracts/architecture 套件，i18n 有变化再执行生成器与检查；实际请求抓取只保留脱敏证据。

严格承诺的是：任务身份明确、自动注入来源受控、原生绑定不可跨任务、删除前有恢复证据。语义相关性不是数学保证，需要允许按需回查；Agent 后续工具主动读取的工作区内容、第三方 CLI 未开放的隐式指令入口，不能仅靠快照模块保证全部相关。上下文污染减少的同时，首次启动和误分类恢复可能增加开销，必须通过上述质量/费用对照决定推广范围。
