# /ws/chat 迁入 Rust 前门：阶段 2，前门终结客户端 socket 并建立到 Node 的聊天通道（2026-11-20）

## 本阶段做了什么

`/ws/chat` 的升级请求不再被前门当作字节流转给 Node。前门自己完成握手，自己持有客户端 socket 的整个生命周期
（读写帧、控制帧、关闭握手、异常断开）。聊天引擎仍在 Node 子进程里，它通过一条前门到 Node 的私有回环通道，
把每个客户端看成一个“虚拟 socket”。

| 产物 | 作用 |
|---|---|
| `native/core/src/chat_bridge.rs` | 通道的帧语法与编解码（纯函数，无 I/O），带字节语料生成器 |
| `native/core/tests/fixtures/chat-bridge-corpus.json` | 24 条字节语料（15 条前门到 Node，9 条 Node 到前门）；Rust 与 Node 两端都对着它测 |
| `native/gateway/src/chat_bridge.rs` | 前门一端：每代 Node 一条流，互证能力令牌，按连接号复用，有界队列把压力传回客户端 TCP |
| `native/gateway/src/ws_chat.rs` | 客户端 socket 的帧泵：握手（复用 `ws_handshake`）、控制帧、关闭握手、写任务独立 |
| `src/ws/gateway-chat-bridge.js` | Node 一端：虚拟 socket 实现 `ws` 的那部分表面，供连接路由、发送队列、聊天引擎使用 |
| `src/gateway-child.js` `startChatBridge` | 在 Node 子进程里拨通道，丢失后退避重拨；能力令牌只留在闭包里，从 `process.env` 删除 |
| `src/ws/connection-router.js` | 启动通道，虚拟 socket 走与真 `ws` socket 相同的 `connection` 事件 |

## 通道协议

一帧是 `u32 大端长度` 加本体。本体是 `kind` 字节、`u32` 连接号，再是各类字段。连接号由前门分配，同一代内不复用。

| 方向 | kind | 内容 |
|---|---|---|
| 前门到 Node | `0x01 Open` | 请求的 JSON：url、头（已按 Node 规则合并）、对端与本端地址 |
| | `0x02 Message` | 文本/二进制标志加完整消息 |
| | `0x03 Pong` | 客户端的 pong 控制帧 |
| | `0x04 Closed` | 关闭码、两个标志（收到/发出关闭帧）、原因；该连接号的最后一帧 |
| | `0x05 Sent` | 一次 `Send` 的完成（成功或失败），顺序与发出顺序一致 |
| Node 到前门 | `0x11 Send` | 序号、二进制标志、载荷 |
| | `0x12 Close` | 关闭码（0 表示无状态码）、原因 |
| | `0x13 Terminate` | 不发关闭帧直接断开 |
| | `0x14 Ping` | 发 ping 控制帧 |

语法是严格的：未知 kind、过短、多余字节、非法 UTF-8、非法标志位都是错误，不做宽容解析。任何一端遇到错误，
就把整条通道视为丢失。

握手与 `auth_control` 同构：前门先发 32 字符 nonce，Node 回 `child:<nonce>` 的 HMAC，前门回 `parent:<nonce>` 的
HMAC，双方用常量时间比较。能力令牌每代 Node 重新生成，经环境变量交给子进程，子进程读后立即从 `process.env` 删除。

## 所有权

前门现在持有：升级握手字节、两个方向的帧传输、客户端 ping 的应答、pong 的上报、带 30 秒宽限的关闭握手、
协议违规时的关闭码（1009 超长、1007 非法 UTF-8、1002 协议错误，与 `ws` 一致）、Node 或通道丢失时的无关闭帧断开。

Node 仍持有，且本阶段没有迁移：准入与鉴权（含票据与分享）、会话解析与历史、发送队列与合并、心跳节拍、
回合编排。重放缓冲与 `cs.clients` 仍在 addon 内的 `RustWsHost`（上一阶段迁入），没有搬到前门进程。
这些事实都依赖 Node 进程内的状态，要先把它们变成 Rust 所有者，才能让前门独立回答。

## 与 `ws` 的语义对齐（经测试固定）

- `send` 的回调在前门把帧写进客户端 socket 之后才触发，`bufferedAmount` 等于尚未写出的字节数。
- 通道丢失时每个虚拟 socket 以 1006 结束，挂起的发送回调收到 `WebSocket is not open: readyState 3 (CLOSED)`。
- `close()` 的参数校验与 `ws` 相同：非法状态码抛 `TypeError`，原因超过 123 字节抛 `RangeError`。
- 无状态码的关闭帧在 Node 侧报告为 1005。
- 一个监听器抛异常只终止它自己的 socket，不会拖垮共享通道（`ws` 会把这类异常交给进程）。
- 客户端不读数据时，该客户端的写任务阻塞，但它发来的控制帧仍然送达 Node，`terminate` 仍然生效，其他客户端不受影响。

## 验证

| 项目 | 结果 |
|---|---|
| `cargo test -p multicc-core chat_bridge` | 7 项通过：往返、语料逐字节钉住、每个定长帧的所有严格前缀都被拒绝、多余字节被拒绝 |
| `cargo test -p multicc-gateway`（全部） | 943 通过，0 失败；其中新增 `tests/ws_chat.rs` 15 项，用真前门加真 Node 通道客户端端到端驱动 |
| `tests/test-gateway-chat-bridge.js` | 23 项通过：语料双向比对（测试内独立转写语法）、非法帧、握手伪造、虚拟 socket 语义、监听器异常隔离 |
| `tests/test-gateway-child.js` | 15 项通过，其中新增 2 项覆盖通道启动器的重拨与停止 |
| `cargo test --workspace` | 2591 通过，0 失败 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通过 |
| `tests/test-chat-ws-conformance.js`（19 个场景） | 通过；临时去掉 Node 端通道接线后同一测试变红，证明场景确实经过前门终结 |
| `tests/test-ws-connection-router.js` | 22 项通过（需要与源码指纹一致的 addon，见下） |
| `npm run test:governance` / `test:state` / `test:core` / `test:security` / `test:integration:isolated` | 全部退出码 0；security 1210 通过（另有 1 项既有 todo）；isolated 含全部聊天隔离套件，约 10 分 16 秒 |
| 变异 | 前门 5 个（无状态码关闭码、cookie 合并分隔符、二进制标志被忽略、terminate 报告为正常关闭、Node 丢失时发关闭帧）与 Node 端 4 个（确认不释放 `bufferedAmount`、放行关闭码 1006、重复连接号被忽略、通道丢失不结束 socket）全部被对应测试抓出，每次改动后文件都已还原并逐字节核对 |

`tests/ws_chat.rs` 覆盖：请求与对端描述（重复头的合并规则、地址与端口）、300 帧文本与二进制混合的顺序、
2000 次连续发送的回调与顺序、5 MiB 下行与 8 MiB 上行逐字节、Node 发起关闭、无状态码关闭、客户端发起关闭、
`terminate`、双向 ping、关闭之后发送失败且不到达客户端、50 个客户端互不串扰、不读数据的客户端不拖慢邻居、
Node 被 `SIGKILL` 后客户端断开且重启后的 Node 可再服务、没有通道时返回 503、畸形握手的状态行与正文与规划器一致。

## 门禁里抓到的回归与处理

第一次跑 `test:core` 有 1 项红：`tests/test-fleet-sharing-routes.js` 里经分享票据连 `/ws/chat` 得到 503。原因是该测试的夹具
子进程 `tests/helpers/gateway-auth-child.js` 以前靠前门把升级转给它，现在前门自己终结这条升级，夹具没有拨聊天通道，
所以前门答 503。修法是让夹具在网关子进程下调用与生产相同的 `startChatBridge`。修后该测试 20/20，共用这个夹具的
`test-gateway-auth-native.js`、`test-service-routes.js`、`test-ws-machines-differential.js` 共 23 项通过，`test:core` 重跑退出码 0。

同一轮里还发现 `ws_handshake.rs` 不能引入 axum：`ws-handshake-mutations.py` 把它当独立 crate 编译，引入 HTTP 类型会让基线编译失败。
握手到 HTTP 响应的适配因此放在 `ws_chat.rs`，`ws_handshake.rs` 与 HEAD 一致，该变异集基线通过且 3 个变异全被抓出。

**跑依赖 addon 的测试要用与当前源码指纹一致的产物。** 改了 `native/*.rs` 之后，继承来的 `MULTICC_RUST_ADDON` 指向旧指纹，
`RustWsHost is not a constructor` 会让 `test-ws-connection-router.js` 22 项里 21 项假红。用
`env -u MULTICC_RUST_ADDON -u MULTICC_RUST_PREBUILT_DIR node scripts/ensure-source-rust.js` 构建后，把
`MULTICC_RUST_ADDON` 与 `MULTICC_RUST_PREBUILT_DIR` 同时指向它。

## 边界

- `--no-node` 下 `/ws/chat` 仍然立即返回 `503 node_runtime_absent`，没有变化。回合编排、会话历史、准入仍在 Node，
  所以前门独立运行时它还不能真实可用。这一条不能因为本阶段完成而改口。
- 没有迁移任何 HTTP 路由，没有切 `--no-node`，没有删除 Node 源码、`package.json`、`node_modules`。
- 通道上每个客户端消息都要经 Node，帧的内容没有被前门解析；心跳节拍与背压合并规则仍由 Node 一侧的发送队列执行。
