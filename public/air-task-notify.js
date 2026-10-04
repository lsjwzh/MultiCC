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
 *        └─► ② sound for marks newer than the ones already rung: 提醒开关开着才有
 *              铃声；朗读「任务…已完成」按统一的三档（shared/notify-prefs.js：
 *              off 不念 / away 只在人不在时念 / always 总是念；away 是这之前的
 *              默认行为 —— 人不在的判定见 shared/user-presence.js）
 *        └─► ③ floating reminder deck, one card per task ([打开][✕]);
 *              several stack up and fan out on click (air-notify-deck.js)
 *   user opens the task (here, or anywhere else)
 *        └─► ① `.unseen` cleared  ② pending/ongoing voice cancelled  ③ its card leaves
 *
 * Whether a task is unseen is never decided here: ① and ③ are both a mirror of
 * the snapshot's marks, so a task opened anywhere clears its row and its card.
 * What this page does keep is what it has already RUNG (a watermark on the
 * server's attention.at, shared by every tab through localStorage), so a
 * reload, a second tab or a tab that slept in the background never rings twice
 * for a result that was already announced.
 *
 * Sound edge cases (the ones that used to read as contradictions):
 *   - several tasks finish in one poll, or within the cooldown → ONE ding and
 *     one sentence naming the most important task (+「另有 N 个」), never a
 *     burst, and never a silently swallowed second completion;
 *   - a task opened before its deferred announcement plays is dropped from it;
 *   - two Air tabs/PWA windows poll the same new mark → only one of them makes
 *     a sound; each shows its own card (the card is not a sound: it follows the
 *     mark, so a tab opened later still shows what the row already shows);
 *   - coming back to a hidden tab cancels narration still queued from while it
 *     was hidden (it would describe something already on screen);
 *   - the open task is never announced here: its chat frame owns that sound.
 *
 * ✕ on a card only takes that card off the deck; the row stays marked until the
 * task is opened, and the card comes back with the next page (the mark is still
 * pending — that is what a reminder owes you).
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
    // 语音播报那一句：比弹窗标题多一个任务名，所以另开三条而不是复用 completed/errored/waiting。
    spokenCompleted: { zh: '任务「{title}」已完成', en: 'Task "{title}" done' },
    spokenErrored: { zh: '任务「{title}」出错了', en: 'Task "{title}" failed' },
    spokenWaiting: { zh: '任务「{title}」在等你回复', en: 'Task "{title}" needs your reply' },
    // 一批多条时的后缀（sentence() 会拼在第一条后面），跟着播报那句的语言走。
    spokenMore: { zh: '，另有 {n} 个任务有新结果', en: ' · {n} more results' },
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

  // ── 出声档位：统一偏好（shared/notify-prefs.js），品牌行的通知面板在改它 ──
  // off=不出朗读；away=只在人不在时念（统一偏好之前的默认行为）；always=总是念。
  // 提醒开关管的是铃声和提醒卡片。老缓存页面没加载 notify-prefs.js 时按默认档
  // 处理（away + 有铃声），行为与从前一致；那时的写入退回旧 key。
  function notifyPrefs() { return root.MultiCCNotifyPrefs || null; }
  function voiceMode() { return notifyPrefs()?.getVoice() || 'away'; }
  function remindOn() { return notifyPrefs() ? notifyPrefs().remindEnabled() : true; }
  function voiceEnabled() { return voiceMode() !== 'off'; }
  function setVoiceEnabled(on) {
    const prefs = notifyPrefs();
    if (prefs) { prefs.setVoice(on ? 'away' : 'off'); return; }
    const s = storage();
    if (s) { try { s.setItem('air:notify-voice', on ? '1' : '0'); } catch (_) {} }
  }

  function createNotifyController(options) {
    const opts = options || {};
    const win = opts.window || root;
    const doc = opts.document || win.document;
    const getCurrentTaskId = typeof opts.getCurrentTaskId === 'function' ? opts.getCurrentTaskId : () => null;
    const openTask = typeof opts.openTask === 'function' ? opts.openTask : null;
    // 语言只有一处判定：public/i18n.js 的 getLang()（显式选择 ＞ 系统语言 ＞ 英文）。
    // 就地这份只在窗口里没有 i18n.js（老缓存页面）时兜底，规则必须和它一致 ——
    // 兜底成中文会让英文系统上的任务提醒 bubble 说中文。语音合成也读它。
    function uiLang() {
      try {
        if (typeof win.getLang === 'function') return win.getLang();
        const stored = win.localStorage?.getItem('multicc_lang');
        return stored === 'en' || stored === 'zh' ? stored
          : (/^zh/i.test(win.navigator?.language || '') ? 'zh' : 'en');
      } catch (_) { return 'en'; }
    }
    const translate = typeof opts.translate === 'function' ? opts.translate : (key, vars) => {
      const table = STRINGS[key] || {};
      // 语言判定只留 uiLang() 一处（上面那段就是它）：显式选择 ＞ 系统语言 ＞ 英文。
      const lang = uiLang();
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
    // Newest mark this tab has rung (②); null until the first snapshot. Only
    // the sound is gated by what was already rung — ① and ③ follow the marks.
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
    // `shown` is that deck's memory, keyed by the mark's own `at`: a card is put
    // up once per mark, so a ✕ stays off for this page while the mirrored row
    // keeps coming back (a reload, another tab) for a mark still pending.
    const shown = new Map();         // id → the attention.at already on the deck
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
        // 念的是哪国话就得报哪国 lang，否则英文内容会被中文语音库按拼音读出来。
        utterance.lang = uiLang() === 'zh' ? 'zh-CN' : 'en-US';
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

    // 播报的那一句必须跟着界面语言走（上面 STRINGS 里的 spoken*）：这里以前是
    // 中文字面量，英文页面上语音会突然说中文。有任务名就用 spoken*（带 {title}），
    // 没有名就退回和浮动条同款的那句 floatTitle*；多任务只加一条后缀。
    const SPOKEN_KEY = { error: 'spokenErrored', waiting: 'spokenWaiting', completed: 'spokenCompleted' };
    const FLOAT_KEY = { error: 'floatTitleError', waiting: 'floatTitleWaiting', completed: 'floatTitle' };
    function sentence(items) {
      const [first] = items;
      const title = String(first.task?.title || '').slice(0, 40);
      const kind = FLOAT_KEY[first.kind] ? first.kind : 'completed';
      let text = title ? translate(SPOKEN_KEY[kind], { title }) : translate(FLOAT_KEY[kind]);
      if (items.length > 1) text += translate('spokenMore', { n: items.length - 1 });
      return text;
    }

    // ② One sound per batch: 铃声跟着提醒开关，朗读跟着三档（档位判定读 flush
    // 那一刻的，不是任务完成那一刻的）。两样全关时连跨标签的响铃声明也不占 ——
    // 没有要响的东西。Presence 同理，读的是真正出声那一刻的。
    function flushSound() {
      if (flushTimer) { cancelSchedule(flushTimer); flushTimer = null; }
      const items = [...pendingSound.values()]
        .filter(({ task }) => unseen.has(String(task.id)));   // opened meanwhile → drop
      pendingSound.clear();
      if (!items.length) return false;
      const mode = voiceMode();
      const remind = remindOn();
      if (mode === 'off' && !remind) return false;
      const mine = claimSound(items);
      if (!mine.length) return false;
      mine.sort((a, b) => KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind]);
      lastVoiceAt = now();
      if (remind) playDing(mine[0].kind);
      const speakNow = mode === 'always' || (mode === 'away' && isAway());
      if (!speakNow) return true;
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
      // ③ every new mark lands on the deck (① is live via isUnseen → CSS class);
      //    提醒开关关掉时新卡片不再上桌（已上桌的不追着撤 —— 撤掉会把「还在等
      //    人看」的标记藏起来，开关管的是以后的提醒）。
      if (remindOn()) for (const [task, kind] of cards) getDeck()?.upsert(task, kind);
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
      shown.delete(id);
      stopVoice();          // ② voice cancels
      deck?.remove(id);     // ③ its card leaves the deck
      // ① sidebar mark disappears on the next render (isUnseen returns false now)
    }

    // Back on a tab that was hidden: narration queued by a throttled
    // background tab would now describe something already on screen.
    presence?.onReturn?.(reason => { if (reason === 'visible') stopVoice(); });

    // Read the marks off the latest snapshot. Every task still carrying one gets
    // its card — the same mirror the sidebar row is, so a reload, a second tab
    // or a browser that was away shows what still needs you. A mark newer than
    // anything any tab has RUNG also makes a sound; the very first snapshot a
    // browser ever sees only sets that watermark, so turning the feature on
    // never replays a result that was already announced.
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
          if (shown.get(id) !== at) {         // once per mark: a ✕ stays off
            shown.set(id, at);
            cards.push([task, mark.kind]);
          }
          if (heard != null && at > heard) sounds.push([task, mark.kind, at]);
        }
        if (!live || !attentionKind(statusOf(task))) {
          pendingSound.delete(id);
          shown.delete(id);
          deck?.remove(id);
        }
      }
      unseen = next;
      tabHeard = newest;
      if (heard == null || newest > heard) {
        try { storage()?.setItem(LS_HEARD, String(newest)); } catch (_) {}
      }
      fireAttention(cards, sounds);
      return sounds.length > 0;      // what rung, not what is on screen
    }

    // Expose a couple of controls the Air toolbar may want (voice on/off).
    // 三档轮换 off → away → always；返回新档位（旧调用方只当布尔用的话，
    // truthy 语义不变：away/always 为真，off 为假）。
    function toggleVoice() {
      const order = ['off', 'away', 'always'];
      const next = order[(order.indexOf(voiceMode()) + 1) % order.length];
      const prefs = notifyPrefs();
      if (prefs) prefs.setVoice(next);
      else setVoiceEnabled(next !== 'off');
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
