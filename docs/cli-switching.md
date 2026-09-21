# Multi-CLI switching

> One conversation, ten coding CLIs. Switch mid-task without losing the thread, without changing directory, and without re-explaining what you are doing.

This is MultiCC's defining feature, so it is worth being precise about what it does — and what it deliberately does *not* do.

---

## Supported CLIs

| CLI | Value | Provider support | One-click install from the UI |
|---|---|---|---|
| Claude Code | `claude` | yes | `npm install -g @anthropic-ai/claude-code` |
| Claude Exp (Agent SDK) | `claude-exp` | yes — shares the Claude Messages provider pool | bundled with MultiCC; upgrade MultiCC to update the SDK |
| OpenAI Codex | `codex` | yes | `npm install -g @openai/codex` |
| Codex Exp (app-server) | `codex-exp` | yes — shares the Codex Responses provider pool | `npm install -g @openai/codex` |
| OpenCode | `opencode` | yes | `npm install -g opencode-ai` |
| ZCode (GLM) | `zcode` | yes | manual — install the ZCode desktop app from <https://zcode.z.ai> (its bundled CLI is what MultiCC drives) |
| Kimi Code (Moonshot) | `kimi` | yes — OpenAI-format providers only (`KIMI_API_KEY`/`KIMI_BASE_URL` injection) | `npm install -g @moonshot-ai/kimi-code` |
| Qoder CN | `qoder` | **no** — provider and subagent are forced to `null` | `curl -fsSL https://qoder.cn/install \| bash` |
| WorkBuddy (Tencent) | `codebuddy` | **no** — vendor auth via `codebuddy` TUI `/login` (`~/.codebuddy`) | `npm install -g @tencent-ai/codebuddy-code` |
| DeepSeek Harness | `dsh` | **no** — DeepSeek-native credentials (`DEEPSEEK_API_KEY` env or the `dsh web` Models page) | `npm install -g @deepseek-ai/dsh` |

Source of truth: `SUPPORTED_CHAT_CLIS` in `src/cli-switch.js`, install specs in `src/cli/switch-runtime.js`.

**Chat sessions only.** Terminal sessions are pinned to the CLI they were created with; so are system sessions (`aux`, `gateway`), which are switched by their bridge controller instead. `POST /api/sessions/:id/switch-cli` returns `400` for anything that is not a chat session.

`claude-exp` and `codex-exp` are additionally chat-only at creation time. `claude-exp` runs each turn through the bundled `@anthropic-ai/claude-agent-sdk` while preserving the same native session UUID, Provider proxy, model, effort, agent, MCP, and subagent routing as the regular Claude path. `codex-exp` is the corresponding opt-in adapter for Codex app-server JSON-RPC and requires Codex `>=0.154.0`.

Both experimental entries are isolated: normal `claude` continues to use the existing stream-json runner, and normal `codex` continues to use `exec --json`.

---

## What actually carries over

MultiCC does **not** translate one vendor's transcript into another's format. That approach is lossy in ways you cannot audit, and it makes every CLI upgrade a compatibility problem.

Instead, each CLI keeps **its own native session**, and continuity between those independent sessions is a **bounded, visible-text checkpoint**:

| Carried over | Not carried over |
|---|---|
| Up to **16 recent user/assistant messages**, capped at **12 000 characters** total (any single message longer than 1 800 chars is truncated) | The source CLI's hidden internal state — its own context compaction, cached reasoning, tool-call internals |
| Task state: `goal`, `phase`, `classifyState`, `lastSummary` | The other CLI's system prompt, skills, or MCP wiring |
| Git snapshot: `HEAD`, branch, and up to 100 working-tree changes | Anything the source CLI never printed as visible text |
| The working directory and git worktree (unchanged — you stay on `multicc/<sessionId>`) | |

The checkpoint is rendered as a prompt prefix that begins with `[MultiCC CLI handoff v1]` and ends with an explicit instruction to the receiving CLI:

> Continue the current user request using this checkpoint. Do not claim access to the source CLI's hidden state.

The system message MultiCC inserts into visible history to mark the switch is itself filtered out of future checkpoints, so switch markers never accumulate.

### Checkpoint budget at a glance

```
16 messages max · 12 000 chars max · 1 800 chars per message
+ task { goal, phase, classifyState, lastSummary }
+ git  { head, branch, changes[…100] }
```

The transcript is walked **newest to oldest** so that a long conversation can never crowd out the messages immediately preceding the switch.

---

## Switching back: native sessions are remembered

Every CLI a chat has used keeps its own saved state — native session id, model, effort, provider, subagent routing, agent preset.

- **First time you switch to a CLI** → a fresh native session, seeded by the checkpoint.
- **Switching back to a CLI you already used** → MultiCC **resumes** that vendor session (`reused: true` on the response) *and* delivers a fresh checkpoint covering what happened while it was away.

So a Claude → Codex → Claude round trip returns you to the Claude conversation that already exists, brought up to date — not to a blank slate.

Pass `{"fresh": true}` to discard the saved native session for the target CLI and start it clean.

### Clearing history clears *every* CLI

Clearing a chat invalidates the native session of **all** CLIs, not just the active one. Otherwise switching away and back after a clear would resurrect context you explicitly discarded. Per-CLI *configuration* (model, effort, provider) is preserved.

---

## Provider follows the CLI

A provider binding is stored **per CLI**, not per session. Switching from Claude-on-provider-A to Codex-on-provider-B switches the model endpoint too — that is usually what you want (each CLI speaks its own vendor's API format), but it means the model shown in the header changes with the CLI.

Qoder, WorkBuddy (`codebuddy`), and DSH (`dsh`) are providerless: selecting them forces `provider` and `subagent` to `null`. They authenticate with their own vendor accounts (Qoder CN login, `codebuddy` TUI `/login`, DeepSeek credentials for dsh).

See [Configuration](configuration.md) for how providers and subagent routing are bound.

---

## The handoff is deferred, not immediate

The checkpoint is queued as `pendingCliHandoff` at the moment you switch. It is **prepended to your next message**, and only marked consumed after that turn completes successfully — at which point MultiCC broadcasts `cli_handoff_applied` and the chat shows a confirmation line.

This matters in two ways:

1. Switching costs you nothing if you change your mind — no tokens are spent until you actually send something.
2. If the first turn after a switch fails, the handoff stays pending and is retried with the next message, rather than being silently lost.

---

## Using it

### Web

Chat header → the **CLI badge** (`#cli-btn`) → pick a CLI from the switcher. The picker shows which CLIs are installed, which already have a saved native session, and offers a one-click install for any that are missing.

### Flutter app

Chat header → the CLI badge → `CliSwitchSheet`, with the same install and reuse indicators.

### API

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/switch-cli" \
  -H 'Content-Type: application/json' \
  -d '{"cli":"codex"}'
```

```jsonc
{
  "ok": true,
  "changed": true,
  "cli": "codex",
  "fromCli": "claude",
  "reusedTarget": false,        // true when an existing native session was resumed
  "cliStates": { /* per-CLI: hasNativeSession, model, provider, effort, lastActivatedAt */ },
  "cliAvailability": { /* per-CLI: available */ },
  "pendingCliHandoff": { "id": "…", "fromCli": "claude", "toCli": "codex", "status": "pending" }
}
```

Body fields: `cli` (required, one of the supported set) and `fresh` (optional boolean).

Notable responses:

| Status | Meaning |
|---|---|
| `200` `changed: false` | Already on that CLI and `fresh` was not set — a no-op |
| `400` | Not a chat session, unsupported `cli`, or the target CLI is not installed / not executable |
| `404` | No such session |

`PATCH /api/sessions/:id` deliberately **rejects** attempts to change `cli` — switching has to go through this route so the checkpoint gets built.

### Installing a missing CLI

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/cli/install-specs` | Official install command for each CLI (or a manual-install note) |
| `POST` | `/api/cli/:cli/install` | Start an install job (8-minute timeout, rolling 12 KB log) |
| `GET` | `/api/cli/install-status/:jobId` | Poll job progress, log tail, and classified error |
| `POST` | `/api/cli/:cli/upgrade` | Start an **upgrade** job for an already-installed CLI |

### Checking installed CLI versions and available updates

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/cli/versions` | Installed `--version` **and** published latest for each CLI |

Two independent facts are reported per CLI and never conflated:

- **installed** — the version of the **same binary the host actually spawns** (resolved through `resolveCliCommands()`, i.e. `cliCommands`), so it never drifts from a stale install artifact the way a PATH-based or hook-based check can.
- **latest** — the version published upstream, read from the npm registry (`GET <registry>/<pkg>/latest`). The registry base follows `npm_config_registry`, so mirror users compare like with like instead of being told about a release they cannot install.

Both halves are cached per server process for **1 day**; `?refresh=1` (or `?force=1`) forces a re-probe of both. The server also proactively probes **once shortly after startup and then once a day** (`startUpdateWatch()`, both timers `unref`'d), so opening the UI is normally a single cached read. Unavailable or unresolved CLIs are reported with `available: false` and are **not** spawned (no ENOENT child processes); the same goes for CLIs with no published source — no request is made for them at all.

**`latest: null` means "cannot check", never "up to date".** `qoder` is installed by a curl script and `zcode` is a manual desktop install; neither publishes to a comparable source, so both report `updateSource: null` and the UI says so explicitly.

```jsonc
{
  "ok": true,
  "cached": false,
  "checkedAt": "2026-09-21T10:12:00.000Z",
  "lastCheckedAt": "2026-09-21T10:12:00.000Z",
  "latestCheckedAt": "2026-09-21T10:12:00.000Z",
  "updateCount": 1,
  "versions": {
    "claude": { "cmd": "/Users/me/.local/bin/claude", "available": true, "version": "2.0.1",
                "error": null, "latest": "2.0.2", "updateAvailable": true,
                "updateSource": "npm", "inUseCount": 1 },
    "qoder":  { "cmd": "/Users/me/.local/bin/qoderclicn", "available": true, "version": "1.1.4",
                "error": null, "latest": null, "updateAvailable": false,
                "updateSource": null, "inUseCount": 0 },
    "kimi":   { "cmd": "kimi", "available": false, "version": null, "error": null,
                "latest": null, "updateAvailable": false, "updateSource": null, "inUseCount": 0 }
  }
}
```

`inUseCount` counts sessions currently holding that CLI (a live chat stream or live background work). It exists so the upgrade confirmation can say how many sessions are affected — it is a warning, not a lock.

When a probe fails or the output has no `x.y.z` token, that CLI's `version` is `null` and `error` carries a short reason; the overall response stays `200 { ok: true }` so one bad binary never blanks the whole panel. The same is true of the upstream half: a registry timeout, a 404, a redirect loop or a non-semver body all resolve to `latest: null`.

### Upgrading

`POST /api/cli/:cli/upgrade` runs the CLI's official command from `OFFICIAL_INSTALL_SPECS` in place (`npm install -g …`), reusing the install job's 8-minute timeout, rolling 12 KB log and classified failure hints; poll it with `GET /api/cli/install-status/:jobId`.

It deliberately does **not** reuse `/install`'s `alreadyInstalled` short-circuit: that shortcut means "only install when missing", while an upgrade is defined by the CLI already being present.

| Status | Meaning |
|---|---|
| `202` | Job started (`jobId`, `command`, `inUseCount`) |
| `400` | Unsupported CLI, or a manual-only install (`zcode` → `{ manual: true }`) |
| `409` | A job for this CLI is already running |

A successful job invalidates both version caches, so the next `/api/cli/versions` re-probes and the update badge clears on its own. A failed one does not: a half-finished npm install is exactly when you want the old reading kept.


---

## Related

- **Session fork** (`POST /api/sessions/:id/fork`) reuses the same checkpoint mechanism to branch a conversation into a new session.
- **Manual context rotation** and **clear-but-keep-visible-history** both emit a `[MultiCC context checkpoint v1]` variant of the same prompt, so a fresh native context can be seeded without losing the visible thread.

---

[← Back to the README](../README.md)
