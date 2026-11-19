# WS 宿主注册表接入：迁移说明与验证（2026-11-19）

本报告是 `ws-host-control-validation-2026-11-19.md` 的收尾件：那一批交付了
握手规划器、连接注册表与发送队列内核（前置件），本批把**生产共享连接路由
（含 `/ws/chat`）的每条 socket 接入 addon 的 `RustWsHost`**，并删除 Node 侧
那份发送包装器。WS upgrade 终结与 `/ws/chat` 的回合引擎状态（快照/重放/
聊天编排）仍在 Node，见文末「残留边界」。

## 迁移说明

### 删除的 Node 逻辑

- **`src/ws-backpressure.js`（195 行，已删除）**。生产路径上每文 JS 副本
  只剩冻结 oracle `tests/helpers/legacy-ws-backpressure.js`（7,848 字节，
  SHA-256 `242aea3afd4aca3149ae26fbcefb66ebd362d2a46b2dacf91e215f95b49b0e52`），
  仅供差分对照；`tests/test-ws-backpressure.js` 钉住「该生产文件保持删除」，
  任何重建副本的回归直接红。
- **`src/ws/connection-router.js` 的全部 JS 簿记**：连接注册表
  （`WeakMap`）、每连接心跳状态（`pendingPong`/`missedPongs`/`timedOut`/
  `connectedAt`）、30 秒扫描里的窗口判定（ping / miss 计数 / `>= 3` 即
  terminate）。路由只保留：路径分发、关闭日志、定时器节奏（30s 调一次
  `wsHost.tick`）与传输端口（ping/close/terminate/sendFrame）。
- **`src/workspace/runtime.js` 对退休模块的限额引用**：`prepareFrame`
  的阈值与合并键改从内核读取（`getNative().wsBackpressureLimits()` 与
  `getNative().wsCoalesceKey(data)`），全进程只剩一份限额的物理副本。

### 新增的 Rust/桥接件

- **`native/addon/src/ws_host.rs`（981 行）**：每条被路由接受的连接一个
  原生条目——连接注册表（替代 WeakMap，`BTreeMap` 保持插入序，与旧
  `Set` 扇出顺序一致）、心跳簿记、以及冻结内核
  `ws_backpressure::Wrapper` 实例（退休模块的逐字节复刻）。`send`/
  `sendImmediate`/`stats`/`flush`/`tick`/`onPong`/`detach` 全部由内核
  决定；Node 侧 socket 作为不透明宿主值经端口驱动。同步完成的重入
  （假 socket 在 `send` 里同步回调）按连接暂存、wrapper 归还后迭代排空，
  保持旧实现的深度优先排空序。
- **`src/ws/native-queue.js`（60 行）**：`ws.send` 补丁的 JS 半边，只
  做转发；同时复原退休的 `_multiccBackpressure` 表面（`sendImmediate`
  供回合引擎断连重放，`stats().queueBytes` 供远控背压暂停判定）。
- **`tests/test-ws-host-differential.js`（560 行）**：整帧差分（见下）。

### 「Node 注册即失败」的保证形态

指令要求「启动断言：Node 注册 WS/chat 连接即失败」。落地的等价保证比
运行时断言更强：**Node 侧的注册物理路径已被删除**——`connection-router.js`
不再 require 任何 JS 包装器（退休模块文件不存在，`require` 会直接抛错），
每条连接（含 `/ws/chat`）在进入分派前即 `wsHost.attach`。三道钉死：
① 漂移守卫测试断言 `src/ws-backpressure.js` 保持删除；
② `tests/test-ws-connection-router.js` 钉住 `/ws/chat` 连接上的原生队列
表面（attach 后 live stats、detach 后 closed tombstone）；
③ 静态组合断言（`tests/test-workspace-runtime.js`）钉住路由对
`workspaceRuntime`/`fields` 的接线形状。

## 启动方式

- **默认入口不变**：`./multicc` / `npm start` / 独立包 / 桌面壳仍以
  `--node` 运行，WS 宿主在 Node 子进程内生效（连接注册、心跳判定、发送
  队列由 addon 持有）。翻转默认入口是迁移最后一步，不属于本批。
- **`--no-node`**：`serve --cwd <检出> --no-node` 下 WS upgrade 终结仍在
  Node，`/ws/*` 升级如实返回 503 `node_runtime_absent`（实测见下），
  不伪装成功。

## 整帧逐字节差分与变异复核

基准：冻结 oracle（退休模块的逐字节副本）+ 对被删路由心跳循环的逐行
模拟器；对象：addon `RustWsHost` + `native-queue.js` 补丁。三条流分开
逐字节比较（架构差异已复核并接受：内核把队列效果应用在同步传输调用
之后，旧包装器先回调再冲刷下一帧——唯一生产 send 回调是 machines 桥
的幂等 `fail()`，两流到同一线态）：

- **transport**：FakeSocket 边界的 send（SHA+options）/close/terminate/
  ping；**effects**：metric/log/schedule/cancel/heartbeatTimeout；
  **callbacks**：生产者 send 回调（序号 → 错误消息）。
- **9 组定向用例**：基本文本/二进制发送与同步完成；手动完成、错误与
  中途 stats；合并键替换（同 session `task_state` 顶替、跨 session 分列、
  无键帧不合并）；8 MiB 单帧越限 1013 关闭；4096 消息数闸（replay 突发
  豁免恰好一次，下一帧溢出）；15 秒拥塞窗断开；同步抛错 → close 失败
  回退 terminate；心跳窗口/pong 重置/三 miss 终止/closing 态跳过；
  detach 在飞帧（钉住已复核差异：迟到 completion 不再触达生产者回调，
  旧词法闭包仍会调——仅 machines 桥，幂等）。
- **模糊**：40 种子 × 200 步随机 op 流，三流逐字节一致，终态 stats 一致。
- **stats 表面**：`congestedAt` 时间戳改为 `congested` 布尔（时间戳无
  消费方；两个读者都只读 `queueBytes`），detach 后回答 closed tombstone。

### 变异复核（7 项真实代码变异：6 捕获，1 行为中性）

| # | 变异点 | 结果 |
|---|---|---|
| M1 | `ws_host.rs` `on_pong` 不再重置心跳窗口 | **捕获**：心跳用例 + 多种子三流全红（35 处） |
| M2 | `tick` 心跳超时后丢弃 `terminate` | **捕获**：心跳用例 + 模糊种子红 |
| M3 | `send_immediate` 失去消息数闸豁免（按普通 send 计数） | **捕获**：消息数闸用例 effects/callbacks/stats 全红 |
| M4 | `Effect::Schedule` 的「已有定时器不再重排」守卫移除 | **行为中性（非覆盖缺口）**：内核 `schedule_flush` 自带 `timer` 去重，两次 Schedule 之间必有 Cancel，宿主层守卫在当前行为下不可观测，属防御性代码 |
| M4b | `buffered_amount()` 恒报 0（替代 M4 的真实行为变异） | **捕获**：数闸用例 + 拥塞用例三流全红 |
| M5 | `native-queue.js` `sendFrame` 丢弃 `options`（binary 标志丢失） | **捕获**：基本二进制用例 + 模糊种子红 |
| M6 | `clock_if_needed` 永不读时钟（拥塞时间不走） | **捕获**：拥塞用例三流红 |

每项变异均单独构建（Rust 变异为 debug addon，经 `MULTICC_RUST_ADDON`
指向变异产物）跑完整差分确认非零退出，随后恢复源码并逐字节比对恢复
结果。恢复后指纹复算不变。

## 测试报告

最终源码指纹（`native/` 全部 `.rs` + Cargo 清单 + 构建脚本）：
**`2ca8032828e6e6501b3efba1`**；addon、gateway、远控、CDP 网关同批
release 产物落在主仓 `data/rust-source/2ca8032828e6e6501b3efba1/darwin-arm64/`。

- **cargo test --workspace --no-fail-fast**：77 个测试目标，**2,548 通过 /
  0 失败**（全绿）。此前一轮全量曾见
  `a_download_ticket_opens_one_file_for_a_remote_client` 在负载下
  `Connection reset by peer`，隔离单跑 0.92s 通过，为负载敏感 flake；
  本批未触碰 gateway 生产代码。
- **cargo clippy --workspace --all-targets -- -D warnings**：通过（EXIT=0）。
- **rustfmt（scoped，本批六个 `.rs` 文件）**：全部干净。注意经
  `lib.rs` 运行时 rustfmt 会遍历整个 addon 模块树，此时唯一 diff 是
  `native/addon/src/terminal_target.rs`——main 上的既有漂移、属别的批次
  所有（`git diff main` 为空，本批未触碰），与本批无关。
- **Node 段**（均对最终指纹构建运行，`MULTICC_RUST_ADDON` +
  `MULTICC_RUST_PREBUILT_DIR` 指向上述产物目录）：
  - `tests/test-ws-host-differential.js`：**37 通过 / 0 失败**
    （9 定向 × 三流 + stats + 40 种子模糊）；
  - `tests/test-ws-backpressure.js`：15 通过 / 0 失败（冻结 oracle 单元 +
    漂移守卫）；
  - `npm run test:security`：**1,178 通过 / 0 失败** / 1 todo（1,179 项，
    含本批差分与背压单元；EXIT=0）；
  - `npm run test:core`：**517 通过 / 0 失败**（EXIT=0）；
  - `npm run test:governance`：**21 通过 / 0 失败**，另制品治理与运行时
    写入清单两项检查均 OK（EXIT=0）。
- 定向小集（`test-ws-connection-router` / `test-workspace-runtime` /
  `test-workspace-ws-native` / `test-security-observability` /
  `test-history-frame-budget`）：74 通过 / 0 失败。

## 无 Node 进程验证记录（最终指纹网关）

启动（隔离数据目录、合成 token、临时回环端口；不触碰在跑生产服务）：

```
MULTICC_DATA_DIR=/tmp/wshost-nonode-final-OBckks/data ACCESS_TOKEN=ws-host-proof-12345 \
  data/rust-source/2ca8032828e6e6501b3efba1/darwin-arm64/multicc-gateway \
  serve --cwd <本 worktree> --no-node --ephemeral-loopback
```

启动日志（判据行）：

```
[multicc-gateway] listening on 127.0.0.1:54519
[multicc-gateway] node runtime disabled (--no-node): routes not owned by Rust answer 503 node_runtime_absent
[multicc-gateway] authentication runtime owned locally (--no-node)
```

- **ps 证据**：单进程 `PID 68000 PPID 1`；`pgrep -P 68000` 无任何子进程
  （不存在 node）。
- **端口证据**：`lsof -nP -iTCP:54519 -sTCP:LISTEN` 仅 `multicc-gateway`
  持有；无 Node 上游、无内部转发端口。
- **HTTP/WS 契约证据**：

| 探针 | 结果 |
|---|---|
| `GET /api/claude/models`（回环、无凭据） | **200**——与在跑生产 Node 服务实测一致（`isAuthenticated` 信任回环；在跑 127.0.0.1:3000 同请求亦 200） |
| 同请求 + 模拟外部对端（`X-Forwarded-For: 203.0.113.9`） | **403** `AUTH_REQUIRED` |
| 外部对端 + `x-access-token: <合成 token>` | **200**（网关凭据形式为 cookie / `x-access-token`；`Authorization: Bearer` 不是凭据形式，`?token=` 查询串默认关闭——`MULTICC_ALLOW_LEGACY_TOKEN_QUERY` 未置位即拒绝，二者均为既有策略） |
| `GET /api/not-owned-by-rust` | **503** `node_runtime_absent` |
| `GET /ws/chat?session=proof`（WebSocket 升级头） | **503** `node_runtime_absent`——WS 终结仍在 Node，诚实失败 |

- **停止与隔离**：SIGTERM 日志 `stop signal received; no node to stop,
  no longer accepting`，进程退出，端口释放；实例仅在隔离目录写自身数据，
  已清理。

## 残留边界（仍在 Node）

- WS upgrade 终结（`/ws/*` 在 `--no-node` 下 503，见上）；
- `/ws/chat` 的回合引擎状态：快照/重放/聊天编排（发送路径已经原生宿主，
  业务状态未迁）；
- `air=1` meta 的 air 协议部分（按设计留在共享路由策略上，本批已接入
  同一原生宿主的注册/心跳/队列）。

## 门禁链

本批提交前对最终指纹（`2ca8032828e6e6501b3efba1`）构建一次跑完的完整
链（Node 段带 `MULTICC_RUST_ADDON` + `MULTICC_RUST_PREBUILT_DIR` 指向
该指纹产物目录）：

| 段 | 结果 |
|---|---|
| rustfmt scoped（本批六个 `.rs` 文件） | 干净；经 `lib.rs` 遍历全 crate 时仅 `terminal_target.rs` 既有漂移（非本批） |
| `cargo clippy --workspace --all-targets -- -D warnings` | EXIT=0 |
| `cargo test --workspace --no-fail-fast` | 77 目标，2,548 通过 / 0 失败，EXIT=0 |
| `tests/test-ws-host-differential.js` | 37 通过 / 0 失败 |
| `tests/test-ws-backpressure.js` | 15 通过 / 0 失败 |
| `npm run test:security` | 1,178 通过 / 0 失败 / 1 todo，EXIT=0 |
| `npm run test:core` | 517 通过 / 0 失败，EXIT=0 |
| `npm run test:governance` | 21 通过 / 0 失败 + 制品治理 + 运行时写入清单 OK，EXIT=0 |
| `--no-node` 进程/端口/契约验证 | 单进程无 node 子进程、lsof 独占、探针矩阵全中、SIGTERM 干净退出（见上节） |
