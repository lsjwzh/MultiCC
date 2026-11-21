# 第三批迁移前 Node 后端文件清单

基线：`b20db3115045168ec0a64b6c8b0a636eea504adc`。共 612 个文件、139099 个物理行；静态可从 `server.js` 到达 595 个文件。

server.js、ecosystem.config.js、scripts/start-gateway.js、src/ 和 plugins/ 下全部已跟踪 JS/CJS/MJS 候选文件（排除插件 tests/extension/ui）；调用关系为相对路径 require/import 的静态解析，条件入口包含在内，动态加载另列。

生产入口仍包含 `server.js`、Rust 网关的 Node 子进程监督和转发、各 `/api/__host/*` 端口、聊天 WS 桥、CLI 常驻流与进程桥。公开路由及条件插件入口继续参照 [运行时登记](../backend-runtime-inventory.md)。静态到达不证明功能开启或文件可以删除，动态依赖和启动条件须随每个模块验收。

## 本批关键保留文件与调用方

| 文件 | 行数 | 静态调用方 |
| --- | ---: | --- |
| `src/task-shell/runtime.js` | 712 | `src/task-shell/host.js` |
| `src/task-shell/host.js` | 553 | `server.js` |
| `src/session-work/scheduler.js` | 908 | `src/orchestration/runtime.js`, `src/routes/task-board.js`, `src/session-work/host.js` |

## Codex 子批后的同口径盘点

七个独立模块完成后，候选文件剩余 **604 个、137,518 行**，相对基线净减八个文件、1,581 行。后面的分目录和完整表仍是迁移前的固定基线，用于核对删除来源；迁移后的完整 JSON 清单、最新行数和静态调用方在主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/node-files-after-codex-sub-batch.json`，随 Codex 子批收据登记。

| 已退出的生产文件 | 基线行数 |
| --- | ---: |
| `src/chat/provider-invocation.js` | 226 |
| `src/chat/auto-provider-selection-key.js` | 10 |
| `src/chat/auto-provider-handoff.js` | 91 |
| `src/cli-adapters/claude.js` | 138 |
| `src/cli-adapters/codex.js` | 366 |
| `src/cli-adapters/codex-exp.js` | 265 |
| `src/cli-adapters/codex-background-events.cjs` | 275 |
| `src/cli-adapters/codex-app-server-bridge.cjs` | 343 |

以上原文件合计 1,714 行；必要兼容接线净增加 133 行，因此后端净减为 1,581 行。旧实现仅保留在测试路径作为冻结对照，不作为生产入口。关键保留文件及调用方与上表一致：任务壳 runtime、host 和 session-work scheduler 分别仍为 712、553、908 行。

## 分目录统计

| 目录 | 文件数 | 行数 |
| --- | ---: | ---: |
| `ecosystem.config.js` | 1 | 36 |
| `plugins/bridges` | 9 | 2795 |
| `plugins/chrome-proxy-launcher` | 1 | 39 |
| `plugins/cron` | 2 | 990 |
| `plugins/utils` | 2 | 328 |
| `plugins/voice` | 1 | 414 |
| `scripts` | 1 | 57 |
| `server.js` | 1 | 3080 |
| `src/annotation-live.js` | 1 | 107 |
| `src/api-contract.js` | 1 | 164 |
| `src/apk-distribution.js` | 1 | 420 |
| `src/artifact-reference.js` | 1 | 120 |
| `src/artifact-retention.js` | 1 | 79 |
| `src/artifacts.js` | 1 | 99 |
| `src/assist-snapshots.js` | 1 | 66 |
| `src/auth-security.js` | 1 | 64 |
| `src/aux-http.js` | 1 | 176 |
| `src/battery-guard.js` | 1 | 135 |
| `src/bootstrap` | 1 | 156 |
| `src/bus.js` | 1 | 18 |
| `src/cdp-relay.js` | 1 | 279 |
| `src/cdpd.js` | 1 | 264 |
| `src/chat` | 67 | 14381 |
| `src/chrome-cdp.js` | 1 | 439 |
| `src/classify` | 8 | 2944 |
| `src/claude-auth` | 8 | 2354 |
| `src/claude-models.js` | 1 | 96 |
| `src/cli` | 10 | 1796 |
| `src/cli-adapters` | 38 | 6490 |
| `src/cli-key-accounts.js` | 1 | 273 |
| `src/cli-switch.js` | 1 | 235 |
| `src/codex` | 13 | 3402 |
| `src/codex-auth` | 1 | 349 |
| `src/commander-migration.js` | 1 | 297 |
| `src/context` | 1 | 94 |
| `src/detached.js` | 1 | 265 |
| `src/directories.js` | 1 | 295 |
| `src/directory` | 5 | 342 |
| `src/dispatch` | 3 | 1088 |
| `src/docs-registry.js` | 1 | 494 |
| `src/doctor` | 5 | 962 |
| `src/events` | 8 | 1065 |
| `src/experiments` | 1 | 731 |
| `src/fleet-sharing.js` | 1 | 145 |
| `src/gateway-child.js` | 1 | 338 |
| `src/git` | 4 | 1313 |
| `src/host-battery.js` | 1 | 82 |
| `src/host-env.js` | 1 | 91 |
| `src/host-lifecycle.js` | 1 | 374 |
| `src/host-power-services.js` | 1 | 63 |
| `src/http` | 9 | 382 |
| `src/http-errors.js` | 1 | 147 |
| `src/ios-ota.js` | 1 | 194 |
| `src/ios-udid.js` | 1 | 190 |
| `src/lan-discovery.js` | 1 | 181 |
| `src/liveness` | 3 | 485 |
| `src/log-housekeeping.js` | 1 | 231 |
| `src/machines.js` | 1 | 119 |
| `src/macos-agent-build.js` | 1 | 67 |
| `src/macos-agent-provision.js` | 1 | 266 |
| `src/macos-unlock-password.js` | 1 | 78 |
| `src/macos-unlock-probe.js` | 1 | 96 |
| `src/memo` | 4 | 369 |
| `src/memory` | 5 | 1047 |
| `src/memory-store.js` | 1 | 299 |
| `src/message-composer.js` | 1 | 452 |
| `src/model-history-converter.js` | 1 | 377 |
| `src/native` | 5 | 320 |
| `src/network` | 6 | 499 |
| `src/network-policy.js` | 1 | 32 |
| `src/notes-store.js` | 1 | 138 |
| `src/notify-settings.js` | 1 | 46 |
| `src/observability.js` | 1 | 212 |
| `src/official-accounts-cli-login.js` | 1 | 121 |
| `src/official-accounts.js` | 1 | 369 |
| `src/operation-service.js` | 1 | 479 |
| `src/orchestration` | 6 | 3690 |
| `src/outbox.js` | 1 | 412 |
| `src/path-safety.js` | 1 | 62 |
| `src/paths.js` | 1 | 247 |
| `src/plugins` | 4 | 1443 |
| `src/portable-git.js` | 1 | 53 |
| `src/powerd.js` | 1 | 66 |
| `src/pricing` | 1 | 724 |
| `src/provider-error.js` | 1 | 34 |
| `src/provider-reassign.js` | 1 | 292 |
| `src/providers` | 31 | 7284 |
| `src/push` | 8 | 1503 |
| `src/quota` | 20 | 1935 |
| `src/quota-managed-browser.js` | 1 | 453 |
| `src/repo-actor.js` | 1 | 227 |
| `src/request-locality.js` | 1 | 16 |
| `src/role-token-tracker.js` | 1 | 200 |
| `src/router-tool-host.js` | 1 | 304 |
| `src/router-tool-runtime.js` | 1 | 1352 |
| `src/routes` | 95 | 24545 |
| `src/runtime-homes-janitor.js` | 1 | 90 |
| `src/runtime-security.js` | 1 | 46 |
| `src/search` | 6 | 1970 |
| `src/secret-audit.js` | 1 | 67 |
| `src/secret-tools.js` | 1 | 468 |
| `src/secrets-vault.js` | 1 | 225 |
| `src/server-processes.js` | 1 | 180 |
| `src/server-restart.js` | 1 | 257 |
| `src/services.js` | 1 | 27 |
| `src/session` | 23 | 3299 |
| `src/session-dto.js` | 1 | 170 |
| `src/session-work` | 2 | 2268 |
| `src/share.js` | 1 | 248 |
| `src/shutdown.js` | 1 | 236 |
| `src/skill-converter.js` | 1 | 636 |
| `src/skill-sync` | 1 | 513 |
| `src/skills.js` | 1 | 207 |
| `src/sqlite` | 1 | 190 |
| `src/sqlite-runtime.js` | 1 | 130 |
| `src/state` | 3 | 335 |
| `src/tailscale-funnel-health.js` | 1 | 496 |
| `src/task-board` | 18 | 2105 |
| `src/task-context-host.js` | 1 | 332 |
| `src/task-display-attribution.js` | 1 | 32 |
| `src/task-routing` | 6 | 568 |
| `src/task-shell` | 25 | 4551 |
| `src/task-worktree.js` | 1 | 227 |
| `src/tmux.js` | 1 | 198 |
| `src/triggers` | 1 | 467 |
| `src/tunnel-sakurafrp-api.js` | 1 | 170 |
| `src/tunnel-sakurafrp.js` | 1 | 127 |
| `src/tunnel.js` | 1 | 1234 |
| `src/turn-ledger` | 5 | 833 |
| `src/unattended` | 4 | 1757 |
| `src/update-runner.js` | 1 | 515 |
| `src/upload-middleware.js` | 1 | 150 |
| `src/upstream-error.js` | 1 | 147 |
| `src/usage-limit-poller.js` | 1 | 317 |
| `src/usage-observed.js` | 1 | 93 |
| `src/voice` | 17 | 5274 |
| `src/wait` | 2 | 632 |
| `src/windows-env.js` | 1 | 276 |
| `src/workspace` | 18 | 3362 |
| `src/ws` | 4 | 952 |

## 全部文件与静态调用方

| 文件 | 行数 | 静态调用方 |
| --- | ---: | --- |
| `ecosystem.config.js` | 36 | 未发现静态内部调用方 |
| `plugins/bridges/discord-bridge.js` | 301 | `server.js` |
| `plugins/bridges/feishu-bridge.js` | 351 | `server.js` |
| `plugins/bridges/gateway-core.js` | 380 | `plugins/bridges/discord-bridge.js`, `plugins/bridges/feishu-bridge.js`, `plugins/bridges/slack-bridge.js`, `plugins/bridges/telegram-bridge.js`, `plugins/bridges/wechat-ilink.js` |
| `plugins/bridges/secure-config.js` | 33 | `plugins/bridges/discord-bridge.js`, `plugins/bridges/feishu-bridge.js`, `plugins/bridges/slack-bridge.js`, `plugins/bridges/telegram-bridge.js`, `plugins/bridges/wechat-bridge.js`, `plugins/bridges/wechat-ilink.js` |
| `plugins/bridges/slack-bridge.js` | 365 | `server.js` |
| `plugins/bridges/telegram-bridge.js` | 271 | `server.js` |
| `plugins/bridges/telegram-client-adapter.js` | 121 | `plugins/bridges/telegram-bridge.js` |
| `plugins/bridges/wechat-bridge.js` | 435 | 未发现静态内部调用方 |
| `plugins/bridges/wechat-ilink.js` | 538 | `server.js` |
| `plugins/chrome-proxy-launcher/src/dock_badge_macos.js` | 39 | 未发现静态内部调用方 |
| `plugins/cron/cron-tasks.js` | 726 | `server.js` |
| `plugins/cron/fanout-migration.js` | 264 | `plugins/cron/cron-tasks.js` |
| `plugins/utils/git-push.js` | 141 | `server.js` |
| `plugins/utils/macos-power.js` | 187 | `server.js` |
| `plugins/voice/voice-asr.js` | 414 | `server.js` |
| `scripts/start-gateway.js` | 57 | 未发现静态内部调用方 |
| `server.js` | 3080 | 未发现静态内部调用方 |
| `src/annotation-live.js` | 107 | `src/routes/events-host.js` |
| `src/api-contract.js` | 164 | `server.js`, `src/http-errors.js`, `src/http/error-presenter.js`, `src/workspace/runtime.js` |
| `src/apk-distribution.js` | 420 | `server.js` |
| `src/artifact-reference.js` | 120 | `src/artifact-retention.js`, `src/artifacts.js`, `src/docs-registry.js`, `src/task-shell/artifacts.js` |
| `src/artifact-retention.js` | 79 | `src/docs-registry.js` |
| `src/artifacts.js` | 99 | `server.js`, `src/docs-registry.js`, `src/task-shell/artifacts.js` |
| `src/assist-snapshots.js` | 66 | `server.js` |
| `src/auth-security.js` | 64 | `server.js`, `src/share.js` |
| `src/aux-http.js` | 176 | `server.js`, `src/doctor/llm-loop.js` |
| `src/battery-guard.js` | 135 | `server.js` |
| `src/bootstrap/state.js` | 156 | `server.js` |
| `src/bus.js` | 18 | `server.js`, `src/dispatch/gateway-host.js` |
| `src/cdp-relay.js` | 279 | `src/chrome-cdp.js` |
| `src/cdpd.js` | 264 | `src/cdp-relay.js`, `src/skill-sync/index.js` |
| `src/chat/adapter-completion.js` | 43 | `src/chat/turn-engine.js` |
| `src/chat/admission-progress.js` | 125 | `src/chat/auto-provider-runtime.js`, `src/chat/turn-engine.js` |
| `src/chat/api-error-host.js` | 444 | `src/chat/index.js` |
| `src/chat/api-error-policy.js` | 293 | `src/chat/admission-progress.js`, `src/chat/api-error-host.js`, `src/chat/claude-api-error-message.js`, `src/chat/index.js`, `src/chat/provider-log-watchdog.js`, `src/chat/retry-policy.js`, `src/classify/vocab.js`, `src/push/runtime.js` |
| `src/chat/auto-provider-handoff.js` | 91 | `src/chat/turn-engine.js` |
| `src/chat/auto-provider-policy.js` | 144 | `src/chat/auto-provider-runtime.js` |
| `src/chat/auto-provider-pricing.js` | 110 | `src/chat/auto-provider-runtime.js` |
| `src/chat/auto-provider-routing.js` | 198 | `src/chat/auto-provider-runtime.js` |
| `src/chat/auto-provider-runtime.js` | 515 | `src/chat/turn-engine.js` |
| `src/chat/auto-provider-selection-key.js` | 10 | `src/chat/auto-provider-runtime.js`, `src/chat/auto-route-notes.js`, `src/cli/switch-runtime.js`, `src/routes/session-profile.js` |
| `src/chat/auto-route-notes.js` | 172 | `src/chat/turn-engine.js` |
| `src/chat/background-hold.js` | 143 | `src/chat/chat-stream.js`, `src/chat/claude-sdk-stream.js`, `src/chat/held-turn-injection.js`, `src/cli-adapters/zcode-bridge.cjs` |
| `src/chat/background-task-runtime.js` | 170 | `server.js` |
| `src/chat/chat-stream.js` | 806 | `server.js`, `src/chat/turn-engine.js` |
| `src/chat/claude-api-error-message.js` | 132 | `src/chat/turn-engine.js` |
| `src/chat/claude-sdk-config.js` | 64 | `src/chat/claude-sdk-stream.js` |
| `src/chat/claude-sdk-route.js` | 132 | `src/chat/claude-sdk-config.js`, `src/chat/claude-sdk-stream.js` |
| `src/chat/claude-sdk-stream.js` | 677 | `src/chat/chat-stream.js` |
| `src/chat/codex-app-stream.js` | 637 | `src/chat/chat-stream.js` |
| `src/chat/codex-rollout-guard.js` | 157 | `src/chat/turn-engine.js`, `src/routes/session-lifecycle.js` |
| `src/chat/error-persistence.js` | 98 | `server.js` |
| `src/chat/finalize-host.js` | 93 | `src/chat/index.js` |
| `src/chat/finalize-plan.js` | 63 | `src/chat/index.js` |
| `src/chat/held-turn-injection.js` | 149 | `server.js`, `src/chat/turn-engine.js` |
| `src/chat/history-frame-budget.js` | 86 | `src/chat/turn-engine.js` |
| `src/chat/host-coordinator.js` | 628 | `server.js`, `src/chat/host-runtime.js`, `src/chat/index.js`, `src/chat/turn-engine.js` |
| `src/chat/host-prompts.js` | 164 | `server.js`, `src/chat/turn-engine.js` |
| `src/chat/host-runtime.js` | 312 | `src/chat/index.js` |
| `src/chat/index.js` | 18 | `server.js`, `src/chat/turn-engine.js` |
| `src/chat/managed-context.js` | 34 | `src/chat/turn-engine.js` |
| `src/chat/missing-resume-recovery.js` | 101 | `src/chat/chat-stream.js`, `src/chat/claude-sdk-stream.js`, `src/cli-adapters/claude-exp-history.js` |
| `src/chat/model-request-policy.js` | 22 | `src/chat/provider-invocation.js` |
| `src/chat/model-timeout-recovery.js` | 34 | `server.js` |
| `src/chat/monitor-admission.js` | 54 | `src/chat/chat-stream.js`, `src/chat/claude-sdk-stream.js`, `src/chat/monitor-control.js` |
| `src/chat/monitor-control.js` | 41 | `src/chat/chat-stream.js` |
| `src/chat/native-session-guard.js` | 123 | `src/chat/turn-engine.js` |
| `src/chat/native-session-state.js` | 27 | `src/chat/turn-engine.js` |
| `src/chat/opencode-context-guard.js` | 61 | `src/chat/turn-engine.js` |
| `src/chat/opencode-context.js` | 42 | `src/chat/opencode-context-guard.js`, `src/cli-adapters/acp-bridge.cjs`, `src/routes/chat-history.js` |
| `src/chat/ports.js` | 24 | `src/chat/index.js` |
| `src/chat/post-turn-router.js` | 111 | `src/chat/host-coordinator.js`, `src/chat/index.js` |
| `src/chat/process-close.js` | 44 | `src/chat/chat-stream.js`, `src/chat/codex-app-stream.js` |
| `src/chat/process-spawn-args.js` | 15 | `src/chat/turn-engine.js` |
| `src/chat/process-watchdog.js` | 167 | `server.js` |
| `src/chat/provider-attempt-runtime.js` | 451 | `src/chat/index.js`, `src/chat/provider-invocation.js`, `src/chat/turn-engine.js`, `src/task-context-host.js` |
| `src/chat/provider-invocation.js` | 226 | `src/chat/index.js`, `src/chat/turn-engine.js` |
| `src/chat/provider-log-watchdog.js` | 324 | `server.js` |
| `src/chat/proxy-broadcast.js` | 173 | `server.js` |
| `src/chat/resident-composition.js` | 35 | `server.js` |
| `src/chat/resident-pool.js` | 167 | `src/chat/resident-composition.js` |
| `src/chat/retry-policy.js` | 87 | `src/chat/index.js` |
| `src/chat/runtime-store.js` | 65 | `src/chat/index.js` |
| `src/chat/session-notices.js` | 136 | `server.js`, `src/chat/turn-engine.js` |
| `src/chat/sessions.js` | 98 | `server.js`, `src/routes/server-core-host.js` |
| `src/chat/stalled-turn-recovery.js` | 239 | `server.js` |
| `src/chat/stream-router.js` | 177 | `src/chat/chat-stream.js` |
| `src/chat/task-state-payload.js` | 45 | `src/chat/task-state-seed.js`, `src/routes/task-state-store.js` |
| `src/chat/task-state-seed.js` | 27 | `src/chat/turn-engine.js` |
| `src/chat/transcript-prune.js` | 64 | `src/chat/turn-engine.js`, `src/routes/chat-history.js` |
| `src/chat/turn-engine.js` | 2985 | `server.js` |
| `src/chat/turn-event-journal.js` | 200 | `server.js` |
| `src/chat/turn-event-replay.js` | 145 | `src/chat/turn-engine.js` |
| `src/chat/turn-lifecycle.js` | 360 | `src/chat/host-coordinator.js`, `src/chat/index.js` |
| `src/chat/turn-progress.js` | 404 | `server.js`, `src/chat/finalize-host.js`, `src/chat/host-runtime.js`, `src/chat/turn-engine.js`, `src/codex/usage.js`, `src/liveness/runtime.js` |
| `src/chat/turn-request.js` | 221 | `src/chat/index.js`, `src/chat/provider-invocation.js` |
| `src/chat/usage-limit-wiring.js` | 116 | `server.js` |
| `src/chat/workspace-residency.js` | 62 | `src/chat/stream-router.js` |
| `src/chrome-cdp.js` | 439 | `src/quota-managed-browser.js`, `src/routes/claude-usage-quota.js`, `src/routes/opencode-quota.js`, `src/routes/qoder-quota.js` |
| `src/classify/aux-run-log.js` | 223 | `src/routes/aux-runs.js` |
| `src/classify/aux-verdict-health.js` | 81 | `server.js`, `src/chat/task-state-payload.js`, `src/routes/session-admin.js`, `src/routes/session-profile.js` |
| `src/classify/history-backtest.js` | 93 | 未发现静态内部调用方 |
| `src/classify/state-machine.js` | 1765 | `server.js` |
| `src/classify/task-attribution.js` | 434 | `src/classify/history-backtest.js`, `src/classify/state-machine.js` |
| `src/classify/task-short-code.js` | 167 | `server.js`, `src/chat/task-state-payload.js`, `src/chat/turn-engine.js`, `src/classify/state-machine.js`, `src/dispatch/targeting.js`, `src/routes/session-admin.js`, `src/routes/session-profile.js` |
| `src/classify/turn-state.js` | 22 | `src/classify/state-machine.js`, `src/turn-ledger/ledger.js` |
| `src/classify/vocab.js` | 159 | `server.js`, `src/chat/process-watchdog.js`, `src/chat/stalled-turn-recovery.js`, `src/classify/state-machine.js`, `src/events/hub.js`, `src/orchestration/runtime.js`, `src/plugins/channel-registry.js`, `src/push/notification-copy.js`, `src/push/runtime.js`, `src/routes/session-admin-host.js`, `src/routes/session-admin.js`, `src/routes/session-profile.js`, `src/routes/task-board.js`, `src/routes/task-goal.js`, `src/session-work/host.js`, `src/session-work/scheduler.js`, `src/task-board/lifecycle-host.js`, `src/task-board/normalize.js`, `src/task-board/retention.js`, `src/task-shell/host.js`, `src/turn-ledger/ledger.js`, `src/workspace/air-routes-host.js`, `src/workspace/inventory.js` |
| `src/claude-auth/account-credentials.js` | 187 | `server.js`, `src/routes/claude-usage-quota.js`, `src/routes/provider-balance-host.js` |
| `src/claude-auth/accounts-refresh.js` | 449 | `server.js` |
| `src/claude-auth/egress-agent.js` | 152 | `server.js`, `src/codex/model-catalog.js`, `src/network/egress-fetch.js` |
| `src/claude-auth/expired-refresh-policy.js` | 31 | `src/claude-auth/accounts-refresh.js`, `src/claude-auth/oauth-refresh.js` |
| `src/claude-auth/oauth-refresh.js` | 872 | `server.js`, `src/chat/api-error-host.js`, `src/claude-auth/accounts-refresh.js` |
| `src/claude-auth/official-oauth.js` | 391 | `src/official-accounts-cli-login.js`, `src/quota/claude-cli-oauth.js`, `src/routes/claude-accounts.js`, `src/routes/claude-usage-quota.js` |
| `src/claude-auth/proxy-recovery.js` | 176 | `src/providers/router-port.js` |
| `src/claude-auth/refresh-health.js` | 96 | `server.js` |
| `src/claude-models.js` | 96 | `src/cli/session-policy.js`, `src/routes/providers-host.js` |
| `src/cli-adapters/acp-bridge.cjs` | 469 | 未发现静态内部调用方 |
| `src/cli-adapters/acp.js` | 238 | `src/cli-adapters/agy.js`, `src/cli-adapters/grok.js`, `src/cli-adapters/opencode.js` |
| `src/cli-adapters/agy.js` | 22 | `src/cli-adapters/index.js` |
| `src/cli-adapters/claude-agent-sdk-bridge.mjs` | 186 | 未发现静态内部调用方 |
| `src/cli-adapters/claude-exp-history.js` | 27 | `src/chat/turn-engine.js` |
| `src/cli-adapters/claude.js` | 138 | `src/cli-adapters/index.js` |
| `src/cli-adapters/codebuddy.js` | 111 | `src/cli-adapters/index.js` |
| `src/cli-adapters/codex-app-server-bridge.cjs` | 343 | 未发现静态内部调用方 |
| `src/cli-adapters/codex-background-events.cjs` | 275 | `src/chat/background-task-runtime.js`, `src/cli-adapters/codex-app-server-bridge.cjs` |
| `src/cli-adapters/codex-exp.js` | 265 | `src/cli-adapters/index.js` |
| `src/cli-adapters/codex-session-file.js` | 68 | `server.js` |
| `src/cli-adapters/codex.js` | 366 | `src/cli-adapters/codex-exp.js`, `src/cli-adapters/index.js` |
| `src/cli-adapters/command-code.js` | 64 | `src/cli-adapters/index.js` |
| `src/cli-adapters/commands.js` | 411 | `server.js`, `src/cli-adapters/index.js`, `src/cli-adapters/kimi-auth.js`, `src/cli/tools-host.js`, `src/codex/model-catalog.js`, `src/routes/codebuddy-models.js`, `src/routes/commandcode-models.js`, `src/routes/developer-tools.js`, `src/routes/grok-models.js`, `src/routes/ops-terminal.js`, `src/routes/qoder-models.js` |
| `src/cli-adapters/completion.js` | 50 | `src/chat/adapter-completion.js`, `src/chat/turn-engine.js`, `src/cli-adapters/acp.js`, `src/cli-adapters/codex-exp.js`, `src/cli-adapters/codex.js`, `src/cli-adapters/command-code.js`, `src/cli-adapters/dsh.js`, `src/cli-adapters/kimi.js`, `src/cli-adapters/pi.js`, `src/cli-adapters/result-completion.js`, `src/cli-adapters/step-completion.js` |
| `src/cli-adapters/core.js` | 34 | `src/cli-adapters/index.js` |
| `src/cli-adapters/dsh.js` | 171 | `src/cli-adapters/index.js` |
| `src/cli-adapters/grok.js` | 33 | `src/cli-adapters/index.js` |
| `src/cli-adapters/index.js` | 108 | `server.js` |
| `src/cli-adapters/kimi-auth.js` | 118 | `src/routes/kimi-auth.js`, `src/session-work/host.js` |
| `src/cli-adapters/kimi.js` | 179 | `src/cli-adapters/index.js` |
| `src/cli-adapters/opencode-error.js` | 12 | `src/chat/turn-engine.js` |
| `src/cli-adapters/opencode-like.js` | 122 | `src/cli-adapters/opencode.js` |
| `src/cli-adapters/opencode.js` | 97 | `src/cli-adapters/index.js` |
| `src/cli-adapters/pi-router-extension.mjs` | 116 | 未发现静态内部调用方 |
| `src/cli-adapters/pi.js` | 113 | `src/cli-adapters/index.js` |
| `src/cli-adapters/qoder.js` | 124 | `src/cli-adapters/index.js` |
| `src/cli-adapters/result-completion.js` | 22 | `src/chat/background-hold.js`, `src/chat/chat-stream.js`, `src/chat/claude-sdk-stream.js`, `src/cli-adapters/claude-agent-sdk-bridge.mjs`, `src/cli-adapters/claude.js`, `src/cli-adapters/codebuddy.js`, `src/cli-adapters/qoder.js` |
| `src/cli-adapters/router-mcp.js` | 152 | `src/cli-adapters/codebuddy.js`, `src/cli-adapters/kimi.js`, `src/cli-adapters/qoder.js`, `src/router-tool-host.js` |
| `src/cli-adapters/step-completion.js` | 20 | `src/cli-adapters/opencode-like.js`, `src/cli-adapters/zcode.js` |
| `src/cli-adapters/vendor-login.js` | 53 | `server.js`, `src/chat/api-error-host.js`, `src/routes/session-create.js` |
| `src/cli-adapters/zcode-app-server.js` | 390 | `src/cli-adapters/zcode-bridge.cjs` |
| `src/cli-adapters/zcode-auth.js` | 372 | `src/routes/zcode-auth.js`, `src/session-work/host.js` |
| `src/cli-adapters/zcode-bridge.cjs` | 943 | 未发现静态内部调用方 |
| `src/cli-adapters/zcode-engine.js` | 33 | `src/cli-adapters/commands.js`, `src/cli-adapters/zcode-auth.js`, `src/cli-adapters/zcode-bridge.cjs`, `src/cli-adapters/zcode-terminal.cjs` |
| `src/cli-adapters/zcode-session.js` | 29 | `src/cli-adapters/zcode-bridge.cjs`, `src/cli-adapters/zcode.js`, `src/cli-switch.js` |
| `src/cli-adapters/zcode-terminal.cjs` | 62 | 未发现静态内部调用方 |
| `src/cli-adapters/zcode.js` | 154 | `src/cli-adapters/index.js` |
| `src/cli-key-accounts.js` | 273 | `server.js`, `src/providers/router-runtime.js`, `src/routes/cli-key-accounts.js`, `src/routes/session-profile.js` |
| `src/cli-switch.js` | 235 | `server.js`, `src/chat/opencode-context-guard.js`, `src/chat/turn-engine.js`, `src/task-shell/context-snapshot.js`, `src/task-shell/workspace.js` |
| `src/cli/claude-bundled-binary.js` | 31 | `server.js`, `src/chat/claude-sdk-stream.js`, `src/cli-adapters/claude-agent-sdk-bridge.mjs`, `src/cli/tools-host.js` |
| `src/cli/cli-capability.js` | 254 | `server.js`, `src/chat/host-runtime.js`, `src/chat/provider-invocation.js`, `src/chat/turn-engine.js`, `src/chat/turn-request.js`, `src/cli-adapters/agy.js`, `src/cli-adapters/claude.js`, `src/cli-adapters/codex-exp.js`, `src/cli-adapters/codex.js`, `src/cli-adapters/command-code.js`, `src/cli-adapters/grok.js`, `src/cli-adapters/kimi.js`, `src/cli-adapters/opencode.js`, `src/cli-adapters/vendor-login.js`, `src/cli-adapters/zcode.js`, `src/cli-switch.js`, `src/cli/cli-upstream-version.js`, `src/cli/session-policy.js`, `src/cli/switch-runtime.js`, `src/cli/tools-host.js`, `src/codex/resident-route.js`, `src/providers/native-vendor.js`, `src/session-work/host.js` |
| `src/cli/cli-upstream-version.js` | 91 | `src/cli/tools-host.js` |
| `src/cli/homebrew-takeover.js` | 42 | `src/cli/tools-host.js` |
| `src/cli/model-default.js` | 12 | `src/cli/session-policy.js` |
| `src/cli/native-session-exists.js` | 188 | `src/cli/switch-runtime.js` |
| `src/cli/session-policy.js` | 498 | `server.js`, `src/chat/turn-engine.js` |
| `src/cli/switch-preparation.js` | 14 | `src/cli/switch-runtime.js` |
| `src/cli/switch-runtime.js` | 446 | `server.js`, `src/chat/turn-engine.js` |
| `src/cli/tools-host.js` | 220 | `src/cli/switch-runtime.js` |
| `src/codex-auth/official-oauth.js` | 349 | `src/routes/codex-accounts.js` |
| `src/codex/accounts-refresh.js` | 86 | `server.js` |
| `src/codex/attempt-home.js` | 589 | `src/providers/core.js` |
| `src/codex/image-bridge-runtime.js` | 30 | `server.js` |
| `src/codex/image-bridge.js` | 348 | `src/codex/image-bridge-runtime.js` |
| `src/codex/model-catalog.js` | 152 | `server.js`, `src/providers/core.js`, `src/routes/codex-accounts.js`, `src/routes/model-catalogs-host.js` |
| `src/codex/oauth-refresh.js` | 435 | `server.js`, `src/codex/accounts-refresh.js`, `src/codex/model-catalog.js` |
| `src/codex/official-relay.js` | 654 | `src/codex/image-bridge.js`, `src/codex/model-catalog.js`, `src/providers/core.js`, `src/providers/official-catalog.js`, `src/providers/router-port.js`, `src/providers/rust-cpr.js`, `src/routes/model-catalogs-host.js` |
| `src/codex/proxy-policy.js` | 32 | `src/codex/resident-route.js`, `src/providers/core.js` |
| `src/codex/proxy-trace.js` | 172 | `src/codex/official-relay.js`, `src/providers/proxy-guard.js`, `src/providers/router-port.js`, `src/routes/system-host.js` |
| `src/codex/rate-limit-windows.js` | 73 | `src/routes/codex-quota.js`, `src/usage-limit-poller.js` |
| `src/codex/resident-route.js` | 195 | `src/chat/codex-app-stream.js`, `src/providers/core.js` |
| `src/codex/session-home.js` | 330 | `src/providers/core.js` |
| `src/codex/usage.js` | 306 | `server.js`, `src/chat/turn-engine.js`, `src/routes/token-usage.js` |
| `src/commander-migration.js` | 297 | `server.js` |
| `src/context/selection.js` | 94 | `src/memory/retrieval.js`, `src/task-shell/context-plan.js`, `src/task-shell/context-snapshot.js`, `src/task-shell/task-graph-context.js` |
| `src/detached.js` | 265 | `server.js` |
| `src/directories.js` | 295 | `server.js`, `src/routes/macos-privacy.js` |
| `src/directory/index.js` | 33 | `server.js` |
| `src/directory/records.js` | 103 | `server.js`, `src/state/owner.js` |
| `src/directory/repository.js` | 58 | `src/directory/index.js` |
| `src/directory/sample-workspace.js` | 79 | `src/routes/directory-host.js` |
| `src/directory/ui-layout.js` | 69 | `src/directory/index.js` |
| `src/dispatch/gateway-host.js` | 655 | `server.js` |
| `src/dispatch/progress.js` | 200 | `server.js` |
| `src/dispatch/targeting.js` | 233 | `server.js`, `src/dispatch/gateway-host.js` |
| `src/docs-registry.js` | 494 | `server.js`, `src/routes/docs-memory-host.js`, `src/task-shell/host.js` |
| `src/doctor/environment.js` | 304 | `src/doctor/host.js` |
| `src/doctor/host.js` | 48 | `server.js` |
| `src/doctor/llm-loop.js` | 175 | `src/doctor/environment.js`, `src/doctor/service.js` |
| `src/doctor/service.js` | 140 | `src/doctor/host.js` |
| `src/doctor/tools.js` | 295 | `src/doctor/environment.js`, `src/doctor/service.js` |
| `src/events/actions.js` | 183 | `src/events/engine.js` |
| `src/events/catalog.js` | 41 | `src/events/engine.js`, `src/events/hub.js` |
| `src/events/engine.js` | 426 | `src/events/host.js` |
| `src/events/envelope.js` | 51 | `src/events/actions.js`, `src/events/hub.js` |
| `src/events/host.js` | 78 | `server.js` |
| `src/events/hub.js` | 154 | `src/events/host.js` |
| `src/events/rules.js` | 78 | `src/events/engine.js`, `src/triggers/index.js` |
| `src/events/task-transitions.js` | 54 | `src/events/hub.js` |
| `src/experiments/tui-chat-mirror-runtime.js` | 731 | `server.js` |
| `src/fleet-sharing.js` | 145 | `server.js` |
| `src/gateway-child.js` | 338 | `server.js`, `src/fleet-sharing.js`, `src/routes/auth.js`, `src/task-shell/migration-gate.js`, `src/task-shell/migration-page-worker.js`, `src/ws/connection-router.js` |
| `src/git/default-commit-message.js` | 20 | `src/git/service.js`, `src/routes/directory-host.js` |
| `src/git/queue.js` | 42 | `plugins/utils/git-push.js`, `server.js` |
| `src/git/service.js` | 1229 | `server.js`, `src/directories.js`, `src/routes/session-bundle.js`, `src/task-board/lifecycle-host.js`, `src/task-shell/host.js`, `src/task-shell/workspace.js`, `src/workspace/admission.js`, `src/workspace/separation-transfer.js` |
| `src/git/wake-sync.js` | 22 | `src/git/service.js` |
| `src/host-battery.js` | 82 | `src/routes/host-read-host.js` |
| `src/host-env.js` | 91 | `server.js`, `src/server-restart.js` |
| `src/host-lifecycle.js` | 374 | `server.js` |
| `src/host-power-services.js` | 63 | `src/routes/host-power.js`, `src/routes/host-read-host.js` |
| `src/http-errors.js` | 147 | `server.js` |
| `src/http/async-route.js` | 17 | `src/http/index.js` |
| `src/http/diagnostic-result.js` | 31 | `src/http/index.js` |
| `src/http/domain-error.js` | 53 | `plugins/utils/macos-power.js`, `src/http/diagnostic-result.js`, `src/http/error-map.js`, `src/http/index.js` |
| `src/http/error-map.js` | 48 | `src/http/async-route.js`, `src/http/error-presenter.js`, `src/http/index.js`, `src/routes/host-power.js` |
| `src/http/error-presenter.js` | 25 | `src/http/diagnostic-result.js`, `src/http/index.js` |
| `src/http/http-error.js` | 37 | `src/http/error-map.js`, `src/http/index.js` |
| `src/http/index.js` | 10 | `src/memo/controller.js`, `src/routes/docs-memory-host.js` |
| `src/http/json-compression.js` | 64 | `server.js` |
| `src/http/public-safety.js` | 97 | `src/http/error-map.js`, `src/http/http-error.js`, `src/provider-reassign.js`, `src/push/business.js`, `src/push/runtime.js`, `src/routes/aux-goal.js`, `src/routes/chat-history.js`, `src/routes/memory-browser.js`, `src/routes/provider-balance-host.js`, `src/routes/providers-host.js`, `src/routes/providers.js`, `src/routes/share.js`, `src/routes/skill-sync.js`, `src/routes/subagent-defaults-host.js`, `src/routes/task-graph.js`, `src/skill-sync/index.js`, `src/triggers/index.js` |
| `src/ios-ota.js` | 194 | `server.js`, `src/ios-udid.js` |
| `src/ios-udid.js` | 190 | `src/routes/system.js` |
| `src/lan-discovery.js` | 181 | `server.js` |
| `src/liveness/process-probe.js` | 102 | `server.js` |
| `src/liveness/rollout-path.js` | 89 | `server.js` |
| `src/liveness/runtime.js` | 294 | `server.js` |
| `src/log-housekeeping.js` | 231 | `server.js` |
| `src/machines.js` | 119 | `server.js` |
| `src/macos-agent-build.js` | 67 | `src/macos-agent-provision.js` |
| `src/macos-agent-provision.js` | 266 | `src/plugins/catalog.js`, `src/routes/macos-privacy.js`, `src/skill-sync/index.js` |
| `src/macos-unlock-password.js` | 78 | `src/host-power-services.js`, `src/routes/host-power.js` |
| `src/macos-unlock-probe.js` | 96 | `src/host-power-services.js` |
| `src/memo/controller.js` | 150 | `src/memo/index.js`, `src/memo/migrate.js` |
| `src/memo/file-port.js` | 39 | `src/memo/index.js` |
| `src/memo/index.js` | 50 | `server.js` |
| `src/memo/migrate.js` | 130 | `src/memo/index.js` |
| `src/memory-store.js` | 299 | `server.js`, `src/memory/builtin-rules.js`, `src/memory/retrieval.js` |
| `src/memory/builtin-rules.js` | 83 | `src/memory/folder-service.js`, `src/memory/retrieval.js`, `src/routes/session-bundle.js` |
| `src/memory/folder-service.js` | 350 | `server.js` |
| `src/memory/retrieval.js` | 127 | `src/memory/folder-service.js` |
| `src/memory/runtime.js` | 357 | `server.js`, `src/routes/session-profile.js` |
| `src/memory/task-distill.js` | 130 | `server.js`, `src/classify/task-attribution.js` |
| `src/message-composer.js` | 452 | `server.js`, `src/chat/managed-context.js`, `src/chat/turn-engine.js`, `src/cli-adapters/acp.js`, `src/cli-adapters/claude.js`, `src/cli-adapters/codebuddy.js`, `src/cli-adapters/codex-exp.js`, `src/cli-adapters/codex.js`, `src/cli-adapters/command-code.js`, `src/cli-adapters/dsh.js`, `src/cli-adapters/kimi.js`, `src/cli-adapters/opencode-like.js`, `src/cli-adapters/pi.js`, `src/cli-adapters/qoder.js`, `src/cli-adapters/zcode.js` |
| `src/model-history-converter.js` | 377 | `src/codex/official-relay.js`, `src/providers/codex-history-hooks.js` |
| `src/native/request-timer.js` | 22 | `src/providers/model-connect-watch.js`, `src/providers/proxy-stall-watch.js` |
| `src/native/runtime.js` | 88 | `server.js`, `src/auth-security.js`, `src/chat/adapter-completion.js`, `src/chat/api-error-policy.js`, `src/chat/auto-provider-policy.js`, `src/chat/auto-provider-pricing.js`, `src/chat/auto-provider-routing.js`, `src/chat/auto-provider-runtime.js`, `src/chat/background-hold.js`, `src/chat/background-task-runtime.js`, `src/chat/claude-sdk-stream.js`, `src/chat/codex-rollout-guard.js`, `src/chat/finalize-host.js`, `src/chat/finalize-plan.js`, `src/chat/history-frame-budget.js`, `src/chat/host-coordinator.js`, `src/chat/host-prompts.js`, `src/chat/missing-resume-recovery.js`, `src/chat/model-request-policy.js`, `src/chat/native-session-guard.js`, `src/chat/opencode-context-guard.js`, `src/chat/opencode-context.js`, `src/chat/provider-attempt-runtime.js`, `src/chat/retry-policy.js`, `src/chat/task-state-payload.js`, `src/chat/task-state-seed.js`, `src/chat/transcript-prune.js`, `src/chat/turn-engine.js`, `src/chat/turn-lifecycle.js`, `src/chat/turn-progress.js`, `src/chat/turn-request.js`, `src/classify/turn-state.js`, `src/classify/vocab.js`, `src/claude-auth/expired-refresh-policy.js`, `src/cli-adapters/claude-agent-sdk-bridge.mjs`, `src/cli-adapters/completion.js`, `src/cli-adapters/kimi.js`, `src/cli-adapters/pi.js`, `src/cli-adapters/result-completion.js`, `src/cli-adapters/step-completion.js`, `src/cli-switch.js`, `src/cli/cli-capability.js`, `src/cli/cli-upstream-version.js`, `src/cli/homebrew-takeover.js`, `src/cli/model-default.js`, `src/cli/switch-preparation.js`, `src/cli/switch-runtime.js`, `src/cli/tools-host.js`, `src/codex/model-catalog.js`, `src/context/selection.js`, `src/dispatch/targeting.js`, `src/events/catalog.js`, `src/events/envelope.js`, `src/events/rules.js`, `src/events/task-transitions.js`, `src/fleet-sharing.js`, `src/git/default-commit-message.js`, `src/git/service.js`, `src/git/wake-sync.js`, `src/http-errors.js`, `src/machines.js`, `src/memory/retrieval.js`, `src/native/request-timer.js`, `src/native/task-domain.js`, `src/native/task-read-model.js`, `src/native/task-search.js`, `src/network-policy.js`, `src/observability.js`, `src/operation-service.js`, `src/orchestration/native-command.js`, `src/orchestration/native-store-host.js`, `src/orchestration/runtime.js`, `src/outbox.js`, `src/provider-error.js`, `src/providers/auto-provider-config.js`, `src/providers/core.js`, `src/providers/defaults-port.js`, `src/providers/force-detach.js`, `src/providers/model-stream-progress.js`, `src/providers/native-credentials.js`, `src/providers/native-store.js`, `src/providers/native-subscription.js`, `src/providers/proxy-stall-watch.js`, `src/providers/references.js`, `src/providers/relay-share-store.js`, `src/providers/rust-cpr.js`, `src/providers/virtual-provider.js`, `src/quota/account-subscription-cache.js`, `src/quota/claude-header-quota.js`, `src/quota/limit-cache-recorder.js`, `src/quota/provider-limit-cache-native-host.js`, `src/quota/provider-quota-history.js`, `src/quota/quota-bar-view.js`, `src/quota/quota-guard.js`, `src/quota/subscription.js`, `src/request-locality.js`, `src/router-tool-runtime.js`, `src/routes/auth.js`, `src/routes/chat-history.js`, `src/routes/providers-host.js`, `src/routes/providers.js`, `src/routes/static-assets.js`, `src/search/diversity.js`, `src/secret-audit.js`, `src/session-work/host.js`, `src/session-work/scheduler.js`, `src/session/adapters/chat-history-file-repository.js`, `src/session/chat-history-service.js`, `src/session/hibernation.js`, `src/session/records.js`, `src/session/runtime-busy.js`, `src/session/state-transition.js`, `src/state/owner.js`, `src/task-board/board-store.js`, `src/task-board/repository.js`, `src/task-board/turn-context.js`, `src/task-context-host.js`, `src/task-routing/attribution-mode.js`, `src/task-routing/code-revision.js`, `src/task-shell/attribution-decisions.js`, `src/task-shell/context-access.js`, `src/task-shell/context-plan.js`, `src/task-shell/context-snapshot.js`, `src/task-shell/history-context.js`, `src/task-shell/host.js`, `src/task-shell/independent-continue.js`, `src/task-shell/migration-gate.js`, `src/task-shell/role-bindings.js`, `src/task-shell/runtime.js`, `src/task-shell/separation.js`, `src/task-shell/store.js`, `src/task-shell/task-actions.js`, `src/task-shell/task-graph-context.js`, `src/task-shell/task-index.js`, `src/task-shell/task-operations.js`, `src/unattended/kernel.js`, `src/usage-limit-poller.js`, `src/usage-observed.js`, `src/wait/service.js`, `src/windows-env.js`, `src/workspace/admission.js`, `src/workspace/air-card-cache.js`, `src/workspace/air-index-port.js`, `src/workspace/air-sync-issue.js`, `src/workspace/runtime.js`, `src/ws/connection-router.js`, `src/ws/ws-host.js` |
| `src/native/task-domain.js` | 57 | `src/routes/task-planning.js`, `src/task-board/attention.js`, `src/task-board/board-store.js`, `src/task-board/native-bridge.js`, `src/task-board/planning.js`, `src/task-board/repository.js`, `src/task-board/retention.js`, `src/task-board/routing.js`, `src/task-board/view.js`, `src/task-shell/capacity.js`, `src/task-shell/host.js`, `src/workspace/air-card-cache.js`, `src/workspace/air-routes-host.js` |
| `src/native/task-read-model.js` | 70 | `src/workspace/air-index-port.js` |
| `src/native/task-search.js` | 83 | `src/routes/task-search.js` |
| `src/network-policy.js` | 32 | `server.js`, `src/lan-discovery.js`, `src/task-shell/migration-gate.js` |
| `src/network/egress-fetch.js` | 102 | `src/routes/claude-accounts.js`, `src/routes/codex-accounts.js` |
| `src/network/global-proxy.js` | 89 | `server.js`, `src/chat/api-error-host.js`, `src/providers/router-runtime.js` |
| `src/network/official-fetch.js` | 11 | `src/codex/official-relay.js` |
| `src/network/outbound.js` | 95 | `plugins/bridges/discord-bridge.js`, `plugins/bridges/feishu-bridge.js`, `plugins/bridges/slack-bridge.js`, `plugins/voice/voice-asr.js`, `src/cli/tools-host.js`, `src/codex/model-catalog.js`, `src/network/global-proxy.js`, `src/network/official-fetch.js`, `src/network/sdk-bridges.js`, `src/official-accounts-cli-login.js`, `src/providers/jev-client.js`, `src/providers/native-subscription.js`, `src/providers/relay-model-catalog.js`, `src/providers/rust-cpr.js`, `src/quota/claude-cli-oauth.js`, `src/quota/codex-usage-request.js`, `src/quota/opencode-zen.js`, `src/routes/claude-accounts.js`, `src/routes/claude-usage-quota.js`, `src/routes/codex-accounts.js`, `src/routes/developer-tools.js`, `src/routes/kimi-quota.js`, `src/routes/plugins.js`, `src/routes/provider-balance.js`, `src/routes/qoder-quota.js`, `src/update-runner.js`, `src/usage-limit-poller.js`, `src/voice/qwen-audio-installer.js`, `src/voice/qwen-audio-supervisor.js`, `src/voice/tts-service.js` |
| `src/network/proxy-policy.js` | 137 | `src/network/global-proxy.js`, `src/network/official-fetch.js`, `src/network/outbound.js`, `src/providers/router-runtime.js`, `src/tmux.js` |
| `src/network/sdk-bridges.js` | 65 | `plugins/bridges/discord-bridge.js`, `plugins/bridges/feishu-bridge.js` |
| `src/notes-store.js` | 138 | `server.js` |
| `src/notify-settings.js` | 46 | `src/routes/host-write.js` |
| `src/observability.js` | 212 | `server.js`, `src/chat/background-task-runtime.js`, `src/chat/host-runtime.js`, `src/chat/provider-attempt-runtime.js`, `src/chat/proxy-broadcast.js`, `src/chat/turn-engine.js`, `src/cli-adapters/codex-background-events.cjs`, `src/session-work/host.js`, `src/upstream-error.js` |
| `src/official-accounts-cli-login.js` | 121 | `server.js` |
| `src/official-accounts.js` | 369 | `server.js`, `src/claude-auth/accounts-refresh.js`, `src/cli-key-accounts.js`, `src/codex/image-bridge-runtime.js`, `src/codex/model-catalog.js`, `src/codex/official-relay.js`, `src/providers/core.js`, `src/providers/relay-model-catalog.js`, `src/routes/claude-accounts.js`, `src/routes/claude-usage-quota.js`, `src/routes/codex-accounts.js`, `src/routes/provider-balance-host.js`, `src/routes/providers-host.js` |
| `src/operation-service.js` | 479 | `src/orchestration/runtime.js` |
| `src/orchestration/draft-host.js` | 439 | `src/orchestration/sqlite-store.js` |
| `src/orchestration/native-command.js` | 36 | `src/orchestration/native-store-host.js`, `src/orchestration/store.js` |
| `src/orchestration/native-store-host.js` | 1135 | `src/orchestration/sqlite-store.js`, `src/session-work/host.js` |
| `src/orchestration/runtime.js` | 1690 | `server.js` |
| `src/orchestration/sqlite-store.js` | 50 | `src/orchestration/runtime.js` |
| `src/orchestration/store.js` | 340 | `src/orchestration/draft-host.js`, `src/orchestration/runtime.js`, `src/orchestration/sqlite-store.js` |
| `src/outbox.js` | 412 | `src/operation-service.js`, `src/orchestration/native-store-host.js`, `src/orchestration/runtime.js`, `src/wait/service.js` |
| `src/path-safety.js` | 62 | `src/directories.js`, `src/paths.js` |
| `src/paths.js` | 247 | `plugins/bridges/secure-config.js`, `plugins/cron/cron-tasks.js`, `plugins/cron/fanout-migration.js`, `server.js`, `src/annotation-live.js`, `src/artifacts.js`, `src/chat/background-task-runtime.js`, `src/claude-models.js`, `src/detached.js`, `src/docs-registry.js`, `src/providers/core.js`, `src/push/service.js`, `src/search/runtime.js`, `src/secret-audit.js`, `src/secrets-vault.js`, `src/session/adapters/chat-history-file-repository.js`, `src/share.js`, `src/task-shell/migration-gate.js`, `src/tunnel.js`, `src/voice/config.js`, `src/workspace/pins.js`, `src/workspace/todo-ignores.js`, `src/workspace/todos.js` |
| `src/plugins/catalog.js` | 573 | `src/routes/plugins.js` |
| `src/plugins/channel-host.js` | 449 | `src/routes/plugins.js` |
| `src/plugins/channel-registry.js` | 149 | `src/events/actions.js`, `src/events/engine.js`, `src/push/channel-subscriptions.js`, `src/push/runtime.js`, `src/routes/events-host.js`, `src/routes/plugins.js`, `src/triggers/index.js` |
| `src/plugins/installer.js` | 272 | `src/routes/plugins.js` |
| `src/portable-git.js` | 53 | `src/repo-actor.js`, `src/routes/developer-tools.js` |
| `src/powerd.js` | 66 | `plugins/utils/macos-power.js` |
| `src/pricing/price-table.js` | 724 | `src/chat/auto-provider-runtime.js`, `src/routes/quota-host.js` |
| `src/provider-error.js` | 34 | `src/chat/api-error-policy.js`, `src/cli-adapters/acp-bridge.cjs`, `src/cli-adapters/acp.js`, `src/cli-adapters/opencode-error.js`, `src/cli-adapters/opencode-like.js`, `src/cli-adapters/opencode.js` |
| `src/provider-reassign.js` | 292 | `src/routes/providers-host.js` |
| `src/providers/auto-provider-config.js` | 318 | `server.js`, `src/chat/auto-provider-routing.js`, `src/chat/auto-provider-runtime.js`, `src/chat/auto-provider-selection-key.js`, `src/chat/turn-engine.js`, `src/routes/session-admin-host.js`, `src/routes/session-profile.js`, `src/session-dto.js` |
| `src/providers/binding.js` | 138 | `src/chat/turn-request.js`, `src/providers/router-port.js`, `src/providers/router-runtime.js`, `src/usage-observed.js` |
| `src/providers/claude-quota-bridge.js` | 56 | `src/providers/router-port.js` |
| `src/providers/claude-settings-override.js` | 86 | `src/providers/core.js` |
| `src/providers/codex-history-hooks.js` | 117 | `src/providers/router-port.js` |
| `src/providers/core.js` | 2461 | `server.js`, `src/chat/turn-engine.js`, `src/claude-auth/oauth-refresh.js`, `src/codex/model-catalog.js`, `src/codex/oauth-refresh.js`, `src/codex/resident-route.js`, `src/providers/virtual-provider.js`, `src/routes/kimi-quota.js`, `src/routes/provider-models.js`, `src/usage-limit-poller.js` |
| `src/providers/defaults-port.js` | 43 | `src/providers/core.js`, `src/routes/providers.js` |
| `src/providers/egress-ip-policy.js` | 75 | `src/chat/turn-engine.js`, `src/providers/core.js`, `src/providers/virtual-provider.js`, `src/routes/provider-balance-host.js`, `src/usage-limit-poller.js` |
| `src/providers/egress-ip.js` | 267 | `src/providers/egress-ip-policy.js` |
| `src/providers/force-detach.js` | 39 | `src/routes/providers-host.js` |
| `src/providers/jev-client.js` | 505 | `src/chat/auto-provider-routing.js`, `src/providers/auto-provider-config.js` |
| `src/providers/model-connect-watch.js` | 74 | `src/providers/proxy-guard.js` |
| `src/providers/model-stream-progress.js` | 12 | `src/providers/proxy-stall-watch.js` |
| `src/providers/native-credentials.js` | 9 | `src/claude-auth/account-credentials.js`, `src/codex/official-relay.js`, `src/official-accounts.js`, `src/providers/core.js`, `src/quota/claude-cli-oauth.js`, `src/quota/codex-usage-request.js`, `src/quota/subscription.js` |
| `src/providers/native-opencode.js` | 53 | `src/chat/auto-provider-runtime.js`, `src/chat/provider-invocation.js`, `src/cli-switch.js`, `src/providers/auto-provider-config.js`, `src/routes/providers.js`, `src/routes/session-profile.js` |
| `src/providers/native-store.js` | 24 | `src/providers/core.js` |
| `src/providers/native-subscription.js` | 22 | `src/quota/account-subscription-reader.js` |
| `src/providers/native-vendor.js` | 109 | `src/chat/auto-provider-runtime.js`, `src/chat/provider-invocation.js`, `src/cli-switch.js`, `src/cli/switch-runtime.js`, `src/providers/auto-provider-config.js`, `src/providers/router-runtime.js`, `src/routes/providers.js`, `src/routes/session-profile.js` |
| `src/providers/official-catalog.js` | 215 | `server.js`, `src/providers/core.js`, `src/quota/official-account-usage.js`, `src/routes/claude-accounts.js`, `src/routes/codex-accounts.js` |
| `src/providers/opencode-model-limits.js` | 114 | `src/providers/core.js` |
| `src/providers/proxy-guard.js` | 409 | `src/providers/router-port.js` |
| `src/providers/proxy-outcome.js` | 78 | `src/providers/proxy-guard.js`, `src/providers/proxy-stall-watch.js`, `src/usage-observed.js` |
| `src/providers/proxy-stall-watch.js` | 304 | `src/chat/model-timeout-recovery.js`, `src/providers/proxy-guard.js` |
| `src/providers/references.js` | 22 | `server.js` |
| `src/providers/relay-model-catalog.js` | 290 | `server.js` |
| `src/providers/relay-share-store.js` | 45 | `server.js`, `src/providers/core.js` |
| `src/providers/router-adapter.js` | 158 | `src/providers/router-runtime.js` |
| `src/providers/router-port.js` | 576 | `src/providers/router-runtime.js` |
| `src/providers/router-runtime.js` | 249 | `server.js` |
| `src/providers/rust-cpr.js` | 328 | `src/providers/router-runtime.js` |
| `src/providers/virtual-provider.js` | 88 | `src/providers/core.js`, `src/providers/rust-cpr.js`, `src/quota/provider-runtime.js`, `src/quota/quota-self-heal.js`, `src/routes/provider-balance-host.js`, `src/routes/providers-host.js` |
| `src/push/bark-devices.js` | 169 | `src/push/service.js`, `src/routes/push-host.js` |
| `src/push/business.js` | 344 | `src/push/service.js`, `src/routes/push-host.js` |
| `src/push/channel-subscriptions.js` | 166 | `src/push/service.js`, `src/routes/push-host.js` |
| `src/push/fcm-devices.js` | 71 | `src/push/service.js` |
| `src/push/fcm-transport.js` | 62 | `src/push/fcm-devices.js` |
| `src/push/notification-copy.js` | 90 | `src/push/runtime.js` |
| `src/push/runtime.js` | 378 | `server.js` |
| `src/push/service.js` | 223 | `server.js` |
| `src/quota-managed-browser.js` | 453 | `src/routes/aliyun-quota.js`, `src/routes/claude-usage-quota.js`, `src/routes/kimi-auth.js`, `src/routes/kimi-quota.js`, `src/routes/opencode-quota.js`, `src/routes/qoder-quota.js`, `src/routes/quota-host.js` |
| `src/quota/account-subscription-cache.js` | 76 | `src/providers/virtual-provider.js`, `src/quota/account-subscription-reader.js`, `src/quota/provider-runtime.js`, `src/routes/providers-host.js` |
| `src/quota/account-subscription-reader.js` | 64 | `server.js`, `src/routes/claude-accounts.js` |
| `src/quota/claude-bar-state.js` | 119 | `src/chat/proxy-broadcast.js`, `src/chat/usage-limit-wiring.js`, `src/routes/quota-host.js` |
| `src/quota/claude-cli-oauth.js` | 109 | `src/claude-auth/account-credentials.js`, `src/claude-auth/accounts-refresh.js`, `src/official-accounts-cli-login.js`, `src/providers/rust-cpr.js`, `src/quota/account-subscription-reader.js`, `src/routes/claude-usage-quota.js`, `src/routes/provider-balance-host.js` |
| `src/quota/claude-header-quota.js` | 12 | `src/providers/claude-quota-bridge.js`, `src/quota/claude-bar-state.js` |
| `src/quota/claude-usage-queue.js` | 164 | `src/chat/usage-limit-wiring.js`, `src/quota/claude-bar-state.js`, `src/routes/claude-usage-quota.js`, `src/routes/quota-host.js` |
| `src/quota/codex-usage-request.js` | 36 | `src/routes/codex-quota.js`, `src/routes/provider-balance-host.js`, `src/usage-limit-poller.js` |
| `src/quota/limit-cache-recorder.js` | 212 | `src/quota/provider-runtime.js` |
| `src/quota/official-account-usage.js` | 131 | `server.js` |
| `src/quota/opencode-zen.js` | 314 | `src/routes/opencode-quota.js` |
| `src/quota/provider-limit-cache-native-host.js` | 136 | `src/quota/provider-limit-cache.js`, `src/quota/provider-runtime.js` |
| `src/quota/provider-limit-cache.js` | 12 | `src/chat/auto-provider-runtime.js`, `src/quota/provider-limit-sync.js`, `src/routes/aux-goal.js`, `src/routes/providers-host.js` |
| `src/quota/provider-limit-sync.js` | 36 | `src/quota/provider-runtime.js`, `src/routes/provider-balance-host.js` |
| `src/quota/provider-quota-history.js` | 81 | `src/quota/provider-runtime.js` |
| `src/quota/provider-runtime.js` | 23 | `server.js` |
| `src/quota/quota-bar-cache.js` | 164 | `src/quota/provider-runtime.js` |
| `src/quota/quota-bar-view.js` | 46 | `src/chat/provider-log-watchdog.js`, `src/chat/proxy-broadcast.js`, `src/chat/usage-limit-wiring.js`, `src/quota/claude-bar-state.js`, `src/quota/provider-limit-sync.js`, `src/routes/providers-host.js` |
| `src/quota/quota-guard.js` | 105 | `src/quota/provider-runtime.js` |
| `src/quota/quota-self-heal.js` | 80 | `server.js` |
| `src/quota/subscription.js` | 15 | `src/claude-auth/official-oauth.js`, `src/official-accounts.js` |
| `src/repo-actor.js` | 227 | `src/git/queue.js`, `src/git/service.js`, `src/task-routing/code-revision.js`, `src/task-routing/evidence.js`, `src/task-shell/workspace.js`, `src/workspace/admission.js` |
| `src/request-locality.js` | 16 | `server.js`, `src/routes/account-routes-host.js`, `src/routes/agent-resources-host.js`, `src/routes/cli-switch-host.js`, `src/routes/directory-host.js`, `src/routes/docs-memory-host.js`, `src/routes/events-host.js`, `src/routes/file-transfer-host.js`, `src/routes/host-ops-host.js`, `src/routes/host-read-host.js`, `src/routes/model-catalogs-host.js`, `src/routes/orchestration-host.js`, `src/routes/plugins-host.js`, `src/routes/plugins.js`, `src/routes/provider-balance-host.js`, `src/routes/provider-relay-host.js`, `src/routes/providers-host.js`, `src/routes/push-host.js`, `src/routes/quota-host.js`, `src/routes/release-history-host.js`, `src/routes/scan-history-host.js`, `src/routes/secrets-vault-host.js`, `src/routes/server-core-host.js`, `src/routes/session-admin-host.js`, `src/routes/session-git-host.js`, `src/routes/session-routes-host.js`, `src/routes/share-machines-host.js`, `src/routes/subagent-defaults-host.js`, `src/routes/system-host.js`, `src/routes/task-routes-host.js`, `src/routes/token-usage-host.js`, `src/routes/turn-ledger-host.js`, `src/routes/voice-gateway-host.js`, `src/routes/voice-host.js`, `src/routes/voice-runtime-host.js`, `src/task-shell/host.js`, `src/workspace/air-routes-host.js` |
| `src/role-token-tracker.js` | 200 | `server.js` |
| `src/router-tool-host.js` | 304 | `server.js` |
| `src/router-tool-runtime.js` | 1352 | `src/router-tool-host.js` |
| `src/routes/account-routes-host.js` | 225 | `server.js` |
| `src/routes/agent-resources-host.js` | 64 | `server.js` |
| `src/routes/agent-resources.js` | 237 | `server.js` |
| `src/routes/aliyun-quota.js` | 147 | `src/routes/quota-host.js` |
| `src/routes/ark-quota.js` | 213 | `src/routes/quota-host.js` |
| `src/routes/auth.js` | 143 | `server.js` |
| `src/routes/aux-goal.js` | 919 | `server.js` |
| `src/routes/aux-runs.js` | 37 | `server.js` |
| `src/routes/chat-history.js` | 906 | `server.js`, `src/chat/turn-engine.js`, `src/task-shell/chat-history.js` |
| `src/routes/claude-accounts.js` | 290 | `server.js` |
| `src/routes/claude-oauth.js` | 184 | `server.js` |
| `src/routes/claude-usage-quota.js` | 541 | `src/routes/quota-host.js` |
| `src/routes/cli-key-accounts.js` | 82 | `server.js` |
| `src/routes/cli-switch-host.js` | 109 | `src/cli/switch-runtime.js` |
| `src/routes/codebuddy-models.js` | 92 | `src/providers/native-vendor.js`, `src/routes/model-catalogs-host.js` |
| `src/routes/codex-accounts.js` | 295 | `server.js` |
| `src/routes/codex-oauth.js` | 83 | `server.js` |
| `src/routes/codex-quota.js` | 118 | `src/routes/quota-host.js` |
| `src/routes/commandcode-auth.js` | 49 | `server.js` |
| `src/routes/commandcode-models.js` | 101 | `src/providers/native-vendor.js`, `src/routes/model-catalogs-host.js` |
| `src/routes/developer-tools.js` | 223 | `src/routes/host-ops-host.js` |
| `src/routes/directory-host.js` | 476 | `src/directory/index.js` |
| `src/routes/docs-memory-host.js` | 250 | `server.js` |
| `src/routes/doctor.js` | 23 | `src/doctor/host.js`, `src/routes/host-ops-host.js` |
| `src/routes/env-doctor.js` | 23 | `src/doctor/host.js`, `src/routes/host-ops-host.js` |
| `src/routes/events-host.js` | 213 | `server.js` |
| `src/routes/file-transfer-host.js` | 106 | `server.js` |
| `src/routes/grok-models.js` | 83 | `src/providers/native-vendor.js`, `src/routes/model-catalogs-host.js` |
| `src/routes/host-ops-host.js` | 310 | `server.js`, `src/routes/orchestration-host.js` |
| `src/routes/host-power.js` | 110 | `src/routes/host-write.js` |
| `src/routes/host-read-host.js` | 148 | `server.js` |
| `src/routes/host-write.js` | 398 | `src/routes/host-ops-host.js` |
| `src/routes/kimi-auth.js` | 193 | `server.js` |
| `src/routes/kimi-quota.js` | 356 | `src/routes/aliyun-quota.js`, `src/routes/quota-host.js` |
| `src/routes/macos-privacy.js` | 220 | `src/routes/host-ops-host.js` |
| `src/routes/memory-browser.js` | 849 | `server.js`, `src/routes/docs-memory-host.js` |
| `src/routes/model-catalogs-host.js` | 152 | `server.js` |
| `src/routes/opencode-models.js` | 475 | `src/chat/auto-provider-runtime.js`, `src/cli-adapters/opencode.js`, `src/routes/model-catalogs-host.js` |
| `src/routes/opencode-quota.js` | 245 | `src/routes/quota-host.js` |
| `src/routes/ops-terminal.js` | 356 | `src/doctor/host.js`, `src/routes/host-ops-host.js` |
| `src/routes/orchestration-host.js` | 160 | `server.js` |
| `src/routes/orchestration.js` | 667 | `server.js` |
| `src/routes/plugins-host.js` | 111 | `src/routes/plugins.js` |
| `src/routes/plugins.js` | 389 | `server.js`, `src/claude-auth/egress-agent.js` |
| `src/routes/provider-balance-host.js` | 80 | `src/routes/provider-balance.js` |
| `src/routes/provider-balance.js` | 36 | `server.js` |
| `src/routes/provider-models.js` | 234 | `src/routes/model-catalogs-host.js` |
| `src/routes/provider-relay-host.js` | 46 | `server.js` |
| `src/routes/providers-host.js` | 600 | `src/routes/providers.js` |
| `src/routes/providers.js` | 156 | `server.js` |
| `src/routes/push-host.js` | 311 | `server.js` |
| `src/routes/qoder-models.js` | 98 | `src/providers/native-vendor.js`, `src/routes/model-catalogs-host.js` |
| `src/routes/qoder-quota.js` | 237 | `src/routes/quota-host.js` |
| `src/routes/quota-host.js` | 351 | `server.js` |
| `src/routes/release-history-host.js` | 349 | `server.js` |
| `src/routes/scan-history-host.js` | 52 | `server.js` |
| `src/routes/secrets-vault-host.js` | 107 | `server.js` |
| `src/routes/server-core-host.js` | 149 | `server.js` |
| `src/routes/server-restart-route.js` | 133 | `server.js` |
| `src/routes/session-admin-host.js` | 316 | `src/routes/session-admin.js` |
| `src/routes/session-admin.js` | 218 | `server.js` |
| `src/routes/session-bundle.js` | 794 | `server.js` |
| `src/routes/session-create.js` | 99 | `server.js` |
| `src/routes/session-git-host.js` | 370 | `src/routes/session-git.js` |
| `src/routes/session-git.js` | 540 | `server.js` |
| `src/routes/session-lifecycle.js` | 474 | `server.js` |
| `src/routes/session-memory.js` | 180 | `server.js` |
| `src/routes/session-meta.js` | 90 | `server.js` |
| `src/routes/session-profile.js` | 649 | `server.js` |
| `src/routes/session-routes-host.js` | 204 | `server.js` |
| `src/routes/share-machines-host.js` | 261 | `server.js` |
| `src/routes/share.js` | 425 | `src/routes/share-machines-host.js` |
| `src/routes/skill-sync.js` | 49 | `src/routes/host-ops-host.js` |
| `src/routes/static-assets.js` | 54 | `server.js` |
| `src/routes/subagent-defaults-host.js` | 155 | `src/routes/providers.js` |
| `src/routes/system-host.js` | 96 | `server.js` |
| `src/routes/system.js` | 92 | `src/routes/release-history-host.js`, `src/routes/update-route.js` |
| `src/routes/task-board.js` | 1854 | `server.js` |
| `src/routes/task-goal.js` | 112 | `src/routes/session-admin.js` |
| `src/routes/task-graph.js` | 284 | `server.js` |
| `src/routes/task-planning.js` | 181 | `src/routes/task-board.js`, `src/routes/task-routes-host.js` |
| `src/routes/task-routes-host.js` | 251 | `server.js` |
| `src/routes/task-search.js` | 200 | `server.js` |
| `src/routes/task-state-store.js` | 68 | `server.js` |
| `src/routes/token-usage-host.js` | 64 | `server.js` |
| `src/routes/token-usage.js` | 509 | `server.js` |
| `src/routes/turn-ledger-host.js` | 95 | `server.js` |
| `src/routes/update-route.js` | 198 | `server.js` |
| `src/routes/voice-gateway-host.js` | 143 | `src/routes/voice-runtime-host.js`, `src/voice/host.js` |
| `src/routes/voice-gateway-proxy.js` | 174 | `src/voice/host.js` |
| `src/routes/voice-host.js` | 389 | `src/routes/voice.js` |
| `src/routes/voice-runtime-host.js` | 236 | `src/voice/host.js` |
| `src/routes/voice.js` | 133 | `src/voice/host.js` |
| `src/routes/workspaces.js` | 81 | `src/routes/share-machines-host.js` |
| `src/routes/zcode-auth.js` | 197 | `server.js` |
| `src/runtime-homes-janitor.js` | 90 | `server.js` |
| `src/runtime-security.js` | 46 | `plugins/bridges/secure-config.js`, `plugins/cron/cron-tasks.js`, `plugins/cron/fanout-migration.js`, `server.js`, `src/claude-auth/accounts-refresh.js`, `src/claude-auth/refresh-health.js`, `src/cli-adapters/zcode-auth.js`, `src/cli-key-accounts.js`, `src/codex/attempt-home.js`, `src/codex/image-bridge.js`, `src/codex/session-home.js`, `src/docs-registry.js`, `src/events/host.js`, `src/host-env.js`, `src/official-accounts.js`, `src/providers/claude-settings-override.js`, `src/providers/core.js`, `src/push/bark-devices.js`, `src/push/business.js`, `src/push/channel-subscriptions.js`, `src/push/fcm-devices.js`, `src/push/service.js`, `src/secrets-vault.js`, `src/share.js`, `src/tunnel.js`, `src/voice/config.js`, `src/voice/hotword-learner.js`, `src/voice/qwen-audio-installer.js`, `src/voice/qwen-audio-supervisor.js` |
| `src/search/diversity.js` | 63 | `src/search/runtime.js` |
| `src/search/index-store.js` | 637 | `src/search/message-corpus.js`, `src/search/runtime.js` |
| `src/search/message-corpus.js` | 606 | `src/search/runtime.js` |
| `src/search/runtime.js` | 393 | `server.js` |
| `src/search/slice-runner.js` | 111 | `src/search/runtime.js` |
| `src/search/tokenize.js` | 160 | `src/search/index-store.js`, `src/task-board/search.js` |
| `src/secret-audit.js` | 67 | `src/chat/auto-provider-routing.js`, `src/router-tool-runtime.js`, `src/secret-tools.js`, `src/secrets-vault.js` |
| `src/secret-tools.js` | 468 | `server.js` |
| `src/secrets-vault.js` | 225 | `server.js`, `src/chat/auto-provider-routing.js`, `src/chat/chat-stream.js`, `src/chat/claude-sdk-stream.js`, `src/chat/codex-app-stream.js`, `src/chat/turn-engine.js`, `src/router-tool-host.js` |
| `src/server-processes.js` | 180 | `src/workspace/writer-escalation.js` |
| `src/server-restart.js` | 257 | `src/routes/server-restart-route.js` |
| `src/services.js` | 27 | `server.js` |
| `src/session-dto.js` | 170 | `src/api-contract.js`, `src/dispatch/targeting.js`, `src/session/query-service.js`, `src/session/workspace-service.js` |
| `src/session-work/host.js` | 1360 | `server.js` |
| `src/session-work/scheduler.js` | 908 | `src/orchestration/runtime.js`, `src/routes/task-board.js`, `src/session-work/host.js` |
| `src/session/adapters/chat-history-file-repository.js` | 127 | `src/search/runtime.js`, `src/session/index.js` |
| `src/session/chat-history-service.js` | 109 | `src/routes/chat-history.js`, `src/session/index.js` |
| `src/session/create-record.js` | 164 | `server.js` |
| `src/session/delivery.js` | 93 | `server.js`, `src/classify/state-machine.js`, `src/task-context-host.js`, `src/wait/injector.js` |
| `src/session/fork-configuration.js` | 27 | `src/routes/session-profile.js` |
| `src/session/handoff-env.js` | 639 | `src/routes/session-bundle.js` |
| `src/session/handoff-zip.js` | 242 | `src/plugins/installer.js`, `src/routes/session-bundle.js` |
| `src/session/hibernation-composition.js` | 100 | `server.js` |
| `src/session/hibernation-reclaimer.js` | 85 | `src/session/hibernation.js` |
| `src/session/hibernation.js` | 718 | `server.js`, `src/session/hibernation-composition.js` |
| `src/session/index.js` | 9 | `server.js`, `src/routes/session-admin.js` |
| `src/session/login-terminal.js` | 45 | `server.js` |
| `src/session/pending-configuration.js` | 47 | `src/providers/force-detach.js`, `src/routes/session-profile.js`, `src/routes/subagent-defaults-host.js`, `src/session/fork-configuration.js` |
| `src/session/persistence.js` | 169 | `server.js` |
| `src/session/ports.js` | 46 | `src/session/chat-history-service.js`, `src/session/query-service.js`, `src/session/workspace-service.js` |
| `src/session/public-session-access.js` | 45 | `server.js`, `src/chat/turn-engine.js`, `src/ws/connection-router.js` |
| `src/session/query-service.js` | 134 | `src/session/index.js` |
| `src/session/records.js` | 108 | `server.js`, `src/routes/task-state-store.js`, `src/session/persistence.js` |
| `src/session/runtime-busy.js` | 64 | `src/cli/switch-runtime.js`, `src/routes/session-git.js`, `src/routes/session-lifecycle.js`, `src/session-work/host.js`, `src/session/hibernation-composition.js`, `src/session/pending-configuration.js`, `src/task-shell/workspace.js`, `src/workspace/admission.js` |
| `src/session/state-transition.js` | 31 | `src/session/index.js` |
| `src/session/subagent.js` | 68 | `src/routes/session-profile.js`, `src/session/create-record.js`, `src/session/fork-configuration.js` |
| `src/session/task-history-retention.js` | 125 | `server.js`, `src/task-board/lifecycle.js` |
| `src/session/workspace-service.js` | 104 | `src/session/index.js` |
| `src/share.js` | 248 | `server.js` |
| `src/shutdown.js` | 236 | `src/host-lifecycle.js` |
| `src/skill-converter.js` | 636 | `server.js` |
| `src/skill-sync/index.js` | 513 | `server.js` |
| `src/skills.js` | 207 | `server.js` |
| `src/sqlite-runtime.js` | 130 | `src/providers/core.js` |
| `src/sqlite/driver.js` | 190 | `src/cli/native-session-exists.js`, `src/search/index-store.js`, `src/sqlite-runtime.js` |
| `src/state/container.js` | 21 | `server.js`, `src/directories.js`, `src/search/runtime.js`, `src/skills.js` |
| `src/state/owner.js` | 68 | `server.js`, `src/chat/runtime-store.js` |
| `src/state/store.js` | 246 | `server.js`, `src/classify/task-short-code.js`, `src/codex/attempt-home.js`, `src/directory/records.js`, `src/directory/ui-layout.js`, `src/quota/quota-bar-cache.js`, `src/role-token-tracker.js`, `src/runtime-security.js`, `src/session/adapters/chat-history-file-repository.js`, `src/workspace/pins.js`, `src/workspace/todo-ignores.js` |
| `src/tailscale-funnel-health.js` | 496 | `src/tunnel.js` |
| `src/task-board/attention.js` | 15 | `src/routes/task-board.js` |
| `src/task-board/board-store.js` | 487 | `src/routes/task-board.js` |
| `src/task-board/classification.js` | 107 | `src/task-board/core.js` |
| `src/task-board/cold-start-seed.js` | 73 | `src/routes/task-board.js` |
| `src/task-board/core.js` | 81 | `src/classify/state-machine.js`, `src/routes/task-board.js`, `src/routes/task-graph.js`, `src/task-board/lifecycle-host.js`, `src/task-shell/host.js`, `src/task-shell/task-graph-context.js`, `src/voice/gateway.js`, `src/voice/host.js`, `src/workspace/air-routes-host.js` |
| `src/task-board/lifecycle-host.js` | 236 | `server.js` |
| `src/task-board/lifecycle.js` | 121 | `src/routes/task-board.js` |
| `src/task-board/native-bridge.js` | 21 | `src/task-board/classification.js`, `src/task-board/lifecycle.js`, `src/task-board/normalize.js`, `src/task-board/view.js` |
| `src/task-board/normalize.js` | 101 | `src/task-board/classification.js`, `src/task-board/core.js`, `src/task-board/routing.js` |
| `src/task-board/planning.js` | 52 | `src/routes/task-board.js`, `src/routes/task-planning.js`, `src/task-board/board-store.js`, `src/task-board/core.js`, `src/task-board/normalize.js`, `src/task-board/view.js` |
| `src/task-board/relocate.js` | 119 | `src/routes/task-board.js` |
| `src/task-board/repository.js` | 19 | `src/routes/task-board.js` |
| `src/task-board/retention.js` | 148 | `src/routes/task-board.js` |
| `src/task-board/routing.js` | 45 | `src/task-board/core.js` |
| `src/task-board/runtime-helpers.js` | 32 | `src/routes/task-board.js` |
| `src/task-board/search.js` | 328 | `src/classify/task-attribution.js`, `src/native/task-search.js` |
| `src/task-board/turn-context.js` | 85 | `src/routes/task-board.js` |
| `src/task-board/view.js` | 35 | `src/task-board/core.js` |
| `src/task-context-host.js` | 332 | `server.js` |
| `src/task-display-attribution.js` | 32 | `src/routes/task-board.js`, `src/task-shell/runtime.js`, `src/task-shell/task-actions.js` |
| `src/task-routing/attribution-mode.js` | 48 | `src/task-shell/attribution-decisions.js`, `src/task-shell/attribution-settings.js` |
| `src/task-routing/candidates.js` | 36 | `src/task-shell/host.js` |
| `src/task-routing/code-revision.js` | 81 | `src/task-routing/evidence.js`, `src/workspace/admission.js` |
| `src/task-routing/delivery-view.js` | 97 | `src/workspace/air-routes-host.js` |
| `src/task-routing/evidence.js` | 198 | `src/workspace/admission.js` |
| `src/task-routing/facts.js` | 108 | `src/task-routing/evidence.js` |
| `src/task-shell/artifacts.js` | 79 | `src/task-shell/host.js` |
| `src/task-shell/attribution-decisions.js` | 382 | `src/task-shell/host.js` |
| `src/task-shell/attribution-settings.js` | 44 | `src/task-shell/host.js` |
| `src/task-shell/capacity.js` | 9 | `src/task-board/retention.js`, `src/task-shell/runtime.js`, `src/task-shell/separation.js`, `src/task-shell/task-actions.js` |
| `src/task-shell/chat-history.js` | 88 | `src/task-shell/host.js`, `src/task-shell/task-index.js` |
| `src/task-shell/context-access.js` | 31 | `src/task-shell/runtime.js` |
| `src/task-shell/context-plan.js` | 127 | `src/task-shell/runtime.js` |
| `src/task-shell/context-snapshot.js` | 51 | `src/task-shell/context-plan.js` |
| `src/task-shell/history-context.js` | 89 | `src/task-shell/context-access.js`, `src/task-shell/independent-continue.js`, `src/task-shell/runtime.js`, `src/task-shell/separation.js`, `src/task-shell/task-actions.js` |
| `src/task-shell/host.js` | 553 | `server.js` |
| `src/task-shell/independent-continue.js` | 322 | `src/task-shell/runtime.js` |
| `src/task-shell/migration-gate.js` | 94 | `server.js` |
| `src/task-shell/migration-page-worker.js` | 83 | 未发现静态内部调用方 |
| `src/task-shell/migration-progress.js` | 54 | `src/task-shell/migration-page-worker.js` |
| `src/task-shell/relations.js` | 20 | `src/task-shell/runtime.js` |
| `src/task-shell/role-bindings.js` | 91 | `src/task-shell/runtime.js`, `src/workspace/admission.js` |
| `src/task-shell/runtime.js` | 712 | `src/task-shell/host.js` |
| `src/task-shell/separation.js` | 405 | `src/task-shell/runtime.js` |
| `src/task-shell/store.js` | 107 | `src/task-shell/host.js`, `src/workspace/admission.js` |
| `src/task-shell/task-actions.js` | 244 | `src/task-shell/runtime.js` |
| `src/task-shell/task-first.js` | 86 | `src/task-shell/runtime.js` |
| `src/task-shell/task-graph-context.js` | 198 | `server.js` |
| `src/task-shell/task-index.js` | 169 | `src/task-shell/host.js` |
| `src/task-shell/task-operations.js` | 408 | `src/task-shell/host.js` |
| `src/task-shell/workspace.js` | 105 | `server.js`, `src/task-shell/host.js` |
| `src/task-worktree.js` | 227 | `server.js`, `src/routes/task-board.js` |
| `src/tmux.js` | 198 | `server.js`, `src/experiments/tui-chat-mirror-runtime.js` |
| `src/triggers/index.js` | 467 | `server.js` |
| `src/tunnel-sakurafrp-api.js` | 170 | `src/tunnel.js` |
| `src/tunnel-sakurafrp.js` | 127 | `src/tunnel.js` |
| `src/tunnel.js` | 1234 | `server.js` |
| `src/turn-ledger/contract.js` | 80 | `src/turn-ledger/ledger.js`, `src/turn-ledger/runtime.js` |
| `src/turn-ledger/evidence.js` | 96 | `src/turn-ledger/runtime.js` |
| `src/turn-ledger/hook-install.js` | 187 | `src/turn-ledger/runtime.js` |
| `src/turn-ledger/ledger.js` | 279 | `src/turn-ledger/runtime.js` |
| `src/turn-ledger/runtime.js` | 191 | `server.js` |
| `src/unattended/host.js` | 1379 | `src/unattended/runtime.js` |
| `src/unattended/kernel.js` | 125 | `src/orchestration/runtime.js`, `src/task-context-host.js`, `src/unattended/host.js`, `src/unattended/routes.js`, `src/unattended/runtime.js` |
| `src/unattended/routes.js` | 68 | `src/routes/session-admin.js` |
| `src/unattended/runtime.js` | 185 | `server.js` |
| `src/update-runner.js` | 515 | `src/routes/update-route.js` |
| `src/upload-middleware.js` | 150 | `server.js` |
| `src/upstream-error.js` | 147 | `src/chat/api-error-policy.js`, `src/cli-adapters/codex.js`, `src/cli-adapters/pi.js`, `src/codex/official-relay.js`, `src/routes/kimi-quota.js`, `src/usage-limit-poller.js` |
| `src/usage-limit-poller.js` | 317 | `server.js`, `src/quota/official-account-usage.js`, `src/quota/quota-self-heal.js`, `src/routes/codex-quota.js`, `src/routes/kimi-quota.js`, `src/routes/provider-balance-host.js` |
| `src/usage-observed.js` | 93 | `src/providers/router-port.js`, `src/role-token-tracker.js` |
| `src/voice/acp-bridge.js` | 835 | 未发现静态内部调用方 |
| `src/voice/asr-local.js` | 427 | `plugins/voice/voice-asr.js`, `src/voice/host.js` |
| `src/voice/asr-model-installer.js` | 339 | `src/voice/host.js` |
| `src/voice/config.js` | 315 | `src/voice/asr-local.js`, `src/voice/host.js` |
| `src/voice/gateway.js` | 375 | `src/routes/voice-gateway-host.js`, `src/voice/host.js`, `src/voice/qwen-audio-supervisor.js` |
| `src/voice/host.js` | 198 | `server.js` |
| `src/voice/hotword-corrector.js` | 213 | `src/voice/asr-local.js`, `src/voice/config.js`, `src/voice/hotword-miner.js` |
| `src/voice/hotword-learner.js` | 306 | `src/voice/config.js` |
| `src/voice/hotword-miner.js` | 275 | `src/voice/hotword-learner.js` |
| `src/voice/launch.js` | 216 | `src/voice/host.js` |
| `src/voice/multicc-acp-agent.mjs` | 82 | 未发现静态内部调用方 |
| `src/voice/qwen-audio-installer.js` | 539 | `src/voice/host.js` |
| `src/voice/qwen-audio-supervisor.js` | 630 | `src/voice/host.js` |
| `src/voice/readiness.js` | 45 | `src/routes/voice.js` |
| `src/voice/router.js` | 88 | `src/routes/task-board.js`, `src/voice/host.js`, `src/voice/launch.js` |
| `src/voice/speech.js` | 55 | `src/dispatch/gateway-host.js`, `src/voice/acp-bridge.js` |
| `src/voice/tts-service.js` | 336 | `server.js` |
| `src/wait/injector.js` | 441 | `server.js`, `src/chat/turn-engine.js` |
| `src/wait/service.js` | 191 | `src/orchestration/runtime.js` |
| `src/windows-env.js` | 276 | `server.js`, `src/cli-adapters/commands.js`, `src/cli/tools-host.js`, `src/routes/developer-tools.js`, `src/routes/ops-terminal.js` |
| `src/workspace/admission.js` | 748 | `server.js` |
| `src/workspace/air-card-cache.js` | 149 | `src/workspace/air-routes-host.js` |
| `src/workspace/air-index-port.js` | 44 | `src/workspace/air-sync-runtime.js` |
| `src/workspace/air-routes-host.js` | 786 | `src/workspace/air-routes.js` |
| `src/workspace/air-routes.js` | 34 | `server.js` |
| `src/workspace/air-storage-notice.js` | 37 | `server.js` |
| `src/workspace/air-sync-issue.js` | 34 | `src/workspace/air-storage-notice.js`, `src/workspace/air-sync-runtime.js` |
| `src/workspace/air-sync-runtime.js` | 195 | `src/workspace/air-routes-host.js` |
| `src/workspace/inventory.js` | 110 | 未发现静态内部调用方 |
| `src/workspace/orphan-scan.js` | 126 | `server.js` |
| `src/workspace/pins.js` | 156 | `server.js`, `src/workspace/air-routes-host.js`, `src/workspace/todos.js` |
| `src/workspace/registry.js` | 154 | `src/workspace/admission.js` |
| `src/workspace/runtime.js` | 295 | `server.js` |
| `src/workspace/separation-transfer.js` | 52 | `src/task-shell/host.js` |
| `src/workspace/todo-ignores.js` | 248 | `src/workspace/air-routes-host.js` |
| `src/workspace/todos.js` | 30 | `src/workspace/air-routes-host.js` |
| `src/workspace/writer-escalation.js` | 105 | `src/workspace/admission.js` |
| `src/workspace/writer-group.js` | 59 | `src/chat/chat-stream.js`, `src/chat/claude-sdk-stream.js`, `src/chat/codex-app-stream.js`, `src/chat/turn-engine.js`, `src/router-tool-host.js`, `src/workspace/admission.js` |
| `src/ws/connection-router.js` | 442 | `server.js` |
| `src/ws/gateway-chat-bridge.js` | 401 | `src/gateway-child.js` |
| `src/ws/native-queue.js` | 60 | `src/ws/connection-router.js` |
| `src/ws/ws-host.js` | 49 | `src/chat/sessions.js`, `src/ws/connection-router.js` |
