# multicc 大文件模块化拆分路线图

> 目标：把 5 个巨型文件**无损**拆成模块，不改运行时行为。
> 原则：分批、小步、每批走「设计文档 → 测试设计 → 代码修改 → 验证」四步循环。
> 创建：2026-07-12。本文件是后续所有批次的总纲，每批完成后在此追加进度。

---

## 1. 现状基线（2026-07-12 勘察）

| 文件 | 行数 | 结构概要 |
|---|---|---|
| `server.js` | **11219** | 历史基线：117 路由（GET 63 + POST 54 + 其他）+ 252 个顶层函数；当前版本已继续拆分，跨会话分派改为 MCP-only。 |
| `public/manage.js` | **7099** | 全局函数风格（无 IIFE/模块），全是顶层 `function`；职责：dashboard 渲染、目录/会话卡、拖拽、菜单、model picker、session dialog、memo、监控… |
| `public/chat.js` | **4858** | 全局函数风格；职责：WS 连接、流处理、工具卡、历史 replay、发送、merge/sync 状态、diff、model/effort/provider picker、memory… |
| `app/lib/screens/main_shell.dart` | **4938** | **32 个 class**，大量独立 StatefulWidget/StatelessWidget 子类（天然拆分单元） |
| `app/lib/screens/chat_screen.dart` | **3962** | **26 个 class**，同上 |

### 已有模块化基础（沿用其约定）
- **后端**：`src/` 下 20+ 模块，统一 `module.exports = { ... }`。例：`providers.js`、`git.js`、`message-composer.js`、`chat-stream.js`、`wait-injector.js`、`claude-proxy.js`、`codex-proxy.js`、`directory/`、`cli-adapters/`。
- **Flutter**：`app/lib/{models, providers, screens, services, widgets}` 已成型。`widgets/` 已有 8 个文件（conflict_diff_dialog, input_bar, message_bubble, model_picker, rainbow_border, session_diff_dialog, thinking_indicator, tool_card）。`screens/` 已有 21 个文件。

---

## 2. 测试基线（无损凭证）

### 纯逻辑单测（不依赖 server，拆分时的 fast-feedback 回归网）—— **全部 GREEN**
| 测试 | 结果 |
|---|---|
| `test-message-composer-golden.js` | 26 passed / 0 failed ✓ |
| `test-codex-transform.js` | 40 passed ✓ |
| `test-classify-api-errors.js` | ✓（含 classify/dispatch 错误分支） |
| `test-wait-injector.js` | 32 pass / 0 fail ✓ |
| `test-bg-completion-coalescer.js` | 13 passed ✓ |
| `test-directory-service.js` | 36 passed / 0 failed ✓ |

> **判回归标准**：每次拆分后，以上 6 个必须保持全 green。

### 集成测试（需 server / claude CLI 在跑，按需抽查）
- `tests/test.js`（auto-detects `:3000`）、`tests/smoke-core.js`（含旧 HTTP dispatch 退役探针）、`tests/test-cross-cli-dispatch.js`（多 CLI 活体 smoke；MCP sync/async 分派由 Router runtime/host/MCP 测试覆盖）。
- 拆完 server.js 后：启动 server → curl 抽查被搬路由仍可达 → 跑 smoke-core。

---

## 3. 关键坑（必读）

1. **server.js 含 3 个故意 NUL 字符**（`\x00`），在 `buildMemoryGraph`（行 2916/2955/2961）用作记忆图谱 Map key 的分隔符（node id 可含任何可打印字符，唯独不含 NUL）。**禁止删除**。后果：`grep` 默认把 server.js 当二进制 → 任何文本搜索必须加 `-a`（或用 perl/python）。
2. **worktree 里跑集成测试常因环境假性失败**（MODULE_NOT_FOUND / fetch failed / TIMEOUT），判回归只信「纯逻辑单测 + server 能否启动 + 路由抽查」。
3. **子 agent 额度池耗尽（API 402）**：Workflow/Task 工具 spawn 的 agent 全部失败。本拆分改用**串行 ultracode**（自己分步推进），不依赖 fan-out。
4. **前端 JS 是静态 `<script>`（非打包）**：改 ES module 要动 HTML `<script type="module">` 与加载顺序，风险高 → 批次 C 先用「全局命名空间对象」过渡。

---

## 4. 拆分批次（从低风险高收益 → 高风险）

### 批次 A：Dart widget 抽离（低风险，边界清晰）
把 `main_shell.dart` / `chat_screen.dart` 里**独立的 widget 子类**抽到 `app/lib/widgets/`（或 `screens/<feature>/`）。延续已有 `widgets/` 约定。
- **风险点**：widget 若依赖父 State 的私有字段/_method，需先用「构造参数 + callback」解耦。
- **验证**：`flutter analyze`（无 error）+ app 启动 smoke + 关键页截图比对。
- **原则**：**只搬 widget 类本身**，不动 `_MainShellState` / `_ChatViewState` 的状态逻辑；被引用的类型/常量保持 import 可达。

#### A1. main_shell.dart 可抽 widget（行号 = class 定义处，含其 State）
| 类 | 行号 | 目标文件 |
|---|---|---|
| `_KpiRow` / `_KpiTile` | 938–1050 | `widgets/kpi_tile.dart` |
| `_FleetDetailSheet` | 1437–1779 | `widgets/fleet_detail_sheet.dart` |
| `_DirectoryCard` | 1779–2524（大块） | `widgets/directory_card.dart` |
| `_DirectoryPreview` | 2536–2630 | `widgets/directory_preview.dart` |
| `_HomeTaskScroller` | 2630–2782 | `widgets/home_task_scroller.dart` |
| `_TaskProgressCard` / `_ActiveTask` | 2782–2924 | `widgets/task_progress_card.dart` |
| `_DirectoryPushButton` | 2924–2985 | `widgets/directory_push_button.dart` |
| `EventTimeline` | 2985–3112 | `widgets/event_timeline.dart` |
| `_ProjectStatPill` | 3112–3159 | （并入 timeline 或 kpi） |
| `_SessionGroup` | 3159–3242 | `widgets/session_group.dart` |
| `SessionCard` | **3242–4128（核心超大）** | `widgets/session_card.dart` |
| `_MiniBadge` / `_AddSessionChip` | 4128–4237 | `widgets/session_badges.dart` |
| `_CreateSessionDialog` | 4237–4744（大块） | `widgets/create_session_dialog.dart` |
| `_UncommittedFilesDialog` / `_GitStatusRow` | 4744–4938 | `widgets/uncommitted_files_dialog.dart` |

#### A2. chat_screen.dart 可抽 widget
| 类 | 行号 | 目标文件 |
|---|---|---|
| `_Header` | 249–513（大块） | `widgets/chat_header.dart` |
| `_ModelChip` | 513–725 | `widgets/model_chip.dart` |
| `_AIConfigSheet` | **746–1853（超大）** | `widgets/ai_config_sheet.dart` |
| `_RolePromptEditorDialog` | 1853–2149 | `widgets/role_prompt_editor_dialog.dart` |
| `_PresetChip`/`_HeaderBtn`/`_ClearCtxButton`/`_ClearMenuBody` | 2149–2578 | `widgets/chat_header_bits.dart` |
| `_HeaderOverflowMenu` | 2578–2752 | `widgets/header_overflow_menu.dart` |
| `_MergeReadyBanner` / `_BehindMainBanner` | 2752–2879 | `widgets/merge_banners.dart` |
| `_AuxClassifyBar` / `_CwdBar` / `_TimeSeparator` | 2879–3165 | `widgets/chat_bars.dart` |
| `_MessageList` | 3165–3413 | `widgets/chat_message_list.dart` |
| `_CostBar` / `_ChatCliBadge` | 3413–3467 | `widgets/chat_badges.dart` |
| `AgentPresetPickerSheet` | 3467–3783 | `widgets/agent_preset_picker.dart` |
| `_CategoryChip` / `_PresetCard` | 3783–3962 | （并入 preset picker） |

> **批次 A 推进顺序建议**：先挑 2–3 个最小、最自包含的（`_KpiTile`、`_TimeSeparator`、`_GitStatusRow`）跑通整套流程作示范，再搬大块（`SessionCard`、`_AIConfigSheet`、`_DirectoryCard`）。

---

### 批次 B：server.js 路由领域化（头号目标，高风险，分多步）
**策略**：构造一个共享上下文 `ctx`，把 117 个路由按领域抽到 `src/routes/<domain>.js`，每个文件 `module.exports = function mount(app, ctx) { app.get/post(...) }`；`server.js` 只保留启动、装配、ctx 组装。

#### B0. 先抽「纯工具函数组」（无路由副作用）→ 挂到 `ctx` 或 `src/server-lib/`
| 组 | 函数 | 行号 |
|---|---|---|
| 认证 | `signToken`/`generateAuthCookie`/`verifyAuthCookie`/`parseCookies`/`isAuthenticated`/`isLocalRequest`/`isExternalProxy` | 96–235 |
| model/effort 解析 | `claudeDefaultModel`/`effectiveSessionModel`/`effectiveSubagentModel`/`cliEffortLevel`/`codexReasoning*`/`effortLabel` … | 320–560 |
| id 分配 | `generateId`/`sessionIdPrefixForDirectory`/`allocateSessionId`/`resolveCwd` | 1585–1632 |

#### B1..Bn. 按领域抽路由组（每个一个文件，独立 mount；行号 = 该组首个路由）
| 文件 | 领域 | 路由行号 |
|---|---|---|
| `routes/auth.js` | login/logout | 153–235 |
| `routes/dashboard.js` | sessions/dashboard/stats | 1919–2053 |
| `routes/classify.js` | reclassify / classify-all | 2053–2146 |
| `routes/agent-resources.js` | skills / presets / claude-sessions | 2146–2300 |
| `routes/directories.js` | memo / sessions / workspace | 2321–2485, 3698+ |
| `routes/memory.js` | memory / graph（**含 NUL buildMemoryGraph**） | 2698–2977 |
| `routes/messages.js` | delete-msg / share / fork / bundle / history | 3086–3526 |
| `routes/share.js` | /share/:token | 3526–3569 |
| `routes/triggers.js` | session triggers | 3569–3614 |
| `routes/git.js` | diff / git-log | 3623–3749 |
| `routes/lifecycle.js` | delete / relocate / restart / merge / sync / rebase / notes | 3749–4120 |
| `routes/files.js` | files / upload / download | 4127–4250 |
| `routes/voice.js` | voice refine/feedback/stt + settings/voice | 4250–4672, 4523–4566 |
| `routes/push.js` | push vapid/subscribe/test + settings/notify | 4672–4719, 4767–4788 |
| `routes/settings.js` | cli/tunnel/access-token/proxy/oauth/power/goal/aux-config | 4788–6017（巨大，可再切） |
| `routes/aux.js` | aux status/health/history/enqueue/config | 5817–6008 |
| `routes/providers.js` | providers CRUD / defaults / probe / speedtest | 6064–6427 |
| `routes/wait.js` | wait / resolve / waits | 9941–9971 |
| `routes/detached.js` | run-detached / detached | 9984–10022 |
| `routes/scan.js` | scan history | 7818 |
| （保留 inline） | bridges mount（wechat/feishu 等） | 6890–6902 |

> **批次 B 非路由大块业务逻辑**（WS handler、classify 引擎、dispatch/gateway 引擎、push monitor、cron 调度）优先级低于路由，放 B 后段或单独批次。

> **B 的最大风险**：路由 handler 闭包引用了顶层 252 个函数和大量顶层变量。抽路由时，被引用的符号要么一起搬到同文件，要么先挂到 `ctx`。**第一步只搬一个最小领域**（如 `routes/scan.js`，仅 1 个路由）跑通 mount 机制，再逐步扩。

---

### 批次 C：前端 JS 模块化（中风险）
`manage.js` / `chat.js` 全局函数 → 模块。
- **过渡方案**（先低风险）：按职责分文件，挂全局命名空间对象 `window.MULTICC = { dashboard: {...}, monitor: {...}, picker: {...}, ... }`，原全局函数名改为 `MULTICC.x.func()`，HTML 顺序加载多 `<script>`。行为不变。
- **最终方案**：再逐步改 ES module（`<script type="module">`），注意 CSP / 依赖顺序 / `tt()` i18n 全局。
- **验证**：browser-act / headless Chrome+CDP 实测各页面核心功能（dashboard 渲染、新建会话、发消息、merge、picker）。

---

## 5. 每批统一四步流程（ultracode）

1. **设计文档**：把该批细化成「哪些符号 → 哪个文件，依赖怎么接，解耦点在哪」，追加到本文件 §6 进度表 + 公共记忆。
2. **测试设计**：写下该批的「通过判据」（涉及哪些回归单测、要抽查哪些路由/UI）。
3. **代码修改**：小步搬，每搬一组立即跑测试。
4. **验证**：全量基线单测 green + server 启动 + （Dart）`flutter analyze` + （UI）截图/CDP 抽查。**通过后 commit。**

---

## 6. 进度表

| 批次 | 切片 | 状态 | commit | 备注 |
|---|---|---|---|---|
| 基线 | 6 纯逻辑单测全 green | ✅ 完成 | — | 2026-07-12 |
| A0 | 示范：main_shell.dart 抽 MiniBadge + AddSessionChip | ✅ 完成 | 见 batch-a0 | 4938→4868，error 0，issues 15=基线，无损 |
| A1 | main_shell.dart 剩余 widget | 🔄 进行中 | — | 已拆 MiniBadge/AddSessionChip/GitStatusRow/KpiTile/ProjectStatPill；累计 4938→4707(-231)；余 SessionCard(886)/_DirectoryCard/_CreateSessionDialog 等大块（多需解耦顶层私有函数 _showSessionSheet/_sessionLastInteractionAt） |
| A2 | chat_screen.dart widget | ⬜ | | |
| B0 | server.js 工具函数组 → ctx | ⬜ | | |
| B1 | server.js 首个领域（scan.js）跑通 mount | ✅ 完成 | 见第六波 | `/api/scan/history` 已走 `src/routes/scan.js` 窄依赖 mount |
| B2.. | server.js 其余领域路由 | ⬜ | | |
| C | manage.js / chat.js 模块化 | ⬜ | | |

---

## 7. 跨会话协作约定
- 每批完成后 `git commit` + 合并回 main（`curl -X POST $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/merge`），更新本表 + 公共记忆进度。
- 下个会话开工前先 `sync`（`curl -X POST $MULTICC_BASE_URL/api/sessions/<id>/sync`）拉最新基分支。
- 遇到 NUL / worktree 测试环境坑，参见 §3。

---

## 8. 2026-07-18 架构复审后的执行进度

旧基线保留用于追踪历史；当前主线已经经历持久化、Git actor、durable orchestration、ProviderRouterPort、Session bounded context 和安全边界重构，不能再按第 1 节的旧行号机械搬运。

### 当前热点基线

| 文件 | 当前约行数 | 判断 |
|---|---:|---|
| `server.js` | 12,481 | 仍是最大风险中心；只允许 composition/薄接线，禁止新增业务状态机 |
| `public/manage.js` | 约 7,356 | 继续用 classic/IIFE 共享层渐进迁移，暂不整体改 ESM |
| `public/chat.js` | 5,558 | 等 Chat turn 纯模块接线稳定后再拆 WS controller |
| `app/lib/screens/main_shell.dart` | 3,269 | 机械 widget 拆分已显著推进，剩余状态/导航耦合需单独批次 |
| `app/lib/screens/chat_screen.dart` | 1,676 | 大 widget 已拆出；下一步收敛 share/config/state ownership |

### 第一波（已完成并联合验收）

- Session query/workspace/chat-history 正式切到 bounded-context canonical service；旧 payload 通过 presenter 保持兼容。功能提交 `a71ed46`。
- 五个 IM bridge 的 gateway 生命周期、内部 Chat WS、echo、log/SSE、dispatch strip 和 chunking 统一到 `plugins/bridges/gateway-core.js`，adapter 删除约 1,000 行重复。功能提交 `a2aa984`。
- `src/path-safety.js` 成为 `realPathOf/isHomeOrAbove` 唯一实现；移除没有生产调用的 `node-pty` 及其安装/检测/fallback。功能提交 `12cf1bf`。
- 运行时写入治理清单随 Bridge 重构更新，避免重构后护栏锚点失效。提交 `eaf42c7`。
- 最新主线完成 `npm ci`、完整 `npm test` 和 `test:integration:isolated`；旧 worktree 的 CPR 0.2 假失败已通过锁文件重装消除。

### 第二波（纯模块基础已完成）

- `src/chat/`：turn request、retry policy、post-turn routing、runtime store 和窄 ports；13 项 characterization tests。功能提交 `2f8a90c`。本批不接生产入口。
- `src/http/`：品牌化 Domain/Infrastructure/HttpError、可信映射、白名单 presenter、async route、diagnostic result；普通错误伪造 `status/statusCode` 仍归 500。功能提交 `f91f696`。本批不接生产路由。
- `public/api-client.js` + `public/provider-catalog.js`：共享同源请求/错误元数据和 Provider 白名单归一；Provider 管理区已迁移，旧 DOM/payload 保持兼容。功能提交 `cce9b44`。
- 新增 Chat/HTTP/Web/Provider 测试已纳入默认 deterministic 门，防止“模块已合入但默认 CI 不执行”。

### 下一批生产接线顺序

1. 先在 `server.js` 接 Chat request admission 与 runtime claim，只迁 duplicate-before-interrupt、durable-before-spawn 两个守卫；保持 Claude/Codex runner 分离。
2. 再接 retry policy 与 post-turn effects；dispatch/outbox ack 必须有磁盘 delivery proof，任何 provider-route 失败都必须释放 running claim。
3. HTTP 路由按领域逐批迁到 `asyncRoute → DomainError → presenter`；先选 directory/memo/memory/upload，再迁 git/session/orchestration/provider/voice。每批保持 legacy 顶层 `error` 和现有兼容字段。
4. Web 继续迁 memo/通知/voice 共享 controller；在 inline handler 清理前不改 ESM。
5. 最后拆 `ChatWsController` 和剩余 Flutter God Screen。删除旧实现必须以 shadow/characterization/isolated HTTP 证据为前提，不做一次性大爆炸重写。

### 第三波（2026-07-18，已完成）

- `runChatTurn` 已接入 turn request normalization、duplicate-first admission 和短生命周期 preparation lease。只有用户消息写盘、Provider route、runtime claim 三项 proof 齐全后才交给 Claude streaming 或 Codex process runner；同步失败与早退都会释放 claim。retry、post-turn 和 runner finalize 暂未迁移。
- Claude 兼容不变量已锁定：duplicate 不分配原生 UUID；真正接纳的“已有历史、无 chat state、尚无原生 ID”请求仍按旧入口先分配 UUID，再按既有 resume 语义执行。Codex 断流续跑与 fresh retry 未改。
- Dashboard Memo 已迁入 `public/memo-controller.js`，`manage.js` 约 7,353→7,246（-107）；Memo 区域不再直接 fetch、拼 token query 或用 innerHTML 渲染会话。
- Chat 通知/提示音已迁入 `public/chat-notifications.js`，`chat.js` 约 5,557→5,417（-140）；错误通知保留 error 类型，通知跳转只白名单保留 session/cwd，Push toggle 串行化避免双击竞态。
- 两份新 Web 测试已纳入默认 security 门。完整 `npm test` 与 `test:integration:isolated` 通过。
- 本批为了明确 proof/lease 顺序，`server.js` 暂时净增长；下一批迁 retry/post-turn 时必须把 preparation composition 收进 `src/chat` host coordinator，不能继续在 God file 内堆状态机。

### 第四波（2026-07-18，已完成）

- Memo GET/PUT/send 已从 `server.js` 连续内联块迁入 `src/memo/{controller,file-port,router,index}.js`；Host 只注入 directories、sessions 和 runTurn port。`server.js` 12,634→12,588（-46）。
- Memo 首次成为 `src/http` 的生产 adopter：400/404/409 保持旧文本与状态，新增 413 `PAYLOAD_TOO_LARGE` 映射；所有 fs/内部/启动异常统一为带 requestId/code 的 `500 internal_error`，不返回原始路径、stack、stderr 或 token。
- Dashboard、Standalone `memo.html` 与 Chat popup 统一消费 `public/memo-controller.js` 的 client/controller/primitives。三端 Memo 直接 fetch/withToken/tokenQS 为 0；Host 重复代码共删除 191 行，生产文件合计净减 10 行。
- 完整 `npm test`、contracts/native 与 `test:integration:isolated` 全绿；新增 isolated Memo HTTP 测试使用临时数据目录和 fake runTurn，不启动 AI。
- 为兼容旧成功 DTO，GET/PUT 仍返回绝对 `path`；这是已接受的本地 authenticated UI 兼容风险。错误响应不得泄露路径，后续 API v2 可移除或改成逻辑文件名。

### 第五波前置修复（先于 retry/post-turn 接线）

只读生命周期审计发现三项 P0，不能直接把现有 retry/post-turn 替换成纯模块：

1. 多个 assistant 保存路径未检查 `appendChatMessage()` 返回值却置 `_resultSaved`，可能在结果未落盘时消费 handoff 或触发 dispatch/gateway/marker。
2. interrupted/API-error 安排 retry 后仍继续 post-turn，可能把部分输出提前回流并清除 dispatch lineage，最终完整结果反而不回流。
3. `_killReason`、`originDispatchId`、`_originTrigger` 属于 session 共享状态；stale proc/stream finalize 可把上一轮终止原因污染下一轮，retry 也会丢 dispatch/trigger lineage。

第五波必须先建立 turn-owned termination/lineage context 与 durable-result proof，修复上述排序，再 shadow 接入 retry decision，最后统一两处 post-turn effect 块。完成前禁止声称 retry/post-turn 已生产迁移。

## 大重构第五波实施结果（2026-07-18）

- Chat 生命周期安全已完成生产接线。新增 `src/chat/turn-lifecycle.js`，把 lineage、launch reason、runner identity、kill reason、result event、durable final proof、shutdown partial checkpoint、usage once claim 与 post-turn claim 从 session 共享字段中分离。
- Claude persistent stream 与 Codex process 仍保留各自 runner/finalize；两者只在“current turn + current runner + final 已写入 history + 无 kill/API/retry/handoff failure”时执行 handoff、dispatch、gateway、marker 与 trigger。append 失败可在 close/finalize 重试；双失败明确告警，不回流。
- 显式 `session_delete/relocate/cli_switch/shutdown/user_cancel/new_user_message` 不再进入 unknown-interruption auto-resume；只有无 kill reason 的真实未知断流可恢复。shutdown partial 以 runner-bound 内容 hash 防重，但永远不提升为 final durability。
- token usage 以 `token_usage.json` 原子写成功作为 authoritative commit；成功后才 claim once/broadcast，daily 仅作为派生 best-effort，主写失败保留 close/finalize 重试资格。
- Manage Memory 从 `manage.js` 整块迁出并继续拆成 `memory-model.js`（唯一 MultiCCApi/DTO 边界）、`memory-graph.js`（SVG/force layout）、`memory-controller.js`（tree/editor）。`manage.js` 7,246→6,511（-735），Memory 域直接 fetch/tokenQS 为 0。
- Memory 复审修复了两个数据损坏风险：超过 200,000 字符的旧文件改为明确只读预览并禁用保存；同路径 reopen 会废弃旧 save/delete 回包。Graph/Tree 加载失败可重试，invalidate 会停止旧 RAF 并在回到 tab 时重载。
- Flutter 首页任务滚动器迁入 `widgets/home_task_scroller.dart`，通过 `sessions/directories/liveStatusFor/onSessionTap` 四个显式输入与宿主交互，不依赖 `SessionManager`。`main_shell.dart` 3,268→2,975（-293）。
- 默认 security 门已纳入 Memory VM/竞态测试。联合验证包括 Chat lifecycle 25 项、core/orchestration 66 项、wait 35 项、Memory 9 项、security 78 项、architecture 22 项、isolated HTTP、Flutter 17 项。

### 第五波后的真实热点

| 文件 | 当前约行数 | 下一步 |
|---|---:|---|
| `server.js` | 12,772 | 本波为修复历史生命周期竞态净增长；下一批必须把已验证的 lifecycle bridge/runner host 下沉到 `src/chat` coordinator，禁止继续 inline 增长 |
| `public/manage.js` | 6,511 | 继续按 session/directory/bridge/settings 分域迁移到共享 client/controller |
| `public/chat.js` | 5,294 | 先抽 WS transport/state store，再迁 message composer host glue |
| `app/lib/screens/main_shell.dart` | 2,975 | 先抽拖拽协调器和 Workspace status port，再拆高耦合 `_DirectoryCard` |
| `app/lib/screens/chat_screen.dart` | 1,675 | 继续拆 header/config/share/state ownership |

保留风险：Memory DTO 为兼容 authenticated Dashboard 的“复制绝对路径”功能仍保留 `path`，远程已认证用户会看到本机目录结构；应在独立兼容批次改为 capability/config 或默认仅返回 `rel`。外部 dispatch delivery 仍不宣称 global exactly-once；本波只保证本进程 current/durable/once claim。

## 大重构第六波实施结果（2026-07-18）

- Chat 生产 host 已迁入 `src/chat/host-coordinator.js` 与 `host-runtime.js`。`server.js` 只注入 history、authoritative usage、broadcast、handoff 和 bus adapters；ownership、append/close finality、usage once、post-turn claim/plan 与 effect 映射不再在 God file 重复实现。
- Claude stream 与 process runner 的 finality 继续分离；stale runner、explicit kill、retry、append 双失败和 usage 主写失败均 fail-closed。同步 production plan 明确 `deliveryProven:false`，没有把 EventEmitter 异步 dispatch 伪装成 durable receipt；proof-aware adapter 暂未接线。
- 首个领域路由 `/api/scan/history` 已迁入 `src/routes/scan.js`，建立 `mount(app, deps)` 路由模板并保持旧 DTO/limit 语义。
- Web Chat 的 Provider/model/effort/native-agent/subagent 配置迁入 `public/chat-ai-config.js`。Provider/session transport 复用 `MultiCCApi`，Provider 数据先经过 catalog 白名单；`public/chat.js` 5,294→4,928（-366），classic-script 与全局兼容 delegate 保留。
- Flutter `_DirectoryCard` 迁入 `widgets/directory_card.dart`，使用不可变 ViewModel + callbacks，不直接依赖 `SessionManager`、`WorkspaceService`、Navigator 或祖先 State。`main_shell.dart` 约 2,976→2,403（约 -573）；宿主 `_DirectoryCardHost` 仍负责 manager/Workspace composition。
- 当前热点约为：`server.js` 12,760、`manage.js` 6,511、`chat.js` 4,928、`main_shell.dart` 2,403、`chat_screen.dart` 1,675。`server.js` 相对本波基线净减 46 行，关键收益是状态机所有权已经移出而非机械搬行。
- 验证：完整 `npm test`、`test:integration:isolated` 全绿；core 新门包含 Chat host 13 项与 scan route 3 项，security 83 项；Flutter 20/20，目标 analyze 0 issue，格式检查无变化。

### 第六波后的下一步

1. 把 process close 与 streaming finalize 的共同 effect/status 清理继续下沉，保留各 runner 的协议差异。
2. 用 orchestration outbox receipt 接 `reservePostTurn/deliverPostTurn`，在此之前继续明确 dispatch `deliveryProven:false`。
3. 按 scan 模板迁移 read-only/低依赖路由，再逐域接 `src/http` presenter；禁止一次性搬 100+ 路由。
4. Web 下一批拆 WS transport/history/rendering；Flutter 用共享 Dashboard Workspace store 替换每卡独立连接，再缩小 `_DirectoryCardHost`。

## 大重构第七波实施结果（2026-07-18）

- Chat 两类 runner 的共同收尾已经生产迁入 `src/chat/finalize-plan.js` 与 `finalize-host.js`。process close 和 streaming finalize 仍保留各自协议判断，但 assistant 持久化、authoritative usage、broadcast、分类、wait、状态和 post-turn effects 只通过一个注入式 executor 执行。
- Finalize 使用两阶段计划：先执行 append，取得真实 durable proof 后再解析后续 effects。append 失败、stale runner、显式 kill、retry、handoff failure 均 fail-closed；dispatch 仍明确 `deliveryProven:false`，没有虚构外部 exactly-once。
- `/api/server-info`、`/api/version-check`、`/api/apk-info` 已按 `mount(app, deps)` 模板迁入 `src/routes/system.js`，保持旧 DTO、缓存和失败降级语义。`server.js` 从本波基线约 12,760 行降至 12,532 行（-228）。
- Web Chat 的鉴权 bootstrap、一次性 WS ticket、凭据清理、连接生命周期、指数退避、stale connect 防护与 send guard 已迁入 `public/chat-transport.js`。HTTPS 页面拒绝降级到明文 `ws:`；`chat.js` 从 4,928 行降至 4,874 行（-54）。
- Flutter 新增 `DashboardWorkspaceStore`：每个 directory 只维护一个 `WorkspaceService`/snapshot，卡片与 fleet detail 共用不可变快照，directory 移除时统一 dispose。`main_shell.dart` 现为 2,399 行；下一阶段再把 sync side effect 从 build composition 移出。
- 默认测试门已包含 finalize plan/host、system routes 和 chat transport。完整 `npm test`、`test:integration:isolated`、Flutter 25/25、目标 analyze 0 issue、Node/Dart 格式与语法检查均通过。

### 第七波后的真实边界

1. `server.js` 仍有约 12.5k 行；下一批只迁低依赖 read-only 路由和 runner spawn/protocol glue，不能把 Claude stream 与 Codex process 强行合并。
2. Chat finalize 已统一 effect execution，但外部 dispatch durable receipt 尚未接 proof-aware outbox adapter；在接入前继续报告 at-least-once/未证明交付。
3. Web 下一批应拆 history/rendering state；Flutter 下一批应把 Workspace store 的同步触发移出 `build()`，并把 Flutter 端旧 WS token query 迁为短期 ticket。
4. `src/http` 仍只在少数领域生产接线；后续按 route group 小批迁移，不做一次性全入口替换。

## 大重构第八波实施结果（2026-07-19）

- 新增 `src/routes/host-read.js`，一次迁移 10 个低依赖只读端点：Push/VAPID、通知摘要、Tunnel/Funnel/IPv6、访问令牌状态、Proxy、官方 OAuth 与电源设置。`server.js` 相对本波基线净减约 90 行，当前约 12,444 行。
- HTTP 与 WebSocket 的本机免鉴权判断统一到 `src/request-locality.js`：只信任 socket peer，Host 必须为 loopback；任何 `Forwarded`、`X-Forwarded-*`、`X-Real-IP`、Via 或常见边缘代理头都会 fail-closed 为外部请求。隔离测试锁定本机直连可用、伪造/反代请求必须鉴权。
- Host read DTO 改成显式白名单：Bark/Webhook 仅暴露安全 origin 与占位符；Push endpoint 仅返回短 SHA-256 指纹；Tunnel/Power/Push 失败只返回稳定分类码，原始路径、URL、token 和底层错误统一进入安全错误边界。通知占位符回写会保留旧 secret，空串仍可显式清除。
- Web Chat 新增 `chat-history-store.js`，负责重连 reconcile、消息 ID 幂等更新、唯一 streaming tail、authoritative usage、分页 generation/requestId、cursor 失效与有界首屏补页。旧分页回包不能覆盖 clear/delete/reconnect 后的新状态。
- Assistant Markdown 统一经过 `safe-markdown.js` 与 DOMPurify 严格策略；禁止 SVG/MathML/style/form/iframe/object/embed、事件属性和危险协议。DOMPurify/marked 缺失或抛错时降级为转义纯文本，避免存储型 XSS 直接进入 DOM。
- `chat.js` 从本波基线约 4,874 行变为约 4,929 行（+55）。这是把历史状态移出后，为补齐重连一致性、分页竞态和安全渲染宿主接线产生的净增长；不能宣称 Chat God file 已缩小。下一批应把 DOM hydration/upsert 下沉到 `chat-history-view.js`，再删除宿主重复。
- Flutter 新增 `DashboardWorkspaceCoordinator`，把 manager listener、目录 reconcile、post-frame snapshot replay 与 dispose 从 `MainShell.build()` 剥离。`SessionManager.applyWorkspaceSnapshot()` 一次更新 waiting/running/status 且只通知一次；generation/source/identity 守卫阻止 manager 替换、目录删除后重建和迟到 callback 覆盖新状态。
- 联合验证：Host/Locality/History/Markdown 专项 34/34，Core 118/118 + Wait 35/35，Security 114/114，完整 deterministic/contracts/native 与全部 isolated integration 全绿；Flutter 37/37，改动文件 format clean。全 Flutter analyze 仅有 12 条既有 info，未出现在本波文件。

### 第八波后的真实边界

1. `server.js` 仍约 12.4k 行；下一批继续迁移 host settings 的写端点与低依赖 route group，并逐批接入 `src/http`，禁止一次搬迁所有路由。
2. Web Markdown sanitizer 仍从固定版本 CDN 加载且没有本地 vendored/SRI；断网时安全降级为纯文本，但完整 Markdown 能力不可用。应在后续依赖治理批次 vendoring 或补 SRI/同源资产。
3. 跨客户端清空历史仍缺服务端广播；当前本地 clear/delete 正确失效分页请求，但其他已连接客户端只能在下一次 authoritative history/reconnect 时收敛。
4. dispatch 外部 delivery 仍未接可信 outbox receipt，继续报告 `deliveryProven:false`；Flutter 端旧 WebSocket token-query 也仍需独立迁移，不能和本波生命周期抽取混为已完成。

## 大重构第九波实施结果（2026-07-19）

- 新增 `src/routes/host-write.js`，把通知、Tunnel 配置/重启/Funnel、访问令牌、Proxy、官方 OAuth 和 macOS 电源共 8 个写端点从 `server.js` 迁出。Host 只注入环境文件、运行态 setter、Tunnel/Push/Power 与安全日志/指标端口；`server.js` 当前约 12,385 行，相对第八波约 12,444 行净减 59 行。
- 写路径采用 persist-before-live；运行态发布失败会补偿磁盘和内存。补偿失败只记录固定阶段分类，并通过 bounded `consistency { degraded, dirty, reason, lastFailureAt }` 暴露，不返回路径、stderr 或 secret。Tunnel 数值、Funnel 端口、通知 URL、ACCESS_TOKEN 的 CR/LF/NUL 都有 fail-closed 校验；普通 Tunnel 配置不再伪造 Funnel 执行态。
- Web Chat 新增 `chat-history-view.js`，统一持有 history hydration/upsert、分页 DOM、tool cards 与 streaming tail。`chat.js` 在合并“首次强制设置密码”门槛后约 4,973→4,717（-256）；跨客户端 `chat_history_reset` 会广播最新权威页、失效旧 cursor，并保留每页 5 条的最新主线策略。
- DOMPurify 3.2.6 已以同源 vendored 资产、许可证和可校验 provenance 纳入 `public/vendor/dompurify/`，Chat 不再依赖 DOMPurify CDN。Markdown 唯一 HTML sink 必须经过 `safe-markdown`；parser/sanitizer 缺失或异常时降级为纯文本。Marked 与 highlight.js 仍是 CDN 依赖，但不会绕过 sanitizer。
- Flutter 新增 `WsTicketClient/WsTicketConnectionGate`。Chat、Workspace、Terminal 与 Voice TTS 每次连接/重连都通过同源 REST header 换取 path-bound、一次性 ticket；长期 token 不再出现在 WebSocket URL。generation gate 阻止迟到 ticket 覆盖新连接，错误对象不保留 token、ticket 或响应正文。Aux 没有独立 Flutter WebSocket，仍复用 Workspace 事件；Voice STT 保持 REST multipart。
- 联合验收：Host read/write/locality 37/37，Core 139/139 + Wait 35/35，Security 124/124，完整 `npm test`、contracts/native 与全套 isolated integration 通过；Flutter 48/48、7 个目标文件 analyze 0 issue、format clean。最终工作区已再次 rebase 到 `main=4d66ec9` 后复验相关 58 项。

### 第九波后的真实边界

1. `server.js` 仍约 12.4k 行，下一批继续以低依赖 route group 小步迁移；优先 settings/voice/files 的窄 controller，不做一次性 route 搬迁。
2. Web 历史 DOM 所有权已收口，但 `chat.js` 仍包含消息发送、工具交互和部分 WS event glue；后续应先抽 event controller，再考虑 ESM，不能破坏 classic-script 加载顺序。
3. Flutter WebSocket 长 token 已清理，但 REST 仍按现有 `X-Access-Token` 契约工作；ticket 只是短期 WebSocket admission，不应被误用为通用 API token。
4. dispatch 外部 delivery 仍没有全局 exactly-once 证明，继续保持 `deliveryProven:false`；本波没有扩大该语义。
5. 历史备份/APK/fixtures 等治理项仍需独立 cleanup 变更和 owner 审核。本轮没有删除任何历史代码或制品。

## 大重构第十波实施结果（2026-07-19）

- 新增默认架构闸门 `scripts/check-source-line-budget.js`：第一方源码默认不超过 3,000 行且不超过 240,000 bytes；长期 reviewed exception 最高 5,000 行。现有 `server.js/manage.js/chat.js` 只是显式迁移债务，ceiling 精确等于当前大小；任何回涨，或缩小后不在同一提交下调 ceiling，都会失败。该检查已进入 `test:architecture`，不能靠压缩多条语句到一行绕过。
- Voice REST/settings 从 `server.js` 迁到 515 行的 `src/routes/voice.js`，覆盖 refine/feedback/confirm/progress/vocab/STT/settings/SSE 共 10 个端点。Host 只注入 upload、Aux、ASR/TTS/Voice 和环境持久化端口；`server.js` 在合入最新 sync 提示后现约 12,016 行，相对本波新基线净移出约 370 行。
- Voice settings 使用可补偿事务：`persist → ASR → TTS → process.env → voice`，任何阶段失败按已尝试阶段逆序恢复。补偿失败只上报固定 stage/category，并暴露 bounded consistency；成功 DTO、upload middleware 顺序、Local-ASR→Cloud fallback 与 SSE cleanup 保持兼容。
- Manage 抽出 `manage-bridges.js`（867 行）和 `manage-host-settings.js`（537 行），`manage.js` 约 6,512→5,221（-1,291）。五个 Bridge/Gateway、Push/通知/密码/Proxy/OAuth/Tunnel/重启/APK 的 classic-script 全局入口保持；三类 SSE 使用 generation + owned timer，stop 后旧 timer 不能复活连接。
- Manage Git 提交树移除旧 HTML 字符串/`innerHTML` sink，repo path、error、hash、date、author、subject、refs 全部通过 DOM + `textContent`；外部 Git 元数据不能注入 HTML。新 Manage 模块没有凭据 query、跨域 fetch 或 `innerHTML`。
- Chat 抽出 `chat-composer.js`（759 行），接管 send/cancel、Slash、键盘/触控、附件/图片、录音/STT、流式语音与原生桥；`chat.js` 约 4,718→4,087（-631）。流式语音 ticket/start 使用 generation：双击共用 pending 请求，cancel/stop 会使迟到 ticket 失效，stale 候选不能开启或覆盖麦克风实例。
- 对抗审查发现并推动修复了 4 个 Major：Bridge stop 后复活、Voice ticket 竞态、Voice 热应用半提交、Git author/error XSS。修复后 Voice 17 项、Composer 10 项、Manage 6 项及联合 Core/Security/Architecture 均通过；最终完整矩阵以本节提交记录为准。

### 第十波后的行数债务与下一步

| 文件 | 当前约行数 | 强制目标 | 下一切片 |
|---|---:|---:|---|
| `server.js` | 12,016 | 3,000 | files/upload/push/aux/goal/provider routes；随后拆 WS/runner composition，协议 runner 保持分离 |
| `public/manage.js` | 5,221 | 3,000 | session/directory lifecycle 与 dashboard card/controller；下一波先降到 5,000 以下 |
| `public/chat.js` | 4,087 | 3,000 | WS event glue、工具交互和剩余 modal/controller；保留 transport/history/composer 所有权 |

Flutter `main_shell.dart` 约 2.4k、`chat_screen.dart` 约 1.7k，已进入常规 2k–3k 预算；第三方 minified/generated 资产按精确 reviewed exception 管理，不与第一方 God file 混淆。当前目标尚未完成，以上三笔 debt 不能被描述为永久 5k 例外。

## 大重构第十一波实施结果（2026-07-19）

- `src/routes/aux-goal.js` 接管 AuxQueue、Aux Provider/模型配置、9 个 Aux/Goal 路由与 Goal 规则；`server.js` 从预算口径 12,016 降至 11,522（-494）。对抗审查修复了拆分后遗漏导出的 `AUX_HISTORY_MAX`、Aux WS stale client、cancel 后错误污染 health，以及原始 Provider/path/secret 错误进入 REST/WS/history/log 的问题。
- `public/manage-session-lifecycle.js` 接管会话创建、Provider/模型、Agent preset、角色与命名配置；`manage.js` 从 5,221 降至 4,569（-652），正式低于 5,000。请求统一走 `MultiCCApi`，Provider 只消费 catalog 白名单。对抗审查将模型/角色/名称 mutation owner 分离，避免不同字段并发时吞掉真实成功响应，并收口 modal/preset 迟到 continuation。
- `public/chat-event-controller.js` 与 `public/chat-live-ui.js` 接管 WS/Claude/Codex 流式事件、工具结果、usage/timing、任务弹幕、Thinking、断线提示与安全弹窗；`chat.js` 从 4,087 降至 2,998（-1,089），已退出迁移债务并受默认 3,000 行/240KB 硬闸门约束。
- Chat generation 从 transport 贯通到 event controller；missing/stale generation 在 debug、DOM 与 state 变化前 fail-closed。原始 error/token/path 不进入诊断日志；新模块不创建网络连接、不拼 token query、不使用 `innerHTML`，Markdown 仍只有 DOMPurify 安全边界。
- 新增 Aux/Goal、Manage lifecycle、Chat event/live UI 的确定性测试并纳入默认 core/security 门；line-budget 已 ratchet 为 `server.js=11,522`、`manage.js=4,569`，Chat debt 已删除。

### 第十一波后的真实边界

1. `server.js` 仍有 11.5k 行；下一批继续迁 files/upload/push/provider route groups，再拆 WS 与 runner composition。Claude streaming 与 Codex process finality 继续保持两个协议边界。
2. `manage.js` 仍有 4.6k 行；下一批优先 directory lifecycle、dashboard card/controller 与共享 Git diff/preset renderer，目标直接进入 3,000。
3. `chat.js` 已达预算，但与 Manage 仍存在 Git diff/preset 展示的跨文件重复；应抽共享安全 renderer，不能为减少行数重新引入 HTML 字符串 sink。
4. Token 只读审计确认全局 Codex fork 首累计快照重复计算约 47.65 亿；该问题属于独立统计修复，不在本波重构中偷偷修改。缓存读取占校正总量约 97.57%，UI 主指标还需单独调整口径。
