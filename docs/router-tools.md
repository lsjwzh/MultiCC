# Router MCP tools

MultiCC exposes cross-session routing as a local stdio MCP server. The MCP
process is only a protocol adapter; durable admission, target validation,
queuing, idempotency, and result completion remain server-side.

## Tools

- `request_user_input(question, reason?, options?, allow_multiple?)` records a
  durable semantic signal that the current turn cannot continue without the
  user. It returns immediately; the model still presents the question as its
  ordinary final response. At turn end the classifier treats the unresolved
  signal as authoritative `W` evidence. The next real user message clears it.
- `route_task(target_session_id, message, idempotency_key?)` admits a durable
  one-way dispatch and returns immediately. The target result is retained on
  the operation but is not returned to the caller.
- `dispatch_master(target_session_id, message, idempotency_key?,
  timeout_seconds?)` admits the same durable request and keeps the original MCP
  tool call open until the operation reaches a terminal state. A timeout does
  not cancel the operation; retrying with the same idempotency key reattaches.
- `dispatch_slave(result, status?)` may complete only the dispatch that created
  the current turn. Natural post-turn completion remains the fallback when a
  model does not explicitly call the slave tool.

Busy targets are handled by the existing durable outbox. A routed request never
interrupts an active worker turn. Every target must exist, be a non-system
worker, and belong to the caller's directory.

## CLI integration

| CLI | Per-run MCP injection |
| --- | --- |
| Claude Code | Inline `--mcp-config`; its persistent process uses a session capability and resolves the current turn dynamically |
| Codex | Per-invocation `mcp_servers.multicc_router` config overrides |
| OpenCode | Runtime-only `OPENCODE_CONFIG_CONTENT` merge |
| ZCode | Runtime-only native `mcp.servers` plus OpenCode-compatible merge |
| Qoder | Inline `--mcp-config` |

No adapter edits user or project MCP configuration files. CLI executables that
are absent cannot be native-smoke-tested on that machine; their deterministic
argument/config contracts remain covered by the core test suite.

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

`request_user_input` is deliberately not an interactive terminal prompt and
does not hold an MCP request open. Its scoped capability proves the originating
session and turn; the host rejects stale turns, deduplicates repeated calls,
and persists only the pending-input fact in session task state. Aux still owns
goal/phase and provides the legacy text fallback, while an unresolved
structured signal wins the waiting-state decision.
