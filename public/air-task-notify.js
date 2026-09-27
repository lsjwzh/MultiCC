/* Task-completion "unseen" notifier for the Air page.
 *
 * One trigger source, three consumers — the same taskCompleted/taskOpened events
 * drive a sidebar mark, a voice nudge, and a floating completion prompt, so the
 * reminder only ever lives in one place (see chat-notifications.js for the same
 * idea on the standalone chat page).
 *
 *   the server marks a task (task.attention in /api/air) when its run moves into
 *   completed / error / waiting, and clears it when anyone opens the task —
 *   from any Air tab, PWA window or the App (see src/task-board/attention.js)
 *        └─► ① sidebar row gets `.unseen` while the snapshot carries the mark
 *        └─► ② sound for marks newer than the ones already rung: ding always;
 *              + 朗读「任务…已完成」 only when the person is away (tab hidden, or
 *              visible but no input for 5 min — see shared/user-presence.js)
 *        └─► ③ floating reminder deck, one card per task ([打开][✕]);
 *              several stack up and fan out on click (air-notify-deck.js)
 *   user opens the task (here, or anywhere else)
 *        └─► ① `.unseen` cleared  ② pending/ongoing voice cancelled  ③ its card leaves
 *
 * Whether a task is unseen is never decided here: this page only keeps what it
 * has already rung (a watermark on the server's attention.at, shared by every
 * tab through localStorage), so a reload, a second tab or a tab that slept in
 * the background never re-announces a result that was already announced — and
 * one opened elsewhere is simply no longer in the snapshot.
 *
 * Sound edge cases (the ones that used to read as contradictions):
 *   - several tasks finish in one poll, or within the cooldown → ONE ding and
 *     one sentence naming the most important task (+「另有 N 个」), never a
 *     burst, and never a silently swallowed second completion;
 *   - a task opened before its deferred announcement plays is dropped from it;
 *   - two Air tabs/PWA windows poll the same new mark → only one of them makes
 *     a sound; each shows its own card;
 *   - coming back to a hidden tab cancels narration still queued from while it
 *     was hidden (it would describe something already on screen);
 *   - the open task is never announced here: its chat frame owns that sound.
 *
 * ✕ on a card only takes that card off the deck; the row stays marked until the
 * task is opened.
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

  // Before the server kept the mark, each page kept its own copy here. Those
  // copies disagreed between tabs (the cause of repeated reminders); dropped.
  const LEGACY_KEYS = ['air:notify-unseen', 'air:notify-prev'];
  const LS_HEARD = 'air:notify-heard';   // newest attention.at already rung, shared by tabs
  const LS_VOICE = 'air:notify-voice';
  const LS_CLAIM = 'air:notify-claim';
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
    deckLabel: { zh: '任务提醒', en: 'Task reminders' },
    deckHint: { zh: '共 {n} 条 · 点击展开', en: '{n} reminders · click to expand' },
    deckCollapse: { zh: '收起 ✕', en: 'Collapse ✕' },
    deckMore: { zh: '还有 {n} 条较早的', en: '{n} older' },
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

    // The server's marks as of the last snapshot (id → { kind, at }), minus
    // the task on screen and tasks opened here that the server has not caught
    // up with yet (opened: id → the mark's `at` that was consumed).
    let unseen = new Map();
    const opened = new Map();
    // Newest mark this tab has put on its deck; null until the first snapshot.
    let tabHeard = null;
    function sharedHeard() {
      const raw = storage()?.getItem(LS_HEARD);
      return raw == null ? null : Number(raw) || 0;
    }
    try { const s = storage(); for (const key of LEGACY_KEYS) s?.removeItem(key); } catch (_) {}

    let lastVoiceAt = -Infinity;
    let voiceTimer = null;
    let flushTimer = null;
    const pendingSound = new Map();  // id → { task, kind } waiting out the cooldown

    // ── ③ Floating reminder deck (drawn by air-notify-deck.js) ────────────
    // One card per task that needs you; several stack and fan out on click.
    // ✕ only takes the card off the deck — the row stays marked until opened.
    const deckFactory = opts.deck !== undefined ? opts.deck : win.MultiCCNotifyDeck;
    let deck = null;
    function getDeck() {
      if (!deck && deckFactory?.create) {
        deck = deckFactory.create({
          window: win, document: doc, translate, setTimeout: schedule, now,
          onOpen: task => { if (task && openTask) openTask(task); },
        });
      }
      return deck;
    }
    function dismissPanel() { deck?.clear(); }

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

    // Cross-tab claim: two tabs polling the same new mark at once both see it
    // above the shared watermark; the first to ring records it, the other stays quiet.
    function claimSound(items) {
      const s = storage();
      if (!s) return items;
      const at = now();
      let claims = {};
      try { claims = JSON.parse(s.getItem(LS_CLAIM)) || {}; } catch (_) {}
      const fresh = {};
      for (const [key, ts] of Object.entries(claims)) if (at - Number(ts) < CLAIM_TTL_MS) fresh[key] = ts;
      // The mark's time makes the key per-event: the same task asking a second
      // question a minute later is a new event, not a duplicate.
      const key = ({ task, kind, at }) => `${task.id}|${kind}|${at || ''}`;
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

    function queueSound(task, kind, at) {
      pendingSound.set(String(task.id), { task, kind, at });
      const wait = lastVoiceAt + VOICE_COOLDOWN - now();
      if (wait <= 0) return;           // caller flushes synchronously
      if (!flushTimer) flushTimer = schedule(flushSound, wait);
    }

    // ── ① ② ③ —— one trigger, three consumers ────────────────────────────
    function fireAttention(cards, sounds) {
      for (const [task, kind, at] of sounds) queueSound(task, kind, at);   // ② sound (batched)
      if (sounds.length && !flushTimer) flushSound();
      // ③ every new mark lands on the deck (① is live via isUnseen → CSS class)
      for (const [task, kind] of cards) getDeck()?.upsert(task, kind);
    }

    function markOpened(taskId) {
      const id = String(taskId || '').trim();
      if (!id) return;
      pendingSound.delete(id);
      // The server clears the mark when the task entry is opened; until the
      // next snapshot says so, this page already treats it as seen.
      const mark = unseen.get(id);
      if (!mark) return;
      opened.set(id, mark.at);
      unseen.delete(id);
      stopVoice();          // ② voice cancels
      deck?.remove(id);     // ③ its card leaves the deck
      // ① sidebar mark disappears on the next render (isUnseen returns false now)
    }

    // Back on a tab that was hidden: narration queued by a throttled
    // background tab would now describe something already on screen.
    presence?.onReturn?.(reason => { if (reason === 'visible') stopVoice(); });

    // Read the marks off the latest snapshot. A mark newer than anything this
    // tab has shown becomes a card; newer than anything any tab has rung, a
    // sound. The very first snapshot a browser ever sees only sets the
    // watermark, so turning the feature on does not replay old results.
    // A card whose task is no longer marked (opened elsewhere) or has moved on
    // (someone continued it) leaves the deck.
    function onSnapshot(tasks, currentTaskId) {
      const list = Array.isArray(tasks) ? tasks : [];
      const current = String(currentTaskId || '');
      const heard = sharedHeard();
      if (tabHeard == null) tabHeard = heard;
      let newest = Math.max(heard || 0, tabHeard || 0);
      const next = new Map();
      const cards = [];
      const sounds = [];
      for (const task of list) {
        const id = String(task?.id || '').trim();
        if (!id) continue;
        const mark = task.attention && KINDS.has(task.attention.kind) ? task.attention : null;
        const at = Number(mark?.at) || 0;
        if (mark) newest = Math.max(newest, at);
        if (!mark || at > (opened.get(id) || 0)) opened.delete(id);
        const live = mark && id !== current && !opened.has(id);
        if (live) {
          next.set(id, { kind: mark.kind, at });
          if (tabHeard != null && at > tabHeard) cards.push([task, mark.kind]);
          if (heard != null && at > heard) sounds.push([task, mark.kind, at]);
        }
        if (!live || !attentionKind(statusOf(task))) {
          pendingSound.delete(id);
          deck?.remove(id);
        }
      }
      unseen = next;
      tabHeard = newest;
      if (heard == null || newest > heard) {
        try { storage()?.setItem(LS_HEARD, String(newest)); } catch (_) {}
      }
      fireAttention(cards, sounds);
      return cards.length > 0;
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
      deckIds: () => deck?.ids() || [],
      toggleVoice,
      unseenCount: () => unseen.size,
      unseenKind: id => unseen.get(String(id || ''))?.kind || null,
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
      if (storage) { try { storage.removeItem(LS_HEARD); storage.removeItem(LS_CLAIM); } catch (_) {} }
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
