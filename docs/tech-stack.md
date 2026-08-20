# Tech stack & runtime dependencies

> Component-by-component technology choices and the npm dependency list.

| Component | Technology |
|-----------|------------|
| **Server** | Node.js + Express + ws |
| **Terminal backend** | tmux + pipe-pane + named FIFO |
| **Chat backend** | Claude Code `stream-json` / Codex `exec --json`, normalized over WebSocket |
| **S2S voice** | Whisper STT + LLM confirmation + Edge/OpenAI/Volcano TTS + Web Audio API |
| **Provider routing** | MultiCC `providers.json`, optional `cc-switch` import, per-session env / `CODEX_HOME` isolation |
| **Codex proxy** | Responses ↔ chat/completions format transform for non-OpenAI endpoints |
| **Worktree orchestration** | Git worktrees + branches per session, serialized merge/sync APIs, syntax-gated merges |
| **Web frontend** | Vanilla JS, xterm.js 5.3, zero build step |
| **Mobile app** | Flutter 3.8, `xterm`, `web_socket_channel`, `shared_preferences`, `flutter_local_notifications` |
| **Voice STT** | Whisper (Groq / OpenRouter / OpenAI-compatible) |
| **Voice refinement** | OpenRouter LLM over SSE |
| **TTS** | Edge TTS (free) / OpenAI TTS / 火山引擎 TTS |
| **Notifications** | Web Push (VAPID) + Bark + Webhook + SpeechSynthesis + Flutter local notifications |
| **IM bridges** | WeChat (iLink), Feishu/Lark (Open Platform), Telegram (Bot API), Discord (Gateway), Slack (Socket Mode) |
| **Scheduler / waits** | Central cron tasks, per-session auto-triggers, server-owned wait/detached-task injector |
| **Public access** | Tailscale Funnel + 花生壳 DDNS monitor |
| **i18n** | zh/en via `public/i18n.js` + Flutter locale |
| **Token stats** | Per-provider daily/weekly/monthly/all-time aggregation from chat history |
| **TLS** | Not terminated in-process — MultiCC serves plain HTTP on loopback; use Tailscale Funnel / ngrok / a reverse proxy for public HTTPS |
| **CLI adapters** | One adapter per CLI (`src/cli-adapters/`) for claude, codex, opencode, zcode, qoder |
| **Service manager** | macOS `launchd` via `./multicc install`; systemd on Linux |

## Runtime dependencies

```
express                 ^4.22.2        HTTP server and routing
ws                      ^8.21.1        WebSocket server
better-sqlite3          ^12.6.2        Read-only cc-switch provider database import
cli-provider-router     (git pin)      Local proxy that routes per-role model traffic
sherpa-onnx-node        ^1.13.4        Local on-device ASR (SenseVoice)
multer                  ^2.2.0         Bounded multipart file uploads
web-push                ^3.6.7         VAPID push notifications
node-cron               ^4.2.1         Per-session schedule triggers
chokidar                ^5.0.0         File-change triggers
@larksuiteoapi/node-sdk ^1.71.1        Feishu/Lark long-connection bridge
discord.js              ^14.16.0       Discord Gateway bridge
node-telegram-bot-api   ^1.2.0         Telegram Bot bridge (lazy adapter)
@slack/bolt             ^4.2.0         Slack Socket Mode bridge
```

> **Zero frontend build step.** All web client code is plain JavaScript served as static files. Flutter and the Android toolchain are required only for an explicit App build from `/manage` or `./multicc apk`; server installation and updates do not invoke them.

---

[← Back to the README](../README.md)
