# Status presentation

Every user-visible status badge in MultiCC — Web session list, Fleet cards, task
board rows and detail, chat status bar, queue dock, mobile web, and the Flutter
app — is drawn by one registry. This document explains the rules; it is **not** a
second source of truth.

| layer | owns | file |
| --- | --- | --- |
| state | what the status *is* | server (see below) |
| presentation | how the status *looks* | `public/status-presentation.js` (Web) · `app/lib/utils/status_presentation.dart` (App) |
| copy | what the status *says* | `app/assets/i18n/{zh,en}.json` → `public/i18n-catalog.js` |
| skin | tone → colour, spinner keyframes | `public/status-badge.css` |

If this document and the registry disagree, **the registry wins**.
`tests/test-status-presentation.js` pins the registry against the server tables
and against the Dart mirror, so drift fails the build rather than reaching a card.

## Fact sources (server, unchanged)

The display layer never invents state. It consumes:

- `src/classify/vocab.js` `TURN_RUN_STATES`
  `{queued, running, waiting, background, succeeded, error, idle}` — **the** run
  state vocabulary. `src/task-board/normalize.js` builds its `TASK_RUN_STATES` set
  from it instead of keeping a copy.
- `src/session-work-host.js` `getRunState(sessionId)` — session run state, one of
  the above.
- `src/session-work-scheduler.js` `FREEZE_REASON_RUN_STATE` — freeze reason enum
  key → run state. Derived from `FREEZE_REASON_CLASSIFY` (reason → classify
  letter) through `runStateForClassify()`, so a letter-backed freeze reason can
  never render differently from the same letter's settled verdict.
- `src/classify/vocab.js` `CLASSIFY_DISPLAY` — classify letter `D/W/B/E/P` →
  `{cardStatus, barTint}`.
- `src/task-board.js` `task.status` `{active, done, archived}` plus the
  aggregated `task.runState`.

Two things are explicitly **not** business state and must never drive a badge:

- **Process liveness** (`isStreaming`, `claudeProc`, `active`). The liveness
  verdict `{working, idle, stalled, unknown}` from `src/liveness/runtime.js` has
  its own pill. A live-but-unoccupied session is `idle`, not `running`; `active`
  is read only to tell `idle` from `offline` when there is no business signal.
- **Terminal text, log lines, natural-language regexes.** A badge is never
  derived from what a model or a CLI printed.

## Two domains, deliberately not fused

A session's lifecycle and a board task's lifecycle answer different questions —
"is this agent free?" vs "is this piece of work finished?" — so they stay
separate enums that happen to share most members.

| | session | task |
| --- | --- | --- |
| shared | `idle` `queued` `running` `waiting` `background` `blocked` `error` `done` `cancelled` `unknown` | same |
| domain-only | `offline` | `archived` |

`coerceStatus('session', 'archived')` and `coerceStatus('task', 'offline')` both
fall to `unknown` rather than leaking across domains.

## Canonical statuses

| status | icon | tone | spinner | terminal | priority | meaning |
| --- | --- | --- | --- | --- | --- | --- |
| `error` | ❌ | `danger` | no | no | 90 | a fault the user must see. Retryable, therefore **not** terminal. |
| `blocked` | 🔒 | `blocked` | no | no | 80 | frozen on something to fix elsewhere (auth/config), not on a reply. |
| `running` | 🔄 | `running` | **yes** | no | 70 | the only status allowed to animate. |
| `queued` | 📥 | `info` | no | no | 60 | admitted, not started. |
| `waiting` | ⏸️ | `waiting` | no | no | 50 | waiting for *your* reply in this conversation. |
| `background` | ⏳ | `info` | no | no | 45 | idling on a background job (`B`): a callback or a dispatched worker is still out there. Nothing is asked of you. |
| `done` | ✅ | `success` | no | yes | 30 | finished. |
| `cancelled` | 🚫 | `muted` | no | yes | 25 | you stopped it. Never rendered as completed. |
| `archived` | 🗄 | `muted` | no | yes | 20 | task filed away (task domain only). |
| `offline` | ⊘ | `muted` | no | no | 15 | no run state and the record is inactive (session domain only). |
| `idle` | ⚪ | `neutral` | no | no | 10 | alive, nothing in flight. |
| `unknown` | ❔ | `neutral` | no | no | 0 | value this build does not recognise. |

Rules this table encodes:

1. **`spinner: true` exists on exactly one status.** That single fact is what
   guarantees an errored card stops spinning the instant it turns red — there is
   no per-surface "stop the animation" code to forget.
2. **Priority is fault-first.** When several signals coexist on one card,
   `highestPriority()` picks the largest number, so a failure is never masked by
   an optimistic parallel signal. `sessionCardStatus()` additionally short-circuits:
   if *any* of `runState` / `workspaceStatus` / `monitorStatus` says `error`, the
   card says `error`.
3. **`unknown` is neutral, never success and never running.** An unrecognised
   value must not read as "finished" or "still going". Every hit is recorded in a
   bounded ring (`unknownStatusDiagnostics()`, 50 entries) and warned once.
4. **Waiting ≠ blocked, and neither borrows the error icon.** ⏸️ means "answer
   me"; 🔒 means "go fix a prerequisite". Both are normal, neither is a fault.
5. **`background` is not `waiting`.** ⏸️ asks you something; ⏳ does not — it means
   the turn is idling on a callback or a dispatched worker. Folding `B` into
   `waiting` put 「等待回答」 on cards nobody can answer, and made them compete for
   the same attention as a real question. It ranks below `waiting` (a question
   always outranks it) and above `succeeded`; faults still outrank it, so a
   background wait never masks a failure. `background` is also *busy* for
   scheduling purposes: merge eligibility and Air's "does this need me?" line
   both treat it like `running`.
6. **Status is never carried by colour alone** (WCAG 1.4.1). Every badge renders
   an icon plus an accessible name; the visible label is optional.

## Legacy and adjacent vocabularies

Alias mapping happens in **one** place, `STATUS_ALIASES` in the registry.
Per-page alias logic is a bug: it drifts, and drift is how an errored session
card ended up with no error icon at all.

| incoming vocabulary | examples | folds to |
| --- | --- | --- |
| classify `cardStatus` | `completed` | `done` |
| workspace agent status | `thinking`, `editing` | `running` |
| scheduler `queueState` | `starting`, `assessing` | `running`; `frozen` → `waiting` |
| task lifecycle | `active` | `running` |
| aux job status | `processing` | `running`; `cancelled` → `cancelled` |
| historic failure words | `failed`, `fail`, `errored` | `error` |
| stop words | `aborted`, `interrupted` | `cancelled` |
| scheduler bookkeeping | `skipped`, `released` | `idle` |
| disconnection | `stopped`, `disconnected`, `inactive` | `offline` |

One mapping is a deliberate **display-layer divergence** from the server, pinned
by a test that asserts it is the *only* divergence in its table:

- `configuration_required` → `blocked` (server: `waiting`). The server is right
  that the user must act; the action is "go set up auth/config", not "answer
  here", so it gets the lock rather than the pause.

`awaiting_callback` and `classify_background` are **not** a divergence: the
scheduler's derived table says `background` for both, and the registry agrees.

Classify `E` used to be a second divergence: the server's `cardStatus` said
`waiting` while its `barTint` said `error`, so one terminal fact rendered as ⏸️
on the session list and ❌ in the chat bar. `E.cardStatus` is now `error` too —
see [cancel-state-flow.md](cancel-state-flow.md), where that split was half of
the "internal error, external something-else" bug.

`cancelled` is presentation-only: the server has no `cancelled` letter — a user
stop is the same abnormal end as an API fault (`E`), distinguished by the
`cancelReason` / `cancelledAt` envelope rather than by a separate terminal value.
The status exists so a surface that *does* know the reason can say "you stopped
this" instead of "the provider failed"; an interrupted turn must never be dressed
up as completed.

## One word per status per surface

Air (the sidebar task rows and the console) prints statuses in its own words —
the ones the workspace-lease and workflow-stage words next to it use. That
vocabulary lives in the registry's `airLabelKey` column, one entry per spec:

```js
SP.airStatusLabels(window.t)      // every canonical status → its Air word
SP.airStatusLabel('background', window.t)
SP.airStatusWordFor(rawValue, window.t)  // alias-tolerant; '' for non-statuses
```

`public/air.js` builds its `stateNames` from it, `public/air-admin.js` builds its
`STATUS_COPY` from it, and the app's `airStatusWord()` reads the same column. Two
hand-kept copies of that table (one in each Air script, one in each of two Dart
files) is exactly how one Air surface started calling a background wait
「等待回答」 while another called the same status something else. Adding an Air
word means adding one `airLabelKey` and one key per locale — never a new table.

## Component usage

```html
<!-- manage.html / chat.html, before the page scripts -->
<link rel="stylesheet" href="status-badge.css">
<script src="status-presentation.js"></script>
```

```js
const SP = window.MultiCCStatusPresentation;

// 1. derive the canonical status from server fields
const status = SP.sessionCardStatus({ runState, workspaceStatus, freezeReason, active });
const taskState = SP.taskStatus(task);            // {status, runState}
const fromLetter = SP.classifyStatus('E');        // 'error'
const fromFreeze = SP.freezeReasonStatus(reason); // fallback 'waiting'

// 2a. innerHTML renderers
el.innerHTML = SP.statusBadgeHtml('task', status, { translate: window.t, showLabel: false });

// 2b. live nodes — idempotent, safe to call on every snapshot/replay
SP.applyStatusBadge(node, 'session', status, { translate: window.t, reason });
```

Both renderers emit the same markup, so a surface can switch between them
without changing its CSS or its tests:

```html
<span class="mc-status st-tone-danger" role="img"
      data-status-domain="session" data-status="error"
      title="异常 · classify_error" aria-label="状态：异常 · classify_error">
  <span class="mc-status-ico" aria-hidden="true">❌</span>
  <span class="mc-status-label">异常</span>
</span>
```

Notes for callers:

- `applyStatusBadge` is **idempotent**: repeated calls (WebSocket snapshot,
  replayed event, duplicate broadcast) always leave exactly one icon and one
  label, always re-resolve the tone class, and always drop `st-spin` when the
  status is not `running`. `running → error → running` leaves no stale glyph.
- `reason` is passed through `sanitizeReason()` before it reaches `title` or
  `aria-label`: known enum keys pass as-is, anything else has URLs, absolute and
  Windows paths and 24+ char tokens replaced with `…` and is capped at 120 chars.
  Never pass raw model output or user text.
- `translate` is the page's `t()`. When the aria key is missing from the
  catalogue the visible copy is used, so a badge is never left nameless.
- **Rendering a status must never advance one.** The registry is pure; it does
  not call the API, does not write state, and holds no timers.
- CSS ships `prefers-reduced-motion: reduce` — `.st-spin` stops animating there.

## Testing

`tests/test-status-presentation.js` (in `npm run test:security`) covers:

- **contract pins** — the classify and freeze tables have exactly the server's
  key sets and exactly the one divergence above; every server run state coerces
  to itself in both domains; the server's run-state list is read from
  `TURN_RUN_STATES` and `normalize.js` must build its set from it.
- **`B` never renders as a question** — classify `B` and its two freeze reasons
  are `background`; in both locales the badge word, the Air word and the
  accessible name differ from `waiting`'s and never say "answer"; every canonical
  status has a *distinct* Air word, so a future fold cannot disguise itself.
- **invariants** — only `running` spins; `error` is ❌ + `danger` + non-terminal +
  highest priority; `unknown` is never success or spinner.
- **coverage matrix** — every status × both domains × both renderers: one icon,
  correct glyph, `aria-hidden` on the icon, `role="img"`, non-empty aria-label and
  title, `data-status` attributes, tone class, `st-spin` iff `spec.spinner`.
- **idempotency / replay** — 5× apply, an 8-step transition replay, label toggling.
- **reason safety** — path/token/URL scrubbing, length cap, HTML escaping.
- **i18n** — every `labelKey`/`ariaKey`/`airLabelKey` present in both `zh` and
  `en`, with length caps so a long label cannot break a card.
- **Web ↔ Dart parity** — the Dart mirror's specs (including `airLabelKey`),
  aliases, freeze table, classify table and both vocabularies are parsed and
  deep-equalled against the JS registry.
- **single Air word source** — `air.js`, `air-admin.js`, `air_task_status.dart`
  and `air_service.dart` must derive their status words from the registry and must
  not carry a hand copy.

Adding a status means: registry → Dart mirror → both i18n files →
`npm run i18n:generate` → a `.st-tone-*` rule if the tone is new → the server
run-state list in `src/classify/vocab.js` if it is a run state. The parity and
catalogue tests fail until all of them are done.
