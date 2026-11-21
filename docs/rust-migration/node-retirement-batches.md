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

### ZCode 会话身份与旧桥接标记修复

删除 `src/cli-adapters/zcode-session.js`（29 行），原生会话 ID 和已知错误标记判定迁入 `native/core/src/zcode_session.rs`，状态修复由 N-API 直接读取、严格赋值于宿主原对象。仅清空已证实的旧桥接标记，保留未知厂商 ID、其他 CLI、历史与配置；每次读取 `cliStates` 的顺序、setter 副作用与部分写入后的异常沿用旧行为。三个消费点仅更换导入，生产 Node 净减 27 行。

Node 事件和 CLI 切换宿主暂留两行原生调用桥；不增加业务规则、JSON 拷贝或扫描。桥接子进程原先已通过 background-hold 使用相同原生模块；本批继续验证其首次启动、resident/legacy、取消与独立宿主启动恢复。待对应进程和状态宿主迁入 Rust 后删除这两行。冻结 `7e57fd99` 原模块作为测试 oracle，新增完整 UTF-16 单字符后缀及 1,600 组状态字节对拍，并检查类型短路、代理与重入、异常身份和严格赋值失败。门禁日志及收据位于主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/zcode-session-gates/`。

完整 26 道门禁中，其余 25 道退出码为 0：包括串行 Rust 2,732 项、ZCode 定向 59 项、隔离启动重复恢复、严格 Clippy、安全、HTTP 字节对拍 67/67、126/126、203/203 和无 Node 启动冒烟。标准 `npm test` 仍 exit 1，仅复现上述两项共享并发基线失败；完整断言报告去除耗时与工作树路径后与干净 `bf99c686` 基线逐字一致，后续被短路的 npm 阶段不记为通过。runner 继续使用 `umask 022` 和来源产物权限规范，原三项 remote-screen 安全测试完整通过，未放宽断言。

### 模型请求预算的宿主参数提取

删除 `src/chat/model-request-policy.js`（22 行），会话 effort、路由模式、环境预算键的读取顺序、BigInt 十进制传递及结果冻结迁入现有 Rust addon 模块。继续调用同一 core 超时规则，不改变计时器或代理请求生命周期。生产入口在 `src/native/runtime.js` 的 Provider invocation 装配处；仅保留一行 N-API 调用和默认宿主环境适配，生产 Node 净减 20 行。请求宿主移入 Rust 后删除该调用桥。

旧 wrapper 冻结为测试 oracle，仅调整 native/runtime 的相对路径；Provider invocation 冻结夹具仍保留原始文本与哈希，通过测试专用 require 接线读取该 oracle。新增 1,024 组值与 JSON 字节对拍，以及惰性 getter、代理、重入、原异常身份、非法宿主形状和冻结结果检查。启动探针新增原生入口必需条件，保留旧预算接口缺失检查，并增加新入口缺失时拒绝启动的断言。完整门禁及收据位于主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/model-request-policy-gates/`。

完整 28 道门禁中，其余 27 道退出码为 0，包括串行 Rust 2,732 项、模型预算与调用装配定向 64 项、启动来源探针 15 项、严格 Clippy、安全、三组 HTTP 字节对拍与无 Node 启动冒烟。标准 `npm test` 仍 exit 1，仅复现上述两项共享并发基线失败，完整归一化断言报告与干净 `bf99c686` 基线逐字一致；被短路的后续 npm 阶段不记为通过。runner 的 `umask 022`、来源及复制品权限有独立记录，原三项 remote-screen 安全用例完整通过，未改断言。

### 模型流进度读取回调

删除 `src/providers/model-stream-progress.js`（12 行），读取回调和每个 reader 的状态生命周期迁入现有 Rust addon，继续使用同一 core SSE 解码器与进度判定。Rust 调用当前宿主的 `Buffer.from` 保留非字符串输入的转换与异常，转换完成后才借用可变状态，允许 `valueOf` 在转换过程中重入。传输字节与代理请求生命周期不变；Node 仅保留一行工厂调用桥，生产 Node 净减 11 行。代理响应宿主迁入 Rust 后可删除该桥及宿主 Buffer 适配。

原 wrapper 冻结为独立 oracle，仅调整 native/runtime 相对路径。新增所有 UTF-8 切分点与混合 chunk 类型对拍、超长帧和 reader 隔离、Buffer 转换及异常身份、转换时重入和异常后的状态连续性检查；独立带 GC 的子进程同时验证旧、新 callback 与自引用环可回收且不保活进程。启动探针保留旧解码器缺失断言，并增加新工厂缺失时拒绝启动的检查。完整门禁及收据位于主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/model-stream-progress-gates/`。

首次构建因遗漏 `ToNapiValue` trait 导入触发 E0599，原始日志和停止收据保留。补齐导入及格式化后，只有该 Rust 文件变化，测试未改；在 `trait-import-rerun/` 完整复验 28 道门禁，其余 27 道退出码为 0，包括串行 Rust 2,732 项、定向 68 项、来源启动探针 15 项、三组 HTTP 字节对拍与无 Node 启动冒烟。标准 `npm test` 仍 exit 1，仅有上述两项共享并发基线失败，完整归一化断言报告与干净 `bf99c686` 基线逐字一致。后续被短路的 npm 阶段不记为通过；`umask 022` 和来源及复制品权限规范继续生效，原三项 remote-screen 安全测试完整通过。

### ZCode 引擎路径与内置配置环境

删除 `src/cli-adapters/zcode-engine.js`（33 行），默认引擎位置和脚本后缀规则迁入 Rust core；候选路径、内置配置文件的单次 metadata 探测、环境短路与复制迁入 Rust addon。四个生产消费点仅更换导入，生产 Node 净减 27 行。宿主仅保留惰性的默认值 getter、路径原语和环境输入的 N-API 接线；不扫描目录，保留现有同步启动契约。CLI 与进程启动宿主移入 Rust 后可删除该接线。

构建脚本不加载 CLI 命令解析器，公开启动器先构建、探测原生模块，再创建宿主子进程；默认引擎读取继续保持惰性。冻结旧模块作为独立 oracle，新增 72 组候选参数差分，以及文件、目录、符号链接、缺失路径、UTF-16 路径字节、环境对象身份、属性顺序、代理、getter 与异常短路检查。启动探针要求四个新入口均存在，旧检查与断言保留。完整门禁及收据位于主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/zcode-engine-gates/`。

完整复验 29 道门禁，其余 28 道退出码为 0，包括串行 Rust 2,734 项、ZCode 定向 63 项、模型流定向 68 项、来源启动探针 15 项、命令解析、三组 HTTP 字节对拍与无 Node 启动冒烟。标准 `npm test` 仍 exit 1，仅有上述第 249、514 行两项共享并发基线失败，完整归一化断言报告与干净 `bf99c686` 基线逐字一致；被短路的后续 npm 阶段不记为通过。已逐项核对全部日志、独立门禁记录及哈希，归档三组 HTTP 详情；继续保留 `umask 022`、来源及复制品可执行文件 0755、addon 0644，原三项 remote-screen 安全用例均通过。整体 Node 后端清零尚未完成，服务未重启。

### CLI 适配器注册、回退与停用规则

删除 `src/cli-adapters/core.js`（34 行），注册过滤、必需方法校验、重复名称替换、默认回退和 Gemini 停用规则迁入 Rust addon，生产 Node 净减 22 行。冻结旧模块作为无生产依赖的独立 oracle；差分覆盖 170 组查找、对象及 Symbol 键、属性顺序、快照与查找隔离、getter、迭代器关闭、同步重入、异常身份，以及已停用适配器的冻结与共享身份。子进程检查保留的查找闭包、引用环回收与自然退出。

Node 仅保留现有原生模块的惰性实例引用与调用闭包；Rust 通过宿主 Map 原语保留任意键及适配器身份，注册表状态由 JavaScript 引擎追踪，避免原生强引用形成不可回收的适配器环。原生工厂只持有不捕获宿主值的停用适配器，不持有各注册表。CLI 宿主整体迁出后可移除这段实例与回调接线。启动探针要求工厂及 `create`、`resolve` 两个方法齐备；旧门禁与断言保留，另加注册表定向门禁。证据目录为主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/cli-provider-registry-gates/`，不能据此宣称整体 Node 后端清零。

首次严格 Clippy 因新增的未使用 `JsValue` 导入失败；仅移除该导入后通过，但完整复验在 `state` 的隔离服务就绪检查失败。原失败日志与收据均保留，首次启动失败的根因未确定，不将它列为基线例外。夹具现把子进程、stdout/stderr 和退出状态传给原等待器，并在失败时将诊断持久保存到临时数据目录之外；断言、超时、就绪条件和清理逻辑均保持原样。受控子进程以 23 退出时，原测试仍以 1 退出，两个输出流和状态完整保存为 0600 日志，证明该修正只增加可观测性。

最终在 `state-fixture-rerun/` 完整执行 30 道门禁，29 道退出码为 0，包括串行 Rust 2,734 项、注册表/ACP 定向 21 项、来源探针 15 项、原隔离 SIGTERM 与开放 WebSocket 检查、三组 HTTP 字节对拍及无 Node 启动冒烟。标准 `npm test` 仍 exit 1，仅有上述第 249、514 行两项共享并发基线失败，完整归一化断言报告与干净 `bf99c686` 基线逐字一致；被短路的后续 npm 阶段不记为通过。全部日志、独立记录、哈希及 HTTP 详情已核对归档。继续保留 `umask 022`、来源与复制品可执行文件 0755、addon 0644，原三项 remote-screen 安全用例均通过。整体 Node 后端清零尚未完成，服务未重启。

### 任务壳容量入口与共享上限

删除 `src/task-shell/capacity.js`（9 行），生产 Node 净减 4 行。目录任务上限 1024 由 Rust task-domain 的单一常量提供，任务仓储及无状态容量规则共用；原生 addon 负责选择现有 `store.rule` 或 `taskDomain` 端口，保留两次 getter 读取、回调接收者、原始返回值和异常身份。Node 只保留常量 getter、现有任务规则宿主端口及调用接线，任务壳宿主整体迁出后即可移除。

旧入口冻结为独立 oracle，仅调整测试中的导入路径。新增 80 组 0/1/1023/1024/1025 边界与目录类型差分、规则返回值身份、惰性访问、重入、变化的 getter 和 JSON 失败检查；现有创建第 1024 个任务及拒绝第 1025 个任务的断言原样保留。启动探针要求两个新原生入口齐备。容量检查点 rebase 到 `483f5062` 无冲突，补丁与已验证备份逐字一致，恢复引用与原补丁均保留。

首次完整门禁在 Rust 关闭测试超时，原始日志与线程采样保留；单独限时复现确认阻塞来自测试日志回调中的 `Condvar::wait_while`，不是生产关闭代码或 Node 就绪诊断夹具。仅修改该 Rust 测试：日志回调以有界缓冲非阻塞入队，子进程退出后才将日志刷入 `MULTICC_TEST_DIAGNOSTICS_DIR` 下的 0600 文件；关闭完成唤醒检查及退出通知、状态和 PID 断言继续验证清理顺序。生产关闭代码不变。修后单项和整个 18 项 `remote_child` 目标通过，完整门禁中的同一关闭测试也通过。

最终在 `shutdown-fix-rerun/` 完整执行 31 道门禁，其余 30 道退出码为 0，包括串行 Rust 2,736 项、容量定向 72 项、来源探针 15 项、三组 HTTP 对拍 67/67、126/126、203/203 及无 Node 启动冒烟。标准 `npm test` 仍 exit 1，仅有上述第 249、514 行两项共享并发基线失败，完整归一化断言报告与干净 `bf99c686` 基线逐字一致；被短路的后续 npm 阶段不记为通过。全部门禁日志、独立记录、哈希及 HTTP 详情均已核对归档。继续保留 `umask 022`、来源及复制品可执行文件 0755、addon 0644 和持久夹具诊断，原三项 remote-screen 安全用例均通过。证据目录为主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/task-shell-capacity-gates/`；整体 Node 后端清零尚未完成，服务未重启。

### 已有 Rust 凭据实现的冗余 Node 入口

删除 `src/providers/native-credentials.js`（9 行），将两个具名函数原样集中到共享原生绑定的 `providerCredentials` 命名空间，七个生产消费点及现有测试只更换导入。生产 Node 净减 2 行；凭据读取、轮换、损坏保护、账号撤销和出口规则原本已由 Rust 实现，本批不宣称新增这部分 Rust 迁移。保留的 Node 例外仅为现有 N-API 的 JSON 转换和异步等待接线，账号、Provider 及额度宿主退出后即可删除。

函数正文、名称、JSON 求值及异步拒绝边界原样保留，现有五项原生 Provider 宿主测试的断言不变。完整 32 道门禁中，其余 31 道退出码为 0，包括五项凭据宿主定向测试、串行 Rust 2,736 项、三组 HTTP 对拍及无 Node 启动冒烟。标准 `npm test` 仍 exit 1，仅有上述第 249、514 行两项共享并发基线失败，完整归一化断言报告与干净 `bf99c686` 基线逐字一致；被短路的后续 npm 阶段不记为通过。全部日志、独立记录、哈希及 HTTP 详情均已核对归档，`umask 022`、来源及复制品可执行文件 0755、addon 0644 和持久夹具诊断保持生效。证据目录为主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/native-credentials-gates/`。整体 Node 后端清零尚未完成，服务未重启。

### 已有 Rust 模型默认值所有者的工厂入口

删除 `src/cli/model-default.js`（12 行），将具名工厂正文原样集中到共享原生绑定，唯一生产消费点和现有会话策略测试只更换导入，生产 Node 净减 8 行。模型选择、历史快照、严格 TTL 和查询缓存原本已由 `RustModelDefaults` 持有，本批不宣称新增这些策略的 Rust 迁移。Node 只保留持有原生所有者及历史、时钟回调的闭包；CLI 会话策略宿主退出后即可删除。

Rust 源码、原有工厂和 `resolve` 启动探针保持不变，既有模型与 TTL、时钟、线路身份、回调异常及重入断言不变。首次完整验收停在慢读客户端用例 `ResetWithoutClosingHandshake`，保留原 Rust exit 101 和 npm 未运行记录；原树隔离运行 10/10 通过后，只完整复验一次。33 道门禁中 32 道退出 0，包括串行 Rust 2,736 项、会话策略 24 项、三组 HTTP 对拍及无 Node 启动冒烟；标准 `npm test` exit 1，仅有上述第 249、514 行两项基线失败，完整归一化断言报告与干净 `bf99c686` 逐字一致，被短路的后续 npm 阶段不记为通过。来源及复制品权限、持久夹具日志、外部线程采样和退出状态均已核对。验收树 `39d3082b` 原样提交为 `f2607b46`，合入 `cd9ddf12` 后主仓与任务工作区干净且为 0/0；证据保存在主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/model-default-entry-gates/isolated-pass-rerun/`。该结果不代表竞态已修复，整体 Node 后端清零尚未完成，服务未重启。

### 已有 Rust Claude 额度解析器的观测入口

删除 `src/quota/claude-header-quota.js`（12 行），将具名函数正文原样集中到共享原生绑定，两个生产消费点与现有测试只更换导入，生产 Node 净减 7 行。头部解析、窗口身份、过期和合并策略原本已在 Rust，本批仅退休独立 Node 兼容入口。Node 保留 JSON 编解码与吞掉观测错误的绑定边界，防止额度读取打断流；宿主调用协议迁出 Node 后即可删除。

旧版缓存记录器和额度渲染器改为依赖独立冻结的原入口，仅调整导入路径；原函数的展开、JSON 求值顺序与 `catch` 边界以及既有窗口、账号隔离、渲染、缓存断言均保留。Rust 实现与 `cprClaudeQuota` 启动探针不变。完整 34 道门禁中 33 道退出 0，包括额度定向 101 项、会话策略 24 项、串行 Rust 2,736 项、三组 HTTP 对拍和无 Node 启动冒烟；标准 `npm test` exit 1，仅有上述第 249、514 行两项基线异常，完整归一化失败报告与干净 `bf99c686` 逐字一致，短路的后续 npm 阶段未记为通过。权限、持久夹具诊断、外部线程采样、日志哈希均核对归档。验收树 `237aa4ea` 原样提交为 `cd261420`，合入 `14c9771a` 后主仓与任务工作区干净且为 0/0；证据目录为主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/claude-header-quota-entry-gates/`。整体 Node 后端清零尚未完成，服务未重启。

### 已有 Rust 额度存储宿主的兼容导出入口

删除 `src/quota/provider-limit-cache.js`（12 行），将原构造函数别名及两个元数据常量合并到已被该入口加载的异步生命周期宿主，四个生产消费点仅更换导入，生产 Node 净减 10 行。构造函数身份、600000 毫秒新鲜度常量及 schema 元数据 1 不变，原异步生命周期函数、Rust 存储调用和启动探针不变，本批不新增或迁回 Node 缓存策略。保留 Node 是为了兼容现有宿主构造和回调协议；宿主调用协议迁出 Node 后即可删除这些导出。

旧版对拍使用独立冻结的原兼容入口；原辅助模块仅调整导入，冻结的 Aux 路由正文保持不动，只在装载器重定向退休依赖。存储边界守卫改为强制退休文件不存在，保留宿主依赖白名单、构造别名身份、Rust 构造器、异步存储调用及禁用 Node SQLite 的断言，并固定两个原元数据值。首次完整运行在编排 HTTP 对拍停下，保存 27 处差异及无 Node/npm 未运行记录；只读诊断确认网关健康早于 Node 宿主就绪，仓库外只读健康检查消除全部差异，冻结源码和原语料、断言、超时保持不变。新目录完整 36 门禁中 35 道退出 0，Rust 2,736 项、缓存定向 197 项、额度 101 项、会话策略 24 项及四组 HTTP 对拍通过；编排原语料 256/256 一致、原两项预期差异通过、296 条副作用调用一致。标准 npm 仍 exit 1，仅有干净 `bf99c686` 已证明的第 249、514 行两项异常；后续被短路阶段未记通过。权限、持久诊断及全部哈希已核对。验收树 `fb1cd075` 原样提交为 `a15c75ca`，合入 `ea7edd9d` 时主仓与任务工作区干净且为 0/0；证据目录为主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/provider-limit-cache-entry-gates/startup-health-rerun/`，健康检查启动器留在持久验收目录。整体 Node 后端清零尚未完成，服务未重启。

### 已有 Rust 订阅解析器的具名入口

删除 `src/quota/subscription.js`（15 行），将两个具名函数正文原样集中到共享原生绑定，两个生产消费点及现有测试只更换导入，生产 Node 净减 8 行。订阅日期解析和 Codex 登录声明筛选原本由 Rust 持有，本批仅退休独立兼容入口，不宣称新增策略迁移。Node 保留 JSON 编解码、默认时钟参数和动态凭据导出查询，以兼容现有宿主协议；调用协议迁出 Node 后即可删除这些绑定。

默认参数及 `Date.now` 求值时点、JSON 求值和异常传播边界不变，动态 `require` 仍解析到同一原生模块，现有订阅、账号及鉴权断言保留。冻结路由对拍辅助模块、Rust 实现和启动探针不变。完整 37 道门禁中 36 道退出 0，订阅与官方账号定向 80/80、零跳过，Rust 2,736 项及四组 HTTP 对拍通过；标准 npm 仍 exit 1，完整归一化失败报告与干净 `bf99c686` 已证明的第 249、514 行两项异常逐字一致，被短路的后续阶段未记通过。沿用仓库外正向健康启动器，未改语料、断言或冻结源码树；权限、持久诊断、慢读线程采样及日志哈希均核对。验收树 `8724e574` 原样提交为 `5ea747c2`，合入 `a04f0565` 时主仓与任务工作区干净且为 0/0；证据目录为主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/subscription-entry-gates/`，合入收据见 [登记预览](/artifacts/cb22793be35ae2cf/subscription-entry-merge-receipt.json)。整体 Node 后端清零尚未完成，服务未重启。

### 已有 Rust 任务提醒策略的可变对象入口

删除 `src/task-board/attention.js`（15 行），将 `call`、`mutate` 和方法表达式原样集中到 `src/native/task-domain.js` 的 `taskAttention` 导出，生产 Node 净减 2 行。提醒策略原本已在 Rust，本批只退休独立兼容入口。Node 保留默认时钟参数、同步 JSON 命令和旧调用者的可变对象写回协议；任务板宿主退出 Node 后即可删除。原生 taskDomain、replace、WeakMap/Proxy、存储和异常代码均未改动，唯一生产消费点及现有测试只换导入。

原任务板和 Air 路由对拍分别导入独立冻结的原 15 行适配器，正文不变，不共享新命名空间。完整 38 门禁中 37 道退出 0，Rust 2,736 项、提醒 62/62 零跳过、四组 HTTP 对拍通过；npm 仍仅为上述 bf99c686 两项已证明的基线 FAIL。原父进程 sample 在符号处理阶段被外部观察器 5 秒等待截断；用户授权单点补证后，仅独立运行同一个慢读用例一次，生成有效父进程调用图，与原网关/Node 样本分别记录来源。原历史样本缺失及补证附加观察器缺少 pathlib 的工具错误均保留，不宣称原严格历史采样检查通过，不新增产品失败例外。原验收树 `2b63c501` 提交为 `92b917df`，经会话 API 合入 `2803ab1b`，双方干净且 0/0；[合入收据](/artifacts/f29a447441bafefb/attention-entry-merge-receipt.json)。证据目录为主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/attention-entry-gates/`。仓库级残留盘点见 [2026-11-21 审计](node-backend-residual-audit-2026-11-21.md)。

### 官方 fetch SDK 兼容门面（待完整验收）

退休 `src/network/official-fetch.js`（11 行），两个原函数在既有 `src/network/outbound.js` 的非枚举 `official` 命名空间保持正文，仅统一增加缩进；唯一生产消费点仍在创建处理器时惰性读取，显式注入 fetch 时不触发。首次使用捕获 createOutbound、outboundFetch 与 macOS parser，随后缓存同一对象；缓存 undefined、依赖 getter 抛错后的重试以及消费者模块重载行为均与独立冻结门面对拍。原 SDK 工厂、Dispatcher、代理策略与 Rust/启动探针不变。

本批 Node 例外仅为 Undici/proxy-agent 专属 SDK 适配和迁移期 CommonJS 装载桥接，不新增代理、重试或其它业务策略。SDK HTTP/官方中继端口迁至 Rust 后一起退出。保留惰性捕获新增 12 行、删除原入口 11 行，生产 Node **净增 1 行**、少 1 文件；不能把删文件行数记作净减。已交付基线为 585 文件/137,248 行，候选为 584 文件/137,249 行。支持的缓存契约是正常冷/热加载、导出替身、加载失败重试及消费者重载；没有生产代码单独逐出 outbound 依赖模块缓存。

基线定向 84/84，新增三种缓存边界后 87/87、零跳过，覆盖函数与 close 身份、双字段投影、取消、NO_PROXY、代理发现、流与失败不重放。提前捕获别名的负向对照被拒绝，未修改生产源码做变异。原既有断言保留，旧门面仅在测试路径冻结；生产与活动测试没有退休模块的加载引用。完整门禁须保留前 38 项并增加本批定向项；验收前不计作交付。证据目录为主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/official-fetch-entry-gates/`。

### 默认聊天提示词拼装整块迁移（候选，待单次完整验收）

以 `476b5805` 为交付基线，删除默认启动路径及全部 CLI 使用的
`src/message-composer.js`（452 个物理行）。上下文门控与排序、系统提示词、
AutoCommit 快照、语音说明、UTF-16 预算、信封校验及留言送达副作用顺序迁到
`native/core/src/message_composer.rs` 与 `native/addon/src/message_composer.rs`。
调用方仅替换导入，原模块不保留转发门面。Node 仅在共享原生绑定中保留六个
同步调用包装；会话对象、闭包、宿主环境和日志端口仍由 Node 持有，这是现有
聊天/CLI 宿主的迁移桥接例外，宿主统一迁出后删除。无新 Node 业务实现。
同口径候选为 583 文件、136,807 行，相对上一交付态少 1 文件、净减 442 行。
默认启动和 19 个直接运行依赖仍包含 Node；本批不宣称删除运行依赖或整体清零。

该接口是同步、有限长度的提示词构造，不做网络、文件扫描或后台计算；N-API
直接借用 live 对象，保留 opaque 参数身份、getter 与回调异常，不经 JSON
复制或生成 JavaScript。留言仍先按原顺序标记、保存，再发送事件及广播；
验证失败时原有已经发生的副作用也不自动回滚或重放。

原版独立字节门禁 108/108。完整旧实现逐字冻结在
`tests/helpers/legacy-message-composer.js`，SHA-256 为
`d796677ac67587b0c3c39b9f626d007d65a49fedc8dacbf6abf54bf75fe8aa4d`。
既有 Claude/Codex 冻结适配器正文及哈希不变，仅由装载器重定向退休依赖；
新增差分覆盖上下文门控、原始参数身份、读取和副作用顺序、回调/访问器异常、
UTF-16 截断、生产警告及渲染排序。39 项既有门禁全部保留，再加本批定向门禁。
完整验收只运行一次，npm 仅允许既有 `bf99c686` 两项基线 FAIL；任何新失败
封存停止，不自动修改或重跑。本节是冻结前候选说明，不代表测试或合入已完成。
证据保存在主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/message-composer-gates/`。

### 启动状态格式与重放编排（候选，待完整验收）

以已交付 `bd1a0c4c`（583 文件、136,807 行）为基线，删除默认启动路径
`src/bootstrap/state.js`（156 行），将格式识别、旧会话到目录/会话 Map 的迁移、
启动重放/加载/恢复日志顺序及默认目录判定迁至
`native/addon/src/state_bootstrap.rs`。唯一生产消费点 server.js 复用现有原生
绑定导入，启动顺序和调用结构不变；共享绑定只保留四个函数转发和一个别名。
不移除 SDK 依赖，不把整个启动器或后端记为已退出 Node。

存储、历史重命名、UUID、日志和备份复制继续使用原有宿主端口。这是迁移期
Node 桥接例外：Rust 持有判定和编排，live 对象、Map 键、Aux 身份及异常不经
JSON 复制。该事务在聊天 IO 启动前同步完成，不新增扫描或后台计算；重命名
和备份仍保留原 best-effort 边界，原生目录表替换顺序不变。启动所有者统一
迁出 Node 后可删除这层端口传输。

原版定向 8/8、零跳过；完整冻结副本
`tests/helpers/legacy-bootstrap-state.js` 的 SHA-256 为
`dd4d45eedc4fe5ca92e61f7e763ac697251466166542c2a107f6d4c862d14c99`。
差分增加到已有 core 测试文件，覆盖 live 读取/回调顺序、恢复、重复 Map 键、
opaque UUID、Aux/当前记录身份、迭代器关闭、异常与 best-effort 边界。
不增加 core 文件条数，不改发布集合数量守卫。原 40 门禁全部保留，增加本批
定向共 41 项；按本轮约定先验证冻结暂存树，通过后才提交并核对提交树一致。
任何真实失败封存停止，不自动修复或重跑。证据保存于主仓
`data/rust-migration/2026-11-22/bootstrap-state-gates/`。

### 物理路径与 HOME 祖先守卫（候选，待完整验收）

上一通知设置候选已按用户授权丢弃，旧补丁、失败门禁和工具异常仍独立封存，
没有修复或重跑。以快进后的 `8f98e031` 为新基线，实际 Node 审计为 583 文件、
136,691 行（旧 582/136,659 审计后另有 Gemini 改动）。删除默认启动依赖链的
`src/path-safety.js`（62 行），祖先回溯、缺失尾段重建和 HOME/根目录判定迁至
`native/addon/src/path_safety.rs`。两个生产消费点只改导入，共享 runtime 仅保留
两个转发函数，继续导出同一函数身份；标准 path/fs/os 平台端口保持原行为。

这是必要的 Node 桥接例外：路径分隔符、平台 resolve/realpath 和 homedir 由既有
宿主接口提供，策略和循环由 Rust 持有。回溯仅检查一条路径的祖先，不枚举目录、
不增加递归文件扫描或耗时后台计算；同步契约保持不变。平台宿主迁出 Node 后
可删转发层。本批不改依赖、构建或启动脚本，19 个直接运行依赖仍保留。

原始 19 检查全部通过，完整旧实现冻结在 `tests/helpers/legacy-path-safety.js`，
SHA-256 为 `cfa3149f36076b5fd09bc7bee35336ea90e79e0086a67980e52705c16f4e7ea7`。
原测试文件追加差分，覆盖真实符号链接/缺失路径、非法参数、端口调用和 getter
顺序、异常身份、精确的 best-effort 边界及 Windows drive/UNC/分隔符语义。
目录脚本化 oracle 只改导入以使用旧实现，不共享新的 Rust 判定。

保留已存 42 门禁的全部命令、coordinator/observer 与超时，只加本批定向共 43 项。
通知设置候选已经丢弃，其保留定向命令运行当前 main 的原 39 项读写检查，
不恢复已丢弃的候选实现或追加 HTTP 测试。本批不重复旧失败运行。
先验证冻结暂存树，仅当除两项 npm 精确基线 FAIL 外全部符合才提交、核对树、
rebase 并授权会话 API 合入；任何新真实失败封存停止，不修复、不重跑、不合入。
证据保存在主仓 `data/rust-migration/2026-11-22/path-safety-gates/`。

### 默认启动中的失用服务注册器（候选，待完整验收）

以已交付 `9598e5e2`（582 文件、136,635 行）为基线，退休 `src/services.js`
（27 行）及 server.js 的 require / provide 两处接线。仓库级源码搜索确认唯一
生产注册是 `chat.runTurn`，没有注册器 call/has 消费点；实际准入始终由原
`chat:run` 总线监听器直接调用 chatTurnEngine.admitChatWork，监听器正文逐字
保留。本批为失用 Node 运行时代码退休，Rust 业务逻辑增量为 0，不新增替代
注册器或 Node 兼容门面，不改 Rust、总线、准入、存储及代理策略。

原注册器完整冻结在主仓验收目录 `frozen-services.js`，SHA-256 为
`b95da6f838ab0e9a8ef9d76cd471f0c7a7870f46f24bdf7428d4dcc8eae1fa75`。
原聊天监听器与唯一注册语句也独立冻结；外部定向测试验证旧注册器只发生一次
set 且无 get/has，移除后仍按原参数身份、接收者和顺序准入，拒绝时保留原
微任务日志行为。仓库源码扫描是第一方静态证明，不声称覆盖任意外部插件。
原聊天准入/协调器/事件系统基线 149/149、零跳过；不新增 core 文件或数量守卫。

服务器行数/字节预算按实际值同步下调。package.json、依赖锁、构建/启动脚本
不需改动，19 个直接运行依赖及默认 Node 启动继续保留。删除 27 行模块和两行
接线，生产 Node 净减 29 行（含注释），不能宣称净增 Rust 策略或依赖移除。

按本轮用户授权先完成独立 topic 提交、无冲突 rebase，再冻结提交树验收。
保留原 43 门禁、runner/coordinator 和全部超时，仅追加一项本批定向，共 44 项，
完整运行一次。npm 仅允许既有 bf99c686 两项精确基线 FAIL；任何新真实失败、
冲突或不安全依赖均封存停止，不自动修复、重跑或合入。证据保存于主仓
`data/rust-migration/2026-11-22/service-registry-retirement-gates/`。

### 默认启动中的供应商引用转发门面（候选，待完整验收）

以已交付 `5b177d73`（581 文件、136,606 行）为基线，退休
`src/providers/references.js`（22 行）。它只有 server.js 一个生产导入，全部
引用判定早已由 Rust provider_registry 持有；原 findProviderReferences 函数
逐字移到既有 src/native/runtime.js 并复用该文件的 getNative，不复制业务规则。
server 和两处既有测试仅更新导入；冻结的旧规则 oracle 不改。

这是必要的 Node 原生绑定桥接例外：现有进程中的会话、默认值与 Aux 对象继续
按原身份交给 addon，保留默认空对象、每次调用的惰性 getNative、原接收者、
同步结果/异常身份和函数声明形状。原函数完整保留为4行（含分隔空行），没有
新增 Node 业务逻辑；Rust 源码、默认启动脚本和依赖均不改。宿主对象不再需要
通过 Node/N-API 传输时可删除这一桥接。保留19个直接运行依赖，不宣称依赖退休。

旧门面完整冻结在持久验收目录 baseline/src/providers/references.js，SHA-256
`03a57a7161c8a2ce4be3c3999cf3b47679062ea790f4304625babb20c73035c4`。
引用/重分配/供应商路由基线51/51、零跳过。本批只新增外部定向检查，不新增
core文件或修改测试数量守卫。保留原43项门禁，追加本批定向共44项，仅运行一次。
按授权先独立提交、无冲突rebase并冻结已提交树，验证后不再次创建topic提交。
仅允许既有两项npm精确基线FAIL，其余新失败/冲突/证据异常立即封存停止，
不修复、不重跑、不合入。证据保存于主仓
`data/rust-migration/2026-11-22/provider-references-retirement-gates/`。

### 默认启动中的 HTTP 聚合入口（候选，待完整验收）

以已交付 `03db2312`（580文件、136,588行）为基线，删除默认启动链中的
`src/http/index.js`（10行）。memo controller只消费domain-error的三个导出，
docs-memory宿主只消费error-map的mapError；两处直接导入既有叶子模块。
两处测试只改导入，函数正文与所有HTTP叶子模块、错误品牌Symbol、类身份和
共享CommonJS缓存所有者保持。没有替代聚合门面，也没有新增Node/Rust业务逻辑。

默认Node启动脚本仍被源码/后台重启监督器直接引用，Rust网关没有等价的
source-start入口；构建检查器也有其他消费者，因此本批不强行移除它们。
全部19个直接运行依赖仍有SDK、平台或协议消费者，没有可随该聚合文件删除的
独占npm运行依赖。默认启动脚本、锁文件、配置与Rust源码不变。迁移Node消费者
时继续分别核销这些平台端口，不能把本次入口删除视为整个产品已无Node。

原聚合入口完整冻结于主仓验收目录baseline/src/http/index.js，SHA-256
`fde054edc5066cbd43e21371510efd95afb8a7c7d5e45551186df99496d13e6d`。
HTTP错误边界、memo controller/宿主、文档注册和记忆浏览基线48/48、零跳过；
本批仅新增外部定向证明，不新增core测试文件或修改数量守卫。
保留原43项门禁，只追加本批定向共44项，完整运行一次。原npm两项精确基线
例外保持FAIL，短路阶段NOT_PASS；新真实失败/冲突/证据异常封存停止，不自动修复。

本轮按授权先冻结暂存树、构建/测试/静态门禁各一次，全部合规后才创建独立
提交、核对提交树等于已测树、无冲突rebase并经会话API合入。候选Node净减
1文件、10行（含注释空行）。证据保存于主仓
`data/rust-migration/2026-11-22/http-barrel-retirement-gates/`。

### 失用HTTP异步适配器（候选，待完整验收）

以已交付 `202e135f`（579文件、136,578行）为基线，删除
`src/http/async-route.js`（17行）。上一批聚合入口退休后，该适配器没有生产
导入或调用，仓库第一方搜索仅找到自身和一项专属单元测试。生产路由使用的是
`src/http-errors.js` 的asyncHandler，本批不修改这一活跃模块或server接线。

同时删除测试中对失用模块的导入及唯一专属用例；其余HTTP断言逐字保留。
旧实现和删除的用例完整保存在持久证据目录，原文件SHA-256：
`a6c97befb009b8447b21984e0066772cd4d8d2758c9262b714c5a51233bd57ac`。
不新增替代适配器，不迁移/复制业务规则，不改Rust、SDK、重启或平台入口；
本批没有可随之移除的独占npm依赖，19个运行依赖及默认Node启动均保留。

原HTTP/memo/文档/记忆基线48/48、零跳过；移除该一个过时用例后保留47项，
追加外部3项退休证明为50项。既有测试文件和core文件数量守卫不变，不把移除
过时用例说成全部48项仍运行。外部证明核对无生产引用、其余断言和活跃模块
源码不变，并与独立冻结的活跃asyncHandler比较拒绝转发及安全错误响应。

只改删除模块、对应测试与本说明3路径，生产Node净减1文件、17行。
冻结暂存树后仅运行一次原43门禁加本批定向共44项。既有两项npm精确基线FAIL
与短路NOT_PASS保持；任何新失败/冲突/不安全依赖封存停止，不高风险自动修复。
合规后才创建唯一提交，记录无冲突rebase并经会话API合入，核对精确树与双clean0/0。
最终全仓审计逐文件说明保留依据，并逐项列出19个运行依赖的保留原因。
证据保存于主仓 `data/rust-migration/2026-11-22/http-async-route-retirement-gates/`。

### 失用HTTP诊断结果适配器（候选，待完整验收）

以已交付 `60ba9660`（578文件、136,561行）为基线，删除
`src/http/diagnostic-result.js`（31行）。第一方源码没有生产导入或调用，
搜索仅找到原模块、唯一专属单元测试与文档。该模块未接入默认启动、重启、
SDK或平台端口，也不持有可独立删除的npm运行依赖。

同步移除测试的专属导入与一项过时用例，更新HTTP边界说明及本批说明，
共4路径。其余HTTP断言和活跃模块逐字保留，不增加替代门面或业务规则。
原模块、专属测试、其余叶子模块与server完整冻结在持久证据目录，
旧模块SHA-256：`7c5431c8b6f2d06ede0dd943b9bad376759e53e73f09b9cbff992d92dcd9feee`。

基线47/47、零跳过；退休一项过时测试后保留46项，追加3项外部退休证明，
候选定向共49项。测试文件与core文件数量守卫保持。生产Node净减1文件、
31行，候选577文件、136,530行；Rust源码指纹不变，默认Node启动及19项
运行依赖保留。静态搜索不作为任意外部私有导入不存在的证明。

冻结暂存树后运行一次原43门禁加本批定向共44项，保留原超时、诊断与采样。
仅接受bf99c686已核实的两项精确npm基线失败，并记录FAIL与后续短路NOT_PASS；
任何新失败、真实冲突或不安全删除均封存停止，不高风险修复或重跑。
验证封存发布后才创建唯一提交，无冲突rebase、会话API合入，核对提交树、
已测树和合入树相同，以及main/工作区clean0/0，再重生成逐文件、逐依赖审计。
证据位于主仓 `data/rust-migration/2026-11-22/http-diagnostic-result-retirement-gates/`。

## 每批验收与最后停用条件

- 先冻结旧版输出和状态变化。覆盖默认与条件入口，对比 WebSocket 原始帧、HTTP/SSE 响应、事务写入以及副作用顺序。对必须变化的字段逐项登记。补充关键失败的断言，变异验证须区分编译失败与行为被检出。
- 用当前源码重建网关和需要的 addon，单批做定向回归，交付前对比 `main` 的已知失败。生产切换前跑 `cargo fmt --check`、严格 Clippy、Rust 工作区测试、Node 兼容、安全、状态、契约、架构与治理套件，以及网关和安装包相关回归。隔离数据夹具覆盖旧版 schema、事务中断重试和重启。
- 每批记录运行时还剩哪些 Node 入口。最后逐项核销默认挂载、条件挂载、动态插件、HTTP 宿主端口、WS/SSE 入口和后台工作者。`scripts/capture-backend-routes.js` 的默认隔离快照须配合条件配置和协议验收。
- 最终用实际发布入口启动隔离包，检查无 Node 可执行路径、无 Node 后端子进程、完整功能路径成功、进程树和监听端口可核验。用隔离副本演练升级和回退，先核对现有格式能否继续被旧版本读取，再确定恢复方式。验证通过的版本记录独立启动命令和用户手动切换流程。
