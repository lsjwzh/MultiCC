# Claude 车道 stdio 协议规范（@anthropic-ai/claude-agent-sdk 0.3.317）

本文是「用 Rust 取代 JS SDK、驱动原生 `claude` 二进制」的协议规范，范围只覆盖
MultiCC 实际使用的功能。所有 CLI→SDK 方向的形状来自三处：`sdk.mjs` 源码、
`sdk.d.ts` 类型、以及用一个**假 CLI 进程**做的实测抓包。正文各节的时序均来自
假 CLI；2026-11-08 又用**真实二进制 + 真实模型（haiku）**做了一轮补测，结果见
**附录 R**，正文里原先标注「未验证」的条目已按附录 R 更新。逐条未知项见第 10 节。

---

## 0. 取证方式与产物

- SDK 源码：`.../multicc/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`
  （0.3.317；`.d.ts` 落后于 `.mjs` 时以 `.mjs` 为准）。
- 实测：`createSdkStream`（真实 MultiCC 驱动）+ `processOptions`（真实选项物化）
  跑在主仓 node_modules 上，`spawnClaudeCodeProcess` 被替换成启动
  `/tmp/claude-lane-capture/scripts/fake-claude.mjs`。假 CLI 只读写 stdin/stdout，
  不发起任何网络请求（`ANTHROPIC_BASE_URL` 指向 `127.0.0.1:9`，不可达）。
- 抓包产物：
  - 脚本：`/tmp/claude-lane-capture/scripts/fake-claude.mjs`、`capture.mjs`、
    `initdelay.mjs`、`router-placeholder.mjs`
  - 日志：`/tmp/claude-lane-capture/logs/{resident,resume,crash,cancel-hook,initdelay}/`
    （`driver.jsonl` = 驱动侧观测；`fake-*.jsonl` = 假 CLI 侧逐行收发）
  - `logs/transport-argv.txt` = 从 `sdk.mjs` 抽出的 transport 初始化源码切片
  - `logs/run-summary.json`
- 保密：抓包里的 token 都是假值（`fake-token-not-real` / `SECRET-TOKEN-PLACEHOLDER`）；
  环境变量只记录键名，值按键名掩码。

---

## 1. 版本钉

| 项 | 值 |
|---|---|
| SDK 包 | `@anthropic-ai/claude-agent-sdk` **0.3.317** |
| 原生包 | `@anthropic-ai/claude-agent-sdk-darwin-arm64` **0.3.317** |
| 二进制 | `/Users/Zhuanz/Downloads/gapasea-all-in-one/code/claudecode/multicc/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` |
| 大小 | 312,806,400 bytes |
| sha256 | `09f153b46b5df9e8b3454716d682a91901de020cbca630f61dec1a015b32b5e9` |
| 其它平台 | 可选依赖 `claude-agent-sdk-{linux-x64,linux-arm64,linux-x64-musl,linux-arm64-musl,darwin-x64,win32-x64,win32-arm64}` 同版本 0.3.317 |

`system/init.claude_code_version` 是运行期才能知道的 CLI 版本，本文不写死；
本轮未运行真实二进制（`--version` 也没跑），版本以 sha256 钉死。

---

## 2. 进程模型

### 2.1 启动

- 子进程 = 原生 `claude` 可执行文件，`stdio: ['pipe','pipe','pipe']`，`windowsHide: true`。
- SDK 通过 `spawnClaudeCodeProcess({ command, args, cwd, env, signal })` 把启动权交给
  MultiCC；MultiCC 在这个回调里自己 `spawn`，因此 **SDK 不自带 stderr 读取器**——
  stderr 由 MultiCC 自己收（保留最后 4000 字节）。Rust 实现同理：stderr 自己读。
- 一个原生会话 = 一个常驻子进程 + 一个 `Query`；多轮用户消息写同一个 stdin，
  `result` 只结束「MultiCC 回合」，不结束输入流与进程。

### 2.2 帧格式

- 两个方向都是 **JSONL**：一行一个 JSON 对象，`\n` 结尾，无长度前缀、无 BOM、无转义换行。
- stdin 关闭 = 输入结束（`stdin.end()`）。
- 空行会被容忍（假 CLI 与 SDK 都跳过空白行）；Rust 侧建议跳过错行。
- 解析失败的行在 SDK 侧会终止读循环（`transport.readMessages` 的 JSON 解析失败）；
  假 CLI 只是记日志。Rust 实现建议：无法解析 → 该进程判故障（与 SDK 一致），
  不要静默丢弃。

### 2.3 关闭

MultiCC `stop()` 的顺序（对应 SDK 的 `query.close()` + 进程收尾）：

1. `run.input.close()`（结束输入迭代器）
2. `run.query.close()` → SDK `transport.close()` → `stdin.end()`，并拒绝所有
   在飞的 control 请求（"Query closed before response received"）
3. 进程还活 → `SIGTERM`；1500ms 后仍活 → `SIGKILL`
4. 等真实 `exit`（同 UUID 的 resume 必须等旧进程真退出）、关本地 relay、删临时设置目录

另外 SDK 在进程层面注册了退出钩子：宿主进程 `exit` 时对仍跟踪的子进程发
`SIGTERM`（win32 上是 `stdin.end()`）。

---

## 3. argv 构造

### 3.1 规则

SDK 的 token 化只有三种形态（`sdk.mjs` 的 `qe`/`Ny`/`G6`）：

```js
qe(key, value) -> `${key}=${value}`            // 单 token
Ny(key, value) -> String(value) 以 "-" 开头且长度>1
                    ? [`${key}=${value}`]      // 单 token
                    : [key, value]             // 两个 token
G6(argv, name, value) -> argv.push(...Ny(`--${name}`, value))
```

- `--model`、`--agent`、`--effort`、`--max-turns`、`--session-id`、`--resume`
  都走 `qe` → **单个 token**，例如 `--resume=<uuid>`。
- `--mcp-config`、`--settings` 走 `Ny`/`G6` → **两个 token**（除非值以 `-` 开头）。
- `--disallowedTools` 走 `qe`，值是逗号拼接（注意 flag 名是 camelCase）。

### 3.2 本车道实际发出的 argv

基准前缀固定 `--output-format stream-json --verbose --input-format stream-json`。
下面是**实测捕获**（resident / 新会话，会话 UUID 与路径已占位）：

```json
[
  "--output-format", "stream-json",
  "--verbose",
  "--input-format", "stream-json",
  "--effort=high",
  "--max-turns=4",
  "--model=claude-sonnet-4-6",
  "--agent=general-purpose",
  "--disallowedTools=WebSearch,WebFetch",
  "--mcp-config",
  "{\"mcpServers\":{\"multicc_router\":{\"command\":\"<node>\",\"args\":[\"<router-script>\"]}}}",
  "--permission-mode=bypassPermissions",
  "--allow-dangerously-skip-permissions",
  "--include-partial-messages",
  "--session-id=<uuid>",
  "--settings",
  "<tmp>/multicc-sdk-XXXX/settings.json"
]
```

恢复已有会话时，`--session-id=<uuid>` 换成 `--resume=<uuid>`，其余不变（实测
`resident` 与 `resume` 两个抓包的 argv 只差这一点）：

```json
[ "...", "--resume=4929b083-5e1a-4cae-817b-8a12dd9e1859", "--disallowedTools=...", ... ]
```

顺序要点：`--mcp-config` 在 permission 之前，`--settings` **最后**（settings 来自
`extraArgs`/`K6` 合并后的尾部）。

### 3.3 选项 → argv 对照（本车道用到的）

| MultiCC 选项 | argv | token 形态 | 说明 |
|---|---|---|---|
| （固定） | `--output-format stream-json` | 2 | 必需 |
| （固定） | `--verbose` | 1 | 必需 |
| （固定） | `--input-format stream-json` | 2 | 控制协议只在 stream-json 输入下可用 |
| `includePartialMessages: true` | `--include-partial-messages` | 1 | 打开 `stream_event` |
| `permissionMode: 'bypassPermissions'` | `--permission-mode=bypassPermissions` | 1 | |
| `allowDangerouslySkipPermissions: true` | `--allow-dangerously-skip-permissions` | 1 | |
| `sessionId`（新会话） | `--session-id=<uuid>` | 1 | 与 `--resume` 互斥 |
| `resume`（已有会话） | `--resume=<uuid>` | 1 | |
| `model` | `--model=<id>` | 1 | |
| `effort` | `--effort=<level>` | 1 | |
| `agent` | `--agent=<name>` | 1 | |
| `maxTurns > 0` | `--max-turns=<n>` | 1 | |
| `disallowedTools[]` | `--disallowedTools=A,B` | 1 | 逗号拼接 |
| `mcpServers` | `--mcp-config` `<json>` | 2 | JSON = `{"mcpServers":{...}}` |
| `settings: <path>` | `--settings` `<path>` | 2 | 见第 4.3 节 |
| `systemPrompt` preset+append | **不发 argv** | — | 走 initialize 的 `appendSystemPrompt` |

`systemPrompt` 与 hooks 都不在 argv，而在 initialize 控制请求里（第 6 节）。

### 3.4 其余 argv（本车道不用，Rust 可拒绝或留空）

`--thinking=*`/`--max-thinking-tokens`、`--max-budget-usd`、`--task-budget`、`--betas`、
`--json-schema`、`--debug`/`--debug-file`、`--permission-prompt-tool`、
`--permission-prompts`、`--continue`、`--channels`、`--allowedTools`、`--tools`、
`--setting-sources`、`--strict-mcp-config`、`--fallback-model`、`--include-hook-events`、
`--session-mirror`、`--project-config-root`、`--add-dir`、`--plugin-dir`、
`--await-initialize`、`--fork-session`、`--resume-session-at`、`--resume-drops-turn`、
`--no-session-persistence`、`--managed-settings`。

其中 `--await-initialize` 只在 `pluginDelivery: 'initialize'` 且确实带插件时加，
MultiCC 不设置；它的语义是「插件经 initialize 下发」，与用户首条消息无关。

---

## 4. 环境变量

### 4.1 SDK 自身强设（子进程 env）

`sdk.mjs` 在 `query()` 里先改 `process.env.CLAUDE_AGENT_SDK_VERSION="0.3.317"`，
再按以下规则生成子进程 env（**注意：`options.env` 一旦提供，就完全不继承
`process.env`**，只有不提供时才 `{...process.env}`）：

| 变量 | 值 | 条件 |
|---|---|---|
| `CLAUDE_CODE_ENTRYPOINT` | `sdk-ts` | 未设置时 |
| `CLAUDE_AGENT_SDK_VERSION` | `0.3.317` | 未设置时 |
| `CLAUDE_CODE_SDK_READS_SESSION_STATE` | `1` | 键不存在时（大小写不敏感判断）→ **总是** |
| `CLAUDE_CODE_SDK_READS_STARTUP_MARKS` | `1` | 仅 readsStartupMarks 场景 |
| `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` | `true` | 仅 `enableFileCheckpointing` |
| `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH` / `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH` | `1` | 仅对应 token 回调 |

transport 再删两个：`NODE_OPTIONS` 一律删除；`DEBUG` 删除，除非
`DEBUG_CLAUDE_AGENT_SDK` 为真（此时 `DEBUG=1`）。

### 4.2 MultiCC 追加

| 变量 | 值 | 来源 |
|---|---|---|
| `CLAUDE_AGENT_SDK_CLIENT_APP` | `multicc-claude-exp/1.0` | `claude-sdk-config.js` |
| `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` | `1` | 同上 |
| `ENABLE_PROMPT_CACHING_1H` | `1`，仅当环境里 `ENABLE_PROMPT_CACHING_1H` / `FORCE_PROMPT_CACHING_5M` / `DISABLE_PROMPT_CACHING` 都未设置时追加（想退回 5 分钟缓存就设 `FORCE_PROMPT_CACHING_5M=1`）。它不以 `ANTHROPIC_`/`CLAUDE_CODE_` 开头，所以不写进 settings 文件 | `claude_lane.rs` `default_prompt_cache_ttl` |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | 每轮 attempt 的值；受管路由时被本地 relay 的 `http://127.0.0.1:<port>` + 随机令牌覆盖 | cfg.env / relay env |

### 4.3 settings 文件（`--settings <path>`）

MultiCC 不把 settings 作为对象传（SDK 会序列化进 argv，令牌会进 `ps`），而是：

1. 读 `cfg.settingsFile`（没有则 `{}`）；
2. 把最终 env 里所有 `^(ANTHROPIC_|CLAUDE_CODE_)` 键复制进 `settings.env`；
3. 写 `mkdtemp('multicc-sdk-')` 目录（0700）下的 `settings.json`（**0600**）；
4. `--settings <该路径>`；进程退出后整目录删除。

实测内容（假令牌）：

```json
{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:5999","ANTHROPIC_AUTH_TOKEN":"SECRET-TOKEN-PLACEHOLDER","ANTHROPIC_API_KEY":"","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1","CLAUDE_CODE_STARTUP_FAILURE_RESULTS":"1"}}
```

`CLAUDE_AGENT_SDK_CLIENT_APP` 不匹配 `^(ANTHROPIC_|CLAUDE_CODE_)`，所以既不在设置文件里、
又作为进程 env 传入。实测子进程 env 键（值掩码）：

```json
["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_BASE_URL",
 "CLAUDE_AGENT_SDK_CLIENT_APP","CLAUDE_AGENT_SDK_VERSION",
 "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC","CLAUDE_CODE_ENTRYPOINT",
 "CLAUDE_CODE_SDK_READS_SESSION_STATE","CLAUDE_CODE_STARTUP_FAILURE_RESULTS",
 "CLAUDE_CONFIG_DIR","DISABLE_AUTOUPDATER","HOME","MULTICC_BASE_URL",
 "MULTICC_SESSION_ID","NO_COLOR","PATH","TERM","TMPDIR","__CF_USER_TEXT_ENCODING"]
```

### 4.4 受管路由 relay（MultiCC 侧，不是 CLI 协议）

当 `ANTHROPIC_BASE_URL` 形如 `http://127.0.0.1:<p>/claude-proxy/<provider>/<session>` 时，
SDK 进程实际指向的是 MultiCC 自己起的 relay：

- 子进程 env：`ANTHROPIC_BASE_URL=http://127.0.0.1:<ephemeral>`、
  `ANTHROPIC_AUTH_TOKEN=<32字节hex>`、`ANTHROPIC_API_KEY=''`；
- relay 只认 `Authorization: Bearer <token>`，`/api/hello` 直接回 `{}`（CLI 的探活）；
- 其余请求原样（头去 hop-by-hop、删 `x-api-key`、换成当轮 CPR 令牌）转发到
  `<origin>/claude-proxy/<provider>/<session>`；SSE 字节原样 pipe；
- `drain()`：有在飞请求时最多等 5s，超时报 `SDK_ROUTE_BUSY`。

Rust 车道若继续复用这个 relay，需要保持同样的入口语义；若直接连 CPR，则不需要。

---

## 5. 消息目录

### 5.1 信封与 request_id

方向无关的三种控制信封：

```json
{"type":"control_request","request_id":"uzr4q22mkrq","request":{"subtype":"initialize", "...":"..."}}
{"type":"control_response","response":{"subtype":"success","request_id":"uzr4q22mkrq","response":{}}}
{"type":"control_response","response":{"subtype":"error","request_id":"uzr4q22mkrq","error":"...", "error_code":"optional_snake_case"}}
{"type":"control_cancel_request","request_id":"uzr4q22mkrq"}
```

- **request_id**：发起方生成，`Math.random().toString(36).substring(2,15)`
  → 11 位左右 `[0-9a-z]`。接收方只按字符串回显，不解析格式。
- 应答与请求通过 `response.request_id` 配对；**SDK 侧**未配对的 response 会进
  `unmatchedControlResponses`（上限 1024，FIFO 丢弃），CLI 侧对迟到的
  `control_cancel_request` 之后仍可能发出 response（实测），接收方应忽略不认识的 id。
- 同一个 id 的重复 `control_request` 在 SDK 侧会被跳过（"Duplicate delivery"）；
  Rust 实现照做即可。
- `control_request` 的 subtype 决定 success payload 形状；见下。

### 5.2 SDK → CLI（本车道实际会发）

#### a) initialize（每次 spawn 一次，构造 Query 时立即发）

实测（带 MultiCC 的背景事件 hook 与预设系统提示追加）：

```json
{"request_id":"uzr4q22mkrq","type":"control_request","request":{"subtype":"initialize","hooks":{"UserPromptSubmit":[{"hookCallbackIds":["hook_0"]}]},"appendSystemPrompt":"APPENDED_SYSTEM_PROMPT_SENTINEL"}}
```

无 hooks、无 systemPrompt 的原始 `query()`（cancel-hook 抓包）会带空系统提示数组：

```json
{"request_id":"uvtcpwy6e3q","type":"control_request","request":{"subtype":"initialize","hooks":{"UserPromptSubmit":[{"hookCallbackIds":["hook_0"]}]},"systemPrompt":[""]}}
```

字段全集（undefined 的键不出现）：`subtype`、`hooks`、`sdkMcpServers`、
`sdkMcpServerConfigs`、`sdkMcpServerManifests`、`jsonSchema`、`systemPrompt`、
`appendSystemPrompt`、`planModeInstructions`、`systemPromptSnapshot`、
`appendSubagentSystemPrompt`、`toolAliases`、`codeRunningMcpTools`、
`excludeDynamicSections`、`agents`、`title`、`skills`、
`webSearchIsolationExemptMcpServers`、`promptSuggestions`、`agentProgressSummaries`、
`forwardSubagentText`、`supportedDialogKinds`、`perTaskStopAffordance`、
`rapidFollowupPreempt`、`forwardNestedSubagentToolCalls`、`workspaceTrust`、`plugins`。

`hooks` 形状：`{ "<HookEvent>": [{ matcher?, hookCallbackIds: ["hook_0", ...], timeout?, onFailure? }] }`；
`hookCallbackIds` 由 SDK 用递增计数器 `hook_N` 生成。MultiCC 只注册
`UserPromptSubmit` 一个 matcher，无 matcher/timeout/onFailure。

`systemPrompt` 与 `appendSystemPrompt` 的取舍（`Vv`）：
- `options.systemPrompt` 未给 → `systemPrompt: [""]`
- 字符串 → `systemPrompt: ["<string>"]`
- 数组 → 原样
- `{type:'custom'}` → `systemPrompt: [prompt]`
- `{type:'preset',preset:'claude_code',append}` → 只发 `appendSystemPrompt`
  （preset 标记本身不上线，CLI 收到 append 即按预设叠加）

#### b) user（每个 MultiCC 回合一条）

MultiCC 常驻车道**自己拼**这行（不经 SDK 的 `streamInput` 包装）：

```json
{"type":"user","session_id":"<uuid>","uuid":"<new-uuid>","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"text","text":"FIRST_TURN remember this"}]}}
```

对照：SDK 自己的 `streamInput` 对 input 迭代器里的对象做 `JSON.stringify(x)+"\n"`
原样写出；`query({prompt:"string"})` 的单轮包装（bridge 用）是：

```json
{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]},"parent_tool_use_id":null}
```

（`verbatimPrompts` 打开时才多一个 `"client_composed":true`，MultiCC 不用。）

#### c) interrupt（MultiCC cancel）

```json
{"request_id":"gp9poyesxv4","type":"control_request","request":{"subtype":"interrupt","cancel_queued":true}}
```

success payload：`{"still_queued":["<uuid>", ...], "cancelled":["<uuid>", ...]}`；
SDK 只保留其中的字符串项，返回 `{still_queued, cancelled?}`；MultiCC 忽略返回内容。

#### d) set_model（同进程切模型，下一条 user 之前）

```json
{"request_id":"se3c1pn019","type":"control_request","request":{"subtype":"set_model","model":"claude-opus-4-6"}}
```

success payload：`{}`。`model` 省略/null/`"default"` = 回到会话默认模型。

#### e) get_task_output

```json
{"request_id":"y5lyk6tjw8e","type":"control_request","request":{"subtype":"get_task_output","task_id":"task-abc"}}
```

success payload（实测假 CLI 应答后 MultiCC 归一化成的形状）：

```json
{"output":"fake task output line\nsecond line\n","total_bytes":39,"truncated":false}
```

#### f) stop_task

```json
{"request_id":"eulzls7i86g","type":"control_request","request":{"subtype":"stop_task","task_id":"task-abc"}}
```

success payload `{}`；MultiCC 收到成功即返回 `true`。

#### g) control_response（回答 CLI 的 hook_callback）

见 5.3.b；response 内容就是 hook 的返回值本身。

#### h) control_cancel_request（本车道只在 hook 被中断时可能出现）

SDK 只在「带 signal 的 control 请求被 abort」时向 CLI 发
`{"type":"control_cancel_request","request_id":"<id>"}`（例如 shutdown 时 abort 全部
在飞请求）。MultiCC 的 hook 调用本身没有外部 signal，正常情况下不会发。

#### i) 结束输入

`run.input.close()` → 迭代器结束 → SDK 调 `transport.endInput()`（`stdin.end()`）。
若注册了 hooks / SDK MCP（`hasBidirectionalNeeds()` 为真），SDK 会**先等本轮
run 结束**（result / session_state idle）再关 stdin；没有 hooks 时直接关。
挂上 MultiCC 的 `UserPromptSubmit` hook 后属于前者——这也是为什么必须靠
`result` 判回合结束。

### 5.3 CLI → SDK

#### a) control_response

- success：`{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{...}}}`
  - initialize 的 success payload 是对象，`d.ts` 里的形状：
    `commands[]`、`agents[]`、`output_style`、`available_output_styles[]`、
    `models[]`、`account`、`hooks_applied?`、`hook_on_failure_supported?`、
    `plugins_applied?`、`pending_permission_requests?`、`pending_user_dialog_requests?`、
    `pending_elicitation_requests?`（后三者在 CLI ≥2.1.268 的 initialize success 上
    总是存在，可能为空数组）。
  - MultiCC 不调用 `supportedCommands/supportedModels/supportedAgents/accountInfo`，
    因此 Rust 实现**至少**要回一个 `subtype:"success"`、`response` 为对象即可；
    但为了未来兼容，建议原样带上上述字段。
- error：`{"type":"control_response","response":{"subtype":"error","request_id":"<id>","error":"<msg>","error_code?":"<snake_case>"}}`
  - `error_code` 只有匹配 `/^[a-z][a-z0-9_]{0,63}$/` 才会被 SDK 记成 `Error.code`；
    否则只是 `Error(message)`。
  - 影响：`getTaskOutput`/`stopTask` 的 error 在 MultiCC 侧被吞成 `null`/`false`；
    `set_model` 的 error 会让该回合失败（pump 的 catch → stop + settle）。

#### b) control_request: hook_callback（本车道唯一会收到的控制请求）

假 CLI 实测发出的（`source:"user"` 的普通用户输入）：

```json
{"type":"control_request","request_id":"fake_fzcm6zaj","request":{"subtype":"hook_callback","callback_id":"hook_0","input":{"hook_event_name":"UserPromptSubmit","prompt":"HOOK_NOTIFY plain notification","source":"user","session_id":"<uuid>","transcript_path":"/tmp/fake-transcript.jsonl","cwd":"<cwd>","permission_mode":"bypassPermissions","prompt_id":"prompt_5"}}}
```

被 MultiCC 判为「原生后台任务通知」的（`source:"system"` + `<task-notification>` 文本）：

```json
{"type":"control_request","request_id":"fake_gvhp9nz4","request":{"subtype":"hook_callback","callback_id":"hook_0","input":{"hook_event_name":"UserPromptSubmit","prompt":"<task-notification><task-id>task_fake01</task-id><summary>fake background task done</summary><status>completed</status><event>fake output event</event></task-notification>","source":"system","session_id":"<uuid>","transcript_path":"/tmp/fake-transcript.jsonl","cwd":"<cwd>","permission_mode":"bypassPermissions","prompt_id":"prompt_6"}}}
```

SDK 的处理：按 `callback_id` 找到注册的 hook，`await hook(input, tool_use_id, {signal})`，
把返回值原样塞进 success response；hook 抛错则回 error response。
本车道观测到的两种应答（**实测**）：

放行（hook 返回 `{}`）：

```json
{"type":"control_response","response":{"subtype":"success","request_id":"fake_fzcm6zaj","response":{}}}
```

拦截（`createMonitorAdmission` 返回 block）：

```json
{"type":"control_response","response":{"subtype":"success","request_id":"fake_gvhp9nz4","response":{"decision":"block","reason":"MultiCC queued this Monitor notification for an admitted turn.","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","suppressOriginalPrompt":true}}}}
```

其它 hook 返回形状（cancel-hook 抓包，`additionalContext`）：

```json
{"type":"control_response","response":{"subtype":"success","request_id":"fake_493czeq5","response":{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"ctx"}}}}
```

CLI 侧应支持的其它 control_request subtype（SDK 处理规则，供 Rust 侧对等判断）：

| subtype | SDK 无对应能力时的行为 |
|---|---|
| `can_use_tool` | 抛 `canUseTool callback is not provided.` → error response |
| `request_user_dialog` | 无 `onUserDialog` → 拒绝（不回 success） |
| `elicitation` | 无 `onElicitation` → `{"action":"decline"}` |
| `mcp_message` | 无对应 SDK MCP server → error response |
| `remote_tool_call` / `remote_plumbing_call` / `remote_tools_probe` / `remote_tools_reannounce` | **故意不回**（留给会话工具服务方） |
| 未知 subtype | error response `Unsupported control request subtype: <x>` |

#### c) control_cancel_request（CLI → SDK，取消正在跑的 hook）

```json
{"type":"control_cancel_request","request_id":"fake_493czeq5"}
```

SDK 行为：abort 该请求的 `AbortController.signal`；**不会**阻止 hook 之后继续写
response（实测 hook 在 abort 后仍写回了 success，CLI 侧应忽略）。Rust 实现需要：
把 callback 的 signal 设为 aborted；迟到的 response 由发送方丢弃。

#### d) keep_alive

```json
{"type":"keep_alive","startup_mark":"<≤64 chars, optional>"}
```

SDK 完全吞掉，只把 `startup_mark`（字符串、长度 ≤64）记成启动耗时锚点；
**不会**转给上层。Rust 车道必须同样吞掉（否则 MultiCC 会把未知事件透传给前端）。
本次抓包未观测到（假 CLI 没发），字段形状来自 `sdk.mjs`。

#### e) transcript_mirror

`{"type":"transcript_mirror","filePath":"...","entries":[...]}`：SDK 吞掉（仅
`sessionStore` 打开时才消费），本车道不用，Rust 侧应吞掉或忽略。

#### f) 流消息（会原样交给上层）

除上述控制类型外，SDK **把所有行都 yield 给 Consumer**，包括它不认识的 `type`。
本车道实际消费的：

1. `system` / `init`（每轮一次；MultiCC 校验 `session_id` 必须等于 cfg.sessionId，
   不匹配即抛 `SDK native session identity changed`）：

```json
{"type":"system","subtype":"init","apiKeySource":"none","claude_code_version":"2.1.317","cwd":"<cwd>","tools":["Read","Bash"],"mcp_servers":[],"model":"claude-sonnet-4-6","permissionMode":"bypassPermissions","slash_commands":[],"output_style":"default","agents":[],"skills":[],"uuid":"<uuid>","session_id":"<uuid>"}
```

2. `system` / `task_started|task_progress|task_updated|task_notification|background_tasks_changed`
   → MultiCC 转 `onBackgroundEvent`（后台任务簿记），同时也会按普通事件透传。

3. `stream_event`（`--include-partial-messages`；Anthropic Messages 流事件原样）：

```json
{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"usage":{"input_tokens":11,"output_tokens":0}}},"parent_tool_use_id":null,"uuid":"<uuid>","session_id":"<uuid>"}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"parent_tool_use_id":null,"uuid":"<uuid>","session_id":"<uuid>"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"answe"}},"parent_tool_use_id":null,"uuid":"<uuid>","session_id":"<uuid>"}
{"type":"stream_event","event":{"type":"content_block_stop","index":0},"parent_tool_use_id":null,"uuid":"<uuid>","session_id":"<uuid>"}
```

4. `assistant`（完整消息；MultiCC 读 `message.model` 与 `message.content[].type`
   = `text` / `tool_use`）：

```json
{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"fake assistant answer #1: FIRST_TURN remember this"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":11,"output_tokens":7,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"parent_tool_use_id":null,"uuid":"<uuid>","session_id":"<uuid>"}
```

5. `user`（CLI 自己补进对话的 user 角色内容，主要是 tool_result；MultiCC 用
   `tool_use_id` 回填工具结果、用 `content` 归一化）：

```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"..."}]},"parent_tool_use_id":null,"uuid":"<uuid>","session_id":"<uuid>"}
```

6. `result`（成功；**实测**）：

```json
{"type":"result","subtype":"success","is_error":false,"duration_ms":12,"duration_api_ms":10,"num_turns":1,"result":"fake assistant answer #1: FIRST_TURN remember this","session_id":"<uuid>","total_cost_usd":0.0001,"usage":{"input_tokens":11,"output_tokens":7,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"modelUsage":{"claude-sonnet-4-6":{"inputTokens":11,"outputTokens":7}},"permission_denials":[],"stop_reason":"end_turn","uuid":"<uuid>"}
```

错误回合（中断时假 CLI 发的，实测）：

```json
{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":12,"duration_api_ms":10,"num_turns":1,"result":"interrupted","session_id":"<uuid>","total_cost_usd":0.0001,"usage":{"input_tokens":11,"output_tokens":7,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}
```

MultiCC 从 `result` 读：`subtype`、`is_error`、`result`、`errors`、`usage`、
`total_cost_usd`、`num_turns`、`stop_reason`、`modelUsage`、`permission_denials`、
`error`/`startup_failure_reason`、`origin.kind`，以及（错误归一化）`http_status`/
`status_code`/`headers`/`request_id`。

7. `system` 的其它 subtype（`compact_boundary`、`hook_progress`、`hook_response`、
   `session_state_changed`、`commands_changed`、`task_summary`、`post_turn_summary`、
   `session_metadata`、`session_writes_lost`、`mirror_error` 等）SDK 都会透传
   （`session_state_changed` 若带 `"sdk_host_only":true` 则被吞）；本车道只依赖
   它做记账/透传。

8. **未知 `type`**：透传。Rust 实现不要把未知类型当错误。

### 5.4 消费端过滤（MultiCC `consume()`）

- 只把事件交给「当前正在跑且已发出」的回合；非当前回合的事件丢弃。
- `system/init`：校验 `session_id`；设置 `started=true`。
- `task_*`/`background_tasks_changed`：转 `onBackgroundEvent` 并重置 idle 计时。
- `isMonitorHandoffResult(event)`（`result` + `origin.kind==='task-notification'`
  + `num_turns===0` + `result` 含拦截原因字符串）→ **吞掉**。实测：被 hook 拦截的
  通知回合，驱动侧 `busy:true` 且 Promise 永不 settle，直到关闭/取消。
- `isMainResult(event)`（原生模块 `cliIsMainResult`）→ 若该回合未取消，进入
  「后台 hold」判断；hold 放行才 `settle`。
- 回合取消后：不再透传事件，但主 `result` 仍会触发 `finish()`（`settle` 为
  `SDK_INTERRUPTED`）。

---

## 6. 初始化与首条消息的时序（重要）

`Query` 构造时立即 `initialize({first:true})`，并挂起 `initializeWritten`。
**实测结论：SDK 不等待 initialize 的应答就写首条 user 消息。**

`initdelay.mjs`：假 CLI 把 initialize 应答延迟 800ms，记录到达顺序：

```text
+26ms  control_request(initialize)
+26ms  control_request 已写出（假 CLI 记录 init_response_pending）
+26ms  user 首条消息已到达假 CLI stdin
+826ms initialize 的 control_response 才发出
```

源码对应：`initializeWritten` 在 `request()` **写出后**就 `markInitializeWritten()`；
`streamInput` 只 `await initializeWritten`；只有 `onFailure:"block"` 的 hook
才会把后续写操作挂到 `promptHold`（等 initialize 应答）。MultiCC 的 matcher 没有
`onFailure`，因此首条 user 可能先于 initialize 应答到达 CLI。
**真实 CLI 容忍这个顺序（实测，见附录 R.1）**；`system/init` 反而在 initialize
应答之后才出现，因此不能把 `system/init` 当作「可以开始写 user」的信号。

initialize 的失败处理也值得注意：`query` 构造里 `this.initialization.catch(()=>{})`，
除非挂钩 `onFailure`，**initialize 的 error 应答不会终止 Query**，只是 Promise 被吞。
Rust 实现应显式决定：建议 fail-closed（初始化失败即杀进程并让回合报错），
但要在 MultiCC 侧配合（否则行为与 JS 版不同）。

---

## 7. 回合生命周期（时序图）

### 7.1 启动 + 正常回合

```text
MultiCC            Rust SDK 等价层                 claude
  send() ────────────► start()
                        spawn claude ──────────────► (argv/env/cwd)
                        stdin: control_request initialize ──►
                        （不等应答）
                        stdin: user 消息 ─────────────►
  ◄── stream_event(message_start/content_block_*) ──────
  ◄── assistant ───────────────────────────────────────
  ◄── system/init（实测：每条 command 开头都重发，见 R.3）
  ◄── result(success) ─────────────────────────────────
                        hold 判定 → settle 当前回合
```

实测关键帧顺序（resident turn1）：`user` 写入 → （假 CLI 回 hook_callback，
SDK 回 control_response）→ `system/init` → `stream_event`×4 → `assistant` → `result`。

### 7.2 多轮 + 模型切换（同一子进程）

```text
turn1: user A ─────► ... ──► result
turn2: control_request(set_model, claude-opus-4-6) ──► control_response {}
       user B ─────────────────────────────────────► ... ──► result
```

实测：同一 PID 贯穿两轮与后续 interrupt/reuse；`set_model` 在 user 之前写出。
真实 CLI 的应答是 `{"model":"claude-sonnet-5-5"}`（不是 `{}`），且在应答之前会先
往 stdout 重放一条 user 消息 `<local-command-stdout>Set model to ...</local-command-stdout>`
（见 R.7），Rust 侧必须按「本地命令回显」吞掉，不能当用户输入。

### 7.3 interrupt

```text
MultiCC cancel():
  control_request(interrupt, cancel_queued:true) ────►
  ◄── control_response {still_queued:[],cancelled:[]}
  ◄── result(error_during_execution)   （该回合的终局 result）
  settle(SDK_INTERRUPTED)      // 3s 未完成则杀进程兜底
下一个回合复用同一子进程（实测 turn3 的 pid 不变）。
```

### 7.4 hook 放行 / 拦截

```text
放行（非通知文本；实测 hook input **没有** `source` 字段，只能看 prompt 文本）：
  claude ── control_request(hook_callback) ──► SDK
  SDK ── control_response(success, response:{}) ──► claude
  claude 继续正常回合

拦截（prompt 以 <task-notification> 开头，且 host 认领该任务）：
  claude ── control_request(hook_callback) ──► SDK
  SDK ── control_response(success, response:{decision:"block",reason,hookSpecificOutput}) ──►
  claude ── result(num_turns:0, origin:{kind:"task-notification"}) ──►
  MultiCC 吞掉该 result；不产生用户可见回合。
```

### 7.5 后台任务输出 / 停止

```text
control_request(get_task_output, task_id) ──► control_response {output,total_bytes,truncated}
control_request(stop_task, task_id)       ──► control_response {}
```

`system/task_*` 事件同时会从 stdout 流出，MultiCC 用作后台任务簿记与 hold 放行。
真实二进制实测（R.5）：`truncated` 时 `output` 是**最后 8192 字节**（按字节截、
可能切在数字/行中间），响应只有 `{output,total_bytes,truncated}` 三键，没有 `bytes`。

### 7.6 恢复

```text
新会话：--session-id=<uuid>；首轮后 s.started=true
恢复：  --resume=<uuid>；init.session_id 必须仍是同一 <uuid>
```

两者都仍在 initialize 里带 `appendSystemPrompt`/hooks；恢复不是单独的协议。

### 7.7 崩溃/退出

```text
claude 退出（code 3，stderr 有内容）
  SDK 拒绝在飞请求 / 结束消息流，错误文本
    "Claude Code process exited with code 3"
  MultiCC 捕获：追加自己的 stderr 尾巴
    "Claude Code process exited with code 3\nFAKE_STDERR: simulated native crash while turning"
  当前回合 reject；下一次 send 会重新 spawn
```

实测见 `logs/crash/`。

---

## 8. 本车道对 CLI 输出的最小契约（Rust 实现清单）

TL;DR：Rust 版「SDK」需要

1. 按第 3/4 节拼 argv/env/settings，spawn 原生二进制；
2. 写一行 initialize（hooks + appendSystemPrompt 视配置），随后写 user 行；
3. 读 stdout 逐行解析：吞 `control_response`（配对自己的请求）、
   `control_cancel_request`、`keep_alive`、`transcript_mirror`；把其余消息原样交给上层；
4. 对 `hook_callback` 控制请求调用宿主 hook，回 success(response=返回值)/error；
5. 提供 `interrupt({cancelQueued})`、`setModel`、`getTaskOutput`、`stopTask`
   四个控制请求 + 应答配对/超时；
6. 维护「回合 = 主 result 边界」，不因 result 关闭进程；
7. 关闭时 end stdin → SIGTERM → 1500ms → SIGKILL，等真实 exit。

---

## 9. 本车道不用的 SDK 能力（供 Rust 明确拒绝）

- `createSdkMcpServer` / 进程内 SDK MCP（会带 `sdkMcpServers`、`sdkMcpServerConfigs`、
  `sdkMcpServerManifests`，并有 `mcp_message` 控制往返）
- `canUseTool` 回调与 `can_use_tool` 控制请求、`permissionPromptToolName`、
  `permissionPrompts`
- `request_user_dialog` / `elicitation` / `onUserDialog` / `onElicitation`
- 插件（`plugins`、`pluginDelivery`、`--plugin-dir`、`--await-initialize`）
- `thinking`/`maxThinkingTokens`、`maxBudgetUsd`、`betas`、`outputFormat/jsonSchema`
- `settingSources`、`sandbox`、`managedSettings`、`forkSession`、`resumeSessionAt`、
  `resumeDropsTurn`、`persistSession:false`、`sessionStore`（transcript mirror）
- `skills`、`allowedTools`/`tools`、`additionalDirectories`、`strictMcpConfig`
- `includeHookEvents`、`sessionMirror`、`verbatimPrompts`（`client_composed`）
- `startupMark`、`getSettings`、`updateSettings`、`rewindFiles`、`cancelAsyncMessage`、
  `backgroundTasks`、`mcp_*` 控制请求

其中 MultiCC **用到**的只有：`mcpServers`（作为 CLI 自己的 MCP 配置走 `--mcp-config`，
不是 SDK MCP）、`systemPrompt preset+append`、`disallowedTools`、`maxTurns`、
`model/effort/agent`、`hooks.UserPromptSubmit`、`permissionMode:bypassPermissions`。

---

## 10. 未知项 / 风险（2026-11-08 真实二进制实测后更新）

> 逐条证据见**附录 R**（场景号/节号对应）。标「已解决」的条目可以直接照实现；
> 标「部分」的只解决了一半；标「未解决」的仍需实测或按保守策略处理。

1. **user 先于 initialize 应答** — **已解决（R.1）**：两种顺序都能跑完整回合。
   Rust 不必等 initialize success 再写首条 user；但也不能用 `system/init` 当作
   可以开始写的信号（它反而在 initialize 应答之后）。
2. **initialize error 的真实原因与恢复** — **部分（R.2）**：拿不到真实 error 应答
   —— `systemPrompt` 类型错误、未知 `hookCallbackIds`、未知字段都被静默接受。
   SDK 吞错误的处理保持不变；Rust 仍建议 fail-closed，但要知道「字段写错」
   大概率不会报错，只会行为漂移。
3. **keep_alive 的真实频率与字段** — **已解决（R.3）**：32 s 空闲窗口内 **0 条**
   `keep_alive` / `transcript_mirror`。它不是稳态心跳；Rust 只需「收到就忽略」。
4. **session_state_changed / sdk_host_only** — **已解决（R.3）**：每条 command
   起 `{"state":"running","sdk_host_only":true}`、`result` 后
   `{"state":"idle","sdk_host_only":true}`；被 block 的通知也走 running→idle。
   观测到的取值只有 `running`/`idle`。
5. **interrupt 后终局 result** — **已解决（R.4）**：ack 后 36 ms 内必达终局
   `error_during_execution`（`is_error:true`、`terminal_reason:"aborted_tools"`、
   无 `result` 字段），同一 PID 可立即复用。
6. **`get_task_output` 的真实截断** — **已解决（R.5）**：`truncated:true` 时
   `output` 是**最后 8192 字节**（按字节切，会切在数字/行中间）；
   响应键只有 `{output,total_bytes,truncated}`。
7. **hook_callback 的并发/超时** — **已解决（R.6）**：CLI 侧硬超时
   **30000 ms**；5 s 的慢 hook 正常接受，回合在 hook 应答后才开始；超时按
   `prompt_submit_outcome.kind="no_verdict"` 处理，0 用量。
8. **未知/多余控制 subtype 与 error 应答** — **已解决（R.2、R.6）**：未知 subtype
   收到配对的 `control_response(error)`，进程继续；hook 的 `error` 应答被当作
   「空答案」，只发 `system/informational` 警告，回合照常完成。
9. **`--settings` 与 `process.env` 的优先级** — **未解决**：本轮为走通 relay 反而
   **清空**了 `ANTHROPIC_*`，没有制造 env/settings 冲突，需另做一次实测。
10. **`system/init` 其它字段** — **已解决（R.3）**：抓到完整 31 键样例（含
    `capabilities`、`memory_paths`、`original_cwd`、`user_message_uuids` 等），
    且实测**每条 command 都重发一次 `system/init`**，不是只发首回合。
11. **`--verbose` 是否必需** — **未解决**：本轮全部带 `--verbose`，没有做去掉的对照。
12. **stdout 非 JSON 污染** — **部分（R.3）**：8 个场景、真实模型、真实二进制下
    stdout 全是合法 JSONL；但没有主动制造污染。Rust 侧仍按 SDK 语义判故障。

---

## 11. 相关代码 / 文档

- 常驻驱动：`src/chat/claude-sdk-stream.js`
- 选项物化 / 设置文件：`src/chat/claude-sdk-config.js`
- 受管路由 relay：`src/chat/claude-sdk-route.js`
- 单轮桥接（兼容入口）：`src/cli-adapters/claude-agent-sdk-bridge.mjs`（原
  `claude-exp.js` 已删除，`claude-exp` 只是 `claude` 的别名）
- hook 语义：`src/chat/monitor-admission.js`、`background-hold.js`、`result-completion.js`
- 运行层说明：`docs/claude-agent-sdk-runtime.md`
- 回归用例：`tests/test-claude-sdk-stream.js`（真实 SDK + 假 HTTP Messages 上游，
  断言同一子进程贯穿多轮、`--resume=<uuid>` 单 token、settings 0600 等）

---

## 附录 R：真实二进制实测（2026-11-08）

### R.0 方法、产物与唯一偏差

- 二进制：第 1 节同一文件（sha256 `09f153b4…b32b5e9`，312,806,400 bytes），
  运行期 `--version` = **2.1.317**，`system/init.claude_code_version` 同为 `2.1.317`。
- 驱动：**真实 JS SDK 0.3.317**（`query()` + 自定义 `spawnClaudeCodeProcess`）或
  **裸 spawn**（不经 SDK）。两种方式都在 `child.stdin.write` / `child.stdout` 上做
  非破坏性 tee，逐行记录单调毫秒时间戳，产物在
  `/tmp/claude-lane-capture/real/<scenario>/trace.jsonl`
  （脚本：同目录 `lib.mjs`、`run-raw.mjs`、`run-sdk.mjs`）。
- cwd 是清空的 `/tmp/claude-lane-capture/real/cwd`（没有 CLAUDE.md / settings）；
  继承环境先剥掉所有 `ANTHROPIC_*` / `MULTICC_*` / `CLAUDE*`。
- 模型一律 `haiku`（`--model=haiku`），提示词都是「Reply with exactly: …」级别，
  只为了拿到真实协议帧，不追求内容。
- **唯一偏差**：这台机器没有独立 Claude 登录（没有 `~/.claude/.credentials.json`，
  Keychain 也没有 `Claude Code-credentials` 条目；`~/.claude.json` 无 oauthAccount）。
  实测只能通过本会话的本地 relay（`ANTHROPIC_BASE_URL=http://127.0.0.1:<临时端口>`
  + 虚拟路由 `ANTHROPIC_AUTH_TOKEN`）出真模型。token 值从未落盘，日志只记录
  env **键名**；`system/init.apiKeySource` 实测为 `"none"`。
- 用量：8 个场景合计 **12 次模型调用**（按 `assistant.message.id` 去重计数；
  S2 的 hook 超时与 S5 被 block 的通知各 0 用量）。所有场景最终 `stdin.end()`
  → 退出码 **0**。

| 场景 | trace 目录 | 结论节 |
|---|---|---|
| 裸 spawn，init+user 背靠背 | `s1-raw-nowait` | R.1 |
| 裸 spawn，等 init 应答再写 user | `s1-raw-wait` | R.1 |
| 裸 spawn，坏 initialize + 未知 subtype | `s2-init-error` | R.2 |
| SDK，生命周期/空闲/set_model/关 stdin | `s3-lifecycle` | R.3、R.7 |
| SDK，前台 Bash + interrupt + 复用 | `s4-interrupt` | R.4 |
| SDK，后台任务/output/stop/hook | `s5-background` | R.5、R.6 |
| SDK，hook 抛错 | `s6-hook-error` | R.6 |
| SDK，`--resume` 新进程 | `s7-resume` | R.7 |

### R.1 首条 user 先于 initialize 应答：**容忍**（未知 1）

裸 spawn，两行背靠背写出，故意不等 initialize 应答：

```text
+1ms    host->cli  control_request {"subtype":"initialize"}   request_id=cap_init_1
+1ms    host->cli  user "Reply with exactly: OK"
+146ms  cli->host  control_response {"subtype":"success","request_id":"cap_init_1",
                   "response":{"commands":[…], …}}
+174ms  cli->host  system/init  session_id=7573831f-… model=claude-haiku-5-5
+3570ms cli->host  assistant [{"type":"text","text":"OK"}]
+3574ms cli->host  result {"subtype":"success","is_error":false,"num_turns":1,
                   "result":"OK","terminal_reason":"completed"}
+3574ms host->cli  stdin_end
+3583ms            exit code=0（关 stdin 后 9ms）
```

对照组（先等 initialize 应答再写 user）：init 应答 `+156ms`、user `+157ms`、
`result +2128ms`。**两种顺序都跑通**，initialize 应答不是前置条件。

顺带印证：真实 SDK 自己也是不等应答的。`s3-lifecycle` 抓到的 SDK 侧写入是
`initialize` 与首条 user 同在 `+6ms`，而 CLI 的 initialize 应答在 `+172ms`。
因此「等 initialize success 再写首条 user」不是必要行为。

**Rust 含义**：保持「先写 initialize 行，再写 user 行」即可，不需要一次额外往返；
但不要把 `system/init` 当作「可以开始写」的信号（它在应答之后才来）。

### R.2 initialize 校验与未知 subtype（未知 2、8）

把一个明显非法的 initialize 发进去：

```json
{"type":"control_request","request_id":"cap_init_bad","request":{
  "subtype":"initialize",
  "systemPrompt":"NOT_AN_ARRAY",
  "hooks":{"UserPromptSubmit":[{"hookCallbackIds":["hook_does_not_exist"]}]},
  "bogusFieldXyz":{"a":1}}}
```

CLI `+143ms` 回了 **success**（`commands` 列表照旧），进程继续；`hookCallbackIds`
里的假 id 也不校验——直到真的触发时才按这个名字发 `hook_callback`（见 R.2 末尾）。
也就是说「initialize 字段写错」大概率**不会**收到 error，只是行为漂移。

未知控制 subtype：

```json
// 发：+143ms
{"type":"control_request","request_id":"cap_unknown",
 "request":{"subtype":"totally_unknown_subtype_xyz","foo":"bar"}}
// 收：+153ms（10ms 内）
{"type":"control_response","response":{"subtype":"error","request_id":"cap_unknown",
 "error":"Unsupported control request subtype: totally_unknown_subtype_xyz"}}
```

进程照常接受后续 user 并跑完回合。**error 应答不是致命错误**，只是配对失败。

未解决的部分：找不到能让真实 CLI 对 initialize 回 error 的输入（`systemPrompt`
类型错误、未知 hook id、未知字段都被接受）。所以「initialize error 应答的恢复
路径」仍无真实样例；Rust 侧 fail-closed 仍可保留，但别指望靠它发现字段拼错。

### R.3 生命周期、空闲与关 stdin（未知 3、4、10、11、12）

30 秒级空闲窗口（`s3-lifecycle`，turn1 结束到 turn2 之间 32 s）内，除一条
`command_lifecycle/completed` 外**没有任何消息**：

```json
{"type":"meta","kind":"idle_window","ms":32003,"count":1,
 "types":["command_lifecycle/"]}
```

**没有** `keep_alive`，**没有** `transcript_mirror`（8 个场景全量 grep 为 0 次）。
它们不是稳态心跳；Rust 只需要「收到就忽略 / 不需要主动回包」。

其它周期性/生命周期帧的真实形状：

```json
{"type":"system","subtype":"init","cwd":"/private/tmp/claude-lane-capture/real/cwd",
 "session_id":"b3fa4c45-…","tools":["Bash"],"mcp_servers":[],
 "model":"claude-haiku-5-5","permissionMode":"bypassPermissions",
 "slash_commands":[…],"terminal_slash_commands":[…],"apiKeySource":"none",
 "claude_code_version":"2.1.317","output_style":"default","agents":[],
 "skills":[…],"plugins":[],"capabilities":["interrupt_receipt_v1",
 "interrupt_cancel_queued_v1","interrupt_send_now_v1","interrupt_requeue_taken_v1",
 "msg_lifecycle_v1","request_marker_lists_v1","ask_user_question_unanswered_v1",
 "lifecycle_wakeup_source_v1","sdk_mcp_tools_list_changed","sdk_mcp_manifests",
 "mcp_read_resource_v1","mcp_tool_ui_meta_v1","ui_surface_v1",
 "mcp_call_result_not_for_model_v1"],
 "analytics_disabled":true,"product_feedback_disabled":true,"uuid":"…",
 "memory_paths":{"auto":"/Users/…/.claude/projects/<mangled-cwd>/memory/"},
 "original_cwd":"/private/tmp/claude-lane-capture/real/cwd",
 "additional_directories":[],"messaging_socket_path":"…",
 "fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required",
 "per_turn_effort_active":true,"ultrathink_available":true,
 "ultrathink_typed_raises":false,"view_mode":"default",
 "user_message_uuids":["428048ae-…"]}

{"type":"system","subtype":"session_state_changed","state":"running",
 "sdk_host_only":true,"uuid":"…","session_id":"b3fa4c45-…"}
{"type":"system","subtype":"session_state_changed","state":"idle",
 "sdk_host_only":true,"uuid":"…","session_id":"b3fa4c45-…"}

{"type":"system","subtype":"status","status":"requesting",
 "session_id":"b3fa4c45-…","uuid":"…","user_message_uuids":["428048ae-…"]}

{"type":"command_lifecycle","command_uuid":"428048ae-…","state":"queued",
 "uuid":"…","session_id":"b3fa4c45-…"}
{"type":"command_lifecycle","command_uuid":"428048ae-…","state":"started", …}
{"type":"command_lifecycle","command_uuid":"428048ae-…","state":"completed", …}
```

实测要点：

1. **`system/init` 不是「只发首回合」**：它**每条 command 开头都重发**。
   `s3` 两轮 → 2 条 init；`s4` 两轮 → 2 条；`s5` 三条 command → 3 条
   （其中被 hook block 的通知 command 也发 init，且**没有** `user_message_uuids`）。
2. `session_state_changed` 只观测到 `running` / `idle` 两值，且都带
   `sdk_host_only:true`；每条 command 是 running → … → idle。
3. `system/status` 的 `status` 只观测到 `requesting`，**每次模型请求发一次**：
   工具结果之后的下一次请求前还会再来一条（`s5` turn A 有 2 条）。
4. `command_lifecycle` 四态：`queued` / `started` / `completed` / `cancelled`，
   与 `result` 边界一一对应；`command_uuid` 就是 `user_message_uuids` 里的值。
5. 关 stdin：`exit code=0`，且非常快——`s3` 9ms、`s4` 21ms、`s5` 36ms、
   `s6` 24ms、`s7` 25ms。没有收尾 JSON 行（末尾半行都没有）。
6. 8 个场景全部没有出现 stdout 非 JSON 污染；但这是真实二进制的「正常态」，
   不代表故障态不会打印（`--verbose` 对照也没做）。

### R.4 interrupt（未知 5）

前台 Bash `sleep 15`，工具调用出现后 2 s 发 interrupt：

```text
+2478ms  cli->sdk  assistant tool_use Bash {"command":"sleep 15","run_in_background":false}
+4086ms  sdk->cli  control_request {"subtype":"interrupt","cancel_queued":true}
+4099ms  cli->sdk  control_response {"subtype":"success","request_id":"…",
                   "response":{"still_queued":[],"cancelled":[]}}      // 13ms
+4115ms  cli->sdk  user tool_result "The user doesn't want to proceed with this tool use. …"
+4115ms  cli->sdk  user text "[Request interrupted by user for tool use]"
+4122ms  cli->sdk  result {
           "subtype":"error_during_execution","is_error":true,
           "num_turns":3,"stop_reason":"tool_use",
           "terminal_reason":"aborted_tools",
           "errors":["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
           "total_cost_usd":0.000156805,
           "model_usage_since_last_result":{…}
         }                                                     // interrupt 后 36ms
+4127ms  cli->sdk  command_lifecycle state:"cancelled"
```

注意：终局 `result` **没有 `result` 字段**（不是空串，是缺键），`is_error:true`，
但 `subtype` 是 `error_during_execution` 而不是 `error`。`command_lifecycle`
随后单独发 `cancelled`。同一 PID 立刻复用：下一条 user 在 `result` 后 1ms 写入，
`+6114ms` 正常 `result(success, result:"OK")`。

**Rust 含义**：interrupt 的 ack 只代表「请求已收」，终局必须等 `result`；
`error_during_execution` + `terminal_reason:"aborted_tools"` 是取消的正常终态。
3 s 兜底杀进程可保留，但实测正常路径 36ms 就收敛，不需要重启。

### R.5 后台任务、`get_task_output`、`stop_task`（未知 6）

后台任务（`run_in_background:true`）的完整事件序列：

```json
{"type":"system","subtype":"background_tasks_changed","tasks":[
  {"task_id":"biw01mws5","run_id":"0mw7l8fr0-58e28fed","task_type":"local_bash",
   "description":"seq 1 5000; sleep 60"}]}

{"type":"system","subtype":"task_started","task_id":"biw01mws5",
 "run_id":"0mw7l8fr0-58e28fed","tool_use_id":"toolu_016TAHoq…",
 "description":"seq 1 5000; sleep 60","is_backgrounded":true,
 "task_type":"local_bash","uuid":"9eb2d63a-…","session_id":"c10e6c0b-…"}

// 工具结果（以 user tool_result 文本回报给模型）
"Command running in background with ID: biw01mws5. Output is being written to:
 /private/tmp/claude-502/<mangled-cwd>/<session_id>/tasks/biw01mws5.output.
 You will be notified when it completes. To check interim output, use Read on that file path."

{"type":"system","subtype":"task_updated","task_id":"biw01mws5",
 "run_id":"0mw7l8fr0-58e28fed","patch":{"status":"completed","end_time":1794127566790}}

{"type":"system","subtype":"task_notification","task_id":"b1pg0q52c",
 "run_id":"0mw7l883b-0c1902ba","tool_use_id":"toolu_01NCkBVp…",
 "status":"completed",
 "output_file":"/private/tmp/claude-502/<mangled-cwd>/<sid>/tasks/b1pg0q52c.output",
 "summary":"Background command \"sleep 3; echo done\" completed (exit code 0)"}

{"type":"system","subtype":"background_tasks_changed","tasks":[]}
```

`task_id` 是短 base36（如 `b1pg0q52c`），`run_id` 是 `<短id>-<8位hex>`；
`output_file` 在系统临时目录 `claude-<uid>/<mangled-cwd>/<session_id>/tasks/<task_id>.output`。
`task_updated.patch.status` 观测到 `completed` / `killed`；
`task_notification.status` 观测到 `completed` / `stopped`。

`get_task_output`（对一个 `seq 1 5000; sleep 60` 的任务，输出 23893 字节）：

```json
// 发
{"type":"control_request","request_id":"7l2qk95m6n",
 "request":{"subtype":"get_task_output","task_id":"biw01mws5"}}
// 收（4ms）
{"type":"control_response","response":{"subtype":"success","request_id":"7l2qk95m6n",
 "response":{"output":"2\n3363\n3364\n…\n4999\n5000\n",
             "total_bytes":23893,"truncated":true}}}
```

`output` 长度 **8192 字节**，是**尾部窗口**，且按字节截断、会切在数字中间
（本例从 `…3362` 中间切开，只剩 `2\n3363…`）。响应只有
`{output,total_bytes,truncated}` 三个键（没有 `bytes`）。

`stop_task`：

```json
// 发
{"type":"control_request","request_id":"bu8y37beqj6",
 "request":{"subtype":"stop_task","task_id":"biw01mws5"}}
// 收（6ms，且在应答前后同一批出现）
{"type":"control_response","response":{"subtype":"success","request_id":"bu8y37beqj6",
 "response":{}}}
{"type":"system","subtype":"task_updated","task_id":"biw01mws5",
 "patch":{"status":"killed","end_time":1794127576777}}
{"type":"system","subtype":"task_notification","task_id":"biw01mws5",
 "status":"stopped","summary":"seq 1 5000; sleep 60", …}
{"type":"system","subtype":"background_tasks_changed","tasks":[]}
```

另一个实测细节：**手动 stop 导致的通知不会触发 `UserPromptSubmit` hook**
（没有在飞 prompt），所以「stop 后 hook 收不到通知」不是 bug。

**Rust 含义**：`truncated` 的语义要按「最后 8 KiB、按字节、可能切在行中」实现；
不要按行补齐，也不要假设 ASCII；`total_bytes` 才是完整长度。

### R.6 `hook_callback`：放行、拦截、超时、error（未知 7、8）

请求形状（`s5`，通知触发）：

```json
{"type":"control_request","request_id":"…","request":{
  "subtype":"hook_callback","callback_id":"hook_0",
  "input":{"session_id":"c10e6c0b-…",
    "transcript_path":"/Users/…/.claude/projects/<mangled-cwd>/<sid>.jsonl",
    "cwd":"/private/tmp/claude-lane-capture/real/cwd",
    "prompt_id":"811ed2f2-d656-471c-8808-71bbdfb9ade7",
    "permission_mode":"bypassPermissions",
    "hook_event_name":"UserPromptSubmit",
    "prompt":"<task-notification>\n<task-id>b1pg0q52c</task-id>\n<tool-use-id>toolu_01NCkBVp…</tool-use-id>\n<output-file>…/tasks/b1pg0q52c.output</output-file>\n<status>completed</status>\n<summary>Background command \"sleep 3; echo done\" completed (exit code 0)</summary>\n</task-notification>"},
  "tool_use_id":"39e71876-8360-4ec1-852e-69d76223abfb"}}
```

**没有 `source` 字段**（本文早前版本假设的 `source:"system"` 不存在）；
`tool_use_id` 在顶层，且通知事件的 `tool_use_id` **不是**被通知任务的 tool_use_id
（是通知事件自己的 id）。识别通知只能看 `prompt` 前缀 `<task-notification>`。
`prompt_id` 是 UUID。

放行（`{}`）：

```text
+5145ms  cli->sdk  hook_callback（通知）
+5145ms  sdk->cli  control_response {"subtype":"success","response":{}}
+5145ms  cli->sdk  result num_turns:0 …（未被拦时的普通通知回合）
```

慢 hook：延迟 **5 s** 再回 `{}` 也被接受；回合同样只是在 hook 应答后才开始
（prompt `+5171ms` → `system/init` `+10182ms`）。

拦截：

```json
// SDK 回
{"type":"control_response","response":{"subtype":"success","request_id":"…",
 "response":{"decision":"block",
   "reason":"MultiCC queued this Monitor notification for an admitted turn.",
   "hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
     "suppressOriginalPrompt":true}}}}
// CLI 随后
{"type":"system","subtype":"informational","level":"warning",
 "content":"UserPromptSubmit operation blocked by hook:\nMultiCC queued this Monitor notification for an admitted turn.",
 "prevent_continuation":true,
 "prompt_submit_outcome":{"kind":"blocked_by_hook","prompt_kept":false,
   "reason":"MultiCC queued this Monitor notification for an admitted turn."}}
{"type":"result","subtype":"success","is_error":false,"num_turns":0,
 "stop_reason":null,
 "result":"UserPromptSubmit operation blocked by hook:\nMultiCC queued this Monitor notification for an admitted turn.",
 "origin":{"kind":"task-notification","producer":"session-task",
   "runId":"0mw7l883b-0c1902ba"}}
```

**重要**：被 block 的 result **带 `result` 字符串且包含 reason**，因此
`monitor-admission.js` 的 `isMonitorHandoffResult`（`num_turns===0 &&
result.includes(BLOCK_REASON)`）对真实二进制仍成立；`origin.kind` 实测就是
`"task-notification"`（抓包日志里被脱敏规则误伤成 `<task-<redacted>>`，真值如此）。

不回包（超时）：

```text
+169ms    cli->sdk  hook_callback callback_id="hook_does_not_exist"
+30192ms  cli->sdk  system/init
+30193ms  cli->sdk  system/informational {
            "content":"UserPromptSubmit operation blocked by hook:\nUserPromptSubmit hook callback timed out after 30000ms",
            "level":"warning","prevent_continuation":true,
            "prompt_submit_outcome":{"kind":"no_verdict","prompt_kept":false,
              "no_verdict_kind":"callback_timed_out"}}
+30194ms  cli->sdk  result {"is_error":false,"num_turns":0,"total_cost_usd":0,
            "result":"UserPromptSubmit operation blocked by hook:\nUserPromptSubmit hook callback timed out after 30000ms"}
```

CLI 侧硬超时 **30000ms**（从发出到放弃 30023ms），期间 prompt 不会开始，也不消耗
模型用量。Rust 侧 hook 执行必须有 <30s 的死线，并在超时后按「无裁决」处理。

hook error（SDK 回 `control_response` 的 error）：

```json
// sdk->cli，hook 抛错后立即（<1ms）
{"type":"control_response","response":{"subtype":"error",
 "request_id":"df5a28cd-7be4-45bf-b5d2-6d896e8f4644",
 "error":"deliberate hook error s6"}}
// CLI：
{"type":"system","subtype":"informational","level":"warning","tag":"hook_callback_failed",
 "content":"UserPromptSubmit: Hook callback hook_0 failed: the SDK host replied with an error or an invalid answer. Its answer was treated as empty."}
// 回合照常：+2027ms result success, is_error=false, num_turns=1, result:"OK"
```

**error 应答不致命**，语义 = 「hook 返回空答案」；回合继续，进程继续。
`control_response(error)` 里的 `request_id` 是 SDK 自己的请求 id（与
`hook_callback` 请求的 `request_id` 对应），不是 CLI 的 `callback_id`。

### R.7 `set_model` 与 `--resume`（场景 7）

`set_model`：

```text
+33971ms  sdk->cli  control_request {"subtype":"set_model","model":"sonnet"}
+33978ms  cli->sdk  user "<local-command-stdout>Set model to `sonnet (claude-sonnet-5-5)`</local-command-stdout>"
+33979ms  cli->sdk  control_response {"model":"claude-sonnet-5-5"}      // 2ms
+33993ms  cli->sdk  system/init model="claude-sonnet-5-5"
+35527ms  cli->sdk  result success result:"OK2"
```

两个坑：应答是 `{"model":"claude-sonnet-5-5"}`（不是 `{}`）；**应答之前** CLI 会
先重放一条 user 消息，`content` 是**字符串**（不是数组）且带
`<local-command-stdout>` 包裹。Rust 侧必须把这类本地命令回显吞掉，否则会被当
成新的用户输入。下一次 `system/init` 的 `model` 已是切换后的模型。

`--resume`：

```text
argv: --output-format stream-json --verbose --input-format stream-json
      --max-turns=4 --model=haiku --resume=b3fa4c45-ccb5-4819-8c32-422561369729
      --tools=Bash --permission-mode=bypassPermissions
      --allow-dangerously-skip-permissions --include-partial-messages

+5ms     sdk->cli user "Reply with exactly: OK3"
+184ms   cli->sdk system/init session_id=b3fa4c45-… model=claude-haiku-5-5 tools=["Bash"]
+2294ms  cli->sdk assistant "OK3"
+2324ms  cli->sdk result {"subtype":"success","num_turns":1,"result":"OK3",
         "usage":{"input_tokens":2,"cache_read_input_tokens":1966,…}}
+2351ms  exit code=0（关 stdin 后 25ms）
```

`init.session_id` 与 `--resume` 的 id 完全相同；历史从 transcript 装载
（`cache_read_input_tokens` 非 0 且远大于本回合输入）；`num_turns` 只计本回合。
恢复不需要额外控制请求，只是换 argv。

### R.8 对 Rust 实现的直接影响（与本文正文的差异点）

1. **`system/init` 每回合重发**：不能用「只认首条 init」的写法；每回合都可能
   用它校验 `session_id`（现在 MultiCC 的做法恰好兼容）。
2. **hook input 没有 `source`**：任何按 `input.source` 判断来源的逻辑都不成立；
   通知识别只能靠 `prompt` 的 `<task-notification>` 前缀（现有实现已是如此）。
3. **hook 死线 30 s**：Rust 侧必须自行超时并把超时映射成
   `prompt_submit_outcome.kind="no_verdict"` 等价语义；hook 抛错映射成
   `control_response(error)` 是安全的。
4. **`get_task_output` 是 8 KiB 尾部字节窗**：与 `d.ts` 描述一致，但要注意会切
   在行中；不要按行重排。
5. **interrupt 终局 `result` 无 `result` 字段**：解析器必须容忍键缺失。
6. **`set_model` 前的 `<local-command-stdout>` user 回显**：必须吞。
7. **argv 差异**：SDK 在 `includePartialMessages:true` 时会加
   `--include-partial-messages`（`s7` 实测）。不带该参数时**没有** `stream_event`
   帧（`s1` 两次裸 spawn 均为 0 条）；只要增量分帧，就必须保留该参数。
8. **仍待实测**：`--settings` 与 process env 的优先级（未知 9）、去掉 `--verbose`
   的行为（未知 11）、故障态 stdout 污染（未知 12）。
