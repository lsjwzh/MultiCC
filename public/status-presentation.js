(function attachMultiCCStatusPresentation(global) {
  'use strict';

  // ── Centralized status presentation registry ────────────────────────────────
  //
  // ONE place that answers "how do I draw this status" for every user-visible
  // surface (web session list, fleet cards, task board, chat bars, queue dock,
  // mobile web). The Flutter app mirrors this file in
  // app/lib/utils/status_presentation.dart; tests/test-status-presentation.js
  // pins the two to the same canonical vocabulary.
  //
  // THIS FILE IS NOT A SOURCE OF TRUTH FOR STATE. The server owns state:
  //   · session run state  — src/session-work-host.js getRunState(), whose
  //     vocabulary is src/task-board.js TASK_RUN_STATES
  //     {queued,running,waiting,error,done,idle}
  //   · freeze reasons     — src/session-work-scheduler.js FREEZE_REASON_RUN_STATE
  //   · classify letters   — src/classify/vocab.js CLASSIFY_DISPLAY (D/W/B/E/P)
  //   · task lifecycle     — src/task-board.js task.status {active,done,archived}
  // Everything below is a pure (canonical value) → (icon, tone, copy) mapping.
  // Never infer state here from terminal text, log lines, or natural language,
  // and never read process liveness (isStreaming / claudeProc): the liveness
  // verdict {working,idle,stalled,unknown} has its own pill and is deliberately
  // NOT a business status.
  //
  // The two domains are kept separate on purpose. A session's lifecycle and a
  // board task's lifecycle answer different questions ("is this agent free?" vs
  // "is this piece of work finished?") and must not be fused into one enum.

  // ── Domain vocabularies ─────────────────────────────────────────────────────

  // Session lifecycle. `runState` verbatim, plus two presentation-only members:
  //   blocked — frozen on something the user must go fix elsewhere (not a reply)
  //   offline — no run state at all (record absent / session not active)
  const SESSION_STATUSES = Object.freeze([
    'idle', 'queued', 'running', 'waiting', 'blocked', 'error', 'done', 'cancelled',
    'offline', 'unknown',
  ]);

  // Task lifecycle. task.status {active,done,archived} refined by the aggregated
  // task.runState the server computes in src/task-board.js.
  const TASK_STATUSES = Object.freeze([
    'idle', 'queued', 'running', 'waiting', 'blocked', 'error', 'done', 'cancelled',
    'archived', 'unknown',
  ]);

  const DOMAIN_STATUSES = Object.freeze({ session: SESSION_STATUSES, task: TASK_STATUSES });

  // ── Presentation spec ───────────────────────────────────────────────────────
  //
  // icon      — the ONE glyph for this status everywhere. Status is never carried
  //             by colour alone (WCAG 1.4.1): every badge renders icon + an
  //             accessible name, and optionally a visible label.
  // tone      — semantic colour token, resolved by status-badge.css. Not a hex.
  // spinner   — may this status animate? Only `running`. This is what guarantees
  //             an errored card stops spinning the moment it turns red.
  // terminal  — is this a resting end state? `error` is deliberately NOT terminal:
  //             it is retryable, and calling it terminal would invite hiding it.
  // priority  — who wins when several signals coexist. Faults outrank progress so
  //             a failure is never masked by an optimistic parallel signal.
  const STATUS_PRESENTATION = Object.freeze({
    idle: Object.freeze({
      icon: '⚪', tone: 'neutral', spinner: false, terminal: false, priority: 10,
      labelKey: 'statusIdle', ariaKey: 'statusAriaIdle',
    }),
    queued: Object.freeze({
      icon: '📥', tone: 'info', spinner: false, terminal: false, priority: 60,
      labelKey: 'statusQueued', ariaKey: 'statusAriaQueued',
    }),
    running: Object.freeze({
      icon: '🔄', tone: 'running', spinner: true, terminal: false, priority: 70,
      labelKey: 'statusRunning', ariaKey: 'statusAriaRunning',
    }),
    waiting: Object.freeze({
      icon: '⏸️', tone: 'waiting', spinner: false, terminal: false, priority: 50,
      labelKey: 'statusWaiting', ariaKey: 'statusAriaWaiting',
    }),
    blocked: Object.freeze({
      icon: '🔒', tone: 'blocked', spinner: false, terminal: false, priority: 80,
      labelKey: 'statusBlocked', ariaKey: 'statusAriaBlocked',
    }),
    error: Object.freeze({
      icon: '❌', tone: 'danger', spinner: false, terminal: false, priority: 90,
      labelKey: 'statusError', ariaKey: 'statusAriaError',
    }),
    done: Object.freeze({
      icon: '✅', tone: 'success', spinner: false, terminal: true, priority: 30,
      labelKey: 'statusDone', ariaKey: 'statusAriaDone',
    }),
    // Presentation-only: the server folds a cancelled claim into runState 'idle',
    // but "you stopped this" and "nothing is happening" are different things to a
    // reader, and an interrupted turn must never be dressed up as completed.
    cancelled: Object.freeze({
      icon: '🚫', tone: 'muted', spinner: false, terminal: true, priority: 25,
      labelKey: 'statusCancelled', ariaKey: 'statusAriaCancelled',
    }),
    archived: Object.freeze({
      icon: '🗄', tone: 'muted', spinner: false, terminal: true, priority: 20,
      labelKey: 'statusArchived', ariaKey: 'statusAriaArchived',
    }),
    offline: Object.freeze({
      icon: '⊘', tone: 'muted', spinner: false, terminal: false, priority: 15,
      labelKey: 'statusOffline', ariaKey: 'statusAriaOffline',
    }),
    // Neutral landing pad for a value this build does not know. Never resolves to
    // success or running: an unrecognised status must not read as "finished" or
    // "still going". Every hit is recorded for diagnostics.
    unknown: Object.freeze({
      icon: '❔', tone: 'neutral', spinner: false, terminal: false, priority: 0,
      labelKey: 'statusUnknown', ariaKey: 'statusAriaUnknown',
    }),
  });

  // ── Legacy / alias compatibility (single point) ──────────────────────────────
  //
  // Historic and adjacent vocabularies land here and NOWHERE else. Per-page alias
  // logic is a bug: it drifts, and drift is how `error` ended up rendering as a
  // notepad glyph on the session card.
  //
  //   · classify cardStatus     — completed
  //   · workspace agent status  — thinking / editing / completed
  //   · scheduler queueState    — starting / assessing / frozen
  //   · task lifecycle          — active
  //   · aux job status          — processing / cancelled
  const STATUS_ALIASES = Object.freeze({
    // → done
    completed: 'done', complete: 'done', success: 'done', succeeded: 'done', finished: 'done',
    // → running
    thinking: 'running', editing: 'running', working: 'running', processing: 'running',
    starting: 'running', assessing: 'running', busy: 'running', active: 'running',
    claimed: 'running', resumed: 'running', started: 'running',
    // → waiting
    frozen: 'waiting', paused: 'waiting', pending: 'waiting',
    // → error
    failed: 'error', fail: 'error', errored: 'error',
    // → cancelled. Work the user stopped. The server folds this into runState
    // 'idle' (src/routes/task-board.js); the display layer keeps it distinct so a
    // stopped turn cannot read as either finished or still running.
    cancelled: 'cancelled', canceled: 'cancelled', aborted: 'cancelled',
    interrupted: 'cancelled',
    // → idle. A released or skipped claim is scheduler bookkeeping, not something
    // the user cancelled: nothing is in flight and nothing was stopped.
    skipped: 'idle', released: 'idle',
    // → offline
    stopped: 'offline', disconnected: 'offline', inactive: 'offline', gone: 'offline',
  });

  // freezeReason → status. Mirrors src/session-work-scheduler.js
  // FREEZE_REASON_RUN_STATE key-for-key, with exactly one presentation-layer
  // refinement: `configuration_required` is `blocked`, not `waiting`. The server
  // is right that the user must act, but the action is "go set up auth/config",
  // not "answer in this conversation" — so it gets the lock, not the pause.
  // tests/test-status-presentation.js asserts this is the only divergence.
  const FREEZE_REASON_STATUS = Object.freeze({
    awaiting_user_input: 'waiting',
    awaiting_callback: 'waiting',
    waiting: 'waiting',
    classify_waiting: 'waiting',
    classify_background: 'waiting',
    configuration_required: 'blocked',
    error: 'error',
    classification_error: 'error',
    unknown_interruption: 'error',
    legacy_unresolved: 'error',
    classify_error: 'error',
    delivery_recovery: 'running',
    continuation_ready: 'running',
    incomplete_requires_resume: 'running',
    classify_running: 'running',
    prelaunch_deferred: 'queued',
  });

  // classify letter → canonical status. Mirrors src/classify/vocab.js
  // CLASSIFY_DISPLAY: normally `cardStatus`, except that `E` is surfaced by its
  // `barTint: 'error'` rather than its `cardStatus: 'waiting'` — an API failure is
  // a fault the user must see as a fault, and the card is the only place some
  // surfaces show it. `C` is retired server-side but stays here so a replayed or
  // persisted old payload still renders instead of falling to unknown.
  // tests/test-status-presentation.js pins this against the server table.
  const CLASSIFY_LETTER_STATUS = Object.freeze({
    D: 'done', C: 'running', W: 'waiting', B: 'waiting', E: 'error', P: 'running',
  });

  /** classify letter (D/C/W/B/E/P) → canonical session status. */
  function classifyStatus(letter) {
    const key = String(letter || '').trim().toUpperCase();
    const hit = CLASSIFY_LETTER_STATUS[key];
    if (hit) return hit;
    if (key) recordUnknown('classify', key);
    return 'unknown';
  }

  // ── Diagnostics for unrecognised values ─────────────────────────────────────
  // Bounded ring so a misbehaving backend cannot grow this without limit.
  const UNKNOWN_LIMIT = 50;
  const _unknownSeen = new Map();   // `${domain}:${raw}` → { domain, raw, count }

  function recordUnknown(domain, raw) {
    const key = `${domain}:${raw}`;
    const hit = _unknownSeen.get(key);
    if (hit) { hit.count += 1; return; }
    if (_unknownSeen.size >= UNKNOWN_LIMIT) return;
    _unknownSeen.set(key, { domain, raw, count: 1 });
    try {
      global.console?.warn?.('[multicc/status] unrecognised status', { domain, raw });
    } catch (_) { /* console is optional */ }
  }

  function unknownStatusDiagnostics() {
    return [..._unknownSeen.values()].map(entry => ({ ...entry }));
  }

  function resetUnknownStatusDiagnostics() { _unknownSeen.clear(); }

  // ── Normalization ───────────────────────────────────────────────────────────

  function normalizeKey(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim().toLowerCase();
  }

  function coerceStatus(domain, raw) {
    const allowed = DOMAIN_STATUSES[domain];
    if (!allowed) throw new TypeError(`[multicc/status] unknown domain ${domain}`);
    const key = normalizeKey(raw);
    if (!key) return 'unknown';
    if (allowed.includes(key)) return key;
    const alias = STATUS_ALIASES[key];
    if (alias && allowed.includes(alias)) return alias;
    recordUnknown(domain, key);
    return 'unknown';
  }

  /**
   * Session lifecycle status from the canonical server fields.
   * @param {{runState?: string, freezeReason?: string, active?: boolean}} input
   *   runState     — getRunState(sessionId); null/absent means "no record".
   *   freezeReason — taskState.queueFreezeReason; an enum key, never free text.
   *   active       — the session record's own active flag, used only to tell
   *                  "offline" apart from "unknown" when there is no run state.
   */
  function sessionStatus(input = {}) {
    const raw = input.runState ?? input.status;
    if (normalizeKey(raw) === '') return input.active === false ? 'offline' : 'unknown';
    const base = coerceStatus('session', raw);
    // The single freeze-reason refinement. Applied only on top of `waiting`, so a
    // stale reason left over from an earlier freeze can never override a live
    // running/done verdict.
    if (base === 'waiting' && FREEZE_REASON_STATUS[normalizeKey(input.freezeReason)] === 'blocked') {
      return 'blocked';
    }
    return base;
  }

  /**
   * freezeReason enum key → canonical status, for surfaces that only hold the
   * reason (queue docks, freeze banners). Falls back to `waiting`: a freeze the
   * display layer does not recognise is a pause, never a fault and never success.
   */
  function freezeReasonStatus(reason, fallback = 'waiting') {
    const key = normalizeKey(reason);
    if (!key) return fallback;
    const hit = FREEZE_REASON_STATUS[key];
    if (hit) return hit;
    recordUnknown('freezeReason', key);
    return fallback;
  }

  /**
   * Session status folded from every signal a dashboard card holds at once.
   * @param {{runState?, workspaceStatus?, monitorStatus?, freezeReason?, active?}} input
   *   runState        — canonical getRunState() value, when the card has it
   *   workspaceStatus — /ws/workspace agent status (itself hydrated from classify)
   *   monitorStatus   — the client-side per-session notification status
   *   active          — process liveness. Used ONLY to pick idle vs offline when
   *                     there is no business signal at all. Liveness is not a
   *                     business status: a live-but-unoccupied session is `idle`,
   *                     not `running`.
   * Source precedence is runState > workspaceStatus > monitorStatus, with one
   * override: if ANY signal says error, the card says error. A fault must never
   * be masked by a parallel optimistic signal — that is how an errored session
   * ended up rendering as a plain notepad glyph.
   */
  function sessionCardStatus(input = {}) {
    const signals = [input.runState, input.workspaceStatus, input.monitorStatus]
      .filter(v => normalizeKey(v) !== '')
      .map(v => coerceStatus('session', v));
    if (signals.includes('error')) return 'error';
    const decided = signals.find(s => s !== 'unknown');
    if (decided) {
      if (decided === 'waiting' && FREEZE_REASON_STATUS[normalizeKey(input.freezeReason)] === 'blocked') {
        return 'blocked';
      }
      return decided;
    }
    return input.active === false ? 'offline' : 'idle';
  }

  /**
   * Task lifecycle status.
   * @param {{status?: string, runState?: string}} task
   * Precedence: an explicit archived/done lifecycle decision (made by a human or
   * by the archive sweep) outranks the derived run state — but everything below
   * it is led by `error`, so a fault is never buried under "still running".
   */
  function taskStatus(task = {}) {
    const lifecycle = normalizeKey(task.status);
    if (lifecycle === 'archived') return 'archived';
    if (lifecycle === 'done') return 'done';
    const raw = task.runState;
    if (normalizeKey(raw) === '') return lifecycle === 'active' ? 'idle' : 'unknown';
    return coerceStatus('task', raw);
  }

  /** Highest-priority status among several coexisting signals. */
  function highestPriority(domain, statuses) {
    const list = (Array.isArray(statuses) ? statuses : [])
      .map(s => coerceStatus(domain, s))
      .filter(s => s !== 'unknown');
    if (!list.length) return 'unknown';
    return list.reduce((best, s) => (
      STATUS_PRESENTATION[s].priority > STATUS_PRESENTATION[best].priority ? s : best
    ));
  }

  function presentation(domain, status) {
    const key = coerceStatus(domain, status);
    return { status: key, ...STATUS_PRESENTATION[key] };
  }

  // ── Reason sanitization ─────────────────────────────────────────────────────
  //
  // A reason may reach a tooltip, so it must never carry a token, a filesystem
  // path, or a URL out of the server. Known enum keys pass through as-is (they
  // are safe by construction and get localized by the caller); anything else is
  // scrubbed and truncated. Errs toward dropping detail.
  const REASON_MAX = 120;
  function sanitizeReason(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return '';
    if (Object.prototype.hasOwnProperty.call(FREEZE_REASON_STATUS, raw)) return raw;
    let safe = raw
      .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '…')          // URLs
      .replace(/(?:^|\s)~?\/[^\s'"]+/g, ' …')                // absolute / home paths
      .replace(/(?:^|\s)[A-Za-z]:\\[^\s'"]+/g, ' …')         // windows paths
      .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '…')               // tokens / keys / hashes
      .replace(/\s+/g, ' ')
      .trim();
    if (safe.length > REASON_MAX) safe = `${safe.slice(0, REASON_MAX - 1)}…`;
    return safe;
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function identity(key) { return key; }

  const TONE_CLASSES = Object.freeze(
    [...new Set(Object.values(STATUS_PRESENTATION).map(p => `st-tone-${p.tone}`))],
  );

  /** Direct child carrying `className`, or null. Works on any minimal DOM. */
  function ownChild(el, className) {
    const kids = el.children || [];
    for (const kid of kids) {
      if (String(kid.className || '').split(/\s+/).includes(className)) return kid;
    }
    return null;
  }

  function resolveCopy(spec, opts) {
    const translate = typeof opts.translate === 'function' ? opts.translate : identity;
    const label = opts.label !== undefined && opts.label !== null && opts.label !== ''
      ? String(opts.label)
      : String(translate(spec.labelKey) ?? spec.labelKey);
    let accessible = String(translate(spec.ariaKey) ?? spec.ariaKey);
    if (accessible === spec.ariaKey) accessible = label;   // catalog gap → visible copy
    const reason = sanitizeReason(opts.reason);
    return { label, accessible, reason };
  }

  /**
   * Idempotent DOM update. Calling this repeatedly — on a WebSocket snapshot, a
   * replayed event, or a duplicate broadcast — always leaves exactly one icon and
   * one label, and always drops the spinner class when the status is not running.
   * That is what makes running→error stop animating and error→running restore
   * cleanly without a leftover double glyph.
   */
  function applyStatusBadge(el, domain, status, opts = {}) {
    if (!el) return null;
    const spec = presentation(domain, status);
    const { label, accessible, reason } = resolveCopy(spec, opts);
    const showLabel = opts.showLabel !== false;
    // `opts.document` lets callers that already hold a document reference (the
    // chat modules, and the fake DOM in tests) avoid depending on a global.
    const doc = el.ownerDocument || opts.document || global.document;

    el.classList.add('mc-status');
    for (const tone of TONE_CLASSES) el.classList.remove(tone);
    el.classList.add(`st-tone-${spec.tone}`);
    el.classList.toggle('st-spin', spec.spinner === true);
    el.classList.toggle('st-terminal', spec.terminal === true);
    el.dataset.statusDomain = domain;
    el.dataset.status = spec.status;

    // Direct-children scan rather than a `:scope >` selector: it expresses the
    // same "my own icon, not a nested one" rule, and it is what keeps repeated
    // calls from stacking a second glyph onto the badge.
    let icon = ownChild(el, 'mc-status-ico');
    if (!icon) {
      icon = doc.createElement('span');
      icon.className = 'mc-status-ico';
      icon.setAttribute?.('aria-hidden', 'true');
      if (typeof el.prepend === 'function') el.prepend(icon);
      else el.insertBefore(icon, el.firstChild);
    }
    icon.textContent = spec.icon;

    let text = ownChild(el, 'mc-status-label');
    if (showLabel) {
      if (!text) {
        text = doc.createElement('span');
        text.className = 'mc-status-label';
        el.appendChild(text);
      }
      text.textContent = label;
    } else if (text) {
      text.remove();
    }

    const title = reason ? `${label} · ${reason}` : label;
    el.setAttribute?.('title', title);
    // The accessible name always carries the state in words, so the badge is
    // readable with colour vision deficiency, in high contrast, and by a screen
    // reader — never colour alone.
    el.setAttribute?.('aria-label', reason ? `${accessible} · ${reason}` : accessible);
    el.setAttribute?.('role', 'img');
    return spec;
  }

  /** String form for the innerHTML-based renderers. Same spec, same classes. */
  function statusBadgeHtml(domain, status, opts = {}) {
    const spec = presentation(domain, status);
    const { label, accessible, reason } = resolveCopy(spec, opts);
    const showLabel = opts.showLabel !== false;
    const title = reason ? `${label} · ${reason}` : label;
    const aria = reason ? `${accessible} · ${reason}` : accessible;
    const classes = [
      'mc-status',
      `st-tone-${spec.tone}`,
      spec.spinner ? 'st-spin' : '',
      spec.terminal ? 'st-terminal' : '',
      opts.className || '',
    ].filter(Boolean).join(' ');
    const idAttr = opts.id ? ` id="${escapeHtml(opts.id)}"` : '';
    return `<span${idAttr} class="${escapeHtml(classes)}" role="img"`
      + ` data-status-domain="${escapeHtml(domain)}" data-status="${escapeHtml(spec.status)}"`
      + ` title="${escapeHtml(title)}" aria-label="${escapeHtml(aria)}">`
      + `<span class="mc-status-ico" aria-hidden="true">${escapeHtml(spec.icon)}</span>`
      + (showLabel ? `<span class="mc-status-label">${escapeHtml(label)}</span>` : '')
      + '</span>';
  }

  const api = Object.freeze({
    SESSION_STATUSES,
    TASK_STATUSES,
    STATUS_PRESENTATION,
    STATUS_ALIASES,
    FREEZE_REASON_STATUS,
    CLASSIFY_LETTER_STATUS,
    TONE_CLASSES,
    coerceStatus,
    classifyStatus,
    freezeReasonStatus,
    sessionStatus,
    sessionCardStatus,
    taskStatus,
    presentation,
    highestPriority,
    sanitizeReason,
    applyStatusBadge,
    statusBadgeHtml,
    unknownStatusDiagnostics,
    resetUnknownStatusDiagnostics,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCStatusPresentation = api;
})(typeof window !== 'undefined' ? window : globalThis);
