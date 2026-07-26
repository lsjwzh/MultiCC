# Cancel state flow

How a manual Cancel (Web stop button, App stop button, task-card cancel, session
queue action) becomes a persisted, broadcast, canonical state — and why it must
not take any shortcut.

Companion to [status-presentation.md](status-presentation.md), which owns how the
resulting status is *drawn*. This document owns how it is *decided*.

## The rule

> **classify is the only writer of session/task business state.**
> A cancel controller may do exactly two things: stop the runner, and submit a
> structured result to classify.

Everything else — the terminal letter, `endedAt`, the cancel envelope, the
persisted broadcast, the scheduler slot release, every projection — follows from
that one submission.

## What was wrong

`cancelActiveTurn` used to write `setTaskState({classifyState:'E'})` **and**
separately call `scheduler.complete()`. Two writers, two fan-outs:

| symptom | cause |
| --- | --- |
| chat bar said ❌, task card still spun 🔄 | the `task_state` broadcast reaches the bar and the workspace stream; the board updates on the scheduler-event path instead |
| a cancelled task rendered ✅ | `onQueueEvent` hard-coded `completed → 'done'`; the event carried no verdict letter, so "the slot was released" was read as "the work finished" |
| a card stayed `running` forever | a cancel with no active scheduler entry emitted **nothing**, and `buildBoardDto` prefers the sticky persisted `t.runState` |
| session list ⏸️ vs chat bar ❌ for the same turn | `CLASSIFY_DISPLAY.E` had `cardStatus:'waiting'` against `barTint:'error'` |
| a successful cancel answered HTTP 404 | the queue route called `cancelActiveTurn` (which cleared the active entry) and then `resolve()` on that now-missing entry |

All five are the same defect seen from different surfaces: **two sources of
truth for one transition.**

## The canonical chain

```
UI (stop button / task card / queue action)
  │   optimistic: 「正在取消…」 only — never a terminal icon
  ▼
controller               src/routes/orchestration.js · src/chat/turn-engine.js
  │   validate + attribute {source, reason, operationId}; NO state write
  ▼
cancelActiveTurn         src/session-work-host.js
  ├─ idempotency: in-flight map keyed by sessionId
  ├─ stopRunner()        kill child / cancel stream / cancel preparation
  ├─ awaitRunnerStop()   bounded (5s); failure is reported, not faked
  ├─ closeTurnForClassify() → scheduler.turnEnded() → state 'assessing'
  ▼
dispatchStateAction({state:'E', cancel:{…}})     src/classify/state-machine.js
  ├─ setTaskState({classifyState:'E', endedAt, cancelledAt,
  │                cancelReason, cancelSource, cancelOperationId})   ← the only write
  ├─ notify broadcast 「已取消：<goal>」 (chat + workspace); no push
  └─ classifyTransition() → scheduler.complete({classifyState:'E'})
        └─ emit('completed', {…, classifyState:'E'})
  ▼
onSchedulerEvent         src/session-work-host.js
  ├─ setTaskState(queueState)         → chat bar / workspace
  └─ onTaskBoardQueueEvent(event)     → board reducer maps the LETTER
  ▼
reconcileTaskProjection(taskId, {classifyState:'E'})
      re-publishes through the board's own reducer — never a hand-built broadcast
```

`cancelActiveTurn` awaits the transition it started (classify's
`dispatchStateAction` is synchronous and fires `classifyTransition` without
awaiting, so the host keeps the in-flight promise in `pendingTransitions`). The
HTTP reply and the reconcile therefore both observe a settled transition, not a
half-applied one.

## Choices, and why

**The terminal letter is `E`, not a new `cancelled` letter.** A user stop and a
provider fault are the same fact for the state machine: *the turn did not end
cleanly*. Adding a letter would mean touching every consumer of D/W/B/E/P for
one button. What distinguishes them is the envelope classify persists next to
the letter:

| field | meaning |
| --- | --- |
| `cancelledAt` | epoch ms; also the guard that stops a late verdict resurrecting the turn |
| `cancelReason` | `user_cancelled` · `cancel_stop_timeout` · `process_watchdog` · `force_insert` · `insert_queued` |
| `cancelSource` | `manual_cancel` · `process_watchdog` · `force_insert` · `insert_queued` |
| `cancelOperationId` | client `Idempotency-Key`, so a retried POST joins one operation |

A surface that knows the envelope says 「已取消」; one that only knows the letter
says 「异常」. Both are true, neither is `done`.

**There is no `cancelling` run state.** The intermediate phase is covered by the
frontend's optimistic 「正在取消…」 system message. Adding an enum member would
force every card, badge, Dart mirror and i18n catalogue to learn a state that
lives for a few hundred milliseconds.

**`E.cardStatus` is now `error`,** matching its `barTint`. One terminal fact, one
face. See [status-presentation.md](status-presentation.md#legacy-and-adjacent-vocabularies).

**A failed stop is still `E`, but not `ok`.** If the runner has not stopped
inside the timeout the result is `{ok:false, code:'runner_stop_timeout'}` with
`cancelReason:'cancel_stop_timeout'`, and the notify reads 「取消失败：任务未能停止」.
Reporting a clean cancel over a process that is still writing would be a lie the
next tool call exposes.

**A cancel never advances the FIFO.** Every verdict releases the active slot via
`complete()`; only `classifyState === 'D'` drains the queue, inside
`selectSessionItem`. The controller must not call `tick()` — the queued item
stays queued, which is what a user who just pressed stop expects.

**A cancel is not an API fault.** classify skips `evaluateTurnApiError` when the
result carries a `cancel` envelope: running the retry policy would log a phantom
provider failure and offer to retry something the user deliberately stopped. It
also suppresses the lock-screen push — the person who pressed the button is
looking at the screen.

## Idempotency and late events

- **In-flight map** (`cancelOperations`, keyed by sessionId): a second click, an
  HTTP retry, or a simultaneous Web+App cancel joins the running operation and
  returns `{deduplicated:true}`. One kill, one history append, one verdict.
- **`alreadyCancelled()` fast path**: when the state is already `E` *with* a
  `cancelledAt` and the runner is stopped, there is nothing to transition — but
  the projection is still reconciled, so a card that drifted is repaired instead
  of left stale. This is the requirement that a no-op cancel must still
  re-publish.
- **No resurrection.** `applyClassifyResult` drops a late Aux verdict when
  `classifyState==='E' && cancelledAt` (`classify_result_ignored_after_cancel`);
  `scanAndReclassify` skips the same sessions (`skipped-cancelled`); the board
  reducer rejects a queue event whose stamp predates `task.runStateAt`
  (`stale_queue_event`), so a `running` heartbeat already in flight when the user
  clicked cannot un-cancel the card.

## Non-manual entries

Same chain, different attribution — they exist so `cancelSource` can tell a user
stop from a dead runner without a second code path:

| entry | source | reason |
| --- | --- | --- |
| stop button (Web/App/task card) | `manual_cancel` | `user_cancelled` |
| `src/chat/process-watchdog.js` | `process_watchdog` | `process_watchdog` |
| force-insert of a new message | `force_insert` | `force_insert` |
| queue insert ahead of a running turn | `insert_queued` | `insert_queued` |

## Tests

`tests/test-cancel-state-flow.js` (in `npm run test:core`) wires the **real**
classify state machine, task-state store, task-board runtime, session-work
scheduler, orchestration store/outbox and session-work host over an isolated
temp directory — no real session, port or user task is touched — and records
every step in one ordered event log so sequence can be asserted:

- the canonical chain, in order, with the runner actually stopped and all three
  projections (session card, task card, chat bar) reading `error`;
- a cancelled turn is never `done`;
- the FIFO is not advanced and no `tick()` fires;
- double-click / retry / dual-end collapse to one kill, one history entry, one
  dispatch;
- a stale projection is repaired even when the computed state already matches;
- a stale `running` heartbeat is rejected; a late classifier verdict is ignored;
- a runner that will not stop lands on an explicit failure, not a fake cancel;
- cancelling with no active entry still publishes;
- mid-tool cancel persists the partial reply exactly once;
- the HTTP route delegates to the intent, never calls `resolve()` or `tick()`,
  maps `Idempotency-Key` to `operationId`, and still requires confirmation;
- a source scan asserting no module outside classify writes a cancel terminal
  state.

`tests/test-session-work-host.js` covers the host unit surface (ordering,
no-direct-write, stop timeout, reconcile-without-active-entry), and
`tests/test-status-presentation.js` pins `E` to a single face.
