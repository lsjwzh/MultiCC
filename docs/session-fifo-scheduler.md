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
                                                       └─ turn-end ─> assessing
                                                                      │
                                                                      v
                                                               classify verdict
                                                               D/W/B/E/P
```

The outbox owns the canonical pending payload and admission sequence.
`sessionSchedules` stores the active reference, classify-backed state, optional
queue-head override and last explicit decision. Once the user message is
durably present in canonical chat history, the delivered outbox payload is
reduced to a history reference.

## The FIFO gate

Classify is the **only semantic gate**. FIFO owns ordering, durable delivery and
the active-task correlation; it does not independently infer success from a
provider exit, process liveness, delivery acknowledgement, pending queue length
or UI state.

At every turn boundary the active entry enters `assessing`. Only the canonical
classify verdict may decide what happens next:

- `D` completes the active entry and permits the next queue item.
- `P` keeps the active entry parked as still processing.
- `W` permits only a correlated answer, approval or direct continuation.
- `B` permits only a correlated callback or continuation.
- `E` permits only a correlated retry or resume.

If classify is unavailable, the entry remains in assessment and the classify
loop retries. Transport failures release their delivery claim for retry; they
do not create a second FIFO completion/freeze authority.

## State transitions

| Current state | Event | Next state | May start another normal item? |
| --- | --- | --- | --- |
| `idle` | FIFO head claimed | `starting` | No |
| `starting` | canonical turn accepted | `running` | No |
| `running` | turn ends for any reason | `assessing: P` | No |
| `assessing` | classify `D` | `idle`, then claim one head | Yes |
| `assessing` | classify `P/W/B/E` | `frozen: classify_*` | No |
| `frozen: W` | correlated answer/approval/direct continuation | `starting` for the same active task | No |
| `frozen: B` | correlated callback/continuation | `starting` for the same active task | No |
| `frozen: E` | correlated retry/resume | `starting` for the same active task | No |
| `frozen` | explicit skip/cancel/resolve | `idle`, then claim one head | Yes |
| active after restart | recovered classify `D/W/B/E/P` | corresponding classify transition | Only for `D` |
| active after restart | no reliable classify fact | `assessing` | No |
| no durable active pointer | pending FIFO items only | `idle`, then claim one head | Yes |

A control item may bypass queued future work only when it identifies the current
active entry/task/request and its kind is permitted by the current classify
state. It resumes that task; it does not create a new FIFO task boundary.
Ordinary queued messages never advance while the active classify state is
`P/W/B/E`.

The public queue contains every pending/leased item, including normal tasks and
correlated controls. This is the same complete list sent in queue snapshots and
queue events.

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
- A recovered `D` completes only when its task/timestamp facts correlate to the
  current active entry. A stale or missing verdict returns to assessment.
- Pending outbox entries alone never fabricate a legacy active task. Only an
  explicit recovered non-D classify fact can rebuild one.
- Delivery recovery may briefly hold a lease while acknowledgement is settled,
  but it cannot manufacture a classify verdict.

## User operations

`GET /api/sessions/:id/queue` returns the server-owned queue state.

`POST /api/sessions/:id/queue/action` accepts `retry`, `resume`, `skip`,
`cancel`, `resolve`, `cancel_queued`, or `insert_queued`. Every action requires
`{ "confirm": true }`.

- Retry/resume continue the current task only when classify `E` permits them.
- Skip/cancel/resolve record an explicit operator decision before advancing.
- `cancel_queued` removes one pending queue entry; the UI exposes this as a
  close icon rather than a textual “cancel” action.
- `insert_queued` promotes one pending entry to the queue head and immediately
  ticks the pump. It never interrupts active work or bypasses classify; it
  starts immediately only when the classify gate already permits a normal item.
