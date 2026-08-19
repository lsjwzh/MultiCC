# Chat View 统一化改造：任务详情 chat 化 + UI/写侧隔离

> 状态：**已拍板（2026-08-19），待实施**
> 作者：架构师会话（multicc-codex-chat-04）
> 前置：docs/task-virtual-session-design.md（任务虚拟会话 B 方案，阶段 1/2 已部分合入）
> 依据：两份只读代码侦查（前端 chat 模块矩阵 / 后端 spawn·拼接·resume 三轴），文中 file:line 均已核对。
>
> **本文档取代 task-virtual-session-design.md 的 §5（阶段 3 前端）与 §4.4（流式转发）**，并将其升级为完整的「chat view 统一化 + 四轴隔离」方案。原阶段 3 计划（manage 页 `.tb-msgs` 容器内嵌 history-view）不再实施，由本方案 M2 的 `chat.html?task=` 全页方案替代——差异：原方案只统一渲染组件，本方案统一整页宿主与数据通道。

## 0. 决策记录（用户 2026-08-19 拍板，全部采纳推荐项）

| # | 决策 | 选择 | 否决项理由 |
|---|---|---|---|
| D1 | 任务详情页形态 | **复用 `chat.html?task=<id>`** | 独立 task.html 薄壳会双页面维护、样式漂移 |
| D2 | 任务 worktree 生命周期 | **per-task 跨 run 稳定，完结后手动清理** | per-run 用完即弃则每轮重建、diff 无连续性 |
| D3 | 旧任务板详情 modal | **新 chat view 上线后退役，任务列表保留** | 双入口长期并存=双实现漂移 |
| D4 | chat.js 拆法 | **拆 chat-host-core + session-features** | mode 分支继续膨胀 3k 行文件 |

背景目标（用户原话锚定）：任务展示页面与 chat view 一模一样、也有 worktree 功能；chat view 通用化改造、禁用 role memory 类功能；任务不走会话 resume；把 UI 与底层 spawn / 上下文拼接 / resume 逻辑隔离。

## 1. 现状梳理（结论）

### 1.1 前端：渲染核心已通用，宿主是唯一重耦合点

| 模块（public/） | 行数 | 通用性 |
|---|---|---|
| chat-transport.js | 271 | ✅ 完全通用（ticket/退避重连/心跳，无 session 概念） |
| chat-history-store.js | 267 | ✅ 纯状态机，只认 `{messages, hasMore, tokenUsage}` DTO |
| chat-history-view.js | 788 | ✅ 气泡/工具卡/markdown/usage 行，只认 DTO 字段 |
| chat-composer.js | 786 | ✅ transportSend 注入项（任务板 composer 已验证 POST 版可行） |
| chat-event-controller.js | 703 | ✅ host 注入式（chat.js:2411-2450 装配），可换宿主 |
| chat-live-ui.js | 1388 | ✅ 大部分（thinking/danmaku/usage/弹窗） |
| status-presentation.js | 501 | ✅ task 域已在词表（taskStatus:310） |
| **chat.js** | **2979** | ❌ 重耦合：`?session=` URL（:122）、会话按钮组、merge/liveness poll、role/memory/memo/provider 全局态 |

会话专属功能清单（M2 禁用面）：role prompt（chat.html:2518, chat.js:1790-1953）、memory 库（chat.js:1979-2123）、memo（chat.html:2541）、provider/model/cli 切换（chat-ai-config.js:766-783）、restart-spawn/rename/share/fork（chat-recovery:44 等）、merge/sync/conflict/auto-commit（chat.js:1111-1296）、liveness pill（chat.js:1285）、会话队列 dock（EC:343）、上下文 clear/rotate（chat-context-controls.js）、oauth 横幅。**全部为按钮级或宿主回调级切口，无一深入渲染核心。**

任务板详情现状（manage-taskboard.js:470-561）：纯 textContent 无 markdown/无工具卡（:541）、整块 innerHTML 重建无增量、无流式无取消无分页、消息更新靠 400ms debounce 全量 refetch + 60s 兜底轮询（:85/:650）。与 chat view 差距为代际级。

### 1.2 后端：写侧已分层共享，读侧是真缺口

- **spawn 轴**：`runChatTurn`（src/chat/turn-engine.js:696）→ normalize → composeMessage → renderPrompt → resolveSpawnEnv → buildInvocation → 分流（claude 常驻流式 :1605 / 其他 per-turn 进程 :1178）。任务板经 dispatch→outbox 走同一入口；槽位 record 提供全部 spawn 字段（cli/provider/model/rolePrompt 在建 worker 时定，src/commander-host-runtime.js:41-56）。**写侧天然共享，不动。**
- **上下文拼接轴**：`composeMessage`（src/message-composer.js:192）纯函数 + deps bag（:186-190）；role memory 层在 `resolveRolePrompt`（src/memory/folder-service.js:170，:120-136 注入记忆库快照）。**禁 role memory = 注入 `resolveRolePrompt:()=>null`，systemPrompt 退化为纯 imgHint。**
- **resume 轴**：任务槽位跨 run 本来就不 resume——run 终结 `resetSlot`（src/task-run-host.js:164-174）清 cliSessionId + 删 chat history 文件。现状已成立，本设计将其固化为契约不变量（§5-I2）。

**读侧缺口**：`handleChatWs`（turn-engine.js:1862-1918）硬绑 persistedSessions/chatSessions 双 Map，init 帧（:1930-1946）与断线回放（:1954-2011）以 sessionName 为主键，`isInternalExecutionSlot` 拦截（:1865）。任务详情只有一个一次性 HTTP 全量端点（GET /api/task-board/tasks/:id/messages），无分页、无 WS。

### 1.3 任务侧三个关键事实

1. **槽位无 worktree**：`createWorker` 不传 worktreePath（commander-host-runtime.js:41-56）→ `cwdForSession`（server.js:1050-1062）落到 dir 根路径。改代码类任务直接污染主工作区——M3 的动机。
2. **双轨真相**：会话消息在 `<dataDir>/chat_history/<session>.json`（src/paths.js:60，JSONL 文件 repo）；任务消息在 task-runs.sqlite 台账（paths.js:108，schema 见 src/task-run-store.js:171-184）。槽位 chat_history 随 resetSlot 删除，台账是唯一持久源。
3. **流式断头**：槽位回合事件只发给槽位自己的 WS 客户端（src/task-context-host.js:118-125，恒为空集合）——详情页实时渲染无通道。

## 2. 核心设计：Transcript View 契约（读侧接口抽象）

```
前端（chat 渲染核心：transport / history-store / history-view / live-ui / event-controller / composer，不动）
   │  只依赖契约五件事：
   │  ① init 快照（identity + 首页 history + 状态）
   │  ② history 分页（before/limit/around）
   │  ③ 流式事件（stream_start / delta / result / msg_meta / task 状态）
   │  ④ send（幂等 clientMsgId）
   │  ⑤ cancel
   ▼
┌─ Transcript View 实现 ─────────────────────────┐
│ SessionTranscript（现状迁出，行为零变化）        │
│   = chat_history 文件 repo + /ws/chat 会话通道  │
│ TaskTranscript（新建）                          │
│   = task_run_messages 只读投影 repo（sqlite）   │
│   + /ws/meta 或 /ws/workspace 的 task_run_stream│
│   + POST /api/task-board/tasks/:id/send        │
└────────────────────────────────────────────────┘
   │ 写侧（三条轴，两种视图共享，不动）
   ▼
runChatTurn → composeMessage(deps 注入) → spawn → finalize → 台账/chat_history 双写
```

UI 层从此不知道背后是会话还是任务。四轴隔离的落点：**spawn/拼接/resume 留在写侧被两种视图共享；UI 只面对契约。**

现成接缝（侦查确认）：
- chat-history-service 经 `assertChatHistoryPort` 消费 repo（server.js:238 注入文件版）——做一个读 `task_run_messages` 的只读 repo 即可复用 paginate + buildReplayMessages（src/routes/chat-history.js:114）。
- turn-request.js:5-8 FORBIDDEN_FIELDS 已拒收 cliSessionId；`hasNativeSession:false` 自然推导 first-turn——任务视图"不走 resume"只需不传 native 证明。
- event-controller host 注入式；transport 无会话概念；composer transportSend 注入。
- wrapper 过滤已有先例：`metadata.wrapper` + `isTaskRunWrapperText`（task-run-context.js:423-441、task-board.js:330-337），`storedTaskMessages`（task-board.js:339-355）是现成读取器。

## 3. 分期计划（M0-M4）

### M0 · 后端读侧：task transcript 投影（先行，独立可合）

**改动**
- 新建 `src/task-transcript-repository.js`（**已实施，2026-08-19**）：纯读侧投影——`taskTranscriptMessages`（台账行 → chat 消息 DTO，白名单 metadata 透出 tools/usage/cost/durationMs/partial/kind/taskRunId，过滤 wrapper）+ `paginateTranscript`（与 chat-history.js:284-319 逐语义对齐的纯分页函数）。实施时未新建独立路由文件：端点已在 task-board.js，原位升级 `handleMessages`（server.js 零改动，行预算/守卫不受影响）。
- `GET /api/task-board/tasks/:id/messages` 升级：响应新增 `messages/hasMore`（`around` 时加 `found/hasNewer`），支持 `before/limit/around`；旧字段（`text`/`items`/`runs`/`usage`）原样保留（不变量 I3）。legacy ref 任务（无台账）走同分页契约（index 派生 id，历史冻结故稳定）。
- DTO 映射：台账行 → chat 消息 DTO `{id, role, content, tools, usage, cost, durationMs, ts, kind, partial, taskRunId}`；metadata.tools/usage 依赖阶段 2 的 recordMessage 扩展——未落字段自然降级为纯文本（渲染器对空 tools 本就跳过）。

**验收（已达成）**
- `tests/test-task-transcript.js` 5 用例：DTO 投影白名单（内部字段 code/retryable/lease 不外泄）、wrapper 双层过滤（标志+遗留前缀，assistant 不误伤）、分页契约（tail/before/around/游标未知/limit 钳制）、路由集成分页 + 旧字段并存、legacy 任务同契约降级。
- 旧前端（manage-taskboard 现版）打新端点不崩：响应只增字段（I3）。
- 回归：test:deterministic 1244/1244、test:contracts 55/55 全绿；server.js 未动，line-budget 不变。

### M1 · 流式转发：task_run_stream

**改动**
- 新建 `src/task-run-stream-forwarder.js`（**已实施，2026-08-19**）：`createTaskRunStreamEmitter(emitClients, chatSessions, records, workspaceBroadcast, opts)` 返回 emitClients 的包装函数。门禁严格：仅 `taskExecutionSlot===true` 且 state 带 `_currentTaskId/_currentTaskRunId` 的会话转发；信封 `{type:'task_run_stream', taskId, runId, dirId, slotEvent}`（单个）/`slotEvents`（批），**槽位 sessionId 永不进信封**。delta 级事件（part_delta / stream_event·content_block_delta）100ms 窗口合并成批发；非 delta 事件先同步冲刷挂起批次再立即转发（保序）；批内上下文（task/run/dir）在批次开启时捕获，冲刷时状态已变仍正确归因。判定函数/定时器均可注入（测试确定性）。
- 接线（server.js 净零行）：`taskContextHost.broadcast` 把 sessionId 作第三参传给 emitClients（其余 emitClients 消费者忽略多参）；server.js:190 解构再导出 + :2184 emitClients 原行替换为工厂调用。工厂经 task-context-host.js 再导出以省一个 require 行（server.js 恰在 3000 行上限）。
- 安全面：不新增（slot 本就把同样内容发给「它自己的客户端」只是恒为空；仅到本 dir 订阅者 + metaClients，与 task_board_update 同权限面）。

**验收（已达成）**
- `tests/test-task-run-stream-forwarder.js` 6 用例：信封形状+槽位 id 不外泄、非槽位/无活动 run 不转发、delta 窗口合并、非 delta 先冲刷后转发保序、delta 类判定边界（content_block_delta 是 / message_start 否）、task-context-host 三参传递兼容旧两参。
- 回归：deterministic 1244/1244 + contracts 55/55 绿；server.js 仍 3000 行整。
- （待 M2 联动验证：fake CLI 慢速输出下前端实时渲染——前端消费者落地时一并验收。）

### M2 · 前端宿主通用化（大改造主体，D4）

**改动**
- chat.js（2979 行）拆三块（分批合入，参考 server.js 拆分批次四坑：交错块丢失/TDZ 扫描/基线误判/handoff 快照）：
  1. `chat-host-core.js`（新，~900 行）：URL 解析（`?session=` 或 `?task=`）、模块装配、渲染管线、契约五件事接线、autofill 分页、断线 reconcile；
  2. `chat-session-features.js`（新，从 chat.js 抽出）：role/memory/memo/provider·model·cli 切换/merge·sync·conflict·diff/share/fork/rename/restart-spawn/liveness/会话队列/oauth——按 feature flag 挂载（`mode==='session'` 全开，行为零变化）；
  3. chat.js 保留为会话模式入口 + 旧全局兼容壳（外部脚本引用不断，chat.html script 序微调）。
- `chat.html?task=<id>` 任务模式：
  - bootstrap：`GET /api/task-board/tasks/:id`（identity/状态）+ M0 分页 history；不调 `/api/sessions/:id`、`/api/providers`、agent-presets。
  - WS：订阅 dir workspace WS（`/ws/workspace?dirId=` 或 `/ws/meta`），消费 `task_run_stream` + `task_board_update`；重连/回放语义按 reconcile 降级（断线后以 M0 分页重拉对账，替代 session 版 chat_history 重放）。
  - composer：transportSend 换 `POST /api/task-board/tasks/:id/send`（clientMsgId 幂等已具备，manage-taskboard.js:198-205 已验证语义对齐）；本地 staged 气泡 → 收到台账确认（task_board_update 或 POST 响应）后 commit，替代 chat_msg_meta。
  - 按钮组按 §1.1 禁用清单不渲染；classify 状态条参数化：task runState 映射到同一条（status-presentation task 域词表现成）。
  - run 分隔条：「第 N 次执行 · 状态 · 时间 · token 合计」，数据来自 run DTO。
- 任务列表入口改跳 `chat.html?task=`；manage 页旧详情 modal 标记 deprecated（M4 退役）。

**验收**
- `chat.html?task=` 与 `chat.html?session=` 除禁用项外视觉/交互一致（对照清单人工过一遍 + 截图）。
- 会话模式回归全绿：feature flag 全开 = 行为零变化（chat 回归套件 + 手工冒烟）。
- 旧任务纯文本降级不报错（无 tools/usage 的台账行渲染为纯文本气泡）。
- 发送→流式→commit 闭环：clientMsgId 幂等（重发不重复执行）。

### M3 · per-task worktree（D2）

**改动**
- 任务创建（或首次需要改代码时惰性）开 worktree：分支 `multicc/task-<taskShortCode>`，路径 `.multicc-worktrees/task-<shortCode>`（复用现有 worktree 布局约定）。**task 维度跨 run 稳定；不是 slot 维度、不是 run 维度。**
- run 开始时把 `task.worktreePath` stamp 进槽位会话（同 `_currentTaskId` stamp 机制，task-context-host.beginTurn 族）；`cwdForSession` 优先读 `session.worktreePath`（server.js:1058 现成逻辑），run 边界切换天然安全——resetSlot 清进程，下一 run 以新 cwd 首启。**不变量：一个 run 从头到尾一个 worktree（I6）。**
- 台账：task 表记 worktreePath/branch；run metadata 记实际 cwd（可观测）。
- diff/merge 端点参数化：现有 `/api/sessions/:id/diff|merge|sync` 的逻辑以 worktreePath 为维度抽纯函数，task 端点（`/api/task-board/tasks/:id/diff|merge`）复用；前端 chat-diff.js 浮层直连（open(sessionId) 参数化）。
- 清理：任务完结不自动删（D2）；详情页给「merge 回基分支后清理 worktree」一键操作；归档时若 worktree 未 merge 给提醒。防磁盘泄漏。
- 并发：同 dir 多任务 = 多 worktree 并行，互不串 cwd；任务 worktree 与会话 worktree 命名空间隔离（`multicc/task-` 前缀）。

**验收**
- 改代码类任务在独立 worktree 执行：主仓 `git status` 不变；diff 浮层可见、merge 可用。
- 同任务第 2 轮 run 复用同一 worktree（连续 diff）。
- 并发两任务不串 cwd；slot reset 后下一 run cwd 正确。
- 清理按钮：merge + worktree 删除 + 台账状态更新原子完成（失败可重试、不半删）。

### M4 · 收尾统一

**改动**
- pendingQuestion（task-board-ui.js:210-300）与 chat 的 user_input_required 卡（EC:326）两套实现统一为一套（保留 chat 版语义，任务版退役）。
- manage 页旧详情 modal 退役（D3）：任务列表保留、详情一律跳 chat view；`/messages` 旧响应字段保留一个过渡版本再删（先标 deprecated）。
- App（Flutter）跟进：TaskMessage 模型加 tools/usage/kind/partial，MessageBubble/ToolCallGroup 复用，workspace WS 加 task_run_stream case（原设计 §5.2 内容平移）。
- 共享契约测试：session/task 两实现背靠同一 DTO golden（防漂移，不变量 I7 的执行机制）。
- 文档：architecture.md / features.md / api-reference.md 同步。

**验收**
- 全量回归绿（含三守卫）；双实现 DTO golden 测试进 CI。
- App 端任务详情 chat 化渲染 + 流式可用。
- 旧版 App/Web 打新服务端不崩（字段兼容测试）。

## 4. 实施顺序与依赖

```
M0 (读侧投影) ──→ M1 (流式) ──→ M2 (宿主通用化) ──→ M4 (收尾)
                        ↘ M3 (worktree，可与 M2 并行，落点在写侧+task 表，不碰 chat.js)
```
- M0 独立可合，先行；M1 依赖 M0 的 DTO 形状；M2 依赖 M0+M1；M3 与 M2 无文件冲突可并行（另一会话实施）；M4 收尾。
- 每期独立 commit + merge，随时可停。

## 5. 不变量（全设计必须守住）

1. **I1 台账唯一事实源**：TaskTranscript 只读 sqlite；展示、编译、usage 结算都只读台账；slot chat-history 与原生 jsonl 是一次性投影。
2. **I2 任务 turn 永远 first-turn 语义**：不透出/不依赖 cliSessionId；run 终结即弃（B 方案 resume 否决案延续，固化为契约）。UI 回放（断线 reconcile）走台账重拉，不走原生 resume。
3. **I3 API 只加字段不删字段**：`text`/`items` 等旧字段保留；旧前端/旧任务数据降级可用。
4. **I4 调度语义不动**：leaseEpoch / slot CAS / outbox 幂等 / quarantine 一行不改。
5. **I5 脱敏**：台账、流式转发、DTO 不出现 cliSessionId/nativeSessionId/凭证。
6. **I6 一个 run 一个 worktree**：worktree 以 task 为生命周期，但 run 开始后不得中途更换；stamp 只发生在 run 边界。
7. **I7 会话模式行为零变化**：M2 的 feature flag 在会话模式全开；chat.js 拆分是搬移不是重写（外部全局引用兼容壳保留）。
8. **I8 事件不解包**：task_run_stream 只包一层信封（taskId/runId/slotEvent），事件语义与 slot 原生事件逐字节一致——前端复用同一 controller 的前提。

## 6. 风险登记

| 风险 | 影响 | 对策 |
|---|---|---|
| chat.js 拆分回归面大（2979 行 + 外部全局引用） | 会话功能破损 | 分批合入 + 每批全量回归；兼容壳保旧全局名；参考 server.js 拆分四坑教训（交错块丢失/TDZ/基线/handoff） |
| worktree 磁盘泄漏（完结不清理堆积） | 磁盘与分支污染 | 详情页一键清理 + 归档提醒；`multicc/task-` 前缀便于批量审计 |
| 双实现漂移（Session/TaskTranscript） | 同一 bug 修两遍或漏修 | §5-I7 共享 DTO golden 契约测试；事件不解包（I8）从根上消一半翻译层 |
| 断线 reconcile 语义降级（任务版无 chat_history 重放） | 断线后短暂不一致 | 对账兜底=分页重拉；staged 气泡以 POST 响应/台账为准，不信任本地乐观态 |
| 流量放大（大 dir 多任务） | metaClients 风暴 | delta 100ms 节流；仅匹配 taskId 的前端消费 |
| M3 惰性建 worktree 的时机竞态（同任务两 run 并发） | 两 run 争一 worktree | 同任务 run 串行（现有调度已保证同槽串行）+ 创建幂等（已存在即复用） |
| 台账缺 tools/usage（阶段 2 未完成时） | 任务 chat view 无工具卡 | 渲染降级为纯文本（渲染器对空 tools 本就跳过）；M0 不阻塞在阶段 2 上 |

## 7. 决策摘要

| 决策 | 选择 | 否决（理由） |
|---|---|---|
| 详情页形态（D1） | 复用 chat.html?task= | 独立 task.html（双页面维护、样式漂移） |
| worktree 生命周期（D2） | per-task 稳定 + 手动清理 | per-run 即弃（每轮重建、diff 断裂）；per-slot（槽位是池化资源，与任务语义不符） |
| 旧 modal（D3） | 退役，列表保留 | 长期双入口（双实现漂移） |
| chat.js 拆法（D4） | host-core + session-features + 兼容壳 | mode 分支（继续膨胀）；一次重写（回归不可控） |
| 隔离抽象 | Transcript View 读侧契约（五件事） | 写侧抽象（任务写侧已共享 runChatTurn，无需新抽象；缺口只在读侧） |
| 流式通道 | workspace.broadcast 信封转发，事件不解包 | 事件翻译层（双语义漂移）；slot 直订（破坏隐藏边界） |
| 历史通道 | 台账只读 repo 适配 chat-history port | 复制台账进 chat_history 文件（双写新轨，破坏 I1） |
