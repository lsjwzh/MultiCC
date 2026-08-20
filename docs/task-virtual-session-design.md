# 任务虚拟会话（Task-as-Virtual-Session）重设计

> 状态：**已实施并落地（P1–P5 / #34–#35 / #37–#38，2026-08-20）**
> 更新（2026-08-20）：池化执行槽派发已退役（#38）。任务工作只有一条入口——
> 任务 1:1 绑定的隐藏 chat 会话；`src/commander-router.js` 与弹性 worker 机器
> 已删除，TaskRun 台账只剩读侧（遗留卡投影 / answers / cancel / 有界重试）。
> 下文「§0 背景」描述的是被取代的旧模型，保留作为设计依据的现状快照。
>
> 原状态：**已拍板（2026-08-18），进入实施**
> 作者：架构师会话（multicc-codex-chat-04）
> 依据：三份现状探查（task-run 台账 / spawn·resume 链路 / 前端·WS），文中所有 file:line 均已核对。
>
> **传输层决策记录**：初版设计是「台账重建 jsonl + CLI `--resume` 续原生多轮」。用户质疑后重新评估，**拍板 B 方案：手动拼装上下文 + chat view，不搞 resume**。理由：① 零 schema 依赖（resume 绑死 CLI 原生 jsonl 格式，升级即漂移风险）；② claude/codex 统一路径，无分期割裂；③ 短平快任务（任务板主力场景）两者等效。被接受的代价：长链条任务的保真度依赖编译器回放质量 → 因此**编译器 v2 纳入阶段 2** 作为配套；prompt cache 命中受 5min TTL 限制（前缀稳定化尽量挽回）。resume 作为传输层的记录在 §10 保留备查，不实施。

## 0. 背景与问题

任务板当前执行模型：每个任务回合（run）在一个隐藏执行槽（`taskExecutionSlot`）上跑一个 CLI 回合，**每轮把任务历史编译成一段上下文文本、伪装成一条 user 消息投递**；槽位历史即用即弃，canonical 记录是 task-run 台账（sqlite）。

生产实测（omnigent 对比任务、AI Loop 接续任务）暴露四个系统性问题：

| # | 问题 | 根因 |
|---|---|---|
| P0-1 | 包装器污染：详情页每条追问显示两遍（原文 + 脚手架墙），且下一轮把它当「用户发言」回放 | wrapper 作为普通 user 消息落台账（turn-engine.js:953-970 → recordMessage），与 `kind:'admission'` 原文并存；handleMessages 不按 kind 过滤（task-board.js:1264-1296） |
| P0-2 | 失败静默：worker 实际干活 4 分钟，classify 判 `classifier_api_error + result_not_durable` → partial output 整个丢弃；台账只有 admission、0 token；卡片仍显示 active；无重试 | 失败 run 不写任何 message（只有 0-token usage 兜底事件，task-run-host.js:436-455）；卡片状态与 run 失败无联动 |
| P1-1 | 幻影卡：classify 的 onClassifyGoal 从 worker 回合自推 goal 另建 `tsk_` 空壳卡，不归并到回合已 stamp 的 `tsk-` 真卡 | classify 归因不优先使用 turn 上 stamp 的 taskId；执行槽回合允许新建卡 |
| P2 | 成本/延迟：每条追问全量上下文重放（~40k fresh input、cacheRead 0、85-100s） | 编译文本前缀不稳定（任务状态/历史条数每轮变），prompt cache 永不命中 |

## 1. 目标与非目标

### 目标（用户原话锚定）

1. **每一个任务就是一个虚拟会话**：详情展示与对话会话一致——消息原文、tool use 卡片、token usage 条、运行中流式渲染。
2. **任务完成后只删 jsonl 和执行环境**，消息原文 / tool use / token usage 持久保留。
3. **下次对话带上保存的上下文**——【仅当前任务 + 各层级共享上下文】。

### 非目标

- 不改变调度/租约/幂等语义（leaseEpoch、outbox、slot CAS 全部不动）。
- 不改变 Commander 路由拓扑（板 → Commander → 槽位的单向路由不变）。
- **不搞 jsonl 重建 / CLI resume**（已否决，见文首决策记录）。
- 不做跨任务上下文共享（虚拟会话边界 = 任务边界 + 各层共享上下文）。

## 2. 核心设计：台账 = 唯一事实源，编译器 = 传输层，chat view = 展示层

```
┌─ 任务虚拟会话（task-run 台账，sqlite，永久）────────────────┐
│  admission（用户原文，kind='admission'）                    │
│  assistant 消息（content + tools + usage + cost + partial） │
│  error 条目（kind='error'，失败原因 + 中断草稿）             │
│  usage 事件（task_run_usage_events，已有）                   │
└───────┬──────────────────────────────┬─────────────────────┘
        │ 每轮 run 开始                 │ 详情页打开 / 流式
        ▼ 编译（传输层）                 ▼ 渲染（展示层）
  编译器 v2 产出上下文消息          chat view（与对话会话同款）
  （作为 user 消息投递给槽位，      消息气泡 + tool 卡片 +
   标 wrapper=true：              token 条 + run 分隔 +
   不落展示、不进下轮编译输入）    error 卡 + 流式增量
        │
        ▼ 回合结束（terminal）
  现有槽位回收（不变）：删 jsonl + chat history + 清 cliSessionId
  ——消息/tool/usage 已在台账，投影销毁无损失
```

三层各自只读写台账，互不知晓对方格式：

- **传输层（编译器 v2，§4.3）**：台账 → 模型输入。每轮手动拼装（B 方案），产出消息标 `wrapper=true` 后投递。
- **展示层（chat view，§5）**：台账 → 前端。服务端 DTO 透出结构化字段，Web/App 复用聊天渲染组件。
- **事实源（台账，§3.1）**：recordMessage 扩展落全字段；这是本设计唯一的数据模型变更。

## 3. 数据模型变更

### 3.1 台账消息升级（零迁移方案）

`task_run_messages` 已有 `content_json` + `metadata_json` 两个自由 JSON 列（task-run-store.js:171-182），**不需要 schema 迁移**。

`recordMessage`（task-run-host.js:303-314）扩展：assistant 消息把以下字段白名单式存入 `metadata_json`：

| 字段 | 来源 | 说明 |
|---|---|---|
| `tools` | turn-engine 终稿 `cs.currentToolCalls`（turn-engine.js:392-397） | `[{id,name,input,result,is_error,startedAt,endedAt}]`；单个 result 超 20k 字符截断并置 `truncated:true`。chat view 和编译器 v2 的 tool 摘要都消费它 |
| `usage` | 终稿 `usage` | `{input,output,cacheRead,cacheCreation}` + roleBreakdown |
| `cost` | 终稿 `cost` | 原样 |
| `durationMs` / `turnTimings` | 终稿 | 计时行渲染 |
| `partial` | close 时 partial checkpoint（turn-engine.js:1727 路径已会进台账，现状丢标志） | 布尔，「中断草稿」角标 |
| `wrapper` | 投递侧标记（§4.1） | 布尔，编译产出消息的身份证 |

新增 kind 取值（kind 列无 CHECK 约束，自由串）：`'error'`（失败条目）。现有 `'admission'`/`'legacy_import'`/`'message'` 不变。

**幂等与唯一性不变**：`UNIQUE(run_id, message_id)` + `stableMessageId` 不变；metadata 扩容不影响去重。

### 3.2 DTO 变更

- `publicMessageDto`（task-runs.js:61-70）：增加白名单字段 `tools/usage/cost/durationMs/partial/wrapper`（从 metadata 透出，剥掉 leaseEpoch/deliveryId 等内部字段）。
- `GET /api/task-board/tasks/:id/messages`（task-board.js:1260）：items 增加同名字段 + `kind`；**过滤 wrapper 消息**（§4.1）；`text` 字段保留（向后兼容旧前端）。
- run DTO 增加 `error`（失败原因摘要）供卡片渲染。

### 3.3 失败语义（治 P0-2）

run terminal 为 failed 时（finalizeTerminal / rejectTaskRun 路径）：

1. 台账写一条 `kind:'error'` 消息：`role:'system'`，content = 人类可读失败原因（如「上游分类器错误，结果未持久化」），metadata 带 `{code, retryable}`。
2. worker 已产出的 partial output 补 `partial:true` 标志，详情页显示为「中断草稿」。
3. run DTO `executionStatus:'failed'` + error 摘要 → 任务卡片显示失败徽标 + 原因（status-presentation 注册表加映射）。
4. **有界自动重试**：`retryable` 的失败（classifier_api_error 等瞬时类）自动重投 1 次（新 run、新 leaseEpoch，台账完整保留两次尝试）；非 retryable 或重试再败 → 保持 failed，等用户追问。重试上限硬编码 1，不做可配置（避免无意识放大成本）。

### 3.4 classify 归因（治 P1-1）

- 归因优先级：turn 上 stamp 的 `taskId`（`_currentTaskId`）> 现有 goal 推断。**执行槽（taskExecutionSlot）回合 classify 一律不得新建任务卡**——只许归到 stamp 的 taskId 或放弃。
- onClassifyGoal 归并：goal 推断命中已有同 dir 任务（已 stamp 卡）时更新该卡，不新建。

## 4. 执行路径变更

### 4.1 包装器身份证（治 P0-1）

B 方案下编译上下文消息**仍是传输层**（投递给槽位的 user 消息），但它获得明确身份，从此在展示与回放中隐身：

1. **落台账即标记**：执行槽 turn 持久化的 user 消息，凡内容属编译产出（携带任务运行上下文），recordMessage 时写 `metadata.wrapper=true`。判据复用现有 `isSystemInjected` 同款思路，但以结构标志为准而非前缀。
2. **展示过滤**：handleMessages 跳过 `wrapper===true` 的消息 + 遗留前缀匹配（内容以 `【Commander 单向路由任务】` 或 `[MultiCC 任务运行上下文` 开头的旧 user 消息；一次性清洗判断，不改旧数据）。
3. **编译输入过滤**：`storedTaskMessages`（编译器的历史来源）同样排除 wrapper——下一轮的历史段只由 admission 原文 + assistant 消息组成。
4. 效果：详情页每条追问只见一次用户原文；模型看到的下一轮历史里没有上一轮的脚手架。

### 4.2 上下文边界（用户要求的「仅当前任务 + 各层级共享上下文」）

编译内容的边界不变，只是组装方式升级（§4.3）：

1. **任务级**：任务标题 / goal / 领域 / 摘要 / 本任务历史 run 的台账消息。
2. **目录级**：目录共享上下文（`_shared` 记忆摘要、目录约定）。
3. **项目级**：全局共享上下文（如有）。

脱敏约束继续适用（task-run-context.js:36-98 redactText/forbiddenSessionKeyName）：**台账和编译文本里绝不携带 cliSessionId/nativeSessionId/凭证**。

### 4.3 编译器 v2（阶段 2 交付，治 P2 + 长任务保真度）

在 `src/task-run-context.js` 的 `buildTaskRunContext` 上出 `version:2`（version 参数已存在，v1 保留可回滚）：

1. **结构化历史回放**（取代 v1 的 `- 用户/助手：text` 平铺）：
   - 每轮一个区块：`【第 N 轮】用户：<admission 原文>` + `助手：<assistant 文本>`。
   - **tool 摘要行**：从 metadata.tools 生成 `助手调用工具：Read(x.js)、Bash(npm test) → 结果要点（≤80 字/个）`；恢复模型对自己工具史的第一人称认知（v1 完全丢失）。
2. **段落固定顺序 + 前缀稳定**（治 P2 的 cache 问题）：
   - 段落顺序固定：任务段 → 共享上下文段 → 历史回放段（从旧到新追加）→ 产物段 → 当前要求段。
   - 易变内容（任务状态、时间戳、条数统计）只允许出现在「当前要求段」之前的最末位置；历史追加只增长不改写已有字节 → 5 分钟缓存窗口内的连续追问命中 prompt cache（fresh input 降为增量）。
3. **预算策略**：历史段预算从 12000 提高到 24000 字符；溢出时保留第 1 轮（任务起源）+ 最近 N 轮，中间省略标注 `（省略 M 轮，详见任务台账）`。
4. **manifest v2**：`schema:'multicc.task-run-context', version:2`，记录 included/omitted/toolSummaryCount/prefixHash，继续落 run metadata 供可观测。

### 4.4 任务维度流式转发（详情页实时渲染）

现状：slot 回合事件只发 slot 自己的 WS 客户端（恒为空，task-context-host.js:118-125）。

变更：`taskContextHost.broadcast`（或 server.js chatBroadcast:2393-2401）增加转发 hook——会话是执行槽且有活动 taskRun 时，把 payload 包装为 `{type:'task_run_stream', taskId, runId, slotEvent:<原 payload>}` 经 workspace broadcast（runtime.js:83-101）发到 dir 订阅者 + metaClients。

- 流量控制：text_delta 级事件 ~100ms 节流合并；usage/result/tool 事件不节流。
- 安全：不新增敏感面（slot 本就把同样内容发给「它自己的客户端」，只是恒为空）；只到本 dir 订阅者，与现有 task_board_update 同权限面。
- 前端无订阅时零成本。

## 5. 前端变更

### 5.1 Web 任务详情（manage-taskboard.js / manage.html）

渲染面零新组件：复用 `MultiCCChatHistoryView`（chat-history-view.js:397-438 renderAssistant/renderUser/hydrateTool/buildUsageLine/renderToolTrajectory）。

- `.tb-msgs` 容器改为 history-view 实例宿主；items 新字段映射为聊天消息 DTO `{role, content, tools, usage, ts, durationMs, id}`。
- run 边界渲染为分隔条（「第 N 次执行 · 状态 · 时间 · token 合计」），复用 renderTaskRunSummary 精简版。
- `kind:'error'` → 错误卡片（红边 + 原因 + 重试状态）；`partial:true` → 「中断草稿」角标。
- 流式：manage 页订阅 `/ws/meta`，收 `task_run_stream` 且 taskId 匹配当前详情时，slotEvent 喂 history-view 流式入口（createAssistantBubble/updateToolInput/addToolResult）。
- 旧任务降级：无 tools/usage 的 items 按现有纯文本行渲染（渲染器对空 tools 本就跳过）。

### 5.2 App（Flutter）

- `TaskMessage` 模型（models/task_board.dart:142-174）增加 `tools/usage/durationMs/kind/partial`。
- `_TaskDetailSheet` 消息区改用现成 `MessageBubble`（message_bubble.dart:213）+ `ToolCallGroup`（tool_card.dart:336），TaskMessage → `ChatMessage` 映射。
- 流式：`workspace_service.dart` 已有 dir 级 WS，增加 `task_run_stream` case，详情打开且 taskId 匹配时转发进消息列表状态。
- 失败徽标走 status-presentation 注册表，服务端 run error 进 task DTO 后自然显示。

## 6. 不变量（全设计必须守住）

1. **台账唯一事实源**：展示、编译、usage 结算都只读台账；slot chat-history 与原生 jsonl 是一次性投影，terminal 即弃。
2. **wrapper 身份证**：编译产出消息必带 `wrapper=true`；展示与编译输入必过滤（结构标志 + 遗留前缀，双层）。
3. **编译确定性**：同一份台账 + 同一 currentText → v2 编译产出字节一致（prefixHash 可校验）；易变状态不得进入前缀段落。
4. **调度语义不动**：leaseEpoch / slot CAS / outbox 幂等 / quarantine 一行不改。
5. **脱敏**：台账与编译文本不出现 cliSessionId/nativeSessionId/凭证。
6. **usage 不漏账**：失败 run 的 partial output 落台账 + unobservable 兜底沿用；重试 run 独立 leaseEpoch 独立结算。
7. **向后兼容**：API 只加字段不删字段（`text` 保留）；旧前端/旧任务数据降级可用。

## 7. 失败模式与对策

| 失败模式 | 影响 | 对策 |
|---|---|---|
| v2 tool 摘要失真（要点截断丢失关键信息） | 模型对历史 tool 结果认知偏差 | 摘要只标注「调用过+要点」，并注明「完整结果在台账」；长任务关键结果由 assistant 文本自然承载 |
| 前缀稳定被破坏（某段混入易变内容） | cache 退回不命中（回到现状，无回退损失） | 编译确定性不变量 + prefixHash 监控；golden 测试锁段落顺序 |
| 超长任务（几十轮）历史段超预算 | 中间轮被省略 | 保留第 1 轮 + 最近 N 轮 + 省略标注；预算 24000 已覆盖绝大多数场景 |
| 流式转发风暴（大 dir 多任务并跑） | metaClients 流量放大 | delta 100ms 节流；只有打开详情的 taskId 被前端消费 |
| 重试放大成本 | 失败任务烧钱 | 硬上限 1 次，仅 retryable 错误码；失败原因写卡片让用户决策 |
| 台账 assistant 缺 tools（旧数据/异常） | chat view 无卡片、v2 无摘要 | 双双降级：渲染跳过空 tools，编译跳过摘要行，不影响主流程 |

## 8. 分阶段计划与验收标准

### 阶段 1 · 止血（独立可合）

改动：
- §4.1 wrapper 身份证：投递落台账标 `wrapper=true`；handleMessages + storedTaskMessages 过滤（标志 + 遗留前缀）。
- §3.3 失败语义：`kind:'error'` 台账条目 + recordMessage 补 `partial` 标志 + run DTO error 摘要 + 卡片失败徽标 + 有界重试 1 次。
- §3.4 classify：归因优先 stamp taskId；执行槽禁新建卡；goal 归并。

验收：
- 隔离测试：详情 items 无 wrapper 文本，admission 原文仅一次；编译输入不含上一轮 wrapper。
- 隔离测试：fake worker 失败 → 台账 error 条目 + partial 草稿，run DTO failed，重试产生且仅 1 次。
- 隔离测试：slot 回合 classify 不产生 `tsk_` 新卡。
- 全量回归绿（含 request-locality / api-contracts / line-budget 三守卫）。

### 阶段 2 · 数据面 + 编译器 v2

改动：
- §3.1 recordMessage 落 tools/usage/cost/durationMs；§3.2 DTO 透出。
- §4.3 buildTaskRunContext version:2 + golden 测试；执行链路切换 v2（v1 保留回滚开关）。

验收：
- 台账 assistant 消息含完整 tools/usage；`/api/task-runs/:runId` 与 `/messages` 透出。
- v2 golden：多轮含 tool 的台账 → 编译文本含结构化回放 + tool 摘要；同输入两次编译字节一致；易变状态只在末段。
- 生产口径（手动验证）：5 分钟内连续追问，第二次 fresh input 显著下降、cacheRead > 0。

### 阶段 3 · 前端 chat view

改动：§5.1（Web）+ §5.2（App）+ §4.4 流式转发。

验收：
- Web 详情页：tool 卡片、usage 行、run 分隔条、error 卡片、partial 角标全部渲染；旧任务纯文本降级不报错。
- 流式：run 进行中打开详情可见增量文本与 tool 卡片实时更新（fake CLI 慢速输出验证）。
- App 同构渲染 + workspace WS 流式。
- 旧版 App/Web 打新服务端不崩（字段兼容测试）。

## 9. 风险登记（实现期持续关注）

1. **双写一致性**：recordMessage 扩展字段在 chat-history 与台账两处写——台账写在先（task-context-host.js:97-116 顺序已是如此），台账失败会阻断 chat-history 写入；保持现状（台账是事实源，失败应阻断）。
2. **server.js line-budget**：wiring 新增行受 3000 行棘轮约束，新逻辑一律进模块，server.js 只加 wiring 行。
3. **静态治理三守卫**：request-locality / api-contracts / line-budget 涉及新增 API 字段与模块时同步更新。
4. **v2 质量主观性**：tool 摘要与回放格式的效果需生产实测校准，预留格式微调空间（manifest version 再升即可，传输层与展示层解耦保证了这一点）。

## 10. 决策摘要

| 决策 | 选择 | 备选（否决理由） |
|---|---|---|
| 台账扩容方式 | metadata_json 白名单字段（零迁移） | ALTER TABLE 加列（无查询需求，徒增迁移面） |
| **模型输入传输层** | **手动拼装（编译器 v2）** | jsonl 重建 + resume（用户否决：schema 漂移风险、codex 割裂、短任务无收益；记录备查不实施） |
| 编译器 | v2 纳入阶段 2（tool 摘要 + 前缀稳定 + 预算提升） | 继续用 v1（tool 史丢失、cache 永不命中，P2 不解决） |
| 失败重试 | 自动 1 次（retryable 限定） | 无限重试（成本失控）；不重试（瞬时错误体验差） |
| 流式 | workspace/meta 转发 slot 事件 | 详情页轮询（延迟差）；slot 直订（破坏 slot 隐藏边界） |
| 展示层 | 复用聊天渲染组件（Web history-view / App MessageBubble） | 新写任务专用渲染（重复造轮子，样式漂移） |
