# Session FIFO scheduler

MultiCC admits every unit of chat work through one durable, per-session
scheduler. The Web/App composer, task board, Commander dispatch, router tools,
triggers, wait callbacks and internal continuations may attach different source
metadata, but they do not make independent busy/launch decisions.

## Flow

```text
Web/App message ─┐
task board ──────┤
Commander ───────┤
dispatch/route ──┼─> durable admission/outbox ─> session gate ─> canonical
wait/trigger ────┤        (sequence + key)          claim        chat turn
retry/answer ────┘                                      │
                                                       └─ turn-end boundary
                                                          advances the queue;
                                                          Aux classify is
                                                          card semantics only
```

The outbox owns the canonical pending payload and admission sequence.
`sessionSchedules` stores only the active reference, state, freeze reason and
last explicit decision. Once the user message is durably present in canonical
chat history, the delivered outbox payload is reduced to a history reference.

## The FIFO gate

The gate is **"is a turn executing"**, not "is the whole task done". A durable
provider result with no structured `request_user_input` pending and no explicit
wait/callback registered completes the active entry at the turn boundary and
the outbox pump claims the next FIFO head. Aux classification (D/W/E/B/P) owns
task-card display only and never gates the queue: a plain `W` just means the
reply ended and the next user or dispatched message may run. Freezing is
reserved for structured signals — an open `request_user_input` (with its
requestId), an explicit wait/callback, a real provider error, or an unknown
interruption. Turn-ended freezes without a requestId (plain `W`, legacy
`waiting`, `classification_error`, `incomplete_requires_resume`) are released
automatically when queued work exists — both at admission time and on the next
pump tick — so work queued before such a freeze is never stuck behind it.

## State transitions

| Current state | Event | Next state | May start another normal item? |
| --- | --- | --- | --- |
| `idle` | FIFO head claimed | `starting` | No |
| `starting` | canonical turn accepted | `running` | No |
| `running` | durable turn result (no open request/wait) | `idle`, then claim one head | Yes |
| `running` | turn ended with unresolved `request_user_input` | `frozen: awaiting_user_input` (requestId) | No |
| `running` | turn ended with an explicit wait pending | `frozen: awaiting_callback` | No |
| `assessing` (defensive; not set by the normal boundary) | D or plain W | `idle`, then claim one head | Yes |
| `assessing` (defensive) | error / interrupted / explicit wait | `frozen` | No |
| `frozen` | correlated answer/approval/callback/retry | `starting` for the same active task | No |
| `frozen` | explicit skip/cancel/resolve | `idle`, then claim one head | Yes |
| `frozen` (turn-ended wait, no requestId) | queued item present at admission or next pump | `idle`, then claim one head | Yes |
| any active state | restart without a live process | `frozen: unknown_interruption` | No |

A control item may bypass queued future work only when it identifies the current
active entry/task/request. It resumes that task; it does not create a new FIFO
task boundary. Ordinary messages admitted while genuinely frozen (requestId
question, callback wait, error) remain behind the existing queue head.

## Idempotency and recovery

- The server assigns one monotonic admission sequence in the orchestration
  store; clients never determine FIFO order.
- `clientMsgId`, dispatch/route IDs and explicit idempotency keys produce stable
  outbox entry IDs. A retry with the same key cannot create or execute a second
  entry.
- Store mutations are serialized and atomically renamed. Claiming the head,
  changing the active schedule and recording a completion/decision therefore
  cannot race into two active turns.
- Duplicate completion is harmless after the active reference is cleared.
- Legacy queued work without a reliable successful terminal fact is
  conservatively frozen after restart.

## User operations

`GET /api/sessions/:id/queue` returns the server-owned queue state.

`POST /api/sessions/:id/queue/action` accepts `retry`, `resume`, `skip`,
`cancel`, or `resolve`. Every action requires `{ "confirm": true }`; retry and
resume continue the current task, while skip/cancel/resolve record an explicit
operator decision before the scheduler may advance.
