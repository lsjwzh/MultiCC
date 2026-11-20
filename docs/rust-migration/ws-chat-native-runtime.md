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

## 任务壳输入与收据重放阶段

基线为 `010dd344`。Rust 网关与 Node 兼容入口使用同一套 Rust 输入规则，负责校验 WebSocket 输入、确定控制身份并生成收据键与请求指纹。兼容入口通过 N-API 提供会话和控制事实，首次投递、收据保留和工作区调度继续走现有宿主。

独立网关使用只读 SQLite 快照核对发起会话、任务壳、收据指纹和已接收结果。重试同一条工作或取消消息会返回原结果。相同消息 ID 对应的另一份内容返回幂等冲突。会话分享只重放属于地址中会话的收据。新任务投递还需接通持久领取、工作区所有权与完成回执。现有任务壳运行时和 Node 启动依赖仍承载这些操作。

### 门禁记录

| 命令 | 结果 |
| --- | --- |
| `cargo build --locked --manifest-path native/Cargo.toml -p multicc-addon -p multicc-gateway` | 通过 |
| `node --test tests/test-chat-ws-conformance.js tests/test-task-shells.js tests/test-task-context-host.js tests/test-scheduler-admit-rust-required.js tests/test-schedule-admit.js tests/test-session-work-scheduler.js tests/test-schedule-claim-live.js` | 133 项通过。既有 21 个金样通过，13 个场景的选定帧逐字节一致，并用旧版 Node 公式独立核对落盘收据 |
| `cargo clippy --locked --manifest-path native/Cargo.toml --workspace --all-targets -- -D warnings` | 通过 |
| `cargo test --locked --manifest-path native/Cargo.toml -p multicc-gateway --test ws_chat -- --nocapture --test-threads=1` | 17 项通过 |
| `npm run test:governance` | 通过 |
| `cargo fmt --manifest-path native/Cargo.toml --all --check` | 基线的 8 个文件仍有格式差异，检查未通过 |

按前述启动方式运行独立网关时，定向回归的直连 Claude 夹具复跑了多轮、历史、重连、取消和错误帧。记录来自取消前仍运行的网关和模型夹具进程。

```text
监听 127.0.0.1:59644
ps -A -o pid=,ppid=,comm= （网关及其后代，省略网关二进制路径前缀）
75138 74977 multicc-gateway
75147 75138 /bin/sh
进程树内 Node 进程数 0
```

## 任务壳收据写入阶段

本阶段在 `09bd540a` 上复验。Node 兼容入口读取执行状态、任务生命周期、默认角色和引用历史，Rust 在同一 SQLite 写事务中校验游标、任务归属、幂等键和问答占位，同时保存任务、收据、关联及游标版本。数据库中已有的不可变历史快照继续使用原始 JSON 字节。

宿主返回投递结果后，Rust 将接收回执与游标推进一起提交。失败或过期的回答与其问答占位一起清理。晚到的回执保留自身结果，并按游标版本判断是否仍可切换当前任务。

独立网关仍只会重放已接收的任务壳收据。首次执行还需要接入调度仓储的准入、领取、写者许可和完成回执。队列执行及自定义 provider 仍由兼容宿主运行。

本阶段重建 `multicc-addon` 和 `multicc-gateway` 后，任务壳、角色、关联历史、分离和调度定向回归通过 196 项。新增游标用例在读取执行状态期间切换当前任务，验证旧请求不会写入收据或占用任务。WebSocket 复验通过 21 个协议金样和 13 个场景的选定帧字节对拍。严格 Clippy、治理门禁和 17 项网关回归均通过。全仓格式检查仍退出 1，所列 8 个文件与 `main` 逐字节相同，本阶段修改的 Rust 文件通过单独格式检查。

本轮直连 Claude 夹具覆盖多轮、历史重放、重连、取消和上游错误。取消前的隔离监听和进程树记录如下。首次任务壳执行与自定义 provider 尚待隔离复验。

```text
监听 127.0.0.1:51924
ps -A -o pid=,ppid=,comm= （网关及其后代，省略网关路径前缀）
2522 2078 multicc-gateway
2531 2522 /bin/sh
进程树内 Node 进程数 0
```

## 调度领取、工作区许可和交付确认阶段

收据阶段已提交为 `a12eb1b1`，并变基到 `main` 的 `09bd540a`。本阶段将调度领取写入移入 SQLite 所有者。Rust 校验会话、投递 ID、租约期限和令牌，再从持久队列读取任务与尝试次数，提交起跑状态。拒绝的领取与 SQLite 写入失败均不会留下起跑状态。

工作区预算、许可的发放与状态变更由同一 Rust 任务仓储完成。工作区释放仍核对写者注册表。兼容宿主继续提供工作区物化、Git 校验和进程存活事实。用户消息已持久化后，Rust 在同一事务中确认 outbox 交付、把文本替换成历史引用并推进匹配的起跑状态。迟到的确认保留已经进入评估或冻结的调度状态。数据库触发器回归覆盖调度起跑写入失败时，outbox 确认随事务回滚的行为。

定向回归 246 项、网关 17 项、原有 21 个金样和 13 个场景的选定帧字节对拍均通过。严格 Clippy 和治理门禁通过。全仓格式检查退出 1，列出的 8 个文件与 `main` 逐字节相同，本阶段修改的 Rust 文件通过单独检查。

独立网关的本轮隔离证据仍覆盖直连 Claude 的多轮、历史回放、重连、取消和错误帧。

```text
监听 127.0.0.1:58983
ps -A -o pid=,ppid=,comm= （网关及其后代，省略网关路径前缀）
42030 41452 multicc-gateway
42046 42030 /bin/sh
进程树内 Node 进程数 0
```

在另一隔离端口 `55948` 投递一条新的任务壳消息，得到 `chat_route_unavailable` 且没有开始回合。独立网关的任务壳路径仍需调用这些写入所有者，并把持久队列执行、工作区许可和完成回执串起来。自定义 provider 的凭据与 attempt 路由仍经兼容宿主。生产调用方迁走后才能清理 Node 源码、启动接线和依赖。

Rust 工作区全量命令退出 101，已执行的 4 个套件累计 1521 项通过。事件目录测试在源文件与 `main` 一致的代码中断言 CLI 数量为 13，实际为 14。源码行数门禁报告 `public/run-config.js` 和 `server.js`，两份文件均与 `main` 逐字节相同。Node 契约套件 163 项通过，桥接契约 32 项通过。状态套件的最后一项关停探活与核心套件的 ACP 取消断言首次失败，单项复验均通过。核心套件中断后补跑 30 段，29 段通过。失败段中的 Fleet 分享用例用当前源码的发布构建复验 20 项通过，无人值守的时序断言复验通过。

安全套件首段记录 1218 通过、3 失败、1 取消。远控中继在冷构建期间超时，回收留下的隔离测试进程后，以同一源码的发布构建复验通过。远控探针和进程套件复验 50 项通过。安全套件被跳过的三个 WebSocket 后续段补跑共 68 项通过。

## 独立网关执行已有任务壳（进入本轮前的基线）

工作分支 `rust/ws-chat-replay-write-native` 以 `09bd540a` 为基线。收据事务 `a12eb1b1` 和调度、工作区事务 `d54034a9` 已提交。独立网关执行、自定义线路和本节验证记录仍在工作树。

已有就绪任务和已登记的常驻工作区可以接收新任务壳输入。网关在持久队列中选择任务并领取租约，先获得写者许可，再持久化用户消息和确认调度交付。回合结束时确认整个 Unix 进程组已退出，在同一任务仓储事务提交任务执行结果与写者释放，然后以原投递 ID 和尝试次数完成调度。代码版本无法读取时保留观测失败原因。重连可以唤醒绑定任务会话中尚未领取的持久工作。启动状态未知的租约会保留，避免重启后重复执行。

固定 Anthropic 自定义线路使用已保存的 `providers.json` 配置。网关独立转发请求，Claude 子进程只获得限于当前回合的回环访问能力。隔离上游测试验证了模型别名、凭据注入、上游回显脱敏、跨块 UTF-8 和回合线路归属。

当前覆盖已有任务壳指向当前执行会话，且工作区绑定已经建立的 Claude 路径。新任务及工作区物化、其他执行会话、控制问答、带依赖或引用上下文的投递、动态线路选择及账号路由仍由兼容宿主提供。`server.js` 与 `server-core-host.js` 仍调用 `src/chat/sessions.js`，`server.js` 仍调用 `src/chat/turn-engine.js`。这些调用及其生产依赖当前仍存在。

### 启动和端到端验收

```sh
cargo build --locked --manifest-path native/Cargo.toml -p multicc-gateway
MULTICC_DATA_DIR=/absolute/isolated-data MULTICC_CLAUDE_BIN=/absolute/claude \
  native/target/debug/multicc-gateway serve --cwd /absolute/isolated-root \
  --no-node --ephemeral-loopback
cargo test --locked --manifest-path native/Cargo.toml -p multicc-gateway \
  --test ws_chat -- --nocapture --test-threads=1
```

网关回归 19 项通过。任务壳夹具验证首次投递、排队、进行中重连、取消、下一项执行、历史归属、收据重放和完成回执。直连夹具复验多轮、历史回放、重连、取消与错误。以下是两个隔离网关执行期间的 `ps -A -o pid=,ppid=,comm=` 记录，省略了二进制路径前缀。采样结束后确认相关 PID 已退出，端口已停止监听。

```text
任务壳监听 127.0.0.1:53381
41656 41529 multicc-gateway
41663 41656 /bin/sh
网关树内 Node 进程数 0

直连监听 127.0.0.1:53426
41721 41529 multicc-gateway
41739 41721 /bin/sh
网关树内 Node 进程数 0
```

### 原始帧对拍

在仓库根目录使用当前构建的 addon 与网关。将 `MULTICC_RUST_ADDON` 指向与 `multicc-gateway` 放在同一目录的 `multicc_core.node`。

```sh
node --test tests/test-chat-ws-conformance.js
node docs/rust-migration/differential/capture-chat-ws-conformance.js \
  --out /tmp/ws-chat-golden-check.json --compare-turn-bytes /tmp/ws-chat-raw.json
```

21 个既有协议金样和 13 个场景的选定帧对拍通过。完整回合检查为两个宿主分别复制初始测试数据库，保留每一条 WebSocket 数据帧的原始负载并以 Base64 写入 JSON。比较包含帧顺序、字段顺序和原始值，时间戳和生成的 ID 也参与比较。

| 场景 | Node 帧数 | Rust 帧数 | 结果 |
| --- | ---: | ---: | --- |
| 已有任务壳的新投递 | 36 | 17 | 不一致 |
| 第二轮 | 37 | 17 | 不一致 |
| 重连历史 | 6 | 5 | 不一致 |
| 取消 | 38 | 15 | 不一致 |
| 上游错误 | 41 | 13 | 不一致 |

首个不同帧均为 `system/init`。两侧的有效模型、有效推理强度、CLI 可用性和线路统计不同。兼容宿主还发送任务状态、通知、队列变更、历史标注和错误策略事件。Rust 错误帧能传递隔离上游的错误详情，兼容宿主以 `api_error_policy` 和 `system/warning` 等帧表达。完整帧门禁退出 1。

### 全量门禁与基线差异

离线锁定依赖重建 `multicc-addon`、`multicc-gateway`、`multicc-writer-launcher` 成功。`cargo clippy --offline --locked --manifest-path native/Cargo.toml --workspace --all-targets -- -D warnings` 通过。

`cargo test --offline --locked --manifest-path native/Cargo.toml --workspace --no-fail-fast -- --test-threads=1` 执行全部目标，2623 项通过、2 项失败、0 项忽略。两项失败的源码、CLI 列表和断言与 `main` 一致。

- 事件目录 `catalog_body_keeps_the_retired_key_order_and_drops_aliases` 期望 13 项，实际 14 项。
- 网关目录 `directories_list_keeps_the_dto_key_order_and_the_count_fallbacks` 的期望遗漏 `agy_terminal` 和 `agy_chat` 两个计数。

全仓 `cargo fmt --manifest-path native/Cargo.toml --all --check` 退出 1。报告中的八个文件均与 `main` 逐字节一致，本阶段修改的 Rust 文件没有格式差异。

- `native/addon/src/terminal_target.rs`
- `native/core/src/http_send.rs`
- `native/core/src/static_assets_routes.rs`
- `native/core/src/static_web.rs`
- `native/gateway/src/app/download.rs`
- `native/gateway/src/app/release_history_routes.rs`
- `native/gateway/src/forward.rs`
- `native/gateway/tests/static_web_root.rs`

Node 套件 `test:bridges`、`test:state`、`test:contracts`、`test:governance` 退出 0。架构套件 147 通过、2 失败。第一项报告 `src/session/hibernation.js` 引用了架构断言尚未放行的 `../native/runtime`。第二项报告 `public/run-config.js` 超出行数和字节预算，以及 `server.js` 预算需要按现有体积收紧。两项的源码和断言均与 `main` 一致。

`npm run test:core` 退出 1，阻断该命令的测试批次有 2627 项通过、7 项失败。CLI 安装表仍缺 `agy`，定向用例复现，相关实现和断言与 `main` 一致。同一批次还有 6 项 Fleet 分享测试在调试产物上失败，替换为同源码的发布产物后，该测试文件 20 项全部通过。被短路的三个后续命令单独通过，其中任务壳套件 303 项，任务优先套件 517 项。

`npm run test:security` 首次因冷构建超时，源码启动脚本单独预热时还把网关放进了重复的 `darwin-arm64` 子目录。相关构建脚本与 `main` 一致。把同源码的发布产物放在隔离目录后，完整安全套件退出 0。主段 1222 项通过、0 项失败，其后的背压、宿主差分、回放套件分别通过 15、37、16 项。

完整回合字节差异和未迁移的兼容路径仍是 Node 清理、最终提交、变基复验与合入 `main` 的待办条件。

## Rust 回合对拍、计划工作区与动态线路

基线为 `main` 的 `09bd540a`。本轮用同一份隔离状态分别启动兼容宿主与 Rust 网关。兼容模式仍由 Node 持有其生产路由和会话状态。独立模式的 Claude 执行链从持久收据、调度领取、工作区和写者租约延续到完成回执。

已登记且就绪的新任务可以带 `workspaceState: planned` 进入这条链。Rust 验证项目、任务分支、工作树路径和基准 Git ref，领取持久物化许可后创建工作树，再验证实际分支及 Git common dir。工作区登记和写者许可在同一 SQLite 事务中提交，随后将会话写为 `awake`。进程启动前的可报告错误会释放许可。进程意外退出后，状态未决的写者许可仍阻止重复执行。工作树创建保留 Git 已有分支和内容。

独立网关支持同一 Claude 线路内的自定义 Anthropic Auto 候选池。每次执行从已提交的 provider 额度快照和保存配置解析候选，用现有 Rust 排序规则选择可用线路。CLI 子进程持有本回合的回环代理地址。隔离上游验收了候选优先级、实际模型和凭据注入，并检查凭据未进入聊天历史。此段 Auto 支持首次选线与任务回合成功后的线路记忆。跨 CLI 切换、难度或价格路由、自动重试及厂商账号接入仍需兼容宿主。

空任务壳的新任务登记、跨会话投递、依赖及引用上下文、控制问答和其它生产 HTTP/WS 路由也仍需兼容宿主。Node 例外范围包括 `server.js` 的启动和回合编排、`src/routes/server-core-host.js` 的会话桥、Claude 原生二进制的 npm 分发，以及这些调用依赖的脚本和包。待剩余入口有 Rust 所有者、两个宿主的真实客户端验收覆盖相同任务类型之后，才能移除相应 Node 模块和依赖。

### 启动方式

```sh
cargo build --offline --locked --release --manifest-path native/Cargo.toml \
  -p multicc-gateway -p multicc-writer-launcher
MULTICC_DATA_DIR=/absolute/isolated-state \
  MULTICC_CLAUDE_BIN=/absolute/native-claude \
  sh scripts/start-rust-only.sh --ephemeral-loopback
```

使用隔离状态已有的 `ACCESS_TOKEN`，或通过环境注入该值。网关打印实际端口。`MULTICC_CLAUDE_BIN` 可以指定可执行文件。省略时解析 PATH 上的 `claude`。独立网关的启动和执行代码不再搜索 npm 的 SDK 目录。若外部 CLI 由 Node 实现，其进程仍会出现在进程树中，本报告以原生可执行夹具复验。

### 完整 WebSocket 回合差异

```sh
node --test tests/test-chat-ws-conformance.js
node docs/rust-migration/differential/capture-chat-ws-conformance.js \
  --out /tmp/ws-chat-golden-check.json --compare-shell-bytes \
  --compare-turn-bytes /tmp/ws-chat-turns.json --audit-turn-differences
```

并排构建的网关和 addon 位于 `MULTICC_RUST_ADDON` 所在目录。工具记录 Base64 原始负载、升级响应、关闭码、发送顺序、事件出现次数、字段名和键序差异。`--audit-turn-differences` 同时检查允许差异和独立模式的完整行为。去掉此选项会对完整回合执行严格字节门禁。

最终发布版采集如下。行内计数会随旧宿主的异步通知变化，原始文件完整记录各次实际顺序。最终原始记录的 SHA-256 为 `a002845eb346022809db48b4723213ef6e8412ab2b2f2251be195293c19d6249`。

| 完整回合 | Node 帧数 | Rust 帧数 |
| --- | ---: | ---: |
| 持久任务壳首次新投递 | 36 | 21 |
| 第二轮 | 36 | 21 |
| 重连历史回放 | 6 | 6 |
| 取消 | 38 | 19 |
| 上游错误 | 42 | 18 |

| 差异 | 独立模式中的允许范围 |
| --- | --- |
| 初始化 | 两侧分别生成并持久化回合 ID。Rust 只报告自身支持的 CLI 可用性和已持久化的 CLI 状态。Provider token 窗口在本轮独立模式为 `null`。模型、推理强度、路线名和稳定身份纳入对拍断言。 |
| 回合及消息身份 | 允许宿主生成不同的运行代次、回合、消息、路由决策和尝试 ID 以及 provider revision。帧内引用、投递及任务身份仍须一致。时钟和耗时按各宿主实测。 |
| 历史及注解 | 播放相同的种子转录时逐字节比较。后续历史按角色、内容及任务归属比较。独立模式保留自身记录的用量、模型和投递归属，旧宿主的 Aux 注解、上下文轨迹、细分时间线和 provider token 广播仍有差异。 |
| 任务状态及排队 | 独立模式回放持久状态并广播回合结束后的更新，队列按耐久收据和完成后的快照更新。兼容宿主还广播 Aux 健康、分类中间态和 queued/claimed/started/assessing/completed 等阶段性通知。 |
| 通知 | Rust 对任务回合发布运行、成功或取消通知。旧宿主可重复发送运行通知，并携带分类、任务短码和语音提示字段。 |
| 取消 | Rust 在同一尝试上结束并标记 `released`，保留已收到的部分内容并生成取消回执。独立模式不将主动取消归为上游错误。兼容宿主夹具有时额外发取消所致的失败和 warning 事件。 |
| 上游错误 | Rust 保留脱敏后的失败结果、`api_error_policy`、`system/warning` 和失败路由终态，并将错误信封持久化。独立模式本轮只有一次尝试，旧宿主另有重试阶段、结果重复和错误通知。审计记录错误策略的部分键序和路由身份字段差异。 |

上述差异限于本轮隔离 Claude 任务壳验收。严格全帧字节一致、完整 Node 宿主退役和切换默认启动方式仍需要补齐兼容路径。

### 测试门禁和 `main` 对照

| 门禁 | 本轮结果 |
| --- | --- |
| Rust 工作区 `cargo test --offline --locked --manifest-path native/Cargo.toml --workspace --no-fail-fast -- --test-threads=1` | 2,624 通过，2 条基线失败，0 忽略。 |
| 严格 Clippy `cargo clippy --offline --locked --manifest-path native/Cargo.toml --workspace --all-targets -- -D warnings` | 通过。 |
| Rust 全仓格式 `cargo fmt --manifest-path native/Cargo.toml --all --check` | 8 个基线文件有未格式化内容。变更文件单独检查通过。 |
| Node `test:bridges`、`test:state`、`test:contracts`、`test:governance` | 均通过。 |
| Node `test:core` | 失败批次 2,630 通过、1 条基线失败、3 跳过。短路的 wait injector、task shells、task first 三段已单独补跑通过。 |
| Node `test:security` | 完整复跑通过。主段 1,222 通过、1 项跳过，后续三段分别通过 15、37、16 项。 |
| Node `test:architecture` | 147 通过，2 条基线失败。 |
| `tests/test-chat-ws-conformance.js` | 21 个场景符合旧宿主金样，13 个任务壳选定帧逐字节匹配。 |
| 退役角色会话单测和入口契约 | 10 项通过，涵盖角色模板、已有角色会话路由和已退役入口的 HTTP 410。 |

逐项对照 `09bd540a`，下列失败对应的断言及实现源码均有相同的 Git blob。事件目录断言期望 13 个 CLI，实际返回 14 个。目录 DTO 断言缺少 `agy_terminal` 和 `agy_chat` 两个计数。核心兼容套件的安装表断言缺少 `agy` 条目。架构边界断言拒绝 `src/session/hibernation.js` 的 `../native/runtime` 依赖。源码预算断言报告 `public/run-config.js` 比登记预算多 12 行、719 字节，也要求收紧 `server.js` 的预算。

格式报告逐一命中 `native/addon/src/terminal_target.rs`、`native/core/src/http_send.rs`、`native/core/src/static_assets_routes.rs`、`native/core/src/static_web.rs`、`native/gateway/src/app/download.rs`、`native/gateway/src/app/release_history_routes.rs`、`native/gateway/src/forward.rs`、`native/gateway/tests/static_web_root.rs`。这些文件和 `main` 的 Git blob 一致。

安全套件的远控端到端夹具在冷构建时超时，冷跑遗留隔离进程已清理。预热后远控端到端通过，默认并发两次触发远控进程测试的 150 毫秒 PID 文件竞态。定向单测通过。最终运行包脚本的同四段命令，将第一段的进程并发限制为 2，全部通过。夹具、断言和生产进程实现与 `main` 相同。

调用审计确认旧固定角色会话创建服务 `src/session/role-worker.js` 仅由单测加载，已删除。保留的单测用持久化旧记录覆盖角色提示注入与 Commander 路由。启动脚本、包脚本和依赖的在用入口继续覆盖生产兼容宿主。独立启动移除了对 npm SDK 目录的查找，冒烟测试使用没有 `server.js` 和 npm 包的空目录。

### 清理后零 Node 进程记录

先完成 Node 兼容测试，再将当前工作树的 `node_modules` 移出，使用 Cargo 重建发布版网关与写者启动器。独立构建的网关 SHA-256 为 `6c346779fed2bf1775a8bb29426a7843c0f0b774008b9368294e75dc1315205a`。这个构建只选择独立运行所需的两个 crate。对拍构建还选择了 addon，因此两份发布构建的二进制摘要不同。

```sh
sh scripts/smoke-no-node-gateway.sh "$PWD/native/target/release/multicc-gateway"
MULTICC_WS_CHAT_PROOF_GATEWAY="$PWD/native/target/release/multicc-gateway" \
  cargo test --offline --locked --manifest-path native/Cargo.toml \
  -p multicc-gateway --test ws_chat -- --nocapture --test-threads=1 \
  native_ production_no_node_chat_runs_replays_and_cancels_real_provider_processes
```

空运行根的冒烟端口为 `127.0.0.1:57054`。空 PATH 上找不到 Node，Rust 探针和健康检查返回 HTTP 200，兼容宿主持有的路由返回 HTTP 503，SIGTERM 退出码 0。五项独立 WebSocket 测试通过，涵盖首次执行、多轮、历史回放、进行中重连、取消、错误、计划工作区和隔离上游。测试子进程的 PATH 无法解析 `node` 或 `nodejs`。

下面是执行期间的 `ps -A -o pid=,ppid=,comm=` 输出，省略网关可执行文件的相同路径前缀。

```text
127.0.0.1:57077  计划工作区及动态线路
19539 19537 multicc-gateway
19587 19539 /bin/sh
19602 19587 /usr/bin/curl
网关及后代中的 Node 进程数 0

127.0.0.1:57108  任务壳排队、重连、取消及下一轮
19669 19537 multicc-gateway
19680 19669 /bin/sh
网关及后代中的 Node 进程数 0

127.0.0.1:57141  直连多轮、历史、取消及错误
19711 19537 multicc-gateway
19720 19711 /bin/sh
网关及后代中的 Node 进程数 0
```

复查确认四个端口均已关闭，三个被抽样的网关 PID 均已退出。
