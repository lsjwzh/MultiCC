/* Task-completion "unseen" notifier for the Air page.
 *
 * One trigger source, three consumers — the same taskCompleted/taskOpened events
 * drive a sidebar mark, a voice nudge, and a floating completion prompt, so the
 * reminder only ever lives in one place (see chat-notifications.js for the same
 * idea on the standalone chat page).
 *
 *   task transitions into completed / error / waiting AND isn't currently open
 *        └─► ① sidebar row gets `.unseen` (always)
 *        └─► ② sound: ding always; + 朗读「任务…已完成」 only when the person is
 *              away (tab hidden, or visible but no input for 5 min — see
 *              shared/user-presence.js for the one presence rule + policy table)
 *        └─► ③ floating completion panel ([打开][✕])
 *   user opens the task
 *        └─► ① `.unseen` cleared  ② pending/ongoing voice cancelled  ③ panel hidden
 *
 * Sound edge cases (the ones that used to read as contradictions):
 *   - several tasks finish in one poll, or within the cooldown → ONE ding and
 *     one sentence naming the most important task (+「另有 N 个」), never a
 *     burst, and never a silently swallowed second completion;
 *   - a task opened before its deferred announcement plays is dropped from it;
 *   - two Air tabs/PWA windows see the same transition → only the first one
 *     to claim it (localStorage) makes a sound, both still mark it;
 *   - coming back to a hidden tab cancels narration still queued from while it
 *     was hidden (it would describe something already on screen);
 *   - the open task is never announced here: its chat frame owns that sound.
 *
 * `unseen` and the last-observed per-task status are persisted to localStorage,
 * so a task that finishes while the page is closed (or across a reload) is still
 * marked ① / prompted ③ the next time the page is open. "©" closing the floating
 * prompt only hides the panel; the row stays marked until the task is opened.
 *
 * Kept a classic script (no module dep) so air.js can construct it before the
 * first snapshot and hand over the handful of callbacks it needs.
 */
(function installAirTaskNotify(root) {
  'use strict';

  // Completion = a human/lifecycle "done" or a successful turn outcome. Errors
  // get their own attention tone (red) instead of being silently skipped — a
  // failed run the user hasn't looked at is at least as much "come see this"
  // as a success. Cancellations and archives are deliberately excluded.
  // `waiting` (a question for the user) is announced too: the open task's chat
  // frame already dings for it, and a question in a task you are NOT looking at
  // is the one you are least likely to notice.
  const COMPLETED = new Set(['done', 'succeeded']);
  const ERROR = new Set(['error']);
  const WAITING = new Set(['waiting']);
  const KINDS = new Set(['completed', 'error', 'waiting']);
  function attentionKind(status) {
    const key = String(status || '');
    if (COMPLETED.has(key)) return 'completed';
    if (ERROR.has(key)) return 'error';
    if (WAITING.has(key)) return 'waiting';
    return null;
  }
  // Which of several simultaneous outcomes the one sentence is about.
  const KIND_PRIORITY = { error: 3, waiting: 2, completed: 1 };

  const LS_UNSEEN = 'air:notify-unseen';
  const LS_PREV = 'air:notify-prev';
  const LS_VOICE = 'air:notify-voice';
  const LS_CLAIM = 'air:notify-claim';
  const PREV_CAP = 200;          // don't let the status watermark grow unbounded
  const VOICE_COOLDOWN = 8000;   // min gap between two sounds, mirrors chat-notifications
  const SPEAK_DELAY_MS = 260;    // let the ding finish before the narration starts
  const CLAIM_TTL_MS = 120000;   // cross-tab "someone already rang for this" window
  // Same tones as chat-notifications.js dingFrequencies(), so a sound means the
  // same thing whichever controller made it.
  const DING = {
    completed: [1046.5, 1567.98],
    error: [783.99, 622.25],
    waiting: [659.25],
  };

  const STRINGS = {
    completed: { zh: '{title} 已完成', en: '{title} done' },
    errored: { zh: '{title} 出错了', en: '{title} failed' },
    waiting: { zh: '{title} 在等你回复', en: '{title} needs your reply' },
    floatTitle: { zh: '任务已完成', en: 'Task complete' },
    floatTitleError: { zh: '任务出错', en: 'Task failed' },
    floatTitleWaiting: { zh: '任务等待回复', en: 'Task needs you' },
    floatOpen: { zh: '打开', en: 'Open' },
    floatClose: { zh: '✕', en: '✕' },
    floatMore: { zh: '另 {n} 个任务有新结果', en: '{n} more updated' },
  };

  function storage() {
    try { return root.localStorage; } catch (_) { return null; }
  }
  function readJson(key, fallback) {
    const s = storage();
    if (!s) return fallback;
    try { const v = JSON.parse(s.getItem(key)); return v == null ? fallback : v; }
    catch (_) { return fallback; }
  }
  function writeJson(key, value) {
    const s = storage();
    if (!s) return;
    try { s.setItem(key, JSON.stringify(value)); } catch (_) { /* quota → drop silently */ }
  }
  function isCompleted(status) { return COMPLETED.has(String(status || '')); }

  // The persisted unseen list used to be a bare array of ids; entries written
  // before the error tone existed read as plain "completed" marks.
  function readUnseen() {
    const raw = readJson(LS_UNSEEN, []);
    if (Array.isArray(raw)) return new Map(raw.map(id => [String(id), 'completed']));
    if (raw && typeof raw === 'object') {
      return new Map(Object.entries(raw).filter(([, kind]) => KINDS.has(kind)));
    }
    return new Map();
  }

  // Voice was flagged on by default, but a user can silence it without losing
  // the sidebar mark or floating prompt (they are "notification", not "voice").
  function voiceEnabled() {
    const s = storage();
    if (!s) return true;
    return s.getItem(LS_VOICE) !== '0';
  }
  function setVoiceEnabled(on) {
    const s = storage();
    if (s) { try { s.setItem(LS_VOICE, on ? '1' : '0'); } catch (_) {} }
  }

  function createNotifyController(options) {
    const opts = options || {};
    const win = opts.window || root;
    const doc = opts.document || win.document;
    const getCurrentTaskId = typeof opts.getCurrentTaskId === 'function' ? opts.getCurrentTaskId : () => null;
    const openTask = typeof opts.openTask === 'function' ? opts.openTask : null;
    const translate = typeof opts.translate === 'function' ? opts.translate : (key, vars) => {
      const table = STRINGS[key] || {};
      // Follow the page's own language toggle (multicc_lang) first, then the
      // browser locale — the same rule the rest of the Air UI uses.
      let lang = 'zh';
      try {
        const stored = win.localStorage?.getItem('multicc_lang');
        lang = /^en$/i.test(stored || '') ? 'en' : /^zh/i.test(stored || '') ? 'zh' : lang;
      } catch (_) {}
      if (!/^zh/i.test(lang)) lang = /zh/i.test(win.navigator?.language || '') ? 'zh' : 'en';
      let text = table[lang] || table.zh || key;
      if (vars) for (const name of Object.keys(vars)) text = text.replace(`{${name}}`, vars[name]);
      return text;
    };
    const schedule = typeof opts.setTimeout === 'function' ? opts.setTimeout : win.setTimeout.bind(win);
    const cancelSchedule = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : win.clearTimeout.bind(win);
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const visibility = () => (typeof doc.visibilityState === 'string' ? doc.visibilityState : 'visible');
    // Presence decides narration (see shared/user-presence.js). Without the
    // shared tracker the page falls back to "hidden = away".
    const presence = opts.presence !== undefined ? opts.presence
      : (win.MultiCCUserPresence?.shared?.() || null);
    const isAway = () => (presence ? presence.isAway() : visibility() === 'hidden');
    // Folded status resolver: task.status only carries the lifecycle
    // (active/done/archived); whether a run ended in success or error lives in
    // runState. The page hands over the same status-presentation fold the
    // sidebar badge uses, so the reminder and the badge can never disagree.
    const statusOf = typeof opts.statusOf === 'function'
      ? opts.statusOf : (task => task?.status);

    // Persisted "terminal but not opened" rows (id → attention kind) + the
    // last status we saw per task.
    const unseen = readUnseen();
    const prevStatus = new Map(Object.entries(readJson(LS_PREV, {})));

    let panel = null;
    let panelTask = null;
    let panelTitle = null;
    let panelBody = null;
    let lastVoiceAt = -Infinity;
    let voiceTimer = null;
    let flushTimer = null;
    const pendingSound = new Map();  // id → { task, kind } waiting out the cooldown

    function persistUnseen() { writeJson(LS_UNSEEN, Object.fromEntries([...unseen].slice(-PREV_CAP))); }
    function persistPrev() {
      const pruned = [...prevStatus.entries()].slice(-PREV_CAP);
      writeJson(LS_PREV, Object.fromEntries(pruned));
    }

    // ── ③ Floating completion panel ────────────────────────────────────────
    function buildPanel() {
      if (panel) return panel;
      panel = doc.createElement('div');
      panel.className = 'task-complete-float';
      panel.setAttribute('role', 'alert');
      const text = doc.createElement('div');
      text.className = 'task-complete-float-text';
      const title = doc.createElement('div');
      title.className = 'task-complete-float-title';
      const body = doc.createElement('div');
      body.className = 'task-complete-float-body';
      const actions = doc.createElement('div');
      actions.className = 'task-complete-float-actions';
      const open = doc.createElement('button');
      open.type = 'button';
      open.className = 'task-complete-open';
      open.textContent = translate('floatOpen');
      const close = doc.createElement('button');
      close.type = 'button';
      close.className = 'task-complete-close';
      close.textContent = translate('floatClose');
      close.setAttribute('aria-label', translate('floatClose'));
      text.append(title, body);
      actions.append(open, close);
      panel.append(text, actions);
      panelBody = body;
      panelTitle = title;
      open.onclick = () => {
        const task = panelTask;
        dismissPanel();
        if (task && openTask) openTask(task);
      };
      close.onclick = () => dismissPanel();
      doc.body.appendChild(panel);
      return panel;
    }

    function showPanel(task, kind = 'completed') {
      panelTask = task || null;
      buildPanel();
      if (panelTitle) {
        const key = kind === 'error' ? 'floatTitleError' : kind === 'waiting' ? 'floatTitleWaiting' : 'floatTitle';
        panelTitle.textContent = translate(key) + ' ·';
      }
      const title = task?.title || task?.id || '';
      if (panelBody) {
        const key = kind === 'error' ? 'errored' : kind === 'waiting' ? 'waiting' : 'completed';
        panelBody.textContent = translate(key, { title });
      }
      const more = [...unseen.keys()].filter(id => id !== task?.id).length;
      if (more > 0 && panelBody) panelBody.textContent += ` · ${translate('floatMore', { n: more })}`;
      panel.hidden = false;
      panel.classList.toggle('is-error', kind === 'error');
      panel.classList.remove('is-hiding');
      // Re-hide whenever animation timers are abandoned.
      if (win.__multiccNotifyHide) cancelSchedule(win.__multiccNotifyHide);
    }

    function dismissPanel() {
      if (!panel) return;
      panel.hidden = true;
      panel.classList.remove('is-error');
      panelTask = null;
      if (panelBody) panelBody.textContent = '';
    }

    // ── ② Voice nudge ─────────────────────────────────────────────────────
    function playDing(kind) {
      try {
        const Ctor = win.AudioContext || win.webkitAudioContext;
        if (!Ctor) return;
        const ctx = new Ctor();
        const freqs = DING[kind] || DING.completed;
        const start = ctx.currentTime;
        freqs.forEach((frequency, index) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, start + index * 0.12);
          gain.gain.exponentialRampToValueAtTime(0.22, start + index * 0.12 + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + index * 0.12 + 0.28);
          osc.connect(gain).connect(ctx.destination);
          osc.start(start + index * 0.12);
          osc.stop(start + index * 0.12 + 0.3);
        });
        schedule(() => { try { ctx.close(); } catch (_) {} }, freqs.length * 120 + 400);
      } catch (_) {}
    }

    function speak(text) {
      if (win.speechSynthesis && typeof win.SpeechSynthesisUtterance === 'function') {
        const utterance = new win.SpeechSynthesisUtterance(text);
        utterance.lang = 'zh-CN';
        utterance.rate = 1.1;
        utterance.volume = 0.75;
        win.speechSynthesis.speak(utterance);
      }
    }

    function stopVoice() {
      if (win.speechSynthesis) { try { win.speechSynthesis.cancel(); } catch (_) {} }
      if (voiceTimer) { cancelSchedule(voiceTimer); voiceTimer = null; }
    }

    // Cross-tab claim: the first Air tab/PWA window to announce a transition
    // records it; the others stay quiet for that same transition.
    function claimSound(items) {
      const s = storage();
      if (!s) return items;
      const at = now();
      let claims = {};
      try { claims = JSON.parse(s.getItem(LS_CLAIM)) || {}; } catch (_) {}
      const fresh = {};
      for (const [key, ts] of Object.entries(claims)) if (at - Number(ts) < CLAIM_TTL_MS) fresh[key] = ts;
      // updatedAt makes the key per-transition: the same task asking a second
      // question a minute later is a new event, not a duplicate.
      const key = ({ task, kind }) => `${task.id}|${kind}|${task.updatedAt || ''}`;
      const mine = items.filter(item => !fresh[key(item)]);
      for (const item of mine) fresh[key(item)] = at;
      try { s.setItem(LS_CLAIM, JSON.stringify(fresh)); } catch (_) {}
      return mine;
    }

    function sentence(items) {
      const [first] = items;
      const title = String(first.task?.title || '').slice(0, 40);
      const outcome = first.kind === 'error' ? '出错了' : first.kind === 'waiting' ? '在等你回复' : '已完成';
      let text = title ? `任务「${title}」${outcome}` : `任务${outcome}`;
      if (items.length > 1) text += `，另有 ${items.length - 1} 个任务有新结果`;
      return text;
    }

    // ② One sound per batch: ding always, narration only when away. Presence
    // is read when the sound actually plays, not when the task finished.
    function flushSound() {
      if (flushTimer) { cancelSchedule(flushTimer); flushTimer = null; }
      const items = [...pendingSound.values()]
        .filter(({ task }) => unseen.has(String(task.id)));   // opened meanwhile → drop
      pendingSound.clear();
      if (!items.length || !voiceEnabled()) return false;
      const mine = claimSound(items);
      if (!mine.length) return false;
      mine.sort((a, b) => KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind]);
      lastVoiceAt = now();
      playDing(mine[0].kind);
      if (!isAway()) return true;
      const text = sentence(mine);
      if (voiceTimer) cancelSchedule(voiceTimer);
      voiceTimer = schedule(() => { voiceTimer = null; speak(text); }, SPEAK_DELAY_MS);
      return true;
    }

    function queueSound(task, kind) {
      pendingSound.set(String(task.id), { task, kind });
      const wait = lastVoiceAt + VOICE_COOLDOWN - now();
      if (wait <= 0) return;           // caller flushes synchronously
      if (!flushTimer) flushTimer = schedule(flushSound, wait);
    }

    // ── ① ② ③ —— one trigger, three consumers ────────────────────────────
    function fireAttention(fires) {
      if (!fires.length) return;
      for (const [task, kind] of fires) {
        unseen.set(String(task.id), kind);
        queueSound(task, kind);          // ② sound (batched)
      }
      persistUnseen();
      if (!flushTimer) flushSound();
      // ③ floating panel shows the most important of this batch
      const [task, kind] = [...fires].sort((a, b) => KIND_PRIORITY[b[1]] - KIND_PRIORITY[a[1]])[0];
      showPanel(task, kind);             // (① is live via isUnseen → CSS class)
    }

    function markOpened(taskId) {
      const id = String(taskId || '').trim();
      if (!id) return;
      pendingSound.delete(id);
      if (!unseen.has(id)) return;
      unseen.delete(id);
      persistUnseen();
      stopVoice();          // ② voice cancels
      if (panelTask && String(panelTask.id) === id) dismissPanel();  // ③ its panel hides
      // ① sidebar mark disappears on the next render (isUnseen returns false now)
    }

    // Back on a tab that was hidden: narration queued by a throttled
    // background tab would now describe something already on screen.
    presence?.onReturn?.(reason => { if (reason === 'visible') stopVoice(); });

    // Diff the latest snapshot against the watermark; anything that moved into
    // a completed / error / waiting state (from a different state) while not the
    // task currently on screen is a reminder candidate. Only fires when the
    // transition is OBSERVED (prev known), so a task that was already done
    // before the feature/page ever saw it does not spam the page on first load.
    // A `waiting` mark whose question got answered elsewhere (App, another
    // tab) is dropped once the task leaves `waiting` — it no longer needs you.
    function onSnapshot(tasks, currentTaskId) {
      // Board insertion order can put a recently rerun old task before hundreds
      // of dormant records. Keep the watermark by activity, not insertion order.
      const list = Array.isArray(tasks) ? [...tasks].sort((a, b) =>
        Number(a.updatedAt || 0) - Number(b.updatedAt || 0)) : [];
      const fires = [];
      for (const task of list) {
        const id = String(task?.id || '').trim();
        if (!id) continue;
        const status = String(statusOf(task) || '');
        const kind = attentionKind(status);
        const prev = prevStatus.get(id);
        const prevKind = prev != null ? attentionKind(prev) : null;
        const isOpen = id === String(currentTaskId || '');
        if (isOpen) {                     // on screen → not "unseen"
          unseen.delete(id);
          pendingSound.delete(id);
        } else if (kind && kind !== prevKind && prev != null) {
          // observed transition into an attention state, not currently open
          fires.push([task, kind]);
          unseen.set(id, kind);
        } else if (!kind && unseen.get(id) === 'waiting') {
          unseen.delete(id);
          pendingSound.delete(id);
        }
        prevStatus.delete(id);
        prevStatus.set(id, status);
      }
      if (prevStatus.size > PREV_CAP) {
        for (const key of prevStatus.keys()) {
          if (prevStatus.size <= PREV_CAP) break;
          prevStatus.delete(key);
        }
      }
      persistPrev();
      persistUnseen();
      fireAttention(fires);
      return fires.length > 0;
    }

    // Expose a couple of controls the Air toolbar may want (voice on/off).
    function toggleVoice() {
      const next = !voiceEnabled();
      setVoiceEnabled(next);
      return next;
    }

    return Object.freeze({
      dismissPanel,
      isUnseen: id => unseen.has(String(id || '')),
      markOpened,
      onSnapshot,
      panelHidden: () => !panel || panel.hidden,
      toggleVoice,
      unseenCount: () => unseen.size,
      unseenKind: id => unseen.get(String(id || '')) || null,
      voiceEnabled,
    });
  }

  // 侧栏「最近任务」只有两个来源，都跨目录、都不随当前目录变：
  //   ① 有未读结果的任务（按最后一条消息时间）；
  //   ② 在这个浏览器里打开过的任务（按最近打开顺序，rememberTask 记最多 12 条）。
  // 不再拿当前目录的任务来填空位：那样切目录时侧栏会整片换掉，看着像「任务跟着
  // 目录变」。某个目录的完整任务在目录首页和控制台里。
  function recentTasks({ tasks, recentTaskIds, limit, isUnseen, statusOf }) {
    const messageAt = task => Number(task?.lastMessageAt || task?.updatedAt || 0);
    const byId = new Map(tasks.map(task => [task.id, task]));
    const pool = [];
    const seen = new Set();
    // Unread outcomes must remain reachable even when all recent slots are
    // already occupied by opened tasks.
    for (const task of tasks.filter(t => isUnseen(t.id) && !['archived', 'cancelled'].includes(statusOf(t)))
      .sort((a, b) => messageAt(b) - messageAt(a))) {
      seen.add(task.id);
      pool.push(task);
    }
    for (const id of recentTaskIds) {
      const task = byId.get(id);
      if (!task || seen.has(task.id)) continue;
      seen.add(task.id);
      pool.push(task);
    }
    return pool.slice(0, limit);
  }

  root.MultiCCTaskNotify = Object.freeze({
    recentTasks,
    create: createNotifyController,
    isCompleted,
    attentionKind,
    __resetForTest(storage) {
      if (storage) { try { storage.removeItem(LS_UNSEEN); storage.removeItem(LS_PREV); } catch (_) {} }
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
