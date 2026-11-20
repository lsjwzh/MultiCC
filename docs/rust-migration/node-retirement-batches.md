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

## 每批验收与最后停用条件

- 先冻结旧版输出和状态变化。覆盖默认与条件入口，对比 WebSocket 原始帧、HTTP/SSE 响应、事务写入以及副作用顺序。对必须变化的字段逐项登记。补充关键失败的断言，变异验证须区分编译失败与行为被检出。
- 用当前源码重建网关和需要的 addon，单批做定向回归，交付前对比 `main` 的已知失败。生产切换前跑 `cargo fmt --check`、严格 Clippy、Rust 工作区测试、Node 兼容、安全、状态、契约、架构与治理套件，以及网关和安装包相关回归。隔离数据夹具覆盖旧版 schema、事务中断重试和重启。
- 每批记录运行时还剩哪些 Node 入口。最后逐项核销默认挂载、条件挂载、动态插件、HTTP 宿主端口、WS/SSE 入口和后台工作者。`scripts/capture-backend-routes.js` 的默认隔离快照须配合条件配置和协议验收。
- 最终用实际发布入口启动隔离包，检查无 Node 可执行路径、无 Node 后端子进程、完整功能路径成功、进程树和监听端口可核验。用隔离副本演练升级和回退，先核对现有格式能否继续被旧版本读取，再确定恢复方式。验证通过的版本记录独立启动命令和用户手动切换流程。
