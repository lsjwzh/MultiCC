/* Task-completion "unseen" notifier for the Air page.
 *
 * One trigger source, three consumers — the same taskCompleted/taskOpened events
 * drive a sidebar mark, a voice nudge, and a floating completion prompt, so the
 * reminder only ever lives in one place (see chat-notifications.js for the same
 * idea on the standalone chat page).
 *
 *   task transitions to a terminal "completed" state AND isn't currently open
 *        └─► ① sidebar row gets `.unseen` (always, visible or background)
 *        └─► ② voice ding + 朗读「任务已完成」 (background tab only)
 *        └─► ③ floating completion panel ([打开][✕]) (visible page only)
 *   user opens the task
 *        └─► ① `.unseen` cleared  ② voice cancelled  ③ floating panel hidden
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
  const COMPLETED = new Set(['done', 'succeeded']);
  const ERROR = new Set(['error']);
  function attentionKind(status) {
    const key = String(status || '');
    if (COMPLETED.has(key)) return 'completed';
    if (ERROR.has(key)) return 'error';
    return null;
  }

  const LS_UNSEEN = 'air:notify-unseen';
  const LS_PREV = 'air:notify-prev';
  const LS_VOICE = 'air:notify-voice';
  const PREV_CAP = 200;          // don't let the status watermark grow unbounded
  const VOICE_COOLDOWN = 8000;   // per-fire cooldown, mirrors chat-notifications
  const SPEAK_DELAY_MS = 260;    // let the ding finish before the narration starts

  const STRINGS = {
    completed: { zh: '{title} 已完成', en: '{title} done' },
    errored: { zh: '{title} 出错了', en: '{title} failed' },
    floatTitle: { zh: '任务已完成', en: 'Task complete' },
    floatTitleError: { zh: '任务出错', en: 'Task failed' },
    floatOpen: { zh: '打开', en: 'Open' },
    floatClose: { zh: '✕', en: '✕' },
    floatMore: { zh: '另 {n} 个任务已完成', en: '{n} more done' },
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
      return new Map(Object.entries(raw).filter(([, kind]) => kind === 'completed' || kind === 'error'));
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
    const visibility = () => (typeof doc.visibilityState === 'string' ? doc.visibilityState : 'visible');
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
    let lastVoiceAt = 0;
    let voiceTimer = null;

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
        panelTitle.textContent = translate(kind === 'error' ? 'floatTitleError' : 'floatTitle') + ' ·';
      }
      const title = task?.title || task?.id || '';
      if (panelBody) {
        panelBody.textContent = translate(kind === 'error' ? 'errored' : 'completed', { title });
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
    function playDing() {
      try {
        const Ctor = win.AudioContext || win.webkitAudioContext;
        if (!Ctor) return;
        const ctx = new Ctor();
        const freqs = [1046.5, 1567.98];
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

    function voiceNudge(task, kind = 'completed') {
      if (!voiceEnabled()) return;
      // 前台盯着页面时只刷侧边栏亮点/浮动条即可，不吵人；页面退到后台（切走/隐藏）
      // 时才用语音补一句提醒。浏览器对隐藏标签页的语音有节流，能做就做、做不了静默降级。
      if (visibility() === 'visible') return;
      const now = Date.now();
      if (now - lastVoiceAt < VOICE_COOLDOWN) return;
      lastVoiceAt = now;
      playDing();
      const title = String(task?.title || '').slice(0, 40);
      const outcome = kind === 'error' ? '出错了' : '已完成';
      const text = title ? `任务「${title}」${outcome}` : `任务${outcome}`;
      if (voiceTimer) cancelSchedule(voiceTimer);
      voiceTimer = schedule(() => speak(text), SPEAK_DELAY_MS);
    }

    // ── ① ② ③ —— one trigger, three consumers ────────────────────────────
    function fireAttention(task, kind) {
      unseen.set(String(task.id), kind);
      persistUnseen();
      voiceNudge(task, kind);  // ② voice
      showPanel(task, kind);   // ③ floating (① is live via isUnseen → CSS class)
    }

    function markOpened(taskId) {
      const id = String(taskId || '').trim();
      if (!id) return;
      if (!unseen.has(id)) return;
      unseen.delete(id);
      persistUnseen();
      stopVoice();          // ② voice cancels
      dismissPanel();       // ③ floating hides
      // ① sidebar mark disappears on the next render (isUnseen returns false now)
    }

    // Diff the latest snapshot against the watermark; anything that crossed into
    // a terminal "completed"/"error" state while not the task currently on screen
    // is a reminder candidate. Only fires when the transition is OBSERVED (prev
    // in a non-terminal state), so a task that was already done before the
    // feature/page ever saw it does not spam the page on first load.
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
        const wasAttention = prev != null && attentionKind(prev);
        const isOpen = id === String(currentTaskId || '');
        if (isOpen) {                     // on screen → not "unseen"
          unseen.delete(id);
        } else if (kind && !wasAttention && prev != null) {
          // observed terminal transition, not currently open
          fires.push([task, kind]);
          unseen.set(id, kind);
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
      for (const [task, kind] of fires) fireAttention(task, kind);
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

  function recentTasks({ tasks, directoryId, recentTaskIds, limit, isUnseen, statusOf }) {
    const byId = new Map(tasks.map(task => [task.id, task]));
    const pool = [];
    const seen = new Set();
    // Unread outcomes must remain reachable even outside the current directory
    // or when all recent slots are already occupied by opened tasks.
    for (const task of tasks.filter(t => isUnseen(t.id) && !['archived', 'cancelled'].includes(statusOf(t)))
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))) {
      seen.add(task.id);
      pool.push(task);
    }
    for (const id of recentTaskIds) {
      const task = byId.get(id);
      if (!task || seen.has(task.id)) continue;
      seen.add(task.id);
      pool.push(task);
    }
    const settled = task => (['done', 'archived'].includes(task.status) ? 1 : 0);
    for (const task of tasks.filter(t => t.dirId === directoryId)
      .sort((a, b) => settled(a) - settled(b) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0))) {
      if (seen.has(task.id)) continue;
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
