# Qwen Audio Voice Gateway

MultiCC can expose one logical Qwen Audio Voice Gateway for a Fleet. The
Gateway is a voice channel, not a Worker and not a second Commander:

```text
microphone / speaker
        │
        ▼
Qwen Audio Agent (realtime audio, VAD, interruption, TTS)
        │ ACP v1 over stdio
        ▼
MultiCC Voice Gateway ──► the Fleet's unique type=commander session
                                  │
                                  ▼
                        route_task / Task Board / Workers
```

## Invariants

- A Fleet is a MultiCC directory (`directoryId`).
- A Voice Gateway binds to exactly one non-ephemeral chat record whose
  `type` is `commander`. Labels and role text do not grant this capability.
- Zero or multiple typed Commanders fail closed. The caller cannot select an
  arbitrary `commanderSessionId`.
- The persisted record uses `type=gateway`, `kind=voice` and
  `gatewayKind=qwen-audio`; existing routing, memory, worktree and task-board
  filters therefore exclude it from Worker candidates.
- Qwen owns realtime audio. MultiCC owns task routing and task state. The
  DashScope API key remains in Qwen's `config.env` and is never copied into
  `sessions.json` or a Voice Gateway response.
- `taskId` is created only by the MultiCC task path. The ACP bridge never
  invents one.
- One adapter process keeps at most 32 ACP session mappings, preventing a
  malformed local client from growing unbounded state.

## Provision a Fleet binding

The versioned API is the stable, path-free status surface:

```bash
curl -X PUT http://127.0.0.1:3000/api/v1/directories/<directory-id>/voice-gateway \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"provider":"qwen-audio-agent"}'
```

`GET /api/v1/directories/<directory-id>/voice-gateway` reports the canonical
Commander binding and its health. `GET /api/v1/voice-gateways` lists all
configured Fleet bindings. The legacy unversioned GET additionally returns a
local launch hint (`acp.command`, `acp.args`, `acp.env`) for the operator UI;
that absolute-path hint is intentionally excluded from the v1 contract.

Creating the same Fleet binding twice is idempotent. If the canonical
Commander changed, PUT rebinds to the current unique typed Commander. If two
Voice Gateway records somehow exist for one Fleet, both GET and PUT return
`voice_gateway_ambiguous`; no record is guessed or deleted.

## Connect Qwen Audio Agent

Qwen Audio Agent v1.0.0 exposes a generic ACP backend using
`AGENT_PROTOCOL=acp`, `ACP_COMMAND`, `ACP_ARGS`, `ACP_LABEL` and
`ACP_WORKSPACE`. Copy the command and args from the unversioned Voice Gateway
response into that Fleet's Qwen `config.env`:

```dotenv
DASHSCOPE_API_KEY=your-dashscope-key
AGENT_PROTOCOL=acp
ACP_COMMAND=/absolute/path/to/node
ACP_ARGS=["/absolute/path/to/multicc/src/voice/multicc-acp-agent.mjs","--directory-id","<directory-id>"]
ACP_LABEL=MultiCC Commander
ACP_WORKSPACE=/absolute/path/to/the/fleet
MULTICC_BASE_URL=http://127.0.0.1:3000

# Leave empty: the real Commander session owns its CLI/provider/model.
QWEN_AUDIO_AGENT_BACKEND_MODEL=
```

Then start the official Qwen runtime and one of its clients:

```bash
qwenaudio
qwenaudio tui
```

The ACP process writes protocol JSON only to stdout; diagnostics go to stderr.
On a remote host, `MULTICC_BASE_URL` must be HTTPS and
`MULTICC_ACCESS_TOKEN` must be supplied through the process environment.
Tokens are never accepted in the URL or command-line args. Loopback uses the
normal MultiCC local-request policy.

## ACP mapping

| ACP v1 method | MultiCC behavior |
| --- | --- |
| `initialize` | advertises text prompts plus resume/close |
| `session/new` | validates the Fleet Gateway and unique Commander |
| `session/resume` | revalidates and recreates only the transport mapping |
| `session/prompt` | sends one correlated `user_message` to the Commander |
| `session/cancel` | cancels its own queued FIFO entry, or its own active turn |
| `session/close` | closes the bridge mapping; never deletes the Commander |

The bridge does not consume assistant output until the committed user event
with its exact `clientMsgId` appears. This matters when the Commander is already
busy: output from the previous turn is ignored, and the ACP prompt remains
pending until its own FIFO entry starts.

Before execution, cancellation derives the scheduler entry ID from the same
idempotency key and calls `cancel_queued`. It never sends a generic chat cancel
that could stop an unrelated active turn. After the committed event proves
that the voice turn owns the active slot, normal cancel is safe.

## Qwen's extra orchestration layer

Qwen's generic ACP backend normally injects a temporary
`qwen_audio_agent_session_*` MCP server and a user-level instruction that asks
the backend Agent to create “third-layer project Sessions”. MultiCC already has
a Commander, Worker routing and a durable Task Board. Allowing both systems to
own delegation would create two task ledgers and conflicting cancellation.

For this integration the ACP bridge therefore:

1. accepts but does not connect the client-supplied MCP descriptors;
2. removes the tagged Qwen backend-instruction block before delivering the
   actual user request;
3. leaves MultiCC's host-injected `route_task` capability authoritative;
4. projects tool name and status only—tool inputs, outputs, file contents and
   credentials never cross the voice ACP boundary.

This is deliberate compatibility behavior, not prompt convenience.

## Current boundary and next increment

This increment provides the Fleet resource model, versioned management
contract and a runnable ACP-to-Commander transport. It does not supervise the
Qwen process, embed Qwen's microphone UI in Flutter, or yet turn later Task
Board completion events into unsolicited voice announcements.

The next safe increment is a Qwen-side `multicc` backend driver (or an upstream
extension point) that treats MultiCC task receipts as native delegation:

- start returns the canonical MultiCC task/operation receipt;
- wait/query/cancel call MultiCC's Task Board and scheduler APIs;
- completion is voiced once, keyed by `taskId`;
- Qwen's internal delegation cache remains a projection, never the task truth.

Until that driver exists, the initial Commander response is available by
voice and all continuing task state remains visible and controllable in the
MultiCC Task Board.

## Failure modes and rollback

| Failure | Behavior |
| --- | --- |
| no/multiple real Commander | provision and ACP session fail closed |
| stale Commander binding | status reports `commander_binding_stale`; PUT repairs |
| duplicate Gateway records | reports `voice_gateway_ambiguous`; no auto-delete |
| Qwen/ACP disconnect | active prompt fails; Commander and task state remain durable |
| ACP session mapping limit | `session_limit_reached`; close an old mapping and retry |
| MultiCC HTTP/WS handshake stalls | bounded connect/request timeout; no unbounded startup hang |
| remote URL without token or HTTPS | ACP process refuses to connect |
| disable/delete Gateway | new ACP sessions fail; existing Commander/Workers are untouched |

Rollback is data-only: disable or delete the Voice Gateway record and stop the
external Qwen process. No chat session, branch, worktree, Task Board card or
provider configuration is deleted.
