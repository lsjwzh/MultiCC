# Unattended mode (replaces Goal mode)

Goal mode (the 🎯 send button, the "run this task in Goal mode" prompt wrapper, the
`[Goal-mode limits]` context layer, `goal:true` / `goalLimits` on messages) is removed.
It is replaced by **unattended mode**: a per-session supervisor that, after every
finished turn, asks the **aux model** whether the goal was reached; if not, it sends the
next instruction by itself; it only notifies a human when a human is really required.

Not touched: the classify sub-state `goalState` (`achieved` / `interact`, the "执行成功"
sub-state on cards) is a different concept and stays. Unattended "achieved" writes
`goalState: 'achieved'` with `goalStateManualAt` (same stamp the manual
"mark achieved" uses), so cards show 达成目标.

## Two entry layers

1. **Task creation** (reuses the old Goal entry): the new-task form (Air quick task, Web
   chat composer is NOT an entry for this, Flutter new-task sheet) has an
   "无人值守 / Unattended" toggle. Turned on, the user defines the goal (defaults to the
   first message text), acceptance criteria (optional list, can be drafted by aux via
   the existing precheck), and the maximum supervision time `maxDurationMinutes`
   (5..1440, default 120). The first message is then sent with
   `unattended: { goal?, criteria?, maxDurationMinutes? }`.
2. **Mid-conversation**: a floating icon on the chat page (Web `chat.html` and Flutter
   `chat_screen`). Click → panel: goal textarea, criteria list (editable), maximum
   supervision time, "AI 补全判断标准" (precheck), Start / Stop / Resume, and a live status
   block (rounds sent so far, remaining time, last verdict + reason, history). The icon
   state: idle (grey), active (green, pulsing), needs_human (amber), achieved (check),
   stopped/exhausted/error (red/grey).
   Takeover works at any time, also when the agent is idle: `start` with
   `evaluateNow` runs one verdict on the last output right away.

A goal or criteria is mandatory (`goal` non-empty; criteria optional but recommended).

## Persisted state: `record.unattended` (null when never used)

```json
{
  "status": "active | achieved | needs_human | exhausted | stopped | error",
  "goal": "string, <= 2000 chars",
  "criteria": ["<= 12 items, each <= 300 chars"],
  "maxDurationMinutes": 120,   // 5..1440, default 120. Bounds wall-clock supervision.
  "rounds": 0,                 // informational: auto follow-ups sent so far. NO cap.
  "startedAt": 0,              // epoch ms of the last start OR resume
  "deadlineAt": 0,             // epoch ms = startedAt + maxDurationMinutes * 60000
  "updatedAt": 0,
  "lastVerdict": { "verdict": "achieved|continue|needs_human", "reason": "", "nextInstruction": "", "humanReason": "", "at": 0 },
  "history": [ { "at": 0, "verdict": "continue", "reason": "" } ],   // last 10
  "stall": { "sameInstruction": 0, "auxFailures": 0, "consecutiveFaults": 0 },
  "evaluating": false,
  "pausedBy": "user | input | cancel | null"
}
```

`status === 'active'` is the only armed state. Everything else is terminal until `resume`/`start`.
There is no round budget: supervision ends when `now >= deadlineAt` (status `exhausted`,
trace `[无人值守 Unattended] 已达到最长值守时间`). UIs show the remaining time computed from
`deadlineAt` — never from a round counter.

## HTTP

- `GET  /api/sessions/:id/unattended` → `{ ok, unattended: <state|null>, limits: { maxDurationMinutesDefault: 120, maxDurationMinutesMin: 5, maxDurationMinutesMax: 1440 } }`
- `POST /api/sessions/:id/unattended` body `{ action, ... }` → same shape as GET.
  - `start`: `{ goal, criteria?, maxDurationMinutes?, evaluateNow? (default true) }`. 400 `goal_required`.
    Sets `startedAt = now`, `deadlineAt = now + maxDurationMinutes * 60000`.
  - `update`: `{ goal?, criteria?, maxDurationMinutes? }` on an active/needs_human state.
    While active it recomputes `deadlineAt` from the ORIGINAL `startedAt`; if that deadline
    is already past it is clamped to `now + 1 minute` and the trace says so.
  - `stop`: status → `stopped`.
  - `resume`: `{ maxDurationMinutes? }`; from `needs_human | exhausted | stopped | error` back
    to `active`, re-arms the clock (`startedAt = now`, `deadlineAt = now + maxDurationMinutes * 60000`),
    `rounds` reset to 0 for `exhausted`, kept otherwise; runs `evaluateNow` when idle.
  - `maxRounds` and `goalLimits.maxRounds` in a request are IGNORED: accepted, never an
    error, never persisted. Out-of-range `maxDurationMinutes` is clamped, not rejected.
  - 404 unknown session, 409 for terminal/aux-less states where it cannot apply, 400 bad action.
- Precheck is unchanged: `POST /api/goal/precheck { task, dimensions? }` →
  `{ ok, verdict, score, issues[], questions[], criteria[], revised, ... }`; `/api/settings/goal`
  unchanged. Only the user-facing wording changes to "目标预检 / Goal precheck" under unattended mode.
- Task creation: `POST /api/task-shell-tasks/:taskId/messages` and the chat WebSocket
  `user_message` accept `unattended: { goal?, criteria?, maxDurationMinutes? }` on the first message.
  Legacy alias (old Flutter builds): `goal: true` + `goalLimits` only signals unattended mode
  (the goal defaults to the message text); `goalLimits.maxRounds` is ignored and nothing else
  about Goal mode survives (no prompt wrapper, no limits note, no `goalLimits` in the turn request).
- WebSocket (chat) event: `{ type: 'unattended_state', unattended: <state|null> }`, broadcast on every change and
  replayed on connect. The session DTO (`/api/sessions/:id`, `/api/air` task rows) carries `unattended`
  (Air rows carry the compact `{ status, rounds, deadlineAt, evaluating }`).

## Supervisor loop (src/unattended/ glue + native/core/src/unattended.rs kernel)

Trigger: classify settles a turn (letters D or W) of a chat session whose
`unattended.status === 'active'`; plus `evaluateNow`. Not on B (background work pending) or
E (fault — existing API-error policy owns it). One evaluation in flight per session.

1. Evidence: goal, criteria, last assistant output (truncated), a few recent messages, previous
   verdicts, and the pending user-input question + options when the turn ended on one.
2. Rust kernel builds the verdict prompt; aux (`type: 'unattended_verdict'`, interactive
   priority) answers JSON `{ verdict, reason, nextInstruction, humanReason, answer? }`.
3. Rust kernel parses + decides the next state/action (stall, parse failure policy; no round
   budget — wall-clock expiry is owned by the host timer).
   - `achieved` → status `achieved`, `goalState: achieved`, success push.
   - `continue` → inject `nextInstruction` as a system-injected message (prefix
     `【无人值守】`), `rounds += 1` (informational only, never a cap). If the turn ended
     on a pending user-input question the aux picks the option/answer itself and it is
     delivered the way a user's answer is (resolves the request).
   - `needs_human` → status `needs_human`, **notify the human** (push + chat notice) with `humanReason`.
     Only for: credentials/secrets/captcha/2FA/payment, physical-world actions, irreversible or
     destructive approvals the goal did not authorize, facts only the user knows, or a blocker the
     agent demonstrably cannot overcome. Everything else the aux decides itself.
   - Same normalized instruction 3 times in a row → `needs_human` (stalled). 2 consecutive aux
     failures/unparseable replies → status `error` + notify.
   - `now >= deadlineAt` (checked by the timer and at the start of every evaluation/fault)
     → `exhausted`, trace `已达到最长值守时间`, notify the user.
4. A real user message does not disarm it (it resets `stall` only). A user Cancel
   (`manual_cancel`) sets `stopped`. Server restart keeps the persisted state; it re-arms on the next
   turn end (no verdict at boot).

## Removal list

Web: 🎯 `#goal-btn`, `#goal-modal`, `goalWrap`, `sendGoal`, chat-composer `goal` option;
Air quick-task "Goal" checkbox + limits (becomes the unattended toggle); Flutter `input_bar` goal
button/dialog, `goalLimits` plumbing. Server: `resolveGoalLimits`, `buildGoalLimitNote`,
`goal-limit` context layer, `goalLimits` in task-shell runtime / turn request (JS + Rust
`turn_request.rs`). i18n keys for the removed UI are deleted; new keys added in both languages.

## v2: human takeover, scheduler-ordered queue, immediate fault/question handling, marked messages

Product decisions (user, 2026-11-10):

1. **Input is locked while unattended is `active`.** A human who needs to type first pauses
   (`stop`, shown as "暂停并接管 / Pause & take over"), types, then presses "继续无人值守 /
   Resume unattended" (`resume`). `needs_human`, `stopped`, `exhausted`, `error`, `achieved`
   leave the input enabled. The lock covers: the composer (Enter, send button, slash commands,
   attach, voice dictation) and the option buttons of a pending `wait_for_user_answer` card
   (the aux answers it itself while active). A banner above the composer says why and carries the
   Pause button.
   Server-side backstop: a *real* user message (not system-injected, not unattended's own) that
   arrives while `active` pauses the supervisor first (`status: 'stopped'`, `pausedBy: 'input'`)
   and is then delivered normally, so a stale client can never make human and supervisor fight.
   `stop` from the UI sets `pausedBy: 'user'`, a Cancel sets `pausedBy: 'cancel'`.
   `resume` while a turn is streaming/queued must NOT run `evaluateNow`; the turn-end settle does it.
2. **No special FIFO handling: the scheduler already gates the FIFO behind a pending
   question (answer runs first) and behind an E fault (continuation runs first, FIFO stays
   staged until D); the supervisor only has to deliver its answer / fault-continue and the
   FIFO continues by itself.** The supervisor therefore does not read the queued deliveries
   into the verdict prompt, and it does not append its message to the FIFO tail: a
   supervisor message is an "insert now" control (the delivery layer admits it as a
   `continuation`, which the scheduler treats as `directRun`). On a D settle with staged
   work the supervisor DEFERS (no verdict, no round burned) and releases the held classic
   push; the last backlog turn's own D settle makes the verdict.
3. **Waiting-on-user and faults are answered immediately.**
   - Turn ended on a pending user-input question: the aux picks the answer (`answer`) and it is
     delivered right away (resolves the request).
   - Turn ended in fault E (not a user Cancel): after the existing API-error policy has finished
     with it (it either scheduled its own retry — then do nothing — or gave up), inject an
     immediate `continue` instruction WITHOUT an aux call. Increments the informational `rounds`
     counter; consecutive faults are capped at 3 then `needs_human` (reason: repeated faults), so
     an unhealthy upstream never loops. Never replay side effects: the instruction only says to
     resume from where it stopped and check state before redoing anything.
4. **Every message the supervisor inserts carries one fixed marker**, defined once in the Rust
   kernel (`UNATTENDED_TAG = "[无人值守 Unattended]"`, exported through the addon and read by JS;
   Web/Flutter hard-code the same literal for rendering). Final text seen by the model:
   `🔇[无人值守 Unattended] <instruction>` (🔇 is the existing system-injected/voice-silent prefix
   added by the delivery layer; the tag is bilingual and language-agnostic so history, classify and
   UIs can recognise it). Applies to: continue instruction, auto-answer to a pending question,
   fault-continue. Code adds the tag, never the aux; any tag the aux emits is stripped first.
   Marked messages: are system-injected for classify/attribution (no new task attribution, do not
   reset autoContinue guards, do not count as a real user message so they never pause the
   supervisor), are not read aloud, and render in both UIs as a distinct "无人值守" bubble/badge.
5. **No misleading notifications (a).** While `active`, classify's own "succeeded"/"waiting" push for a
   D/W settle is held back; the supervisor guarantees exactly one outcome per settle: inject (no push),
   achieved push, needs_human/exhausted/stalled/error push — and on every no-op path (no_output,
   superseded, aux unavailable, evaluation dropped) it releases the classic push as fallback so a settle
   is never silent.
6. **Visible evaluation (b).** State gains `evaluating: boolean` (true from the moment the verdict starts
   until it is applied; broadcast on both edges; cleared on any terminal path and at boot) and
   `pausedBy: 'user'|'input'|'cancel'|null`. Each decision also appends a persisted UI-only trace line to
   the chat history (NOT sent to the model, not part of any model context): e.g.
   `[无人值守 Unattended] 判定：继续 · <reason> · 下一步：<instruction>` / `达成` / `需要人工：<humanReason>` /
   `已暂停（用户接管）` / `故障后自动继续`. Panels show a "判定中…/Judging…" spinner while `evaluating`.

Updated state additions: `"evaluating": false`, `"pausedBy": null`. Removal of the old
"a real user message only resets stall counters" rule (superseded by 1).

## Backend notes (v2)

The server half of the v2 contract. The Web/Flutter agents render against this;
nothing here is a suggestion — these are the exact wire shapes (`src/`, `server.js`).

### Marker

One fixed literal, defined once in `native/core/src/unattended.rs`
(`UNATTENDED_TAG`), exposed as `unattendedTag()` on the addon and as
`TAG` from `src/unattended/kernel.js`:

```
[无人值守 Unattended]
```

Every supervisor-inserted message is `<marker> <text>`; the delivery layer still adds the
`🔇` system prefix in front, so the model/history sees
`🔇[无人值守 Unattended] <instruction>`. UIs may hard-code the literal for recognising a
marked bubble. The auxiliary model never writes the marker (any it emits is stripped).

### New state fields

`record.unattended` (and therefore GET/POST `/api/sessions/:id/unattended`, the session
DTO and every `unattended_state` event) gains:

```json
{ "evaluating": false, "pausedBy": null }
```

- `evaluating: boolean` — true from the moment a verdict request starts until it is
  applied/failed/cancelled; both edges are broadcast as `unattended_state`. Always false
  after a restart (stale `true` is cleared at boot/load).
- `pausedBy: "user" | "input" | "cancel" | null` — why the supervisor is paused; cleared by
  `resume`/`start`. `user` = panel "Pause & take over" (`stop`), `input` = a real user
  message arrived while active (server backstop), `cancel` = the turn was cancelled.
- `maxDurationMinutes: integer` — 5..1440, default 120. Replaces the old `maxRounds`,
  which is gone from the state (requests may still send it; it is ignored).
- `startedAt: epoch ms` — the last `start` OR `resume`.
- `deadlineAt: epoch ms` — `startedAt + maxDurationMinutes * 60000`.
- `rounds: integer` — informational count of verdicts/injections. **No cap.**
- `lastVerdict`, `history`, `goal`, `criteria`, `status`, `stall.consecutiveFaults` keep
  their v2 meaning.

The Air task-row compact projection (`/api/air` task rows) is
`{ status, rounds, deadlineAt, evaluating }` (a copy, never the cached card object).
There is no `maxRounds` anywhere on the wire.

### Wall-clock supervision (replaces the round budget)

- Limits (GET/POST responses): `limits: { maxDurationMinutesDefault: 120,
  maxDurationMinutesMin: 5, maxDurationMinutesMax: 1440 }`. The Rust kernel owns the pure
  math: `unattendedClampDuration` (`clamp_duration`), `unattendedArmDeadline`
  (`arm_deadline`), `unattendedDeadlineExpired` (`deadline_expired`), mirrored in
  `src/unattended/kernel.js` as `clampDuration` / `armDeadline` / `deadlineExpired`.
- `start`/`resume` arm `startedAt = now`, `deadlineAt = now + maxDurationMinutes*60000`.
  `update` shifts only `maxDurationMinutes`: the deadline is recomputed from the ORIGINAL
  `startedAt`; if that deadline is already past it is clamped to `now + 1 minute` and a
  trace line notes the shift.
- Expiry: when `now >= deadlineAt` while `status === 'active'` the supervisor stops with
  `status: 'exhausted'` (the existing terminal status), sets
  `lastVerdict.humanReason` / the trace line to `[无人值守 Unattended] 已达到最长值守时间`,
  leaves `pausedBy` null, broadcasts `unattended_state` + `unattended_trace`, notifies the
  user (error push) and fires the held classic push fallback, like every other no-op path.
- One `setTimeout` per active session in the Node host, armed to `deadlineAt`, `unref()`'d
  and cleared on every status change / stop / pause / resume / shutdown. It fires even when
  no turn ever settles. Boot migration (`src/unattended/runtime.js`) re-arms it for every
  persisted active record. Every evaluation and `onFault` also checks expiry first, so a
  late timer can never allow another injection.
- Boot migration of legacy records: `maxRounds` is dropped. An active record with no
  `deadlineAt` gets `maxDurationMinutes = 120`, `startedAt = now`,
  `deadlineAt = now + 120 min`. Non-active records get `maxDurationMinutes = 120` (if
  missing) and a null-safe `startedAt = updatedAt || now`,
  `deadlineAt = startedAt + maxDurationMinutes*60000`.
- The Rust verdict prompt no longer mentions or enforces a round budget; the stall
  protections (same instruction ×3, consecutive aux failures, consecutive faults) are
  unchanged and independent of rounds. `rounds` keeps incrementing for display only.
- **UIs show remaining time computed from `deadlineAt`** (e.g.
  `remaining = deadlineAt - Date.now()`), never a round fraction; `rounds` is a badge/count.

### Trace history entry (persisted, UI-only)

Each decision appends one chat-history message. It is **not** model context: `role` is
`system`, every model-facing replay/evidence path filters `role === 'user' | 'assistant'`,
and the supervisor's own verdict evidence (`historyMessages` in `src/unattended/host.js`)
does the same.

```json
{
  "id": "…",
  "role": "system",
  "kind": "unattended_trace",
  "content": "[无人值守 Unattended] 判定：继续 · <reason> · 下一步：<instruction>",
  "ts": 1731234567890,
  "taskId": "tsk_…"
}
```

`content` always starts with the marker. Recognised prefixes (server wording, not i18n):

| decision | `content` |
| --- | --- |
| continue | `[无人值守 Unattended] 判定：继续 · <reason> · 下一步：<instruction>` |
| achieved | `[无人值守 Unattended] 判定：达成 · <reason>` |
| needs_human | `[无人值守 Unattended] 判定：需要人工 · <humanReason>` |
| stalled | `[无人值守 Unattended] 判定：停滞 · <reason>` |
| exhausted | `[无人值守 Unattended] 已达到最长值守时间` |
| error | `[无人值守 Unattended] 判定：出错 · <reason>` |
| paused | `[无人值守 Unattended] 已暂停（<用户接管 / 用户输入 / 已取消>）` |
| fault-continue | `[无人值守 Unattended] 故障后自动继续（第 <n> 次）` |

The trace is appended before the action is applied (so an inject's trace precedes the
instruction bubble) and written even when the case ends in a push-only outcome.

### Live broadcast

Same chat socket that already carries `unattended_state`:

```json
{
  "type": "unattended_trace",
  "kind": "unattended_trace",
  "message": "[无人值守 Unattended] 判定：继续 · … · 下一步：…",
  "entry": { "id": "…", "role": "system", "kind": "unattended_trace",
             "content": "…", "ts": 1731234567890, "taskId": "tsk_…" }
}
```

`message === entry.content`. Clients may render `entry` once and ignore duplicates by
`entry.id` (the durable history reload shows the same message with the same id).

### HTTP behaviour

No new routes. `GET /api/sessions/:id/unattended` and the POST result include the new state
fields. `POST` action semantics added by v2:

- `stop` → `status: "stopped"`, `pausedBy: "user"`.
- `resume` → clears `pausedBy`; runs `evaluateNow` **only** when no turn is streaming and no
  delivery is queued — otherwise the turn-end settle evaluates.
- `start` same rule for its default `evaluateNow`.
- A real user message that arrives while `active` is paused first (`status: "stopped"`,
  `pausedBy: "input"`) and then delivered normally. System-injected messages
  (`🔇`-prefixed: autoContinue/bgCheck/bg-completion/dispatch results/cron) and any message
  carrying the marker never pause it.

### Queue ordering

There is no backlog-evidence input to `buildVerdictPrompt`. Ordering is entirely the
session-work scheduler's job (`src/session-work/scheduler.js`):

- a pending `wait_for_user_answer` gates the FIFO (`blockedByUserInput`); the matching
  answer is selectable first and the FIFO resumes after it;
- an E fault leaves ordinary FIFO work staged; a direct continuation / control item is
  immediately selectable, and the FIFO stays put until a D verdict or an explicit
  `insert_queued`;
- a D verdict drains the FIFO automatically.

Consequently the supervisor's auto-answer (W) and fault-continue (E) reach the scheduler
as `continuation` work (`directRun`) and are selected before the staged backlog. When a D
settle still has queued deliveries, the supervisor defers its verdict
(`{ ok:false, code:'backlog_pending' }`, held push released) — `hasQueuedDeliveries` is the
one read-only scheduler question it asks.

### Fault (E) continuation

After the API-error policy has finished with an E (its own scheduled retry → do nothing),
the supervisor injects `<marker> …故障后继续…` **without** an aux call. It increments the
informational `rounds` counter; 3 consecutive faults → `needs_human` (reason: repeated
faults). The text only asks the agent to resume from where it stopped and verify state
before redoing side effects. A user Cancel is not a fault. A clean D/W settle resets the
fault counter.
