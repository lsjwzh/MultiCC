# Node 后端模块与运行依赖

默认生产服务使用 Cargo 构建的网关。部署目录中的后端 JavaScript 和 Node 运行依赖计数见[生产清单](remaining-node-checklist.md)。下表统计显式兼容宿主及其工具。

运行 `node --expose-internals scripts/inventory-node-backend.js docs/rust-migration/node-module-dependencies.md` 重建。
统计工作树中 Git 跟踪和未忽略的新文件。下表逐项列出 src 中的模块，含薄桥和离线工具。入口栏标示从 server.js 递归追踪字面量 import、require、require.resolve 及其 createRequire 别名的结果。脚本路径列另列 path.join/resolve(__dirname, 字面量) 指向的文件，包含 worker 与子进程。条件分支按可能加载计；运行时注入依赖仍需结合具体部署核验。动态表达式附行号。

当前 src 中有 264 个 .js、2 个 .cjs、3 个 .mjs。根包有 0 个直接运行依赖。

## 根包运行依赖

兼容宿主打包路径与根 npm 包独立。下表只统计根包 dependencies。开发依赖与桌面包中的宿主仍应分别审计。

兼容宿主的 Claude 引擎由 `@anthropic-ai/claude-agent-sdk` 的平台可选包提供二进制，解析入口为 `native/core/src/claude_models.rs`。CPR 的传递依赖（包括 `@iarna/toml`）保留在 package-lock.json 中。

| 包 | 声明版本 | 直接引用（server.js、src、启动入口、生产插件） |
|---|---|---|

## src 模块

| 文件 | 入口 | 本地直接依赖 | 本地脚本路径 | Node 内置模块 | 外部包 | 动态或未解析 |
|---|---|---|---|---|---|---|
| `src/annotation-live.js` | server.js | `src/native/binding.js` | — | `fs`, `os`, `path` | — | — |
| `src/apk-distribution.js` | server.js | — | — | — | — | — |
| `src/aux-http.js` | server.js | — | — | `http`, `https` | — | — |
| `src/bus.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/cdp-relay.js` | server.js | `src/cdpd.js` | — | `events`, `net` | `ws` | — |
| `src/cdpd.js` | server.js | — | — | `child_process`, `fs`, `net`, `os`, `path` | — | — |
| `src/chat/admission-progress.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/chat/api-error-host.js` | server.js | `src/claude-auth/oauth-refresh.js`, `src/native/binding.js` | — | — | — | — |
| `src/chat/api-error-policy.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/chat/auto-provider-routing.js` | server.js | `src/native/binding.js`, `src/secrets-vault.js` | — | — | — | — |
| `src/chat/auto-provider-runtime.js` | server.js | `src/chat/admission-progress.js`, `src/chat/auto-provider-routing.js`, `src/native/binding.js`, `src/pricing/price-table.js` | — | — | — | — |
| `src/chat/auto-route-notes.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/chat/background-hold.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/chat/background-task-runtime.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/chat/chat-stream.js` | server.js | `src/chat/background-hold.js`, `src/chat/claude-sdk-stream.js`, `src/chat/codex-app-stream.js`, `src/chat/stream-router.js`, `src/native/binding.js`, `src/secrets-vault.js` | — | `child_process`, `crypto` | — | — |
| `src/chat/claude-sdk-stream.js` | server.js | `src/chat/background-hold.js`, `src/native/binding.js`, `src/secrets-vault.js` | — | `crypto` | — | — |
| `src/chat/codex-app-stream.js` | server.js | `src/native/binding.js`, `src/secrets-vault.js` | — | `child_process`, `crypto`, `fs`, `path` | — | — |
| `src/chat/codex-rollout-guard.js` | server.js | `src/native/binding.js` | — | `os` | — | — |
| `src/chat/error-persistence.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/chat/finalize-host.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/chat/held-turn-injection.js` | server.js | `src/chat/background-hold.js` | — | — | — | — |
| `src/chat/host-coordinator.js` | server.js | `src/chat/turn-lifecycle.js`, `src/native/binding.js` | — | `crypto` | — | — |
| `src/chat/host-runtime.js` | server.js | `src/chat/host-coordinator.js`, `src/native/binding.js` | — | — | — | — |
| `src/chat/index.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/chat/missing-resume-recovery.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/chat/native-session-guard.js` | server.js | `src/native/binding.js` | — | `os` | — | — |
| `src/chat/opencode-context.js` | server.js | `src/cli-switch.js`, `src/native/binding.js` | — | `crypto`, `os`, `path` | — | — |
| `src/chat/process-watchdog.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/chat/provider-log-watchdog.js` | server.js | `src/native/binding.js` | — | `fs`, `os`, `path` | — | — |
| `src/chat/proxy-broadcast.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/chat/resident-pool.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/chat/stalled-turn-recovery.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/chat/stream-router.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/chat/turn-engine-host.js` | server.js | `src/chat/admission-progress.js`, `src/chat/auto-provider-runtime.js`, `src/chat/auto-route-notes.js`, `src/chat/chat-stream.js`, `src/chat/codex-rollout-guard.js`, `src/chat/held-turn-injection.js`, `src/chat/host-coordinator.js`, `src/chat/native-session-guard.js`, `src/chat/opencode-context.js`, `src/cli-switch.js`, `src/cli/session-policy.js`, `src/cli/switch-runtime.js`, `src/codex/usage.js`, `src/native/binding.js`, `src/routes/chat-history/index.js`, `src/secrets-vault.js`, `src/wait/injector.js` | — | `child_process`, `crypto` | — | — |
| `src/chat/turn-event-journal.js` | server.js | `src/native/binding.js` | — | `fs`, `path` | — | — |
| `src/chat/turn-lifecycle.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/chrome-cdp.js` | server.js | `src/cdp-relay.js` | — | `fs`, `http`, `os`, `path` | `ws` | — |
| `src/classify/aux-run-log.js` | server.js | `src/native/binding.js` | — | `fs`, `path` | — | — |
| `src/classify/history-backtest.js` | 归属离线回测 | `src/classify/task-attribution.js` | — | — | — | — |
| `src/classify/task-attribution.js` | server.js | `src/native/binding.js` | — | `crypto` | — | — |
| `src/classify/vocab.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/claude-auth/account-credentials.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/claude-auth/accounts-refresh.js` | server.js | `src/claude-auth/oauth-refresh.js`, `src/native/binding.js` | — | `child_process`, `crypto`, `fs`, `os`, `path` | — | — |
| `src/claude-auth/oauth-refresh.js` | server.js | `src/native/binding.js` | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/claude-auth/proxy-recovery.js` | server.js | — | — | `async_hooks`, `stream` | — | — |
| `src/cli-adapters/claude-agent-sdk-bridge.mjs` | 宿主脚本路径 | `src/native/binding.js` | — | `fs`, `module`, `os`, `path`, `url` | — | — |
| `src/cli-adapters/completion.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/cli-adapters/pi-router-extension.mjs` | 宿主脚本路径 | — | — | `child_process`, `readline`, `url` | — | — |
| `src/cli-adapters/result-completion.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/cli-adapters/zcode-app-server.js` | 宿主脚本路径 | — | — | — | — | — |
| `src/cli-adapters/zcode-bridge.cjs` | 宿主脚本路径 | `src/chat/background-hold.js`, `src/cli-adapters/zcode-app-server.js`, `src/native/binding.js` | — | `child_process`, `fs`, `os`, `path`, `readline` | — | — |
| `src/cli-adapters/zcode-terminal.cjs` | 宿主脚本路径 | `src/native/binding.js` | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/cli-key-accounts.js` | server.js | `src/native/binding.js` | — | `crypto`, `fs`, `path` | — | — |
| `src/cli-switch.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/cli/cli-capability.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/cli/cli-upstream-version.js` | server.js | `src/native/binding.js` | — | `os`, `path`, `tls` | — | — |
| `src/cli/native-session-exists.js` | server.js | `src/sqlite/driver.js` | — | `fs`, `os`, `path` | — | — |
| `src/cli/session-policy.js` | server.js | `src/native/binding.js` | — | `fs`, `os`, `path` | — | — |
| `src/cli/switch-runtime.js` | server.js | `src/cli/native-session-exists.js`, `src/cli/tools-host.js`, `src/native/binding.js`, `src/routes/cli-switch-host.js` | — | `crypto` | — | — |
| `src/cli/tools-host.js` | server.js | `package.json`, `src/cli/cli-upstream-version.js`, `src/native/binding.js` | — | `child_process`, `crypto`, `fs`, `os`, `path` | — | — |
| `src/codex-auth/official-oauth.js` | server.js | — | — | `crypto`, `http` | — | — |
| `src/codex/usage.js` | server.js | `src/native/binding.js` | — | `crypto` | — | — |
| `src/commander-migration.js` | server.js | — | — | — | — | — |
| `src/detached.js` | server.js | `src/native/binding.js` | — | `child_process`, `crypto`, `fs`, `os`, `path` | — | — |
| `src/directories.js` | server.js | `src/native/binding.js` | — | `fs`, `path` | — | — |
| `src/dispatch/gateway-host.js` | server.js | `src/dispatch/targeting.js`, `src/native/binding.js` | — | — | — | — |
| `src/dispatch/targeting.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/doctor/environment.js` | server.js | `src/doctor/llm-loop.js`, `src/doctor/tools.js` | — | `child_process`, `crypto`, `fs`, `os`, `path` | — | — |
| `src/doctor/llm-loop.js` | server.js | `src/aux-http.js` | — | `http`, `https` | — | — |
| `src/doctor/service.js` | server.js | `package.json`, `src/doctor/environment.js`, `src/doctor/llm-loop.js`, `src/doctor/tools.js`, `src/native/binding.js`, `src/routes/ops-terminal.js` | — | `crypto`, `os`, `path` | — | — |
| `src/doctor/tools.js` | server.js | — | — | `child_process`, `fs`, `path` | — | — |
| `src/events/actions.js` | server.js | `src/native/binding.js` | — | `crypto`, `net` | — | — |
| `src/events/engine.js` | server.js | `src/events/actions.js`, `src/native/binding.js` | — | `crypto` | — | — |
| `src/events/host.js` | server.js | `src/events/engine.js`, `src/events/hub.js`, `src/native/binding.js` | — | `dns`, `fs`, `http`, `https`, `os` | — | — |
| `src/events/hub.js` | server.js | `src/native/binding.js` | — | `crypto` | — | — |
| `src/experiments/tui-chat-mirror-runtime.js` | server.js | `src/tmux.js` | — | `crypto`, `fs`, `os`, `path` | — | — |
| `src/fleet-sharing.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/git/queue.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/git/service/index.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/host-battery.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | `child_process`, `fs/promises` | — | — |
| `src/host-lifecycle.js` | server.js | `src/shutdown.js` | — | — | — | — |
| `src/http/error-presenter.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/ios-ota.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/ios-udid.js` | server.js | `src/native/binding.js` | — | `child_process`, `crypto` | `express` | — |
| `src/lan-discovery.js` | server.js | `src/native/binding.js` | — | `net`, `os` | `@homebridge/ciao` | — |
| `src/liveness/rollout-path.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/liveness/runtime.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/log-housekeeping.js` | server.js | — | — | `fs`, `path` | — | — |
| `src/machines.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/macos-agent-build.js` | 未从已知入口静态到达 | — | — | `crypto`, `fs`, `path` | — | — |
| `src/macos-unlock-password.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/macos-unlock-probe.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/memo/index.js` | server.js | `src/memo/migrate.js`, `src/native/binding.js` | — | `fs`, `path` | — | — |
| `src/memo/migrate.js` | server.js | `src/native/binding.js` | — | `child_process`, `path` | — | — |
| `src/model-history-converter.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/native/binding.js` | server.js | `package.json`, `src/chat/api-error-host.js`, `src/chat/finalize-host.js`, `src/chat/host-coordinator.js`, `src/chat/host-runtime.js`, `src/chat/turn-lifecycle.js`, `src/native/bootstrap-apis.js`, `src/operation-service.js`, `src/routes/plugins-host.js`, `src/tailscale-funnel-health.js`, `src/tunnel-sakurafrp-api.js`, `src/wait/service.js` | `scripts/multicc-router-mcp.js`, `src/cli-adapters/claude-agent-sdk-bridge.mjs`, `src/cli-adapters/pi-router-extension.mjs`, `src/cli-adapters/zcode-bridge.cjs`, `src/cli-adapters/zcode-terminal.cjs`, `src/task-shell/migration-page-worker.js`, `src/voice/multicc-acp-agent.mjs` | `async_hooks`, `buffer`, `child_process`, `crypto`, `diagnostics_channel`, `events`, `fs`, `fs/promises`, `http`, `https`, `module`, `net`, `os`, `path`, `perf_hooks`, `stream`, `stream/promises`, `util`, `worker_threads`, `zlib` | `cli-provider-router`, `multer`, `pinyin-pro`, `proxy-agent`, `undici` | `1338 require(path.join(root, 'scripts', 'ensure-source-rust'))`, `487 require(file)` |
| `src/native/bootstrap-apis.js` | server.js | `native/core/src/task_planning_status.json`, `src/native/binding.js` | — | `events`, `os`, `path` | — | — |
| `src/network/egress-fetch.js` | server.js | `src/native/binding.js` | — | `http`, `https` | `proxy-agent` | — |
| `src/network/sdk-bridges.js` | server.js | `src/native/binding.js` | — | `fs`, `module`, `path` | `@discordjs/ws`, `discord.js`, `ws` | `50 localRequire(id)` |
| `src/official-accounts-cli-login.js` | server.js | `src/native/binding.js` | — | `crypto`, `fs`, `os`, `path` | — | — |
| `src/operation-service.js` | server.js | `src/native/binding.js` | — | `crypto` | — | — |
| `src/orchestration/host.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/paths/index.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/portable-git.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/pricing/price-table.js` | server.js | — | — | `fs`, `os`, `path` | — | — |
| `src/provider-reassign.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/providers/codex-history-hooks.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/providers/force-detach.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/providers/proxy-guard.js` | server.js | `src/native/binding.js`, `src/providers/proxy-stall-watch.js` | — | `async_hooks` | — | — |
| `src/providers/proxy-stall-watch.js` | server.js | `src/native/binding.js` | — | `perf_hooks` | — | — |
| `src/providers/router-port.js` | server.js | `src/claude-auth/proxy-recovery.js`, `src/native/binding.js`, `src/providers/proxy-guard.js` | — | `crypto`, `path` | — | — |
| `src/providers/router-runtime.js` | server.js | `src/cli-key-accounts.js`, `src/native/binding.js`, `src/providers/router-port.js`, `src/providers/rust-cpr.js` | — | `path` | `cli-provider-router` | — |
| `src/providers/rust-cpr.js` | server.js | `src/native/binding.js` | — | `crypto`, `path` | `cli-provider-router` | `17 require(path.join(cprRoot, 'proxy/request-hook'))`, `18 require(path.join(cprRoot, 'proxy/hop-credentials'))` |
| `src/push/bark-devices.js` | server.js | `src/native/binding.js` | — | `crypto`, `fs`, `http`, `https` | — | — |
| `src/push/business.js` | server.js | `src/native/binding.js` | — | `crypto`, `fs` | — | — |
| `src/push/channel-subscriptions.js` | server.js | `src/native/binding.js` | — | `crypto`, `fs` | — | — |
| `src/push/fcm-devices.js` | server.js | `src/native/binding.js` | — | `crypto`, `fs` | — | — |
| `src/push/fcm-transport.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/push/runtime.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/push/service.js` | server.js | `src/native/binding.js`, `src/push/bark-devices.js`, `src/push/business.js`, `src/push/channel-subscriptions.js`, `src/push/fcm-devices.js` | — | `fs`, `http`, `https` | `web-push` | — |
| `src/quota-managed-browser.js` | server.js | `src/chrome-cdp.js` | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/quota/opencode-zen.js` | server.js | `src/native/binding.js` | — | `fs`, `os`, `path` | — | — |
| `src/repo-actor/index.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/request-locality.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/router-tool-host.js` | server.js | `src/native/binding.js`, `src/router-tool-runtime.js`, `src/secrets-vault.js` | `scripts/multicc-router-mcp.js` | `path` | — | — |
| `src/router-tool-runtime.js` | server.js | `src/native/binding.js` | — | `crypto` | — | — |
| `src/routes/account-routes-host.js` | server.js | `src/cli-key-accounts.js`, `src/native/binding.js` | — | `fs`, `os`, `path` | — | — |
| `src/routes/agent-resources.js` | server.js | — | — | — | — | — |
| `src/routes/aliyun-quota.js` | server.js | `src/quota-managed-browser.js`, `src/routes/kimi-quota.js` | — | — | — | — |
| `src/routes/ark-quota.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/routes/auth.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/aux-goal.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/chat-history/index.js` | server.js | `src/chat/opencode-context.js`, `src/cli-switch.js`, `src/native/binding.js` | — | `crypto` | — | — |
| `src/routes/claude-accounts.js` | server.js | `src/native/binding.js`, `src/network/egress-fetch.js` | — | — | — | — |
| `src/routes/claude-oauth.js` | server.js | — | — | — | — | — |
| `src/routes/claude-usage-quota.js` | server.js | `src/chrome-cdp.js`, `src/claude-auth/account-credentials.js`, `src/native/binding.js`, `src/quota-managed-browser.js` | — | — | — | — |
| `src/routes/cli-switch-host.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/codex-accounts.js` | server.js | `src/codex-auth/official-oauth.js`, `src/native/binding.js`, `src/network/egress-fetch.js` | — | — | — | — |
| `src/routes/codex-quota.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/developer-tools.js` | server.js | `src/native/binding.js` | — | `child_process` | — | — |
| `src/routes/directory-host.js` | server.js | `src/native/binding.js` | — | `crypto`, `path` | — | — |
| `src/routes/events-host.js` | server.js | `src/annotation-live.js`, `src/native/binding.js` | — | `crypto` | — | — |
| `src/routes/file-transfer-host.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/host-ops-host.js` | server.js | `src/native/binding.js`, `src/routes/developer-tools.js`, `src/routes/host-write.js`, `src/routes/macos-privacy.js`, `src/routes/ops-terminal.js` | — | — | — | — |
| `src/routes/host-power.js` | server.js | `src/native/binding.js` | — | `fs`, `os`, `path` | — | — |
| `src/routes/host-read-host.js` | server.js | `src/native/binding.js`, `src/routes/host-power.js` | — | — | — | — |
| `src/routes/host-write.js` | server.js | `src/native/binding.js`, `src/routes/host-power.js` | — | — | — | — |
| `src/routes/kimi-auth.js` | server.js | `src/native/binding.js`, `src/quota-managed-browser.js` | — | — | — | — |
| `src/routes/kimi-quota.js` | server.js | `src/native/binding.js`, `src/quota-managed-browser.js` | — | — | — | — |
| `src/routes/macos-privacy.js` | server.js | `src/directories.js`, `src/native/binding.js` | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/routes/opencode-quota.js` | server.js | `src/chrome-cdp.js`, `src/quota-managed-browser.js`, `src/quota/opencode-zen.js` | — | — | — | — |
| `src/routes/ops-terminal.js` | server.js | `src/native/binding.js` | — | `child_process` | — | — |
| `src/routes/orchestration-host.js` | server.js | `src/native/binding.js`, `src/routes/host-ops-host.js`, `src/unattended/native-host.js` | — | — | — | — |
| `src/routes/orchestration.js` | server.js | — | — | — | — | — |
| `src/routes/plugins-host.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/provider-balance-host.js` | server.js | `src/claude-auth/account-credentials.js`, `src/native/binding.js` | — | — | — | — |
| `src/routes/providers-host.js` | server.js | `src/native/binding.js`, `src/provider-reassign.js`, `src/providers/force-detach.js` | — | — | — | — |
| `src/routes/providers.js` | server.js | `src/native/binding.js`, `src/routes/providers-host.js`, `src/routes/subagent-defaults-host.js` | — | — | — | — |
| `src/routes/push-host.js` | server.js | `src/native/binding.js`, `src/push/bark-devices.js`, `src/push/business.js`, `src/push/channel-subscriptions.js` | — | — | — | — |
| `src/routes/qoder-quota.js` | server.js | `src/chrome-cdp.js`, `src/native/binding.js`, `src/quota-managed-browser.js` | — | `fs`, `os`, `path` | — | — |
| `src/routes/quota-host.js` | server.js | `src/native/binding.js`, `src/pricing/price-table.js`, `src/quota-managed-browser.js`, `src/routes/aliyun-quota.js`, `src/routes/claude-usage-quota.js`, `src/routes/codex-quota.js`, `src/routes/kimi-quota.js`, `src/routes/opencode-quota.js`, `src/routes/qoder-quota.js` | — | `child_process` | — | — |
| `src/routes/release-history-host.js` | server.js | `src/ios-udid.js`, `src/native/binding.js` | — | `http` | — | — |
| `src/routes/secrets-vault-host.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/server-core-host.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/server-restart-route.js` | server.js | `src/server-restart.js` | — | — | — | — |
| `src/routes/session-admin-host.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/session-admin.js` | server.js | `src/native/binding.js`, `src/routes/orchestration-host.js`, `src/routes/session-admin-host.js`, `src/routes/task-goal.js`, `src/session/query-service.js`, `src/session/workspace-service.js` | — | — | — | — |
| `src/routes/session-bundle.js` | server.js | `src/native/binding.js`, `src/session/handoff-env.js` | — | `child_process`, `crypto`, `fs`, `os`, `path`, `util` | `express` | `771 require(file.zipRef)`, `779 require(file.zipRef)`, `782 require(zipPayload.gitBundleZip.zipRef)` |
| `src/routes/session-create.js` | server.js | `src/cli-key-accounts.js`, `src/native/binding.js`, `src/routes/account-routes-host.js` | — | `crypto` | — | — |
| `src/routes/session-git-host.js` | server.js | `src/native/binding.js` | — | `path` | — | — |
| `src/routes/session-git.js` | server.js | `src/native/binding.js`, `src/routes/session-git-host.js` | — | `path` | — | — |
| `src/routes/session-lifecycle.js` | server.js | `src/chat/codex-rollout-guard.js`, `src/native/binding.js` | — | — | — | — |
| `src/routes/session-profile.js` | server.js | `src/cli-key-accounts.js`, `src/native/binding.js` | — | `crypto`, `fs`, `path` | — | — |
| `src/routes/session-routes-host.js` | server.js | `src/native/binding.js` | — | `crypto` | — | — |
| `src/routes/share-machines-host.js` | server.js | `src/native/binding.js`, `src/routes/share.js` | — | — | — | — |
| `src/routes/share.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/subagent-defaults-host.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/task-goal.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/task-graph.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/task-routes-host.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/task-search.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/token-usage.js` | server.js | `src/codex/usage.js`, `src/native/binding.js` | — | — | — | — |
| `src/routes/update-route.js` | server.js | `src/routes/release-history-host.js`, `src/update-runner.js` | — | — | — | — |
| `src/routes/voice-gateway-proxy.js` | server.js | `src/native/binding.js` | — | `http` | — | — |
| `src/routes/voice.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/routes/zcode-auth.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/runtime-homes-janitor.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/search/index-store.js` | server.js | `src/native/binding.js`, `src/sqlite/driver.js` | — | `crypto`, `fs`, `path` | — | — |
| `src/search/message-corpus.js` | server.js | `src/search/index-store.js` | — | `crypto`, `fs` | — | — |
| `src/search/runtime.js` | server.js | `src/native/binding.js`, `src/search/index-store.js`, `src/search/message-corpus.js`, `src/search/slice-runner.js` | — | `path` | — | — |
| `src/search/slice-runner.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/secret-tools.js` | server.js | `src/native/binding.js` | — | `child_process`, `fs` | — | — |
| `src/secrets-vault.js` | server.js | `src/native/binding.js` | — | `crypto`, `fs`, `path` | — | — |
| `src/server-processes.js` | server.js | — | — | `child_process`, `fs`, `path` | — | — |
| `src/server-restart.js` | server.js | `src/native/binding.js` | — | `child_process`, `crypto`, `fs`, `net`, `path` | — | — |
| `src/session-work/index.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/session/chat-history-service/index.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/session/handoff-env.js` | server.js | — | — | `fs`, `os`, `path` | — | — |
| `src/session/hibernation-composition.js` | server.js | `src/native/binding.js`, `src/session/hibernation.js` | — | `fs` | — | — |
| `src/session/hibernation.js` | server.js | `src/native/binding.js` | — | `fs`, `os`, `path` | — | — |
| `src/session/query-service.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/session/workspace-service.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/share.js` | server.js | `src/native/binding.js` | — | `crypto`, `fs` | — | — |
| `src/shutdown.js` | server.js | — | — | — | — | — |
| `src/skill-converter.js` | server.js | — | — | `fs`, `os`, `path` | — | — |
| `src/skill-sync/index.js` | server.js | `src/cdpd.js`, `src/native/binding.js` | — | — | — | — |
| `src/skills.js` | server.js | `src/native/binding.js` | — | `fs`, `os`, `path` | — | — |
| `src/sqlite/driver.js` | server.js | — | — | `fs`, `path` | — | `74 require(file)` |
| `src/state/container.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/tailscale-funnel-health.js` | server.js | — | — | `crypto`, `http`, `https`, `net` | — | — |
| `src/task-board/core/index.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/task-board/lifecycle-host.js` | server.js | `src/native/binding.js` | — | `fs` | — | — |
| `src/task-board/routing.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/task-context-host.js` | server.js | `src/native/binding.js`, `src/unattended/native-host.js` | — | — | — | — |
| `src/task-routing/code-revision.js` | server.js | `src/native/binding.js` | — | `crypto`, `fs/promises`, `path` | — | — |
| `src/task-routing/delivery-view.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/task-routing/evidence.js` | server.js | `src/native/binding.js`, `src/task-routing/code-revision.js` | — | `crypto`, `fs`, `path` | — | — |
| `src/task-routing/facts.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/task-shell/artifacts.js` | server.js | `src/native/binding.js` | — | `fs`, `path` | — | — |
| `src/task-shell/attribution-decisions.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/task-shell/chat-history.js` | server.js | `src/routes/chat-history/index.js` | — | — | — | — |
| `src/task-shell/context-plan.js` | server.js | `src/cli-switch.js`, `src/native/binding.js` | — | — | — | — |
| `src/task-shell/history-context.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/task-shell/host.js` | server.js | `src/native/binding.js`, `src/task-shell/artifacts.js`, `src/task-shell/attribution-decisions.js`, `src/task-shell/chat-history.js`, `src/task-shell/runtime.js`, `src/task-shell/store.js`, `src/task-shell/task-index.js`, `src/task-shell/task-operations.js`, `src/task-shell/workspace.js`, `src/workspace/separation-transfer.js` | — | `child_process`, `crypto`, `util` | — | — |
| `src/task-shell/independent-continue.js` | server.js | `src/native/binding.js`, `src/task-shell/history-context.js` | — | — | — | — |
| `src/task-shell/migration-page-worker.js` | 宿主脚本路径 | `src/native/binding.js` | — | `fs`, `http`, `worker_threads` | — | — |
| `src/task-shell/role-bindings.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/task-shell/runtime.js` | server.js | `src/native/binding.js`, `src/task-shell/context-plan.js`, `src/task-shell/history-context.js`, `src/task-shell/independent-continue.js`, `src/task-shell/role-bindings.js`, `src/task-shell/separation.js`, `src/task-shell/task-actions.js`, `src/task-shell/task-first.js` | — | `crypto` | — | — |
| `src/task-shell/separation.js` | server.js | `src/native/binding.js`, `src/task-shell/history-context.js` | — | — | — | — |
| `src/task-shell/store.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/task-shell/task-actions.js` | server.js | `src/native/binding.js`, `src/task-shell/history-context.js` | — | — | — | — |
| `src/task-shell/task-first.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/task-shell/task-graph-context.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/task-shell/task-index.js` | server.js | `src/native/binding.js`, `src/task-shell/chat-history.js` | — | — | — | — |
| `src/task-shell/task-operations.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/task-shell/workspace.js` | server.js | `src/cli-switch.js`, `src/native/binding.js` | — | `fs` | — | — |
| `src/tmux.js` | server.js | `src/native/binding.js` | — | `child_process`, `fs`, `net`, `os`, `path` | — | — |
| `src/triggers/index.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/tunnel-sakurafrp-api.js` | server.js | — | — | `fs`, `os`, `path` | — | — |
| `src/tunnel-sakurafrp.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/tunnel/index.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/turn-ledger/hook-install.js` | server.js | — | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/turn-ledger/ledger.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/turn-ledger/runtime.js` | server.js | `src/native/binding.js`, `src/turn-ledger/hook-install.js`, `src/turn-ledger/ledger.js` | — | `fs`, `os`, `path` | — | — |
| `src/unattended/native-host.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/unattended/runtime.js` | server.js | `src/unattended/native-host.js` | — | — | — | — |
| `src/update-runner.js` | server.js | `src/native/binding.js`, `src/windows-standalone-update.js` | — | `fs`, `path` | — | — |
| `src/upload-middleware.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/voice/acp-bridge.js` | 宿主脚本路径 | `src/native/binding.js` | — | `crypto` | `ws` | — |
| `src/voice/asr-local.js` | server.js | `src/native/binding.js` | — | `child_process`, `fs`, `os`, `path` | `sherpa-onnx-node` | — |
| `src/voice/host.js` | server.js | `src/native/binding.js`, `src/routes/voice-gateway-proxy.js`, `src/routes/voice.js`, `src/voice/asr-local.js`, `src/voice/qwen-audio-installer.js`, `src/voice/qwen-audio-supervisor.js` | `src/voice/multicc-acp-agent.mjs` | `path` | — | — |
| `src/voice/multicc-acp-agent.mjs` | 宿主脚本路径 | `src/voice/acp-bridge.js` | — | `stream` | `@agentclientprotocol/sdk` | — |
| `src/voice/qwen-audio-installer.js` | server.js | `src/native/binding.js` | — | `child_process`, `crypto`, `fs`, `path` | — | — |
| `src/voice/qwen-audio-supervisor.js` | server.js | `src/native/binding.js` | — | `child_process`, `crypto`, `fs`, `net`, `path` | — | — |
| `src/voice/router.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/voice/tts-service.js` | server.js | `src/native/binding.js` | — | `child_process`, `https` | `ws` | — |
| `src/wait/injector.js` | server.js | `src/native/binding.js` | — | `crypto` | — | — |
| `src/wait/service.js` | server.js | `src/native/binding.js` | — | `crypto` | — | — |
| `src/windows-standalone-update.js` | server.js | — | — | `child_process`, `fs`, `os`, `path` | — | — |
| `src/workspace/admission.js` | server.js | `src/native/binding.js`, `src/task-routing/code-revision.js`, `src/task-routing/evidence.js`, `src/task-shell/role-bindings.js`, `src/task-shell/store.js`, `src/workspace/registry.js`, `src/workspace/writer-escalation.js` | — | `child_process`, `crypto`, `fs`, `path`, `util` | — | — |
| `src/workspace/air-routes.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/workspace/inventory.js` | 工作区运维脚本 | `src/native/binding.js` | — | `crypto`, `path` | — | — |
| `src/workspace/orphan-scan.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
| `src/workspace/registry.js` | server.js | — | — | `crypto` | — | — |
| `src/workspace/runtime.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/workspace/separation-transfer.js` | server.js | `src/native/binding.js` | — | — | — | — |
| `src/workspace/writer-escalation.js` | server.js | `src/server-processes.js` | — | — | — | — |
| `src/ws/connection-router.js` | server.js | `src/native/binding.js` | — | `crypto` | `ws` | — |
| `src/ws/native-queue.js` | 未从已知入口静态到达 | `src/native/binding.js` | — | — | — | — |
