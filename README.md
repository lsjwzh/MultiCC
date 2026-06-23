<p align="center">
  <img src="public/icon.svg" width="120" height="120" alt="MultiCC Logo" />
</p>

<h1 align="center">MultiCC</h1>

<p align="center">
  <strong>One Claude Code instance. Many clients. Any device.</strong>
</p>

<p align="center">
  <a href="#what-is-multicc">What it is</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#configuration">Configuration</a> &bull;
  <a href="#api-reference">API</a> &bull;
  <a href="#faq">FAQ</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js >=18" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/flutter-Android%20%7C%20iOS-02569B" alt="Flutter app" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
</p>

---

## What is MultiCC?

**MultiCC** (Multi-Client Claude Code) is a self-hosted server that lets you drive one local [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI from a browser, a PWA, a native Flutter app (Android/iOS), or even a WeChat chat — all at the same time, all against the same persistent sessions.

It is designed around three observations:

1. **Claude Code sessions should outlive the client.** You open a task on your laptop, walk away, and want to keep an eye on it from your phone. MultiCC runs sessions in `tmux` so disconnecting never kills progress.
2. **One UI can't serve every moment.** Sometimes you want a full terminal; sometimes a chat bubble is enough; sometimes you just want push notifications when Claude is waiting. MultiCC ships multiple front-ends against one backend.
3. **Voice is the fastest input on a phone.** Dictate in Chinese or English, let Whisper transcribe, let an LLM rewrite it into a precise technical prompt. Corrections feed back into the vocabulary so the system gets sharper the more you use it.

```
        ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
        │ Desktop Web  │   │  Mobile PWA  │   │ Flutter App  │   │   WeChat     │
        │ (Terminal)   │   │    (Chat)    │   │  (Android)   │   │   Bridge     │
        └──────┬───────┘   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
               │                  │                  │                  │
               ▼                  ▼                  ▼                  ▼
        ┌──────────────────────────────────────────────────────────────────────┐
        │                  MultiCC Server (Express + ws + HTTPS)               │
        │   ┌────────────────────────┐         ┌────────────────────────┐     │
        │   │  tmux session backend  │         │ Claude stream-json     │     │
        │   │  (terminal mode)       │         │ spawner (chat mode)    │     │
        │   └──────────┬─────────────┘         └──────────┬─────────────┘     │
        │              ▼                                   ▼                   │
        │         claude CLI                          claude --output-format  │
        │                                             stream-json              │
        └──────────────────────────────────────────────────────────────────────┘
```

---

## Features

### Two modes against the same backend

| Mode | UI | Backend |
|------|----|---------|
| **Terminal** (`/`) | Full `xterm.js` — scrollback, colors, input, resize | `tmux` session, `pipe-pane` + named FIFO for reliable output capture |
| **Chat** (`/chat`) | Message bubbles with streaming tool cards | `claude --output-format stream-json` — events forwarded live over WebSocket; `AskUserQuestion` is disabled by default so headless chat asks follow-up questions as normal text |

Both modes share the same session registry, auth layer, and notification pipeline.

### Multi-client per session

- Multiple browser tabs / devices can attach to the same session and see output in sync.
- Reconnect is instant on foreground: a rolling replay buffer (last 500 stream events) backfills chat bubbles so you never see a half-empty conversation after the screen wakes up.
- Flutter app and web UI can talk to the same `chat` session concurrently.

### Flutter native app

- Rewrite of the old Capacitor webview client — now a real Flutter app with `xterm` terminal widget and a custom chat UI.
- **Multi-session sidebar** with swipe-to-close, unread badges, and per-session cwd.
- **Background notifications** via `flutter_local_notifications` + the server's Web Push/Bark pipeline.
- **In-app APK auto-update**: the app pings the server's `/multicc.apk` mtime and offers a one-tap update when a newer build is available.
- **Voice capture** using the `record` plugin with waveform.
- Distributed as a signed APK via `/manage` → APK button.

### Voice input

- **Whisper STT** through any OpenAI-compatible endpoint (Groq, OpenRouter, self-hosted).
- **AI refinement** streams raw text through an LLM (default: OpenRouter) and replaces filler/hallucinations with precise technical language — delivered over SSE with first-token and total-latency metrics.
- **Vocabulary learning loop.** Every time you accept a refined result (or edit it), the diff is stored in `voice_examples.json`; terms that keep appearing are promoted into `whisper_vocab.json` and fed back as the Whisper `prompt` parameter, so Whisper gets better at your project's jargon over time.

### Notifications

Three delivery channels, all triggered from the same "waiting / completed" detector:

| Channel | Reach | Typical use |
|---------|-------|-------------|
| **Web Push (VAPID)** | Any browser / PWA with push permission | Laptop in another room, phone in your pocket |
| **Bark** | iOS `Bark` app | Reliable iOS push without Apple certs |
| **Webhook** | Any HTTP endpoint | Pipe into Slack, Lark, n8n, Home Assistant |
| **In-app voice alert** | Browser `speechSynthesis` (foreground only) | Desk laptop — "task completed" speaks aloud |
| **Flutter local notification** | Android notification tray | Lock-screen alerts when the app is backgrounded |

Alerts fire only when the originating client is **not** looking at the session — no interruptions while you're actively reading output.

### Multi-session dashboard (`/manage`)

- Visual cards for every tmux session (status, cwd, client count, last activity).
- Click a card to open its terminal in an inline iframe — no new tabs.
- Per-session WebSocket monitors tag sessions as `waiting` / `completed` in real time.
- One-click **QR code** with LAN IP + access token for phone onboarding.
- **Voice settings panel** (OpenRouter/Whisper keys, models, vocabulary) hot-reloaded without restart.
- **Notification settings** for Web Push subscribe/unsubscribe, Bark URL, Webhook URL.
- **APK download** button that serves the latest Flutter build.
- **phtunnel/花生壳 monitor** (optional) — a shell watchdog that restarts the Phtunnel DDNS app if the public URL goes unreachable.

### WeChat bridge (`/wechat`)

Two implementations share the same UI:

- **iLink bridge** (`wechat-ilink.js`) — current default. Uses the iLink WeChat API to relay messages; works with PC WeChat.
- **MCP bridge** (`wechat-bridge.js`) — legacy. Talks to a `wechat-mcp` server over JSON-RPC.

Features (both):

- Bidirectional relay between a WeChat contact/group and a MultiCC session.
- Hash-based deduplication to break echo loops.
- In-WeChat commands: `/help`, `/status`, `/sessions`, `/bind <id>`.
- Live SSE log stream in the browser UI.

### Security

- Optional `ACCESS_TOKEN` gates every API/WebSocket endpoint.
- `multicc_auth` HTTP-only cookie minted from the token for sticky browser sessions.
- Localhost connections bypass the token.
- Self-signed HTTPS certificate auto-generated with SAN entries for every local IP, auto-renewed when your IP changes (required for microphone + PWA).

---

## Quick Start

### One-Click Install

```bash
curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/main/install.sh | bash
```

This auto-detects your OS, checks prerequisites, clones the repo, installs dependencies, configures an access token, and optionally installs as a background service.

Options:

```bash
curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/main/install.sh | bash -s -- \
  --port 8080 --token mysecrettoken --no-service
```

| Flag | Description |
|------|-------------|
| `--dir <path>` | Install into this directory (default: `./MultiCC`) |
| `--token <xxx>` | Pre-set ACCESS_TOKEN (default: auto-generate) |
| `--port <port>` | Server port (default: `3000`) |
| `--no-service` | Skip launchd/systemd service install |
| `--no-clone` | Use current directory; don't clone |
| `--branch <name>` | Git branch to clone (default: `main`) |

After install:

```bash
cd MultiCC && ./multicc start     # start server
cd MultiCC && ./multicc install   # install as background service (macOS)
```

### Prerequisites

- **Node.js** >= 18
- **tmux** (for terminal mode; chat mode does not need it)
- **Claude Code CLI** — `claude` on your PATH, already logged in
- **Flutter** 3.8+ (only if you want to build the native app yourself)

### Manual Install (alternative)

```bash
git clone https://github.com/lsjwzh/MultiCC.git
cd MultiCC
npm install
node server.js
```

The server prints its access URL on startup — open `http://localhost:3000/chat` to begin. Other devices on the same network append `?token=<ACCESS_TOKEN>` (find it in your `.env` file).

### Service management

```bash
./multicc start       # start server
./multicc stop        # stop server
./multicc restart     # restart server
./multicc status      # check if running
./multicc log         # tail live logs
./multicc install     # install launchd agent (macOS auto-start)
./multicc uninstall   # remove launchd agent
```

On Linux, set up a systemd user service:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/multicc.service <<'UNIT'
[Unit]
Description=MultiCC Server
After=network.target
[Service]
ExecStart=$(which node) $PWD/server.js
WorkingDirectory=$PWD
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now multicc
```

### Build the Flutter app

```bash
cd app
flutter pub get
flutter build apk --release           # Android
flutter build ios --release --no-codesign   # iOS (needs Xcode + signing to install)
```

The release APK is at `app/build/app/outputs/flutter-apk/app-release.apk`; the `/manage` page serves `public/multicc.apk`.

---

## Configuration

All configuration is environment-variable driven. Voice settings additionally hot-reload when edited via the dashboard UI.

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3443` (HTTPS) / `3000` (HTTP) | Listen port |
| `ACCESS_TOKEN` | *(none)* | Gate all endpoints; localhost always bypassed |
| `CLAUDE_CMD` | *(auto-detected)* | Override path to the `claude` binary |
| `CLAUDE_ARGS` | *(none)* | Extra CLI args passed to every spawned `claude` |
| `CLAUDE_CHAT_DISALLOWED_TOOLS` | `AskUserQuestion` | Comma-separated Claude tools disabled only in chat mode. Keep `AskUserQuestion` disabled unless you implement a custom ask bridge for headless chat. |

### Voice — LLM refinement

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | *(none)* | API key for the refinement LLM |
| `OPENROUTER_MODEL` | `google/gemini-2.0-flash-001` | Model name |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible base URL |

### Voice — Whisper STT

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_API_KEY` | *(falls back to `OPENROUTER_API_KEY`)* | API key |
| `WHISPER_BASE_URL` | `https://openrouter.ai/api/v1` | e.g. `https://api.groq.com/openai/v1` |
| `WHISPER_MODEL` | `whisper-large-v3-turbo` | Model name |
| `WHISPER_LANGUAGE` | `zh` | ISO 639-1 language hint |
| `WHISPER_PROMPT` | *(none)* | Static vocabulary hints (auto-learned terms merge with this) |

### Notifications

| Variable | Default | Description |
|----------|---------|-------------|
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | *(auto-generated)* | Web Push keys — written to `.env` on first run |
| `BARK_URL` | *(none)* | Bark push endpoint, e.g. `https://api.day.app/<your-key>` |
| `WEBHOOK_URL` | *(none)* | Generic webhook URL — receives JSON `{ title, body, type, sessionId, url }` |

---

## Architecture

```
multicc/
├── server.js                   # Main server — Express, ws, tmux, chat spawner, voice, push
├── wechat-ilink.js             # WeChat bridge (iLink API — current default)
├── wechat-bridge.js            # WeChat bridge (legacy MCP variant)
├── multicc                     # Launchd service manager script
├── phtunnel-monitor.sh         # Optional DDNS watchdog
├── package.json
├── .env                        # Environment + VAPID keys
│
├── public/                     # Zero-build static frontend
│   ├── index.html / client.js  # Terminal mode UI
│   ├── chat.html   / chat.js   # Chat mode UI
│   ├── manage.html             # Multi-session dashboard
│   ├── wechat.html             # WeChat bridge UI
│   ├── pwa.js / sw.js          # PWA registration + push subscription + service worker
│   ├── manifest.json           # Web App Manifest
│   ├── icon.svg
│   └── multicc.apk             # Served by /multicc.apk (build output, gitignored)
│
├── app/                        # Flutter native client (Android + iOS)
│   ├── lib/
│   │   ├── main.dart
│   │   ├── providers/          # ChatProvider, SessionProvider
│   │   ├── screens/            # SetupScreen, ChatScreen, SessionListScreen
│   │   ├── services/           # ChatService, SettingsService, NotificationService, UpdateService
│   │   └── widgets/            # InputBar (voice + file picker), MessageBubble, ToolCard
│   ├── android/                # package com.multicc.multicc_app
│   └── ios/                    # bundle com.multicc.multiccApp
│
├── sessions.json               # Persisted session registry (gitignored)
├── chat_history/               # Per-session chat transcripts (gitignored)
├── voice_examples.json         # STT correction history (50-entry FIFO)
├── whisper_vocab.json          # Auto-learned vocabulary (100-term LRU)
├── push_subscriptions.json     # Web Push subscription store
├── wechat-config.json          # WeChat bridge configuration
└── cert.pem / key.pem          # Auto-generated self-signed TLS cert
```

### How a message flows

**Terminal mode:**

```
browser keystroke → ws → tmux send-keys → claude → tmux pipe-pane → FIFO → ws → xterm render
```

**Chat mode:**

```
user message
  → ws → server.js (chatProviderSpawn)
  → claude --output-format stream-json [--resume <id>]
  → stdout stream-json events
  → server buffers last 500 events for reconnect replay
  → fan-out to all attached clients (web + Flutter)
  → chat bubble render with live tool cards
```

**Key design decisions:**

- **tmux for terminal, raw spawn for chat.** Terminal needs persistent TTY-backed state and survives disconnects via tmux. Chat is turn-based, so the server spawns `claude` per user turn, relying on `--resume` to keep conversational continuity.
- **No database.** All state is in-memory `Map` objects persisted to flat JSON files.
- **Single auth layer.** `ACCESS_TOKEN` → HTTP-only `multicc_auth` cookie → applied uniformly to REST, WebSocket, and static file routes (with JS/CSS exemption for login-page rendering).
- **Vocabulary learning loop.** Corrections flow from `/api/voice/feedback` → `voice_examples.json` → frequency ranking → `whisper_vocab.json` → Whisper `prompt` param.
- **Reconnect-safe chat.** Every chat WS connect replays the buffered events before resuming live, so the client can rebuild its bubble state deterministically.

---

## API Reference

### Directories

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/directories` | List directories with session counts and Git push status |
| `POST` | `/api/directories/:id/push` | Push the directory base branch to its configured remote |

### Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/sessions` | List all sessions |
| `GET` | `/api/sessions/:id` | Get session details |
| `DELETE` | `/api/sessions/:id` | Kill and delete a session |
| `POST` | `/api/sessions/:id/relocate` | Change session's working directory |
| `POST` | `/api/sessions/:id/restart` | Restart a dead terminal session in place |
| `GET` | `/api/agent-resources/skills` | List installed Claude and Codex skills |
| `GET` | `/api/agent-resources/claude-sessions` | List Claude Code history sessions |
| `DELETE` | `/api/agent-resources/claude-sessions/:project/:id` | Delete one unlinked Claude history session |
| `DELETE` | `/api/agent-resources/claude-sessions?olderThanDays=N` | Delete unlinked Claude history older than N days |

### Files

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/files?path=<dir>&session=<id>` | List directory contents |
| `GET` | `/api/download?path=<file>&inline=<bool>` | Download or preview a file |

### Voice

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/voice/stt` | Multipart audio upload → Whisper transcription |
| `POST` | `/api/voice/refine` | `{ raw }` → SSE stream of refined text |
| `POST` | `/api/voice/feedback` | `{ raw, refined, userFinal }` → correction log |
| `GET` | `/api/voice/vocab` | Learned vocabulary terms |
| `DELETE` | `/api/voice/vocab/:term` | Remove a term |
| `GET` / `POST` | `/api/settings/voice` | Get / update voice configuration (hot-reload) |
| `GET` / `POST` | `/api/settings/power` | Read / update macOS lid-sleep prevention (macOS only; administrator authorization required) |

### Push / Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/push/vapid-key` | VAPID public key |
| `POST` / `DELETE` | `/api/push/subscribe` | Register / remove push subscription |
| `POST` | `/api/push/test` | Fire a test push to all subscribers |
| `POST` | `/api/bark/test` | Fire a test Bark push |
| `POST` | `/api/webhook/test` | Fire a test webhook |

### WeChat Bridge

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/wechat/status` | Bridge running state |
| `GET` / `POST` | `/api/wechat/config` | Get / update bridge config |
| `POST` | `/api/wechat/start` | Start bridge |
| `POST` | `/api/wechat/stop` | Stop bridge |
| `POST` | `/api/wechat/send` | Send message to PTY or WeChat (`{ text, target }`) |
| `GET` | `/api/wechat/log` | Message log (`?since=<ms>`) |
| `GET` | `/api/wechat/events` | SSE stream of live log entries |

### Server Info & Update

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/server-info` | Server IP, port, protocol, URL, token |
| `GET` | `/multicc.apk` | Latest Flutter APK (served from `public/multicc.apk`) |

### WebSocket Protocol

**Terminal mode:** `ws[s]://host/?id=<sessionId>&token=<token>`

```jsonc
// Client -> Server
{ "type": "input",  "data": "ls -la\r" }
{ "type": "resize", "cols": 120, "rows": 40 }
{ "type": "upload", "tempId": "up_xxx", "name": "file.txt", "mime": "text/plain", "data": "<base64>" }

// Server -> Client
{ "type": "session_id", "id": "a1b2c3d4" }
{ "type": "output",     "data": "..." }
{ "type": "exit",       "data": "..." }
{ "type": "relocate",   "cwd": "/new/path" }
{ "type": "file_saved", "tempId": "up_xxx", "path": "/tmp/multicc_xxx.txt", "name": "file.txt" }
```

**Chat mode:** `ws[s]://host/chat?id=<sessionId>&token=<token>`

```jsonc
// Client -> Server
{ "type": "user_message", "text": "refactor server.js", "files": [...] }
{ "type": "cancel" }          // abort the in-flight turn
{ "type": "clear" }           // wipe history and start a fresh claude session

// Server -> Client
{ "type": "system",    "subtype": "init", "is_streaming": false, "session_id": "..." }   // only the server's own init carries is_streaming
{ "type": "stream_event", "event": { /* Claude stream-json event */ } }
{ "type": "turn_end",  "ok": true }
{ "type": "error",     "error": "..." }
```

---

## FAQ

### "Certificate warning" on first visit

Expected. MultiCC generates a self-signed cert for HTTPS (required for microphone + PWA). Click **Advanced** → **Proceed** once per device.

### Claude command not found

MultiCC searches common install paths on startup. If it still can't find `claude`, set the env var:

```bash
echo 'CLAUDE_CMD=/path/to/claude' >> .env
```

### "此浏览器不支持录音"

`MediaRecorder` requires a secure context. Make sure you're on `https://` (or `http://localhost`) and that you've accepted the certificate.

### Flutter app can't reach the server from my phone

- Check the phone is on the same LAN.
- Open `https://<your-ip>:3443` in the phone's browser first and accept the cert — the Flutter app piggybacks on the system trust store.
- Confirm `ACCESS_TOKEN` is set in the Flutter setup screen if the server has one.

### tmux sessions pile up

Terminal-mode sessions are named `multicc-<id>`. To clean up orphans:

```bash
tmux list-sessions | grep multicc | cut -d: -f1 | xargs -I{} tmux kill-session -t {}
```

### I upgraded from WebCC and my app settings are gone

The rename changed persistence keys (`webcc_*` → `multicc_*`) and the Android/iOS package identifiers (`com.webcc.*` → `com.multicc.*`). Consequences:

- **Web UI:** you'll get logged out once, and notification/voice toggles reset to defaults.
- **Flutter app:** install it as a **new app** (old one stays side-by-side until you uninstall it). Setup screen will ask for host / token / session again.
- **launchd service:** `./webcc uninstall` first under the old checkout, then `./multicc install` under the new checkout — the `Label` changed from `com.webcc.server` to `com.multicc.server`.
- **Running tmux sessions** named `webcc-*` are orphaned; kill them with the command above (substituting `webcc`).

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| **Server** | Node.js + Express + ws |
| **Terminal backend** | tmux + pipe-pane + named FIFO |
| **Chat backend** | `claude --output-format stream-json` with `--resume` |
| **Web frontend** | vanilla JS, xterm.js 5.3, zero build step |
| **Mobile app** | Flutter 3.8, `xterm`, `web_socket_channel`, `shared_preferences`, `flutter_local_notifications` |
| **Voice STT** | Whisper (Groq / OpenRouter / OpenAI-compatible) |
| **Voice refinement** | OpenRouter LLM over SSE |
| **Notifications** | Web Push (VAPID) + Bark + generic webhook |
| **WeChat** | iLink API (default) or MCP (legacy) |
| **TLS** | Auto-generated self-signed certs with SAN IPs |
| **Service manager** | macOS `launchd` via `./multicc install` |

### Runtime dependencies

```
express          ^4.18.2    HTTP server and routing
ws               ^8.16.0    WebSocket server
multer           ^1.4.5     Multipart file upload handling
web-push         ^3.6.7     VAPID push notifications
node-pty         ^1.0.0     PTY fallback (terminal recovery path)
better-sqlite3   ^12.6.2    Reserved for future features
```

> **Zero frontend build step.** All web client code is plain JavaScript served as static files.

---

## License

MIT. See [LICENSE](LICENSE).

---

<p align="center">
  <sub>Built with Claude Code · https://github.com/lsjwzh/MultiCC</sub>
</p>
