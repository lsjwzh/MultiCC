# /ws/chat 迁入 Rust 前门：阶段 1，冻结客户端可见契约（2026-11-20）

## 本阶段做了什么

在改动任何 `/ws/chat` 实现之前，先把 Node 终结的实现从客户端一侧能看到的全部行为冻结成可复跑的等价基线。
后续阶段（前门终结升级、鉴权、会话历史、回合编排）每一步都必须让这份基线保持不变。

| 产物 | 作用 |
|---|---|
| `docs/rust-migration/differential/capture-chat-ws-conformance.js` | 起真网关 + 真 Node 服务 + 假 Claude CLI（隔离数据根），逐场景观察升级状态、帧序、帧键集、小帧原文、关闭码与原因 |
| `docs/rust-migration/differential/chat-ws-conformance-golden.json` | 冻结的 19 个场景（13 KB），连续 4 次独立采集逐字节一致后落盘 |
| `tests/test-chat-ws-conformance.js` | 重新采集并与冻结文件逐场景比较；另外对新采集直接断言契约关键事实，防止有人随手重生成基线而削弱它 |
| `docs/rust-migration/differential/chat-ws-conformance-mutations.py` | 变异证明：基线通过，5 个改动客户端可见行为的变异全部变红 |

测试归 `core/isolated`（`npm:test:integration:isolated`），只用回环端口和隔离数据根。

## 冻结下来的契约（对后续迁移有约束力）

1. **拒绝发生在升级之后。** 所有拒绝都是 `101 Switching Protocols` 后立刻收到关闭帧 `4003 Forbidden`，不是 HTTP 4xx。
   前门终结时必须先完成握手再发关闭帧（`ws_machines.rs` 是同样做法）。覆盖：外部无凭据、错误 token、票据复用、票据路径不符、
   分享 token 未知、分享用于别的会话、需要密码的分享缺 cookie。
2. **外部与本机的区分。** 带转发头（如 `X-Forwarded-For`）的请求按外部处理，本机无凭据可进；
   外部可用旧式 `token`、一次性 `ticket`（路径绑定、只能用一次）或分享。
3. **缺会话。** 先发 `error{code:session_not_found}`，再发无状态码的关闭，客户端看到 `1005`。
   缺 `session` 参数时按 `_default` 解析，结果同上。
4. **任务壳开启时（`MULTICC_TASK_SHELLS=1`）**，任何不是 `typing` 的帧，若没带 `taskShell:true`，都回
   `error{code:task_shell_route_required}`；畸形 JSON 被静默忽略；`ping` 回 `pong`。
5. **分享权限。** `view` 分享的 `user_message` 被静默丢弃，`ping` 仍回 `pong`（心跳先于权限门）。
   `operate` 分享先用密码换 cookie，再在握手里带上；没有 cookie 就是 `4003`。
6. **一整轮的帧序只冻结锚点**：`task_shell_routed < stream_start < stream_event < assistant < result < stream_end`。
   轮次周围的 `task_state`、`session_queue`、`notify`、`provider_token_stats`、`api_error_policy`、`system/warning`
   的有无和位置在相同输入下也会变化（旧实现同样如此），所以这些不属于契约，也不应被后续实现去“模仿”。
7. **取消控制必须带 `taskId` 和 `turnId`**（取自 `stream_start` 帧），否则回 `error{code:invalid_control}`；
   带齐后回 `task_shell_routed{decision:cancel}`。
8. 空会话的连接突发是 `system/init → background_tasks → unattended_state → session_queue`，没有 `chat_history`。

## 终结 `/ws/chat` 需要的 Node 事实（实测盘点，下一阶段的输入）

升级后，Node 的连接路由与 `handleChatWs` 依次读取下列状态。前门接管升级就必须为每一项给出 Rust 所有者或宿主端口：

| 事实 | 现在由谁持有 |
|---|---|
| 关机中、公开对端是否允许（`lanOnly`） | Node `authSecurity` / `networkPolicy`，规则已在 Rust |
| 本机/外部判定、旧 cookie、旧 token | Rust 策略（`request-locality`、`auth_security`） |
| 一次性 WS 票据（含 `machineGrantId`、`fleetSessionId`、`correlationId`） | 网关已有 `auth_control`；`--no-node` 下本地 `AuthRuntime` |
| 分享访问（token + cookie → 权限与会话） | Node `share` 实例 |
| 电脑授权是否有效 | Node `machines.active` |
| 内部执行槽会话判定 | Node `persistedSessions` |
| 会话存在、类型、失效、任务壳作用域 | Node `persistedSessions`、`invalidSessions`、任务上下文宿主 |
| 连接突发里的初始化帧内容（模型、provider、token 窗口、CLI 状态…） | Node，依赖 attempt 运行时、provider 注册表、历史运行时 |
| 客户端帧的处理（取消、清空历史、投递消息） | Node `getSessionWorkHost()`、任务壳宿主 |

结论：升级与鉴权可以先迁，因为规则与票据已在 Rust；会话历史与回合编排的事实仍在 Node 进程内，
必须经一条前门↔Node 的双向通道（Node 把事件交给前门去广播与缓冲，前门把客户端帧交给 Node），
再逐块把这些事实挪成 Rust 所有者。这条通道是第 2 阶段起的主要工作量。

## 这一阶段没有做的事

- 没有改任何生产代码，没有改动 `/ws/chat` 的行为。
- 没有迁移任何路由，没有切 `--no-node`，没有删除 Node 源码、`package.json`、`node_modules`。
- 重放缓冲写侧与 `cs.clients` 所有权此前已迁入 addon 内的 `RustWsHost`（见
  `ws-chat-replay-ownership-report-2026-11-20.md`）；把它们再往前挪到前门进程，取决于上面那条通道。

## 门禁

见本阶段提交说明与最终迁移报告。
