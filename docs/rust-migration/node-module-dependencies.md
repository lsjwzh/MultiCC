# Node 后端模块与运行依赖

默认生产服务使用 Cargo 构建的网关。部署目录中的后端 JavaScript 和 Node 运行依赖计数见[生产清单](remaining-node-checklist.md)。下表统计显式兼容宿主及其工具。

运行 `node --expose-internals scripts/inventory-node-backend.js docs/rust-migration/node-module-dependencies.md` 重建。
统计工作树中 Git 跟踪和未忽略的新文件。下表逐项列出 src 中的模块，含薄桥和离线工具。入口栏标示从 server.js 递归追踪字面量 import、require、require.resolve 及其 createRequire 别名的结果。脚本路径列另列 path.join/resolve(__dirname, 字面量) 指向的文件，包含 worker 与子进程。条件分支按可能加载计；运行时注入依赖仍需结合具体部署核验。动态表达式附行号。

当前 src 中有 413 个 .js、2 个 .cjs、3 个 .mjs。根包有 0 个直接运行依赖。

## 根包运行依赖

兼容宿主打包路径与根 npm 包独立。下表只统计根包 dependencies。开发依赖与桌面包中的宿主仍应分别审计。

兼容宿主的 Claude 引擎由 `@anthropic-ai/claude-agent-sdk` 的平台可选包提供二进制，解析入口为 `native/core/src/claude_models.rs`。CPR 的传递依赖（包括 `@iarna/toml`）保留在 package-lock.json 中。

| 包 | 声明版本 | 直接引用（server.js、src、启动入口、生产插件） |
|---|---|---|

## src 模块

| 文件 | 入口 | 本地直接依赖 | 本地脚本路径 | Node 内置模块 | 外部包 | 动态或未解析 |
|---|---|---|---|---|---|---|
| `src/agy-accounts.js` | server.js | `src/native/binding.js` | — | `path` | — | — |
| `src/annotation-live.js` | server.js | `src/paths/index.js` | — | `fs`, `os`, `path` | — | — |
| `src/apk-distribution.js` | server.js | — | — | — | — | — |
| `src/artifact-retention.js` | server.js | `src/native/binding.js` | — | `fs`, `path` | — | — |
| `src/artifacts.js` | server.js | `src/native/binding.js`, `src/paths/index.js` | — | `fs`, `os`, `path` | — | — |
| `src/auth-security.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/aux-http.js` | server.js | — | — | `http`, `https` | — | — |
| `src/battery-guard.js` | server.js | — | — | — | — | — |
| `src/bus.js` | server.js | — | — | `events` | — | — |
| `src/cdp-relay.js` | server.js | `src/cdpd.js` | — | `events`, `net` | `ws` | — |
| `src/cdpd.js` | server.js | — | — | `child_process`, `fs`, `net`, `os`, `path` | — | — |
| `src/chat/admission-progress.js` | server.js | `src/chat/api-error-policy.js` | — | — | — | — |
| `src/chat/api-error-host.js` | server.js | `src/chat/api-error-policy.js`, `src/claude-auth/oauth-refresh.js`, `src/native/binding.js`, `src/network/global-proxy.js` | — | — | — | — |
| `src/chat/api-error-policy.js` | server.js | `src/native/binding.js`, `src/provider-error.js`, `src/upstream-error.js` | — | — | — | — |
| `src/chat/auto-provider-routing.js` | server.js | `src/native/binding.js`, `src/providers/auto-provider-config.js`, `src/providers/jev-client.js`, `src/secret-audit.js`, `src/secrets-vault.js` | — | — | — | — |
| `src/chat/auto-provider-runtime.js` | server.js | `src/chat/admission-progress.js`, `src/chat/auto-provider-routing.js`, `src/native/binding.js`, `src/pricing/price-table.js`, `src/providers/auto-provider-config.js`, `src/providers/native-vendor.js`, `src/quota/provider-limit-cache-native-host.js`, `src/routes/opencode-models.js` | — | — | — | — |
| `src/chat/auto-route-notes.js` | server.js | `src/providers/auto-provider-config.js` | — | — | — | — |
| `src/chat/background-hold.js` | server.js | `src/cli-adapters/result-completion.js`, `src/native/binding.js` | — | — | — | — |
| `src/chat/background-task-runtime.js` | server.js | `src/native/binding.js`, `src/observability.js`, `src/paths/index.js` | — | — | — | — |
| `src/chat/chat-stream.js` | server.js | `src/chat/background-hold.js`, `src/chat/claude-sdk-stream.js`, `src/chat/codex-app-stream.js`, `src/chat/missing-resume-recovery.js`, `src/chat/stream-router.js`, `src/cli-adapters/result-completion.js`, `src/native/binding.js`, `src/secrets-vault.js` | — | `child_process`, `crypto` | — | — |
| `src/chat/claude-sdk-config.js` | server.js | `src/chat/claude-sdk-route.js` | — | `crypto`, `fs`, `os`, `path` | — | — |
| `src/chat/claude-sdk-route.js` | server.js | — | — | `crypto`, `http` | — | — |
| `src/chat/claude-sdk-stream.js` | server.js | `src/chat/background-hold.js`, `src/chat/claude-sdk-config.js`, `src/chat/claude-sdk-route.js`, `src/chat/missing-resume-recovery.js`, `src/cli-adapters/result-completion.js`, `src/cli/cli-capability.js`, `src/native/binding.js`, `src/secrets-vault.js` | — | `crypto` | — | — |
| `src/chat/codex-app-stream.js` | server.js | `src/codex/resident-route.js`, `src/native/binding.js`, `src/secrets-vault.js` | — | `child_process`, `crypto`, `fs`, `path` | — | — |
| `src/chat/codex-rollout-guard.js` | server.js | `src/native/binding.js` | — | `os` | — | — |
| `src/chat/error-persistence.js` | server.js | — | — | `crypto` | — | — |
| `src/chat/finalize-host.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/chat/held-turn-injection.js` | server.js | `src/chat/background-hold.js` | — | — | — | — |
| `src/chat/host-coordinator.js` | server.js | `src/chat/turn-lifecycle.js`, `src/native/binding.js` | — | `crypto` | — | — |
| `src/chat/host-runtime.js` | server.js | `src/chat/host-coordinator.js`, `src/cli/cli-capability.js`, `src/native/binding.js`, `src/observability.js` | — | — | — | — |
| `src/chat/index.js` | server.js | `src/chat/api-error-host.js`, `src/chat/api-error-policy.js`, `src/chat/finalize-host.js`, `src/chat/host-coordinator.js`, `src/chat/host-runtime.js`, `src/chat/provider-attempt-runtime.js`, `src/chat/turn-lifecycle.js`, `src/chat/turn-request.js`, `src/native/binding.js`, `src/state/owner.js` | — | — | — | — |
| `src/chat/missing-resume-recovery.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/chat/native-session-guard.js` | server.js | `src/native/binding.js` | — | `os` | — | — |
| `src/chat/opencode-context.js` | server.js | `src/cli-switch.js`, `src/native/binding.js` | — | `crypto`, `os`, `path` | — | — |
| `src/chat/process-watchdog.js` | server.js | `src/classify/vocab.js` | — | — | — | — |
| `src/chat/provider-attempt-runtime.js` | server.js | `src/native/binding.js`, `src/observability.js` | — | — | — | — |
| `src/chat/provider-log-watchdog.js` | server.js | `src/chat/api-error-policy.js`, `src/native/binding.js` | — | `fs`, `os`, `path` | — | — |
| `src/chat/proxy-broadcast.js` | server.js | `src/native/binding.js`, `src/observability.js`, `src/quota/claude-bar-state.js` | — | — | — | — |
| `src/chat/resident-pool.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/chat/sessions.js` | server.js | `src/ws/ws-host.js` | — | — | — | — |
| `src/chat/stalled-turn-recovery.js` | server.js | `src/classify/vocab.js` | — | — | — | — |
| `src/chat/stream-router.js` | server.js | `src/chat/workspace-residency.js` | — | — | — | — |
| `src/chat/turn-engine-host.js` | server.js | `src/chat/admission-progress.js`, `src/chat/auto-provider-runtime.js`, `src/chat/auto-route-notes.js`, `src/chat/chat-stream.js`, `src/chat/codex-rollout-guard.js`, `src/chat/held-turn-injection.js`, `src/chat/host-coordinator.js`, `src/chat/index.js`, `src/chat/native-session-guard.js`, `src/chat/opencode-context.js`, `src/chat/provider-attempt-runtime.js`, `src/cli-adapters/completion.js`, `src/cli-switch.js`, `src/cli/cli-capability.js`, `src/cli/session-policy.js`, `src/cli/switch-runtime.js`, `src/codex/usage.js`, `src/native/binding.js`, `src/native/task-domain.js`, `src/observability.js`, `src/providers/auto-provider-config.js`, `src/providers/egress-ip-policy.js`, `src/providers/host.js`, `src/routes/chat-history/index.js`, `src/secrets-vault.js`, `src/wait/injector.js` | — | `child_process`, `crypto` | — | — |
| `src/chat/turn-event-journal.js` | server.js | — | — | `fs`, `path` | — | — |
| `src/chat/turn-lifecycle.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/chat/turn-request.js` | server.js | `src/cli/cli-capability.js`, `src/native/binding.js`, `src/providers/binding.js` | — | — | — | — |
| `src/chat/usage-limit-wiring.js` | server.js | `src/native/binding.js`, `src/quota/claude-bar-state.js`, `src/quota/claude-usage-queue.js` | — | — | — | — |
| `src/chat/workspace-residency.js` | server.js | — | — | `fs`, `path` | — | — |
| `src/chrome-cdp.js` | server.js | `src/cdp-relay.js` | — | `fs`, `http`, `os`, `path` | `ws` | — |
| `src/classify/aux-run-log.js` | server.js | — | — | `fs`, `path` | — | — |
| `src/classify/history-backtest.js` | 归属离线回测 | `src/classify/task-attribution.js` | — | — | — | — |
| `src/classify/task-attribution.js` | server.js | `src/memory/task-distill.js`, `src/native/binding.js`, `src/native/task-domain.js`, `src/task-board/search.js` | — | `crypto` | — | — |
| `src/classify/vocab.js` | server.js | `src/chat/api-error-policy.js`, `src/native/binding.js` | — | — | — | — |
| `src/claude-auth/account-credentials.js` | server.js | `src/native/binding.js`, `src/quota/claude-cli-oauth.js` | — | — | — | — |
| `src/claude-auth/accounts-refresh.js` | server.js | `src/claude-auth/oauth-refresh.js`, `src/native/binding.js`, `src/official-accounts.js`, `src/quota/claude-cli-oauth.js`, `src/runtime-security.js` | — | `child_process`, `crypto`, `fs`, `os`, `path` | — | — |
| `src/claude-auth/egress-agent.js` | server.js | `src/routes/plugins.js` | — | `path` | `proxy-agent` | — |
| `src/claude-auth/oauth-refresh.js` | server.js | `src/native/binding.js`, `src/providers/host.js` | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/claude-auth/official-oauth.js` | server.js | `src/native/binding.js` | — | `crypto`, `http` | — | — |
| `src/claude-auth/proxy-recovery.js` | server.js | — | — | `async_hooks`, `stream` | — | — |
| `src/claude-auth/refresh-health.js` | server.js | `src/runtime-security.js` | — | `fs`, `path` | — | — |
| `src/claude-models.js` | server.js | `src/paths/index.js` | — | `fs`, `path` | — | — |
| `src/cli-adapters/acp.js` | server.js | `src/cli-adapters/completion.js`, `src/cli/cli-capability.js`, `src/native/binding.js`, `src/provider-error.js` | — | — | — | — |
| `src/cli-adapters/claude-agent-sdk-bridge.mjs` | 宿主脚本路径 | `src/cli-adapters/result-completion.js`, `src/cli/cli-capability.js`, `src/native/binding.js` | — | `fs`, `module`, `os`, `path`, `url` | — | — |
| `src/cli-adapters/codebuddy.js` | server.js | `src/cli-adapters/result-completion.js`, `src/cli-adapters/router-mcp.js`, `src/cli/cli-capability.js`, `src/native/binding.js` | — | — | — | — |
| `src/cli-adapters/command-code.js` | server.js | `src/cli-adapters/completion.js`, `src/cli/cli-capability.js`, `src/native/binding.js` | — | — | — | — |
| `src/cli-adapters/commands.js` | server.js | `src/agy-accounts.js`, `src/native/binding.js`, `src/providers/host.js`, `src/windows-env.js` | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/cli-adapters/completion.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/cli-adapters/dsh.js` | server.js | `src/cli-adapters/completion.js`, `src/native/binding.js` | — | `fs`, `os`, `path` | — | — |
| `src/cli-adapters/index.js` | server.js | `src/cli-adapters/acp.js`, `src/cli-adapters/codebuddy.js`, `src/cli-adapters/command-code.js`, `src/cli-adapters/commands.js`, `src/cli-adapters/completion.js`, `src/cli-adapters/dsh.js`, `src/cli-adapters/kimi.js`, `src/cli-adapters/opencode.js`, `src/cli-adapters/pi.js`, `src/cli-adapters/qoder.js`, `src/cli-adapters/zcode.js`, `src/cli/cli-capability.js`, `src/native/binding.js` | `scripts/multicc-router-mcp.js` | `path` | — | — |
| `src/cli-adapters/kimi-auth.js` | server.js | `src/cli-adapters/commands.js` | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/cli-adapters/kimi.js` | server.js | `src/cli-adapters/completion.js`, `src/cli-adapters/router-mcp.js`, `src/cli/cli-capability.js`, `src/native/binding.js` | — | — | — | — |
| `src/cli-adapters/opencode-like.js` | server.js | `src/cli-adapters/completion.js`, `src/cli/cli-capability.js`, `src/native/binding.js`, `src/provider-error.js` | — | — | — | — |
| `src/cli-adapters/opencode.js` | server.js | `src/cli-adapters/acp.js`, `src/cli-adapters/opencode-like.js`, `src/cli/cli-capability.js`, `src/native/binding.js`, `src/provider-error.js`, `src/routes/opencode-models.js` | — | — | — | — |
| `src/cli-adapters/pi-router-extension.mjs` | 宿主脚本路径 | — | — | `child_process`, `readline`, `url` | — | — |
| `src/cli-adapters/pi.js` | server.js | `src/cli-adapters/completion.js`, `src/cli/cli-capability.js`, `src/native/binding.js`, `src/upstream-error.js` | `src/cli-adapters/pi-router-extension.mjs` | `path` | — | — |
| `src/cli-adapters/qoder.js` | server.js | `src/cli-adapters/result-completion.js`, `src/cli-adapters/router-mcp.js`, `src/cli/cli-capability.js`, `src/native/binding.js` | — | — | — | — |
| `src/cli-adapters/result-completion.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/cli-adapters/router-mcp.js` | server.js | `src/native/binding.js` | — | `fs`, `os`, `path` | — | — |
| `src/cli-adapters/zcode-app-server.js` | 宿主脚本路径 | — | — | — | — | — |
| `src/cli-adapters/zcode-auth.js` | server.js | `src/native/binding.js`, `src/runtime-security.js` | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/cli-adapters/zcode-bridge.cjs` | 宿主脚本路径 | `src/chat/background-hold.js`, `src/cli-adapters/zcode-app-server.js`, `src/native/binding.js` | — | `child_process`, `fs`, `os`, `path`, `readline` | — | — |
| `src/cli-adapters/zcode-terminal.cjs` | 宿主脚本路径 | `src/native/binding.js` | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/cli-adapters/zcode.js` | server.js | `src/cli-adapters/completion.js`, `src/cli/cli-capability.js`, `src/native/binding.js` | `src/cli-adapters/zcode-bridge.cjs`, `src/cli-adapters/zcode-terminal.cjs` | `path` | — | — |
| `src/cli-key-accounts.js` | server.js | `src/agy-accounts.js`, `src/cli/cli-capability.js`, `src/official-accounts.js`, `src/runtime-security.js` | — | `crypto`, `fs`, `path` | — | — |
| `src/cli-switch.js` | server.js | `src/cli/cli-capability.js`, `src/native/binding.js`, `src/providers/native-vendor.js` | — | — | — | — |
| `src/cli/cli-capability.js` | server.js | `src/native/binding.js` | — | `fs`, `path` | — | — |
| `src/cli/cli-upstream-version.js` | server.js | `src/cli/cli-capability.js`, `src/native/binding.js` | — | `os`, `path`, `tls` | — | — |
| `src/cli/native-session-exists.js` | server.js | `src/sqlite/driver.js` | — | `fs`, `os`, `path` | — | — |
| `src/cli/session-policy.js` | server.js | `src/claude-models.js`, `src/cli/cli-capability.js`, `src/native/binding.js` | — | `fs`, `os`, `path` | — | — |
| `src/cli/switch-runtime.js` | server.js | `src/cli/cli-capability.js`, `src/cli/native-session-exists.js`, `src/cli/tools-host.js`, `src/native/binding.js`, `src/providers/auto-provider-config.js`, `src/providers/native-vendor.js`, `src/routes/cli-switch-host.js` | — | `crypto` | — | — |
| `src/cli/tools-host.js` | server.js | `package.json`, `src/cli-adapters/commands.js`, `src/cli/cli-capability.js`, `src/cli/cli-upstream-version.js`, `src/native/binding.js`, `src/network/outbound.js`, `src/windows-env.js` | — | `child_process`, `crypto`, `fs`, `os`, `path` | — | — |
| `src/codex-auth/official-oauth.js` | server.js | — | — | `crypto`, `http` | — | — |
| `src/codex/accounts-refresh.js` | server.js | `src/codex/oauth-refresh.js` | — | — | — | — |
| `src/codex/attempt-home.js` | server.js | `src/runtime-security.js`, `src/state/store.js` | — | `crypto`, `fs`, `path` | — | — |
| `src/codex/image-bridge-runtime.js` | server.js | `src/codex/image-bridge.js`, `src/official-accounts.js` | — | `os`, `path` | — | — |
| `src/codex/image-bridge.js` | server.js | `src/codex/official-relay.js`, `src/runtime-security.js` | — | `child_process`, `crypto`, `fs`, `os`, `path` | — | — |
| `src/codex/model-catalog.js` | server.js | `src/claude-auth/egress-agent.js`, `src/cli-adapters/commands.js`, `src/codex/oauth-refresh.js`, `src/codex/official-relay.js`, `src/native/binding.js`, `src/network/outbound.js`, `src/official-accounts.js`, `src/providers/host.js` | — | `os`, `path` | — | — |
| `src/codex/oauth-refresh.js` | server.js | `src/providers/host.js` | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/codex/official-relay.js` | server.js | `src/codex/proxy-trace.js`, `src/model-history-converter.js`, `src/native/binding.js`, `src/network/outbound.js`, `src/official-accounts.js`, `src/upstream-error.js` | — | `crypto`, `os`, `path` | — | — |
| `src/codex/proxy-trace.js` | server.js | — | — | — | — | — |
| `src/codex/resident-route.js` | server.js | `src/cli/cli-capability.js`, `src/native/binding.js`, `src/providers/host.js` | — | `fs` | — | — |
| `src/codex/session-home.js` | server.js | `src/runtime-security.js` | — | `crypto`, `fs`, `os`, `path` | — | — |
| `src/codex/usage.js` | server.js | `src/native/binding.js` | — | `crypto` | — | — |
| `src/commander-migration.js` | server.js | — | — | — | — | — |
| `src/detached.js` | server.js | `src/paths/index.js` | — | `child_process`, `crypto`, `fs`, `os`, `path` | — | — |
| `src/directories.js` | server.js | `src/git/service/index.js`, `src/native/binding.js`, `src/state/container.js` | — | `fs`, `path` | — | — |
| `src/directory/records.js` | server.js | `src/state/store.js` | — | — | — | — |
| `src/dispatch/gateway-host.js` | server.js | `src/bus.js`, `src/cli/cli-capability.js`, `src/dispatch/targeting.js`, `src/native/binding.js` | — | — | — | — |
| `src/dispatch/progress.js` | server.js | — | — | — | — | — |
| `src/dispatch/targeting.js` | server.js | `src/cli/cli-capability.js`, `src/native/binding.js`, `src/native/task-domain.js` | — | — | — | — |
| `src/docs-registry.js` | server.js | `src/artifact-retention.js`, `src/artifacts.js`, `src/native/binding.js`, `src/paths/index.js`, `src/runtime-security.js` | — | `child_process`, `fs`, `net`, `path` | — | — |
| `src/doctor/environment.js` | server.js | `src/doctor/llm-loop.js`, `src/doctor/tools.js` | — | `child_process`, `crypto`, `fs`, `os`, `path` | — | — |
| `src/doctor/llm-loop.js` | server.js | `src/aux-http.js` | — | `http`, `https` | — | — |
| `src/doctor/service.js` | server.js | `package.json`, `src/doctor/environment.js`, `src/doctor/llm-loop.js`, `src/doctor/tools.js`, `src/native/binding.js`, `src/routes/ops-terminal.js` | — | `crypto`, `os`, `path` | — | — |
| `src/doctor/tools.js` | server.js | — | — | `child_process`, `fs`, `path` | — | — |
| `src/events/actions.js` | server.js | `src/native/binding.js`, `src/plugins/channel-registry.js` | — | `crypto`, `net` | — | — |
| `src/events/engine.js` | server.js | `src/events/actions.js`, `src/native/binding.js`, `src/plugins/channel-registry.js` | — | `crypto` | — | — |
| `src/events/host.js` | server.js | `src/events/engine.js`, `src/events/hub.js`, `src/runtime-security.js` | — | `dns`, `fs`, `http`, `https`, `os` | — | — |
| `src/events/hub.js` | server.js | `src/classify/vocab.js`, `src/native/binding.js` | — | `crypto` | — | — |
| `src/experiments/tui-chat-mirror-runtime.js` | server.js | `src/tmux.js` | — | `crypto`, `fs`, `os`, `path` | — | — |
| `src/fleet-sharing.js` | server.js | `src/gateway-child.js`, `src/native/binding.js` | — | — | — | — |
| `src/gateway-child.js` | server.js | `src/ws/gateway-chat-bridge.js` | — | `net`, `path` | — | `43 require(path.join(sourceRoot, 'scripts', 'ensure-source-rust'))` |
| `src/git/queue.js` | server.js | `src/repo-actor/index.js` | — | — | — | — |
| `src/git/service/index.js` | server.js | `src/native/binding.js`, `src/repo-actor/index.js` | — | `async_hooks` | — | — |
| `src/host-battery.js` | server.js | — | — | `child_process`, `fs/promises` | — | — |
| `src/host-env.js` | server.js | `src/runtime-security.js` | — | `fs`, `path` | — | — |
| `src/host-lifecycle.js` | server.js | `src/shutdown.js` | — | — | — | — |
| `src/http-errors.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/http/error-presenter.js` | 未从已知入口静态到达 | `src/http-errors.js`, `src/native/binding.js` | — | — | — | — |
| `src/http/json-compression.js` | server.js | — | — | `zlib` | — | — |
| `src/ios-ota.js` | server.js | — | — | — | — | — |
| `src/ios-udid.js` | server.js | `src/ios-ota.js` | — | `child_process`, `crypto` | `express` | — |
| `src/lan-discovery.js` | server.js | `src/native/binding.js` | — | `net`, `os` | `@homebridge/ciao` | — |
| `src/liveness/process-probe.js` | server.js | — | — | — | — | — |
| `src/liveness/rollout-path.js` | server.js | — | — | — | — | — |
| `src/liveness/runtime.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/log-housekeeping.js` | server.js | — | — | `fs`, `path` | — | — |
| `src/machines.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/macos-agent-build.js` | server.js | — | — | `crypto`, `fs`, `path` | — | — |
| `src/macos-agent-provision.js` | server.js | `src/macos-agent-build.js` | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/macos-unlock-password.js` | server.js | — | — | `child_process`, `os` | — | — |
| `src/macos-unlock-probe.js` | server.js | — | — | `child_process`, `os`, `path` | — | — |
| `src/memo/index.js` | server.js | `src/http-errors.js`, `src/memo/migrate.js`, `src/native/binding.js` | — | `fs`, `path` | — | — |
| `src/memo/migrate.js` | server.js | `src/native/binding.js` | — | `child_process`, `path` | — | — |
| `src/memory-store.js` | server.js | — | — | `crypto`, `fs`, `path` | — | — |
| `src/memory/builtin-rules.js` | server.js | `src/memory-store.js` | — | `fs`, `path` | — | — |
| `src/memory/folder-service.js` | server.js | `src/memory/builtin-rules.js`, `src/memory/retrieval.js` | — | — | — | — |
| `src/memory/retrieval.js` | server.js | `src/memory-store.js`, `src/memory/builtin-rules.js`, `src/native/binding.js` | — | `fs`, `path` | — | — |
| `src/memory/runtime.js` | server.js | — | — | — | — | — |
| `src/memory/task-distill.js` | server.js | — | — | `fs`, `path` | — | — |
| `src/model-history-converter.js` | server.js | — | — | `crypto` | — | — |
| `src/native/binding.js` | server.js | `src/chat/api-error-policy.js`, `src/chat/provider-attempt-runtime.js`, `src/chat/turn-request.js`, `src/cli/cli-capability.js`, `src/native/task-domain.js`, `src/network/outbound.js`, `src/providers/auto-provider-config.js`, `src/providers/binding.js`, `src/quota/provider-limit-cache-native-host.js`, `src/session/records.js`, `src/upstream-error.js` | `src/cli-adapters/claude-agent-sdk-bridge.mjs` | `crypto`, `fs`, `os`, `path` | — | `197 require(file)` |
| `src/native/task-domain.js` | server.js | `src/native/binding.js`, `src/paths/index.js`, `src/state/store.js` | — | `fs` | — | — |
| `src/native/task-read-model.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/native/task-search.js` | server.js | `src/native/binding.js`, `src/task-board/search.js` | — | — | — | — |
| `src/network/egress-fetch.js` | server.js | `src/claude-auth/egress-agent.js` | — | `http`, `https` | `proxy-agent` | — |
| `src/network/global-proxy.js` | server.js | `src/network/outbound.js`, `src/network/proxy-policy.js` | — | `http`, `https` | — | — |
| `src/network/outbound.js` | server.js | `src/network/proxy-policy.js` | — | — | `proxy-agent`, `undici` | — |
| `src/network/proxy-policy.js` | server.js | — | — | `child_process`, `util` | — | — |
| `src/network/sdk-bridges.js` | server.js | `src/network/outbound.js` | — | `fs`, `module`, `path` | `@discordjs/ws`, `discord.js`, `ws` | `50 localRequire(id)` |
| `src/notes-store.js` | server.js | — | — | `fs`, `path` | — | — |
| `src/observability.js` | server.js | `src/native/binding.js` | — | `perf_hooks` | — | — |
| `src/official-accounts-cli-login.js` | server.js | `src/claude-auth/official-oauth.js`, `src/network/outbound.js`, `src/quota/claude-cli-oauth.js` | — | `crypto`, `fs`, `os`, `path` | — | — |
| `src/official-accounts.js` | server.js | `src/native/binding.js`, `src/runtime-security.js` | — | `crypto`, `fs`, `os`, `path` | — | — |
| `src/operation-service.js` | server.js | `src/native/binding.js`, `src/outbox.js` | — | `crypto` | — | — |
| `src/orchestration/draft-host.js` | server.js | `src/orchestration/json-store-host.js` | — | `util` | — | — |
| `src/orchestration/host.js` | server.js | `src/native/binding.js`, `src/operation-service.js`, `src/orchestration/json-store-host.js`, `src/orchestration/sqlite-store.js`, `src/outbox.js`, `src/wait/service.js` | — | `async_hooks`, `crypto` | — | — |
| `src/orchestration/json-store-host.js` | server.js | `src/native/binding.js` | — | `fs`, `path` | — | — |
| `src/orchestration/native-store-host.js` | server.js | `src/native/binding.js`, `src/outbox.js` | — | `async_hooks`, `buffer`, `crypto`, `path`, `util` | — | — |
| `src/orchestration/sqlite-store.js` | server.js | `src/orchestration/draft-host.js`, `src/orchestration/json-store-host.js`, `src/orchestration/native-store-host.js` | — | — | — | — |
| `src/outbox.js` | server.js | `src/native/binding.js` | — | `crypto` | — | — |
| `src/paths/index.js` | server.js | `src/native/binding.js` | — | `fs`, `os`, `path` | — | — |
| `src/plugins/catalog.js` | server.js | `package.json`, `src/macos-agent-provision.js` | — | `child_process`, `crypto`, `fs`, `os`, `path` | — | — |
| `src/plugins/channel-host.js` | server.js | — | — | `child_process`, `fs`, `path` | — | — |
| `src/plugins/channel-registry.js` | server.js | `src/classify/vocab.js` | — | — | — | — |
| `src/plugins/installer.js` | server.js | `src/native/binding.js` | — | `crypto`, `fs`, `path` | — | — |
| `src/portable-git.js` | server.js | — | — | `fs`, `os`, `path` | — | — |
| `src/powerd.js` | server.js | — | — | `fs`, `path` | — | — |
| `src/pricing/price-table.js` | server.js | — | — | `fs`, `os`, `path` | — | — |
| `src/provider-error.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/provider-reassign.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/providers/auto-provider-config.js` | server.js | `src/native/binding.js`, `src/providers/jev-client.js`, `src/providers/native-vendor.js` | — | — | — | — |
| `src/providers/binding.js` | server.js | — | — | — | — | — |
| `src/providers/claude-quota-bridge.js` | server.js | `src/native/binding.js` | — | `async_hooks` | — | — |
| `src/providers/codex-history-hooks.js` | server.js | `src/model-history-converter.js` | — | — | — | — |
| `src/providers/defaults-port.js` | server.js | `src/native/binding.js` | — | `path` | — | — |
| `src/providers/egress-ip-policy.js` | server.js | `src/providers/egress-ip.js` | — | — | — | — |
| `src/providers/egress-ip.js` | server.js | — | — | `https` | — | — |
| `src/providers/force-detach.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/providers/host.js` | server.js | `src/codex/attempt-home.js`, `src/codex/model-catalog.js`, `src/codex/official-relay.js`, `src/codex/resident-route.js`, `src/codex/session-home.js`, `src/native/binding.js`, `src/official-accounts.js`, `src/paths/index.js`, `src/providers/defaults-port.js`, `src/providers/official-catalog.js` | — | `child_process`, `crypto`, `fs`, `os`, `path` | `cli-provider-router` | — |
| `src/providers/jev-client.js` | server.js | `src/network/outbound.js` | — | — | — | — |
| `src/providers/model-connect-watch.js` | server.js | `src/native/binding.js` | — | `async_hooks`, `diagnostics_channel` | — | — |
| `src/providers/native-vendor.js` | server.js | `src/cli/cli-capability.js`, `src/routes/agy-models.js`, `src/routes/model-catalogs-host.js` | — | — | — | — |
| `src/providers/official-catalog.js` | server.js | `src/codex/official-relay.js` | — | — | — | — |
| `src/providers/proxy-guard.js` | server.js | `src/codex/proxy-trace.js`, `src/providers/model-connect-watch.js`, `src/providers/proxy-outcome.js`, `src/providers/proxy-stall-watch.js` | — | `async_hooks` | — | — |
| `src/providers/proxy-outcome.js` | server.js | — | — | `crypto` | — | — |
| `src/providers/proxy-stall-watch.js` | server.js | `src/native/binding.js`, `src/providers/proxy-outcome.js` | — | `perf_hooks` | — | — |
| `src/providers/relay-model-catalog.js` | server.js | `src/network/outbound.js`, `src/official-accounts.js` | — | `crypto` | — | — |
| `src/providers/relay-share-store.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/providers/router-adapter.js` | server.js | — | — | `path` | — | — |
| `src/providers/router-port.js` | server.js | `src/claude-auth/proxy-recovery.js`, `src/codex/official-relay.js`, `src/codex/proxy-trace.js`, `src/providers/binding.js`, `src/providers/claude-quota-bridge.js`, `src/providers/codex-history-hooks.js`, `src/providers/proxy-guard.js`, `src/usage-observed.js` | — | `crypto`, `path` | — | — |
| `src/providers/router-runtime.js` | server.js | `src/agy-accounts.js`, `src/cli-key-accounts.js`, `src/network/global-proxy.js`, `src/network/proxy-policy.js`, `src/providers/binding.js`, `src/providers/native-vendor.js`, `src/providers/router-adapter.js`, `src/providers/router-port.js`, `src/providers/rust-cpr.js` | — | `path` | `cli-provider-router` | — |
| `src/providers/rust-cpr.js` | server.js | `src/codex/official-relay.js`, `src/native/binding.js`, `src/network/outbound.js`, `src/providers/virtual-provider.js`, `src/quota/claude-cli-oauth.js` | — | `crypto`, `path` | `cli-provider-router` | `17 require(path.join(cprRoot, 'proxy/request-hook'))`, `18 require(path.join(cprRoot, 'proxy/hop-credentials'))` |
| `src/providers/virtual-provider.js` | server.js | `src/native/binding.js`, `src/providers/egress-ip-policy.js`, `src/providers/host.js`, `src/quota/account-subscription-cache.js` | — | — | — | — |
| `src/push/bark-devices.js` | server.js | `src/runtime-security.js` | — | `crypto`, `fs`, `http`, `https` | — | — |
| `src/push/business.js` | server.js | `src/native/binding.js`, `src/runtime-security.js` | — | `crypto`, `fs` | — | — |
| `src/push/channel-subscriptions.js` | server.js | `src/plugins/channel-registry.js`, `src/runtime-security.js` | — | `crypto`, `fs` | — | — |
| `src/push/fcm-devices.js` | server.js | `src/push/fcm-transport.js`, `src/runtime-security.js` | — | `crypto`, `fs` | — | — |
| `src/push/fcm-transport.js` | server.js | — | — | `crypto`, `fs` | — | — |
| `src/push/runtime.js` | server.js | `src/chat/api-error-policy.js`, `src/classify/vocab.js`, `src/native/binding.js`, `src/plugins/channel-registry.js` | — | — | — | — |
| `src/push/service.js` | server.js | `src/paths/index.js`, `src/push/bark-devices.js`, `src/push/business.js`, `src/push/channel-subscriptions.js`, `src/push/fcm-devices.js`, `src/runtime-security.js` | — | `fs`, `http`, `https` | `web-push` | — |
| `src/quota-managed-browser.js` | server.js | `src/chrome-cdp.js` | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/quota/account-subscription-cache.js` | server.js | `src/native/binding.js` | — | `fs` | — | — |
| `src/quota/account-subscription-reader.js` | server.js | `src/native/binding.js`, `src/network/outbound.js`, `src/quota/account-subscription-cache.js`, `src/quota/claude-cli-oauth.js` | — | `os`, `path` | — | — |
| `src/quota/claude-bar-state.js` | server.js | `src/native/binding.js`, `src/quota/claude-usage-queue.js` | — | — | — | — |
| `src/quota/claude-cli-oauth.js` | server.js | `src/claude-auth/official-oauth.js`, `src/native/binding.js`, `src/network/outbound.js` | — | `fs`, `os`, `path` | — | — |
| `src/quota/claude-usage-queue.js` | server.js | — | — | — | — | — |
| `src/quota/limit-cache-recorder.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/quota/official-account-usage.js` | server.js | `src/providers/official-catalog.js`, `src/usage-limit-poller.js` | — | `path` | — | — |
| `src/quota/opencode-zen.js` | server.js | `src/network/outbound.js` | — | `fs`, `os`, `path` | — | — |
| `src/quota/provider-limit-cache-native-host.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/quota/provider-quota-history.js` | server.js | `src/native/binding.js` | — | `fs` | — | — |
| `src/quota/provider-runtime.js` | server.js | `src/native/binding.js`, `src/providers/virtual-provider.js`, `src/quota/account-subscription-cache.js`, `src/quota/limit-cache-recorder.js`, `src/quota/provider-limit-cache-native-host.js`, `src/quota/provider-quota-history.js`, `src/quota/quota-bar-cache.js`, `src/quota/quota-guard.js` | — | — | — | — |
| `src/quota/quota-bar-cache.js` | server.js | `src/state/store.js` | — | — | — | — |
| `src/quota/quota-guard.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/quota/quota-self-heal.js` | server.js | `src/providers/virtual-provider.js`, `src/usage-limit-poller.js` | — | `os`, `path` | — | — |
| `src/repo-actor/index.js` | server.js | `src/native/binding.js`, `src/portable-git.js` | — | `child_process`, `crypto`, `fs`, `path`, `util` | — | — |
| `src/request-locality.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/role-token-tracker.js` | server.js | `src/state/store.js`, `src/usage-observed.js` | — | `fs`, `path` | — | — |
| `src/router-tool-host.js` | server.js | `src/cli-adapters/router-mcp.js`, `src/native/binding.js`, `src/router-tool-runtime.js`, `src/secrets-vault.js` | `scripts/multicc-router-mcp.js` | `path` | — | — |
| `src/router-tool-runtime.js` | server.js | `src/native/binding.js`, `src/secret-audit.js` | — | `crypto` | — | — |
| `src/routes/account-routes-host.js` | server.js | `src/cli-key-accounts.js`, `src/native/binding.js`, `src/request-locality.js` | — | `fs`, `os`, `path` | — | — |
| `src/routes/agent-resources.js` | server.js | — | — | — | — | — |
| `src/routes/agy-models.js` | server.js | `src/agy-accounts.js` | — | `child_process`, `fs`, `path`, `readline` | — | — |
| `src/routes/aliyun-quota.js` | server.js | `src/quota-managed-browser.js`, `src/routes/kimi-quota.js` | — | — | — | — |
| `src/routes/ark-quota.js` | server.js | — | — | `child_process`, `fs`, `path` | — | — |
| `src/routes/auth.js` | server.js | `src/gateway-child.js`, `src/native/binding.js` | — | — | — | — |
| `src/routes/aux-goal.js` | server.js | `src/native/binding.js`, `src/quota/provider-limit-cache-native-host.js` | — | — | — | — |
| `src/routes/chat-history/index.js` | server.js | `src/chat/opencode-context.js`, `src/cli-switch.js`, `src/native/binding.js`, `src/session/chat-history-service/index.js` | — | `crypto` | — | — |
| `src/routes/claude-accounts.js` | server.js | `src/claude-auth/official-oauth.js`, `src/network/egress-fetch.js`, `src/network/outbound.js`, `src/official-accounts.js`, `src/providers/official-catalog.js`, `src/quota/account-subscription-reader.js` | — | — | — | — |
| `src/routes/claude-oauth.js` | server.js | — | — | — | — | — |
| `src/routes/claude-usage-quota.js` | server.js | `src/chrome-cdp.js`, `src/claude-auth/account-credentials.js`, `src/claude-auth/official-oauth.js`, `src/network/outbound.js`, `src/official-accounts.js`, `src/quota-managed-browser.js`, `src/quota/claude-cli-oauth.js`, `src/quota/claude-usage-queue.js` | — | — | — | — |
| `src/routes/cli-switch-host.js` | server.js | `src/request-locality.js` | — | — | — | — |
| `src/routes/codex-accounts.js` | server.js | `src/codex-auth/official-oauth.js`, `src/codex/model-catalog.js`, `src/network/egress-fetch.js`, `src/network/outbound.js`, `src/official-accounts.js`, `src/providers/official-catalog.js` | — | — | — | — |
| `src/routes/codex-quota.js` | server.js | `src/native/binding.js`, `src/usage-limit-poller.js` | — | — | — | — |
| `src/routes/developer-tools.js` | server.js | `src/cli-adapters/commands.js`, `src/network/outbound.js`, `src/portable-git.js`, `src/windows-env.js` | — | `child_process` | — | — |
| `src/routes/directory-host.js` | server.js | `src/native/binding.js`, `src/request-locality.js`, `src/state/store.js` | — | `crypto`, `path` | — | — |
| `src/routes/docs-memory-host.js` | server.js | `src/docs-registry.js`, `src/http-errors.js`, `src/request-locality.js`, `src/routes/memory-browser.js` | — | — | — | — |
| `src/routes/events-host.js` | server.js | `src/annotation-live.js`, `src/plugins/channel-registry.js`, `src/request-locality.js` | — | `crypto` | — | — |
| `src/routes/file-transfer-host.js` | server.js | `src/request-locality.js` | — | — | — | — |
| `src/routes/host-ops-host.js` | server.js | `src/native/binding.js`, `src/request-locality.js`, `src/routes/developer-tools.js`, `src/routes/host-write.js`, `src/routes/macos-privacy.js`, `src/routes/ops-terminal.js` | — | — | — | — |
| `src/routes/host-power.js` | server.js | `src/http-errors.js`, `src/macos-unlock-password.js`, `src/macos-unlock-probe.js`, `src/native/binding.js` | — | `fs`, `os`, `path` | — | — |
| `src/routes/host-read-host.js` | server.js | `src/codex/proxy-trace.js`, `src/host-battery.js`, `src/native/binding.js`, `src/request-locality.js`, `src/routes/host-power.js` | — | — | — | — |
| `src/routes/host-write.js` | server.js | `src/native/binding.js`, `src/routes/host-power.js` | — | — | — | — |
| `src/routes/kimi-auth.js` | server.js | `src/cli-adapters/kimi-auth.js`, `src/quota-managed-browser.js` | — | — | — | — |
| `src/routes/kimi-quota.js` | server.js | `src/network/outbound.js`, `src/providers/host.js`, `src/quota-managed-browser.js`, `src/upstream-error.js`, `src/usage-limit-poller.js` | — | — | — | — |
| `src/routes/macos-privacy.js` | server.js | `src/directories.js`, `src/macos-agent-provision.js` | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/routes/memory-browser.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/model-catalogs-host.js` | server.js | `src/cli-adapters/commands.js`, `src/codex/model-catalog.js`, `src/codex/official-relay.js`, `src/native/binding.js`, `src/request-locality.js`, `src/routes/opencode-models.js`, `src/routes/provider-models.js` | — | `child_process` | — | — |
| `src/routes/opencode-models.js` | server.js | — | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/routes/opencode-quota.js` | server.js | `src/chrome-cdp.js`, `src/quota-managed-browser.js`, `src/quota/opencode-zen.js` | — | — | — | — |
| `src/routes/ops-terminal.js` | server.js | `src/cli-adapters/commands.js`, `src/windows-env.js` | — | `child_process` | — | — |
| `src/routes/orchestration-host.js` | server.js | `src/native/binding.js`, `src/request-locality.js`, `src/routes/host-ops-host.js`, `src/unattended/native-host.js` | — | — | — | — |
| `src/routes/orchestration.js` | server.js | — | — | — | — | — |
| `src/routes/plugins-host.js` | server.js | `src/request-locality.js` | — | — | — | — |
| `src/routes/plugins.js` | server.js | `src/network/outbound.js`, `src/plugins/catalog.js`, `src/plugins/channel-host.js`, `src/plugins/channel-registry.js`, `src/plugins/installer.js`, `src/request-locality.js`, `src/routes/plugins-host.js` | — | `child_process`, `fs`, `path` | — | — |
| `src/routes/provider-balance-host.js` | server.js | `src/claude-auth/account-credentials.js`, `src/native/binding.js`, `src/network/outbound.js`, `src/official-accounts.js`, `src/providers/egress-ip-policy.js`, `src/providers/virtual-provider.js`, `src/quota/claude-cli-oauth.js`, `src/request-locality.js`, `src/usage-limit-poller.js` | — | — | — | — |
| `src/routes/provider-models.js` | server.js | `src/providers/host.js` | — | — | — | — |
| `src/routes/providers-host.js` | server.js | `src/claude-models.js`, `src/cli/cli-capability.js`, `src/native/binding.js`, `src/official-accounts.js`, `src/provider-reassign.js`, `src/providers/force-detach.js`, `src/providers/virtual-provider.js`, `src/quota/account-subscription-cache.js`, `src/quota/provider-limit-cache-native-host.js`, `src/request-locality.js` | — | — | — | — |
| `src/routes/providers.js` | server.js | `src/native/binding.js`, `src/providers/defaults-port.js`, `src/providers/native-vendor.js`, `src/routes/providers-host.js`, `src/routes/subagent-defaults-host.js` | — | — | — | — |
| `src/routes/push-host.js` | server.js | `src/push/bark-devices.js`, `src/push/business.js`, `src/push/channel-subscriptions.js`, `src/request-locality.js` | — | — | — | — |
| `src/routes/qoder-quota.js` | server.js | `src/chrome-cdp.js`, `src/network/outbound.js`, `src/quota-managed-browser.js` | — | `fs`, `os`, `path` | — | — |
| `src/routes/quota-host.js` | server.js | `src/pricing/price-table.js`, `src/quota-managed-browser.js`, `src/quota/claude-bar-state.js`, `src/quota/claude-usage-queue.js`, `src/request-locality.js`, `src/routes/aliyun-quota.js`, `src/routes/ark-quota.js`, `src/routes/claude-usage-quota.js`, `src/routes/codex-quota.js`, `src/routes/kimi-quota.js`, `src/routes/opencode-quota.js`, `src/routes/qoder-quota.js` | — | `child_process` | — | — |
| `src/routes/release-history-host.js` | server.js | `src/ios-udid.js`, `src/native/binding.js`, `src/request-locality.js` | — | `http` | — | — |
| `src/routes/secrets-vault-host.js` | server.js | `src/request-locality.js` | — | — | — | — |
| `src/routes/server-core-host.js` | server.js | `src/chat/sessions.js`, `src/request-locality.js` | — | — | — | — |
| `src/routes/server-restart-route.js` | server.js | `src/server-restart.js` | — | — | — | — |
| `src/routes/session-admin-host.js` | server.js | `src/classify/vocab.js`, `src/providers/auto-provider-config.js`, `src/request-locality.js` | — | — | — | — |
| `src/routes/session-admin.js` | server.js | `src/classify/vocab.js`, `src/native/binding.js`, `src/native/task-domain.js`, `src/routes/orchestration-host.js`, `src/routes/session-admin-host.js`, `src/routes/task-goal.js`, `src/session/query-service.js`, `src/session/workspace-service.js` | — | — | — | — |
| `src/routes/session-bundle.js` | server.js | `src/git/service/index.js`, `src/memory/builtin-rules.js`, `src/native/binding.js`, `src/session/handoff-env.js` | — | `child_process`, `crypto`, `fs`, `os`, `path`, `util` | `express` | `771 require(file.zipRef)`, `779 require(file.zipRef)`, `782 require(zipPayload.gitBundleZip.zipRef)` |
| `src/routes/session-create.js` | server.js | `src/cli-key-accounts.js`, `src/native/binding.js`, `src/routes/account-routes-host.js` | — | `crypto` | — | — |
| `src/routes/session-git-host.js` | server.js | `src/request-locality.js` | — | `path` | — | — |
| `src/routes/session-git.js` | server.js | `src/native/binding.js`, `src/routes/session-git-host.js` | — | `path` | — | — |
| `src/routes/session-lifecycle.js` | server.js | `src/chat/codex-rollout-guard.js`, `src/native/binding.js` | — | — | — | — |
| `src/routes/session-memory.js` | server.js | — | — | — | — | — |
| `src/routes/session-profile.js` | server.js | `src/classify/vocab.js`, `src/cli-key-accounts.js`, `src/cli/cli-capability.js`, `src/memory/runtime.js`, `src/native/binding.js`, `src/native/task-domain.js`, `src/providers/auto-provider-config.js`, `src/providers/native-vendor.js` | — | `crypto`, `fs`, `path` | — | — |
| `src/routes/session-routes-host.js` | server.js | `src/native/binding.js`, `src/request-locality.js` | — | `crypto` | — | — |
| `src/routes/share-machines-host.js` | server.js | `src/native/binding.js`, `src/request-locality.js`, `src/routes/share.js` | — | — | — | — |
| `src/routes/share.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/subagent-defaults-host.js` | server.js | `src/native/binding.js`, `src/request-locality.js` | — | — | — | — |
| `src/routes/task-board/index.js` | server.js | `src/classify/vocab.js`, `src/native/binding.js`, `src/native/task-domain.js`, `src/routes/task-planning.js`, `src/session-work/index.js`, `src/task-board/board-store.js`, `src/task-board/core/index.js`, `src/task-board/lifecycle.js`, `src/task-board/native-bridge.js`, `src/task-board/planning.js`, `src/task-board/relocate.js`, `src/task-board/retention.js`, `src/task-worktree.js`, `src/voice/router.js` | — | `crypto`, `fs` | — | — |
| `src/routes/task-goal.js` | server.js | `src/classify/vocab.js` | — | — | — | — |
| `src/routes/task-graph.js` | server.js | `src/native/binding.js`, `src/task-board/core/index.js` | — | — | — | — |
| `src/routes/task-planning.js` | server.js | `native/core/src/task_planning_status.json`, `src/native/task-domain.js`, `src/task-board/planning.js` | — | — | — | — |
| `src/routes/task-routes-host.js` | server.js | `src/request-locality.js`, `src/routes/task-planning.js` | — | — | — | — |
| `src/routes/task-search.js` | server.js | `src/native/task-search.js` | — | — | — | — |
| `src/routes/token-usage.js` | server.js | `src/codex/usage.js` | — | — | — | — |
| `src/routes/update-route.js` | server.js | `src/routes/release-history-host.js`, `src/update-runner.js` | — | — | — | — |
| `src/routes/voice-gateway-host.js` | server.js | `src/request-locality.js`, `src/voice/gateway.js` | `src/voice/multicc-acp-agent.mjs` | `path` | — | — |
| `src/routes/voice-gateway-proxy.js` | server.js | — | — | `http` | — | — |
| `src/routes/voice-host.js` | server.js | `src/request-locality.js` | — | — | — | — |
| `src/routes/voice-runtime-host.js` | server.js | `src/request-locality.js`, `src/routes/voice-gateway-host.js` | — | — | — | — |
| `src/routes/voice.js` | server.js | `src/native/binding.js`, `src/routes/voice-host.js` | — | — | — | — |
| `src/routes/zcode-auth.js` | server.js | `src/cli-adapters/zcode-auth.js` | — | — | — | — |
| `src/runtime-homes-janitor.js` | server.js | — | — | `fs`, `os`, `path` | — | — |
| `src/runtime-security.js` | server.js | `src/state/store.js` | — | `fs`, `path` | — | — |
| `src/search/index-store.js` | server.js | `src/native/binding.js`, `src/sqlite/driver.js` | — | `crypto`, `fs`, `path` | — | — |
| `src/search/message-corpus.js` | server.js | `src/search/index-store.js` | — | `crypto`, `fs` | — | — |
| `src/search/runtime.js` | server.js | `src/native/binding.js`, `src/paths/index.js`, `src/search/index-store.js`, `src/search/message-corpus.js`, `src/search/slice-runner.js`, `src/state/container.js`, `src/state/store.js` | — | `path` | — | — |
| `src/search/slice-runner.js` | server.js | — | — | — | — | — |
| `src/secret-audit.js` | server.js | `src/native/binding.js`, `src/paths/index.js` | — | `async_hooks` | — | — |
| `src/secret-tools.js` | server.js | `src/secret-audit.js` | — | `child_process`, `fs` | — | — |
| `src/secrets-vault.js` | server.js | `src/paths/index.js`, `src/runtime-security.js`, `src/secret-audit.js` | — | `crypto`, `fs`, `path` | — | — |
| `src/server-processes.js` | server.js | — | — | `child_process`, `fs`, `path` | — | — |
| `src/server-restart.js` | server.js | `src/host-env.js` | — | `child_process`, `crypto`, `fs`, `net`, `path` | — | — |
| `src/session-work/index.js` | server.js | `src/cli-adapters/kimi-auth.js`, `src/cli-adapters/zcode-auth.js`, `src/native/binding.js`, `src/orchestration/native-store-host.js` | — | `crypto` | — | — |
| `src/session/chat-history-service/index.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/session/handoff-env.js` | server.js | — | — | `fs`, `os`, `path` | — | — |
| `src/session/hibernation-composition.js` | server.js | `src/native/binding.js`, `src/session/hibernation.js` | — | `fs` | — | — |
| `src/session/hibernation.js` | server.js | `src/native/binding.js` | — | `fs`, `os`, `path` | — | — |
| `src/session/query-service.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/session/records.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/session/workspace-service.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/share.js` | server.js | `src/auth-security.js`, `src/paths/index.js`, `src/runtime-security.js` | — | `crypto`, `fs` | — | — |
| `src/shutdown.js` | server.js | — | — | — | — | — |
| `src/skill-converter.js` | server.js | — | — | `fs`, `os`, `path` | — | — |
| `src/skill-sync/index.js` | server.js | `src/cdpd.js`, `src/macos-agent-provision.js`, `src/native/binding.js` | — | — | — | — |
| `src/skills.js` | server.js | `src/state/container.js` | — | `fs`, `os`, `path` | — | — |
| `src/sqlite/driver.js` | server.js | — | — | `fs`, `path` | — | `74 require(file)` |
| `src/state/container.js` | server.js | — | — | — | — | — |
| `src/state/owner.js` | server.js | `src/directory/records.js`, `src/native/binding.js` | — | — | — | — |
| `src/state/store.js` | server.js | — | — | `fs`, `path` | — | — |
| `src/tailscale-funnel-health.js` | server.js | — | — | `crypto`, `http`, `https`, `net` | — | — |
| `src/task-board/board-store.js` | server.js | `src/native/binding.js`, `src/native/task-domain.js`, `src/task-board/planning.js` | — | — | — | — |
| `src/task-board/core/index.js` | server.js | `src/native/binding.js`, `src/task-board/native-bridge.js`, `src/task-board/normalize.js`, `src/task-board/planning.js`, `src/task-board/routing.js` | — | — | — | — |
| `src/task-board/lifecycle-host.js` | server.js | `src/classify/vocab.js`, `src/git/service/index.js`, `src/task-board/core/index.js` | — | `fs` | — | — |
| `src/task-board/lifecycle.js` | server.js | `src/native/binding.js`, `src/task-board/native-bridge.js` | — | — | — | — |
| `src/task-board/native-bridge.js` | server.js | `src/native/binding.js`, `src/native/task-domain.js`, `src/task-board/planning.js` | — | `crypto` | — | — |
| `src/task-board/normalize.js` | server.js | `src/classify/vocab.js`, `src/task-board/native-bridge.js`, `src/task-board/planning.js` | — | `crypto` | — | — |
| `src/task-board/planning.js` | server.js | `src/native/binding.js`, `src/native/task-domain.js` | — | `crypto` | — | — |
| `src/task-board/relocate.js` | server.js | — | — | — | — | — |
| `src/task-board/retention.js` | server.js | `src/classify/vocab.js`, `src/native/binding.js`, `src/native/task-domain.js` | — | — | — | — |
| `src/task-board/routing.js` | server.js | `src/native/task-domain.js`, `src/task-board/normalize.js` | — | — | — | — |
| `src/task-board/search.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/task-context-host.js` | server.js | `src/chat/provider-attempt-runtime.js`, `src/native/binding.js`, `src/unattended/native-host.js` | — | — | — | — |
| `src/task-routing/code-revision.js` | server.js | `src/native/binding.js`, `src/repo-actor/index.js` | — | `crypto`, `fs/promises`, `path` | — | — |
| `src/task-routing/delivery-view.js` | server.js | — | — | — | — | — |
| `src/task-routing/evidence.js` | server.js | `src/repo-actor/index.js`, `src/task-routing/code-revision.js`, `src/task-routing/facts.js` | — | `crypto`, `fs`, `path` | — | — |
| `src/task-routing/facts.js` | server.js | — | — | `util` | — | — |
| `src/task-shell/artifacts.js` | server.js | `src/artifacts.js`, `src/native/binding.js` | — | `fs`, `path` | — | — |
| `src/task-shell/attribution-decisions.js` | server.js | `src/native/binding.js`, `src/native/task-domain.js` | — | — | — | — |
| `src/task-shell/chat-history.js` | server.js | `src/routes/chat-history/index.js` | — | — | — | — |
| `src/task-shell/context-plan.js` | server.js | `src/cli-switch.js`, `src/native/binding.js` | — | — | — | — |
| `src/task-shell/history-context.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/task-shell/host.js` | server.js | `src/classify/vocab.js`, `src/docs-registry.js`, `src/git/service/index.js`, `src/native/binding.js`, `src/native/task-domain.js`, `src/request-locality.js`, `src/task-board/core/index.js`, `src/task-shell/artifacts.js`, `src/task-shell/attribution-decisions.js`, `src/task-shell/chat-history.js`, `src/task-shell/runtime.js`, `src/task-shell/store.js`, `src/task-shell/task-index.js`, `src/task-shell/task-operations.js`, `src/task-shell/workspace.js`, `src/workspace/separation-transfer.js` | — | `child_process`, `crypto`, `util` | — | — |
| `src/task-shell/independent-continue.js` | server.js | `src/native/binding.js`, `src/task-shell/history-context.js` | — | — | — | — |
| `src/task-shell/migration-gate.js` | server.js | `src/gateway-child.js`, `src/native/binding.js`, `src/paths/index.js` | `src/task-shell/migration-page-worker.js` | `fs`, `path`, `worker_threads` | — | — |
| `src/task-shell/migration-page-worker.js` | 宿主脚本路径 | `src/gateway-child.js`, `src/native/binding.js` | — | `fs`, `http`, `worker_threads` | — | — |
| `src/task-shell/role-bindings.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/task-shell/runtime.js` | server.js | `src/native/binding.js`, `src/task-shell/context-plan.js`, `src/task-shell/history-context.js`, `src/task-shell/independent-continue.js`, `src/task-shell/role-bindings.js`, `src/task-shell/separation.js`, `src/task-shell/task-actions.js`, `src/task-shell/task-first.js` | — | `crypto` | — | — |
| `src/task-shell/separation.js` | server.js | `src/native/binding.js`, `src/task-shell/history-context.js` | — | — | — | — |
| `src/task-shell/store.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/task-shell/task-actions.js` | server.js | `src/native/binding.js`, `src/task-shell/history-context.js` | — | — | — | — |
| `src/task-shell/task-first.js` | server.js | — | — | — | — | — |
| `src/task-shell/task-graph-context.js` | server.js | `src/native/binding.js`, `src/task-board/core/index.js` | — | — | — | — |
| `src/task-shell/task-index.js` | server.js | `src/native/binding.js`, `src/task-shell/chat-history.js` | — | — | — | — |
| `src/task-shell/task-operations.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/task-shell/workspace.js` | server.js | `src/cli-switch.js`, `src/git/service/index.js`, `src/native/binding.js`, `src/repo-actor/index.js` | — | `fs` | — | — |
| `src/task-worktree.js` | server.js | — | — | `crypto`, `fs`, `path` | — | — |
| `src/tmux.js` | server.js | `src/network/proxy-policy.js` | — | `child_process`, `fs`, `net`, `os`, `path` | — | — |
| `src/triggers/index.js` | server.js | `src/native/binding.js`, `src/plugins/channel-registry.js` | — | — | — | — |
| `src/tunnel-sakurafrp-api.js` | server.js | — | — | `fs`, `os`, `path` | — | — |
| `src/tunnel-sakurafrp.js` | server.js | — | — | `fs`, `os`, `path` | — | — |
| `src/tunnel/index.js` | server.js | `src/native/binding.js`, `src/runtime-security.js`, `src/tailscale-funnel-health.js`, `src/tunnel-sakurafrp-api.js`, `src/tunnel-sakurafrp.js` | — | `child_process`, `fs`, `http`, `https`, `os`, `path` | — | — |
| `src/turn-ledger/hook-install.js` | server.js | — | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/turn-ledger/ledger.js` | server.js | `src/classify/vocab.js`, `src/native/binding.js` | — | — | — | — |
| `src/turn-ledger/runtime.js` | server.js | `src/cli/cli-capability.js`, `src/native/binding.js`, `src/turn-ledger/hook-install.js`, `src/turn-ledger/ledger.js` | — | `fs`, `os`, `path` | — | — |
| `src/unattended/native-host.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/unattended/runtime.js` | server.js | `src/unattended/native-host.js` | — | — | — | — |
| `src/update-runner.js` | server.js | `src/network/outbound.js` | — | `fs`, `path` | — | — |
| `src/upload-middleware.js` | server.js | — | — | `path` | `multer` | — |
| `src/upstream-error.js` | server.js | `src/observability.js` | — | — | — | — |
| `src/usage-limit-poller.js` | server.js | `src/native/binding.js`, `src/network/outbound.js`, `src/providers/egress-ip-policy.js`, `src/providers/host.js`, `src/upstream-error.js` | — | `crypto` | — | — |
| `src/usage-observed.js` | server.js | `src/native/binding.js`, `src/providers/binding.js`, `src/providers/proxy-outcome.js` | — | — | — | — |
| `src/voice/acp-bridge.js` | 宿主脚本路径 | `src/native/binding.js` | — | `crypto` | `ws` | — |
| `src/voice/asr-local.js` | server.js | `src/voice/config.js`, `src/voice/hotword-corrector.js` | — | `child_process`, `fs`, `os`, `path` | `sherpa-onnx-node` | — |
| `src/voice/asr-model-installer.js` | server.js | — | — | `fs`, `path`, `stream`, `stream/promises` | — | — |
| `src/voice/config.js` | server.js | `src/paths/index.js`, `src/runtime-security.js`, `src/voice/hotword-corrector.js`, `src/voice/hotword-learner.js` | — | `fs` | — | — |
| `src/voice/gateway.js` | server.js | `src/task-board/core/index.js` | — | `crypto` | — | — |
| `src/voice/host.js` | server.js | `src/routes/voice-gateway-host.js`, `src/routes/voice-gateway-proxy.js`, `src/routes/voice-runtime-host.js`, `src/routes/voice.js`, `src/task-board/core/index.js`, `src/voice/asr-local.js`, `src/voice/asr-model-installer.js`, `src/voice/config.js`, `src/voice/gateway.js`, `src/voice/launch.js`, `src/voice/qwen-audio-installer.js`, `src/voice/qwen-audio-supervisor.js`, `src/voice/router.js` | `src/voice/multicc-acp-agent.mjs` | `path` | — | — |
| `src/voice/hotword-corrector.js` | server.js | — | — | — | `pinyin-pro` | — |
| `src/voice/hotword-learner.js` | server.js | `src/native/binding.js`, `src/runtime-security.js`, `src/voice/hotword-miner.js` | — | `crypto`, `fs`, `path` | — | — |
| `src/voice/hotword-miner.js` | server.js | `src/native/binding.js`, `src/voice/hotword-corrector.js` | — | — | — | — |
| `src/voice/launch.js` | server.js | `src/voice/router.js` | — | `crypto` | — | — |
| `src/voice/multicc-acp-agent.mjs` | 宿主脚本路径 | `src/voice/acp-bridge.js` | — | `stream` | `@agentclientprotocol/sdk` | — |
| `src/voice/qwen-audio-installer.js` | server.js | `src/network/outbound.js`, `src/runtime-security.js` | — | `child_process`, `crypto`, `fs`, `path` | — | — |
| `src/voice/qwen-audio-supervisor.js` | server.js | `src/network/outbound.js`, `src/runtime-security.js`, `src/voice/gateway.js` | — | `child_process`, `crypto`, `fs`, `net`, `path` | — | — |
| `src/voice/router.js` | server.js | — | — | `fs`, `path` | — | — |
| `src/voice/tts-service.js` | server.js | `src/network/outbound.js` | — | `child_process`, `https` | `ws` | — |
| `src/wait/injector.js` | server.js | `src/native/binding.js` | — | `crypto` | — | — |
| `src/wait/service.js` | server.js | `src/native/binding.js`, `src/outbox.js` | — | `crypto` | — | — |
| `src/windows-env.js` | server.js | `src/native/binding.js` | — | `child_process`, `fs`, `path` | — | — |
| `src/workspace/admission.js` | server.js | `src/git/service/index.js`, `src/native/binding.js`, `src/repo-actor/index.js`, `src/task-routing/code-revision.js`, `src/task-routing/evidence.js`, `src/task-shell/role-bindings.js`, `src/task-shell/store.js`, `src/workspace/registry.js`, `src/workspace/writer-escalation.js` | — | `child_process`, `crypto`, `fs`, `path`, `util` | — | — |
| `src/workspace/air-card-cache.js` | server.js | `src/native/binding.js`, `src/native/task-domain.js` | — | — | — | — |
| `src/workspace/air-index-port.js` | server.js | `src/native/binding.js`, `src/native/task-read-model.js` | — | `crypto` | — | — |
| `src/workspace/air-routes-host.js` | server.js | `src/classify/vocab.js`, `src/native/task-domain.js`, `src/request-locality.js`, `src/task-board/core/index.js`, `src/task-routing/delivery-view.js`, `src/workspace/air-card-cache.js`, `src/workspace/air-sync-runtime.js` | — | `crypto`, `path` | — | — |
| `src/workspace/air-routes.js` | server.js | `src/workspace/air-routes-host.js` | — | — | — | — |
| `src/workspace/air-sync-runtime.js` | server.js | `src/workspace/air-index-port.js` | — | — | — | — |
| `src/workspace/inventory.js` | 工作区运维脚本 | `src/classify/vocab.js` | — | `crypto`, `path` | — | — |
| `src/workspace/orphan-scan.js` | server.js | — | — | `fs`, `path` | — | — |
| `src/workspace/registry.js` | server.js | — | — | `crypto` | — | — |
| `src/workspace/runtime.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/workspace/separation-transfer.js` | server.js | `src/git/service/index.js` | — | — | — | — |
| `src/workspace/writer-escalation.js` | server.js | `src/server-processes.js` | — | — | — | — |
| `src/ws/connection-router.js` | server.js | `src/gateway-child.js`, `src/native/binding.js`, `src/ws/native-queue.js`, `src/ws/ws-host.js` | — | `crypto` | `ws` | — |
| `src/ws/gateway-chat-bridge.js` | server.js | — | — | `crypto`, `events`, `net` | — | — |
| `src/ws/native-queue.js` | server.js | — | — | — | — | — |
| `src/ws/ws-host.js` | server.js | `src/native/binding.js` | — | — | — | — |
