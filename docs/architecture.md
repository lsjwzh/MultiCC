# Architecture reference

> Repository layout, message-flow diagrams, and the design decisions behind them.

```
multicc/
├── server.js                     # HTTP + WebSocket host: wires routes, tmux, CLI spawner, bridges
├── install.sh                    # One-command installer with OS detection
├── multicc                       # CLI service manager (start/stop/restart/status/log/update/install)
├── ecosystem.config.js           # PM2 config (alternative process manager)
│
├── src/                          # Server-side modules
│   ├── cli-switch.js             # Cross-CLI state machine + handoff checkpoint builder
│   ├── cli/                      # switch-runtime.js (switch + install routes), session-policy.js
│   ├── cli-adapters/             # One adapter per CLI: claude, codex, opencode, zcode, qoder
│   │                             #   + commands.js (binary resolution), router-mcp.js,
│   │                             #   zcode-bridge.cjs / zcode-engine.js / zcode-auth.js
│   ├── chat/                     # Turn engine, host coordinator, finalize plan, background tasks
│   ├── chat-stream.js            # Claude stream-json / Codex exec --json event normalizer
│   ├── message-composer.js       # Builds the prompt sent to a CLI (history, images, hints)
│   ├── providers.js              # Provider store, cc-switch import, per-session spawn env
│   ├── provider-router-*.js      # Local cli-provider-router proxy lifecycle (subagent routing)
│   ├── routes/                   # ~35 Express route modules (sessions, git, voice, providers…)
│   ├── ws/connection-router.js   # WebSocket path router (/, /ws/chat, /ws/voice, /ws/tts, …)
│   ├── git.js                    # Git worktree, merge/sync, auto-commit, syntax validation
│   ├── git-queue.js              # Serialized git operations (prevents concurrent conflicts)
│   ├── tmux.js                   # Tmux session management, pipe-pane, FIFO output
│   ├── network-policy.js         # Fail-closed bind policy (loopback unless explicitly allowed)
│   ├── auth-security.js          # HMAC cookies, timing-safe token compare, WS tickets
│   ├── request-locality.js       # Loopback detection (localhost bypasses ACCESS_TOKEN)
│   ├── directories.js / directory/ # Directory workspace registry & per-directory services
│   ├── dispatch/                 # MCP dispatch targeting, progress reduction, gateway host
│   ├── commander-*.js            # Agent Commander runtime + router
│   ├── task-board.js             # Shared task board store
│   ├── notes-store.js            # Inter-agent notes
│   ├── wait-service.js           # Durable callback/poll/delay state, exactly-once resolution
│   ├── wait-injector.js          # Legacy wait/recovery compatibility layer
│   ├── session-delivery.js       # Typed continuation/system/retry admission boundary
│   ├── detached.js               # run-detached task lifecycle (setsid, polling, completion)
│   ├── tts-service.js            # Edge/OpenAI/Volcano TTS with WebSocket streaming
│   ├── voice.js                  # Classic voice: STT + LLM refinement + vocabulary
│   ├── asr-local.js              # Local sherpa-onnx SenseVoice ASR
│   ├── push.js / push-runtime.js # VAPID, Bark, webhook notification delivery
│   ├── share.js                  # Session sharing (snapshot links, password auth)
│   ├── memory/ , memory-store.js # Per-session + shared agent memory
│   ├── skills.js , skill-sync/   # Claude/Codex skill discovery and conversion
│   ├── triggers/                 # post-turn | file-change | schedule triggers
│   ├── token-global.js           # Global token usage aggregation & stats
│   ├── tunnel.js                 # Tailscale Funnel & 花生壳 DDNS monitor
│   ├── paths.js                  # Canonical location of every state file
│   ├── shutdown.js               # Graceful shutdown / restart
│   ├── bus.js / services.js / state.js  # Event bus, service registry, in-memory state
│   └── … (~90 modules total)
│
├── plugins/                      # Optional subsystems, loaded by the host
│   ├── bridges/                  # IM gateways
│   │   ├── gateway-core.js       # Shared gateway session + reply flow
│   │   ├── wechat-ilink.js       # WeChat bridge (iLink API — current default)
│   │   ├── wechat-bridge.js      # WeChat bridge (legacy MCP variant)
│   │   ├── feishu-bridge.js      # Feishu/Lark long-connection bridge
│   │   ├── telegram-bridge.js    # Telegram bot bridge
│   │   ├── discord-bridge.js     # Discord bot bridge
│   │   └── slack-bridge.js       # Slack Socket Mode bridge
│   ├── cron/cron-tasks.js        # Recurring scheduled chat tasks
│   ├── voice/voice-asr.js        # Whisper-compatible STT integration
│   └── utils/                    # git-push.js, macos-power.js
│
├── public/                       # Zero-build static frontend
│   ├── index.html / client.js    # Terminal mode UI (xterm.js)
│   ├── chat.html / chat.js       # Chat mode UI (message bubbles, tool cards, inline images)
│   ├── chat-live-ui.js           # CLI switch picker, background-task danmaku, live overlays
│   ├── manage.html / manage.js   # Multi-session dashboard & admin panel
│   ├── wechat.html / wechat.js   # WeChat bridge UI
│   ├── events.html               # Directory event timeline viewer
│   ├── share.html                # Shared session snapshot viewer
│   ├── memo.html                 # Directory memo editor
│   ├── s2s-session.js            # Speech-to-Speech state machine
│   ├── vad-monitor.js            # Voice Activity Detection (RMS-based)
│   ├── voice-output.js           # TTS playback via Web Audio API
│   ├── voice-stream.js           # Voice capture client
│   ├── voice-worklet.js          # Audio processing worklet
│   ├── pwa.js / sw.js            # PWA registration + push + service worker
│   ├── tour.js                   # Mask-based onboarding guided tour
│   ├── i18n.js                   # Chinese/English internationalization
│   ├── manifest.json             # Web App Manifest
│   ├── agent-presets.json        # Agent role templates (Commander, Reviewer, Builder…)
│   ├── qrcode.min.js             # QR code generation
│   └── multicc.apk               # Latest Flutter APK (build output)
│
├── app/                          # Flutter native client (Android + iOS)
│   ├── lib/
│   │   ├── main.dart
│   │   ├── providers/            # ChatProvider, SessionProvider
│   │   ├── screens/              # Setup, Chat, SessionList, Dashboard
│   │   ├── services/             # Chat, Settings, Notification, Update
│   │   └── widgets/              # InputBar, MessageBubble, ToolCard, CliSwitchSheet
│   ├── android/                  # package com.multicc.multicc_app
│   └── ios/                      # bundle com.multicc.multiccApp
│
├── skills/                       # 76 Claude/Codex skill definitions
├── tests/                        # Deterministic unit + contract + governance suites
├── scripts/                      # Governance checks, i18n generation, router MCP shim
│
├── docs/                         # This documentation set + design & contract docs
│
├── sessions.json                 # Session registry (gitignored)
├── directories.json              # Directory workspace registry (gitignored)
├── providers.json                # Provider store with API keys (gitignored)
├── provider-defaults.json        # Default provider per CLI (gitignored)
├── scheduled_tasks.json          # Cron job definitions (gitignored)
├── task_board.json               # Shared task board (gitignored)
├── orchestration.json            # Orchestration/worker state (gitignored)
├── chat_history/                 # Per-session chat transcripts (gitignored)
├── events/                       # Per-directory event logs (gitignored)
├── detached/                     # run-detached task state (gitignored)
├── artifacts/                    # Uploaded / generated files (gitignored)
├── logs/                         # Server logs (gitignored)
├── voice_examples.json           # STT correction history (50-entry FIFO)
├── whisper_vocab.json            # Auto-learned vocabulary (100-term LRU)
├── token_usage.json              # Per-session token stats (gitignored)
├── token_daily.json              # Daily token stats windows (gitignored)
├── push_subscriptions.json       # Web Push subscription store
└── .env                          # Environment + secrets + VAPID keys (gitignored)
```

> State-file locations are resolved by `src/paths.js` and follow `MULTICC_DATA_DIR` when it is set.

## How a message flows

**Terminal mode:**

```
browser keystroke → ws → tmux send-keys → claude → tmux pipe-pane → FIFO → ws → xterm render
```

**Chat mode:**

```
user message
  → ws → server.js (CLI + provider abstraction)
  → claude stream-json or codex exec --json [resume/session id]
  → stdout JSON events normalized through src/chat-stream.js
  → buffered (last 500 events) for reconnect replay
  → fan-out to all attached clients (web + Flutter)
  → chat bubble render with live tool cards, inline images, token stats
```

**S2S voice mode:**

```
microphone → VAD (vad-monitor.js) → utterance ASR (/api/voice/stt) → LLM confirmation →
user "yes" → agent runs task → streaming TTS reads reply aloud →
user interrupts by speaking → agent stops → next turn
```

## Key design decisions

- **Vendor transcripts are never translated.** Cross-CLI continuity is a bounded, visible-text checkpoint (16 messages / 12000 chars + task state + git state), injected as a prompt prefix. Each CLI keeps its own native session, so switching back resumes that vendor conversation instead of replaying a lossy translation. See [Multi-CLI switching](cli-switching.md).
- **Fail-closed network binding.** `src/network-policy.js` refuses to start on a non-loopback host unless `MULTICC_ALLOW_REMOTE=1` is set explicitly. TLS is delegated to a front-end (Tailscale Funnel, ngrok, reverse proxy) rather than terminated in-process.
- **tmux for terminal, raw spawn for chat.** Terminal needs persistent TTY state that survives disconnects. Chat is turn-based — the server spawns the CLI per turn, relying on Claude `--resume` or Codex `exec resume` for continuity.
- **Provider isolation per child process.** Claude providers inject `ANTHROPIC_*` env vars only for that session's spawn. Codex providers materialize separate `CODEX_HOME` directories. The server strips any leaked env vars at startup.
- **Worktree-first concurrency.** Each session owns a branch + worktree. Merge/sync APIs move changes between session branches and the base branch — no shared mutable checkout.
- **No database for MultiCC state.** All state is in-memory `Map` objects persisted to flat JSON files. Fast, debuggable, no migration headaches. (SQLite appears only as a read-only reader for `cc-switch`'s provider database.)
- **Single auth layer.** `ACCESS_TOKEN` → HTTP-only `multicc_auth` cookie → applied uniformly to REST, WebSocket, and static files (JS/CSS exempted for login-page rendering).
- **Reconnect-safe chat.** Every WebSocket connect replays buffered events before going live, so the client deterministically rebuilds its bubble state.
- **Reliable continuation.** `wait`, `run-detached`, cron, and dispatch all re-enter a chat session through the same managed turn path — long-running work never gets lost between turns.
- **Syntax-gated merges.** Merge into the base branch is rejected if any `.js` file has syntax errors — broken code can't corrupt the shared branch.
- **Serialized git operations.** Concurrent git commands from multiple polled endpoints are queued through `src/git-queue.js` to prevent race conditions.

---

[← Back to the README](../README.md)
