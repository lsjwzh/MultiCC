# Codex app-server 适配器可行性方案

> 研究结论于 2026-09-21 通过**真机活体探测**得出（本机 codex-cli 0.154.0），非文档推断。
> 所有数字与载荷片段都来自 `/tmp/codex-probe/*.jsonl` 的原始记录。

## 0. 一句话结论

`codex exec --json` 不是「spawn 模式的实现」，它是 **app-server 协议的一个有损导出器**；
multicc 现在为了补它丢掉的字段，额外维护了至少**四条补偿链路**（代理 delta 旁路、rollout 体积守卫、
reasoning 完整到达特判、断流续跑）。把 codex 链路的接缝从 `exec --json` 换成 **app-server JSON-RPC**，
可以让这些补偿机制**变成不必要**，同时拿到当前架构**在原理上不可能**有的能力（双向审批、中途 steer、原生中断）。

代价是接入一个 `[experimental]` 协议。因此方案是**分阶段 + 版本护栏 + 可回退**，不是切换。

### 0.1 实验实现状态（2026-09-21）

第一阶段已作为独立 Chat CLI `codex-exp` 落地，现有 `codex` 仍原样走 `exec --json`：

- 每轮启动 `codex app-server --listen stdio://`，首次 `thread/start`，续轮
  `thread/resume { excludeTurns: true }`，收到 `turn/completed` 后退出。
- `initialize` 强制 Codex `>=0.154.0`；不满足时本轮明确失败。回退方式是切回独立的
  `codex` CLI，不在同一轮静默改协议。
- 原生 assistant delta、reasoning delta、command/MCP tool 事件、token usage 与
  `item/tool/requestUserInput` 已投影到现有中性事件层。
- v1 保持与旧 Codex 相同的 `approvalPolicy: never`、`sandbox: danger-full-access`；
  交互审批和常驻双向 runner 留到下一阶段。
- `codex-exp` 与 `codex` 各自保存 native thread 状态，但复用同一个 Codex Provider / Responses 路由池。

## 1. 先纠正问题的框架

「不走 spawn，把自己当 TUI」这个提法里的**唯一变量搞错了位置**：

- 所有方案都是 spawn（tmux、node-pty、自实现终端、app-server 客户端，全部是 spawn 一个子进程）。
- 真正的变量是 **子进程 stdout 里装的是什么**：
  - 装结构化 JSON 事件 → chat 模式
  - 装终端转义序列 → terminal 模式（TUI）

所以「TUI vs chat UI」是**同一个事件流上的两个 renderer**，分叉点在 renderer，不在请求。
用户问的「codex 的数据源头是哪、tui 和 chatui 在哪里分叉」——答案是：数据源是 **app-server**，
TUI 和 `exec --json` 都是它的客户端；**分叉点在客户端**,不在 core。

## 2. 分叉点的源码级证据

### 2.1 exec 只是 app-server 的一个消费端

`codex-rs/exec/src/event_processor_with_jsonl_output.rs` 直接 `use codex_app_server_protocol::ServerNotification;`
——exec 内部接的就是 app-server 的通知流，然后**主动降维**再打印。

### 2.2 降维后的表面：8 个顶层事件

`codex-rs/exec/src/exec_events.rs` 中 `enum ThreadEvent` 只有 8 个变体：

```
thread.started  turn.started  turn.completed  turn.failed
item.started    item.updated  item.completed  error
```

对照 app-server 协议面（从 `codex app-server generate-json-schema` 导出，共 39 个 schema 文件）：

| 方向 | 变体数 |
|---|---|
| ClientRequest（客户端→服务端请求） | **99** |
| ServerNotification（服务端→客户端通知） | **81** |
| ServerRequest（服务端→客户端**双向请求**） | **10** |
| ClientNotification | 1（`initialized`） |

### 2.3 降维是「静默丢弃」，不是「有损编码」

`event_processor_with_jsonl_output.rs` 的 match 结尾是：

```rust
_ => CodexStatus::Running,
```

**兜底分支什么都不做**。凡是没被显式列出的通知，一律静默消失。这三条推论直接来自源码：

1. **没有 delta。** `ItemAgentMessageDelta`、`ItemReasoningSummaryTextDelta`、`ItemReasoningTextDelta`、
   `ItemCommandExecutionOutputDelta`、`ItemMcpToolCallProgress` 全部落到 `_` 分支。
2. **中断不产生任何事件。** `TurnStatus::Interrupted` 分支只做 `InitiateShutdown`，**不 push 任何 ThreadEvent**。
   而 `ThreadEvent` 枚举里**根本没有 `turn.aborted` 变体**。
3. **exec 必须自己编造终态。** 它调 `reconcile_unfinished_started_items()` 给「开始过但没收到完成通知」的条目
   补发 completed——因为进行中的更新本来就被丢了。

第 2 条在 multicc 里已经体现为一个**死分支**：`src/cli-adapters/codex.js:150-158`
的 `createCompletionTracker` 里处理 `event.type === 'turn.aborted'`，而 exec 永远不会发这个事件。

### 2.4 usage 也是被降维的

`TurnCompletedEvent { usage }` 里的 usage 来自 `self.usage_from_last_total()`——**turn 结束时取最后一个快照**。
中途的 `thread/tokenUsage/updated` 全部丢弃。

## 3. 活体探测：4 组实测

全部实测跑通，原始记录在 `/tmp/codex-probe/`。

### 3.1 探测 1：stdio 握手 + 一个最小 turn（`probe.mjs`）

`codex app-server --listen stdio://`，换行分隔 JSON-RPC。一个「Reply with exactly one word: PONG」的 turn，
**820ms 走完，16 条通知**：

```
[97ms]   RESP initialize ok
[212ms]  RESP thread/start ok
[216ms]  RESP turn/start ok
[791ms]  item/agentMessage/delta   delta="P"
[806ms]  item/agentMessage/delta   delta="ONG"
[813ms]  thread/tokenUsage/updated
[820ms]  turn/completed            status=completed durationMs=601
```

`thread/started` 一次就给出 exec 永远拿不到的一整套事实：

```json
{"thread":{"id":"01a0c3ad-d676-75a1-9e2b-b85279a8b21d",
 "sessionId":"01a0c3ad-d676-75a1-9e2b-b85279a8b21d",
 "path":"/Users/Zhuanz/.multicc/codex-attemp…",
 "historyMode":"paginated","modelProvider":"custom","model":"deepseek-v4-flash",
 "status":{"type":"idle"},"cliVersion":…,"originator":…,"gitInfo":…}}
```

`thread/tokenUsage/updated` 带 exec 拿不到的精度与字段：

```json
{"tokenUsage":{"last":{"totalTokens":15930,"inputTokens":15927,
  "cachedInputTokens":4224,"cacheWriteInputTokens":0,
  "outputTokens":3,"reasoningOutputTokens":0},
 "modelContextWindow":258400}}
```

### 3.2 探测 2：同进程多轮、原生中断、历史重建（`probe2.mjs`）

- `thread/shellCommand`（`source:"userShell"`）**免审批直接执行**，并**被包进一个合成 turn**
  （`turn/started` → `item/started` → `item/commandExecution/outputDelta` → `item/completed` → `turn/completed`）。
  也就是说「在会话里跑一条命令并把输出作为结构化事件流出来」是**现成的原生原语**。
- **同进程第二轮 `turn/start` 直接成功** —— 一个 app-server 进程贯穿整个会话，不需要 `exec resume`。
- `turn/interrupt` → 立刻收到 `turn/completed { status: "interrupted", durationMs: 921 }`
  （对照：exec 在这种情况下**什么事件都不发**）。
- `thread/read { includeTurns: true }` 完整重建出历史（`turn[0].items == ["commandExecution"]`），
  **不需要读 rollout 文件**。

### 3.3 探测 3：真实模型触发的双向审批（`probe3.mjs`）——最关键的一组

配置 `approvalPolicy: "untrusted"` + `sandbox: "read-only"`，让模型执行
`touch /tmp/codex-probe/proof.txt`（需要沙箱外写权限）。**通知普查**：

| 次数 | 通知 |
|---|---|
| **108** | `item/reasoning/textDelta` |
| **23** | `item/agentMessage/delta` |
| 1 | `item/commandExecution/requestApproval` ← **ServerRequest** |
| 1 | `serverRequest/resolved` |
| 2 | `thread/tokenUsage/updated` |
| 2 | `warning` |

审批请求的完整载荷（注意 `reason` / 可选项 / 策略修正建议都是**结构化字段**）：

```json
{"kind":"command","itemId":"call_00_omVxQ7UBhPdUcTEPtHXN6347",
 "reason":"Creating /tmp/codex-probe/proof.txt requires write access beyond the read-only sandbox.",
 "command":"/bin/zsh -lc 'touch /tmp/codex-probe/proof.txt'",
 "commandActions":[{"type":"unknown","command":"touch /tmp/codex-probe/proof.txt"}],
 "proposedExecpolicyAmendment":["touch","/tmp/codex-probe/proof.txt"],
 "availableDecisions":["accept",
   {"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["touch","/tmp/codex-probe/proof.txt"]}},
   "cancel"]}
```

客户端回 `{decision:"accept"}` 后 **`proof.txt` 真的被创建**（`fs.existsSync` 为 true），
turn 以 `status: completed, durationMs: 2292` 收口。
→ **双向控制面不是设计意图，是实测跑通的行为。**

### 3.4 探测 4/5：多客户端与 transport（`probe4.mjs` / `probe5.mjs`）

这一组**部分失败，但失败本身是有价值的硬约束**：

- `codex app-server daemon start` → `managed standalone Codex install not found at
  $CODEX_HOME/packages/standalone/current/codex`。daemon 只认 installer 的托管布局，
  **homebrew / npm 安装的 codex 用不了**。
- multicc 的 per-attempt CODEHOME 命名会让 control socket 路径长达 **170 字符**，
  超过 macOS `SUN_LEN`（~104）→ 报 `path must be shorter than SUN_LEN`。
  即使有 standalone 布局，**当前 attempt-home 命名也必然踩这个坑**。
- `--listen unix://PATH` **能绑定成功**（但必须先建真实目录：macOS 的 `/tmp` 是符号链接，
  会被 `socket directory path exists and is not a directory` 拒绝）。
- UDS 上跑的**不是**裸 JSON-RPC：acceptor 里是 `accept_hdr_async_with_config(...)`
  ——**WebSocket over Unix socket**。所以裸换行 JSON 连不上（实测 `initialize` 超时）。
  `codex app-server proxy` 正是 stdio ↔ control socket 的桥，**这一层不需要我们实现**。

## 4. 能力对比（exec vs app-server）

| 能力 | `exec --json` | app-server | 依据 |
|---|---|---|---|
| 助手文本流式 delta | ❌ 丢弃 | ✅ `item/agentMessage/delta` | 源码 `_ =>` + 探测 1/3 |
| 推理过程流式 | ❌ 丢弃 | ✅ `item/reasoning/{textDelta,summaryTextDelta,summaryPartAdded}` | 探测 3：单 turn 108 条 |
| 工具输出流式（bash 边跑边出） | ❌ 只有 `aggregated_output` | ✅ `item/commandExecution/outputDelta` | 探测 2 |
| MCP 调用进度 | ❌ 丢弃 | ✅ `item/mcpToolCall/progress` | 源码 `_ =>` |
| turn 边界 | ✅ `turn.completed` | ✅ `turn/completed`（带 `durationMs`） | 探测 1 |
| **中断可见性** | ❌ **完全无事件** | ✅ `status:"interrupted"` | 源码 + 探测 2 |
| token usage | ⚠️ 仅 turn 末快照 | ✅ 回合中 + `modelContextWindow` + reasoning tokens | 探测 1/3 |
| **双向审批** | ❌ 不可能（只能 `--dangerously-bypass-approvals-and-sandbox`） | ✅ 10 个 ServerRequest | 探测 3 |
| 结构化提问（ask/AskUserQuestion） | ❌ 需 hack 解析 function_call | ✅ `item/tool/requestUserInput` | `codex.js:254` 注释 |
| 中途 steer（turn 进行中插话） | ❌ | ✅ `turn/steer`（含 `expectedTurnId`） | 协议面（**未实活体验证**） |
| 中断 | ❌ 靠杀进程 | ✅ `turn/interrupt` | 探测 2 |
| 历史重建 | ❌ 重放 rollout 文件（会挂） | ✅ `thread/read {includeTurns}` | 探测 2 |
| 会话存活跨客户端 | ❌ 进程即会话 | ✅ thread 在服务端 | 探测 2（同进程两轮） |
| 结构化告警 | ⚠️ 折成文本 | ✅ `warning`/`configWarning`/`deprecationNotice` | 探测 1/3 |
| liveness | ❌ 靠进程存活猜 | ✅ `thread/status/changed`（idle/active） | 探测 1/3 |
| 模型重路由/校验/鉴权恢复 | ⚠️ 部分折成文本 | ✅ `model/rerouted`/`model/verification`/`modelProvider/authRecovery*` | 协议面 |
| 会话元数据（改名/目标/队列/压缩） | ❌ | ✅ `thread/name|goal|queue/…`/`thread/compacted` | 协议面 |

## 5. multicc 现状：为 exec 的损失付了哪些补偿成本

| 位置 | 规模 | 存在理由 | app-server 下 |
|---|---|---|---|
| `src/providers/router-port.js:447-452` + `src/codex/official-relay.js:318-320` + `src/chat/proxy-broadcast.js:65` | 跨 3 文件 | **纯为补 codex 丢失的 delta**（注释原文：让 codex turn 增量渲染而不是等 `item.completed`） | 可下线 |
| `src/chat/codex-rollout-guard.js` | 232 行 | `exec resume` 前先量 rollout 体积（440MB rollout 会让它静默挂死） | 待验证后退役 |
| `src/chat/turn-engine.js:860` | — | 注释原文「codex reasoning arrives complete (no partial stream)」特判 | 可删特判 |
| `src/cli-adapters/codex.js:150-158` | — | `turn.aborted` 分支（**exec 永不产生，已是死代码**） | 可删 |
| `src/chat/chat-stream.js` | 678 行 | 常驻进程 + `--resume` 重生 + resume 目标丢失恢复 | **仅服务 claude** |
| `turn-engine` codex 断流续跑（`codexStreamDisconnectContinuePrompt` / `…_MAX`） | — | 补偿 exec 无 during-turn 信号 | 可简化 |
| `src/cli-adapters/codex.js:167-186` | — | `exec … --json --dangerously-bypass-approvals-and-sandbox` + `resume <id>` | 替换点 |

一个值得注意的**不对称**：multicc 已经为 Claude 实现了正是用户描述的那套架构
（`chat-stream.js`：spawn 一次、stdin 写消息、**turn 边界取事件而非进程退出**）。
codex 侧缺的不是「新架构」,而是**把同一架构接到 CLI 自己提供的那条正规缝上**。

## 6. 81 个 ServerNotification → multicc 中性事件映射

multicc 现有的中性词表（`src/cli-adapters/codex.js` 的 `decodeEvent` 产出）：
`session_started` / `assistant_text` / `thinking` / `tool_start` / `tool_result` /
`user_input_signal` / `error` / `complete`。

### 6.1 直接映射（第一批实现范围）

| app-server 通知 | → 中性事件 | 备注 |
|---|---|---|
| `thread/started` | `session_started` | thread id 即原生 session id；附 `path`/`cliVersion`/`historyMode` |
| `thread/status/changed` | `activity` | **新能力**：真 idle/active |
| `turn/started` | turn open（记 `turnId`） | exec 也有，但无 turn id |
| `item/agentMessage/delta` | `assistant_text`（增量） | **替换代理旁路** |
| `item/started`/`item/completed`（`agentMessage`） | `assistant_text` open/close | |
| `item/reasoning/textDelta`、`summaryTextDelta`、`summaryPartAdded` | `thinking`（增量） | **替换整块特判** |
| `item/started`/`item/completed`（`reasoning`） | `thinking` open/close | |
| `item/agentMessage/delta` / `agentMessage` 的 `phase`/`memoryCitation`/`questions` | 前端卡片字段 | 现有 `phase` 语义可直接复用 |
| `item/started`（`commandExecution`） | `tool_start{Bash, command, cwd, source}` | 比 exec 多 `commandActions`/`source(agent\|userShell)` |
| `item/commandExecution/outputDelta` | 工具实时输出 | **新能力** |
| `item/completed`（`commandExecution`） | `tool_result{exitCode, durationMs, aggregatedOutput}` | |
| `item/commandExecution/terminalInteraction` | 交互式 tty 提示 | 新能力 |
| `item/started`/`item/completed`（`fileChange`）、`item/fileChange/patchUpdated`、`outputDelta` | 编辑卡 + 实时 diff | |
| `item/started`/`item/completed`（`mcpToolCall`）、`item/mcpToolCall/progress` | MCP 工具卡 + 进度 | |
| `item/started`/`item/completed`（`collabToolCall`） | 子 Agent 卡 | |
| `turn/plan/updated`、`item/plan/delta` | 计划/todo | |
| `turn/diff/updated` | 实时 diff | |
| `thread/tokenUsage/updated` | `usage` | 含 `modelContextWindow`/reasoning tokens |
| `turn/completed` | `complete{status,error,durationMs}` | 终态唯一真源 |
| `error` / `warning` / `guardianWarning` / `configWarning` / `deprecationNotice` | `error` / 告警面 | 结构化，不再是文本 |
| `model/rerouted` / `model/verification` / `modelProvider/authRecovery*` | provider 切换/鉴权提示 | |
| `serverRequest/resolved` | 审批卡 dismiss | 跨端去重可直接复用现有机制 |
| `item/autoApprovalReview/{started,completed}`、`autoApprovalReview/strictReviewRequired` | 自动审查卡 | 新能力 |
| `thread/compacted` | 压缩提示 | |
| `thread/name|goal/…`、`thread/queue/changed`、`thread/project/updated`、`project/changed`、`skills/changed` | 元数据/队列 UI | |
| `mcpServer/startupStatus/updated`、`mcpServer/event/stream/notification` | MCP 控制面健康 | |
| `account/rateLimits/updated`、`account/updated` | 配额（与 CRP 代理侧信道可互校） | |
| `thread/environment/connected\|disconnected`、`fs/changed`、`hook/*` | 环境/文件/hook 卡 | |
| `process/outputDelta`、`process/exited` | 后台进程监管 | |
| `command/exec/outputDelta` | 客户端发起命令的流 | |

### 6.2 10 个 ServerRequest → multicc 等待/审批路径

| ServerRequest | → 归宿 | 优先级 |
|---|---|---|
| `item/tool/requestUserInput` | **`user_input_signal`**（原生结构化提问） | P0 — 直接替掉 `codex.js:254` 的 function_call hack |
| `item/commandExecution/requestApproval` | 审批卡（可选 accept / acceptWithExecpolicyAmendment / cancel） | P0 — 已实测 |
| `item/fileChange/requestApproval`、`applyPatchApproval` | 补丁审批卡 | P1 |
| `execCommandApproval` | 遗留 exec 审批 | P2 |
| `item/permissions/requestApproval` | 权限档位升级卡 | P1 |
| `mcpServer/elicitation/request` | MCP elicitation（可复用 `wait_for_user_answer` 形态） | P1 |
| `item/tool/call` | 客户端动态工具执行 | P2 |
| `account/chatgptAuthTokens/refresh` | token 刷新 | P1 |
| `attestation/generate` | attestation | P2 |

### 6.3 明确不纳入 Chat 范围

`thread/realtime/*`（13 个，语音/实时）、`windows/*`、`windowsSandbox/*`、
`externalAgentConfig/import/*`、`app/list/updated`、`mcpServer/oauthLogin/completed`、
`fuzzyFileSearch/*`、`remoteControl/status/changed`。

## 7. 迁移方案

### 7.1 接入形态（按落地顺序）

1. **stdio + `codex app-server proxy`**：`proxy` 是现成的 stdio ↔ control-socket 桥，
   multicc 侧继续用「spawn + 读 stdout JSONL」的既有管道，**改动面最小、可先跑通**。
2. **`unix://` 自有 socket**：multicc 自己监管一个长命 app-server（每会话或每目录一个），
   客户端断开后重连即恢复。**socket 目录必须短**（见 §8.2），绝不能放在 attempt-home 里。
3. **(可选) `ws://127.0.0.1:PORT`**：跨进程/跨目录复用同一 app-server；
   非 loopback 需要 `--ws-auth capability-token | signed-bearer-token`。

### 7.2 不变量（与现有架构对齐）

- 一个 app-server 进程 = 一个会话执行体；thread id 直接作为 `cliSessionId` 落库。
- turn 边界取 `turn/completed`（与 claude 侧 `stream-json` 的 `result` 同构）。
- 审批走既有 `user_input_signal` 等待/去重/跨端 resolve 通道（`session-work-host` 的
  `resolveUserInput` 机制可原样复用）。
- app-server 进程随 multicc 会话生命周期管理；**不做自动重启**（遵守现有重启纪律）。

### 7.3 护栏与回退

- **协议版本护栏**：`initialize` 后必须做能力探测（`experimentalFeature/list` /
  关键 method 存在性），不满足即**本轮回退 exec**，绝不假设。
- **特性开关**：adapter 级别 `codex-app-server` vs `codex-exec`，默认保持现状，
  影子观察后再切。回退路径必须始终可用（`exec resume` 保留）。
- **失败可见**：app-server 握手/协议错要落成结构化 error，不能静默降级成「看起来正常」。

### 7.4 清理顺序（每一刀都要有证据）

| 阶段 | 动作 | 前置证据 |
|---|---|---|
| 1 | 接 app-server，双跑（exec 保留） | 本文档 |
| 2 | delta 走原生，**下线代理 delta 旁路** | 官方 OAuth + 自定义 provider 两路都验过 |
| 3 | 删 `turn.aborted` 死分支、删「reasoning 完整到达」特判 | 已是死代码 |
| 4 | 退役 `codex-rollout-guard` | 证明 resume 不再重放 rollout 文件 |
| 5 | 简化断流续跑 | app-server 的 during-turn 信号能覆盖 |

## 8. 风险与未决问题

### 8.1 `[experimental]` 是真实风险
`codex app-server` 自带 `[experimental]` 标记，协议可能随版本变动。
**必须**版本护栏 + 能力探测 + 可回退，不能把它当稳定 API。

### 8.2 硬约束：socket 路径长度与 attempt-home 命名
- 实测：multicc 的 per-attempt CODEX_HOME 命名让 control socket 路径达 **170 字符**，
  超 macOS `SUN_LEN`（~104）→ 直接失败。
- `daemon` 还需要 installer 托管布局（`$CODEX_HOME/packages/standalone/current/codex`），
  **homebrew/npm 版 codex 没有**。
- 结论：**daemon 通道在当前安装形态下不可用**；要走 §7.1 的第 1/2 条，
  并把 socket 放在短路径下（如 `~/.multicc/as/<短哈希>.sock`）。

### 8.3 未做活体验证的点（不要当成已成立）
- `turn/steer` 中途注入（`expectedTurnId` 语义、竞态行为）
- MCP 注入：`-c mcp_servers.multicc_router.*`（含 `required=true` 启动语义）在 app-server 下是否等价
- 官方 OAuth provider 路径（本次探测走的是本地自定义 provider `deepseek-v4-flash`；
  协议层与 provider 无关，但 **delta/usage 的 provider 行为要另验**）
- 图像/vision 输入（`localImage`）、`outputSchema` 结构化输出
- `thread/resume` 在 app-server 下与 `exec resume` 的等价性与成本
- 长会话 compaction、rollout 增长在 app-server 下的表现

### 8.4 行为变更需要用户决策
- 现在 codex 是 `--dangerously-bypass-approvals-and-sandbox`（**全绕过**）。
  接 app-server 后审批**变得可用**，是否启用、默认策略是什么，是产品决策而非技术决策。
- 服务端 thread 不会像本地进程那样「空闲即回收」，
  `chat-stream.js` 的 warm/idle-recycle 语义需要重新定义。

### 8.5 副作用记录
- 探测消耗了少量真实配额（4 个 turn，其中 3 个极小）。
- 探测过程中起过一个 app-server 进程，已 `SIGKILL` 清理；`/tmp/cxs`、`~/.cxsock` 为探测残留。

## 9. 建议

1. **接受结论**：接缝应该是 app-server JSON-RPC，不是抓屏、不是自实现终端。
   TUI 是渲染器，不是事实源——`exec --json` 已经证明了降维会静默丢弃：81 个通知变体里只有少数几个
   被投影成它自有的 8 个事件，其余全部落到 `_ => CodexStatus::Running`。
2. **先做 P0 的两件事**（收益最直接、风险最低）：
   `item/agentMessage/delta` + `item/reasoning/*/textDelta` 替掉代理旁路；
   `item/tool/requestUserInput` 替掉 `AskUserQuestion` 的 function_call hack。
3. **不要一次切换**：exec 保留为回退，版本护栏先于功能。
4. **把 §8.3 的未验证清单当作开工前置**，尤其是 MCP 注入与官方 OAuth 两路。

---
*探测脚本与原始记录：`/tmp/codex-probe/{probe,probe2,probe3,probe4,probe5}.mjs`、`*.jsonl`。
协议 schema 导出：`/tmp/codex-proto/`（39 文件）。codex 源码：`/tmp/codex-research/codex`。*
