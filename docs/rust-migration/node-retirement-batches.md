# Node 后端分批搬迁计划

盘点基线为 `main` 的 `c1be57b5`。聊天核心 `src/chat/` 有 68 个 JS 文件、14,352 行。加上 `src/session-work/` 和 `src/task-shell/` 后为 100 个文件、21,697 行。整个 `server.js` 和 `src/` 的 JS 源码为 607 个文件、136,103 行。数字按物理行统计，包含注释和桥接代码。

`--no-node` 已独立跑通受支持的 Claude 回合，以及已登记任务的计划工作区物化、领取和完成。当前兼容启动路径仍经聊天桥交给 `node server.js` 执行。任务壳 HTTP 已由 Rust 匹配路由，部分操作仍经 `/api/__host/task-shell` 调用 Node。服务是否仍依赖 Node，要看操作最终由谁执行。 [聊天验收记录](ws-chat-native-runtime.md) · [网关聊天入口](../../native/gateway/src/ws_chat.rs) · [任务壳 HTTP 入口](../../native/gateway/src/app/task_shell.rs)

## 批次与依赖

每批按业务边界搬迁。Rust 接管状态读取、事务与副作用，HTTP、WebSocket、内部调用和重启恢复全部切到同一所有者。删除清单随切换交付，旧实现作为测试对照时只放在测试路径。正式切换跟随部署范围，安装包与生产配置的切换安排在最终收口。

| 顺序 | 整块范围 | 交付和删除边界 |
| --- | --- | --- |
| 1 | 会话问答 | 搬迁问题事件、状态初始化、等待与恢复、回答与撤销、重连回放。目标删除五个专用 JS 文件和专用 HTTP 宿主操作，具体见下文。 |
| 2 | 任务壳与工作投递 | 接管空壳登记、新任务身份、跨会话、引用与依赖、收据重试、调度执行与恢复。现有 Rust 收据、调度和写者许可事务继续使用。接齐关系、操作、归因、分离及上下文的调用方后，删除 `src/task-shell/runtime.js`、`src/task-shell/host.js`、`src/task-shell/routes.js` 与 `src/routes/task-shell-host.js`，并移除 `/api/__host/task-shell`。任务队列的恢复、定时与后台消费者一并切换后，删除 `src/session-work/scheduler.js`，包括任务板的冻结原因调用。 |
| 3 | Provider 路由与 CLI 执行 | 复用 Rust Auto Provider 和回合内核，补齐跨 CLI、账号及凭据决策、重试边界和各已支持 CLI 的适配。用相同的启动、流、停止和凭据隔离契约替换 Node 执行侧。按 CLI 关掉对应的 Node 常驻流和适配模块，可先用已有原生执行器的 Claude 验证共享契约，再接 Codex 和其他在册线路。 |
| 4 | 聊天回合和会话宿主 | 依赖第 1–3 批。把回合收尾、后台任务通告、历史、状态订阅及其它仍持有会话的入口切到 Rust。迁掉 `server.js` 与 `src/routes/server-core-host.js` 的 `chatSessionsOwner` 消费点，再删除 `src/chat/turn-engine.js`、`src/chat/sessions.js` 和聊天专用桥。第 2 批遗留的回合相关接线随 `src/session-work/host.js` 一并退出。 |
| 5 | 聊天以外的生产后端 | 依照运行时台账，把每个仍访问 Node 的域连同宿主事实来源和后台进程一起移交。盘点 HTTP 中间件、文件与 SSE、终端/工作区与其它 WS、管理与账号、自动化、插件和渠道。以当前源码隔离重抓默认及条件配置，逐域删除 Express 路由和 `/api/__host/*` 操作。 |
| 6 | 启动、包与进程清除 | 第 4、5 批全部验收后，让 npm 启动入口、`multicc`、独立安装包与桌面宿主调用同一个 Rust 服务。删除 `server.js`、网关的 Node 子进程监督与转发、后端运行所需的 npm 依赖和对应打包接线。验证完整包在无 Node 的环境中可以安装、启动和升级。 |

构建工具、测试夹具、前端 JS 和 Electron 客户端的 Node 用途按现有项目边界单独统计。外部 CLI 和插件按实际执行路径区分。产品为了服务请求而启动的 Node 进程仍计入退出验收。必要的 SDK 或 Electron 适配须逐项记录调用方、保留范围和替换条件。 [总计划](../backend-rust-exit-plan.md) · [Node 运行时登记台账](../backend-runtime-inventory.md)

## 首批实施范围

首批从问答开始。Rust 编排仓储已经实现 `sessionWorkQuestion` 的事务和快照规则。问答事务、事件帧、旧记录首次导入与状态裁决使用同一套 Rust 规则。兼容模式从宿主取得活跃回合、外部等待和分类结果，并通过有序仓储调用提交。原生模式由网关提供作用域限制在单个 Claude 回合的 MCP 入口。 [Rust 事务](../../native/core/src/orchestration_store/session_work_state.rs) · [原生问答接线](../../native/gateway/src/ws_chat_native/question.rs)

1. **事务与状态事实。** 复用编排库目前的 schema、版本及旧记录初始化规则。建立类型化的 Rust 问答操作，覆盖记录、读快照、开始回合、回答、撤销、移交和恢复。用会话、任务、回合和请求身份核对旧帧与并发回答。若兼容回合仍由 Node 启动，由其在回合事件边界传递身份；Rust 在有序队列内核对并更新持久事实。
2. **消费点和线协议。** 把 CLI 问题事件、提示生成、wait 事件、队列等待、任务壳回答及取消、撤销 HTTP 和 WebSocket 重连接到同一 Rust 操作。复用 `native/gateway/src/ws_chat_native/` 的连接与回放顺序。保证持久化后才发出可见问题；解决与撤销加入同一连接的回放窗口，活帧、重连帧和关闭顺序均有对照。
3. **删除入口。** 首批整文件删除目标为下表五项，共 549 个现有物理行。迁出问答信号规范化、提示模板、事件帧和撤销、恢复裁决。兼容入口保留 JS 宿主传输、回调和分类投影。待聊天宿主与会话调度完全由 Rust 驱动后，移除 `--node` 下的 `user-input-dismiss` 宿主操作及其共享接线。

| 首批整文件删除目标 | 当前职责 |
| --- | --- |
| `src/classify/user-input-host.js` | 抽取 CLI 问题、生成提示及兼容定义 |
| `src/classify/user-input-owned-host.js` | 同步/异步投影、事件与宿主回调 |
| `src/session-work/question-owner.js` | 调用 Rust 问答事务、旧记录初始化 |
| `src/session-work/production-question-host.js` | 在 `server.js` 中组装问答、工作与回合活跃事实 |
| `src/chat/question-input-bridge.js` | 适配器问题落盘协调和 WS 初始化回放屏障 |

首批验收包括新问题与重连、并发或重发回答只接受一次、过期回合拒绝、取消与回答交错、跨会话移交、关闭后恢复、底层写失败时保留错误原因。兼容回归使用 `tests/test-production-question-owner.js`、`tests/test-session-work-host.js`、`tests/test-session-work-scheduler.js`、`tests/test-chat-ws-conformance.js` 和相关 task shell 套件。隔离端到端扩充现有 `native/gateway/tests/ws_chat.rs`，覆盖 `--no-node` 的真实入口。所有删除目标都要通过生产调用方审计，剩余的测试引用迁入保存的对照夹具。

在 `--no-node` 下，Claude 通过回合专属的回环 MCP 入口发问。普通会话沿用消息 ID 做重发去重，任务壳沿用 SQLite 收据与调度准入事务；回答同时关联请求与回合。HTTP 撤销沿用统一鉴权和执行槽屏蔽。五个旧生产文件已删除。尚由 Node 持有回合的 CLI 与会话继续走兼容宿主，兼容入口委托同一 Rust 仓储。

## 第二批进度

工作树已经接通空壳登记、会话归属、壳视图和游标比较并交换。原生网关在 `--no-node` 下直接处理打开、查看、游标选择和引用追踪 HTTP 接口。兼容宿主调用同一 Rust 仓储。登记和归属在一个事务中写入，归属冲突回滚新壳。

WebSocket 从壳内会话按游标向同壳的已登记执行投递。预约收据时重新检查任务归属、工作区和控制身份，重复提交回放原收据。引用快照的构造、摘要校验和追踪在 Rust 执行，越界会话与损坏快照均被拒绝。

2026-11-20 追加接通以下四条链路。

- 首次物化由 `materializePlannedWorktree` 在 Rust 工作线程执行，Node 仓库 actor 继续提供调用期间的仓库租约。原生网关复用同一个 `worktree_sync::materialize_planned`，核对分支、目录和 Git common dir 后激活写者。
- 引用的摘要、快照、裁剪、校验、呈现和首次注入使用 Rust 所有者。版本化快照保留原始 UTF-16 语义，损坏摘要拒绝注入。兼容调用通过共享原生适配器访问，实际注入的快照 ID 写入收据。
- HTTP 普通投递、固定任务投递和收据重试在原生模式使用持久收据、统一调度准入和写者许可。兼容模式的调用分派及投递步骤推进已迁入 Rust，Node 依次执行宿主端口。失败后修复配置并重启可使用原收据重试，接受过的消息重放原结果。语音重试复用持久载荷和指纹。
- 网关启动时执行 Rust 的恢复准备、版本校验和恢复事务，后台队列可以在没有 WebSocket 客户端连接时继续消费。兼容 JSON 草稿的恢复同样调用 Rust 转移内核，事件的缺省属性还原也由原生适配器执行。

本轮整文件删除如下，物理行按 `splitlines()` 统计。

| 已删除文件 | 原有行数 |
| --- | --- |
| `src/task-shell/routes.js` | 48 |
| `src/routes/task-shell-host.js` | 210 |
| `src/task-shell/context.js` | 68 |
| `src/session-work/recovery-transport.js` | 17 |

四个文件合计删除 343 行，包含调用方和桥接改动的 `src/**/*.js` 后端净减 653 行。Rust、回归测试和迁移登记另行计入仓库总增量。

验证包含 `cargo build --workspace`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test -p multicc-gateway --test ws_chat --test task_shell`、`npm run test:task-shells` 与现有 HTTP 差分。网关 WebSocket 31/31、任务壳 HTTP 13/13、npm 任务壳 304/304、任务与工作区 517/517、调度、问答、投递及访问控制定向 260/260 通过。已完成的 HTTP 对拍为 67/67，副作用序列一致。新增回归覆盖空壳幂等和身份冲突回滚、跨会话投递、引用追踪与损坏摘要、首次物化与真实 Provider 输入、HTTP 重发和修复后重试、控制取消和持久问答、无客户端的启动恢复及再次重启去重。隔离 Claude 执行路径的进程树内 Node 数为 0。

补测保留语音在 4000 个 UTF-16 单元处截断 emoji 的行为。原始载荷在收据状态更新和重试投递之间保持不变，指纹沿用首次持久值；旧库通用读取仍保持原有宽松解码口径。两个断言共同通过，未放宽孤立代理项的迁移断言。原始红证、最终日志、产物校验及合并收据保存在主仓 `data/rust-migration/2026-11-20/task-shell-batch2-343455fc/`，其中 `receipt.json` 记录最终提交、基线、合并和每条验收命令的退出码。

第二批整体仍有任务关系、归属操作、分离、独立继续和定时消费者的接线待退出。`src/task-shell/runtime.js`、`src/task-shell/host.js`、`src/session-work/scheduler.js` 继续承接现有 CLI 回合、进程内会话记录、广播及这些任务操作的兼容接线。保留范围由当前 Node CLI 宿主和尚待迁移的操作决定，后续批次迁走这些调用方后再整文件删除，并移除兼容端口 `/api/__host/task-shell`。本轮零 Node 隔离验收覆盖现有原生 Claude 路径与新增任务壳 HTTP 路径，其他 CLI 的执行适配继续列入第三批。

## 第三批进度

2026-11-21 从 `b20db311` 重新盘点。服务端源码、启动器与插件后端候选共 612 个 JS/CJS/MJS 文件、139,099 个物理行，静态可从 `server.js` 到达 595 个。完整文件、行数、条件入口说明和静态调用方见 [迁移前文件清单](node-runtime-files-batch3.md)。Node 依赖包、前端、Electron 客户端及测试夹具不混入该计数。

先完成以下三个独立模块；每个模块均独立通过工作区构建、严格 Clippy、整个 gateway 包测试、任务壳套件、HTTP 逐字节对拍及无 Node 隔离验收后提交。

| 模块 | Rust 所有者及消费点 | 退出的生产文件 | 原行数 |
| --- | --- | --- | ---: |
| 物理尝试准备 | `native/addon/src/provider_invocation.rs` 推进路由解析、模型、复用指纹、证明及失败清理；复用 core 的身份与预算规则，所有调用方通过共享原生入口访问 | `src/chat/provider-invocation.js` | 226 |
| 选择身份 | 直接调用已有 Rust 选择键所有者，删除中间专用桥，迁完四个生产消费点 | `src/chat/auto-provider-selection-key.js` | 10 |
| 续跑交接 | `native/core/src/auto_provider_handoff.rs` 与 addon 同名适配器持有去重、容量与清理状态，裁决异步入队和日志异常 | `src/chat/auto-provider-handoff.js` | 91 |
| Claude 执行适配 | `native/addon/src/claude_adapter.rs` 负责终端参数、SDK 参数与事件解码；`native/core/src/claude_adapter.rs` 在工作线程清理历史，兼容 SDK 和原生网关均等待清理后启动子进程 | `src/cli-adapters/claude.js` | 138 |

四个专用生产文件合计 465 行，连同调用方改动，`src/**/*.js` 后端净减 409 行。冻结旧实现只留在测试夹具。各模块的运行日志、字节对拍、原始失败证明、产物和提交收据保存在主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/module1`、`module2`、`module3`。

物理尝试定向回归 165/165，交接定向 83/83，Claude 定向 108/108、流回归 50/50；每个模块的全 gateway 包均为 1,036 项通过，任务壳 304/304、HTTP 67/67 且副作用顺序一致。四份原生 Claude 隔离进程树内 Node 数均为 0。新增故障对拍覆盖模型列表 getter、证明失败清理、异步入队 getter、日志异常、并发去重、容量淘汰和 UTF-16；原生聊天还用子进程启动检查确认历史已完成清理，并继续验证多轮、重连与取消。

必要的 Node 范围为 `src/native/runtime.js` 中闭包、Promise 等待和现有 CLI/SDK 回调传输；回调接通当前会话宿主，Rust 负责上述模块的决定和状态。尚未迁出的 Provider 路由端口、账号与凭据装配、Codex/其它 CLI 进程协议及 Node 会话宿主继续列入第三、四批，不能据此宣称第三批整体完成。下一步接 Codex 执行链路，SDK 或平台专用端口随各消费点迁移逐项退出。

### Codex 子批：执行适配、后台状态与原生进程桥

继续完成四个模块，每个模块通过指定门禁后单独提交。

| 模块 | 提交 | Rust 所有者 | 退出的生产文件 | 原行数 | 后端净减行数 |
| --- | --- | --- | --- | ---: | ---: |
| Codex JSON 执行适配 | `ba828f58` | `native/addon/src/codex_adapter.rs` 及 `codex_adapter/events.rs` | `src/cli-adapters/codex.js` | 366 | 344 |
| Codex app-server 适配状态 | `11a76fdc` | `native/addon/src/codex_app_adapter.rs` 及其事件、调用子模块 | `src/cli-adapters/codex-exp.js` | 265 | 242 |
| 子线程后台事件和定时决策 | `8c49fa53` | `native/core/src/codex_background.rs`，addon 接入同一所有者 | `src/cli-adapters/codex-background-events.cjs` | 275 | 246 |
| Codex app-server 进程桥 | `e0bdb521` | `native/gateway/src/codex_bridge.rs`，复用上述后台所有者 | `src/cli-adapters/codex-app-server-bridge.cjs` | 343 | 340 |

本子批退出四个文件、1,249 个原物理行，后端净减 1,172 行。与先前三个模块合计，第三批已退出八个专用生产文件、1,714 个原物理行；新增和修改兼容接线后，后端 JS/CJS/MJS 累计净减 **1,581 行**。同一盘点口径剩余 **604 个文件、137,518 行**。Rust、冻结对照夹具和测试的新增行不混入后端减行数。迁移后的逐文件清单保存在主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/node-files-after-codex-sub-batch.json`。

默认 Codex app-server 调用现在启动相邻预编译产物中的 `multicc-gateway codex-app-bridge`。该模式不监听 HTTP、不启动 Node；通过 JSON-RPC 管道执行 initialize、线程创建及恢复、串行多轮、审批拒绝、请求超时、信号及 EOF 回收。后台子线程隔离、接入、进度节流、心跳和终态也由 Rust 决定。适配器中的增量去重、思考文本和按回合用量状态由 Rust 持有，保留数字、字符串、NaN、缺省和不透明对象键的区分，并在完成时释放状态槽。

Node 仍只在 `src/native/runtime.js` 提供闭包、SDK 端口、定时器和异步回调传输。调用者显式传入 `deps.bridge` 时，保留原有自定义 Node 桥覆盖；这是现有测试和自定义传输端口的兼容范围，默认路径不使用它。该覆盖端口统一采用 Rust 可执行接口后可以移除。Codex 会话常驻宿主 `src/chat/codex-app-stream.js`、账号和凭据装配以及其它 CLI 线路继续保留在后续迁移清单。

模块四、五、六的 gateway 包分别为 1,036 项通过；模块七增加 RPC 超时和孤立 UTF-16 单元线协议检查后为 1,038 项通过。各模块任务壳均为 304/304、HTTP 原始字节对拍 67/67 且副作用顺序一致；构建及严格 Clippy 通过。定向回归分别为 87、120、30、112 项通过。冻结旧桥的八个场景直接对比 stdout、stderr、退出码及 RPC 原始字节，无动态字段归一化。真实 Codex 连接本地模拟模型上游，通过两个子线程执行及独立完成验证，没有使用真实账号或外部模型请求。

当时验收覆盖四份 `--no-node` Claude 网关进程树和 Codex 原生桥的两轮执行，进程树内 Node 数均为 0。Codex 桥还在无法解析 Node 的 PATH 下启动。`/ws/chat` 的独立验收见后续 Codex 原生聊天条目。

本轮逐项审计的允许差异为：默认启动命令由 Node+CJS 改为 Rust 子命令；回合中显式切换线程排到前一回合结束之后，防止恢复操作提前改变主线程身份；原生管道错误日志保留系统原因，运行时堆栈文本可以不同。线程切换、等待 RPC 时关闭 stdin、关闭输出管道后的子进程回收均有专门断言。普通与恢复协议的八个冻结对拍场景，以及 HTTP 67 个场景，仍要求逐字节相同。

合并前复验重复检出了订阅缓存测试超时。已用先前主线网关产物复现同一失败，路由、缓存实现和原测试断言均与主线一致。根因是并行夹具仅用进程号与系统时间戳命名目录；本机时间戳会重复，夹具互相清理目录。新增四线程、4,000 次目录名生成回归，旧实现只产生 965 个唯一目录而失败；改为额外附加原子序号后，回归和两个原订阅测试 3/3 通过，未修改原断开连接断言。此测试修复独立于生产迁移，最终 gateway 包增加到 1,039 项。原始超时、主线产物对照、碰撞红证和修复日志均保存在 `codex-sub-batch` 证据目录。

合并前组合自动回归为 375/375，CLI 适配契约为 29/29。扩展组合时误纳入的 `tests/test-chat-stream.js` 是需要真实 Claude 的手工账号探针，因 `spawn claude ENOENT` 失败；原文件未改，未产生供应商请求，失败另存 `manual-claude-probe-result.json`，未将其计作自动门禁通过。自动组合继续使用既有隔离流测试。严格 Clippy 初次检出的代码写法问题已修正，未增加 lint 豁免。各模块及最终复验的构建产物、日志和收据保存在主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/module4` 至 `module7`、`codex-sub-batch`。

第三批整体继续进行。下一块仍须迁移 Provider 账号及凭据决策、Codex 会话宿主和其余在册 CLI 执行链路。`src/task-shell/runtime.js`（712 行）、`src/task-shell/host.js`（553 行）、`src/session-work/scheduler.js`（908 行）仍由这些宿主和第四批会话状态消费；本轮没有删除它们，也没有把它们计入减行数。

### Codex 凭据装配

`native/core/src/codex_provider_home.rs` 接管直连凭据来源选择、私有文件原子写入、旧版配置的 `env_key` 补全，以及官方 OAuth 启动目录与尝试目录的凭据清理。官方路由的托管校验和 `OPENAI_*` 环境键筛选在 Rust addon 执行。常驻 Codex 用同一份尝试目录的 OAuth 状态清理实际子进程环境，首次启动和复用均覆盖。官方路由清理失败时阻止启动，避免回退到环境里的其它登录。

相对本轮基线 `dd1d43d6`，删除 `src/codex/proxy-policy.js`（32 行），生产 Node 代码净减 83 行。定向验证覆盖常驻路由的官方子代理、清理失败、旧版直连导入，以及宿主登录与 Provider 凭据的分流。七组直连配置与认证文件对拍一致，包含 CRLF、文件权限及启动环境。对应网关、addon、构建日志、任务壳 HTTP 逐字节对拍和隔离进程树记录位于 `data/rust-migration/2026-11-21/provider-cli-batch3/module8`。

工作树验证通过 `cargo build --workspace`、严格 Clippy、gateway 1,039 项、任务壳 304 项、定向回归 197 项、子代理 8 项和任务壳 HTTP 67 项。四份原生回合的网关进程树内 Node 数均为 0。同步端口最多读取 16 MiB 的配置或认证文件，并拒绝非普通文件。

兼容宿主保留同步 N-API 接线、会话和尝试目录的生命周期，以及 npm CPR 的角色与代理配置写入。这些调用仍由现有 Codex 常驻宿主使用，待原生 `/ws/chat` 接管、配置和历史回放完成对拍后继续迁移。凭据装配子批在 `41aa3356` 合入，变基后的验收记录位于 `data/rust-migration/2026-11-21/provider-cli-batch3/module8-post-rebase`。

### Codex 原生聊天

`--no-node` 的 `/ws/chat` 已接管未绑定托管 Provider 的 `codex-exp` 会话。Rust 网关通过原生 app-server 桥发送消息，在放行提示词前持久化已确认的线程 ID，并处理增量、使用量、取消和启动失败。恢复要求 app-server 确认同一个线程。原生线程缺失时返回原始原因并保留已保存的 ID。Rust 网关通过关闭桥接输入结束回合，并等待子进程退出。

这一入口的运行进程树已退出 Node WebSocket 桥和 `src/chat/codex-app-stream.js` 的调用路径。带 Node 的兼容启动继续使用原宿主，继续承接托管 Provider、标准 `codex` 和其余 Codex 会话能力。本阶段的 Node 生产文件删除数与净减行数均为 0。

工作树验证覆盖多轮、网关重启后的线程恢复、重连回放、取消后的进程回收、旧线程缺失及上游错误。隔离 app-server 夹具的进程树内 Node 数为 0。构建、严格 Clippy、网关 1,040 项、WebSocket 定向 32 项、任务壳 304 项、桥接与凭据兼容 63 项、任务壳 HTTP 字节对拍 67 项通过。证据位于 `data/rust-migration/2026-11-21/provider-cli-batch3/codex-native-ws`。

### 固定托管 Provider 与标准 Codex

`--no-node` 的 `/ws/chat` 接入标准 `codex exec` 及固定托管 Provider。原生进程解析与持久化线程 ID，支持同线程续轮、连接恢复和取消。固定托管线路由 Rust 解析配置并创建回环代理，CLI 使用仅用于该回合的路由凭据，上游凭据保留在代理内，响应写回 CLI 前脱敏。

标准 Codex 对累积快照计算逐回合用量，使用线程私有基线防止重复累加，旧历史按回合投影。Web 和 Flutter 依赖的即时发送 ACK、状态通知、单个结果帧、模型归属、用量、时间线和历史回放均有针对性断言。两种 CLI 的首轮与重连已进行 4 组原始帧采集及逐字段契约对拍。直发时 Node 生成的临时任务及投递状态、重复广播、运行时标识与时间戳的裁定保存在主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/codex-managed-ws/wire-contract`。

原生托管线路支持固定 Provider。多候选自动路由、旧有 rollout 根目录迁移与手动切换时的 rollout 同步仍由带 Node 的兼容路径承担。本批退出这些原生入口上的兼容宿主调用，生产 Node 文件删除数和净减行数均为 0。

### Codex 配额窗口

`native/core/src/usage_limit_poll.rs` 统一按周期长度识别 Codex 的 5 小时、每周和每月窗口，计算重置时间，并根据利用率最高的窗口决定配额提示。Rust 网关、手动刷新和后台轮询共用这份规则。删除 `src/codex/rate-limit-windows.js`（73 行），本模块生产 Node 代码净减 96 行。

手动刷新和主动轮询沿用现有 Node 账号读取及请求回调，经 N-API 传入已解析的响应和观测时间。后续这些请求和凭据生命周期迁入 Rust 时，移除对应接线。工作树验证包括 45 项兼容回归、5 项网关适配定向回归、严格 Clippy，以及 1,445 组输入的 2,890 次旧版 JSON 字节对拍。证据位于主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/codex-rate-limit-windows`。下一模块处理 Codex 会话目录扫描，先把启动与配置调用接到异步边界。

### 会话配置切换的异步目录准备

Codex 配置切换复用 Rust 的 rollout 查找、歧义判断和原子复制，在 addon 工作线程完成准备后才进入会话持久化同步事务。配置准备与回合启动共用互斥槽，提交前重新核对会话身份、配置和忙状态，过期准备返回 409。同步事务内只执行已确认的路由变更。

强制删除 Provider 的引用收集、逐会话解绑计划、手动回退和响应判定由 Rust 分步接口持有。兼容宿主执行回调，等待 Promise 落地后再提交响应进行判定，并在异步期间出现新引用时阻止删除。批量迁移会话同样按顺序等待异步 PATCH。Node 的最小保留范围为进程内会话表、既有验证与广播、Promise 和回调传输。会话配置所有权接入原生宿主后可移除这部分接线。

会话路由字节对拍曾出现 12 项 OPTIONS 返回 503。单条请求在同一二进制和端口先返回 503，兼容宿主启动后返回 200，确认 harness 在前门健康检查通过后过早启动语料。补充会话守卫就绪检查后，响应与副作用顺序均为 126/126 一致。原始失败、主线复现、单条请求和修复后记录位于主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/codex-profile-scan`，组合门禁位于 `codex-profile-scan-gates`。后续继续迁移 `src/codex/session-home.js` 的启动和重试调用边界。

### Claude 启动配置覆盖

删除 `src/providers/claude-settings-override.js`（86 行），配置环境键筛选、缺失路由键清空、会话文件名生成、私有目录与原子写入迁入 `native/addon/src/claude_settings_override.rs`。沿用共享 Rust `state_file` 写入器，保持文件 0600、目录 0700，以及 Provider 切换后重写配置的行为。生产 Node 代码净减 76 行。

现有回合引擎与 Provider 宿主仍在 Node，因此 `src/native/runtime.js` 暂留同步 N-API 调用和家目录路径适配。Rust 通过 N-API 访问 V8 的 live 值、`encodeURIComponent` 与 `JSON.stringify`，以保留 getter 异常、键顺序、`toJSON`、孤立 UTF-16 代理项及非 JSON 值语义；未在 Node 增加配置业务规则。调用方迁入原生宿主后可删除这段兼容接线。

冻结对照 `tests/helpers/legacy-claude-settings-override.js` 来自 `5ec8703f`。仓库差分测试覆盖 540 组输入的环境投影、文件名、JSON 字节和权限，另验证 getter 访问顺序、异常对象身份及序列化失败保留原文件。完整门禁与合并收据保存在主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/claude-settings-override-gates/`。兼容测试使用项目锁定的 SDK 0.3.325 oracle；首次自动发现本机 0.3.317 的失败日志保留，未放宽环境字节断言。

### OpenCode 进程错误优先级

删除 `src/cli-adapters/opencode-error.js`（12 行），优先保留实际 RPC 原因、仅在 `agent_exited` 或缺失原因时检查原始 stderr 的选择规则迁入 `native/addon/src/opencode_error.rs`。分类器继续使用既有 Rust core 实现，宿主只保留两行 N-API 与原有有界元数据分类回调接线；未增加 Node 业务规则。事件宿主与元数据适配迁入 Rust 后可一并删除回调。该小模块生产 Node 代码净减 10 行。

冻结对照来自 `ae728cb3` 的原模块，只调整 helper 内的 require 相对路径。256 组输入验证错误形状、stderr 形状、其它 CLI 和继承属性；单独断言 getter 短路、异常对象身份、分类器只调用一次、两个回调参数同一对象及原始 stderr 对象身份。构建、测试及合并证据记录在主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/opencode-process-error-gates/`。

### 进程启动参数排序

删除 `src/chat/process-spawn-args.js`（15 行），参数可迭代对象的复制、`--settings` 与提示词分隔符排序、原始 payload 追加迁入 `native/addon/src/process_spawn_args.rs`。回合引擎仅更换导入，`src/native/runtime.js` 保留一行 N-API 调用；生产 Node 代码净减 14 行。回合宿主迁入 Rust 后删除该桥。V8 的 live iterable、数组方法和异常仍经 N-API 访问，保留参数对象与 payload 身份，不引入 JSON 编解码。

冻结旧模块的 384 组组合检查 argv 值与序列化字节，另验证自定义迭代器和 getter 顺序、异常身份、不修改输入以及非可迭代参数失败。完整构建、严格静态、回归与 HTTP 对拍证据记录在主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/process-spawn-args-gates/`。

约定门禁通过后补跑标准 `npm test`，在未修改的 `tests/test-fleet-sharing-routes.js` 两项共享并发检查失败（249 行创建结果未全部为 200；514 行访问次数耗尽后的 410 数量为 0、预期 4）。另建目标分支 `bf99c686` 的干净、独立工作树，仅运行该测试文件，使用与该基线源码指纹匹配的旧原生产物，57.707 秒后同两断言、同值失败；测试文件哈希一致，基线不含本批 Rust 模块且保留旧 Node 文件。按用户明确授权将其登记为基线既有／环境失败后交付 argv 小批。完整 `npm test` 仍为失败，未放宽断言、未声称已修复共享并发根因。复现及对比记录在上述证据目录的 `baseline-diagnosis/`。

### 已迁移会话 ID 规则的旧副本

`src/chat/native-session-state.js` 的生产消费者只剩 `turn-engine.js` 的未使用导入。实际事件路径已经由 `chatApplyAdapterEvent` 进入 `native/addon/src/chat_events.rs::accept_session_id`，并使用 core 的 `capture_session_id` 完成 fresh/resume 判定、严格赋值和持久化接线。本批删除该 27 行 Node 模块及一行闲置导入，生产 Node 净减 28 行，不增加任何兼容桥或 Rust 业务副本。

原件完整冻结到 `tests/helpers/legacy-native-session-state.js`，仅供旧事件 reducer 和底层协议测试作独立 oracle；真实路径的差分测试继续直接调用 Rust 的 `chatApplyAdapterEvent`。既有用例覆盖 fresh 替换、resume ID 不匹配及事件／副作用顺序。验证和收据记录在主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/native-session-state-gates/`。

本批定向 57 项通过，缺少真实 Claude 捕获文件的一项按原条件跳过。首次并行 Rust 全量遇到 `subagent_defaults` 夹具 `EADDRINUSE`，同一测试隔离通过，再完整串行复跑 2730 项通过；未修改断言。其余约定门禁、HTTP 字节对拍和无 Node 冒烟通过。标准 `npm test` 仍只有上节已由干净基线确认的两项共享并发失败，同断言同值；共享实现及测试夹具未变，原失败记录及基线例外继续保留，未记作全绿。

### 闲置的聊天端口声明

删除 `src/chat/ports.js`（24 行）及聚合导出的一行，生产 Node 净减 25 行。该模块的 `CHAT_TURN_PORTS` 与 `assertChatTurnPorts` 只有聚合导出和模块自身测试引用，服务端解构、其他业务代码和插件均未消费；不增加替代业务实现或兼容桥。删除测试中仅针对该已删除接口的示例断言，仍保留同一用例对其余七个聊天核心模块的 I/O 依赖检查。完整验证及收据存放在主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/chat-ports-gates/`。

首次后台验证因 detached 宿主的 `umask 077` 使 Cargo 产物保留 0700，被现有打包可执行权限检查拒绝，导致三项 remote-screen 安全夹具失败。验证 runner 改为 `umask 022`，并仅对新构建的来源和复制品规范可执行文件 0755、addon 0644；原失败及诊断记录保留，未改断言或跳过原三项测试。完整重建复验的其余 23 道门禁均通过，HTTP 字节对拍为 67/67、126/126、203/203，无 Node 启动冒烟通过。标准 `npm test` 仍 exit 1，仅有上述两项共享并发基线失败，去除耗时及工作树路径后，完整断言报告与干净 `bf99c686` 基线逐字一致。其后被 `&&` 短路的 npm 阶段不记为通过；完整日志、独立门禁、权限与对拍明细保存在 `permission-fixed-rerun/`。

## 每批验收与最后停用条件

- 先冻结旧版输出和状态变化。覆盖默认与条件入口，对比 WebSocket 原始帧、HTTP/SSE 响应、事务写入以及副作用顺序。对必须变化的字段逐项登记。补充关键失败的断言，变异验证须区分编译失败与行为被检出。
- 用当前源码重建网关和需要的 addon，单批做定向回归，交付前对比 `main` 的已知失败。生产切换前跑 `cargo fmt --check`、严格 Clippy、Rust 工作区测试、Node 兼容、安全、状态、契约、架构与治理套件，以及网关和安装包相关回归。隔离数据夹具覆盖旧版 schema、事务中断重试和重启。
- 每批记录运行时还剩哪些 Node 入口。最后逐项核销默认挂载、条件挂载、动态插件、HTTP 宿主端口、WS/SSE 入口和后台工作者。`scripts/capture-backend-routes.js` 的默认隔离快照须配合条件配置和协议验收。
- 最终用实际发布入口启动隔离包，检查无 Node 可执行路径、无 Node 后端子进程、完整功能路径成功、进程树和监听端口可核验。用隔离副本演练升级和回退，先核对现有格式能否继续被旧版本读取，再确定恢复方式。验证通过的版本记录独立启动命令和用户手动切换流程。
