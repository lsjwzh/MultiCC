# Feature reference

> The complete feature catalogue, migrated out of the README. The README keeps a one-line summary of each area and links here for the detail.

## Two modes, one backend

| Mode | UI | Backend |
|------|----|---------|
| **Terminal** (`/`) | Full `xterm.js` — scrollback, colors, input, resize | `tmux` session, `pipe-pane` + named FIFO for reliable output |
| **Chat** (`/chat`) | Message bubbles with streaming tool cards, image previews, in-place CLI switching | Claude Code, Codex, OpenCode, ZCode, Kimi Code, or Qoder CN — events normalized over WebSocket |

Both modes share the same session registry, auth, and notifications. Reconnect replays the last 500 stream events so you never see a half-empty conversation.

## Multi-provider support

Each session picks its own CLI (`claude`, `codex`, `opencode`, `zcode`, `kimi`, or `qoder`). Claude/Codex/OpenCode can use MultiCC provider routing; ZCode drives its own engine config (`~/.zcode/cli/config.json`); Kimi Code uses its native login or OpenAI-format provider credentials injected per session; Qoder CN keeps its own signed-in account or BYOK configuration.

| CLI | Terminal mode | Chat mode | Provider isolation |
|-----|---------------|-----------|--------------------|
| **Claude Code** | `claude` inside `tmux`, resumed by session id | `claude -p --output-format stream-json` | Per-session `ANTHROPIC_*` env vars; clean default login for sessions without a provider override |
| **Codex** | `codex` / `codex resume <id>` inside `tmux` | `codex exec --json` | Per-provider `CODEX_HOME` under `~/.multicc/codex-homes`; local proxy for non-OpenAI endpoints |
| **OpenCode** | `opencode --session <id>` inside `tmux` | `opencode run --format json` | Uses the Claude-compatible provider pool; native session id retained per logical chat |
| **ZCode** | ZCode TUI (engine) inside `tmux` | in-tree bridge → `zcode.cjs --prompt --json` | Drives the headless engine inside the ZCode.app bundle; provider/auth owned by ZCode in `~/.zcode/cli/config.json`, located via `ZCODE_ENGINE` |
| **Kimi Code** | `kimi` inside `tmux`, resumed by `--session <id>` | `kimi -p <prompt> --output-format stream-json --auto` | Native `kimi login` device-code flow, or an OpenAI-format MultiCC provider injected as `KIMI_API_KEY`/`KIMI_BASE_URL` inside a per-session `KIMI_CODE_HOME` under `~/.multicc/kimi-homes` |
| **Qoder CN** | `qoderclicn --resume <id>` inside `tmux` | `qoderclicn -p --output-format stream-json` | Uses Qoder's own login/BYOK settings; native session id, model tier, reasoning effort, and agent retained per logical chat |

For Qoder CN, install the official CLI (`curl -fsSL https://qoder.cn/install | bash`), then run `qoderclicn` once to sign in or set `QODERCN_PERSONAL_ACCESS_TOKEN`. MultiCC auto-detects the `qoderclicn` executable and deliberately leaves Qoder account/BYOK management to Qoder itself. See the [Qoder CN quick start](https://docs.qoder.cn/cli/qoder-cli-cn-get-started-quickly).

For ZCode, install the official desktop app from [zcode.z.ai](https://zcode.z.ai), then point MultiCC at the headless engine bundled inside it: set `ZCODE_ENGINE` to `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` (the macOS default). ZCode owns its provider/auth in `~/.zcode/cli/config.json` — sign in via the desktop app or configure a provider (e.g. BigModel/GLM) there. In chat mode MultiCC does not invoke the Electron GUI; an in-tree bridge runs the engine headlessly and flattens its whole-JSON output into the streaming JSONL the chat UI consumes.

For Kimi Code, install the official CLI (`npm install -g @moonshot-ai/kimi-code` — also one-click installable from the CLI switcher), then sign in once with `kimi login` (OAuth device-code flow: MultiCC can open the verification page in the managed browser via `POST /api/kimi/auth/login`). Alternatively bind the session to an OpenAI-format MultiCC provider: MultiCC injects the provider's API key and base URL into an isolated per-session `KIMI_CODE_HOME` and fails closed when the binding loses its credentials.

- Providers are managed from `/manage` or the provider API — create, edit, import from `cc-switch`, set per-CLI defaults.
- **Per-session model selection**: each session can override the provider's default model; the chat UI shows a model picker with provider-specific options.
- **Provider-aware model options**: custom providers expose their own model lists (e.g., DeepSeek, GLM, Qwen) via `modelOptions`.
- **Per-role subagent routing (cost optimization)**: each Claude session can set a separate `subagent = { providerId, model }`. The main loop runs on your frontier model (Opus/Fable/Sonnet); Task-tool subagents — exploration, grep, file reads, test iteration — are routed through the local `claude-proxy` to a cheaper provider+model of your choice. Configure per session via the chat UI or the session API. Native Claude Code only lets subagents inherit the main client; MultiCC is the only harness that routes them independently.

  | Role | Suggested model | Why |
  |------|-----------------|-----|
  | Main loop | Opus / Fable / Sonnet | Hard reasoning, planning, edits |
  | Subagent (Task tool) | DeepSeek-V3 / GLM / Qwen / Haiku | Cheap, fast, good enough for grep/read/test |

## Session orchestration

- **Git worktree isolation.** Each normal session runs in `<repo>/.multicc-worktrees/<sessionId>` on branch `multicc/<sessionId>`. Parallel agents edit safely; merge/sync APIs move changes between session branches and the base branch.
- **Agent Commander.** Every new directory is seeded with an Agent Commander chat session — a fleet conductor that can coordinate specialized sibling sessions. Comes with role presets for common agent profiles.
- **MCP-only cross-session dispatch.** `route_task` is one-way. `dispatch_master` requires `mode="sync"` (stream safe, provider-emitted reasoning plus worker progress and return inline) or `mode="async"` (return after admission; `dispatch_slave` later inserts a result message and wakes the caller). The retired HTTP and text-marker paths are not executable.
- **In-place cross-CLI handoff (chat sessions only).** A chat can switch among Claude, Codex, OpenCode, ZCode, Kimi Code, and Qoder CN without changing its logical session or worktree. Terminal sessions are fixed to the CLI they were created with. See [Multi-CLI switching](cli-switching.md). Each CLI keeps an independent native session and settings snapshot; a bounded checkpoint of visible conversation, task state, and Git state bridges the semantic context. Vendor JSONL files are never rewritten or shared.
- **Passive inter-agent notes.** Sessions leave notes for siblings in the same directory; notes are prepended to the target agent's next chat turn.
- **Syntax-gated merges.** Merge is rejected if a session's changes introduce JS syntax errors — broken code can't reach the base branch.
- **Auto-commit + auto-sync.** Sessions auto-commit before merging; after a successful merge, sibling worktrees in the same directory are synced to the new base automatically (conflicting ones are skipped and reported as `siblingsSynced` on the merge response).

## Task board

Tasks filed from any surface (voice, IM bridges, chat, the board itself) run on pooled headless slots, fully outside your interactive sessions:

- **Unified task chat view.** `chat.html?task=<taskId>` is the same renderer as a session chat — paginated history, tool cards, run separators, and a composer that queues the task's next run. Task transcripts project from the task-run ledger under the identical DTO/pagination contract as session history (pinned by a shared golden test), and live output streams in via `task_run_stream` envelopes on the directory socket.
- **Pending-question card, everywhere.** A run that needs a decision raises one card in the task's chat view; answering it (card tap or composer text) resolves the waiting run over the same transport — no separate task-board answer UI. The Flutter app renders the same question from the run projection and live-refreshes the task detail while a run streams.
- **Per-task worktree.** Code-editing tasks run in `<repo>/.multicc-worktrees/task-<hash>` on branch `multicc/task-<hash>`, stable across all of a task's runs (diff continuity). Row-level actions on the board: merge back to base, cleanup worktree, complete/reopen, reclassify.
- **Board as the fleet view.** AI-grouped modules with a pending bucket, run-state aggregation per task, backfill progress for archived history, and read-only archive pages that reuse the same list renderer.

## Long-running & scheduled work

- **Wait/poll.** Agents register poll or callback waits; MultiCC injects results back into the chat session when the condition resolves — no human nudge needed.
- **`run-detached`.** Long builds, tests, deploys run with `setsid` outside the session lifecycle. Completion auto-registers a wait and sends exit code + output tail back.
- **Cron jobs.** Recurring tasks with standard 5-field cron expressions, each owning a persistent chat session so context carries across runs.
- **Per-session auto-triggers.** Post-turn, file-change, and schedule triggers wake sessions automatically, with cooldowns and manual test firing.
- **Progress-friendly defaults.** The system prompt steers agents toward `run-detached` or explicit waits instead of fragile background shell jobs.

## Speech-to-Speech (S2S) real-time voice

Talk to your agents like a phone call — the newest voice mode:

- **Real-time VAD** (Voice Activity Detection) with RMS-based adaptive noise floor — speaks when you speak, listens when you listen.
- **Utterance-level ASR**: VAD segments your speech and the captured utterance is transcribed on silence via the Whisper-compatible `/api/voice/stt` endpoint. (The local sherpa-onnx ASR described under *Voice input (classic mode)* is a separate path and is not used by S2S.)
- **LLM confirmation** refines the recognized text into a structured task list; you confirm with a tap or "yes."
- **Streaming TTS** reads the agent's reply aloud as it arrives; supports Edge TTS (free), OpenAI TTS, and 火山引擎 TTS.
- **Barge-in interrupt**: start speaking and TTS playback stops immediately so the agent listens.
- **Progress summaries**: the agent gives spoken status updates during long tasks.

Powered by: `public/s2s-session.js` (state machine), `public/vad-monitor.js` (VAD), `public/voice-output.js` (TTS player), `src/tts-service.js` (server-side TTS).

## Voice input (classic mode)

- **Whisper STT** through any OpenAI-compatible endpoint (Groq, OpenRouter, self-hosted).
- **AI refinement** streams raw text through an LLM and replaces filler with precise technical language — delivered over SSE.
- **Vocabulary learning loop.** Accepted corrections feed into `whisper_vocab.json` and are sent as the Whisper `prompt` parameter — the system gets better at your project's jargon over time.

## Multi-client per session

- Multiple browser tabs, phones, and the Flutter app can attach to the same session and see output in sync.
- **Reconnect replay**: a rolling buffer of 500 stream events backfills chat bubbles on reconnect — never see a half-empty conversation after waking the screen.
- **Persistent chat history**: every message is stored in `chat_history/<sessionId>.json` with token counts and timing.

## Token usage & cost tracking

- **Per-provider stats**: daily, weekly, monthly, and all-time token counts for every provider (Claude, Codex, custom endpoints).
- **Per-session breakdown**: each chat message shows input/output tokens and provider attribution.
- **Global usage panel**: `/manage` shows cumulative token usage across all sessions, including Codex session tokens from `~/.codex/sessions`.
- **Live display**: the chat header bar shows per-provider token consumption in real time.

## Notifications

Five delivery channels, triggered when the agent finishes or needs input — and only when you're not actively watching:

| Channel | Reach | Use case |
|---------|-------|----------|
| **Web Push (VAPID)** | Any browser / PWA | Laptop in another room, phone in your pocket |
| **Bark** | iOS `Bark` app | Reliable iOS push without Apple certs |
| **Webhook** | Any HTTP endpoint | Pipe into Slack, Lark, n8n, Home Assistant |
| **In-app voice alert** | Browser `speechSynthesis` | "Task completed" speaks aloud at your desk |
| **Flutter local notification** | Android notification tray | Lock-screen alerts when the app is backgrounded |

## Multi-IM bridges

MultiCC can be your agents' gateway to the world — reply from WeChat, Feishu, Telegram, Discord, or Slack:

| Bridge | Transport | Gateway session | Setup |
|--------|-----------|-----------------|-------|
| **WeChat** (iLink) | PC WeChat API | `__gateway__` | iLink WeChat plugin |
| **Feishu / Lark** | Open Platform long-connection | `__feishu_gateway__` | App ID + Secret in `/manage` |
| **Telegram** | Bot API long-polling | `__telegram_gateway__` | Bot token from @BotFather |
| **Discord** | Gateway WebSocket | `__discord_gateway__` | Bot token + intents |
| **Slack** | Socket Mode | `__slack_gateway__` | App token + bot token |

All bridges support:
- Bidirectional relay between IM and a MultiCC chat session.
- MCP dispatch with bridge-specific confirmation — the agent proposes a task, you confirm in-chat where required, then the Gateway calls `dispatch_master(mode="async")`; the result returns as a new message.
- Live SSE log stream in the browser UI.
- Start/stop controls and credential management from `/manage`.

## Flutter native app

A real Flutter app (Android + iOS), not a wrapped webview:

- **Multi-session sidebar** with swipe-to-close, unread badges, and per-session working directory.
- **xterm terminal widget** and a custom chat UI with message bubbles, tool cards, and inline images.
- **Background notifications** via `flutter_local_notifications` + the server's push pipeline.
- **In-app APK auto-update**: uses the server's local-first `/multicc.apk` source and offers one-tap install from either the local package or the verified exact-version Release Asset.
- **Voice capture** with waveform visualization.
- **Task progress scroller** on the home screen showing real-time session status.
- **KPI dashboard**: active sessions, waiting sessions, cron jobs — all tappable for drill-down.
- **Directory management**: drag-to-reorder, compact preview cards, detail sheets.

## Web dashboard (`/manage`)

A single operational surface for everything:

- **Directory workspace view**: session counts, git push status, merge state, real-time activity indicators.
- **Session cards** with status (idle/completed/thinking/editing/running/waiting/error), cwd, provider, client count, last activity, and rainbow border animation when active.
- **Task progress scroller**: live scrolling feed of what each session is doing — shown on the home page.
- **Inline terminal**: click a session card to open its terminal in a large modal — no new tabs needed.
- **Session creation wizard**: multi-step flow (name → role preset → provider → model → create) with provider-aware model options.
- **Git worktree management**: view ahead/behind/conflict state, sync from base, merge to base, push base branch — all one-click.
- **Provider management**: import from `cc-switch`, create/edit/delete local providers, set CLI defaults, switch per-session.
- **Cron job panel**: create, edit, disable, manually run, and delete recurring tasks.
- **Wait/detached task inspector**: see what's pending and what's running in the background.
- **Public tunnel toggle**: enable Tailscale Funnel or monitor 花生壳 DDNS for external access.
- **QR code**: LAN IP + access token for instant phone onboarding.
- **APK download source**: download a non-empty local APK when present; otherwise use only the verified `multicc.apk` asset from the GitHub Release matching the current package version.
- **Onboarding tour**: mask-based guided walkthrough for new users.

## Session sharing

- Share selected chat messages as a **read-only snapshot link** — perfect for showing results to teammates.
- Optional password protection and operation permission.
- Shared sessions render with the same message bubbles and tool cards as the original.

## i18n (Internationalization)

- Both web UI and Flutter app support **Chinese (zh)** and **English (en)**.
- Default language is Chinese (`zh`); switch to English in settings. The choice is remembered per device (`multicc_lang` in `localStorage` on web, shared preferences in the app).
- All UI strings, status labels, error messages, and notifications are translated.

## Public access (tunnel)

- **Tailscale Funnel**: one-click toggle in `/manage` to expose your MultiCC server to the public internet via Tailscale.
- **花生壳 (phtunnel) monitor**: optional shell watchdog that restarts the DDNS client if the public URL goes unreachable.
- Both tunnel modes are managed from the dashboard with live status indicators.

## Security

- Optional `ACCESS_TOKEN` gates every API/WebSocket endpoint.
- `multicc_auth` HTTP-only cookie for sticky browser sessions.
- Localhost connections bypass the token.
- **Plain HTTP by default.** MultiCC does not terminate TLS itself. Browser APIs that need a secure context (microphone, PWA install, service worker) work over `http://localhost`; for any other host, put a real TLS front-end in front of it — Tailscale Funnel, ngrok, or your own reverse proxy.
- **Zero-config, password-gated LAN access.** Installer-created instances automatically bind the IPv4 LAN because they already have an `ACCESS_TOKEN`; tokenless starts stay loopback-only, LAN peers never bypass authentication, and explicit non-loopback binds remain fail-closed behind `MULTICC_ALLOW_REMOTE=1`. Public ingress is not created automatically.

## Server resilience

- **Port auto-selection (development only)**: with `NODE_ENV=development` or `MULTICC_DEV=true`, an occupied port rolls over to the next free one. In production an occupied port is a hard startup failure, so you always know which port you are on.
- **Graceful shutdown**: drains in-flight chat turns on SIGTERM/SIGINT instead of dropping them.
- **Crash recovery**: TTS service handles missing binaries gracefully; VAPID keys auto-generate on first run.
- **Syntax-gated merges**: JS files are validated before merging into the base branch.
- **Self-update**: `./multicc update` pulls, reinstalls dependencies if the manifests changed, and restarts — stashing and restoring local changes around the fast-forward, since the running server keeps the tree dirty by itself. `./multicc update --force` skips that dance and lands on the remote's code whatever the local history is, stashing local work to `multicc-force-update-<timestamp>` without restoring it. The same run is one click from the version number in the `/manage` sidebar, and its state lives in `logs/update.log` — so the restarted server can still report how the update it was launched by ended. See [Installation](installation.md#when-the-working-tree-is-dirty-or-the-history-diverged).

---

[← Back to the README](../README.md)
