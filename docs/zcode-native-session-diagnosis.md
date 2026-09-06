# ZCode 持续失败：原生会话 ID 污染（2026-09-06）

## 结论

会话 `multicc-codex-term-01-gw-chat`（zocde-woker）最近三次失败的直接原因在 MultiCC ZCode adapter / bridge 的会话身份处理。它的持久化 `cliSessionId` 和 `cliStates.zcode.cliSessionId` 都是 `zcode-settings`，这是旧桥接器的配置错误标记，不是 ZCode 原生会话 ID。

目标会话当前 `provider=null`、`model=null`，使用 ZCode 原生配置：`zai/glm-5.2`，Anthropic 协议，`https://api.z.ai/api/anthropic`。配置存在 API key；认证值未输出。安装的桌面版为 3.10.1，引擎 `--version` 返回 0.16.5。

原生日志证明模型请求成功、工具运行完成，而 MultiCC 在收到完整结果后拒绝了真实 `sess_...` ID。这三次失败不是 GPT-6 / Codex Official OAuth 的 HTTP 400，也没有证据指向 Z.ai 网络或认证失败。其他账号、模型、provider 的健康状态不在此结论内。

## 证据（UTC 时间，凭据未输出）

| 执行日期 | ZCode 原生完成证据 | 随后的 MultiCC 错误 |
| --- | --- | --- |
| 09-03 | `zcode-2026-09-03.jsonl:490`，05:26:32.372，`turn.completed`，67 次工具调用 | `multicc-error.log:7012`，05:26:32.505，`native_resume_mismatch` |
| 09-05 | `zcode-2026-09-05.jsonl:131`，13:02:35.985，`turn.completed`，18 次工具调用 | `multicc-error.log:21440`，13:02:36.083，同上 |
| 09-06 | `zcode-2026-09-06.jsonl:92`，00:06:50.153，`turn.completed`，10 次工具调用 | `multicc-error.log:24299`，00:06:50.259，同上 |

原生日志位于 `~/.zcode/cli/log/`；MultiCC 日志位于运行目录 `logs/`。09-06 原生身份是 `sess_515ef299-4c21-49ea-8971-96ad3b9139b1`；第 87–92 行显示请求完成、`finishReason=stop`、输出非空（536 字符）。紧接着 MultiCC 记录：

```json
{"event":"api_error_policy_decision","provider":"zcode","providerId":"_default_","code":"native_resume_mismatch","httpStatus":null,"phase":"before_first_token","rootCause":"turn cancelled","turnElapsedMs":72408}
```

三次后续均有 `provider_attempt_retry_blocked` / `attempt_prepare_failed`，再进入 `classifyState=E`。`src/dispatch/targeting.js` 将 E 映射为 `routingState=error`。

09-06 原生日志第 15 行确认 `mcp.server.connected`，`mcpServerName=multicc_router`，`toolCount=10`。早期“没有 dispatch_slave”的历史消息不能代表最新 MCP 状态；09-03 的一次连接确有 `toolCount=0`，但这与最近三次结果被丢弃是不同问题。

## 失败链路

1. 旧 `zcode-bridge.cjs` 将模型配置不一致错误写成 `{type:"error",sessionID:"zcode-settings",...}`。另有 `zcode-err`、`zcode-parse`、`zcode-no-engine` 和缺失身份时生成的 `zcode-<时间戳>`。
2. `zcode.js` 对所有带 `sessionID` 的事件先产生 `session_started`，包括错误事件；因此错误标记可能被保存为原生 ID，或抢先触发身份不匹配而掩盖原始错误。
3. 后续请求携带该标记，但 bridge 只对 `sess_` ID 发出 `--resume`，实际启动了新原生会话。
4. bridge 使用 `spawnSync` 等待整体 JSON。引擎执行完才返回真正的 `sess_...`；MultiCC 认为这是续聊身份变化，触发 `native_resume_mismatch`，结果无法正常入库。

持久化快照的更新时间在 2026-07-26。`zcode-settings` 对应哪一个错误分支可由代码确认；缺少当时的原始日志，无法还原那次具体的两个模型值。

## 最小复现与修复

无需网络、真实凭据或模型调用：

```sh
node --test tests/test-zcode-bridge.js
node tests/test-zcode-session-recovery-isolated.js
```

核心复现：让 adapter 解码 `sessionID=zcode-settings` 的错误事件，再按宿主方式捕获 `session_started`。修复前它把 `sess_existing` 覆盖成错误标记。用同样受污染的记录运行假引擎，真实 ID 会与保存的错误标记冲突。

改动范围：

- `src/cli-adapters/zcode.js`：错误事件不产生身份事件；成功事件只接受实际引擎使用的 `sess_` 格式。
- `src/cli-adapters/zcode-bridge.cjs`：所有错误分支取消伪 ID；成功 JSON 缺少有效身份时明确报错，不再生成时间戳 ID。子引擎使用与 bridge 相同的 Node 可执行文件。
- `src/cli-adapters/zcode-session.js`：集中验证原生身份，定向修复已知旧错误标记。
- `src/cli-switch.js`：复用现有启动 / CLI 切换状态整理入口，清理活动及备用 ZCode 快照中的已知伪 ID；保留其他 CLI 和真实 / 未知格式的原生 ID。
- 测试：错误身份污染、错误信息保留、活动 / 备用快照迁移、迁移幂等、正确续聊防串线、无身份输出拒收、真实隔离服务的持久化与二次启动。隔离启动用例纳入 `test:integration:isolated`。

只读迁移预演对当前运行数据的结果：仅目标会话受影响，`zcode-settings → null`。没有直接修改正在运行服务的 `sessions.json`。

## 验证与上线边界

- 四个新增单元回归在修复前全部失败，修复后全部通过。
- ZCode bridge/auth、provider invocation：22 个用例通过。
- CLI switch runtime、持久化、provider 协议路由、state bootstrap：45 个用例通过；CLI switch 15 个用例和 adapter 契约脚本通过。
- 完整 `npm test` 通过。
- 真实隔离服务两次启动通过：伪 ID 修复被持久化，真实身份保留，显示历史文件字节不变。
- 本轮没有发送真实模型任务、修改原生 JSONL、切换 provider、重启正式 MultiCC 或覆盖目标 worktree。

合入后需要用户手动重启 MultiCC；启动整理会持久化修复。下一条新请求创建合法的原生会话并恢复正常 ID 捕获。显示历史、原生文件和代码保留，但不把任何历史原生会话猜作当前会话，也不自动重放旧任务。旧原生隐藏上下文不会自动迁入新会话，需要时用明确的任务摘要接续。

尤其注意：上述三次失败并非零副作用，原生工具已执行 67 / 18 / 10 次。目标 worktree 在本次诊断时工作区干净，但相对 main 有 2 个独有提交、落后 31 个提交；包括 `292b0800`（ZCode MCP 注入）和 `554ccbed`（合并远端 main）。已保留，不将“同步失败”的表象当成可以丢弃代码的依据。

bridge 目前仍等待完整 JSON，不转发实时工具进度；长任务可能长时间没有网页输出。这是后续流式协议改造范围，本次身份修复不宣称解决它，也不把宿主 `before_first_token` 标记当作“引擎尚未执行工具”的证明。
