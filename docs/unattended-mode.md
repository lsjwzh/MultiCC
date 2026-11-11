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
  "retryAt": null,             // epoch ms of the armed fault retry, or null
  "retryCategory": "capacity | fault | null",
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
2. **优先级：解决等待/异常 → FIFO → 普通自动接续。** 无人值守处于 `active`
   时，W 等待和 E 异常保持 FIFO 暂存，先由无人值守回答问题或发送恢复指令。
   恢复回合正常完成后，按用户重排后的顺序发送 FIFO；队列清空后才发送普通自动
   接续。恢复消息使用 `unattendedRecovery` 标记，与普通 `unattendedSystem` 消息区分。
   恢复无人值守时，有 FIFO 也不能跳过等待/异常处理；普通自动接续不能冒充恢复指令。
   D 正常完成且 FIFO 尚未清空时推迟辅助判定，不新增普通鞭策消息。普通判定期间
   若又有排队或运行中的工作，丢弃过时结果，等待新工作结束；等待/异常的恢复判定
   不因 FIFO 积压而跳过。活动回合不受抢占，B 后台等待保留既有调度规则。
   新业务规则均在 Rust 内核。现有 Node 宿主仅保留必要的状态、队列和消息元数据
   桥接；后续 Rust 接管调度宿主接口时移除这些桥接。
3. **等待与故障优先恢复。**
   - Turn ended on a pending user-input question: the aux picks the answer (`answer`) and it is
     delivered right away (resolves the request).
   - Turn ended in fault E (not a user Cancel): after the existing API-error policy has finished
     with it (it either scheduled its own retry — then do nothing — or gave up), continue
     WITHOUT an aux call. The first fault continues immediately (`fault_continue`); later
     consecutive faults back off 60 s / 120 s / 300 s / 600 s / 900 s and persist `retryAt`
     (`fault_wait`), injected by the durable retry timer. A fault streak is never capped: the
     wall-clock deadline is the only bound. Human-only categories (auth/permission, billing,
     invalid request/model, adapter configuration) stop immediately and name the cause. Never
     replay side effects: the instruction only says to resume from where it stopped and check
     state before redoing anything.
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
- `retryAt: epoch ms | null` — the durable fault-retry deadline. Set only by
  `fault_wait`; cleared by the host when the timer fires, by a clean D/W settle, `resume`,
  `stop`/pause, expiry and boot migration (non-active records). Present on
  `unattended_state`, GET/POST responses, the session DTO and the session schema.
- `retryCategory: "capacity" | "fault" | null` — `capacity` for rate limits, transient
  provider/network/timeout errors, `preparation_failed` and `candidate_pool_exhausted`
  (the UI words these as a provider/quota outage); `fault` for every other recoverable
  fault. See “Fault (E) continuation” below.

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
- A second, independent `setTimeout` per active session runs the durable fault retry: armed
  to `retryAt` and cleared/re-armed by the same `write()` path (so stop, pause, resume, user
  takeover, expiry, shutdown and a new turn by any other path all clear it). On fire it
  re-checks active, expiry first, `retryAt` due and no active turn, then clears `retryAt` and
  injects the recovery instruction with `{ unattendedRecovery: true }` — the scheduler's
  `select_queued` puts that above FIFO and ordinary continuations. Boot re-arms it for every
  persisted active record; a `retryAt` in the past fires promptly.
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
| fault-wait | `[无人值守 Unattended] 故障后将在 HH:MM 自动重试（第 <n> 次）` |
| fault-wait (capacity) | `[无人值守 Unattended] 上游额度/线路暂不可用，将在 HH:MM 自动重试（第 <n> 次）` |

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

`buildVerdictPrompt` 不读取 FIFO 消息正文。调度器把队列摘要和无人值守状态交给
`native/core/src/unattended.rs::select_queued`：

- `active` 且执行位置已释放时，关联问题的回答和明确的恢复指令优先。
- W/E 尚未恢复时继续暂存 FIFO 和普通自动接续；恢复为 D 后按队列顺序处理 FIFO。
- FIFO 清空后才发送普通自动接续；兼容旧版固定前缀和新版消息标记。
- 暂停、人工接管、到期、活动回合与后台等待保留原有调度边界。

`hasQueuedDeliveries` 只提供积压事实；是否推迟判定由 Rust 结合等待/异常状态决定。

### Fault (E) continuation and backoff

After the API-error policy has finished with an E (its own scheduled retry → do nothing),
the supervisor continues **without** an aux call. Fault recovery is never capped by a
streak counter: the wall-clock deadline is the only bound. On the n-th consecutive fault
(after increment) the kernel delays the next continuation by `FAULT_BACKOFF_MS`
(`native/core/src/unattended.rs`):

| n | delay before the next attempt |
| --- | --- |
| 1 | 0 → `fault_continue`, inject immediately |
| 2 | 60 s |
| 3 | 120 s |
| 4 | 300 s |
| 5 | 600 s |
| ≥ 6 | 900 s |

The retry time is `max(now + backoff, retryNotBefore)`, where `retryNotBefore` is the
earliest known provider unblock hint: this session's Auto candidate pool reports the
earliest parked candidate (`blockedUntilMs`) or full-quota-window reset
(`resetMs`/`resetsAtMs`) when **no** candidate is usable. When no hint exists (for example
a turn-scoped unsafe-failure-phase refusal, or a non-Auto session) the backoff alone
applies. Delay 0 → `fault_continue` (host injects now); delay > 0 → `fault_wait` with
persisted `retryAt`/`retryCategory`, and the durable retry timer performs the injection.
The kernel persists a timezone-free decision; the host formats HH:MM in traces and notices.

Faults a human must fix stop immediately (`needs_human`) with the cause named in Chinese:
`authentication_permission`, `billing_quota`, `invalid_request_model`,
`adapter_configuration`. These are the categories in
`native/core/src/api_error_policy.rs` where retrying cannot help (credential/permission,
balance/quota, invalid request/model, adapter/CLI configuration); everything else —
including `rate_limit`, `provider_transient`, `network`, `timeout`, `context_token_limit`,
`tool_protocol`, `cancel_shutdown` and `unknown` — is retried with backoff. A retry whose
computed time is at/after `deadlineAt` also stops (`retry_past_deadline`): it could never
run inside the budget.

The text only asks the agent to resume from where it stopped and verify state before
redoing side effects; the replay-safety rules are unchanged (an unsafe replay boundary
still fails fast). A user Cancel is not a fault. A clean D/W settle resets
`consecutiveFaults` and clears `retryAt`/`retryCategory`; `resume` resets the streak too.
When the streak first reaches 3 the host sends exactly one waiting push/notice: the session
stays active, and the notice names the next attempt time and says the user can pause to
take over. There is no "3 rounds then give up" path anymore.

**Priority:** fault recovery (immediate continuation or the fired retry timer) outranks
staged FIFO, which outranks ordinary automatic continuation. `select_queued` recognises the
recovery message and the `unattendedRecovery` marker before any FIFO item.

### Every turn end has exactly one supervisor result

One entry (`onTurnEnd(sessionId, facts)` in `src/unattended/host.js`) receives **every** way
a turn can end. The host passes facts only; `decide_turn_end` in
`native/core/src/unattended.rs` owns the policy and returns exactly one action. When a turn
ends with no supervisor notice of its own, the held classic classify push is released, so a
settle is never silent.

Source attribution is evaluated before the end `kind` and does not depend on it. A turn end
whose `killReason`/`cancelSource` names a user source always pauses and never injects: the
three message-carrying sources (`insert_queued`, `force_insert`, `new_user_message`) pause as
`pausedBy:'input'`, every other user source pauses as `pausedBy:'cancel'`, and this holds even
when the same event is reported as an `E` fault. The host assigns the kill reason *before* it
stops a runner, so a user cancel can never reach the kernel as `fault_continue`.

Exactly one supervisor result is produced per turn, idempotently by persisted turn identity.
Every acting decision stamps the kernel's `lastTurnEndId` with the reported `turnId`; a repeat
report for the same turn returns `none` / `duplicate_turn`, and a later report that carries
user attribution for an already handled turn returns `pause` /
`duplicate_user_takeover` (the stronger factual take-over only pauses, it never injects a
second time).

| End type (fact) | Kernel action |
| --- | --- |
| D settle, no staged backlog (`settle:'D'`) | `evaluate` (Aux verdict) |
| D settle, staged backlog (`backlogPending`) | `none` / `backlog_pending` — defer; release held push |
| W settle (`settle:'W'`, pending question) | `evaluate` — the Aux answers the question |
| E fault, API policy scheduled its retry (`retryScheduled`) | `none` / `policy_retry` |
| E fault (rules path) or host-interrupted turn, recoverable category | `fault_continue` (delay 0) or `fault_wait` with persisted `retryAt`; never a streak cap |
| E fault whose category is human-only (`authentication_permission`, `billing_quota`, `invalid_request_model`, `adapter_configuration`) | `needs_human` immediately, naming the cause |
| Computed retry time at/after `deadlineAt` | `needs_human` / `retry_past_deadline` |
| Any end whose attribution is a user source (checked before `kind`) | `pause` / `pausedBy:'cancel'` or `'input'` — user sources never inject |
| Repeat report for an already handled turn (`lastTurnEndId === turnId`) | `none` / `duplicate_turn` |
| Later report carrying user attribution for a handled turn | `pause` / `duplicate_user_takeover` |
| User cancel: `manual_cancel`, `task-shell`, `user_cancel`, `cancel_repeat`, `dispatch_cancel` | `pause` / `pausedBy:'cancel'` |
| User cancel that carries a message: `insert_queued`, `force_insert`, `new_user_message` | `pause` / `pausedBy:'input'` (takeover) |
| Host-side cancel: `process_watchdog`, `stalled_recovery`, `*_log_watchdog` / `provider_log_error`, `restart_spawn`, `restart_recovery`, `shutdown`, `cli_switch`, `relocate`, `preparation_failed` | fault continuation with backoff (`preparation_failed` is `capacity`); no 3-fault cap |
| Persisted `retryAt` reached (retry timer) | `fault_continue` injection with `unattendedRecovery` (recovery priority over FIFO) |
| Cancel with unrecognized attribution | `pause` / `pausedBy:'cancel'` — fail safe: unlock input, never inject against a possible user stop |
| Real user message (`noteUserMessage`) | `pause` / `pausedBy:'input'`, then delivery |
| Wall-clock deadline (timer) | `exhausted` |
| Any of the above on a non-active session | `none` |

Why a host-side interruption is a fault: a watchdog/restart/stalled-recovery cancel is a
statement about the **host or upstream**, not about the user's goal. Treating it as "turn
finished" left the session `active` (input locked) with nothing running after the incident
of 2026-11-10. Treating it as a user Cancel would silently abandon a goal the user never
stopped. It therefore follows the same continuation policy as an API fault: back off on
consecutive host interruptions and keep retrying; only the deadline (or a human-only error
category) stops it.

Turn identity: `turnId` is the dedupe key, so it must name the turn that really ended.
`taskState.turnId` is written at turn **end** and therefore names the previous, already
settled turn. A cancel gets its identity from (in this order) the in-memory
`_activeTurn.turnId`, the persisted `activeTurnId` while classify is processing, and — for a
record from before that field or a turn that died before the start write — a fresh
`turn_recovery_<uuid>` id. It never falls back to `taskState.turnId`: a stale id matches
`lastTurnEndId`, makes the recovery cancel a `duplicate_turn`, injects nothing and leaves the
input locked. `ensureCurrentTask` (src/classify/state-machine.js) persists `activeTurnId`
inside the same P write that starts the turn — one disk save, not a separate identity save —
and every classify settle clears it. A turn that fails between that write and the runner
handoff (message composition, spawn guard, runtime start, rejected runner) has no finalizer
of its own: the turn engine cancels it through the same entry with
`cancelSource:preparation_failed` (a host-side source, so an armed supervisor continues
under the same backoff policy) instead of leaving a phantom P turn for the watchdog.

A policy-scheduled retry does not claim the turn: an E fault with `retryScheduled:true`
returns `none` / `policy_retry` and writes no next state, so neither `lastTurnEndId` nor
`lastSettleAt` moves. The API retry reuses the same turn object, and its real D/W/E settle
must still evaluate.

What the three kill-capable host paths actually do: a **CLI switch** never kills a live
turn — while the session is busy (`configurationBusy`) the switch is staged and applied at
the next turn boundary, so it produces no turn-end report of its own. A **relocate** refuses
an active session unless forced; the task-board move forces it, kills the runner with
`killReason:relocate`, and the runner's process-exit finalizer reports that killed turn as an
`E` fault carrying the same kill reason through this one entry. **Shutdown** tears the
processes down without a guaranteed turn-end report (the server is exiting); that turn is
recovered at the next boot instead, see below.

A pause also withdraws the supervisor's own not-yet-started work. The supervisor's `inject`
goes through the session-delivery boundary, whose admission result names the scheduler entry
and whether it is still `queued`. Every write that leaves `active` (pause, achieved,
needs_human, expiry, error) asks `sessionScheduler.cancelQueued(entryId)` for exactly those
entries, so a takeover cannot leave one more unattended round waiting in the FIFO. A
delivery the scheduler already claimed is left to the normal turn-end/cancel path. The
tracking map is in memory (known limitation): after a restart the supervisor has no record
of continuations it admitted before the restart, so those already-queued entries cannot be
withdrawn even if the user takes over; the persisted turn end owns the outcome instead.

Restart re-settle: a restart can settle a turn before this host is ready (the processing
watchdog writes `E` + `cancelledAt` straight to the task state). After
`orchestrationRuntime.start()`, `reconcileStartup()` replays those cancelled settles exactly
once: it requires an active unattended record, a persisted `cancelSource`, a settle newer
than `lastSettleAt`, and no live scheduler slot. Every handled state write persists
`lastSettleAt`, so a settle the live host already handled is never replayed and one settle
can never inject twice. Replay is bounded to the current run: only turn ends settled after
the current run's `startedAt` (and newer than `lastSettleAt`) are replayed; anything older is
history from an earlier run, not new work.

A shutdown or forced teardown can leave no cancel record at all: the task state is still
`P` with the persisted `activeTurnId`. Orphan recovery has exactly **one** owner — the
processing watchdog — and boot reconciliation deliberately does nothing for this shape
(`reconcileStartup()` only replays recorded cancels). At `orchestrationRuntime.start()` the
expired leases are recovered and `scheduler.recover()` runs first: when the old schedule
survived it re-parks the P slot as `frozen/classify_running`; when it did not, session
status is simply idle. Either way the watchdog's next sweeps see a processing letter with
no live child (or stream), mark it suspect, and after the dead-runner confirmation window
cancel it through the one entry with `cancelSource:process_watchdog` and the persisted
in-flight turn id. That cancel is a host interruption, so the continuation follows the
normal fault policy; its `lastTurnEndId` makes any later report (including a second boot)
a `duplicate_turn`, and a still-staged interrupt notice drains only after that
continuation's own D.
