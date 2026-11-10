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
   first message text) and acceptance criteria (optional list, can be drafted by aux via
   the existing precheck), and `maxRounds`. The first message is then sent with
   `unattended: { goal?, criteria?, maxRounds? }`.
2. **Mid-conversation**: a floating icon on the chat page (Web `chat.html` and Flutter
   `chat_screen`). Click → panel: goal textarea, criteria list (editable), maxRounds,
   "AI 补全判断标准" (precheck), Start / Stop / Resume, and a live status block
   (round n/N, last verdict + reason, history). The icon state: idle (grey), active
   (green, pulsing), needs_human (amber), achieved (check), stopped/exhausted/error (red/grey).
   Takeover works at any time, also when the agent is idle: `start` with
   `evaluateNow` runs one verdict on the last output right away.

A goal or criteria is mandatory (`goal` non-empty; criteria optional but recommended).

## Persisted state: `record.unattended` (null when never used)

```json
{
  "status": "active | achieved | needs_human | exhausted | stopped | error",
  "goal": "string, <= 2000 chars",
  "criteria": ["<= 12 items, each <= 300 chars"],
  "maxRounds": 30,            // 1..200, default 30. Counts auto follow-ups only.
  "rounds": 0,                // auto follow-ups sent so far
  "startedAt": 0, "updatedAt": 0,
  "lastVerdict": { "verdict": "achieved|continue|needs_human", "reason": "", "nextInstruction": "", "humanReason": "", "at": 0 },
  "history": [ { "at": 0, "verdict": "continue", "reason": "" } ],   // last 10
  "stall": { "sameInstruction": 0, "auxFailures": 0 }
}
```

`status === 'active'` is the only armed state. Everything else is terminal until `resume`/`start`.

## HTTP

- `GET  /api/sessions/:id/unattended` → `{ ok, unattended: <state|null>, limits: { maxRoundsDefault: 30, maxRoundsMax: 200 } }`
- `POST /api/sessions/:id/unattended` body `{ action, ... }` → same shape as GET.
  - `start`: `{ goal, criteria?, maxRounds?, evaluateNow? (default true) }`. 400 `goal_required`.
  - `update`: `{ goal?, criteria?, maxRounds? }` on an active/needs_human state.
  - `stop`: status → `stopped`.
  - `resume`: from `needs_human | exhausted | stopped | error` back to `active`, `rounds` reset to 0 for `exhausted`, kept otherwise; runs `evaluateNow`.
  - 404 unknown session, 409 for terminal/aux-less states where it cannot apply, 400 bad action.
- Precheck is unchanged: `POST /api/goal/precheck { task, dimensions? }` →
  `{ ok, verdict, score, issues[], questions[], criteria[], revised, ... }`; `/api/settings/goal`
  unchanged. Only the user-facing wording changes to "目标预检 / Goal precheck" under unattended mode.
- Task creation: `POST /api/task-shell-tasks/:taskId/messages` and the chat WebSocket
  `user_message` accept `unattended: { goal?, criteria?, maxRounds? }` on the first message.
  Legacy alias (old Flutter builds): `goal: true` + `goalLimits.maxRounds` is mapped to
  `unattended: { maxRounds }`; nothing else about Goal mode survives (no prompt wrapper, no
  limits note, no `goalLimits` in the turn request).
- WebSocket (chat) event: `{ type: 'unattended_state', unattended: <state|null> }`, broadcast on every change and
  replayed on connect. The session DTO (`/api/sessions/:id`, `/api/air` task rows) carries `unattended`
  (Air rows may carry the compact `{ status, rounds, maxRounds }`).

## Supervisor loop (src/unattended/ glue + native/core/src/unattended.rs kernel)

Trigger: classify settles a turn (letters D or W) of a chat session whose
`unattended.status === 'active'`; plus `evaluateNow`. Not on B (background work pending) or
E (fault — existing API-error policy owns it). One evaluation in flight per session.

1. Evidence: goal, criteria, last assistant output (truncated), a few recent messages, previous
   verdicts, and the pending user-input question + options when the turn ended on one.
2. Rust kernel builds the verdict prompt; aux (`type: 'unattended_verdict'`, interactive
   priority) answers JSON `{ verdict, reason, nextInstruction, humanReason, answer? }`.
3. Rust kernel parses + decides the next state/action (budget, stall, parse failure policy).
   - `achieved` → status `achieved`, `goalState: achieved`, success push.
   - `continue` → inject `nextInstruction` as a system-injected message (prefix
     `【无人值守】`), `rounds += 1`. If the turn ended on a pending user-input question the
     aux picks the option/answer itself and it is delivered the way a user's answer is
     (resolves the request). If `rounds >= maxRounds` → `exhausted` + notify.
   - `needs_human` → status `needs_human`, **notify the human** (push + chat notice) with `humanReason`.
     Only for: credentials/secrets/captcha/2FA/payment, physical-world actions, irreversible or
     destructive approvals the goal did not authorize, facts only the user knows, or a blocker the
     agent demonstrably cannot overcome. Everything else the aux decides itself.
   - Same normalized instruction 3 times in a row → `needs_human` (stalled). 2 consecutive aux
     failures/unparseable replies → status `error` + notify.
4. A real user message does not disarm it (it resets `stall` only). A user Cancel
   (`manual_cancel`) sets `stopped`. Server restart keeps the persisted state; it re-arms on the next
   turn end (no verdict at boot).

## Removal list

Web: 🎯 `#goal-btn`, `#goal-modal`, `goalWrap`, `sendGoal`, chat-composer `goal` option;
Air quick-task "Goal" checkbox + limits (becomes the unattended toggle); Flutter `input_bar` goal
button/dialog, `goalLimits` plumbing. Server: `resolveGoalLimits`, `buildGoalLimitNote`,
`goal-limit` context layer, `goalLimits` in task-shell runtime / turn request (JS + Rust
`turn_request.rs`). i18n keys for the removed UI are deleted; new keys added in both languages.
