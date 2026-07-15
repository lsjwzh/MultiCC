# Claude 子 Agent 跨 Provider 路由

## 结论

Claude Code 原生允许给子 Agent 指定 `model`，但没有给单个子 Agent 指定
`provider` 或 `ANTHROPIC_BASE_URL` 的配置项：

- `CLAUDE_CODE_SUBAGENT_MODEL` 的优先级高于 Agent 定义里的 `model`。
- `ANTHROPIC_BASE_URL` 是整个 Claude CLI 进程的网关地址，不是 Agent 级配置。
- 子 Agent 在同一个 CLI 进程内发起独立的 Messages API 请求。

参考：

- [Claude Code 子 Agent 模型选择](https://code.claude.com/docs/en/sub-agents#choose-a-model)
- [Claude Code 环境变量](https://code.claude.com/docs/en/env-vars)
- [LLM Gateway 配置](https://code.claude.com/docs/en/llm-gateway)
- [Claude Code usage tracing](https://code.claude.com/docs/en/monitoring-usage)

因此 MultiCC 使用单个本地 Messages API 网关，而不是尝试在子 Agent 启动时
替换进程环境。

## 请求链路

1. Claude session 启动时，MultiCC 把 `ANTHROPIC_BASE_URL` 指向：
   `/claude-proxy/<mainProvider>/<sessionId>`。
2. 主请求保持普通 model，代理按 URL 中的 `mainProvider` 转发。
3. 配置子 Agent override 后，MultiCC 设置：
   `CLAUDE_CODE_SUBAGENT_MODEL=ccfw:<subProvider>:<model>`。
4. 子 Agent 请求携带该 model；代理解析 provider、恢复真实 model，并转发到子 provider。
5. provider tier（`opus`、`sonnet`、`haiku`、`fable`）在代理中映射为该
   provider 的 wire model；`[1M]` 等 CLI 后缀不会发送给上游。

真实 provider key 只保存在 MultiCC provider store。Claude 子进程只拿到本地代理
地址和无外部用途的虚拟 token。

## Token 归属

Claude CLI 的最终 `result.usage` 会合并主线程和所有子 Agent，不能用于 provider
拆分。`claude-proxy` 在每个 upstream response 上旁路解析 usage：

- SSE：读取 `message_start.message.usage` 和 `message_delta.usage`。
- 非流式 JSON：读取顶层 `usage`。
- 归属维度：`sessionId + role(main/sub/aux) + providerId + wire model`。
- 当前回合：保存在 `role-token-tracker` 内存 snapshot，推送 `role_token_stats`。
- 持久统计：按本地日期写入 `token_by_role.json` 的 `main/sub/aux/provider` 分桶；
  Aux 不会污染 CLI 主线程统计。

只有 2xx response 会计量；上游 429/5xx 重试不会被当作成功 token 重复累计。

## 测试方案

### 离线契约测试

```bash
npm run test:subagent-routing
```

测试使用两个本地 mock Anthropic upstream，不需要真实 key，覆盖：

- `ccfw` 编解码和畸形输入拒绝。
- 主/子请求进入不同 provider、path 和鉴权头。
- tier 映射、`[1M]` 后缀剥离和 Content-Length 重算。
- SSE 分片透传与 usage 解析。
- 非流式 JSON usage 解析。
- 主/辅及多个子 provider 的 runtime/persistent token 分桶。
- 未知 provider 失败关闭，不回落到主 provider。

### 真实 Claude CLI 验收

准备一个 `claude` chat session，并把主 provider 与子 Agent provider 配成不同值：

```bash
MULTICC_LIVE_SESSION=<session-id> npm run test:subagent-live
```

脚本强制主模型调用一次 foreground `Agent`，并断言：

- 事件流中确实出现 `Agent`/`Task` tool_use。
- 子 Agent marker 返回主线程。
- `/api/token-usage/by-role?session=...` 的 main/sub 均大于零。
- `subByProvider` 命中配置的子 provider。
- `token_by_role.json` 对应的 main/sub provider 分桶都产生正增量。

该测试会产生真实模型调用和一条 session 历史记录，不应放入默认 `npm test`。

## 边界

- 子 provider 必须支持 Anthropic Messages 协议；不能直接选择 OpenAI Responses
  或 Codex provider。
- `CLAUDE_CODE_SUBAGENT_MODEL` 是 session 级 override，因此一个 Claude CLI session
  默认只能给所有内建子 Agent 指定同一个备用 provider/model。
- Claude Official OAuth 经过代理默认关闭。开启
  `CLAUDE_OFFICIAL_VIA_PROXY=1` 会从 macOS Keychain 重放订阅 token，需要自行评估
  Anthropic 条款和共享 Keychain 风险。
- 若要在同一回合按 named Agent 选择多个 provider，需要 Claude Code 暴露
  Agent 级 provider 信号，或改用独立 MultiCC session dispatch。
