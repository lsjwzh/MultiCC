# Node 后端剩余面逐簇台账（2026-11-19，128 条路由 / 26 层中间件）

机器可读底稿：`docs/rust-migration/node-surface-ledger.json`。对账命令：

```bash
node scripts/capture-backend-routes.js     # 重新捕获（会覆盖 docs/backend-runtime-inventory.md，先备份比对）
node scripts/check-node-surface-ledger.js  # 台账与捕获逐簇、逐层对账；漂移即非零退出
node tests/test-node-surface-ledger.js     # 对账器自身的 6 种漂移用例
```

捕获基线：**128 条路由注册、26 层中间件/路由器**。2026-11-19 `static-and-apk` 簇清零（`/multicc.apk` 迁入前门，判定走既有宿主端口 op，公开注册 -1）且版本化 HTML 与 `express.static` 两层中间件随 `static_web_root` 退役，129/31 → 128/29；同日 `/artifacts` 双 root 的三层中间件（headers + 两个 serveStatic）随前门 `artifacts.rs` 退役（见 docs/gateway.md §62），128/29 → 128/26；2026-11-18 `air-sync` 两条迁入前门（复用既有宿主端口），131 → 129。更早：2026-11-16 `GET /api/channels` 迁入前门 132 → 131，`plugins-core` 的 `/api/channels/recheck` 与 `/plugins/:id/*` 迁入前门后 -2、宿主端口 +1，133 → 132；当日第一次捕获是 139/32（指纹 `3b8663bf…`），静态簇迁走 3 条路由与 1 层中间件后为 136/31；`server-core` 簇迁入前门后 4 条公开路由消失、宿主端口 +1，为 133/31；同批 `cli-switch` 的 `switch-cli` 迁入前门后公开路由 -1、宿主端口 +1，总数仍为 133/31。中间件以「名字@挂载#序号」为键对账，不以位置号为键。

## 1. 「驱动到零」应当怎么读

128 不是一类东西，直接归零既不可能也不应该：

| 终态 | 条数 | 含义 | 能否归零 |
|---|---:|---|---|
| 宿主端口（`/api/__host/*`） | 35 | 路由本体已在前门，Node 只剩回环接口，提供 Node 独有事实或执行进程/文件副作用 | **不能，也不应**。这是迁移的目标形态；每迁一个簇这里 +1 |
| 插件（`plugins/**`） | 71 | 5 个 IM bridge（wechat-ilink 15、feishu/telegram/discord/slack 各 12）+ cron 8，属可独立发布的插件代码 | 不在核心后端迁移范围 |
| 状态已在 Rust | 6 | `src/cli/tools-host.js`：作业表、互斥、日志环、缓存、响应策略都在 `RustCliToolsRuntime`，Node 只 spawn/kill/probe | 注册上移需先决定网关是否持有子进程 |
| 驻留 Node | 16 | 持有子进程、长连接、内存句柄或浏览器会话 | 须先拆出「状态/规则」与「句柄执行」两层 |

所以真正的衡量不是 128→0，而是**驻留 Node 的 16 条逐簇转成「状态在 Rust + Node 执行器」**。

## 2. 路由簇台账（16 条驻留 Node + 6 条状态在 Rust）

| 簇 | 条数 | 终态 | 阻塞点 / 下一步 |
|---|---:|---|---|
| `server-core`（`/healthz` `/readyz` `/metrics` `/api/repo-operations/:id`） | 0 | 已迁前门 | 2026-11-16 四条公开路由迁入 `native/gateway/src/app/server_core.rs`，Node 只剩宿主端口 `src/routes/server-core-host.js`（并入「宿主端口」一行）。`multicc_active_turns` 改由 `owner.chatActiveTurns(streamBusyFn)` 在宿主端口内计数，Node 不再遍历 `chatSessions` |
| `static-and-apk`（`/multicc.apk`） | 0 | 已迁前门 | 2026-11-19 清零：`/multicc.apk` 由前门认领，判定（本地文件/302/裸 404 no-store）经既有 `release-history` 宿主端口的 `apk-download` op 取宿主决策，`fellThrough` 由前门按退休链续走守卫 → `static_web_root` 发文件 → 转发；版本化 HTML 与 `express.static(public/)` 同批迁入 `native/gateway/src/app/static_web_root.rs`（规则 `multicc_core::static_web`），真实 app 不再注册任何静态处理器。`src/routes/static-assets.js` 只剩 `serveHtml` 薄桥（share 页用，重写规则经原生模块调唯一源 `version_html`）；差分三条套件全绿（见 docs/gateway.md §61） |
| `plugins-core`（`/api/plugins*` `/api/channels*`） | 8 | 驻留 Node | `channelHost`/`installer`/`catalog` 是 Node 实例。`/api/channels`、`/api/channels/recheck` 与 `/plugins/:id/*` 已迁入 Rust 前门；相关事实通过既有 `src/routes/plugins-host.js` 提供。插件文件的静态扩展名按共用的 `http_entry::public_path` 免登录（见 route-inventory.md） |
| `cli-tools`（`/api/cli/*`） | 6 | 状态在 Rust | 已是目标形态。前门接管须网关持有子进程，与「无状态 L7」冲突，保持 |
| `cli-switch`（`switch-cli`） | 0 | 已迁前门 | 2026-11-16 迁入 `native/gateway/src/app/cli_switch.rs`，Node 只剩宿主端口 `src/routes/cli-switch-host.js`（并入「宿主端口」一行）。入口闸门在前门内直接调 `multicc_core::cli_switch_runtime::plan("manualGate")` 判掉：会话不存在 404、`aux`/`gateway` 系统会话 400、非 chat 会话 400、cli 不在支持表 400，外加 `taskExecutionSlot` 内部槽 404（早于 OPTIONS 与 body 解析）——这些分支零 Node 往返，差分实测 7/7 只调 `facts`。过闸后的 `noop`/`switch` 交 Node 执行器：`switch` 必须一次往返跑完（`signature` 与 `preparations` 是跨 `await` 的 TOCTOU 保护，拆开就破）。忙判定已走 Rust 规则 `native/core/src/active_turns.rs` |
| `oauth-login`（`zcode/kimi` login） | 2 | 驻留 Node | 阻塞最多 5 分钟并持有登录子进程，前门已原样转发 |
| `session-bundle`（`bundle.zip` `import-zip`） | 2 | 驻留 Node | 流式 zip 与 multipart，依赖 `persistedSessions` |
| `provider-proxy`（`/codex-proxy/...responses`） | 2 | 驻留 Node | SSE 透传经 Rust CPR。守卫依赖每轮 attempt 能力令牌授权与 CPR 观测钩子，**不读** `chatSessions`/`persistedSessions`（实测 0 处）。前置=attempt 能力表落 Rust |
| `air-sync`（`/api/air/sync` `/api/air/page`） | 0 | 已迁前门 | 2026-11-18 两条迁入前门（`air-sync-runtime.js` 的 `mount()` 已删），快照经既有 `/api/__host/air` 宿主端口的 `sync`/`page` op 提供（见 docs/gateway.md §60） |
| `router-tools`（`router-tools/:tool` `voice/stt`） | 2 | 驻留 Node | 仅回环；音频上传 |

Node 内存态与剩余路由的真实依赖（逐文件 grep 核实，不是推断）：

| 内存态 | 实际引用方（引用次数） | 卡住的簇 |
|---|---|---|
| `chatSessions` | `src/cli/switch-runtime.js`（7，均在宿主端口背后）、`src/cli/tools-host.js`（1，`activeLanes`） | 已不再卡住任何簇。`server-core` 的 activeTurns 走宿主端口的 `owner.chatActiveTurns(streamBusyFn)`，`cli-switch` 的忙判定走 `native/core/src/active_turns.rs`；两簇都已迁前门。剩 `cli-tools` 的一处事实 |
| `persistedSessions` | `server.js`（102）、`src/routes/session-bundle.js`（5） | `session-bundle` |
| attempt 能力令牌表 | `src/providers/proxy-guard.js`（`authorizeProxyRequest*`） | `provider-proxy`、`providerProxyGuard` ×2 |
| WS/下载 ticket `Map` | `auth.js` 的 Node 适配器 | `admission-adapters` |

`plugins-core`、`router-tools`、`air-sync`、`static-and-apk` 四个簇实测**不**引用 `chatSessions`/`persistedSessions`，所以它们的阻塞点不是会话表，而是各自的 Node 实例。**不引用会话表不等于可以只迁 HTTP 两条**，逐个核实后的结论：

- `air-sync`：**已迁**（2026-11-18）。此前判断「不可单独迁」是因为两条 HTTP 与 WebSocket `attach` 共享串行队列与「重放到实时」交接屏障；落地时的解法是 HTTP 读取仍经宿主端口拿同一运行时的快照，屏障与客户端表留在 Node，公开路径由前门认领。
- `static-and-apk`：**已迁**（2026-11-19，见上）。
- `plugins-core`：`/api/channels`、`/api/channels/recheck` 与 `/plugins/:id/*` 已迁走，其余 8 条依赖 `channelHost`/`installer`/`catalog` 实例，需先拆「状态/规则」与「进程/文件执行」两层。
- `router-tools`：`/api/internal/router-tools/:tool` 仅回环，`/api/voice/stt` 是音频上传，未评估。

## 3. 中间件台账（29 层，逐层对账）

| 组 | 层 | 终态 |
|---|---:|---|
| `request-shaping`（query、expressInit、requestId、jsonCompression） | 4 | 随 Node 自发 JSON 响应数下降退役；前门 `app/express.rs` 已有等价实现 |
| `admission-adapters`（`/api` shutdown、peer、auth 三个 gate） | 3 | 规则唯一源是 Rust admission owner，Node 只是适配器（`src/routes/auth.js:124-132`）；登录/exchange/ws-ticket 在 gateway child 下不注册。仅当不再有不经前门直达 Node 的入口时才能删 |
| `session-and-proxy-guards`（publicSessionAccessGuard ×2、providerProxyGuard ×2） | 4 | publicSessionAccessGuard 依赖会话归属；providerProxyGuard 依赖 attempt 能力令牌表。留 Node 直到对应表落 Rust |
| `protocol-proxy-mounts`（/claude-proxy、/codex-proxy、unmatched） | 3 | CPR 协议代理入口，SSE 不可在此 gzip |
| `machines-and-parsers`（machines 跨站拦截 + raw/json 局部解析 + 全局 `express.json(50mb)`） | 4 | 随承载它们的 Node 路由一并退役 |
| `static-and-artifacts`（voice-gateway web） | 1 | artifacts 双 root 三层（headers + 两个 serveStatic）已于 2026-11-19 随前门 `artifacts.rs` 退役（docs/gateway.md §62）；versioned-HTML 与 `express.static` 两层同日随 `static_web_root` 退役；apk/ipa 路径守卫那一层已于 2026-11-16 迁入前门。只剩 voice-gateway web |
| `bridges-and-remote`（IM bridge router ×5、remote-screen） | 6 | 插件/远控 |
| `terminal-error`（safeErrorHandler） | 1 | 必须最后一个，Node 路由归零时才能删 |

## 4. 与既有台账的订正

- `docs/rust-migration/route-inventory.md` §7 前置件 16 写「`valid_provider_id` ①-④可进 Rust、⑤需要 store 事实与协议表」。**实际** ①-④ 规则与 ⑤ 的编排早已在 addon（`native/addon/src/provider_registry.rs` 的 `provider_validate_id`），8 个消费点共用同一个函数实例（`server.js:1609/1655/2205` 转发到 `providerRoutes.validProviderId`）。剩下留在 JS 的是 ⑤ 依赖的规则表（协议兼容表、车道→池映射、`providerSupportsCli`），本批收入 `multicc_core`。
- 此前口径的 187 处是源码里 `app.<verb>('路径')` 字面量数，包含未挂载与测试夹具；139 是真实启动后的运行时注册数，以后以 139 这个口径为准。

## 5. 前门对 Node 事实的依赖结构（2026-11-16 实测）

数据来源：扫描 `native/gateway/src/app/*.rs` 中是否调用 `host_port`，以及各模块调用的 `/api/__host/*` 端口。

- 前门共 57 个路由模块（新增 `plugins`）。**18 个纯 Rust**（零 `host_port` 调用）：`accept`、`account_subscription`、`auth`、`claude_models`、`download`、`external_workspaces`、`provider_balance_panels`、`provider_catalog_view`、`provider_limit_history`、`quota_guard`、`run_config_presets`、`scoped_auth`、`service_transport`、`services`、`source_workspaces`、`static_assets_routes`、`token_usage_global`、`uploads`。
- **37 个经宿主端口**，约占前门路由代码的 77.6%（25396 / 32732 行；上一次量是 36 个 / 24767 / 32078 行）。最大的几个是 `session_git`（2022 行）、`providers`（1839 行，22 个 op）、`directory_routes`（1547 行）、`task_shell`（1386 行）、`session_admin`（1335 行）、`docs_memory_routes`（1289 行）。
- 没有杠杆点：任一宿主端口最多只被 2 个模块共用（`provider-balance`、`secrets-vault`），其余每个端口只服务 1 个模块。37 个模块背后的 Node 事实互相独立，所以这是 37 次逐簇迁移，不能靠一次共用改造批量完成。

由此得到的边界，请后续批次按它排期，不要把它当成一个批次的工作量：

1. 鉴权运行态（前门自持）是唯一一个解锁面横跨所有簇的前置件，因为 `--no-node` 下它决定需鉴权的 Rust 路由能否应答。它不会让 36 个宿主端口簇脱离 Node。
2. 37 个宿主端口簇各自要把 Node 独有事实（会话表、provider 存储、任务板句柄、各类运行时实例）迁成 Rust 持有，才能删掉对应宿主端口。已知的跨簇危险见 `docs/backend-rust-exit-plan.md` 与记忆中的任务板 Proxy 镜像、会话表迁移条目。
3. 插件 71 条属于可独立发布、签名升级的插件代码（本文件第 1 节），不并入核心后端迁移；把它们搬进 Rust 会破坏插件的独立发布模型。
4. 本节是依赖结构的实测，不是工作量估计；没有给出时间或人天数字，因为没有测量过。

2026-11-19 更新：`static_web_root` 模块加入前门（public/ 静态与版本化 HTML，纯 Rust、零 `host_port` 调用；`/multicc.apk` 的判定经既有 `release-history` 宿主端口），本节 §5 的模块计数为 2026-11-16 口径，未重测。
