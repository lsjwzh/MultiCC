# src 下的 JavaScript 用途盘点（2026-11-25）

基线为本地 main 合并提交 `a94bf826`。本表固定在删除 Codex 会话查找器之前，共 530 个唯一路径，其中 .js 525 个、.cjs 2 个、.mjs 3 个；根入口 server.js 单独计。后续工作树的实时列表见[模块依赖表](node-module-dependencies.md)。

## 生产包和源码的计数范围

服务包指纹 `26d7237cbdb9925abc8af9e8` 对应 309 个文件，其中 225 个 JavaScript 全部供浏览器执行。打包脚本复制 5 个 Rust 程序、public、插件的 ui/public 和版本信息，跳过整个 src、server.js 和 Node 模块。所以此包 backendJs=0、生产 Node 依赖为 0。Electron 和 standalone 兼容入口默认仍可启动 Node 宿主；其中会话管理、渠道、CLI 适配、任务编排等仍会执行服务端 JS。[服务打包脚本](../../scripts/stage-rust-runtime.sh) · [包内清点与探针](production-entry-2026-11-24.md) · [桌面启动参数](../../desktop/lib/desktop-env.js)

## 源文件分类

从 server.js 沿模块导入可达 518 个文件；再沿宿主传给 CLI、worker 和子进程的脚本路径可达 9 个。合计 527 个兼容后端文件，包含业务实现、运行时适配、HTTP 接线与 Rust 桥接。另有两个离线工具和一个目前仅测试引用的后端错误呈现模块。src 内测试套件文件和浏览器前端文件均为 0。名称带 ui、frontend 或 extension 的模块按调用环境分类，例如 directory/ui-layout.js 管理宿主数据，pi-router-extension.mjs 通过 Node 子进程和 readline 工作。

下表的主责按文件归类。HTTP 处理和 CLI 适配也可能含业务判断；直接调用原生接口的文件还可能有宿主编排。计数描述文件用途，不能换算为尚待移植的业务逻辑行数。

| 主要职责 | 文件数 |
|---|---:|
| 后端业务或其宿主编排 | 340 |
| 原生接口与兼容封装 | 18 |
| 宿主基础设施 | 44 |
| 离线工具 | 2 |
| CLI 协议与运行适配 | 20 |
| 宿主脚本或其依赖 | 9 |
| 仅见测试调用 | 1 |
| 后端 HTTP 处理与接线 | 96 |
| 测试套件 | 0 |
| 浏览器前端 | 0 |
| **合计** | **530** |

2026-11-27 更新：`src/powerd.js` 已退休。它只在测试里被引用，生产电源装配直接调用原生 addon；测试已改接 `systemPowerDaemon` / `powerDaemon`，本表该行仅作历史记录。

例如，`src/chat/model-timeout-recovery.js` 判断失败是否属于当前回合，并决定是否终止运行中的请求。`src/cli/session-policy.js` 的 backfill 从已有会话转录补回模型名。`src/task-shell/migration-progress.js` 虽归入宿主脚本依赖，仍在 JS 中把迁移阶段和字节数换算为进度。与这些实现相比，`src/request-locality.js` 将本地请求判定转发给 Rust。

## 逐文件依据

使用仓库的 inventory-node-backend.js 解析模块导入和本地脚本路径。最后一栏列一处直接调用方或模块引用方，条件分支也计入静态可达。离线入口从 scripts 单独追踪，error-presenter 另用仓库引用搜索核实。另有 195 个文件直接导入 src/native/ 下的模块，原生依赖栏列出这些导入。横线表示没有这类直接导入，仍可能经其他模块调用 Rust。

| 文件 | 主要职责 | 功能域 | 从兼容宿主到达方式 | 直接引用示例 | 直接导入的原生封装 |
|---|---|---|---|---|---|
| `src/agy-accounts.js` | 后端业务或其宿主编排 | agy-accounts | 模块导入 | `src/cli-adapters/commands.js` | `native/runtime.js` |
| `src/annotation-live.js` | 后端业务或其宿主编排 | annotation-live | 模块导入 | `src/routes/events-host.js` | — |
| `src/api-contract.js` | 后端业务或其宿主编排 | api-contract | 模块导入 | `server.js` | — |
| `src/apk-distribution.js` | 后端业务或其宿主编排 | apk-distribution | 模块导入 | `server.js` | — |
| `src/artifact-reference.js` | 后端业务或其宿主编排 | artifact-reference | 模块导入 | `src/artifact-retention.js` | — |
| `src/artifact-retention.js` | 后端业务或其宿主编排 | artifact-retention | 模块导入 | `src/docs-registry.js` | — |
| `src/artifacts.js` | 后端业务或其宿主编排 | artifacts | 模块导入 | `server.js` | — |
| `src/auth-security.js` | 原生接口与兼容封装 | 宿主公共接口 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/aux-http.js` | 后端业务或其宿主编排 | aux-http | 模块导入 | `server.js` | — |
| `src/battery-guard.js` | 后端业务或其宿主编排 | battery-guard | 模块导入 | `server.js` | — |
| `src/bus.js` | 宿主基础设施 | bus | 模块导入 | `server.js` | — |
| `src/cdp-relay.js` | 宿主基础设施 | cdp-relay | 模块导入 | `src/chrome-cdp.js` | — |
| `src/cdpd.js` | 宿主基础设施 | cdpd | 模块导入 | `src/cdp-relay.js` | — |
| `src/chat/adapter-completion.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/turn-engine.js` | `native/runtime.js` |
| `src/chat/admission-progress.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/auto-provider-runtime.js` | — |
| `src/chat/api-error-host.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/index.js` | — |
| `src/chat/api-error-policy.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/admission-progress.js` | `native/runtime.js` |
| `src/chat/auto-provider-policy.js` | 原生接口与兼容封装 | 聊天执行 | 模块导入 | `src/chat/auto-provider-runtime.js` | `native/runtime.js` |
| `src/chat/auto-provider-pricing.js` | 原生接口与兼容封装 | 聊天执行 | 模块导入 | `src/chat/auto-provider-runtime.js` | `native/runtime.js` |
| `src/chat/auto-provider-routing.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/auto-provider-runtime.js` | `native/runtime.js` |
| `src/chat/auto-provider-runtime.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/turn-engine.js` | `native/runtime.js` |
| `src/chat/auto-route-notes.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/turn-engine.js` | — |
| `src/chat/background-hold.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/chat-stream.js` | `native/runtime.js` |
| `src/chat/background-task-runtime.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/chat/chat-stream.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | — |
| `src/chat/claude-sdk-config.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/claude-sdk-stream.js` | — |
| `src/chat/claude-sdk-route.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/claude-sdk-config.js` | — |
| `src/chat/claude-sdk-stream.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/chat-stream.js` | `native/runtime.js` |
| `src/chat/cli-relay-spawn.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/turn-engine.js` | — |
| `src/chat/codex-app-stream.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/chat-stream.js` | — |
| `src/chat/codex-rollout-guard.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/turn-engine.js` | `native/runtime.js` |
| `src/chat/error-persistence.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | — |
| `src/chat/finalize-host.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/index.js` | `native/runtime.js` |
| `src/chat/finalize-plan.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/index.js` | `native/runtime.js` |
| `src/chat/held-turn-injection.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | — |
| `src/chat/history-frame-budget.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/turn-engine.js` | `native/runtime.js` |
| `src/chat/host-coordinator.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/chat/host-prompts.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/chat/host-runtime.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/index.js` | — |
| `src/chat/index.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/chat/managed-context.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/turn-engine.js` | `native/runtime.js` |
| `src/chat/missing-resume-recovery.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/chat-stream.js` | `native/runtime.js` |
| `src/chat/model-timeout-recovery.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | — |
| `src/chat/monitor-admission.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/chat-stream.js` | — |
| `src/chat/monitor-control.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/chat-stream.js` | — |
| `src/chat/native-session-guard.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/turn-engine.js` | `native/runtime.js` |
| `src/chat/opencode-context-guard.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/turn-engine.js` | `native/runtime.js` |
| `src/chat/opencode-context.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/opencode-context-guard.js` | `native/runtime.js` |
| `src/chat/post-turn-router.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/host-coordinator.js` | — |
| `src/chat/process-close.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/chat-stream.js` | — |
| `src/chat/process-watchdog.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | — |
| `src/chat/provider-attempt-runtime.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/index.js` | `native/runtime.js` |
| `src/chat/provider-log-watchdog.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | — |
| `src/chat/proxy-broadcast.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | — |
| `src/chat/resident-composition.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | — |
| `src/chat/resident-pool.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/resident-composition.js` | — |
| `src/chat/retry-policy.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/index.js` | `native/runtime.js` |
| `src/chat/runtime-store.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/index.js` | — |
| `src/chat/session-notices.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | — |
| `src/chat/sessions.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | — |
| `src/chat/stalled-turn-recovery.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | — |
| `src/chat/stream-router.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/chat-stream.js` | — |
| `src/chat/task-state-payload.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/task-state-seed.js` | `native/runtime.js` |
| `src/chat/task-state-seed.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/turn-engine.js` | `native/runtime.js` |
| `src/chat/transcript-prune.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/turn-engine.js` | `native/runtime.js` |
| `src/chat/turn-engine.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/chat/turn-event-journal.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | — |
| `src/chat/turn-event-replay.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/turn-engine.js` | — |
| `src/chat/turn-lifecycle.js` | 原生接口与兼容封装 | 聊天执行 | 模块导入 | `src/chat/host-coordinator.js` | `native/runtime.js` |
| `src/chat/turn-progress.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/chat/turn-request.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/index.js` | `native/runtime.js` |
| `src/chat/usage-limit-wiring.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `server.js` | — |
| `src/chat/workspace-residency.js` | 后端业务或其宿主编排 | 聊天执行 | 模块导入 | `src/chat/stream-router.js` | — |
| `src/chrome-cdp.js` | 宿主基础设施 | chrome-cdp | 模块导入 | `src/quota-managed-browser.js` | — |
| `src/classify/aux-run-log.js` | 后端业务或其宿主编排 | 归属与分类 | 模块导入 | `src/routes/aux-runs.js` | — |
| `src/classify/aux-verdict-health.js` | 后端业务或其宿主编排 | 归属与分类 | 模块导入 | `server.js` | — |
| `src/classify/history-backtest.js` | 离线工具 | 归属与分类 | 独立脚本 | `scripts/backtest-task-attribution.js` | — |
| `src/classify/state-machine.js` | 后端业务或其宿主编排 | 归属与分类 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/classify/task-attribution.js` | 后端业务或其宿主编排 | 归属与分类 | 模块导入 | `src/classify/state-machine.js` | — |
| `src/classify/task-short-code.js` | 后端业务或其宿主编排 | 归属与分类 | 模块导入 | `server.js` | — |
| `src/classify/turn-state.js` | 原生接口与兼容封装 | 归属与分类 | 模块导入 | `src/classify/state-machine.js` | `native/runtime.js` |
| `src/classify/vocab.js` | 后端业务或其宿主编排 | 归属与分类 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/claude-auth/account-credentials.js` | 后端业务或其宿主编排 | Claude账户 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/claude-auth/accounts-refresh.js` | 后端业务或其宿主编排 | Claude账户 | 模块导入 | `server.js` | — |
| `src/claude-auth/egress-agent.js` | 后端业务或其宿主编排 | Claude账户 | 模块导入 | `server.js` | — |
| `src/claude-auth/expired-refresh-policy.js` | 后端业务或其宿主编排 | Claude账户 | 模块导入 | `src/claude-auth/accounts-refresh.js` | `native/runtime.js` |
| `src/claude-auth/oauth-refresh.js` | 后端业务或其宿主编排 | Claude账户 | 模块导入 | `server.js` | — |
| `src/claude-auth/official-oauth.js` | 后端业务或其宿主编排 | Claude账户 | 模块导入 | `src/official-accounts-cli-login.js` | `native/runtime.js` |
| `src/claude-auth/proxy-recovery.js` | 后端业务或其宿主编排 | Claude账户 | 模块导入 | `src/providers/router-port.js` | — |
| `src/claude-auth/refresh-health.js` | 后端业务或其宿主编排 | Claude账户 | 模块导入 | `server.js` | — |
| `src/claude-models.js` | 后端业务或其宿主编排 | claude-models | 模块导入 | `src/cli/session-policy.js` | — |
| `src/cli-adapters/acp.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/cli-adapters/gemini.js` | `native/runtime.js` |
| `src/cli-adapters/agy.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/cli-adapters/index.js` | `native/runtime.js` |
| `src/cli-adapters/claude-agent-sdk-bridge.mjs` | 宿主脚本或其依赖 | CLI适配 | 含脚本路径 | `src/native/runtime.js` | `native/runtime.js` |
| `src/cli-adapters/codebuddy.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/cli-adapters/index.js` | `native/runtime.js` |
| `src/cli-adapters/codex-session-file.js` | 后端业务或其宿主编排 | CLI适配 | 模块导入 | `server.js` | — |
| `src/cli-adapters/command-code.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/cli-adapters/index.js` | `native/runtime.js` |
| `src/cli-adapters/commands.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/cli-adapters/completion.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/chat/adapter-completion.js` | `native/runtime.js` |
| `src/cli-adapters/dsh.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/cli-adapters/index.js` | `native/runtime.js` |
| `src/cli-adapters/gemini.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/cli-adapters/index.js` | — |
| `src/cli-adapters/grok.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/cli-adapters/index.js` | — |
| `src/cli-adapters/index.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/cli-adapters/kimi-auth.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/routes/kimi-auth.js` | — |
| `src/cli-adapters/kimi.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/cli-adapters/index.js` | `native/runtime.js` |
| `src/cli-adapters/opencode-like.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/cli-adapters/opencode.js` | `native/runtime.js` |
| `src/cli-adapters/opencode.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/cli-adapters/index.js` | `native/runtime.js` |
| `src/cli-adapters/pi-router-extension.mjs` | 宿主脚本或其依赖 | CLI适配 | 含脚本路径 | `src/cli-adapters/pi.js` | — |
| `src/cli-adapters/pi.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/cli-adapters/index.js` | `native/runtime.js` |
| `src/cli-adapters/qoder.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/cli-adapters/index.js` | `native/runtime.js` |
| `src/cli-adapters/result-completion.js` | 原生接口与兼容封装 | CLI适配 | 模块导入 | `src/chat/background-hold.js` | `native/runtime.js` |
| `src/cli-adapters/router-mcp.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/cli-adapters/codebuddy.js` | `native/runtime.js` |
| `src/cli-adapters/step-completion.js` | 原生接口与兼容封装 | CLI适配 | 模块导入 | `src/cli-adapters/opencode-like.js` | `native/runtime.js` |
| `src/cli-adapters/vendor-login.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `server.js` | — |
| `src/cli-adapters/zcode-app-server.js` | 宿主脚本或其依赖 | CLI适配 | 含脚本路径 | `src/cli-adapters/zcode-bridge.cjs` | — |
| `src/cli-adapters/zcode-auth.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/routes/zcode-auth.js` | `native/runtime.js` |
| `src/cli-adapters/zcode-bridge.cjs` | 宿主脚本或其依赖 | CLI适配 | 含脚本路径 | `src/cli-adapters/zcode.js` | `native/runtime.js` |
| `src/cli-adapters/zcode-terminal.cjs` | 宿主脚本或其依赖 | CLI适配 | 含脚本路径 | `src/cli-adapters/zcode.js` | `native/runtime.js` |
| `src/cli-adapters/zcode.js` | CLI 协议与运行适配 | CLI适配 | 模块导入 | `src/cli-adapters/index.js` | `native/runtime.js` |
| `src/cli-key-accounts.js` | 后端业务或其宿主编排 | cli-key-accounts | 模块导入 | `server.js` | — |
| `src/cli-switch.js` | 后端业务或其宿主编排 | cli-switch | 模块导入 | `server.js` | `native/runtime.js` |
| `src/cli/claude-bundled-binary.js` | 后端业务或其宿主编排 | CLI管理 | 模块导入 | `server.js` | — |
| `src/cli/cli-capability.js` | 后端业务或其宿主编排 | CLI管理 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/cli/cli-upstream-version.js` | 后端业务或其宿主编排 | CLI管理 | 模块导入 | `src/cli/tools-host.js` | `native/runtime.js` |
| `src/cli/homebrew-takeover.js` | 后端业务或其宿主编排 | CLI管理 | 模块导入 | `src/cli/tools-host.js` | `native/runtime.js` |
| `src/cli/native-session-exists.js` | 后端业务或其宿主编排 | CLI管理 | 模块导入 | `src/cli/switch-runtime.js` | — |
| `src/cli/session-policy.js` | 后端业务或其宿主编排 | CLI管理 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/cli/switch-preparation.js` | 后端业务或其宿主编排 | CLI管理 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/cli/switch-runtime.js` | 后端业务或其宿主编排 | CLI管理 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/cli/tools-host.js` | 后端业务或其宿主编排 | CLI管理 | 模块导入 | `src/cli/switch-runtime.js` | `native/runtime.js` |
| `src/codex-auth/official-oauth.js` | 后端业务或其宿主编排 | Codex认证 | 模块导入 | `src/routes/codex-accounts.js` | — |
| `src/codex/accounts-refresh.js` | 后端业务或其宿主编排 | Codex运行时 | 模块导入 | `server.js` | — |
| `src/codex/attempt-home.js` | 后端业务或其宿主编排 | Codex运行时 | 模块导入 | `src/providers/core.js` | — |
| `src/codex/image-bridge-runtime.js` | 后端业务或其宿主编排 | Codex运行时 | 模块导入 | `server.js` | — |
| `src/codex/image-bridge.js` | 后端业务或其宿主编排 | Codex运行时 | 模块导入 | `src/codex/image-bridge-runtime.js` | — |
| `src/codex/model-catalog.js` | 后端业务或其宿主编排 | Codex运行时 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/codex/oauth-refresh.js` | 后端业务或其宿主编排 | Codex运行时 | 模块导入 | `server.js` | — |
| `src/codex/official-relay.js` | 后端业务或其宿主编排 | Codex运行时 | 模块导入 | `src/codex/image-bridge.js` | `native/runtime.js` |
| `src/codex/proxy-trace.js` | 后端业务或其宿主编排 | Codex运行时 | 模块导入 | `src/codex/official-relay.js` | — |
| `src/codex/resident-route.js` | 后端业务或其宿主编排 | Codex运行时 | 模块导入 | `src/chat/codex-app-stream.js` | `native/runtime.js` |
| `src/codex/session-home.js` | 后端业务或其宿主编排 | Codex运行时 | 模块导入 | `src/providers/core.js` | — |
| `src/codex/usage.js` | 后端业务或其宿主编排 | Codex运行时 | 模块导入 | `server.js` | — |
| `src/commander-migration.js` | 后端业务或其宿主编排 | commander-migration | 模块导入 | `server.js` | — |
| `src/context/selection.js` | 后端业务或其宿主编排 | 上下文 | 模块导入 | `src/task-shell/context-plan.js` | `native/runtime.js` |
| `src/detached.js` | 宿主基础设施 | detached | 模块导入 | `server.js` | — |
| `src/directories.js` | 后端业务或其宿主编排 | directories | 模块导入 | `server.js` | `native/runtime.js` |
| `src/directory/index.js` | 后端业务或其宿主编排 | 目录 | 模块导入 | `server.js` | — |
| `src/directory/records.js` | 后端业务或其宿主编排 | 目录 | 模块导入 | `server.js` | — |
| `src/directory/repository.js` | 后端业务或其宿主编排 | 目录 | 模块导入 | `src/directory/index.js` | — |
| `src/directory/sample-workspace.js` | 后端业务或其宿主编排 | 目录 | 模块导入 | `src/routes/directory-host.js` | — |
| `src/directory/ui-layout.js` | 后端业务或其宿主编排 | 目录 | 模块导入 | `src/directory/index.js` | — |
| `src/dispatch/gateway-host.js` | 后端业务或其宿主编排 | 派发 | 模块导入 | `server.js` | — |
| `src/dispatch/progress.js` | 后端业务或其宿主编排 | 派发 | 模块导入 | `server.js` | — |
| `src/dispatch/targeting.js` | 后端业务或其宿主编排 | 派发 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/docs-registry.js` | 后端业务或其宿主编排 | docs-registry | 模块导入 | `server.js` | — |
| `src/doctor/environment.js` | 后端业务或其宿主编排 | 诊断 | 模块导入 | `src/doctor/host.js` | — |
| `src/doctor/host.js` | 后端业务或其宿主编排 | 诊断 | 模块导入 | `server.js` | — |
| `src/doctor/llm-loop.js` | 后端业务或其宿主编排 | 诊断 | 模块导入 | `src/doctor/environment.js` | — |
| `src/doctor/service.js` | 后端业务或其宿主编排 | 诊断 | 模块导入 | `src/doctor/host.js` | — |
| `src/doctor/tools.js` | 后端业务或其宿主编排 | 诊断 | 模块导入 | `src/doctor/environment.js` | — |
| `src/events/actions.js` | 后端业务或其宿主编排 | 事件 | 模块导入 | `src/events/engine.js` | — |
| `src/events/catalog.js` | 后端业务或其宿主编排 | 事件 | 模块导入 | `src/events/engine.js` | `native/runtime.js` |
| `src/events/engine.js` | 后端业务或其宿主编排 | 事件 | 模块导入 | `src/events/host.js` | — |
| `src/events/envelope.js` | 后端业务或其宿主编排 | 事件 | 模块导入 | `src/events/actions.js` | `native/runtime.js` |
| `src/events/host.js` | 后端业务或其宿主编排 | 事件 | 模块导入 | `server.js` | — |
| `src/events/hub.js` | 后端业务或其宿主编排 | 事件 | 模块导入 | `src/events/host.js` | — |
| `src/events/rules.js` | 后端业务或其宿主编排 | 事件 | 模块导入 | `src/events/engine.js` | `native/runtime.js` |
| `src/events/task-transitions.js` | 后端业务或其宿主编排 | 事件 | 模块导入 | `src/events/hub.js` | `native/runtime.js` |
| `src/experiments/tui-chat-mirror-runtime.js` | 后端业务或其宿主编排 | 终端镜像 | 模块导入 | `server.js` | — |
| `src/fleet-sharing.js` | 后端业务或其宿主编排 | fleet-sharing | 模块导入 | `server.js` | `native/runtime.js` |
| `src/gateway-child.js` | 宿主基础设施 | gateway-child | 模块导入 | `server.js` | — |
| `src/git/default-commit-message.js` | 原生接口与兼容封装 | Git | 模块导入 | `src/git/service.js` | `native/runtime.js` |
| `src/git/queue.js` | 后端业务或其宿主编排 | Git | 模块导入 | `server.js` | — |
| `src/git/service.js` | 后端业务或其宿主编排 | Git | 模块导入 | `server.js` | `native/runtime.js` |
| `src/git/wake-sync.js` | 原生接口与兼容封装 | Git | 模块导入 | `src/git/service.js` | `native/runtime.js` |
| `src/host-battery.js` | 宿主基础设施 | host-battery | 模块导入 | `src/routes/host-read-host.js` | — |
| `src/host-env.js` | 宿主基础设施 | host-env | 模块导入 | `server.js` | — |
| `src/host-lifecycle.js` | 宿主基础设施 | host-lifecycle | 模块导入 | `server.js` | — |
| `src/host-power-services.js` | 宿主基础设施 | host-power-services | 模块导入 | `src/routes/host-power.js` | — |
| `src/http-errors.js` | 宿主基础设施 | http-errors | 模块导入 | `server.js` | `native/runtime.js` |
| `src/http/domain-error.js` | 宿主基础设施 | HTTP | 模块导入 | `plugins/utils/macos-power.js` | — |
| `src/http/error-map.js` | 宿主基础设施 | HTTP | 模块导入 | `src/routes/docs-memory-host.js` | — |
| `src/http/error-presenter.js` | 仅见测试调用 | HTTP 错误呈现 | 仅见测试 | `tests/test-memo-http-controller.js、tests/test-http-error-boundary.js` | — |
| `src/http/http-error.js` | 宿主基础设施 | HTTP | 模块导入 | `src/http/error-map.js` | — |
| `src/http/json-compression.js` | 宿主基础设施 | HTTP | 模块导入 | `server.js` | — |
| `src/http/public-safety.js` | 宿主基础设施 | HTTP | 模块导入 | `src/http/error-map.js` | — |
| `src/ios-ota.js` | 后端业务或其宿主编排 | ios-ota | 模块导入 | `server.js` | — |
| `src/ios-udid.js` | 后端业务或其宿主编排 | ios-udid | 模块导入 | `src/routes/system.js` | — |
| `src/lan-discovery.js` | 宿主基础设施 | lan-discovery | 模块导入 | `server.js` | — |
| `src/liveness/process-probe.js` | 后端业务或其宿主编排 | 会话存活 | 模块导入 | `server.js` | — |
| `src/liveness/rollout-path.js` | 后端业务或其宿主编排 | 会话存活 | 模块导入 | `server.js` | — |
| `src/liveness/runtime.js` | 后端业务或其宿主编排 | 会话存活 | 模块导入 | `server.js` | — |
| `src/log-housekeeping.js` | 宿主基础设施 | log-housekeeping | 模块导入 | `server.js` | — |
| `src/machines.js` | 后端业务或其宿主编排 | machines | 模块导入 | `server.js` | `native/runtime.js` |
| `src/macos-agent-build.js` | 后端业务或其宿主编排 | macos-agent-build | 模块导入 | `src/macos-agent-provision.js` | — |
| `src/macos-agent-provision.js` | 后端业务或其宿主编排 | macos-agent-provision | 模块导入 | `src/plugins/catalog.js` | — |
| `src/macos-unlock-password.js` | 后端业务或其宿主编排 | macos-unlock-password | 模块导入 | `src/host-power-services.js` | — |
| `src/macos-unlock-probe.js` | 后端业务或其宿主编排 | macos-unlock-probe | 模块导入 | `src/host-power-services.js` | — |
| `src/memo/controller.js` | 后端业务或其宿主编排 | 备忘录 | 模块导入 | `src/memo/index.js` | — |
| `src/memo/file-port.js` | 后端业务或其宿主编排 | 备忘录 | 模块导入 | `src/memo/index.js` | — |
| `src/memo/index.js` | 后端业务或其宿主编排 | 备忘录 | 模块导入 | `server.js` | — |
| `src/memo/migrate.js` | 后端业务或其宿主编排 | 备忘录 | 模块导入 | `src/memo/index.js` | — |
| `src/memory-store.js` | 后端业务或其宿主编排 | memory-store | 模块导入 | `server.js` | — |
| `src/memory/builtin-rules.js` | 后端业务或其宿主编排 | 记忆 | 模块导入 | `src/memory/folder-service.js` | — |
| `src/memory/folder-service.js` | 后端业务或其宿主编排 | 记忆 | 模块导入 | `server.js` | — |
| `src/memory/retrieval.js` | 后端业务或其宿主编排 | 记忆 | 模块导入 | `src/memory/folder-service.js` | `native/runtime.js` |
| `src/memory/runtime.js` | 后端业务或其宿主编排 | 记忆 | 模块导入 | `server.js` | — |
| `src/memory/task-distill.js` | 后端业务或其宿主编排 | 记忆 | 模块导入 | `server.js` | — |
| `src/model-history-converter.js` | 后端业务或其宿主编排 | model-history-converter | 模块导入 | `src/codex/official-relay.js` | — |
| `src/native/runtime.js` | 原生接口与兼容封装 | 原生接口 | 模块导入 | `server.js` | `native/runtime.js`, `native/task-domain.js` |
| `src/native/task-domain.js` | 原生接口与兼容封装 | 原生接口 | 模块导入 | `src/native/runtime.js` | `native/runtime.js` |
| `src/native/task-read-model.js` | 原生接口与兼容封装 | 原生接口 | 模块导入 | `src/workspace/air-index-port.js` | `native/runtime.js` |
| `src/native/task-search.js` | 原生接口与兼容封装 | 原生接口 | 模块导入 | `src/routes/task-search.js` | `native/runtime.js` |
| `src/network-policy.js` | 原生接口与兼容封装 | 宿主公共接口 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/network/egress-fetch.js` | 宿主基础设施 | 网络 | 模块导入 | `src/routes/claude-accounts.js` | — |
| `src/network/global-proxy.js` | 宿主基础设施 | 网络 | 模块导入 | `server.js` | — |
| `src/network/outbound.js` | 宿主基础设施 | 网络 | 模块导入 | `plugins/bridges/discord-bridge.js` | — |
| `src/network/proxy-policy.js` | 宿主基础设施 | 网络 | 模块导入 | `src/network/global-proxy.js` | — |
| `src/network/sdk-bridges.js` | 宿主基础设施 | 网络 | 模块导入 | `plugins/bridges/discord-bridge.js` | — |
| `src/notes-store.js` | 后端业务或其宿主编排 | notes-store | 模块导入 | `server.js` | — |
| `src/observability.js` | 宿主基础设施 | observability | 模块导入 | `server.js` | `native/runtime.js` |
| `src/official-accounts-cli-login.js` | 后端业务或其宿主编排 | official-accounts-cli-login | 模块导入 | `server.js` | — |
| `src/official-accounts.js` | 后端业务或其宿主编排 | official-accounts | 模块导入 | `server.js` | `native/runtime.js` |
| `src/operation-service.js` | 后端业务或其宿主编排 | operation-service | 模块导入 | `src/orchestration/runtime.js` | `native/runtime.js` |
| `src/orchestration/draft-host.js` | 后端业务或其宿主编排 | 编排 | 模块导入 | `src/orchestration/sqlite-store.js` | — |
| `src/orchestration/native-command.js` | 后端业务或其宿主编排 | 编排 | 模块导入 | `src/orchestration/native-store-host.js` | `native/runtime.js` |
| `src/orchestration/native-store-host.js` | 后端业务或其宿主编排 | 编排 | 模块导入 | `src/orchestration/sqlite-store.js` | `native/runtime.js` |
| `src/orchestration/runtime.js` | 后端业务或其宿主编排 | 编排 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/orchestration/sqlite-store.js` | 后端业务或其宿主编排 | 编排 | 模块导入 | `src/orchestration/runtime.js` | — |
| `src/orchestration/store.js` | 后端业务或其宿主编排 | 编排 | 模块导入 | `src/orchestration/draft-host.js` | — |
| `src/outbox.js` | 后端业务或其宿主编排 | outbox | 模块导入 | `src/operation-service.js` | `native/runtime.js` |
| `src/paths.js` | 宿主基础设施 | paths | 模块导入 | `server.js` | `native/runtime.js` |
| `src/plugins/catalog.js` | 后端业务或其宿主编排 | 插件 | 模块导入 | `src/routes/plugins.js` | — |
| `src/plugins/channel-host.js` | 后端业务或其宿主编排 | 插件 | 模块导入 | `src/routes/plugins.js` | — |
| `src/plugins/channel-registry.js` | 后端业务或其宿主编排 | 插件 | 模块导入 | `src/events/actions.js` | — |
| `src/plugins/installer.js` | 后端业务或其宿主编排 | 插件 | 模块导入 | `src/routes/plugins.js` | `native/runtime.js` |
| `src/portable-git.js` | 宿主基础设施 | portable-git | 模块导入 | `src/repo-actor.js` | — |
| `src/powerd.js` | 宿主基础设施 | powerd | 模块导入 | `plugins/utils/macos-power.js` | — |
| `src/pricing/price-table.js` | 后端业务或其宿主编排 | 定价 | 模块导入 | `src/chat/auto-provider-runtime.js` | — |
| `src/provider-error.js` | 后端业务或其宿主编排 | provider-error | 模块导入 | `src/chat/api-error-policy.js` | `native/runtime.js` |
| `src/provider-reassign.js` | 后端业务或其宿主编排 | provider-reassign | 模块导入 | `src/routes/providers-host.js` | — |
| `src/providers/auto-provider-config.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/providers/binding.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/chat/turn-request.js` | — |
| `src/providers/claude-quota-bridge.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/providers/router-port.js` | `native/runtime.js` |
| `src/providers/codex-history-hooks.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/providers/router-port.js` | — |
| `src/providers/core.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/providers/defaults-port.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/providers/core.js` | `native/runtime.js` |
| `src/providers/egress-ip-policy.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/chat/turn-engine.js` | — |
| `src/providers/egress-ip.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/providers/egress-ip-policy.js` | — |
| `src/providers/force-detach.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/routes/providers-host.js` | `native/runtime.js` |
| `src/providers/jev-client.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/chat/auto-provider-routing.js` | — |
| `src/providers/model-connect-watch.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/providers/proxy-guard.js` | `native/runtime.js` |
| `src/providers/native-opencode.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/chat/auto-provider-runtime.js` | — |
| `src/providers/native-store.js` | 原生接口与兼容封装 | 供应商 | 模块导入 | `src/providers/core.js` | `native/runtime.js` |
| `src/providers/native-subscription.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/quota/account-subscription-reader.js` | `native/runtime.js` |
| `src/providers/native-vendor.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/chat/auto-provider-runtime.js` | — |
| `src/providers/official-catalog.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `server.js` | — |
| `src/providers/opencode-model-limits.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/providers/core.js` | — |
| `src/providers/proxy-guard.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/providers/router-port.js` | — |
| `src/providers/proxy-outcome.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/providers/proxy-guard.js` | — |
| `src/providers/proxy-stall-watch.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/chat/model-timeout-recovery.js` | `native/runtime.js` |
| `src/providers/relay-model-catalog.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `server.js` | — |
| `src/providers/relay-share-store.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/providers/router-adapter.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/providers/router-runtime.js` | — |
| `src/providers/router-port.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/providers/router-runtime.js` | — |
| `src/providers/router-runtime.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `server.js` | — |
| `src/providers/rust-cpr.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/providers/router-runtime.js` | `native/runtime.js` |
| `src/providers/virtual-provider.js` | 后端业务或其宿主编排 | 供应商 | 模块导入 | `src/providers/core.js` | `native/runtime.js` |
| `src/push/bark-devices.js` | 后端业务或其宿主编排 | 推送 | 模块导入 | `src/push/service.js` | — |
| `src/push/business.js` | 后端业务或其宿主编排 | 推送 | 模块导入 | `src/push/service.js` | — |
| `src/push/channel-subscriptions.js` | 后端业务或其宿主编排 | 推送 | 模块导入 | `src/push/service.js` | — |
| `src/push/fcm-devices.js` | 后端业务或其宿主编排 | 推送 | 模块导入 | `src/push/service.js` | — |
| `src/push/fcm-transport.js` | 后端业务或其宿主编排 | 推送 | 模块导入 | `src/push/fcm-devices.js` | — |
| `src/push/notification-copy.js` | 后端业务或其宿主编排 | 推送 | 模块导入 | `src/push/runtime.js` | — |
| `src/push/runtime.js` | 后端业务或其宿主编排 | 推送 | 模块导入 | `server.js` | — |
| `src/push/service.js` | 后端业务或其宿主编排 | 推送 | 模块导入 | `server.js` | — |
| `src/quota-managed-browser.js` | 后端业务或其宿主编排 | quota-managed-browser | 模块导入 | `src/routes/aliyun-quota.js` | — |
| `src/quota/account-subscription-cache.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `src/providers/virtual-provider.js` | `native/runtime.js` |
| `src/quota/account-subscription-reader.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `server.js` | — |
| `src/quota/claude-bar-state.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `src/chat/proxy-broadcast.js` | `native/runtime.js` |
| `src/quota/claude-cli-oauth.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `src/claude-auth/account-credentials.js` | `native/runtime.js` |
| `src/quota/claude-usage-queue.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `src/chat/usage-limit-wiring.js` | — |
| `src/quota/codex-usage-request.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `src/routes/codex-quota.js` | `native/runtime.js` |
| `src/quota/limit-cache-recorder.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `src/quota/provider-runtime.js` | `native/runtime.js` |
| `src/quota/official-account-usage.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `server.js` | — |
| `src/quota/opencode-zen.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `src/routes/opencode-quota.js` | — |
| `src/quota/provider-limit-cache-native-host.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `src/chat/auto-provider-runtime.js` | `native/runtime.js` |
| `src/quota/provider-limit-sync.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `src/quota/provider-runtime.js` | — |
| `src/quota/provider-quota-history.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `src/quota/provider-runtime.js` | `native/runtime.js` |
| `src/quota/provider-runtime.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `server.js` | — |
| `src/quota/quota-bar-cache.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `src/quota/provider-runtime.js` | — |
| `src/quota/quota-bar-view.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `src/chat/provider-log-watchdog.js` | `native/runtime.js` |
| `src/quota/quota-guard.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `src/quota/provider-runtime.js` | `native/runtime.js` |
| `src/quota/quota-self-heal.js` | 后端业务或其宿主编排 | 额度 | 模块导入 | `server.js` | — |
| `src/repo-actor.js` | 后端业务或其宿主编排 | repo-actor | 模块导入 | `src/git/queue.js` | — |
| `src/request-locality.js` | 原生接口与兼容封装 | 宿主公共接口 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/role-token-tracker.js` | 后端业务或其宿主编排 | role-token-tracker | 模块导入 | `server.js` | — |
| `src/router-tool-host.js` | 后端业务或其宿主编排 | router-tool-host | 模块导入 | `server.js` | — |
| `src/router-tool-runtime.js` | 后端业务或其宿主编排 | router-tool-runtime | 模块导入 | `src/router-tool-host.js` | `native/runtime.js` |
| `src/routes/account-routes-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/agent-resources-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/agent-resources.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/agy-accounts.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/session-create.js` | — |
| `src/routes/agy-models.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/providers/native-vendor.js` | — |
| `src/routes/aliyun-quota.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/quota-host.js` | — |
| `src/routes/ark-quota.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/quota-host.js` | — |
| `src/routes/auth.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/routes/aux-goal.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/aux-runs.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/chat-history.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/routes/claude-accounts.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/claude-oauth.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/claude-usage-quota.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/quota-host.js` | — |
| `src/routes/cli-key-accounts.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/cli-switch-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/cli/switch-runtime.js` | — |
| `src/routes/codebuddy-models.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/providers/native-vendor.js` | — |
| `src/routes/codex-accounts.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/codex-oauth.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/codex-quota.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/quota-host.js` | `native/runtime.js` |
| `src/routes/commandcode-auth.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/commandcode-models.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/providers/native-vendor.js` | — |
| `src/routes/developer-tools.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/host-ops-host.js` | — |
| `src/routes/directory-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/directory/index.js` | — |
| `src/routes/docs-memory-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/events-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/file-transfer-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/grok-models.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/providers/native-vendor.js` | — |
| `src/routes/host-ops-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/host-power.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/host-write.js` | — |
| `src/routes/host-read-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/host-write.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/host-ops-host.js` | `native/runtime.js` |
| `src/routes/kimi-auth.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/kimi-quota.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/aliyun-quota.js` | — |
| `src/routes/macos-privacy.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/host-ops-host.js` | — |
| `src/routes/memory-browser.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/model-catalogs-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/opencode-models.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/chat/auto-provider-runtime.js` | — |
| `src/routes/opencode-quota.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/quota-host.js` | — |
| `src/routes/ops-terminal.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/doctor/host.js` | — |
| `src/routes/orchestration-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/orchestration.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/plugins-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/plugins.js` | — |
| `src/routes/plugins.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/provider-balance-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/provider-balance.js` | — |
| `src/routes/provider-balance.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/provider-models.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/model-catalogs-host.js` | — |
| `src/routes/provider-relay-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/providers-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/providers.js` | `native/runtime.js` |
| `src/routes/providers.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/routes/push-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/qoder-models.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/providers/native-vendor.js` | — |
| `src/routes/qoder-quota.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/quota-host.js` | — |
| `src/routes/quota-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/release-history-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/scan-history-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/secrets-vault-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/server-core-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/server-restart-route.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/session-admin-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/session-admin.js` | — |
| `src/routes/session-admin.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/session-bundle.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/routes/session-create.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/session-git-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/session-git.js` | — |
| `src/routes/session-git.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/routes/session-lifecycle.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/routes/session-memory.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/session-meta.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/session-profile.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/routes/session-routes-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/share-machines-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/share.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/share-machines-host.js` | — |
| `src/routes/skill-sync.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/host-ops-host.js` | — |
| `src/routes/subagent-defaults-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/providers.js` | `native/runtime.js` |
| `src/routes/system-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/system.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/release-history-host.js` | — |
| `src/routes/task-board.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | `native/runtime.js`, `native/task-domain.js` |
| `src/routes/task-goal.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/session-admin.js` | — |
| `src/routes/task-graph.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/task-planning.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/task-board.js` | `native/task-domain.js` |
| `src/routes/task-routes-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/task-search.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | `native/task-search.js` |
| `src/routes/task-state-store.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/token-usage-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/token-usage.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/turn-ledger-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/update-route.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/routes/voice-gateway-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/voice-runtime-host.js` | — |
| `src/routes/voice-gateway-proxy.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/voice/host.js` | — |
| `src/routes/voice-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/voice.js` | — |
| `src/routes/voice-runtime-host.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/voice/host.js` | — |
| `src/routes/voice.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/voice/host.js` | — |
| `src/routes/workspaces.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `src/routes/share-machines-host.js` | — |
| `src/routes/zcode-auth.js` | 后端 HTTP 处理与接线 | HTTP路由 | 模块导入 | `server.js` | — |
| `src/runtime-homes-janitor.js` | 后端业务或其宿主编排 | runtime-homes-janitor | 模块导入 | `server.js` | — |
| `src/runtime-security.js` | 后端业务或其宿主编排 | runtime-security | 模块导入 | `server.js` | — |
| `src/search/diversity.js` | 后端业务或其宿主编排 | 检索 | 模块导入 | `src/search/runtime.js` | `native/runtime.js` |
| `src/search/index-store.js` | 后端业务或其宿主编排 | 检索 | 模块导入 | `src/search/message-corpus.js` | `native/runtime.js` |
| `src/search/message-corpus.js` | 后端业务或其宿主编排 | 检索 | 模块导入 | `src/search/runtime.js` | — |
| `src/search/runtime.js` | 后端业务或其宿主编排 | 检索 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/search/slice-runner.js` | 后端业务或其宿主编排 | 检索 | 模块导入 | `src/search/runtime.js` | — |
| `src/secret-audit.js` | 后端业务或其宿主编排 | secret-audit | 模块导入 | `src/chat/auto-provider-routing.js` | `native/runtime.js` |
| `src/secret-tools.js` | 后端业务或其宿主编排 | secret-tools | 模块导入 | `server.js` | — |
| `src/secrets-vault.js` | 后端业务或其宿主编排 | secrets-vault | 模块导入 | `server.js` | — |
| `src/server-processes.js` | 宿主基础设施 | server-processes | 模块导入 | `src/workspace/writer-escalation.js` | — |
| `src/server-restart.js` | 宿主基础设施 | server-restart | 模块导入 | `src/routes/server-restart-route.js` | — |
| `src/session-dto.js` | 后端业务或其宿主编排 | session-dto | 模块导入 | `src/api-contract.js` | — |
| `src/session-work/host.js` | 后端业务或其宿主编排 | 会话作业 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/session-work/scheduler.js` | 后端业务或其宿主编排 | 会话作业 | 模块导入 | `src/orchestration/runtime.js` | `native/runtime.js` |
| `src/session/chat-history-service.js` | 后端业务或其宿主编排 | 会话 | 模块导入 | `src/routes/chat-history.js` | `native/runtime.js` |
| `src/session/handoff-env.js` | 后端业务或其宿主编排 | 会话 | 模块导入 | `src/routes/session-bundle.js` | — |
| `src/session/hibernation-composition.js` | 后端业务或其宿主编排 | 会话 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/session/hibernation.js` | 后端业务或其宿主编排 | 会话 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/session/query-service.js` | 后端业务或其宿主编排 | 会话 | 模块导入 | `src/routes/session-admin.js` | `native/runtime.js` |
| `src/session/records.js` | 后端业务或其宿主编排 | 会话 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/session/workspace-service.js` | 后端业务或其宿主编排 | 会话 | 模块导入 | `src/routes/session-admin.js` | `native/runtime.js` |
| `src/share.js` | 后端业务或其宿主编排 | share | 模块导入 | `server.js` | — |
| `src/shutdown.js` | 宿主基础设施 | shutdown | 模块导入 | `src/host-lifecycle.js` | — |
| `src/skill-converter.js` | 后端业务或其宿主编排 | skill-converter | 模块导入 | `server.js` | — |
| `src/skill-sync/index.js` | 后端业务或其宿主编排 | 技能 | 模块导入 | `server.js` | — |
| `src/skills.js` | 后端业务或其宿主编排 | skills | 模块导入 | `server.js` | — |
| `src/sqlite-runtime.js` | 宿主基础设施 | sqlite-runtime | 模块导入 | `src/providers/core.js` | — |
| `src/sqlite/driver.js` | 宿主基础设施 | 数据库 | 模块导入 | `src/cli/native-session-exists.js` | — |
| `src/state/container.js` | 宿主基础设施 | 状态存储 | 模块导入 | `server.js` | — |
| `src/state/owner.js` | 宿主基础设施 | 状态存储 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/state/store.js` | 宿主基础设施 | 状态存储 | 模块导入 | `server.js` | — |
| `src/tailscale-funnel-health.js` | 后端业务或其宿主编排 | tailscale-funnel-health | 模块导入 | `src/tunnel.js` | — |
| `src/task-board/board-store.js` | 后端业务或其宿主编排 | 任务板 | 模块导入 | `src/routes/task-board.js` | `native/runtime.js`, `native/task-domain.js` |
| `src/task-board/core.js` | 后端业务或其宿主编排 | 任务板 | 模块导入 | `src/classify/state-machine.js` | `native/runtime.js` |
| `src/task-board/lifecycle-host.js` | 后端业务或其宿主编排 | 任务板 | 模块导入 | `server.js` | — |
| `src/task-board/lifecycle.js` | 后端业务或其宿主编排 | 任务板 | 模块导入 | `src/routes/task-board.js` | `native/runtime.js` |
| `src/task-board/native-bridge.js` | 原生接口与兼容封装 | 任务板 | 模块导入 | `src/routes/task-board.js` | `native/task-domain.js` |
| `src/task-board/normalize.js` | 后端业务或其宿主编排 | 任务板 | 模块导入 | `src/task-board/core.js` | — |
| `src/task-board/planning.js` | 后端业务或其宿主编排 | 任务板 | 模块导入 | `src/routes/task-board.js` | `native/task-domain.js` |
| `src/task-board/relocate.js` | 后端业务或其宿主编排 | 任务板 | 模块导入 | `src/routes/task-board.js` | — |
| `src/task-board/repository.js` | 原生接口与兼容封装 | 任务板 | 模块导入 | `src/routes/task-board.js` | `native/runtime.js`, `native/task-domain.js` |
| `src/task-board/retention.js` | 后端业务或其宿主编排 | 任务板 | 模块导入 | `src/routes/task-board.js` | `native/runtime.js`, `native/task-domain.js` |
| `src/task-board/routing.js` | 后端业务或其宿主编排 | 任务板 | 模块导入 | `src/task-board/core.js` | `native/task-domain.js` |
| `src/task-board/search.js` | 后端业务或其宿主编排 | 任务板 | 模块导入 | `src/classify/task-attribution.js` | `native/runtime.js` |
| `src/task-board/view.js` | 后端业务或其宿主编排 | 任务板 | 模块导入 | `src/task-board/core.js` | `native/task-domain.js` |
| `src/task-context-host.js` | 后端业务或其宿主编排 | task-context-host | 模块导入 | `server.js` | `native/runtime.js` |
| `src/task-routing/attribution-mode.js` | 后端业务或其宿主编排 | 任务路由 | 模块导入 | `src/task-shell/attribution-decisions.js` | `native/runtime.js` |
| `src/task-routing/candidates.js` | 后端业务或其宿主编排 | 任务路由 | 模块导入 | `src/task-shell/host.js` | — |
| `src/task-routing/code-revision.js` | 后端业务或其宿主编排 | 任务路由 | 模块导入 | `src/task-routing/evidence.js` | `native/runtime.js` |
| `src/task-routing/delivery-view.js` | 后端业务或其宿主编排 | 任务路由 | 模块导入 | `src/workspace/air-routes-host.js` | — |
| `src/task-routing/evidence.js` | 后端业务或其宿主编排 | 任务路由 | 模块导入 | `src/workspace/admission.js` | — |
| `src/task-routing/facts.js` | 后端业务或其宿主编排 | 任务路由 | 模块导入 | `src/task-routing/evidence.js` | — |
| `src/task-shell/artifacts.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/host.js` | — |
| `src/task-shell/attribution-decisions.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/host.js` | `native/runtime.js` |
| `src/task-shell/attribution-settings.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/host.js` | — |
| `src/task-shell/chat-history.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/host.js` | — |
| `src/task-shell/context-access.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/runtime.js` | `native/runtime.js` |
| `src/task-shell/context-plan.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/runtime.js` | `native/runtime.js` |
| `src/task-shell/context-snapshot.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/context-plan.js` | `native/runtime.js` |
| `src/task-shell/history-context.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/context-access.js` | `native/runtime.js` |
| `src/task-shell/host.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `server.js` | `native/runtime.js`, `native/task-domain.js` |
| `src/task-shell/independent-continue.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/runtime.js` | `native/runtime.js` |
| `src/task-shell/migration-gate.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/task-shell/migration-page-worker.js` | 宿主脚本或其依赖 | 任务壳 | 含脚本路径 | `src/task-shell/migration-gate.js` | — |
| `src/task-shell/migration-progress.js` | 宿主脚本或其依赖 | 任务壳 | 含脚本路径 | `src/task-shell/migration-page-worker.js` | — |
| `src/task-shell/relations.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/runtime.js` | — |
| `src/task-shell/role-bindings.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/runtime.js` | `native/runtime.js` |
| `src/task-shell/runtime.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/host.js` | `native/runtime.js` |
| `src/task-shell/separation.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/runtime.js` | `native/runtime.js` |
| `src/task-shell/store.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/host.js` | `native/runtime.js` |
| `src/task-shell/task-actions.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/runtime.js` | `native/runtime.js` |
| `src/task-shell/task-first.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/runtime.js` | — |
| `src/task-shell/task-graph-context.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/task-shell/task-index.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/host.js` | `native/runtime.js` |
| `src/task-shell/task-operations.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `src/task-shell/host.js` | `native/runtime.js` |
| `src/task-shell/workspace.js` | 后端业务或其宿主编排 | 任务壳 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/task-worktree.js` | 后端业务或其宿主编排 | task-worktree | 模块导入 | `server.js` | — |
| `src/tmux.js` | 宿主基础设施 | tmux | 模块导入 | `server.js` | — |
| `src/triggers/index.js` | 后端业务或其宿主编排 | 触发器 | 模块导入 | `server.js` | — |
| `src/tunnel-sakurafrp-api.js` | 后端业务或其宿主编排 | tunnel-sakurafrp-api | 模块导入 | `src/tunnel.js` | — |
| `src/tunnel-sakurafrp.js` | 宿主基础设施 | tunnel-sakurafrp | 模块导入 | `src/tunnel.js` | — |
| `src/tunnel.js` | 宿主基础设施 | tunnel | 模块导入 | `server.js` | — |
| `src/turn-ledger/hook-install.js` | 后端业务或其宿主编排 | 回合台账 | 模块导入 | `src/turn-ledger/runtime.js` | — |
| `src/turn-ledger/ledger.js` | 后端业务或其宿主编排 | 回合台账 | 模块导入 | `src/turn-ledger/runtime.js` | `native/runtime.js` |
| `src/turn-ledger/runtime.js` | 后端业务或其宿主编排 | 回合台账 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/unattended/host.js` | 后端业务或其宿主编排 | 无人值守 | 模块导入 | `src/unattended/runtime.js` | — |
| `src/unattended/kernel.js` | 后端业务或其宿主编排 | 无人值守 | 模块导入 | `src/orchestration/runtime.js` | `native/runtime.js` |
| `src/unattended/routes.js` | 后端 HTTP 处理与接线 | 无人值守 | 模块导入 | `src/routes/session-admin.js` | — |
| `src/unattended/runtime.js` | 后端业务或其宿主编排 | 无人值守 | 模块导入 | `server.js` | — |
| `src/update-runner.js` | 后端业务或其宿主编排 | update-runner | 模块导入 | `src/routes/update-route.js` | — |
| `src/upload-middleware.js` | 宿主基础设施 | upload-middleware | 模块导入 | `server.js` | — |
| `src/upstream-error.js` | 后端业务或其宿主编排 | upstream-error | 模块导入 | `src/chat/api-error-policy.js` | — |
| `src/usage-limit-poller.js` | 后端业务或其宿主编排 | usage-limit-poller | 模块导入 | `server.js` | `native/runtime.js` |
| `src/usage-observed.js` | 后端业务或其宿主编排 | usage-observed | 模块导入 | `src/providers/router-port.js` | `native/runtime.js` |
| `src/voice/acp-bridge.js` | 宿主脚本或其依赖 | 语音 | 含脚本路径 | `src/voice/multicc-acp-agent.mjs` | — |
| `src/voice/asr-local.js` | 后端业务或其宿主编排 | 语音 | 模块导入 | `plugins/voice/voice-asr.js` | — |
| `src/voice/asr-model-installer.js` | 后端业务或其宿主编排 | 语音 | 模块导入 | `src/voice/host.js` | — |
| `src/voice/config.js` | 后端业务或其宿主编排 | 语音 | 模块导入 | `src/voice/asr-local.js` | — |
| `src/voice/gateway.js` | 后端业务或其宿主编排 | 语音 | 模块导入 | `src/routes/voice-gateway-host.js` | — |
| `src/voice/host.js` | 后端业务或其宿主编排 | 语音 | 模块导入 | `server.js` | — |
| `src/voice/hotword-corrector.js` | 后端业务或其宿主编排 | 语音 | 模块导入 | `src/voice/asr-local.js` | — |
| `src/voice/hotword-learner.js` | 后端业务或其宿主编排 | 语音 | 模块导入 | `src/voice/config.js` | — |
| `src/voice/hotword-miner.js` | 后端业务或其宿主编排 | 语音 | 模块导入 | `src/voice/hotword-learner.js` | — |
| `src/voice/launch.js` | 后端业务或其宿主编排 | 语音 | 模块导入 | `src/voice/host.js` | — |
| `src/voice/multicc-acp-agent.mjs` | 宿主脚本或其依赖 | 语音 | 含脚本路径 | `src/routes/voice-gateway-host.js` | — |
| `src/voice/qwen-audio-installer.js` | 后端业务或其宿主编排 | 语音 | 模块导入 | `src/voice/host.js` | — |
| `src/voice/qwen-audio-supervisor.js` | 后端业务或其宿主编排 | 语音 | 模块导入 | `src/voice/host.js` | — |
| `src/voice/readiness.js` | 后端业务或其宿主编排 | 语音 | 模块导入 | `src/routes/voice.js` | — |
| `src/voice/router.js` | 后端业务或其宿主编排 | 语音 | 模块导入 | `src/routes/task-board.js` | — |
| `src/voice/speech.js` | 后端业务或其宿主编排 | 语音 | 模块导入 | `src/dispatch/gateway-host.js` | — |
| `src/voice/tts-service.js` | 后端业务或其宿主编排 | 语音 | 模块导入 | `server.js` | — |
| `src/wait/injector.js` | 后端业务或其宿主编排 | 等待 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/wait/service.js` | 后端业务或其宿主编排 | 等待 | 模块导入 | `src/orchestration/runtime.js` | `native/runtime.js` |
| `src/windows-env.js` | 宿主基础设施 | windows-env | 模块导入 | `server.js` | `native/runtime.js` |
| `src/workspace/admission.js` | 后端业务或其宿主编排 | 工作区 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/workspace/air-card-cache.js` | 后端业务或其宿主编排 | 工作区 | 模块导入 | `src/workspace/air-routes-host.js` | `native/runtime.js`, `native/task-domain.js` |
| `src/workspace/air-index-port.js` | 后端业务或其宿主编排 | 工作区 | 模块导入 | `src/workspace/air-sync-runtime.js` | `native/runtime.js`, `native/task-read-model.js` |
| `src/workspace/air-routes-host.js` | 后端业务或其宿主编排 | 工作区 | 模块导入 | `src/workspace/air-routes.js` | `native/task-domain.js` |
| `src/workspace/air-routes.js` | 后端 HTTP 处理与接线 | 工作区 | 模块导入 | `server.js` | — |
| `src/workspace/air-storage-notice.js` | 后端业务或其宿主编排 | 工作区 | 模块导入 | `server.js` | — |
| `src/workspace/air-sync-issue.js` | 后端业务或其宿主编排 | 工作区 | 模块导入 | `src/workspace/air-storage-notice.js` | `native/runtime.js` |
| `src/workspace/air-sync-runtime.js` | 后端业务或其宿主编排 | 工作区 | 模块导入 | `src/workspace/air-routes-host.js` | — |
| `src/workspace/inventory.js` | 离线工具 | 工作区 | 独立脚本 | `scripts/task-workspace-inventory.js` | — |
| `src/workspace/orphan-scan.js` | 后端业务或其宿主编排 | 工作区 | 模块导入 | `server.js` | — |
| `src/workspace/pins.js` | 后端业务或其宿主编排 | 工作区 | 模块导入 | `server.js` | — |
| `src/workspace/registry.js` | 后端业务或其宿主编排 | 工作区 | 模块导入 | `src/workspace/admission.js` | — |
| `src/workspace/runtime.js` | 后端业务或其宿主编排 | 工作区 | 模块导入 | `server.js` | `native/runtime.js` |
| `src/workspace/separation-transfer.js` | 后端业务或其宿主编排 | 工作区 | 模块导入 | `src/task-shell/host.js` | — |
| `src/workspace/todo-ignores.js` | 后端业务或其宿主编排 | 工作区 | 模块导入 | `src/workspace/air-routes-host.js` | — |
| `src/workspace/todos.js` | 后端业务或其宿主编排 | 工作区 | 模块导入 | `src/workspace/air-routes-host.js` | — |
| `src/workspace/writer-escalation.js` | 后端业务或其宿主编排 | 工作区 | 模块导入 | `src/workspace/admission.js` | — |
| `src/workspace/writer-group.js` | 后端业务或其宿主编排 | 工作区 | 模块导入 | `src/chat/chat-stream.js` | — |
| `src/ws/connection-router.js` | 宿主基础设施 | WebSocket | 模块导入 | `server.js` | `native/runtime.js` |
| `src/ws/gateway-chat-bridge.js` | 宿主基础设施 | WebSocket | 模块导入 | `src/gateway-child.js` | — |
| `src/ws/native-queue.js` | 宿主基础设施 | WebSocket | 模块导入 | `src/ws/connection-router.js` | — |
| `src/ws/ws-host.js` | 宿主基础设施 | WebSocket | 模块导入 | `src/chat/sessions.js` | `native/runtime.js` |
