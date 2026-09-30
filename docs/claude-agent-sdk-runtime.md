# Claude Agent SDK 常驻运行时

`claude-exp` 的聊天路径由 `chat-stream` 统一分派到 `claude-sdk-stream`。
首次发送时调用一次 `query({ prompt: AsyncIterable, options })`，之后的用户消息
写入同一个异步输入队列。主 `result` 事件结束当前 MultiCC 回合，不结束输入流。
SDK 启动的 Claude Code 子进程保持存活；SDK 输出循环继续接收后台任务事件。

```text
turn-engine → chat-stream → claude-sdk-stream → SDK Query → Claude Code
                              输入队列 ────────────→ stdin
                              interrupt / setModel → 控制协议
                              事件 / result ←─────── stdout
```

## 控制与回收

- 取消先调用 `Query.interrupt({ cancelQueued: true })`。只有收到回合结果、控制应答，
  且代理请求排空后，才释放当前发送；排队消息一并取消，迟到事件不会交给新回合。
- 中断在 3 秒内未完成时关闭 Query，并对捕获的进程句柄执行 SIGTERM / SIGKILL。
- 同 Provider 的模型切换在下一回合输入前调用 `setModel()`，无需重启进程。
- Provider、别名、子 Agent 路由、effort、角色提示词、工具/MCP 配置或轮数上限
  发生变化时，在回合边界回收并恢复同一原生 UUID。
- 默认空闲 10 分钟回收。活跃后台任务延后回收；后台持续无信号超过 2 小时仍会回收。
- transcript 裁剪调用现有 `recycle()`，有当前回合或后台任务时延后。
- 删除、休眠、切 CLI、关闭服务走同一生命周期接口。
  `closeAndWait()` 等待真实子进程退出；SDK 未成功返回过答案也可能已有原生历史，
  恢复判断沿用原生会话状态。缺失历史或身份不匹配不会自动换 UUID。

## 每轮代理凭据与常驻进程

CPR 的 URL 和令牌包含每次 attempt 的独立能力凭据，不能把上一轮的环境直接复用。
`claude-sdk-route` 为每个常驻 SDK 进程创建一个仅监听 `127.0.0.1` 的稳定入口：

1. Claude Code 持有随机的本地入口令牌。
2. 每轮输入前，入口绑定本轮确切的 CPR URL 和能力令牌。
3. 每个请求在开始时固定目标；有请求尚未排空时禁止换绑。
4. 转发只接受认证后的 Messages / count_tokens 请求，保持请求体和 SSE 字节原样，
   CPR 继续执行原有授权、主/子路由、用量归属和速率头处理。
5. 有后台任务时，host 阻止新受管回合抢占；运行器也拒绝重绑或回收。

非受管 Provider 路径直接使用原来的环境。SDK 启动配置使用权限为 0600 的临时文件，
避免把令牌放入 argv；会话路由覆盖本地 settings 的路由字段，进程退出后删除文件。
原来的单轮桥接入口保留给离线回归和兼容调用，正式聊天路径不再按消息调用它。

## 验证

`test-claude-sdk-stream.js` 使用真实 SDK、真实子进程和隔离的模拟 Messages 服务，
覆盖持续对话/工具历史、变化的 attempt 能力与归属、模型切换、协议中断、
中断超时、崩溃恢复、零成功回合历史、空闲与后台回收，以及进程/配置清理。
`test-claude-sdk-route.js` 验证认证、目标约束、请求固定、SSE 透传和断连清理；
`test-claude-sdk-host.js` 验证生产 host 分派及切后端时的退出等待。
这些测试不使用真实 Provider 凭据，也不重启运行中的 MultiCC 服务。
