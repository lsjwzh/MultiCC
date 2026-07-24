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
                                                       └─ classify/finalizer
                                                          decides advance/freeze
```

The outbox owns the canonical pending payload and admission sequence.
`sessionSchedules` stores only the active reference, state, freeze reason and
last explicit decision. Once the user message is durably present in canonical
chat history, the delivered outbox payload is reduced to a history reference.

## State transitions

| Current state | Event | Next state | May start another normal item? |
| --- | --- | --- | --- |
| `idle` | FIFO head claimed | `starting` | No |
| `starting` | canonical turn accepted | `running` | No |
| `running` | turn ended; classification pending | `assessing` | No |
| `assessing` | structured success (`D`) | `idle`, then claim one head | Yes |
| `assessing` | waiting/error/blocked/unknown | `frozen` | No |
| `frozen` | correlated answer/approval/callback/retry | `starting` for the same active task | No |
| `frozen` | explicit skip/cancel/resolve | `idle`, then claim one head | Yes |
| any active state | restart without a live process | `frozen: unknown_interruption` | No |

A control item may bypass queued future work only when it identifies the current
active entry/task/request. It resumes that task; it does not create a new FIFO
task boundary. Ordinary messages admitted while frozen remain behind the
existing queue head.

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
