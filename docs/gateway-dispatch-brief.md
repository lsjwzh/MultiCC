# Gateway 分派契约（MCP-only）

## 唯一入口

Gateway 与普通 chat 一样，只能通过会话内注入的 MultiCC Router MCP 跨会话派发：

- `route_task`：单向任务，不回传结果。
- `dispatch_master({ mode: "sync" })`：工具调用保持挂起，安全进度通过 MCP progress notification 返回，Worker 最终答复直接成为工具结果。
- `dispatch_master({ mode: "async" })`：持久登记后立即返回；Worker 必须调用 `dispatch_slave`，结果稍后作为新消息唤醒 Master。

旧的 `POST /api/sessions/:id/dispatch`、`/api/v1/...` 与文本 marker 均已删除，任何 marker 形文本只按普通文本处理。

## Gateway 行为

- 微信 Gateway：先自然语言复述目标与任务，等待用户明确确认；下一轮调用 `dispatch_master(mode="async")`。
- 实时语音 Router：用户已明确要求执行时可直接调用 `dispatch_master(mode="async")`；含糊的项目/会话目标必须先追问。
- 工具返回 `admitted` 和 `operation_id` 后，Gateway 才能声称任务已提交。
- Gateway 不解析 assistant 输出，不从自然语言推断“已经派发”。

## Async 不等待规则

Async Master 得到 admission 后，只能继续处理与 Worker 结果无依赖的工作，然后自然结束当前 turn。不得轮询 operation、读取 Worker 会话、调用 wait 或用其他方式同步等待。Worker 的 `dispatch_slave` 回执形成一条正常会话消息；调度器仅在 Master 处于 `P`（当前 turn 正执行）时暂存，turn 结束进入 `D`、`W` 或 `E` 后即可投递并唤醒。分派协议不制造 `B` 状态。

若 Async Worker 结束却没有调用 `dispatch_slave`，Host 将 operation 终结为 `missing_dispatch_slave` 失败，并把失败回执唤醒 Master；不会把普通最终文本误当作成功。

## Sync 规则

Sync Worker 不调用 `dispatch_slave`。Host 订阅该 operation 对应 Worker turn 的规范化事件，持续转发模型明确输出的 reasoning/thinking 增量、文本增量、安全工具名、心跳阶段和公开错误；工具输入、工具结果、thinking signature、redacted thinking、凭证及原始内部事件不会透出。Worker 最终 assistant 输出会完成 operation，并直接关闭原 MCP 调用，不插入新消息。

目标忙时，两种模式都进入持久 FIFO：Sync 继续挂起；Async 已经返回 admission，之后由结果消息唤醒。

## 验收不变量

1. 生产代码不存在公开 HTTP dispatch route，也不存在 marker 执行器。
2. `dispatch_master` 必须显式传 `mode`；Async 不接受 `timeout_seconds`。
3. Sync 最终结果不产生 `dispatch.result` outbox；Async 只接受同一 operation lineage 的 `dispatch_slave`。
4. Async 回执不会打断 `P`，但可从 `D/W/E` 启动新 turn。
5. operation、task board 与接收消息均保留真实发送者和 task lineage，重试由 idempotency key 去重。
