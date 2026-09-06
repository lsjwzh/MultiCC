# 多会话壳与任务上下文分支：实验设计及副作用评估

日期：2026-09-06。审阅基线：`2b7ac89b`。状态：设计评审稿；实验和业务改造尚未执行。

本文承接后续讨论，作为新实验的主方案。[上一版上下文隔离方案](task-context-isolation-design.md) 保留为历史参考；其「完成后追问必建新 epoch」规则由本文的「先冻结、验证后可恢复」替代。两份文档不能作为互相独立的实施清单累加。

## 1. 要验证的方案

前台会话是输入、时间线、通知与任务导航入口；任务拥有工作目标、正式历史、决定、产物和执行状态；CLI 会话是可替换的执行载体。会话壳与任务多对多，任务树只组织工作，不拥有一份混合的模型上下文。

```text
壳 A ── 关联 ── 任务 T1：实现功能 ── T1 的正式历史 / 上下文分支
壳 B ── 关联 ────────┘                         │
  └──── 关联 ── 任务 T2：补充测试 ── T2 的正式历史 / 上下文分支
                      │                       │
         主任务 T0 的两个子任务        每个任务自己的隐藏执行会话
                                              │
                                    现有队列 → CLI / 工具 / 工作区
```

四个实验假设：

1. 跨任务私有上下文不会自动混入；同任务连续追问和跨壳续作不必重新调查背景。
2. 多个入口汇合到同一个任务队列，仍只有一个活动执行者，消息、问题结算和费用不会重复。
3. 冻结任务分支与按需检索能减少无关输入，同时保住可复用的任务内前缀；实际收益通过对照实验验证。
4. 复用隐藏会话、队列、聊天渲染和生命周期基础设施，可以分阶段实现，不需要先建设新的 Agent 执行引擎。

首版实验限定在同一宿主、同一项目目录、用户主动启用的普通 Web chat 壳；先用明确任务选择验证多壳共享，再启用自动归集。既有任务入口也必须汇合到相同绑定。外部 Fleet、公开分享、Terminal、语音/IM gateway、cron 自动建树、自有工具执行循环和跨项目任务合并不纳入首批执行实验。对这些入口保留既有语义；若不能保证不绕过新任务绑定，则拒绝向实验任务投递并返回明确原因。

本轮只产出设计、代码落点和实验清单，没有开启功能开关、修改历史/数据库、调用真实模型测试、执行 GC 或重启服务。

## 2. 已有基础与实际缺口

| 当前代码 | 已有能力 | 实验需要补的部分 |
| --- | --- | --- |
| `src/routes/task-board.js:ensureBoundChatSessionUnlocked()` | task.chatSessionId ↔ record.taskBoundTaskId，创建与反向绑定修复 | 多壳关联、持久化唯一绑定；实验任务禁止 adoptOrigin 将含多任务历史的普通会话直接当任务执行者 |
| `src/session-work-scheduler.js` | 以 sessionId 为队列键，持久化 FIFO、控制消息、重试与恢复 | 同一 taskId 的所有入口解析为同一隐藏 sessionId；源壳不再同时启动执行 |
| `src/classify/task-attribution.js`、`src/task-context-host.js` | provisional taskId、same/new、relatedTaskId | 执行前可等待的身份判定、严格校验、路由凭据和可纠正归属 |
| `src/task-board.js:groupRelatedTasks()` | taskGroups 只改展示分组，保留各任务原 ID / refs | 主题关系与 parent/depends_on 分开建模，避免将组的 rootTaskId 误当真实父任务 |
| `src/classify/user-input-host.js` | pendingUserInput 按执行 session 保存，含 taskId；同 session 可广播 resolved | 跨壳问题投影、持久化回答抢占、不同答案冲突、epoch 校验 |
| `src/routes/task-board.js`、`src/task-run-store.js` | 旧 run 路径已有 reserveAnswerReceipt / markAnswerAccepted | 借用结算语义，覆盖不带 taskRunId 的新隐藏会话，不能伪造 run 来获得去重 |
| `src/session/chat-history-service.js`、`src/task-transcript-repository.js` | 聊天与旧任务台账两类正式历史读取 | 实验消息统一原文源、壳和任务引用投影、来源 ID、完整工具证据 |
| `public/chat-task-mode.js` | 任务页优先解析隐藏会话，复用普通聊天 UI；另有旧台账投影 | 新壳不重定向成执行会话身份；多任务消息按 taskId/runId 分别渲染 |
| `src/routes/session-lifecycle.js` | 删除会话会级联停止、清理；隐藏任务会话有独立删除限制 | 删除壳只拆关联，任务及其他壳的工作继续；reset/stop/模型设置明确指向任务 |
| `src/session-delivery.js`、router/dispatch | 多种续接仍以 sessionId 为目标 | 区分 sourceShellId 与 executionSessionId，保留 task/epoch/request 的来源身份 |
| `src/token-global.js` | 原生历史仍承担部分用量事实读取、请求级去重 | 在删除原生文件前封存必要用量；多个壳显示同一费用不多计一次 |

现有模型协议转换器 `src/model-history-converter.js` 继续处理请求字段与工具关联兼容，不承担任务选择。现有 taskGroups、隐藏会话和单 session 问题广播，都不能直接证明已经支持本方案的多壳共享。

## 3. 领域对象、关系和权威来源

### 3.1 对象与所有权

| 对象 | 建议字段 | 权威内容 |
| --- | --- | --- |
| Shell | shellId、dirId、focusedTaskId、focusRevision | 交互入口、默认关注任务；每个客户端窗口另存 view cursor，后台输出不自动改变 focus |
| ShellTaskLink | shellId、taskId、visibility、linkedAt、cursor | 哪个壳关联/关注哪个任务；不是任务所有权或访问凭证 |
| Task | canonical taskId、goal、status、revision | 任务身份与工作目标；已有任务记录继续是来源，新增表不复制一份可编辑 task |
| TaskRelation | fromTaskId、toTaskId、type、revision、source | 父子、依赖、主题关联；独立于身份 alias |
| Message / RouteReceipt | messageId、originShellId、ingressSeq、contentRef、taskId、routeRevision | 原文一份、路由决策一份；展示和执行是投影 |
| ContextEpoch | epochId、taskId、policyRevision、snapshotRef、state | 一段可恢复的任务上下文；不绑定来源壳 |
| RuntimeBinding | taskId、executionSessionId、bindingRevision | 一个任务当前唯一执行载体；两个壳不产生两份绑定 |
| Execution / Question | turnId、attemptId、taskId、epochId、questionId | 本次执行、费用与等待的精确归属；taskRunId 存在时继续沿用 |

taskId ≠ shellId ≠ executionSessionId ≠ epochId。任务可有多个历史执行实例，同一时刻最多一个活动上下文写者。Native thread/session ID 仅是宿主字段，不能拿它作为用户权限或任务身份。

### 3.2 关系类型

- `same task`：消息路由到现有 canonical taskId，不创建新节点；相似标题不是自动合并依据。
- `child_of`：新的独立交付物属于某父任务。首版每个节点最多一个父节点，禁止自指和环；事务内验证，防并发写入形成环。
- `depends_on`：一个任务需要另一任务的结果。约定消费者 → 提供者，独立 DAG；首版仅展示和检索，不自动触发执行或父任务完成。
- `related_to`：主题相近，可由 taskGroups 提供候选。允许多对多，不携带全文注入权限。
- `alias / merged`：沿用既有 canonical 解析；身份合并是独立显式操作。运行中任务不得通过归集自动合并、迁移队列或拼接原生历史。

一个子任务结束只更新子任务；父任务业务状态仍由既有 classify/明确完成流程判定。上下文只提取相关上级决定与引用结果，不沿祖先、兄弟、依赖递归注入整棵树。依赖结果记录版本，更新后将引用标为待检查，不静默改写已经注入的快照。

## 4. 任务关系判定与消息准入

### 4.1 路由优先级

1. 控制消息优先：问题回答、重试、取消和后台回调通过 questionId/turnId/epoch 确定目标，不交给语义归集。
2. 明确任务 chip、任务卡、#任务引用或回复某条消息，优先解析稳定 taskId，并校验来源与访问范围。
3. 普通文本使用当前 focus、来源壳近期必要上下文、同项目允许参与匹配的任务摘要产生有界候选。
4. 归集器分别输出 identity（same/new/ambiguous）及关系建议（child/related/dependency）；复用现有归集模型，不让它直接写数据库或执行工具。
5. 服务端校验目标存在、项目范围、alias、revision 和结构，才持久化路由。模型置信分数只用于观测，不作为安全闸门。

跨壳自动匹配只搜索显式允许共享的任务集合；私有任务默认不因相似就被另一个壳接入。用户明确关联任务时，UI 显示接下来消息会进入该任务的共享历史。同一项目不是权限证明，壳关联本身也不扩张既有服务端授权。现有宿主级 token 不代表已经具备多用户 ACL；本实验不宣称提供新的多租户隔离。

「继续」「上面的方案」优先定位回复对象和发送时的 focusRevision；不能在归集超时后改成新任务裸发。失败保留消息并给出原始错误码/原因，可有界重试；确实有多个合理目标时显示任务选择。多目标的一条消息首版保留一个原文，仅输出拆分建议，不自动扇出多个执行任务。

### 4.2 从收到到执行

```text
鉴权 + 输入去重
  → 持久化原文及 shell ingressSeq（此时可未归属）
  → 生成路由决策
  → 原子提交 task/link/route intent 或记录待创建任务意图
  → 幂等创建/解析任务隐藏会话，持久化唯一 RuntimeBinding
  → 通过现有 outbox 投递到任务执行会话的队列
  → 出队时再次校验 routeRevision / bindingRevision / epoch / 访问范围
  → 决定 resume 或从正式历史冷启动
  → 执行、正式结果提交、各壳引用投影
```

源壳只处理输入和路由，不调用自己的 CLI 执行同一消息。归集是短任务，不能占用任务执行 FIFO 等待工作结束。UI 区分「已保存 / 待归属 / 已排队 / 执行中 / 完成或失败」，HTTP 成功接收不等于任务已完成。

同一壳顺序依赖的消息按 ingressSeq 提交路由，避免后一条归集更快而抢先执行；尚未解决的前一条只阻挡该壳相关后续消息。不同壳的消息在任务准入时分配 taskQueueSequence，以服务端提交顺序为准，不用客户端时钟排序。问题回答及取消走既有结构化控制通道，可越过等待中的普通消息，保留已有直投语义。

去重键分层：输入用 `(originShellId, clientMsgId)`；目标执行用全局 messageId/routeRevision 对应的稳定 deliveryKey。不同壳碰巧生成相同 clientMsgId 不冲突，不同用户输入相同文本不自动去重；同一输入重试不会创建第二个任务、第二条原文或第二次执行。若已开始执行才发现归属错误，保留已发生事件与副作用，记录纠正及后续路线，不把旧执行偷偷挪到另一任务。

### 4.3 原子性与恢复

消息、路由凭据、link 和任务队列意图需有确定性 ID 和可恢复状态。现有任务卡 JSON、task-runs.sqlite 与 orchestration.sqlite 不在一个事务里：新任务创建使用 messageId 派生的创建键，步骤记录为 prepared → task-created → bound → enqueued；崩溃后查询同键实体再补齐，不将“HTTP 超时”当“尚未创建”。

binding 通过持久化 compare-and-swap 保证唯一，现有内存 holdTaskOperation 不作为全部恢复证明。重绑前暂停新投递，停止并排空旧执行，确认旧队列和控制消息归属；无法证明排空就保留隔离状态。禁止两个队列一边接收一边切换绑定。

## 5. 多壳共享时的执行和交互

### 5.1 队列与调度

实验首版采用 `taskId → 唯一 executionSessionId → 现有 session FIFO`，通过入口汇聚取得任务级串行语义，先不全局改队列主键。隐藏执行会话仍使用现有 classify、liveness、取消、错误恢复、outbox 租约和工作区能力。壳、任务卡、旧直接 API、MCP 等任何能够访问实验执行会话的入口，都必须验证 taskId/binding，不能绕过入口创建第二次执行。

实验阶段每个项目的实际执行并发先限制为 1，路由和查看不受该执行名额限制；不同任务各有队列，已完成/等待且生产者排空的任务释放执行名额，避免头部等待阻塞整个项目。执行名额检查需在短时临界区完成，不能持有一项锁等待另一项锁；问题回答的可靠接收/结算和取消控制不被普通队列阻挡，需要重新启动原生执行时仍遵守项目并发上限。扩展跨任务并行需另验证工作区、端口和共享文件冲突。

用户 B 在 A 执行时输入补充，默认进入同任务队列；只有已有明确支持的控制/补充通道才允许执行中注入。首版不因多壳而新增任意热注入。B 点停止会影响共享任务的执行，按钮必须标出目标任务；移除自己未执行的排队消息与停止整个任务是不同操作，均按既有权限检查。

### 5.2 等待回答与迟到结果

问题使用 `(taskId, epochId, questionId)` 身份，关联具体 origin turn。多个壳显示同一问题的不同视图；回答通过持久化 receipt 抢占 pending → reserved → accepted。原文可靠保存、目标投递持久接收后才结算成功；崩溃后用同键重试完成。相同提交重试返回已有结果，不同答案在同一问题已被占用时返回冲突，不能被悄悄追加成另一条回答。

accepted 后向所有有权限且已关联该任务的壳发送 resolved 事件；重连从权威问题状态重建。壳切换 focus 不会自动取消任务的问题。用户在任务上明确用新要求替代问题时，记录 superseded 并同步所有入口，不能因另一个壳的无关输入触发 `beginTurn()` 清空它。

后台 callback、dispatch.result、retry 绑定 task/epoch/turn/run，禁止恢复到来源壳当前 focus。目标正在执行时排队；已封存 epoch 的迟到结果保存为原任务证据，由恢复规则决定是否开新 epoch，不能自行唤醒已退出的 native generation。

### 5.3 展示、费用、配置与删除

- 默认壳时间线保留该壳提交的消息和对应回答；任务详情展示完整共享任务历史。其他壳的活动通过任务状态/未读提示和任务详情查看，避免静默把别人的对话全插入当前时间线。事件带 taskId、turnId、messageId，不能靠“当前最后一个气泡”拼接。
- 任务消息和工具输出只有一个权威实体，壳只存引用及显示状态；一个输出可被多个视图渲染，不触发新的执行、摘要或计费。公开分享/导出先固定授权快照，不沿新的 link 自动扩展可见内容；首版实验壳可暂不开放分享。
- 用量按 provider request/attempt 及 task/turn 记一次，保留现有去重口径。来源壳可显示“本壳发起的费用”，共享任务累计另标口径；两种视图不能相加成项目总额。归集/摘要费用也计入实验总成本。
- 任务模型、Provider、角色与工具能力属于任务执行配置，并在 turn 开始冻结。另一壳的默认设置只影响它创建的新任务，不覆盖已有任务；更改共享任务配置走显式任务设置，在安全边界生效。
- 删除壳仅解除关联、停止壳自身的路由工作和移除其显示投影；正在运行的共享任务、原文、工作区、其他壳的等待都保留。最后一个壳解绑也不等于删除任务，任务可从看板继续打开。
- `MULTICC_SESSION_ID`、MCP 所有权、Git merge/worktree 操作仍对应隐藏执行会话，originShellId 仅是投递元数据，不能伪装成工具授权身份。新实验任务禁用旧 adoptOrigin 捷径，保证执行历史未混入其他任务。

## 6. 上下文分支、冻结和恢复

上下文按任务组织，来源壳变化不改变任务快照。默认注入当前需求、任务有效决定、必要项目/用户规则、有界同任务历史，以及明确引用的证据；工具结果按完整配对保留在正式存档，按需读取大结果。taskGroups、树关系和相似检索只产生候选，不能自动读取整棵树。

壳私有经验不因关联任务自动加入共享上下文；必要用户规则优先采用明确的项目/用户作用域。私有内容若已进入共享任务模型并影响输出，就不能靠后续取消显示撤回，因此筛选必须在投递前完成。此处是注入范围控制，不能替代对 Agent 文件工具的权限隔离。

保留稳定公共规则与工具定义，任务初始 snapshot 固定字节；新消息、检索证据和约束追加到后面。审计 ID、时间戳、计数与频繁变化的任务列表不进入公共前缀。CLI 自动读取规则/记忆仍须逐个审计，无法观测的入口标部分覆盖；缓存键及实际命中按 Provider 测量，保留原生 ID 本身不是命中保证。

| 事件 | epoch / native 处理 |
| --- | --- |
| 同任务多轮或换壳续作 | 复用同 epoch、同任务历史；native 恢复验证通过时 resume |
| classify 判定业务完成 D | 结果提交且生产者排空后进入 frozen，允许释放 CLI 进程，保留可恢复分支 |
| frozen 任务再次追问 | 检查 native 所有权、schema、配置指纹、历史覆盖、文件/代码基线；通过则激活原 epoch；不通过则从正式存档建新 epoch |
| 新任务 / 同树兄弟任务 | 独立 epoch，绝不 resume 原任务 native |
| W/B 等待、工具或子进程仍有工作 | 保留归属和 pin，不因 turn 结束或静默超时冻结/删除 |
| CLI 不支持恢复、文件损坏、显式重置、上下文过长 | 建立新 snapshot/epoch；旧分支封存，必要字段来源可追溯 |
| 任务合并、角色能力不兼容、关键规则变化 | 安全边界重新核验，必要时重建；不拼原生文件或重用不兼容线程 |

资源状态为 active / suspended / frozen / sealing / sealed，区别于业务完成状态，也区别于现有 scheduler frozen（队列冻结）。命名和 DTO 必须明确，不能用同一个 `frozen` 字段表示两者。sealed 原生上下文不可直接继续；frozen 在恢复验证通过时可以。冻结期间无原生写者是安全回收的前提之一。

恢复旧任务时检查代码基线和未提交改动。文件已改变应追加变化证据并重查关键结论，不能为恢复缓存回退工作区。旧测试结果保持历史属性，不代表当前 HEAD 验证通过。

物理归档按闲置保留策略与资源预算单独触发；sealed 文件建议先保留 30 天、按 archivedAt 计时，这只是待实验评估的默认值。GC 必须同时满足原文/工具/附件/用量 coverage、无运行或等待 pin、所有权清晰、revision 未变。首版实验关闭物理 GC；也必须阻止旧 Codex TTL 扫描器绕过新 pin 删除实验文件。Claude `.pruned.jsonl` 的用量处理、OpenCode 数据库型原生状态分别由适配器处理，不采用通用扩展名删除。

## 7. 数据落点和模块结构

实验新消息采用一个 canonical message journal；未归属前为 inbox 原文，归属后通过 RouteReceipt 成为任务消息。助手最终/partial 消息、工具证据也写入这个来源。现有 chat-history 作为展示/恢复投影或旧数据来源，实验路径不得再把它当第二个独立可编辑事实源。增量流可暂存在内存，final/partial 提交后以权威 revision 校准投影。

建议复用 `task-runs.sqlite` 增加实验命名空间，由现有初始化入口统一迁移，独立模块管理 SQL：

- messages 与 message_routes：原文/内容引用、来源、归属修订和路由意图；非 taskRun 消息无需伪造 run。
- shell_task_links 与 shell_message_refs：关联、展示引用、投影 cursor；shell focus 是 UI 默认，不是全局任务指针。
- task_relations 与 task_runtime_bindings：关系及唯一执行载体；task 卡本身继续由既有 Task Board 管理。
- question_receipts：不依赖来源壳的原子问题结算。
- context_epochs / context_snapshots / context_native_manifests：沿用上一版的上下文恢复结构。

这些是建议逻辑表，实施可合并低频 metadata，但唯一约束、归属和恢复语义必须保留。当前数据库通过 `task_run_meta.schema_version` 管版本；扩展统一注册迁移，不能让多个模块各自升级/覆盖版本。SQLite 与现有任务 JSON、orchestration outbox 之间用持久 intent + 幂等消费完成恢复，不假定跨库事务。大工具结果和 snapshot 字节进入正式数据目录的内容寻址文件，纳入 `src/paths.js`、备份和引用保护，不能放在 7 天过期的临时 artifacts。

```text
src/task-shell/                    # 新增实验入口层
  runtime.js                      # 接收、路由、绑定、任务执行入口汇聚
  routing.js                      # 归集候选、关系结果校验、纠正
  store.js                        # message/route/link/relation/binding/answer SQL
  projection.js                   # 任务消息 → 壳时间线、状态、等待和用量引用
src/context/                       # 与上一版合并实施
  repository.js                   # 新事实源 + 旧历史只读桥接
  snapshot.js                     # 片段选择、预算、稳定编译、注入清单
  lifecycle.js                    # native 校验、冻结、恢复、封存/GC
src/routes/task-shell.js            # 实验 link/focus/route/status API
public/chat-shell-transport.js      # 复用聊天渲染的新传输适配
```

sourceShell 路由必须在现有主模型启动路径之前截获；已绑定任务的执行入口跳过自动重新归集，执行前只校验身份。现有 taskContextHost/messageComposer 继续做 metadata 和 prompt 接线，server.js 只组合宿主，遵守行数限制。新增模块数量和 SQL 拆分在实现时依职责调整，避免一份 runtime 包揽所有功能。

## 8. API、事件与兼容边界

建议实验接口如下，均为设计，不是现有可调用端点：

| 接口 | 语义 |
| --- | --- |
| `POST /api/sessions/:shellId/task-links` | 显式关联任务；读/写能力由既有鉴权及实验范围校验决定 |
| `DELETE /api/sessions/:shellId/task-links/:taskId` | 解除当前壳关联，不删除任务、不取消执行 |
| `POST /api/sessions/:shellId/messages` | 保存原文；可带 selectedTaskId、replyToMessageId、focusRevision、clientMsgId；返回 messageId、routeState |
| `POST /api/sessions/:shellId/messages/:messageId/route` | 处理歧义或纠正；携带 expectedRevision，已经执行的事件保留历史归属 |
| `GET /api/sessions/:shellId/history` | 沿用现有消息 DTO / 分页语义，实验记录从权威消息和引用投影 |
| 任务 answer / cancel / settings / context 端点 | 以 taskId 和精确 question/turn 身份处理，复用现有宿主服务，不靠 shell 当前 focus 推断 |

事件在复用的 chat DTO 外携带 `taskId, messageId, turnId, eventId, taskSequence, revision`；final/partial/question 事件权威保存，重连按游标读取，旧 revision 不覆盖新状态。流式 delta 按 task/turn 聚合，多个壳只广播视图更新，禁止将这些广播重新包装为 user_message。默认只订阅已关联任务并校验既有权限，task tree 根的可见性不自动授予所有后代权限。

旧客户端不能把多任务流当单一会话流消费。功能协商未声明支持时，新壳以只读提示或明确不支持响应呈现，不能悄悄回到原生壳 CLI 执行；既有普通会话继续原路径。App 在第一轮 Web 闭环通过后接入同一 DTO、answer 与重连契约，不另建状态机。

## 9. 改动与影响范围

| 范围 | 主要代码落点 | 改造强度 |
| --- | --- | --- |
| 壳入口、归集、绑定 | `src/chat/turn-engine.js`、`src/task-context-host.js`、`src/classify/task-attribution.js`、`src/routes/task-board.js`、新增 task-shell | 高：主执行前分流及唯一性 |
| 任务关系 | `src/task-board.js`、`src/task-board-merge-runtime.js`、新增关系 store | 中高：alias/分组/树与 DAG 区分 |
| 队列、重试、异步续接 | `src/session-work-scheduler.js`、`src/session-work-host.js`、`src/session-delivery.js`、`src/router-tool-runtime.js`、`src/router-tool-host.js`、`src/wait-service.js`、dispatch 宿主 | 高：所有入口必须汇聚，控制消息与迟到事件保真 |
| 消息、问题、用量 | `src/session/chat-history-service.js`、`src/routes/chat-history.js`、`src/task-run-host.js`、`src/task-run-store.js`、`src/task-transcript-repository.js`、`src/classify/user-input-host.js`、`src/token-global.js` | 高：一份事实源、问题 receipt、去重计费 |
| 上下文与生命周期 | `src/message-composer.js`、`src/task-run-context.js`、`src/cli-switch.js`、`src/chat/native-session-state.js`、`src/cli-adapters/*`、context/rollout guard、prune/cleanup/recovery | 高：冻结和恢复验真，旧清理器不得旁路 |
| 记忆、工作区和管理 | `src/memory/folder-service.js`、`src/memory/runtime.js`、`src/task-worktree.js`、`src/session-hibernation.js`、`src/routes/session-lifecycle.js` | 高：私有记忆、壳删除、task 级资源归属 |
| Web 与 App | `public/chat-transport.js`、`public/chat-event-controller.js`、`public/chat-task-mode.js`、`public/chat-user-input-card.js`、`public/chat-session-queue.js`、`public/chat-context-controls.js`、`app/lib/services/task_chat_transport.dart`、`app/lib/providers/chat_provider.dart` | 中高：多任务流、问题同步、按钮目标与缓存 |
| 接线与治理 | `src/paths.js`、`src/session-persistence.js`、bootstrap、`server.js`、i18n、API/架构测试 | 中：存储、版本迁移、错误与旧客户端边界 |

相比上一版单会话上下文隔离，多壳方案增加了统一消息来源、关系路由、共享问题结算和 UI 投影。实施规模需重新估计：显式关联的 Web 实验闭环预计新增约 7–9 个模块、触及约 20–30 个既有文件；自动归集、多 CLI、App 及外围入口完整覆盖约 35–50 个既有文件，测试另计。这是范围估算，不是完成天数或已经改动的文件数。

## 10. 副作用、控制措施与残余风险

| 副作用 / 触发条件 | 用户影响 | 控制措施 | 仍然存在的代价 |
| --- | --- | --- | --- |
| 任务误拆：调查→设计→实现被当独立目标 | 反复解释背景、缓存下降 | 交付目标与阶段分开；回复/显式引用优先；保留纠正入口 | 语义判断无法保证全对 |
| 任务误合：两个壳讨论相似主题 | 把私有决定混入共享任务，错误操作 | 跨壳仅匹配允许共享候选；related 不等于 same；执行前记录目标 | 执行后的泄露或文件改动不能靠改标签撤回 |
| 两壳并发给出相反要求 | 后到要求可能覆盖前一轮决定 | 任务序列、来源标记；执行前针对矛盾决定澄清；不把矛盾当普通覆盖 | 同任务串行会增加等待 |
| 回答/取消目标漂移 | 错误回答问题、停止另一任务 | 精确 question/turn 身份与原子 receipt；按钮显示任务 | shared stop 本身会影响其他入口 |
| 路由缓慢、归集服务失败 | 首字变慢，消息停在待归属 | 明确任务免归集；有界候选/重试；真实错误与持久收件状态 | 无法安全判断时需要选择目标 |
| 切回旧任务，代码已变化 | 用过期代码结论继续实施 | Git/文件指纹核验，追加变化证据，不恢复旧工作区覆盖新修改 | 恢复可能重新检索、重测 |
| 只保留摘要导致证据遗漏 | 重复调查，工具结果无法核实 | 正式存档完整工具结果与 blob；摘要有来源、可按需读取 | 增加存储和检索开销 |
| 缓存键/模型/工具 schema 变化 | 保留任务线程也可能缓存不命中 | 固定快照、追加消息、按 Provider 对照费用和延迟 | 缓存过期无法由 MultiCC 控制 |
| 共享任务的角色/Provider 冲突 | 壳设置看似失效或覆盖他人配置 | 任务执行配置明确展示，壳默认只用于新任务 | 用户需要理解当前操作作用于任务 |
| 一条输出被两个壳消费 | 重复通知、费用翻倍、生成反馈循环 | 一份事件、多份引用；不反向注入；按请求计费、按事件去重 | WS/前端投影流量仍增加 |
| 删除/重命名/迁移壳仍绑定旧级联 | 任务执行中断或证据丢失 | 新壳生命周期只管理 link/UI；任务资源单独持有 | 旧管理接口必须逐项审计 |
| 任务树越长、关系循环或错误传播 | 上下文膨胀、调度死锁、父任务假完成 | parent/DAG 事务验证；不递归全量加载；首版依赖不自动调度 | 树本身不能表达全部协作语义 |
| 隐藏会话/worktree/原生文件增多 | 磁盘、进程、端口占用 | 惰性启动、空闲冻结；实验并发 1、GC 延迟且有 pin | 首版关闭 GC 会增长磁盘 |
| 双存储/跨库恢复发生半提交 | 原文存在但任务没创建，重复投递 | durable intent、确定性 ID、幂等接收、故障注入 | 改造复杂度高于只修改 JSONL |
| 权限变化或壳私有规则冲突 | 跨壳信息外露、任务行为不一致 | 投递/订阅/执行再校验作用域；私有记忆不自动带入 | 宿主文件工具访问需要自己的权限边界 |
| 调度与 classify 状态混淆 | 壳误报完成、等待队列卡死 | 任务业务状态、队列状态、上下文资源状态分别投影 | 多维状态需更清楚的错误提示 |

最需要优先阻断的是错任务执行、重复外部动作、跨范围内容注入和证据丢失；缓存变化、额外判定延迟与磁盘增长属于需要测量和预算的取舍，不能用前四项风险换命中率。

## 11. 实验步骤与放行标准

下列数字是建议的实验门槛，尚未采样或测得；达到门槛也不代表对所有自然语言提供形式化保证。

| 阶段 | 实验内容 | 放行标准 |
| --- | --- | --- |
| E0 离线与 shadow | 至少 120 条标注样本，覆盖 same/new/child/related/指代歧义/控制消息，每类至少 20 条；shadow 只记录决策，不改变真实任务或运行 | 明确引用与控制消息映射 100% 正确；自动执行子集的路由精确率 ≥99%；单独报告覆盖率、拒绝/澄清率和误拆率，不能靠全部拒绝达标 |
| E1 显式多壳闭环 | 新建两个实验壳、三个任务，显式关联同任务和同树兄弟；用 fake CLI / 工具验证事实源与队列 | 一任务一个活动执行者；原文/费用一次；两个壳的问题状态同步；切换 focus 不影响目标；旧入口不旁路 |
| E2 时序和崩溃 | 至少 200 组可重复交错序列，注入路由、创建、绑定、入队、问题 reserve、结果保存各边界崩溃 | 丢消息、重复执行、串任务、越范围注入均为 0；重启能够恢复或给出明确受阻状态 |
| E3 自动路由与上下文 | 在 E0 留出的独立样本验证自动 same/new 和关系建议；放置任务/壳私有唯一标记，捕获可观测的实际模型请求 | 不相关标记泄露 0；当前任务必要决定保留；恢复旧分支能识别代码变化；纠正操作可追溯 |
| E4 真实模型对照 | ≥30 组配对场景：连续追问、A→B→A、多壳共享各 ≥10 组；同 Provider/模型/工具 schema，冷热缓存分开并交错顺序 | 质量与必要约束通过率不低于基线；报告全部样本费用、输入/缓存 token、TTFT p50/p95、重复调查次数；探索性目标为完成同等工作的总模型费用不高于基线 110%，超出需分析归集/检索/冷启动成本再决定推广范围 |
| E5 小范围试用 | 同目录显式启用，先 Web、后 App，再逐 CLI 验证；原生 GC 仍关闭 | 关键故障为 0，澄清率/等待时长可接受；功能协商、退场、消息查询可用后才扩大 |

E0 至少预留三分之一独立验收样本，不用同一批调提示再报泛化效果；计入 ambiguous、不可用与拒绝样本。E4 的 30 组仅是探索性对照，应公布离散程度，不把小样本均值当长期成本保证。真实模型实验只在后续实施验证阶段执行，使用隔离仓库、合成数据与可控工具，不重放用户历史中的真实发布、删除、支付或消息发送动作。

对照组用当前代码完成相同输入和同一验收目标；跨壳共享的基线采用两个窗口打开同一个现有任务会话，避免拿“重复做两次工作”的旧路径虚增实验收益。普通任务切换按当前普通会话流程对照，各组使用等价初始文件状态；分别计入归集、检索、摘要和主执行费用，延迟单独报告，不与费用混作一个指标。

必须具备的时序场景：A/B 同时向 T1 发不同消息；两壳相同 clientMsgId；同消息断线重试；两壳对 Q 给不同答案；A 等回调时 B 切到 T2；冻结/归档边界收到迟到结果；模型切换与回答同时发生；删除壳时任务仍执行；任务 alias 改变时消息仍排队；新旧 Web/App 同时连接；share token 访问实验消息；GC 扫描撞上恢复与用量结算。

测试扩展以现有 `tests/test-task-bound-session.js`、`tests/test-session-work-scheduler.js`、`tests/test-user-input-answer-delivery.js`、`tests/test-task-run-store.js`、`tests/test-task-board-groups.js`、`tests/test-task-board-merge.js`、`tests/test-chat-transport.js`、`tests/test-chat-user-input-card.js` 为基础；新增 task-shell route/projection/store/recovery 契约和跨壳时序用例。业务实施时按变更运行 core/security/state/provider-router/contracts/architecture，并在 i18n 改动时执行生成与检查。本轮仅验证设计文件引用、格式和发布访问，不将这些未来用例记为已通过。

## 12. 上线顺序、退出与最终建议

按目录 opt-in，模式为 off → shadow → explicit → automatic；每条消息记录准入模式，切换开关不能使已入队消息改走另一条执行链。先创建全新的实验壳与任务，禁止把现有混合原生历史直接改标签当隔离历史。旧任务可用稳定 refs 只读导入证据；未核验的原生文件标 legacy-unverified，不自动清理。

一旦出现错任务执行、重复动作、内容越范围或证据损坏，暂停该实验目录的新自动准入并冻结切换/GC；已接受的任务和问题通过支持该 schema 的执行版本恢复、人工取消或排空。切换到 explicit 仅影响后续未执行消息，保留原文、路由记录与绑定。不能将实验壳直接重新启用为旧原生 CLI 会话，也不能简单降级二进制后忽略新数据；没有恢复验证的版本不得接管实验任务。

交付顺序建议：先完成 E0 及 canonical message/link/binding/question 最小基础，再实现 E1/E2；随后引入自动路由和固定任务快照，最后覆盖 App、多 CLI 及受保护 GC。任务树初期只承担组织和证据引用，依赖自动调度留待独立需求。动态改 JSONL 可保留为已验证 CLI 的局部裁剪手段，不作为跨任务隔离成立的前提。

这套实验的核心验收是：两个壳连接同一任务时访问同一份工作事实，连接同树不同任务时保持不同上下文；任务关系判断可解释、可纠正；已发生的消息、工具动作和费用不会因视图或归属变化而被抹掉或重复。业务实现需要完成后再手动重启服务，本设计交付不需要重启。
