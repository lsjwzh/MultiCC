# 任务虚拟会话（Task-as-Virtual-Session）重设计

> 状态：设计待评审（2026-08-18）
> 作者：架构师会话（multicc-codex-chat-04）
> 依据：三份现状探查（task-run 台账 / spawn·resume 链路 / 前端·WS），文中所有 file:line 均已核对。

## 0. 背景与问题

任务板当前执行模型：每个任务回合（run）在一个隐藏执行槽（`taskExecutionSlot`）上跑一个 CLI 回合，**每轮把任务历史编译成一堵上下文文本墙、伪装成一条 user 消息投递**；槽位历史即用即弃，canonical 记录是 task-run 台账（sqlite）。

生产实测（omnigent 对比任务、AI Loop 接续任务）暴露四个系统性问题：

| # | 问题 | 根因 |
|---|---|---|
| P0-1 | 包装器污染：详情页每条追问显示两遍（原文 + 脚手架墙），且下一轮把它当「用户发言」回放 | wrapper 作为普通 user 消息落台账（turn-engine.js:953-970 → recordMessage），与 `kind:'admission'` 原文并存；handleMessages 不按 kind 过滤（task-board.js:1264-1296） |
| P0-2 | 失败静默：worker 实际干活 4 分钟，classify 判 `classifier_api_error + result_not_durable` → partial output 整个丢弃；台账只有 admission、0 token；卡片仍显示 active；无重试 | 失败 run 不写任何 message（只有 0-token usage 兜底事件，task-run-host.js:436-455）；卡片状态与 run 失败无联动 |
| P1-1 | 幻影卡：classify 的 onClassifyGoal 从 worker 回合自推 goal 另建 `tsk_` 空壳卡，不归并到回合已 stamp 的 `tsk-` 真卡 | classify 归因不优先使用 turn 上 stamp 的 taskId；执行槽回合允许新建卡 |
| P2 | 成本/延迟：每条追问全量上下文重放（~40k fresh input、cacheRead 0、85-100s） | 无原生会话续接，每轮重新编译全部历史为单条消息 |

## 1. 目标与非目标

### 目标（用户原话锚定）

1. **每一个任务就是一个虚拟会话**：详情展示与对话会话一致——消息原文、tool use 卡片、token usage 条、运行中流式渲染。
2. **任务完成后只删 jsonl 和执行环境**，消息原文 / tool use / token usage 持久保留。
3. **下次对话带上保存的上下文**——【仅当前任务 + 各层级共享上下文】，且以真多轮对话形态（而非文本墙）。

### 非目标

- 不改变调度/租约/幂等语义（leaseEpoch、outbox、slot CAS 全部不动）。
- 不改变 Commander 路由拓扑（板 → Commander → 槽位的单向路由不变）。
- 不做跨任务上下文共享（虚拟会话边界 = 任务边界 + 各层共享上下文）。
- 不删除 buildTaskRunContext 编译器——它降级为回退路径和 manifest 来源。

## 2. 核心设计：台账 = 唯一事实源，jsonl = 每轮重建的临时投影

```
┌─ 任务虚拟会话（task-run 台账，sqlite，永久）────────────────┐
│  admission（用户原文，kind='admission'）                    │
│  assistant 消息（content + tools + usage + cost + partial） │
│  tool_use / tool_result 配对数据（在 assistant.tools 内）    │
│  error 条目（kind='error'，失败原因 + 中断草稿）             │
│  usage 事件（task_run_usage_events，已有）                   │
└──────────────┬─────────────────────────────────────────────┘
               │ 每轮 run 开始时
               ▼ 重建（新模块 transcript-rebuild）
   槽位原生 jsonl（临时投影）
   ~/.claude/projects/<slug>/<newId>.jsonl
               │
               ▼ spawn
   claude -p --resume <newId>
        --append-system-prompt <任务简报 + 各层共享上下文>
   stdin: 用户原文（干净的一条 user 消息）
               │ 回合结束（terminal）
               ▼ 现有槽位回收（不变）
   删除 jsonl + chat history + 清 cliSessionId（worktree 保留复用）
```

**关键洞察**：现状里「删 jsonl」和「续上下文」的矛盾，靠把台账升级为完整 transcript 存储解决——jsonl 不再是事实源，只是台账的每轮投影。terminal 时消息已落台账（现有 recordMessage 链路），回收照删 jsonl，下一轮从台账重建一份新的。

### 2.1 为什么可行（现状证据）

- **jsonl schema 完全已知**：`src/chat/transcript-prune.js:5-43` 头注释就是最完整的 schema 文档，且修剪器**就地重写 jsonl 后 session 照常 `--resume`**——证明 Claude 接受外部改写的合法 transcript。
- **id 可控**：claude 会话 id 是 multicc 自己分配的 UUID（`_streamSessionId`，turn-engine.js:1620-1625），不是 CLI 生成的；新 id + 预置文件 + `--resume` 与现有 respawn 路径同形。
- **重建数据已具备**：chat-history 的 assistant 终稿带 `tools:[{id,name,input,result,is_error,startedAt,endedAt}]`（turn-engine.js:392-397）——正好覆盖 tool_use/tool_result 配对重建所需。
- **slot 进程本来就每轮新建**：槽位回收后下轮 run 重新 spawn，所以 `--append-system-prompt` 天然是 per-run 的，任务简报/共享上下文走 system 层没有任何进程存留问题。

### 2.2 claude jsonl 重建的不变量（违反即 API 400 或会话错乱）

来自 transcript-prune.js:31-43 的硬约束：

1. **parentUuid 链完整**：条目构成单链，`--resume` 从叶向根回放；链中第一条 `parentUuid:null`；严禁中间挖洞。
2. **tool_use ↔ tool_result 配对不可断**：assistant 的每个 tool_use 块必须在后续 user 条目里有对应 `tool_use_id` 的 tool_result。
3. **不伪造 thinking 签名**：`thinking`/`redacted_thinking` 块带不可伪造的 signature——重建时**整条丢弃 thinking 块**（合法，不影响 API 校验）。
4. 每行需带 `sessionId`（= 新分配 id）、`cwd`、`timestamp`、`type`、`message`。

重建产物校验器（fail-closed）：重建后对文件做完整校验（链完整、配对齐全、JSON 可解析）；**任何一步失败 → 回退到现有编译文本墙模式**（行为与今天一致，不会更糟），并记日志 `task_run_transcript_rebuild_failed`。

### 2.3 codex 的处理（明确的取舍）

codex rollout 重建更脆弱：`rollout-<ts>-<thread_id>.jsonl` 文件名含时间戳、首行 `session_meta`、fork 语义、provider 分 home（`~/.multicc/codex-homes/<provider>/`）。**阶段 2 只做 claude；codex 槽位继续走编译文本墙**（行为不变）。codex 重建列为阶段 4 可选项，届时以同样「台账 → 投影」模式实现。这是有意的分期取舍：claude 是任务槽主力 CLI，codex 路径不因本设计回退任何东西。

## 3. 数据模型变更

### 3.1 台账消息升级（零迁移方案）

`task_run_messages` 已有 `content_json` + `metadata_json` 两个自由 JSON 列（task-run-store.js:171-182），**不需要 schema 迁移**。

`recordMessage`（task-run-host.js:303-314）扩展：assistant 消息把以下字段白名单式存入 `metadata_json`：

| 字段 | 来源 | 说明 |
|---|---|---|
| `tools` | turn-engine 终稿 `cs.currentToolCalls` | `[{id,name,input,result,is_error,startedAt,endedAt}]`；单个 result 超 20k 字符截断并置 `truncated:true`（与 chat history 展示口径一致） |
| `usage` | 终稿 `usage` | `{input,output,cacheRead,cacheCreation}` + roleBreakdown |
| `cost` | 终稿 `cost` | 原样 |
| `durationMs` / `turnTimings` | 终稿 | 计时行渲染 |
| `partial` | close 时 partial checkpoint | 布尔，现状丢失的标志补上 |
| `wrapper` | 见 §4.1 | 布尔，标记包装器消息（双保险，见下） |

新增 kind 取值（kind 列无 CHECK 约束，自由串）：`'error'`（失败条目）。现有 `'admission'`/`'legacy_import'`/`'message'` 不变。

**幂等与唯一性不变**：`UNIQUE(run_id, message_id)` + `stableMessageId` 不变；metadata 扩容不影响去重。

### 3.2 DTO 变更

- `publicMessageDto`（task-runs.js:61-70）：增加白名单字段 `tools/usage/cost/durationMs/partial/wrapper`（从 metadata 透出，剥掉 leaseEpoch/deliveryId 等内部字段）。
- `GET /api/task-board/tasks/:id/messages`（task-board.js:1260）：items 增加同名字段 + `kind`；**过滤 `wrapper===true` 及旧格式包装器**（见 §4.1）；`text` 字段保留（向后兼容旧前端）。
- run DTO 增加 `error`（失败原因摘要）供卡片渲染。

### 3.3 失败语义（治 P0-2）

run terminal 为 failed 时（finalizeTerminal / rejectTaskRun 路径）：

1. 台账写一条 `kind:'error'` 消息：`role:'system'`，content = 人类可读失败原因（如「上游分类器错误，结果未持久化」），metadata 带 `{code, retryable}`。
2. worker 已产出的 partial output（close 时 partial checkpoint 已会走 appendChatMessage → 台账）补 `partial:true` 标志，详情页显示为「中断草稿」。
3. run DTO `executionStatus:'failed'` + error 摘要 → 任务卡片显示失败徽标 + 原因（status-presentation 注册表加映射）。
4. **有界自动重试**：`retryable` 的失败（classifier_api_error 等瞬时类）自动重投 1 次（新 run、新 leaseEpoch，台账完整保留两次尝试）；非 retryable 或重试再败 → 保持 failed，等用户追问。重试上限是硬编码 1，不做可配置（避免无意识放大成本）。

### 3.4 classify 归因（治 P1-1）

- 归因优先级：turn 上 stamp 的 `taskId`（`_currentTaskId`）> 现有 goal 推断。**执行槽（taskExecutionSlot）回合 classify 一律不得新建任务卡**——只许归到 stamp 的 taskId 或放弃。
- onClassifyGoal 归并：goal 推断命中已有同 dir 任务（标题相似度/已 stamp 卡）时更新该卡，不新建。

## 4. 执行路径变更

### 4.1 包装器退出对话流（治 P0-1）

现状：`buildCommanderRoutedMessage`（task-board.js:933-942）把「【Commander 单向路由任务】+ 说明 + 【任务：title】+ 正文 + 编译上下文」作为一条 user 消息投递，并落台账。

新模型下三层注入分离：

| 层 | 内容 | 载体 | 落台账？ |
|---|---|---|---|
| system 层 | 角色提示 + 任务简报（标题/goal/领域/摘要）+ 各层共享上下文（目录共享记忆等） | `--append-system-prompt`（claude）/ `-c` 指令（codex，沿用文本墙期） | 否 |
| 会话层 | 历史回合（用户原文 ↔ assistant 含 tool 配对） | 重建 jsonl `--resume`（claude）/ 文本墙（codex 暂） | 已有 |
| 当前轮 | 用户追问原文 | stdin 一条干净 user 消息 | 是（kind='admission' 已存） |

- 投递给槽位的消息就是**用户原文**（可带极短前缀标注任务归属，用 🔇 系统注入前缀——isSystemInjected 机制已存在，classify/看板扫描已会排除它）。
- **旧数据过滤**：handleMessages 与上下文编译排除（a）`metadata.wrapper===true` 的新消息，（b）内容以 `【Commander 单向路由任务】`/`【任务：` 开头的遗留 user 消息（前缀匹配，一次性清洗判断，不改旧数据）。
- buildTaskRunContext 保留：(a) codex 槽位继续用；(b) claude 重建失败时回退用；(c) contextManifest/hash 继续作为 run metadata 的可观测性产物。

### 4.2 共享上下文的分层（用户要求的「各层级」）

system 层注入内容按层级组装（每段有预算截断，总量 ≤ 4k 字符）：

1. **会话级**：槽位角色提示（现有 rolePrompt 机制）。
2. **任务级**：任务标题 / goal / 领域 / 摘要 / 当前状态。
3. **目录级**：目录共享记忆（`_shared` 记忆目录摘要）+ 目录约定。
4. **项目级**：全局共享上下文（如有）。

注意脱敏约束：redactText/forbiddenSessionKeyName（task-run-context.js:36-98）的规矩继续适用——**台账和注入文本里绝不携带 cliSessionId/nativeSessionId**；重建 jsonl 的 id 只来自新分配的 UUID。

### 4.3 重建 + resume 的回合流程（claude）

1. run 开始（beginTaskRun 已有）：写 admission（原文）。
2. 投递前（task-run-host beforeDeliver 阶段新增）：调用 `transcriptRebuild({taskId, slotRecord})`：
   - 取该任务**所有历史 run** 的台账消息（排除 wrapper/error 以外的……不，error 条目也不进投影——投影只含 admission(user 原文) + assistant(终稿/partial) 序列）。
   - 分配新 UUID；按 §2.2 不变量生成 jsonl 行（user/assistant 交替、tool 配对、丢弃 thinking、parentUuid 链、首条 parentUuid:null）。
   - 写入 `~/.claude/projects/<slug(slot worktree cwd)>/<newId>.jsonl`；校验；失败 → 回退文本墙。
   - 把 newId 写入 slot record 的 `_streamSessionId`（沿用现有字段与 respawn 逻辑）。
3. spawn：现有 chat-stream 路径，进程新建，`s.started=false` 首轮用 `--session-id <newId>`——**预置文件已存在时首轮即等价 resume**（需验证：若 `--session-id` 对已存在文件的行为不符，则置 `started=true` 直接走 `--resume`；这是实现期第一个要写的 golden 测试）。
4. 回合进行：消息走现有 recordMessage 链路落台账（含 §3.1 新字段）。
5. terminal：现有回收照删 jsonl、清 `_streamSessionId`——投影销毁，事实源已在台账。

### 4.4 任务维度流式转发（详情页实时渲染）

现状：slot 回合事件只发 slot 自己的 WS 客户端（恒为空，task-context-host.js:118-125）。

变更：`taskContextHost.broadcast`（或 server.js chatBroadcast:2393-2401）增加一个转发 hook——当会话是执行槽且有活动 taskRun 时，把 payload 包装为 `{type:'task_run_stream', taskId, runId, slotEvent:<原 payload>}` 经 workspace broadcast（runtime.js:83-101）发到 dir 订阅者 + metaClients。

- 流量控制：text_delta 级事件转发做 ~100ms 节流合并（usage/result/tool 事件不节流）。
- 安全：payload 不含任何新敏感面（slot 本来就把同样内容发给「它自己的客户端」，只是恒为空）；转发只到本 dir 订阅者，与现有 task_board_update 同权限面。
- 前端无订阅时零成本（workspace broadcast 本就扇出）。

## 5. 前端变更

### 5.1 Web 任务详情（manage-taskboard.js / manage.html）

渲染面零新组件：复用 `MultiCCChatHistoryView`（chat-history-view.js:397-438 renderAssistant/renderUser/hydrateTool/buildUsageLine/renderToolTrajectory）。

- `#tb-detail-modal` 的消息流容器（`.tb-msgs`）改为 history-view 实例的宿主；items 的新字段（content/tools/usage/durationMs）直接映射到聊天消息 DTO 形态 `{role, content, tools, usage, ts, durationMs, id}`。
- run 边界渲染为分隔条（「第 N 次执行 · 状态 · 时间 · token 合计」），复用现有 renderTaskRunSummary 的精简版。
- `kind:'error'` 渲染为错误卡片（红边 + 原因 + 「重试中/已重试」标记）；`partial:true` 的 assistant 气泡带「中断草稿」角标。
- 流式：manage 页订阅 `/ws/meta`（已有 metaClients 通道），收 `task_run_stream` 且 taskId 匹配当前打开详情时，把 slotEvent 喂给 history-view 的流式入口（createAssistantBubble/updateToolInput/addToolResult，chat-history-view.js:181-277, 726）。
- 旧任务降级：无 tools/usage 字段的 items 按现有纯文本行渲染（自动，因为渲染器对空 tools 本就跳过）。

### 5.2 App（Flutter）

- `TaskMessage` 模型（models/task_board.dart:142-174）增加 `tools/usage/durationMs/kind/partial` 解析。
- `_TaskDetailSheet` 消息区（task_board_view.dart:1236-1288）改用现成 `MessageBubble`（message_bubble.dart:213）+ `ToolCallGroup`（tool_card.dart:336）：把 TaskMessage 映射为 `ChatMessage`（models/message.dart:111-133）。
- 流式：`workspace_service.dart` 已订阅 dir 级 WS，增加 `task_run_stream` case → 详情 sheet 打开且 taskId 匹配时转发给消息列表状态（ChatEvent 模型已有全量事件类型，:263-437）。
- 任务板列表的失败徽标：taskDisplayState 走 status-presentation 注册表，服务端 run error 落进 task DTO 后自然显示。

## 6. 不变量（全设计必须守住）

1. **台账唯一事实源**：展示、上下文重建、usage 结算都只读台账；slot chat-history 和原生 jsonl 永远是一次性投影。
2. **包装器永不进对话**：不进展示流、不进重建投影、不进 classify 材料（🔇 前缀 + wrapper 标志 + 遗留前缀过滤，三层保险）。
3. **重建合法性**：§2.2 四条 jsonl 不变量由校验器 fail-closed 强制；校验不过必回退文本墙，禁止带病 spawn。
4. **调度语义不动**：leaseEpoch / slot CAS / outbox 幂等 / quarantine 一行不改；重建失败不等于 run 失败（回退路径照常执行）。
5. **脱敏**：台账与注入文本不出现 cliSessionId/nativeSessionId/凭证（沿用 redactText 规则）。
6. **usage 不漏账**：失败 run 的 partial output 落台账 + unobservable 兜底事件沿用；重试 run 独立 leaseEpoch 独立结算。
7. **向后兼容**：API 只加字段不删字段（`text` 保留）；旧前端看不到新字段仍可用；旧任务数据降级渲染。

## 7. 失败模式与对策

| 失败模式 | 影响 | 对策 |
|---|---|---|
| Claude Code 升级改 jsonl schema | 重建的 transcript 不被接受 | golden fixture 测试锁 schema（fixtures 存合法/非法样例）；校验器 fail-closed 回退文本墙；`prepareSpawn` 清洗逻辑（claude.js:98-133）保持兼容 |
| `--session-id` 遇已存在文件行为异常 | 首轮 spawn 失败或开新空会话 | 实现期第一个 golden 测试验证；不符则置 `started=true` 走 `--resume` |
| 台账 assistant 缺 tools（旧数据/异常落库） | 重建断 tool 配对 | 重建器对无 result 的 tool_use 合成 `tool_result{content:'(结果未记录)', is_error:false}`；或整条 tool 块降级丢弃只留 text（二选一，实现期以 fixture 测试定） |
| 超长任务（几十轮）重建文件过大 | 重建耗时、prompt cache 仍从头算 | 投影与原生会话同构，cache 命中以前缀为准，重建文件字节稳定即命中；超 200 条消息时按 buildTaskRunContext 同策略头截（首条保留 admission #1 + 最近 N 条，截断处插一条 `isMeta` 说明行） |
| 流式转发风暴（大 dir 多任务并跑） | metaClients 流量放大 | delta 事件 100ms 节流合并；只有打开详情的 taskId 才被前端消费 |
| 重试放大成本 | 失败任务烧钱 | 重试硬上限 1 次，仅 retryable 错误码；失败原因写卡片让用户决策 |
| codex 用户期待同等体验 | codex 槽仍是文本墙 | 明确文档化分期；codex 重建列阶段 4 |

## 8. 分阶段计划与验收标准

### 阶段 1 · 止血（小改，独立可合）

改动：
- handleMessages + 上下文编译过滤包装器（wrapper 标志 + 遗留前缀匹配）。
- 失败 run 写 `kind:'error'` 台账条目 + run DTO error 摘要 + 卡片失败徽标 + 有界重试 1 次。
- classify：归因优先 stamp taskId；执行槽回合禁新建卡；goal 归并。
- recordMessage 补 `partial` 标志（中断草稿可见）。

验收：
- 隔离测试复现 P0-1：详情 items 无包装器文本，admission 原文仅出现一次。
- 隔离测试复现 P0-2：fake worker 失败 → 台账有 error 条目 + partial 草稿，run DTO executionStatus=failed，重试 run 产生且仅 1 次。
- 隔离测试复现 P1-1：slot 回合 classify 不再产生 `tsk_` 新卡。
- 全量回归绿（含三条静态治理守卫：request-locality / api-contracts / line-budget）。

### 阶段 2 · 后端核心（台账 transcript 化 + 重建 resume）

改动：
- recordMessage 落 tools/usage/cost/durationMs（§3.1）；publicMessageDto 透出。
- 新模块 `src/chat/transcript-rebuild.js`：台账 → claude jsonl 投影 + 校验器 + golden fixtures。
- 投递链路：claude 槽位走「system 层注入 + 重建 resume + 原文 stdin」；codex 槽位保持文本墙（明确分支点）。
- 上下文分层组装器（§4.2），总量预算 4k。

验收：
- golden 测试：多轮含 tool 配对的台账 → 重建文件通过校验器；缺 result / 旧数据降级路径均合法。
- 隔离全栈：两轮追问任务，第二轮 spawn 的 jsonl 含第一轮完整配对；fake CLI 断言收到的 stdin 只有用户原文（无包装墙）。
- 生产口径验证（手动）：追问的 fresh input 从 ~40k 降到增量级、cacheRead > 0。
- 回退路径测试：篡改台账使校验失败 → 自动走文本墙且 run 成功。

### 阶段 3 · 前端聊天化

改动：§5.1（Web）+ §5.2（App）+ §4.4 流式转发。

验收：
- Web 详情页：tool 卡片、usage 行、run 分隔条、error 卡片、partial 角标全部渲染；旧任务纯文本降级不报错。
- 流式：run 进行中打开详情能看到增量文本与 tool 卡片实时更新（fake CLI 慢速输出验证）。
- App 同构：MessageBubble 复用渲染 + workspace WS 流式。
- 旧版 App/Web 打新服务端不崩（字段兼容测试）。

### 阶段 4 ·（可选）codex 投影重建

同模式实现 rollout 重建（session_meta 首行 + 文件名/目录约定 + provider home），claude 路径的全部测试同构复制。排期另议。

## 9. 风险登记（实现期需持续关注）

1. **jsonl schema 漂移**（最大风险）：缓解靠 golden fixture + fail-closed 回退；每次升级 Claude Code 后跑 fixture 测试。
2. **双写一致性**：recordMessage 扩展字段在 chat-history 与台账两处写——台账写在 chat-history 之前（task-context-host.js:97-116 顺序已是如此），台账失败会阻断 chat-history 写入，需评估是否改为台账失败仅记日志（倾向：保持现状，台账是事实源，失败应阻断）。
3. **server.js line-budget**：wiring 新增行受 3000 行棘轮约束，新逻辑一律进新模块，server.js 只加 wiring 行。
4. **静态治理三守卫**：request-locality / api-contracts / line-budget 的断言涉及新增 API 字段与模块时要同步更新（记忆：migration-debt-guard-sync）。

## 10. 决策摘要

| 决策 | 选择 | 备选（否决理由） |
|---|---|---|
| 台账扩容方式 | metadata_json 白名单字段（零迁移） | ALTER TABLE 加列（无查询需求，徒增迁移面） |
| 上下文续接 | 台账重建 jsonl + CLI resume | 继续文本墙（P2 成本不解决）；持久保留 jsonl 不删（违背用户「删 jsonl」要求，且执行环境残留） |
| 任务简报注入 | system 层（append-system-prompt） | 每条追问内嵌（污染对话流，P0-1 重演） |
| codex | 阶段 2 保持文本墙，阶段 4 再做 | 同步做（rollout 格式脆弱，拉长关键路径） |
| 失败重试 | 自动 1 次（retryable 限定） | 无限重试（成本失控）；不重试（瞬时错误体验差） |
| 流式 | workspace/meta 转发 slot 事件 | 详情页轮询（延迟差）；slot 直订（破坏 slot 隐藏边界） |
