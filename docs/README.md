# MultiCC documentation

> First-time user? Start at the **[top-level README](../README.md)** (or the
> **[中文导引](../README.zh.md)**). This folder holds the full reference — the
> README keeps only what you need for a first run, everything deeper lives here.

## Start here

The nine documents the README links to directly.

| Document | What's in it |
|---|---|
| **[Multi-CLI switching](cli-switching.md)** | The headline feature: `claude`/`codex`/`opencode`/`zcode`/`kimi`/`qoder` in one chat, the bounded handoff checkpoint, `reused` semantics, one-click install, and the `switch-cli` API. |
| [Installation & service management](installation.md) | Install-script flags (`--branch`, `--port`, `--token`, `--no-service`, `--no-apk`, `--no-clone`), updating, force-push recovery, the `./multicc` manager, macOS `launchd` / Linux `systemd` units, Flutter APK/iOS builds. |
| [Configuration](configuration.md) | Every environment variable: `ACCESS_TOKEN`, `HOST` + `MULTICC_ALLOW_REMOTE`, `PORT`, `providers.json`, `cc-switch` import, voice, TTS/ASR, notifications. |
| [Features](features.md) | Complete feature catalogue: git worktrees, parallel sessions, subagent provider routing, voice, IM bridges, push, task board. |
| [Architecture](architecture.md) | Repository layout (`src/`, `cli-adapters/`, `routes/`, `plugins/`, `skills/`), message-flow diagrams, and the design decisions — no vendor-transcript translation, fail-closed network binding. |
| [API reference](api-reference.md) | REST endpoints by domain (`/api/sessions`, `/api/sessions/:id/switch-cli`, `/api/cli/:cli/install`, `/api/voice/*`, `/api/push/*`) and the `/ws/chat` WebSocket protocol with ws-ticket auth. |
| [How MultiCC compares](ecosystem-comparison.md) | 12-project landscape and head-to-head tables: cc-switch, Ruflo, CLIProxyAPI, oh-my-claudecode, AionUi, vibe-kanban, cc-connect, CloudCLI, Superset, Orca, cockpit-tools — and what MultiCC is *worse* at. |
| [FAQ](faq.md) | Troubleshooting: HTTPS / TLS, microphone secure-context, port conflicts, provider setup. |
| [Tech stack](tech-stack.md) | Runtime dependencies and what each is for: Express, ws, better-sqlite3, sherpa-onnx-node, cli-provider-router, chokidar 5, Flutter. |

## Design & contracts

Internal contracts that keep the surface area bounded. Mostly reference for
contributors and integrators.

| Document | What's in it |
|---|---|
| [API contracts](api-contracts.md) | The versioned `v1` HTTP + WebSocket contract surface and its stability rules. |
| [API error policy](api-error-policy.md) | How provider failures are classified once at the owned turn boundary (`429`, `5xx`, timeouts). |
| [Cancel state flow](cancel-state-flow.md) | How a manual Cancel (web stop button, app stop, task-card cancel) propagates to the running CLI. |
| [Classify state-machine audit](classify-state-machine-audit.md) (visual map: served at `/docs/classify-state-machine-architecture`, source [`public/docs/classify-state-machine-architecture.html`](../public/docs/classify-state-machine-architecture.html)) | Current P/D/W/B/E inputs, outputs and sequences; semantic/atomicity audit; target split between turn execution and task lifecycle. |
| [Codex subagent provider routing](codex-subagent-provider-routing.md) | Routing Codex parent vs. child threads through separate provider/model endpoints. |
| [Fleet Commander migration](commander-migration.md) | Startup invariant that every registered directory is valid, and the upgrade migration that enforces it. |
| [Session FIFO scheduler](session-fifo-scheduler.md) | The single durable per-session queue that admits every unit of chat work. |
| [Router MCP tools](router-tools.md) | Cross-session routing exposed as a local stdio MCP server. |
| [Status presentation](status-presentation.md) | Every user-visible status badge — web session list, Fleet cards, task cards — and its state machine. |

## Governance reviews (2026-07-18)

Fixed-point reviews that record what was deliberately *not* deleted or changed.

| Document | What's in it |
|---|---|
| [Repository artifact governance](repository-artifact-governance.md) | What stays in the repo and why; the artifact baseline. |
| [Session domain boundaries](session-domain-boundaries.md) | The session/entity/role boundaries enforced by tests. |
| [Data-root & CI governance](data-root-ci-governance.md) | Data directory layout and CI-only artifacts. |
| [Dependency security audit](security-dependency-audit.md) | npm dependency review and accepted risks. |

## Voice

Two paths: classic voice (local ASR + TTS) and realtime speech-to-speech.

| Document | What's in it |
|---|---|
| [Local ASR](local-asr.md) | On-device recognition with sherpa-onnx `SenseVoiceSmall int8` in the Node process. |
| [Realtime voice design](realtime-voice-design.md) | Design for full-duplex speech-to-speech with barge-in. |
| [Realtime voice implementation](realtime-voice-implementation.md) | What was built: VAD, TTS playback, session state machine. |
| [Realtime voice report](realtime-voice-report.md) | Completion report and file map (`voice-output.js`, `vad-monitor.js`, `voice-session.js`). |
| [Realtime voice benchmark](benchmark-realtime-voice.md) | Latency / throughput measurements. |

## Provider routing & protocol bridges

How MultiCC talks to non-default endpoints and across CLIs.

| Document | What's in it |
|---|---|
| [Claude subagent provider routing](claude-subagent-provider-routing.md) | Routing Claude Code subagents to a different provider/model for cost control. |
| [Codex proxy contract](codex-proxy-contract.md) | The Responses ↔ `chat/completions` transform that lets `codex` reach non-OpenAI endpoints. |
| [Gateway dispatch brief](gateway-dispatch-brief.md) | Design brief for the gateway auto-dispatch (hermes/feishu-style bridge). |
| [Message builder — design](message-builder-design.md) | The unified `composeMessage` / `shape(envelope)` design across all four CLI adapters. |
| [Message builder — example](message-builder-example.md) | Worked message-construction examples for the envelope layers. |
| [Multi-platform bridge plan](MULTI_PLATFORM_BRIDGE_PLAN.md) | Plan for the multi-platform IM bridge (WeChat / Feishu / Telegram / Discord / Slack). |

## Modularization archive

Historical roadmap for splitting the large files. Kept for context; some content
predates later refactors.

| Document | What's in it |
|---|---|
| [Modularization roadmap](modularization-roadmap.md) | Plan for losslessly splitting the five large files into modules. |
| [Modularization batch A0](modularization-batch-a0.md) | Template batch: extracting a badge widget end-to-end. |

## Assets

- [`images/`](images/) — placeholders for the README demo GIF/screenshots and the
  redaction convention. See [`images/README.md`](images/README.md).

---

[← Back to the README](../README.md)
