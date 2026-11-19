# `/ws/machines/<id>` 迁入 Rust 前门（2026-11-19）

本批把第一条**生产** WebSocket 路径的升级终结权交给 Rust 前门，并在同一改动里
删除 Node 实现。这不代表 WS 域迁移完成：`/ws/chat` 的升级终结与回合引擎仍在
Node（阻塞项 4），本批没有触碰它们。

## 为什么是这一条

它是 9 类 WS 中唯一**零共享状态**的：桥只持有一条客户端 socket、一条上游
socket，不参与快照、重放、回合或任何跨连接注册表。其余路径都先要拆出状态所有权。

## 归属

- 新增 `native/gateway/src/ws_machines.rs`：路径认领、握手终结、票据消费、
  准入判定、上游拨号、双向转发、关闭码改写。
- 新增 `native/gateway/src/ws_tls.rs`：`wss://` 对端的 TLS 客户端，信任策略与
  `crate::outbound` 一致（系统根 + `NODE_EXTRA_CA_CERTS`），证书按 URL 主机名
  校验而非按票据钉住的地址。
- `native/gateway/src/forward.rs`：在任何 HTTP 层之前认领，且**仅认领真升级**
  （`Upgrade` + `Connection: upgrade` 令牌），与 Node `upgrade` 事件的触发条件
  一致；同路径的普通 GET 仍照旧落到 Node。
- 删除 `src/ws/machines.js`（48 行）与 `src/ws/connection-router.js` 里的分支。
  冻结对照 `tests/helpers/legacy-ws-machines.js`，与删除前原件的 SHA-256 同为
  `239bbad4a6dd66e96c0fefdf874a5fbdd70920b3c06e9be92f5a01343cb9d451`。

## 一条不在被删模块里的规则

共享连接路由给**每条**它接受的 socket 装了原生发送包装器
（`src/ws/native-queue.js`，在 machines 分支之前运行），所以发往客户端的帧一直
走 `multicc_core::ws_backpressure`：排队、按 JSON `type` 合并、以及 1013 慢客户端
切断。不把这套内核放在客户端 sink 前面就不是字节等价，因此 Rust 侧同样以内核
默认上限运行它。`bufferedAmount` 映射为写入任务尚未完成的那一帧的字节数——
内核最多只保持一帧在飞，这也正是 Node 包装器在 `flush()` 时刻量到的值。

## 差分与变异

`tests/test-ws-machines-differential.js`：同一个假对端、同一个原始 socket 客户端，
两侧比对客户端可见字节（握手状态行、每帧 opcode 与载荷 sha、关闭码与原因）。

- Node 侧 = 冻结模块跑在真实 `ws` server 上，并按生产方式装上原生发送包装器
  （`RustWsHost` 的 anchor 必须像生产路由那样挂在宿主对象上，否则会被回收，
  表现为 `host value anchor released`）。
- Rust 侧 = `multicc-gateway` 自己终结升级。

8 项全通过，覆盖：文本/二进制/跨字节中文帧双向转发；上游关闭 → 1012、上游 4003
→ 保留 4003；票据作用域内但 `machineId` 指向别的机器 → 4003；无钉住地址 → 4003；
一次性票据不能开第二条 socket；畸形握手先被拒且**不**花掉票据；同路径普通 GET
仍由 Node 应答；上游超内核上限的 9 MiB 帧 → 1013 且原文案一致。

差分抓到一个真实实现缺陷并已修正：上游以 4003 关闭时，Node 只改关闭码、
文案仍是 `电脑连接已关闭`，初版 Rust 误把文案也换成了 `电脑连接票据无效`。

`docs/rust-migration/differential/ws-machines-mutations.py`：基线通过 + 5 个变异
全部被捕获（改 1012、去掉 4003 透传、去掉路径绑定、抬高队列上限、认领普通 GET）。

## 门禁

- `cargo test --locked -p multicc-gateway`：917 通过 0 失败。
- `cargo clippy -p multicc-gateway --all-targets -- -D warnings`：通过。
- 格式：只格式化本批新增文件。`cargo fmt --check -p multicc-gateway` 的既存
  diff 在 HEAD 上就是 9 处（`app/download.rs`、`app/release_history_routes.rs`、
  `forward.rs`、`tests/static_web_root.rs`），本批把一度涨到 12 的计数改回 9，
  未改动他人既存债务。
- `tests/test-ws-connection-router.js` 22 通过；`tests/test-gateway-auth-native.js`
  6 通过；`tests/test-ws-backpressure.js` 15 通过；`tests/test-ws-host-differential.js`
  37 通过；`scripts/check-source-line-budget.js` 通过；
  `tests/test-node-surface-ledger.js` 通过。
- 新测试已登记进 `package.json` 的 `test:security`，否则 CI 永远不会跑它。
- `native/gateway/tests/no_node.rs` 增加一条守卫：`--no-node` 且无本地 auth
  所有者时，这条路径仍是**立即** 503 `node_runtime_absent`，不是先 101 再等
  控制线超时才关。网关套件由此变为 918 通过 0 失败。

## 未覆盖与限制

- `wss://` 对端只有拨号与信任策略的代码路径，**没有**真实 TLS 握手的本地差分：
  本仓没有可复用的本地 TLS WS 服务夹具，`native/gateway/tests/outbound.rs` 用的是
  CONNECT 隧道桩而非真握手。这条路径未经实测验收。
- 多个钉住地址按票据顺序依次尝试，共享同一个 10s 预算；Node 走的是 `net.connect`
  的 Happy Eyeballs（250ms 交错）。客户端可见字节流观察不到这个差别，但在
  「首地址黑洞」场景下建连延迟特性不同。
- 本批不代表真实配对电脑的端到端验收，也没有重启生产服务。

## 状态

本批只落在工作树，未提交、未合并、未推送、未重启。
