# multicc 大文件模块化拆分路线图

> 目标：把 5 个巨型文件**无损**拆成模块，不改运行时行为。
> 原则：分批、小步、每批走「设计文档 → 测试设计 → 代码修改 → 验证」四步循环。
> 创建：2026-07-12。本文件是后续所有批次的总纲，每批完成后在此追加进度。

---

## 1. 现状基线（2026-07-12 勘察）

| 文件 | 行数 | 结构概要 |
|---|---|---|
| `server.js` | **11219** | 117 路由（GET 63 + POST 54 + 其他）+ 252 个顶层函数；已把 20+ 模块拆到 `src/`，残留路由 handler + 大块业务逻辑（WS/classify/dispatch-gateway/push/cron） |
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
- `tests/test.js`（auto-detects `:3000`）、`tests/smoke-core.js`（14 个核心 API 场景）、`tests/test-cross-cli-dispatch.js`（跨 CLI 分派边界，54 pass/8 skip）。
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
| B1 | server.js 首个领域（scan.js）跑通 mount | ⬜ | | |
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

### 第四波建议

1. 先迁 Memo HTTP 三条路由到 `asyncRoute → DomainError → presenter`，消除原始 `e.message` 路径泄漏；同时让 `memo.html` 与 Chat 内 Memo 复用同一 controller，结束三套实现。
2. 再把 retry policy 和 post-turn effect 接入生产，并将 preparation composition 从 `server.js` 下沉到可注入 coordinator。
3. 完成上述两项后再拆 Chat WS controller；Flutter God Screen 作为独立批次，避免与 Web/host 热点交叉。
