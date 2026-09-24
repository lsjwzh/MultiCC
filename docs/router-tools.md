# Router MCP tools

MultiCC exposes cross-session routing as a local stdio MCP server. The MCP
process is only a protocol adapter; durable admission, target validation,
queuing, idempotency, and result completion remain server-side.

## Tools

- `wait_for_user_answer(question, reason?, options?, allow_multiple?)` records a
  durable semantic signal that the current turn cannot continue without the
  user. It returns immediately; the model still presents the question as its
  ordinary final response. At turn end the classifier treats the unresolved
  signal as authoritative `W` evidence. The next real user message clears it.
- `request_user_input(...)` is a backward-compatible alias. New prompts and
  agents should prefer `wait_for_user_answer` to avoid collisions with vendor
  built-in tools that are unavailable in non-interactive execution.
- `route_task(target_session_id | new_task, message, idempotency_key?)` admits a durable
  one-way dispatch and returns immediately. The target result is retained on
  the operation but is not returned to the caller.
- `dispatch_master(target_session_id | new_task, message, idempotency_key?, mode,
  timeout_seconds?)` admits the same durable request. Sync keeps the original
  MCP call open; async returns after admission and wakes the caller later. A
  timeout or interrupted transport does not cancel the operation.
- `dispatch_status(operation_id?, target_session_id?, active_only?, limit?)`
  recovers authoritative durable operation plus target FIFO/running state for
  dispatches owned by the caller. It is the required recovery step after an
  ambiguous `dispatch_master` result, including `terminated` and network loss.
- `dispatch_cancel(operation_id, cancel_running?, reason?)` cancels an owned
  queued/running dispatch. Re-routing is safe only after this succeeds or the
  original operation is terminal.
- `dispatch_slave(result, status?)` may complete only the dispatch that created
  the current turn. Natural post-turn completion remains the fallback when a
  model does not explicitly call the slave tool.

Supply exactly one of `target_session_id` and `new_task`. An explicit target
receives work under its existing canonical task identity. For an independent
task, use `new_task: {title, cli?, model?, provider?, effort?}`. The host creates
the task and its matching execution session in the caller's directory through
the same task-shell service used by the UI, then admits the message. Agents
must not pre-create sessions/tasks with curl, Python, or management REST APIs.

```json
{
  "new_task": {"title": "Review the plan", "cli": "codex", "effort": "high"},
  "message": "Review the proposed changes and report findings with evidence.",
  "mode": "async",
  "idempotency_key": "review-plan-1"
}
```

Keep the same explicit retry key and arguments after an incomplete receipt,
including across caller turns. The creation receipt and dispatch receipt are
durable: failure between creating metadata and admitting delivery is retryable
without creating another task. Changing configuration, content, or target
under that key is a conflict. Creation metadata may remain if delivery fails;
it is not proof that the task executed.

Busy targets are handled by the existing durable outbox. A routed request never
interrupts an active worker turn. Every target must exist, be a non-system
worker, and belong to the caller's directory. Normal routing accepts only
`kind=chat`; a terminal target is rejected unless the caller passes
`allow_terminal: true`, which Commander instructions permit only after an
explicit user request for that terminal.

## CLI integration

| CLI | Per-run MCP injection |
| --- | --- |
| Claude Code | Inline `--mcp-config`; its persistent process uses a session capability and resolves the current turn dynamically |
| Codex | Per-invocation `mcp_servers.multicc_router` config overrides |
| OpenCode | Runtime-only `OPENCODE_CONFIG_CONTENT` merge |
| ZCode | Session-directory workspace `.zcode/config.json` entry carrying the per-spawn capability env (the engine ignores `ZCODE_CONFIG_CONTENT` and rebuilds stdio child environments from a `HOME`/`PATH`/... whitelist, so neither the runtime env-var merge nor plain env inheritance can reach the MCP child) plus the OpenCode-compatible merge for future engine support |
| Qoder | Inline `--mcp-config` |

Adapters do not touch shared user or project MCP configuration. The one
session-scoped exception is ZCode: because its engine offers no runtime config
channel, the adapter maintains `multicc_router` inside the session directory's
`.zcode/config.json` — a non-destructive merge rewritten on every spawn with
the current capability, gitignored, and never propagated outside that
directory. CLI executables that are absent cannot be native-smoke-tested on
that machine; their deterministic argument/config contracts remain covered by
the core test suite.

## Security and recovery

The MCP child calls a pre-auth internal HTTP bridge that accepts only a real
loopback transport with a random process capability. The capability is scoped
to one session, expires, and is revoked when a per-turn process exits. Claude's
persistent capability resolves the active turn on every call and is revoked
when its stream session is disposed.

The server generates task and operation identifiers. `dispatch_slave` validates
the operation lineage and target chat before it can write a result. Operation
state and outbox items use the existing atomic orchestration store; no token is
persisted. Restart recovery can deliver or complete admitted work independently
of the MCP process. MCP cancellation aborts only the waiting tool request and
does not discard the durable operation.

Dispatch carries the canonical task-shell receipt, client message ID, and
admission timestamp through the durable outbox. Task identity conflicts are
rejected before admission. A permanent identity refusal at execution terminates
delivery and records a failed operation instead of retrying indefinitely.
Queue insertion is reported as started only with durable delivery or scheduler
start evidence; `ok:true, started:false` means prioritized but still waiting.

The MCP-only task creation rule is a model instruction, not an HTTP access
restriction. Management APIs retain their existing authentication and local
access behavior; API clients may still create valid tasks through the canonical
service. No additional login requirement or model-specific HTTP gate is imposed.

Process-presence fields such as `active`, `streaming`, clients, recent task
labels, and repository status are not dispatch completion evidence. Humans can
query `GET /api/sessions/:id/dispatches`; it projects bounded metadata by
joining durable operations with the target scheduler FIFO and active entry.

`wait_for_user_answer` (and its legacy `request_user_input` alias) is
deliberately not an interactive terminal prompt and
does not hold an MCP request open. Its scoped capability proves the originating
session and turn; the host rejects stale turns, deduplicates repeated calls,
and persists only the pending-input fact in session task state. Aux still owns
goal/phase and provides the legacy text fallback, while an unresolved
structured signal wins the waiting-state decision.
