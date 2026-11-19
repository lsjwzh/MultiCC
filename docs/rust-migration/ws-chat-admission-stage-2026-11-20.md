# `/ws/chat` 准入与鉴权迁成 Rust 所有者（2026-11-20）

本阶段把每条 WebSocket 连接的**准入判定**从 `src/ws/connection-router.js` 的内联块搬进
`multicc_core::ws_admission`。这是收尾迁移第 7 步五项之一；另外四项（会话历史、回合编排、
重放缓冲写侧、`cs.clients`）本阶段**未做**，`--no-node` 下 `/ws/chat` 仍然 503，原因与量化见文末。

## 搬了什么

Node 仍然拥有请求、cookie、分享记录、一次性票据表、机器授权与会话记录，也仍然由它执行关闭。
搬进 Rust 的是**判定**：哪道闸门先响、按什么顺序、以及准入后的 socket 带着什么。完整有序序列：

1. 优雅关闭 → `close(1012, 'server shutting down')`
2. 公网直连策略拒绝 → `multicc_ws_public_peer_rejected_total` + `close(4003, 'Direct public access disabled')`
3. 发送队列安装位（`installNativeQueue`，原生工作区自带队列的 socket 跳过）
4. 分享令牌分支（仅 `/ws/chat` 且带 `share` 参数）→ 命中则授权，否则 `close(4003, 'Forbidden')`
5. 一次性票据：机器授权撤销 → `close(4003, '电脑授权已撤销')`；`ws._machineGrantId`；
   `ws._correlationId`（correlationId 回退 requestId）；fleet 作用域不符 →
   `multicc_ws_fleet_scope_denied_total` + `close(4003, 'Forbidden')`
6. 遗留凭据：`multicc_ws_legacy_auth_total` + `legacy_ws_auth` 警告（query / cookie）
7. 最终拒绝：`multicc_ws_auth_denied_total` + `close(4003, 'Forbidden')`
8. 内部执行槽 → `Session does not exist.` 帧 + 无参 `ws.close()`（空关闭帧，不是 1000）
9. 准入：chat socket 带上 `ws._sharePerm`（null 也带），再交给按路径的处理函数

### 两条容易丢的性质

- **拒绝之前可以先有标注。** 路由的 close 监听会打 `ws._correlationId`，所以一张随后因 fleet
  作用域被拒的票据仍然在关闭日志里留下自己的名字。变异 `annotates-a-revoked-grant` 钉住这一点。
- **一次性票据只在分享分支没授权时才消耗。** `needs_ticket` 用与 `plan` 同一条分享规则回答这件事，
  所以调用方不会烧掉原路径没碰过的票据。同理 `needs_share_record`：分享表只为带 `share`
  参数的 chat socket 查一次，别的路径一次都不查（这是既有测试里的契约）。

## 事实采集的边界

每个事实都是纯读，所以在判定之前一次性收齐。两处凭据校验改成「这个凭据到底送来了没有」来守，
而不是守它的开关位——开关的合取由内核拥有。这会让 `verifyCookie` / `verifyAccessToken`
在开关关闭时也被调用；两者都是纯密码学比较，没有日志也没有计数，所以不可观测，这里明确记录。

两处**不能**投机执行的查询由内核先回答：`wsAdmissionNeedsShareRecord` 与
`wsAdmissionNeedsTicket`。JS 侧在它们前面各留了一个参数存在性短路，那是必要条件、内核会再查一遍，
不是规则的第二份副本。

## 测试与变异

| 项目 | 结果 |
|---|---|
| 冻结 oracle `tests/helpers/legacy-ws-admission.js` | sha256 `0b53a5f787d3f5790a63a349e35a232e394410605b8ca6630bdcf3a62c45cb65`；逐语句转录自路由内联块 |
| 语料 `ws-admission-corpus.json` | 1080 例，六个分组各自在它读的维度上穷举：gates 48、share 48、deny 512、ticket 448、queue 8、dispatch 16 |
| 覆盖 | 615 准入 / 465 拒绝；五种关闭形态与四个计数器全部出现；遗留警告 88 例、机器标注 8 例、关联 id 248 例、内部槽 6 例 |
| 内核 `cargo test -p multicc-core --lib ws_admission` | 5 项通过（逐例差分、`needs_ticket` 与 oracle 一致、`needs_ticket` 与 plan 实际到达的阶段一致、无需分享记录时记录不影响判定、JSON 桥） |
| 接线差分 `tests/test-ws-admission-differential.js` | 800 例经**真** `mountWsConnectionRouter` 驱动；另 280 例是 URL 表达不出的 id 组合（chat socket 带目录 id、无会话路径带会话 id），由内核语料覆盖 |
| 变异 `ws-admission-mutations.py` | 基线通过，28 个变异全部检出 |

差分断言的是客户端和运维真正看得见的东西：关闭码与原因（含无参 close）、计数器顺序、
`legacy_ws_auth` 的三个字段、`ws._machineGrantId` / `ws._correlationId` / `ws._sharePerm`、
`Session does not exist.` 帧、是否真的派发到了某个按路径处理函数、票据有没有被消耗、分享表有没有被查。

## 踩到的坑

**变异脚本的临时工作区必须带上 `tests/helpers/legacy-chat-replay-buffer.js`。**
`chat_replay_buffer` 用 `include_str!` 在编译期钉自己的 oracle，临时工作区少这一层会让整个 crate
编译失败——于是**每个**变异都「被检出」，基线也一起红。第一次运行就是这样，那一轮结果毫无意义。
判据：日志里是 `error: couldn't read .../tests/helpers/...` 而不是断言失败。
同类脚本 `chat-replay-buffer-mutations.py` 早就复制了这个文件，新脚本照抄即可。

## 门禁

| 门禁 | 结果 |
|---|---|
| `rustfmt --edition 2021 --check`（本阶段两个新文件） | 通过。注意只能检查自己的文件：传 `lib.rs` 会遍历整个 crate，仓库里有 7 个文件带既有 rustfmt 欠账 |
| `cargo test --locked --offline --workspace -- --test-threads=1` | 通过 |
| `cargo clippy --locked --offline --workspace --all-targets -- -D warnings` | 通过 |
| `npm run test:governance` / `test:state` / `test:security` / `test:core` | 全部退出码 0 |
| `npm run test:integration:isolated` | 与变异集并行那一轮红 1 项（见下）；不并行单独重跑退出码 0 |
| `tests/test-ws-connection-router.js` | 22/22 |
| `tests/test-release-version-consistency.js` | 5/5，棘轮 468→469 条、388→389 deterministic、440→441 命令，算式写在断言上方 |

`test-dispatch-loop-isolated.js` 的 `D1: slave did not receive the dispatched message` 只在与变异集
并行跑（CPU 争用）那一轮出现；两个变体单独跑都退出码 0，整段 `test:integration:isolated` 不并行
重跑也退出码 0。与本阶段的改动没有接触面——该测试走
dispatch MCP 与 aux provider，同一轮日志里还有 `Aux Provider 不可用：provider not found` 的环境噪声。
按既有判定口径记为负载下的计时竞态，不是回归。

## 还需要 Node 的部分（`--no-node` 下 `/ws/chat` 为什么仍是 503）

拒绝点是 `native/gateway/src/forward.rs`：`/ws/chat` 的升级在 `upstream.node_absent()` 时直接走
`forward`，答 `503 node_runtime_absent`。准入迁完**不改变**这一点，因为前门拿到 socket 之后
没有人能回答回合的事：

| 仍在 Node | 规模 | 为什么不是这一刀 |
|---|---|---|
| 回合编排 `src/chat/` + `src/session-work/` | 16,996 行 | 整个产品的核心；含 `handleChatWs`（turn-engine.js 2,999 行） |
| CLI 进程拉起与流解析 | `chat-stream.js`、`codex-app-stream.js`、`turn-engine.js` 三处 spawn | 各 provider 的协议适配 |
| Claude SDK 车道 | `@anthropic-ai/claude-agent-sdk` 0.3.325 | **Node 包**，没有 Rust 等价物；要么重新实现协议，要么这条车道必须留一个 Node 进程 |
| 会话历史 | JSONL 读取 + `chat_history_index` 已有内核 | 可做，但是独立一刀 |
| 重放缓冲写侧与 `cs.clients` | 已在 addon 的 `RustWsHost` | 写入方是 Node 的 turn engine，要先有上面几行的 Rust 所有者 |

所以「`/ws/chat` 在 Node 缺席时端到端可用」不是一刀能到的终点。按依赖顺序，下一刀应是
**会话历史读取**（连接后前两帧 `chat_history` / `task_state` 的来源），因为它不依赖回合编排；
之后才是回合编排本身，而那一步必须先决定 SDK 车道怎么办。
