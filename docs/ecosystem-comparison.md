# MultiCC vs. the CLI-harness ecosystem

> Migrated out of the README so the front page stays focused. This is the full competitive survey: a 12-project landscape table, a problem-to-project decision tree, and eight head-to-head capability matrices.

The open-source ecosystem around Claude Code and Codex has grown fast. Below is a survey of projects that **harness** these CLIs (spawn, manage, and route the official binaries) rather than replace them.

> **Standalone coding agents** like [OpenCode](https://github.com/naklecha/opencode), [Aider](https://github.com/paul-gauthier/aider), and [Cline](https://github.com/cline/cline) implement their own agent loop — they're alternatives to Claude Code, not orchestration layers on top. They're excluded from this comparison.

## The CLI harness landscape

| Project | Stars | Architecture | Drives | What it solves |
|---------|-------|-------------|--------|----------------|
| **[cc-switch](https://github.com/farion1231/cc-switch)** | ~111k | Desktop GUI (Tauri) | Claude Code, Codex, OpenCode, Gemini CLI | **Provider & account management.** Switch API keys/providers globally, manage skills across CLIs. The "control panel" for which API backs your CLI. |
| **[Ruflo](https://github.com/ruvnet/ruflo)** | ~62k | CLI + MCP server (TypeScript) | Claude Code, Codex | **Agent meta-harness.** 100+ specialized agents, coordinated swarms, self-learning memory, federation across machines. The "framework" for building agent systems. |
| **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** | ~38k | API proxy (Go) | Claude Code, Codex, Gemini, Grok | **API routing.** Wraps multiple CLIs behind a single OpenAI-compatible API endpoint. The "router" layer. |
| **[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)** | ~37k | CLI (TypeScript) | Claude Code | **Teams-first orchestration.** Multi-agent parallel execution with a teams metaphor. Claude Code only. |
| **[AionUi](https://github.com/iOfficeAI/AionUi)** | ~29k | Desktop + Web (TypeScript) | Claude Code, Codex, OpenCode, Gemini CLI | **Cowork desktop app.** Multi-agent chat UI, 24/7 automation, skills customization. The "desktop workspace" for AI agents. |
| **[vibe-kanban](https://github.com/BloopAI/vibe-kanban)** | ~27k | Web UI (Rust) | Claude Code, Codex, 10+ agents | **Kanban task management.** Plan on a board, each task gets a workspace + agent. *Sunsetting.* |
| **[cc-connect](https://github.com/chenhg5/cc-connect)** | ~13k | Bridge (Go) | Claude Code, Codex, Gemini CLI | **IM bridge only.** Routes agent I/O to Feishu/DingTalk/Slack/Telegram/Discord/WeChat Work. No orchestration. |
| **[CloudCLI](https://github.com/siteboon/claudecodeui)** | ~12.5k | Web + Mobile (React/Electron) | Claude Code, Codex, Cursor CLI, Gemini | **GUI layer.** Chat interface, file explorer, CodeMirror editor, Git explorer, plugin system. Hosted cloud tier (€7/mo) adds persistent sessions. No scheduling, IM, or provider routing. |
| **[Superset](https://github.com/superset-sh/superset)** | ~12k | Desktop (Electron) | Claude Code, Codex, any CLI | **Code editor for agents.** Parallel worktrees, diff viewer, IDE integration. The "IDE" layer. |
| **[Orca](https://github.com/stablyai/orca)** | ~10k | Desktop + Mobile (TypeScript) | Claude Code, Codex, OpenCode | **Agent IDE.** Parallel worktrees, SSH remote, mobile companion, GitHub/Linear integration. YC-backed. |
| **[cockpit-tools](https://github.com/jlcodes99/cockpit-tools)** | ~12k | Desktop (Rust) | Codex, Cursor, Copilot, etc. | **Account manager.** Multi-account switching, quota monitoring, instance management. |
| **MultiCC** | — | **Self-hosted server** (Node.js) | **Claude Code, Codex** | **Persistent multi-agent service.** Web + mobile + IM, scheduling, notifications, voice, cross-session dispatch. |

## What problem does each project solve?

```
"I want to switch API providers / manage accounts"    → cc-switch, cockpit-tools
"I want to build multi-agent swarms with memory"      → Ruflo
"I want a desktop workspace for AI agents"             → AionUi
"I want a Kanban board for coding agents"              → vibe-kanban
"I want an IDE that runs agents in parallel"           → Superset, Orca
"I want a web/mobile UI for my CLI agents"             → CloudCLI
"I want to bridge my agents to IM"                     → cc-connect
"I want to route multiple CLIs through one API"        → CLIProxyAPI

"I want a self-hosted server that turns my AI coding
 agents into a persistent, multi-client, scheduled,
 notifiable, voice-enabled, IM-connected service"      → MultiCC
```

## Head-to-head: orchestration harnesses that drive both Claude Code + Codex

Only projects that explicitly support **both** Claude Code and Codex are included. Capabilities marked as of July 2026 based on public READMEs.

### Architecture & deployment

| Capability | cc-switch | Ruflo | AionUi | Superset | Orca | CloudCLI | **MultiCC** |
|------------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Architecture** | Desktop GUI (Tauri) | CLI + MCP | Desktop + Web | Desktop IDE (Electron) | Desktop + Mobile | Web + Mobile | **Self-hosted server** |
| **Runs headless on a server** | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ (cloud) | ✅ |
| **Always-on without desktop** | ❌ | ✅ (daemon) | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Zero frontend build step** | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **One-click install script** | ❌ | ✅ (`npx`) | ❌ | ❌ | ❌ | ❌ | ✅ (`curl \| bash`) |
| **Service manager (launchd/systemd)** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Self-update mechanism** | ✅ (app update) | ✅ (`npx`) | ✅ (app update) | ✅ (app update) | ✅ (app update) | ❌ | ✅ (`./multicc update` + APK) |
| **Public tunnel (Tailscale/DDNS)** | N/A | ❌ | ❌ | N/A | ❌ | ❌ | ✅ |
| **HTTPS auto-cert with SAN IPs** | N/A | ❌ | N/A | N/A | N/A | ✅ (cloud) | ✅ |

### CLI & provider management

| Capability | cc-switch | Ruflo | AionUi | Superset | Orca | CloudCLI | **MultiCC** |
|------------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Drives Claude Code** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Drives Codex** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Per-session provider isolation** | ❌ (global) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Per-session model selection** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Per-role subagent routing (cheap model for Task tool)** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Provider-aware model options** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Import providers from cc-switch** | N/A | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Codex provider isolation (CODEX_HOME)** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Codex proxy for non-OpenAI endpoints** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Per-CLI default provider** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

### Git worktree & multi-agent

| Capability | cc-switch | Ruflo | AionUi | Superset | Orca | CloudCLI | **MultiCC** |
|------------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Git worktree per session** | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ |
| **Merge/sync back to base branch** | N/A | ❌ | N/A | ✅ | ✅ | N/A | ✅ (API + UI) |
| **Auto-commit before merge** | N/A | ❌ | N/A | ❌ | ❌ | N/A | ✅ |
| **Sibling worktree auto-sync** | N/A | ❌ | N/A | ❌ | ❌ | N/A | ✅ |
| **Syntax-gated merges** | N/A | ❌ | N/A | ❌ | ❌ | N/A | ✅ |
| **Multi-directory support** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Agent Commander role** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Role presets / templates** | ✅ (skills) | ✅ (100+ agents) | ✅ (skills) | ❌ | ❌ | ❌ | ✅ |
| **Cross-session dispatch** | ❌ | ✅ (swarm) | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Passive inter-agent notes** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

### Session modes & UI

| Capability | cc-switch | Ruflo | AionUi | Superset | Orca | CloudCLI | **MultiCC** |
|------------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Terminal mode (xterm.js)** | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Chat mode (streaming bubbles)** | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| **Streaming tool cards** | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ |
| **Inline image rendering** | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ |
| **Multi-client per session** | N/A | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ (web + app + IM) |
| **Reconnect replay buffer** | N/A | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (last 500 events) |
| **Session status indicators** | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ (7 states) |
| **Directory workspace dashboard** | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Event timeline per directory** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Directory memo (shared notes)** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Session sharing (snapshot link)** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Onboarding tour** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **i18n (zh/en)** | ✅ (multi-lang) | ❌ | ✅ (multi-lang) | ❌ | ✅ (multi-lang) | ✅ (multi-lang) | ✅ (zh/en) |

### Mobile & notifications

| Capability | cc-switch | Ruflo | AionUi | Superset | Orca | CloudCLI | **MultiCC** |
|------------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Mobile app (native)** | ❌ | ❌ | ❌ | ❌ | ✅ (iOS+Android) | ✅ (responsive web) | ✅ (Flutter) |
| **PWA support** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **In-app APK auto-update** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **QR code phone onboarding** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Web Push (VAPID)** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Bark push (iOS)** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Webhook notifications** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Voice alert (speechSynthesis)** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Flutter local notifications** | N/A | ❌ | ❌ | N/A | ❌ | N/A | ✅ |
| **Smart "don't notify when watching"** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

### IM bridges

| Capability | cc-switch | Ruflo | AionUi | Superset | Orca | CloudCLI | **MultiCC** |
|------------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **WeChat bridge** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Feishu / Lark bridge** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Telegram bridge** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Discord bridge** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Slack bridge** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **IM dispatch with confirmation** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **IM → agent result auto-reply** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

### Scheduling & autonomous work

| Capability | cc-switch | Ruflo | AionUi | Superset | Orca | CloudCLI | **MultiCC** |
|------------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Cron / scheduled tasks** | ❌ | ✅ (daemon) | ✅ (24/7) | ❌ | ❌ | ❌ | ✅ |
| **Persistent context across cron runs** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Wait/poll auto-resume** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Callback wait (external system)** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **run-detached (setsid background)** | ❌ | ✅ (daemon) | ✅ | ❌ | ❌ | ❌ | ✅ |
| **Per-session auto-triggers** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **File-change triggers** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Post-turn triggers** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

### Voice

| Capability | cc-switch | Ruflo | AionUi | Superset | Orca | CloudCLI | **MultiCC** |
|------------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Voice input (STT + AI refine)** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Vocabulary learning loop** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **S2S real-time voice** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **VAD with barge-in interrupt** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Streaming TTS output** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Multi-engine TTS (Edge/OpenAI/Volcano)** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

### Observability & cost

| Capability | cc-switch | Ruflo | AionUi | Superset | Orca | CloudCLI | **MultiCC** |
|------------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Token usage tracking** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Per-provider token stats** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (daily/weekly/monthly) |
| **Per-message token display** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Global usage panel** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Task duration tracking** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Task progress scroller** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

### API & programmability

| Capability | cc-switch | Ruflo | AionUi | Superset | Orca | CloudCLI | **MultiCC** |
|------------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **REST API for all operations** | ❌ | ✅ (MCP) | ❌ | ❌ | ❌ | ❌ | ✅ |
| **WebSocket real-time protocol** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Programmatic session creation** | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Webhook for external integrations** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Detached task API** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Wait/poll API** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

## Where MultiCC is unique

MultiCC is the only project in this list that is a **self-hosted server** rather than a desktop app or CLI tool. This architectural choice unlocks its differentiators:

1. **Always-on, headless operation.** Runs on your Mac mini / Linux box / VPS. No desktop needed. Agents keep working after you close your laptop.
2. **Multi-client per session.** Web, Flutter app, and IM bridges can all attach to the same session simultaneously — output fans out to all.
3. **IM-native.** Five IM bridges (WeChat, Feishu, Telegram, Discord, Slack) with bidirectional relay and `<<dispatch>>` confirmation. cc-connect does bridging only; MultiCC does bridging + orchestration.
4. **Scheduled & autonomous work.** Cron jobs with persistent context, wait/poll auto-resume, run-detached background tasks — agents continue without human nudges.
5. **Voice.** S2S real-time voice (VAD → ASR → LLM → TTS → barge-in) and classic STT with vocabulary learning. No other harness offers voice.
6. **Per-session provider isolation.** One session on Claude Max, another on DeepSeek, no env bleed. Other tools switch globally or don't manage providers.
7. **Per-role subagent routing — run the main loop on a frontier model, push the Task tool to a cheap one.** Claude Code's subagents are in-process sidechains that natively share the main Anthropic client — every other harness is stuck with that limit. MultiCC ships a local reverse proxy (`claude-proxy`) that inspects each `/v1/messages` request and routes the subagent to a *different* provider+model of your choice (`CLAUDE_CODE_SUBAGENT_MODEL=ccfw:<provider>:<model>`). Result: keep Opus/Fable for the hard thinking, offload exploration/grep/test/iteration to DeepSeek, GLM, Qwen, or Haiku — same repo, parallel worktrees, dramatically lower spend.

## Where MultiCC is weaker

- **No desktop IDE integration.** Superset and Orca offer diff viewers, inline editing, and IDE handoff. MultiCC's terminal is xterm.js in a browser — no native editor integration.
- **No SSH remote worktrees.** Orca supports running agents on a remote beefy machine via SSH. MultiCC runs everything on the server host.
- **No native GUI app.** cc-switch and AionUi are polished desktop apps. MultiCC is a web server (by design, but some users prefer a native app).
- **Smaller community.** The projects above have 10k–111k stars. MultiCC is newer and less known.
- **No swarm framework.** Ruflo offers 100+ specialized agents, self-learning memory, and federation. MultiCC's cross-session dispatch is simpler and more manual.

---

[← Back to the README](../README.md)
