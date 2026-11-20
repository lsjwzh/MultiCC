# /ws/chat 网关宿主迁移记录

基线为 `29bcdece`，工作分支为 `rust/ws-chat-replay-write-native`。
生产 WebSocket 握手由网关接管。`--no-node` 模式将 `/ws/chat` 交给 `ws_chat_native`。兼容模式通过私有聊天桥将已升级的连接交给 Node。

| 顺序 | 模块与现有调用链 | Rust 所有权与依赖 |
| --- | --- | --- |
| 1 | `gateway::forward → ws_chat → chat_bridge → connection-router → turn-engine.handleChatWs`。连接路由读取对端、cookie、票据、分享记录、机器授权与会话记录 | `ws_admission` 已负责准入规则。网关已有本地认证和一次性票据所有者。还需接入会话、分享和任务壳事实，保留核验顺序与拒绝帧。 |
| 2 | `session-create → create-record → sessionPersistence` 负责创建与工作树。连接从 `persistedSessions`、`invalidSessions`、`chatSessions` 恢复状态 | 记录的持久化协议在 `durable_state`，实时记录与回合所有者目前在 addon。网关需要直接加载旧记录，统一状态写入与恢复，再接管创建和实时投影。 |
| 3 | `handleChatWs → history runtime / task-shell/chat-history → history file repository` | Rust addon 支持旧 JSON 数组、JSONL、可见性账本及增量尾写。连接预算、种子和回放计划在 Rust。网关需要共享文件协议、分页与任务壳投影，按已有顺序输出。 |
| 4 | `user_message → taskContextHost → session-work host/scheduler → turn-engine → provider runner` | 调度事务、回合生命周期与若干事件规则已在 Rust。Node 组织写入回执、路由证明、工作目录和 CLI 参数，并持有 SDK/进程句柄。网关需直接驱动这些端口。 |
| 5 | `cancel → 同一调度操作 → 活跃 runner → 持久化与广播`；错误从 provider 事件进入 `api-error-host` 和回合结束协调器 | 按回合所有权处理取消、退出和重复请求，确认完成回执后清理活跃槽。保留同一错误信封、重试边界与重连状态。 |
| 6 | 兼容模式的回放写入、成员及发送队列由 Node 进程中的 Rust addon 持有 | Rust-only 模式的生产路径使用 `ws_chat_hub` 管理成员、回放和有界发送队列。 |

当前分支已通过生产的 Node 兼容入口调用以下 Rust 核心：

- 会话记录的主文件与备份恢复、跨文件事务日志重放，会话打开、历史恢复初值、工作目录选择、任务壳命令分流及文本取消识别。旧配对会话的拆分和工作树检查仍经宿主执行。工作树不可用时，仍选择不可用工作区路径。
- 历史文件命名、旧数组和 JSONL 扫描、写入字节及行尾偏移。回放写入与连接成员由同一个原生宿主持有。历史可见性、分页和任务壳投影仍需接到独立网关。
- 回合记录表、取消时的回合身份选择以及 Claude 进程的初始化、双向流、中断、管道排空和退出。独立进程夹具验证了两次交互与中断。现有 addon 继续通过 N-API 输出原事件。调度回执、provider 路由选择、任务壳投影与取消完成协调仍经 Node 宿主调用。

在首次隔离诊断中，生产入口 `multicc-gateway serve --no-node` 的 PID 为 `56431`，监听 `127.0.0.1:54320`，进程树内 Node 进程为 0。`/healthz` 返回 200，生产 `/ws/chat` 返回 `503 node_runtime_absent`，随后诊断网关退出码为 0。

## 生产入口回归

`cargo test --locked --manifest-path native/Cargo.toml -p multicc-gateway --test ws_chat -- --nocapture --test-threads=1` 直接启动生产网关二进制，使用隔离数据目录和 shell 实现的 Claude 标准输入输出夹具。验证从已有记录恢复会话、连续两轮且第二轮带上续接参数、断线历史回放、进行中回复回放、实际调用子进程 `interrupt`、取消后保存部分回复及上游失败帧。重连初始化、后续流式、结果和错误帧携带 Web 和 App 校验所需的 provider 回合归属。

带回合归属的 16 项 WebSocket 回归通过。最新定向复验中，隔离网关只监听 `127.0.0.1:60708`。取消前用 `ps -A -o pid=,ppid=,comm=` 采集进程树，以下省略了二进制路径前缀。

```text
62194 62193 multicc-gateway
62217 62194 /bin/sh
进程树内 Node 进程数 0
```

本批 Rust-only 执行范围是已存在会话记录中的直连 Claude 对话。任务壳、后台任务、保留历史清理、队列调度、定制 provider 和其他 CLI 的功能及完整帧对拍仍依赖兼容路径。Claude 子进程按回合启动，通过持久化的原生会话 ID 续接上下文。兼容模式的 `turn-engine.js`、`sessions.js` 和启动接线仍有生产消费者。

## 任务壳历史与队列快照阶段

后续一批从 `a50fd15a` 开始。独立网关使用任务仓储的只读 SQLite 快照核对任务壳、会话关联和项目归属。它回放有关联的持久历史，应用各源会话的可见性和现有回合归属覆盖。旧记录缺少消息 ID 时，按源会话、记录顺序和内容派生稳定 ID。连接时从调度仓储读出 `session_queue`，沿用 Rust 的队列排序、活跃位投影和提问答案过滤规则。

任务壳投递、收据恢复、实时关联会话历史更新、队列执行及自定义 provider 转发仍由兼容宿主承担。Node 会话与回合模块及启动接线因此仍有调用方。

### 启动与复跑

从仓库根目录构建并在独立数据根启动网关。替换示例中的两个绝对路径。从网关日志读取操作系统分配的回环端口。端到端测试提供会话数据和 Claude 标准输入输出夹具。

```sh
cargo build --locked --manifest-path native/Cargo.toml -p multicc-gateway
MULTICC_DATA_DIR=/absolute/isolated-data \
  native/target/debug/multicc-gateway serve --cwd /absolute/isolated-root \
  --no-node --ephemeral-loopback

cargo test --locked --manifest-path native/Cargo.toml -p multicc-gateway \
  --test ws_chat -- --nocapture --test-threads=1
```

使用当前源码构建原生模块和网关，然后复查原有的 21 个协议场景。对拍工具在同一份隔离状态上先后启动兼容模式和 `--no-node`，比较 8 个新增场景的原始 WebSocket 负载字节、升级状态和关闭结果。新增场景包括非法或缺失壳标识、未关联会话、会话分享、普通输入与心跳、关联历史、归档历史，以及含提问答案的持久队列。

```sh
MULTICC_RUST_ADDON="$(node -p 'require("./scripts/ensure-source-rust").ensureSourceRust()')" \
  node --test tests/test-chat-ws-conformance.js
```

### 已采集的端到端记录

定向网关回归通过 17 项，涵盖连续两轮、持久历史、旧消息 ID、流式重连、子进程中断、部分回复和上游错误。测试使用固定的 shell 夹具输出，真实启动生产网关与子进程。

```text
监听 127.0.0.1:60194
ps -A -o pid=,ppid=,comm= （网关及其后代，省略网关二进制路径前缀）
48984 46977 multicc-gateway
49060 48984 /bin/sh
进程树内 Node 进程数 0
```

### 门禁记录

| 命令 | 结果 |
| --- | --- |
| `cargo test --locked --manifest-path native/Cargo.toml --workspace -- --test-threads=1` | 2622 项通过，0 失败，0 忽略 |
| `cargo clippy --locked --manifest-path native/Cargo.toml --workspace --all-targets -- -D warnings` | 通过 |
| `cargo fmt --manifest-path native/Cargo.toml --all --check` | 基线已有 8 个文件的格式差异。单独检查本批 Rust 文件通过 |
| `node --test tests/test-chat-ws-conformance.js` | 21 个兼容场景通过，另有 8 个场景的新旧选定帧逐字节一致 |
| `npm run test:security` | 首次远控用例在冷构建阶段超时。预构建原生产物后复验通过 |
| `npm run test:state` | 通过 |
| `npm run test:contracts` | 通过 |
| `npm run test:governance` | 通过 |
| `npm run test:core` | 使用发布构建复验通过。修复了临时端口为 65535 时，登录回调夹具生成无效地址的问题 |
| `npm run test:integration:isolated` | 分段复验通过。发布构建跑通记忆 API 之前的命令，修复启动等待与进程清理后，从记忆 API 续跑的 12 条命令全部通过 |
| `node --test tests/test-fleet-sharing-routes.js` | 使用发布构建的网关与原生模块复验，20 项通过 |
