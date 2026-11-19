# WS 宿主与聊天控制面：阶段验证（进行中）

本报告记录中间状态，不代表 WS 宿主迁移验收完成。WS upgrade、聊天状态、快照与
重放仍在 Node；九类 WS 路径尚未由 Rust 前门接管。**连接注册、心跳判定与每连接
发送队列已在 2026-11-19 的后续批次接入 Rust 注册表，见文末「宿主切换」一节与
`ws-host-registry-2026-11-19.md`。**

- `427c0296` 引入同一票据所有者上的一次性消费。核心测试覆盖路径、到期、重复
  消费和原生工作区权限元数据；网关控制通道测试覆盖跨进程形式和并发唯一成功者。
- `d719968a` 加入 VM 槽位交接，后续字段投影仍在工作树中：VM 槽位经弱引用回到 Node 线程取值、删除并限长序列化；
  只投影授权及机器连接所需字段，忽略无关循环引用和回调；必需字段无法序列化或
  响应超过控制帧上限时拒绝。机器票据的地址和上游 URL 已通过真实 addon 的私有通道
  测试；这不等同于机器 WebSocket 宿主已迁移。
- `ws_handshake` 是尚未接线的 Rust 握手规划器。Node `ws` 的 noServer 处理器生成
  的 20 组成功及错误响应已逐字节对照；允许 POST、修改 accept 密钥、允许重复子协议
  三项真实代码变异在隔离临时 crate 中均被语料捕获；复跑脚本为
  `docs/rust-migration/differential/ws-handshake-mutations.py`。尚未验证完整 upgrade 与后续帧。
- Rust `api_contract::ws_envelope` 与 Node `createWsEnvelope` 的 26 组 JSON 值逐字节
  对照，覆盖字段顺序、ID 回退、孤立代理项和溢出数字；探针使用该实现生成事件帧。
- `ws_registry` 是仅在测试探针接线的 Rust 连接注册表：连接独立、消息数和字节数分别限额，
  接收方持有帧期间保留字节配额，断开时移除注册。定向测试覆盖隔离、限额、释放、
  无效容量和标识耗尽；按会话索引的广播隔离了慢客户端与不同会话，并保证并发生产者
  的事件对各客户端按同一顺序入队。三条真实连接的测试确认同会话扇出及跨会话隔离；
  这些测试不能证明现有 Node 背压与连接行为已经等价。
- 注册表现对消息数、字节数或单帧超限的连接发出独立断连信号，后续入队失败；测试
  探针接到信号后以 1013 和 Node 的慢客户端原因关闭。定向测试验证溢出通知、
  同会话其他客户端不受影响及消息数单独触顶；尚未验证生产聊天的完整背压语义。
- 仅测试开关启用的 `/__gateway_test/ws` 在真实网关监听器串联握手、同一票据所有者、
  连接注册及聊天式 ping；无 Node 模式与 Node 子进程持有循环引用票据的模式均通过，
  错误握手不消费票据、重放以 4003 关闭。文本与二进制 ping 的原始响应帧分别与 Node
  `ws` 对照一致；错误路径的票据也由原所有者消费并拒绝。测试开关关闭时探针不注册；
  探针并不处理生产聊天、快照或重放。
- 对隔离副本的探针源码分别变异 pong 内容、二进制消息处理和会话分组；真实网关帧及
  多连接测试均捕获错误。事件信封版本变异已加入复跑脚本，待本轮运行确认。
  复跑脚本为 `docs/rust-migration/differential/ws-probe-mutations.py`。这些变异只覆盖探针，
  不构成生产聊天链路的完整变异验证。
- 聊天消息的 ping 与 share 权限门槛由 Rust 决定；32 组动作与旧规则对照。复制 Rust
  门槛源码到临时目录，分别变异「只读者不能 ping」及「operate 可以清空历史」，
  编译后两项变异均被定向断言捕获。尚未做完整 Rust/Node WS 帧逐字节差分及其变异。
- 定向验证：相关认证、聊天和 WS 路由 Node 测试 94 项通过；其他聊天运行时 Node
  测试 65 项通过；真实网关 + 隔离数据根 + 假 CLI 的聊天连接、ping/pong、消息、
  重连和取消通过；真实分享会话的 operate 输入经任务会话路由通过。新版 addon 预检
  可拒绝缺少聊天门槛方法的旧模块。
- 本次 VM 字段投影和握手/注册表改动后，认证、聊天、WS 路由与原生模块预检共 110 项
  Node 测试通过。首轮临时 addon 缺少同目录 gateway 而失败，补齐成套产物后复跑通过。
- 接入测试专用监听路径后，认证、网关、聊天、WS 路由与原生模块预检共 115 项 Node
  测试通过；网关测试额外覆盖独立 Rust 所有者、Node 子进程所有者和测试开关关闭。
- 本轮加入多连接会话广播及 Rust 事件信封后，相关 Node 段复跑 116 项通过；帧对照
  额外覆盖文本/二进制输入及孤立代理项、溢出数字。
- 全工作区 `cargo clippy --workspace --all-targets -- -D warnings` 通过，
  `cargo test --workspace --no-fail-fast` 77 个测试目标共 2540 项通过；本批 Rust 文件
  格式检查、`check-source-line-budget` 和 Node 路由台账对账通过。
- 来源地址隔离测试使用调试构建时分别在共享创建及 14 个并发密码校验处失败；换用
  优化构建单独复跑后通过，覆盖真实 WS 快照、共享权限、重复票据和密码限流。结果与
  调试构建的 scrypt 性能和三秒控制通道期限有关这一判断一致，但未单独测量各请求耗时。
- 本轮一次全工作区测试中 `docs_memory_routes` 因先探测后释放的端口被并行进程占用而
  启动失败（`EADDRINUSE`）。夹具已改为网关直接绑定系统分配的回环端口，相关 16 项
  测试连续两次通过；重新运行的全工作区 clippy 及测试通过，77 个测试目标共 2543 项。
  此结果早于本轮新增的注册表溢出断连，新增代码已通过 5 项注册表定向测试，仍需
  完整复跑最终验证。

剩余：Rust WS 宿主及聊天控制面、所有实际连接的所有权和 ticket 守卫、机器连接与
共享的完整行为、真实逐字节差分及代码变异、最终验证后的台账和报告提交、合并核验。

## 本轮追加：发送侧队列规则的 Rust 所有者

- 新增 `native/core/src/ws_backpressure.rs`：复刻 `src/ws-backpressure.js` 的全部
  可观测决策（合并键、队列天花板、消息数闸、高水位与拥塞计时、1013 关闭、metric 与
  log 行及其顺序）。时钟、重试定时器、`bufferedAmount` 与 socket 由调用方提供。
- 冻结实现 `tests/helpers/legacy-ws-backpressure.js` 与 `src/ws-backpressure.js`
  逐字节相同（7848 B）；`docs/rust-migration/differential/ws-backpressure-oracle.js`
  驱动冻结实现生成 `ws-backpressure-golden.json`，20 组场景共 175 个效果。Rust 内核
  重放同一 op 序列，效果逐个相等（`frozen_node_backpressure_decisions_match_effect_for_effect`），
  另有一项常量漂移断言对齐 `DEFAULTS` 与 `COALESCE_TYPES`。
- 变异验证 `docs/rust-migration/differential/ws-backpressure-mutations.py`：
  baseline 通过，`count-cap-everywhere`、`coalesce-appends`、`high-water-strict`、
  `congestion-strict`、`ceiling-without-frame`、`congestion-never-clears`、
  `keeps-the-timer`、`no-terminate-fallback` 八项真实代码变异全部被语料捕获；
  另有一项断言要求语料覆盖全部九种效果类型（含 cancel 与 terminate 两条拆除路径）。
- 为什么这是前置件：共享连接路由对每条非原生 socket 都安装该包装器，因此连
  `/ws/machines`（无 Node 业务状态的字节桥）在 client 方向也会按 JSON `type` 合并帧、
  按 2 MiB + 8 MiB 天花板和 15 秒拥塞计时以 1013 断开。任何 WS 宿主若不带这套规则，
  迁移就不是字节等价。
- 漂移守卫：`tests/test-ws-backpressure.js` 断言冻结副本与 `src/ws-backpressure.js`
  逐字节相同（15 项通过），改动生产模块而不重生成语料会直接报红；语料本身可由
  oracle 脚本重跑复现，输出字节一致。
- 本轮**未**做：Node 侧仍运行自己的那份包装器（未改为委托内核），生产 `/ws/chat`
  与其余 WS 路径的升级、连接、聊天状态、快照/重放仍由 Node 持有；Node 的 WS 注册
  未停用，也没有加启动断言。
  （本条是该轮结束时的状态，已被下一节取代。）

## 宿主切换（后续批次）

- Node 侧那份包装器已删除（`src/ws-backpressure.js`），共享连接路由对每条非原生
  socket 改为向 addon 的 `RustWsHost` 注册；连接注册表、心跳窗口判定和发送队列由
  内核决定。完整说明、差分口径与验证记录见 `ws-host-registry-2026-11-19.md`。
- 仍未做：WS upgrade 终结、`/ws/chat` 的回合引擎状态、快照/重放。`--no-node` 下
  `/ws/*` 升级仍如实返回 503 `node_runtime_absent`。
