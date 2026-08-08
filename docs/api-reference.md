# HTTP & WebSocket API reference

> Every documented endpoint, migrated out of the README.

## Directories

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/directories` | List directories with session counts and git push status |
| `POST` | `/api/directories` | Register a workspace directory and seed its Agent Commander session |
| `PATCH` | `/api/directories/:id` | Rename / relocate / update role prompt |
| `DELETE` | `/api/directories/:id?force=1` | Delete a directory record, optionally removing owned sessions |
| `POST` | `/api/directories/:id/push` | Push the directory base branch to remote |
| `GET` | `/api/directories/:id/sessions` | List sessions in a directory with worktree and merge state |
| `POST` | `/api/directories/:id/sessions` | Create a Claude/Codex terminal or chat session (`{ cli, kind, label?, model?, provider?, role? }`) |
| `GET` | `/api/directories/:id/workspace` | Live workspace board snapshot |
| `GET` / `PUT` | `/api/directories/:id/memo` | Read / write the directory memo (`<memoryStore>/<dirId>/memo.md`) |
| `POST` | `/api/directories/:id/memo/send` | Send memo text to a chat session |
| `GET` | `/api/directories/:id/events` | Directory event log (merges, dispatches, notes, provider changes) |

## Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/sessions` | List all sessions |
| `GET` | `/api/sessions/:id` | Get session details |
| `PATCH` | `/api/sessions/:id` | Update label, model, role prompt, memory, streaming, auto-continue, provider |
| `POST` | `/api/sessions/:id/switch-cli` | Switch a chat CLI (`{ cli, fresh? }`), preserving per-CLI native state and staging a one-shot semantic handoff |
| `DELETE` | `/api/sessions/:id` | Kill and delete a session |
| `POST` | `/api/sessions/:id/relocate` | Change session's working directory |
| `POST` | `/api/sessions/:id/restart` | Restart a dead terminal session in place |
| `GET` | `/api/sessions/:id/merge-status` | Inspect worktree ahead/behind/conflict state |
| `POST` | `/api/sessions/:id/sync` | Merge the directory base branch into this session's worktree |
| `POST` | `/api/sessions/:id/merge` | Merge this session branch back into the directory base branch |
| `POST` | `/api/sessions/:id/notes` | Leave a passive note for another agent in the same directory |
| `GET` | `/api/agent-resources/skills` | List installed Claude and Codex skills |
| `GET` | `/api/agent-resources/claude-sessions` | List Claude Code history sessions |
| `DELETE` | `/api/agent-resources/claude-sessions/:project/:id` | Delete one unlinked Claude history session |
| `DELETE` | `/api/agent-resources/claude-sessions?olderThanDays=N` | Delete unlinked Claude history older than N days |

## Providers

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/providers?appType=claude\|codex` | List providers with secrets masked, plus defaults |
| `POST` | `/api/providers/import` | Import / refresh providers from `cc-switch` |
| `POST` | `/api/providers` | Create a local provider (`{ appType, name, baseUrl?, authToken?, model?, modelOptions?, settingsConfig? }`) |
| `PATCH` | `/api/providers/:appType/:id` | Update provider metadata or settings |
| `DELETE` | `/api/providers/:appType/:id` | Delete a local provider and clear matching defaults |
| `GET` / `PUT` | `/api/provider-defaults` | Read / set default provider per CLI |

## Orchestration

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/sessions/:id/wait` | Register a durable poll, callback, or delay wait |
| `POST` | `/api/wait/:wid/resolve?token=<token>` | Resolve a callback wait from an external system |
| `GET` | `/api/sessions/:id/waits` | List waits for one session |
| `DELETE` | `/api/wait/:wid` | Cancel a wait |
| `POST` | `/api/sessions/:id/run-detached` | Launch a server-owned background command and auto-register completion polling |
| `GET` | `/api/sessions/:id/detached` | List detached tasks known to the server |
| `GET` | `/api/detached/:taskId` | Inspect one detached task status and log tail |
| `GET` | `/api/sessions/:id/triggers` | List post-turn, file-change, and schedule triggers |
| `POST` | `/api/sessions/:id/triggers` | Add a trigger (`{ type, prompt?, cooldownMs?, paths?, cron? }`) |
| `PUT` | `/api/sessions/:id/triggers/:tid` | Update one trigger |
| `DELETE` | `/api/sessions/:id/triggers/:tid` | Delete one trigger |
| `POST` | `/api/sessions/:id/triggers/:tid/test` | Fire a trigger immediately for manual testing |

Example wait:
```bash
curl -s "$MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/wait" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"poll","pollCmd":"test -f build.done && cat build.done","untilContains":"ok","intervalSec":15,"maxChecks":40}'
```

Chat CLIs also receive scoped MCP tools for the current session:

- `wait_for_external_result` registers a durable `callback` or `delay`.
- `get_external_wait` reads only waits owned by that session.
- `cancel_external_wait` cancels only a pending wait owned by that session.

The MCP surface intentionally cannot select another session, run polling commands,
choose an injected message, or recover a callback secret after its first return.
Use the HTTP poll endpoint only when a trusted host-side command or URL probe is
actually required.

Example detached task:
```bash
curl -s "$MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/run-detached" \
  -H 'Content-Type: application/json' \
  -d '{"command":"npm test","label":"test suite","intervalSec":10,"maxChecks":120}'
```

## Cron Jobs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/cron` | List scheduled tasks with next-run and last-run status |
| `POST` | `/api/cron` | Create a five-field cron task targeting a directory |
| `PATCH` | `/api/cron/:id` | Update schedule, prompt, target directory, CLI, or enabled state |
| `DELETE` | `/api/cron/:id` | Delete a scheduled task |
| `POST` | `/api/cron/:id/run` | Trigger one scheduled task immediately |

Example:
```bash
curl -s "$MULTICC_BASE_URL/api/cron" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Daily review","dirPath":"'"$PWD"'","cli":"claude","cron":"0 9 * * *","prompt":"Review the repo status and summarize risks."}'
```

## Files

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/files?path=<dir>&session=<id>` | List directory contents |
| `GET` | `/api/download?path=<file>&inline=<bool>` | Download or preview a file |

## Voice — Classic (STT + Refinement)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/voice/stt` | Multipart audio upload → Whisper transcription |
| `POST` | `/api/voice/refine` | `{ raw }` → SSE stream of refined text |
| `POST` | `/api/voice/feedback` | `{ raw, refined, userFinal }` → correction log |
| `GET` | `/api/voice/vocab` | Learned vocabulary terms |
| `DELETE` | `/api/voice/vocab/:term` | Remove a term |
| `GET` / `POST` | `/api/settings/voice` | Get / update voice configuration (hot-reload) |
| `GET` / `POST` | `/api/settings/power` | Read / update macOS lid-sleep prevention |

## Voice — Speech-to-Speech (S2S)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/voice/confirm` | S2S: parse raw text into structured requirement items for user confirmation |
| `POST` | `/api/voice/progress-summary` | S2S: generate a spoken progress summary from stream events |
| `GET` / `POST` | `/api/settings/voice` | Get / update voice settings (TTS provider, voice, ASR backend, API keys) |

## Push / Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/push/vapid-key` | VAPID public key |
| `POST` / `DELETE` | `/api/push/subscribe` | Register / remove push subscription |
| `POST` | `/api/push/test` | Fire a test push to all subscribers |
| `POST` | `/api/push/notify` | Authenticated/local business WebPush with strict schema and idempotency |
| `POST` | `/api/push/test-bark` | Fire a test Bark push |
| `POST` | `/api/push/test-webhook` | Fire a test webhook |

`POST /api/push/notify` accepts JSON with exactly `title`, `body`, `type`, `tag`,
`url`, and `dedupeKey`. `type` is limited to `strategy-actionable` or
`strategy-test`, and `url` must be `/manage`. A notification is reported as
`delivered: true` only when every current WebPush subscription accepts it;
responses include per-request subscriber, delivery, failure, and stale counts.
Successful event keys are retained as hashed, bounded receipts for 30 days so a
retry can be acknowledged without sending a second notification.

## Session Sharing

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/sessions/:id/share` | Create a share link (`{ password?, allowOperate? }`) |
| `GET` | `/api/sessions/:id/shares` | List active shares for a session |
| `DELETE` | `/api/sessions/:id/share/:token` | Revoke a share link |
| `POST` | `/api/sessions/:id/share-messages` | Share selected messages as a snapshot |
| `GET` | `/share/:token` | View a shared session (HTML page) |
| `POST` | `/api/share/:token/auth` | Authenticate a password-protected share |
| `GET` | `/api/share/:token/session` | Get shared session data |

## Token Usage

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/token-usage/global` | Global token usage stats across all sessions |
| `GET` | `/api/token-usage/by-role` | Token usage broken down by agent role (main / aux / subagent) |

## Tunnel (Public Access)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/settings/tunnel` | Tailscale Funnel & 花生壳 configuration and status |
| `GET` / `POST` | `/api/tunnel/funnel` | Read / toggle Tailscale Funnel |
| `GET` | `/api/tunnel/ipv6` | IPv6 reachability probe |
| `POST` | `/api/tunnel/restart/:provider` | Restart a tunnel provider process |

## WeChat Bridge

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/wechat/status` | Bridge running state |
| `GET` / `POST` | `/api/wechat/config` | Get / update bridge config |
| `POST` | `/api/wechat/start` | Start bridge |
| `POST` | `/api/wechat/stop` | Stop bridge |
| `POST` | `/api/wechat/send` | Send message to WeChat (`{ text, target }`) |
| `GET` | `/api/wechat/log` | Message log (`?since=<ms>`) |
| `GET` | `/api/wechat/events` | SSE stream of live log entries |

## Feishu / Lark Bridge

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/feishu/status` | Bridge running state |
| `GET` / `POST` | `/api/feishu/config` | Get / update App ID, App Secret, domain |
| `GET` / `PUT` / `DELETE` | `/api/feishu/gateway` | Read / create / destroy the gateway session |
| `POST` | `/api/feishu/gateway/reset` | Clear gateway history and reset |
| `POST` | `/api/feishu/start` | Start the long-connection bridge |
| `POST` | `/api/feishu/stop` | Stop the bridge |
| `POST` | `/api/feishu/send` | Send a message to Feishu/Lark |
| `GET` | `/api/feishu/log` | Message log |
| `GET` | `/api/feishu/events` | SSE stream of live log entries |

## Telegram / Discord / Slack Bridges

All three bridges share the same API structure (substitute the platform name):

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/<platform>/status` | Bridge running state |
| `GET` / `POST` | `/api/<platform>/config` | Get / update bot token and config |
| `GET` / `PUT` / `DELETE` | `/api/<platform>/gateway` | Read / create / destroy the gateway session |
| `POST` | `/api/<platform>/gateway/reset` | Clear gateway history and reset |
| `POST` | `/api/<platform>/start` | Start the bridge |
| `POST` | `/api/<platform>/stop` | Stop the bridge |
| `POST` | `/api/<platform>/send` | Send a message to the IM platform |
| `GET` | `/api/<platform>/log` | Message log |
| `GET` | `/api/<platform>/events` | SSE stream of live log entries |

## Server Info & Update

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/server-info` | Server IP, port, protocol, URL, token |
| `GET` | `/multicc.apk` | Latest Flutter APK (served from `public/multicc.apk`) |
| `POST` | `/api/update` | Start `./multicc update` detached — body `{ "force": bool }` |
| `GET` | `/api/update/status` | Progress of the running / last update |

`POST /api/update` returns `202 { ok, status: "started", force, activeStreaming }`.
`activeStreaming` is how many sessions were mid-turn — the update ends in a restart, so
those turns get interrupted (partial output is saved). It returns `409` when an update is
already running or the server is shutting down, and `503 { error, code }` when the update
can't be started at all (`code` is one of `UPDATE_MANAGER_MISSING`,
`UPDATE_NOT_A_GIT_CHECKOUT`, `UPDATE_BASH_MISSING`, … or `UPDATE_START_FAILED`).

`GET /api/update/status` derives its answer from `logs/update.log` rather than memory —
the process that starts an update is not the one that reports its outcome:

```jsonc
{
  "state": "running",                   // idle | running | succeeded | failed | stale
  "running": true,
  "exitCode": null,                     // set once the run finishes
  "force": true,
  "startedAt": "2026-08-03T04:20:00Z",  // from the log's start marker
  "updatedAt": "2026-08-03T04:20:12Z",  // log mtime — the last sign of life
  "silentMs": 1200,                     // running/stale only: time since that write
  "tail": "…last 8 KiB of update output…",
  "logPath": "/path/to/MultiCC/logs/update.log"
}
```

`stale` means the log went quiet for 15 minutes — the updater was probably killed
mid-flight. Poll this endpoint through the restart: the connection failing is expected and
means the server is coming back, not that the update failed. Both endpoints are
`ACCESS_TOKEN`-gated exactly like `/api/restart`.

## WebSocket Protocol

**Terminal mode:** `ws[s]://host/?id=<sessionId>&token=<token>`

```jsonc
// Client → Server
{ "type": "input",  "data": "ls -la\r" }
{ "type": "resize", "cols": 120, "rows": 40 }
{ "type": "upload", "tempId": "up_xxx", "name": "file.txt", "mime": "text/plain", "data": "<base64>" }

// Server → Client
{ "type": "session_id", "id": "a1b2c3d4" }
{ "type": "output",     "data": "..." }
{ "type": "exit",       "data": "..." }
{ "type": "relocate",   "cwd": "/new/path" }
{ "type": "file_saved", "tempId": "up_xxx", "path": "/tmp/multicc_xxx.txt", "name": "file.txt" }
```

**Chat mode:** `ws[s]://host/ws/chat?id=<sessionId>&ticket=<ticket>`

Chat WebSockets authenticate with a short-lived ticket from `POST /api/auth/ws-ticket` rather than the raw access token.

Other WebSocket paths: `/` (terminal), `/ws/voice`, `/ws/tts`, `/ws/workspace`, `/ws/meta`, `/ws/aux`.

```jsonc
// Client → Server
{ "type": "user_message", "text": "refactor server.js", "files": [...] }
{ "type": "cancel" }          // abort the in-flight turn
{ "type": "clear_history" }   // wipe history and start a fresh native session

// Server → Client
{ "type": "system",       "subtype": "init", "is_streaming": false, "session_id": "..." }
{ "type": "stream_event", "event": { /* Claude stream-json event */ } }
{ "type": "turn_end",     "ok": true, "provider_token_stats": {...} }
{ "type": "error",        "error": "..." }
{ "type": "chat_history", "messages": [...], "tokenUsage": {...} }
{ "type": "provider_token_stats", "windows": { "daily": ..., "weekly": ..., "monthly": ..., "allTime": ... } }
```

---

[← Back to the README](../README.md)
