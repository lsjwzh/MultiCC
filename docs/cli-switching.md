# Multi-CLI switching

> One conversation, six coding CLIs. Switch mid-task without losing the thread, without changing directory, and without re-explaining what you are doing.

This is MultiCC's defining feature, so it is worth being precise about what it does — and what it deliberately does *not* do.

---

## Supported CLIs

| CLI | Value | Provider support | One-click install from the UI |
|---|---|---|---|
| Claude Code | `claude` | yes | `npm install -g @anthropic-ai/claude-code` |
| OpenAI Codex | `codex` | yes | `npm install -g @openai/codex` |
| OpenCode | `opencode` | yes | `npm install -g opencode-ai` |
| ZCode (GLM) | `zcode` | yes | manual — install the ZCode desktop app from <https://zcode.z.ai> (its bundled CLI is what MultiCC drives) |
| Kimi Code (Moonshot) | `kimi` | yes — OpenAI-format providers only (`KIMI_API_KEY`/`KIMI_BASE_URL` injection) | `npm install -g @moonshot-ai/kimi-code` |
| Qoder CN | `qoder` | **no** — provider and subagent are forced to `null` | `curl -fsSL https://qoder.cn/install \| bash` |

Source of truth: `SUPPORTED_CHAT_CLIS` in `src/cli-switch.js`, install specs in `src/cli/switch-runtime.js`.

**Chat sessions only.** Terminal sessions are pinned to the CLI they were created with; so are system sessions (`aux`, `gateway`), which are switched by their bridge controller instead. `POST /api/sessions/:id/switch-cli` returns `400` for anything that is not a chat session.

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

Clearing a chat invalidates the native session of **all six** CLIs, not just the active one. Otherwise switching away and back after a clear would resurrect context you explicitly discarded. Per-CLI *configuration* (model, effort, provider) is preserved.

---

## Provider follows the CLI

A provider binding is stored **per CLI**, not per session. Switching from Claude-on-provider-A to Codex-on-provider-B switches the model endpoint too — that is usually what you want (each CLI speaks its own vendor's API format), but it means the model shown in the header changes with the CLI.

Qoder is providerless: selecting it forces `provider` and `subagent` to `null`.

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

Body fields: `cli` (required, one of the six) and `fresh` (optional boolean).

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

---

## Related

- **Session fork** (`POST /api/sessions/:id/fork`) reuses the same checkpoint mechanism to branch a conversation into a new session.
- **Manual context rotation** and **clear-but-keep-visible-history** both emit a `[MultiCC context checkpoint v1]` variant of the same prompt, so a fresh native context can be seeded without losing the visible thread.

---

[← Back to the README](../README.md)
