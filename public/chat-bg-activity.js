(function attachMultiCCChatBgActivity(global) {
  'use strict';

  // 后台任务活动行：轮次还在流式但正文暂时没有新内容时（最典型就是 agent 把活
  // 派给了后台 Bash / 子 Agent 然后干等），消息流末尾只剩呼吸灯一个在弹跳，用户
  // 分不清「在跑」和「卡死」。本模块在呼吸灯正下方挂一条实时状态行：最老的后台
  // 任务描述 + 走字的运行时长，外加轮询 /api/sessions/:id/tasks 拿到的最近一行
  // 输出，让"后台在动"看得见。数据源与左上角后台任务卡（danmaku）同一条 WS 事件
  // 流（monitor_* / background_tasks 快照），轮次结束即收行——之后的活动归悬浮卡。
  //
  // 数字格式的唯一来源（shared/format.js，页面里先于本文件加载）。Node 侧的测试
  // 沙箱里没有页面全局，落回 require，与 chat-event-controller.js 的取法一致。
  const FMT = (typeof window !== 'undefined' && window.MultiCCFormat)
    || (typeof globalThis !== 'undefined' && globalThis.MultiCCFormat)
    || (typeof require === 'function' ? require('./shared/format.js') : null);

  const TICK_MS = 1000;   // 时长走字频率
  const POLL_MS = 5000;   // lastOutput / createdAt 校准轮询，只在行可见时才有意义
  // 快照对账的宽限：快照只列服务端确认的后台任务，分类缺口会让真在跑的任务
  // 短暂缺席；有心跳/进度证据的任务在宽限内不收行，免得活动行一闪一闪。
  const SNAPSHOT_GRACE_MS = 90000;
  const DESC_MAX = 60;    // 主行里任务描述的截断长度（title 属性里留全文）
  const TAIL_MAX = 120;   // 「最近输出」行的截断长度
  const TITLE_MAX = 160;  // 悬停提示里每条任务描述的截断长度

  const TERMINAL_STATUSES = new Set(['done', 'failed', 'fail', 'error', 'cancelled', 'canceled', 'interrupted', 'stale', 'timeout', 'completed']);

  function clampText(value, max) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function lastNonEmptyLine(value) {
    const lines = String(value == null ? '' : value).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line) return line;
    }
    return '';
  }

  function isBackgroundMessage(message) {
    // 同步 Bash（background:false）不是后台任务，danmaku 卡也不收它。
    return message.background !== false;
  }

  function taskIdOf(message) {
    const id = message.task_id || message.id;
    return id == null ? '' : String(id);
  }

  function createBgActivity(options = {}) {
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof options.getMessagesEl !== 'function' || typeof options.getIsStreaming !== 'function') {
      return Object.freeze({ onEvent() {}, dispose() {}, runningCount: () => 0 });
    }
    const translate = typeof options.translate === 'function' ? options.translate : (key => key);
    const getSessionId = typeof options.getSessionId === 'function' ? options.getSessionId : () => '';
    const fetchJson = typeof options.fetchJson === 'function' ? options.fetchJson : null;
    const debug = typeof options.debug === 'function' ? options.debug : () => {};
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const setIntervalFn = options.setInterval || global.setInterval.bind(global);
    const clearIntervalFn = options.clearInterval || global.clearInterval.bind(global);

    // taskId → 运行中任务。startedAt 先用首见时间占位，轮询回来后用服务端
    // createdAt 校准（重连快照场景下首见时间会低估真实时长）。
    const running = new Map();
    let el = null;
    let tickTimer = null;
    let pollTimer = null;
    let pollInFlight = false;
    let lastSignature = '';

    function tr(key, params) {
      const text = translate(key, params);
      return text == null ? key : text;
    }

    function ensureTimers() {
      if (tickTimer == null) tickTimer = setIntervalFn(() => {
        if (running.size > 0) render();
      }, TICK_MS);
      if (pollTimer == null) pollTimer = setIntervalFn(pollTasks, POLL_MS);
    }

    function stopTimersIfIdle() {
      if (running.size > 0) return;
      if (tickTimer != null) { clearIntervalFn(tickTimer); tickTimer = null; }
      if (pollTimer != null) { clearIntervalFn(pollTimer); pollTimer = null; }
    }

    function ensureEl() {
      const messagesEl = options.getMessagesEl();
      if (!messagesEl) return null;
      if (!el || !el.isConnected) {
        el = doc.createElement('div');
        el.className = 'bg-activity';
        el.dataset.testid = 'bg-activity';
        const dot = doc.createElement('span');
        dot.className = 'bg-activity-dot';
        dot.setAttribute('aria-hidden', 'true');
        const text = doc.createElement('span');
        text.className = 'bg-activity-text';
        const main = doc.createElement('span');
        main.className = 'bg-activity-main';
        const tail = doc.createElement('span');
        tail.className = 'bg-activity-tail';
        tail.hidden = true;
        text.append(main, tail);
        el.append(dot, text);
        lastSignature = '';
      }
      // 呼吸灯在就紧跟其后（用户视线落点）；不在就贴消息流末尾（正文流过一阵
      // 停住时，thinking-bubble 可能已被 message_start 摘掉）。
      const thinking = typeof messagesEl.querySelector === 'function'
        ? messagesEl.querySelector('.thinking-bubble') : null;
      if (thinking && thinking.parentElement === messagesEl) {
        messagesEl.insertBefore(el, thinking.nextSibling);
      } else if (el.parentElement !== messagesEl) {
        messagesEl.appendChild(el);
      }
      return el;
    }

    function focusTasks() {
      return [...running.values()].sort((a, b) => a.startedAt - b.startedAt);
    }

    // 首选落点：当前生成中气泡最底部的状态行（点 · 状态 · 归属，chat-live-ui
    // setStreamStatus）。宿主返回 false（还没有生成中的气泡，例如只有 thinking 气泡）
    // 才退回独立胶囊。
    const setStatus = typeof options.setStatus === 'function' ? options.setStatus : null;

    function render() {
      // 只由「有没有后台任务在跑」决定，不看这一轮是否还在流式：轮次结束、对话
      // 收尾，任务还在跑就继续在最后一条助手气泡底部亮着；任务结束才收行。
      if (running.size === 0) {
        if (setStatus) setStatus('', '');
        if (el) { el.remove(); lastSignature = ''; }
        stopTimersIfIdle();
        return;
      }
      const tasks = focusTasks();
      const focus = tasks[0];
      const label = tasks.length > 1
        ? tr('bgActivityRunningCount', { n: tasks.length })
        : tr('bgActivityRunning');
      const desc = clampText(focus.description, DESC_MAX);
      const elapsed = FMT ? FMT.formatDuration(Math.max(0, now() - focus.startedAt)) : '';
      const extra = tasks.length > 1 ? ` … +${tasks.length - 1}` : '';
      const mainText = [label, desc, elapsed].filter(Boolean).join(' · ') + extra;
      // tail 优先展示最近一次有新输出的运行中任务，不一定是主行那个。
      let tailSource = null;
      for (const task of tasks) {
        if (task.tailLine && (!tailSource || (task.tailAt || 0) > (tailSource.tailAt || 0))) tailSource = task;
      }
      const tailText = tailSource ? tailSource.tailLine : '';
      const titleText = tasks.map(task => clampText(task.description, TITLE_MAX)).join('\n');
      if (setStatus) {
        const inline = tailText ? `${mainText} · ↳ ${tailText}` : mainText;
        const title = tailText ? `${titleText}\n↳ ${tr('bgActivityLatest')} · ${tailText}` : titleText;
        if (setStatus(inline, title)) {
          if (el) { el.remove(); el = null; lastSignature = ''; }
          return;
        }
      }
      const node = ensureEl();
      if (!node) return;
      const signature = `${mainText}\n${tailText}`;
      if (signature === lastSignature) return;
      lastSignature = signature;
      const main = node.querySelector('.bg-activity-main');
      if (main) main.textContent = mainText;
      const tail = node.querySelector('.bg-activity-tail');
      if (tail) {
        if (tailText) {
          tail.textContent = `↳ ${tr('bgActivityLatest')} · ${tailText}`;
          tail.hidden = false;
        } else {
          tail.textContent = '';
          tail.hidden = true;
        }
      }
      node.title = titleText;
      debug('bg-activity', `render — ${running.size} running`);
    }

    async function pollTasks() {
      if (!fetchJson || pollInFlight) return;
      if (running.size === 0) return;
      const sessionId = getSessionId();
      if (!sessionId) return;
      pollInFlight = true;
      let payload = null;
      try {
        payload = await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/tasks`);
      } catch (error) {
        debug('bg-activity', 'tasks poll failed');
      } finally {
        pollInFlight = false;
      }
      const tasks = payload && Array.isArray(payload.tasks) ? payload.tasks : null;
      if (!tasks) return;
      const byId = new Map();
      for (const record of tasks) {
        if (record && record.taskId != null) byId.set(String(record.taskId), record);
      }
      let changed = false;
      for (const [taskId, task] of running) {
        const record = byId.get(taskId);
        if (!record) continue;
        const createdAt = Number(record.createdAt);
        if (Number.isFinite(createdAt) && createdAt > 0 && createdAt < task.startedAt) {
          task.startedAt = createdAt;
          changed = true;
        }
        const line = clampText(lastNonEmptyLine(record.lastOutput), TAIL_MAX);
        if (line && line !== task.tailLine) {
          task.tailLine = line;
          task.tailAt = Number(record.updatedAt) || now();
          changed = true;
        }
        // WS 的 monitor_done 丢了的话，这里用持久台账把行收掉，避免一直转。
        if (record.status && TERMINAL_STATUSES.has(String(record.status))) {
          running.delete(taskId);
          changed = true;
        }
      }
      if (changed) render();
    }

    function schedulePollNow() {
      if (fetchJson) pollTasks();
    }

    function remember(taskId, description) {
      const prev = running.get(taskId);
      running.set(taskId, {
        taskId,
        description: description || (prev && prev.description) || '',
        startedAt: prev ? prev.startedAt : now(),
        tailLine: prev ? prev.tailLine : '',
        tailAt: prev ? prev.tailAt : 0,
        lastSeenAt: now(),
      });
    }

    function onEvent(message) {
      if (!message || typeof message !== 'object') return;
      switch (message.type) {
        case 'monitor_started': {
          if (!isBackgroundMessage(message)) return;
          const taskId = taskIdOf(message);
          if (!taskId) return;
          remember(taskId, message.description);
          ensureTimers();
          schedulePollNow();
          render();
          break;
        }
        case 'monitor_progress': {
          if (!isBackgroundMessage(message)) return;
          const taskId = taskIdOf(message);
          if (!taskId) return;
          if (!running.has(taskId)) remember(taskId, message.description);
          else if (message.description) running.get(taskId).description = message.description;
          if (running.has(taskId)) running.get(taskId).lastSeenAt = now();
          // 进度心跳说明任务活着，顺带拉一次台账校准 tail。
          schedulePollNow();
          render();
          break;
        }
        case 'monitor_done': {
          const taskId = taskIdOf(message);
          if (taskId && running.delete(taskId)) render();
          break;
        }
        case 'background_tasks': {
          const snapshot = new Map();
          for (const task of message.tasks || []) {
            if (!task || !isBackgroundMessage(task)) continue;
            const taskId = taskIdOf(task);
            if (!taskId) continue;
            snapshot.set(taskId, task);
          }
          for (const [taskId, snap] of snapshot) {
            if (running.has(taskId)) {
              const task = running.get(taskId);
              if (snap.description) task.description = snap.description;
              task.lastSeenAt = now();
            } else {
              remember(taskId, snap.description);
            }
          }
          for (const taskId of [...running.keys()]) {
            if (snapshot.has(taskId)) continue;
            // 快照缺席但进度证据还新鲜：宽限内保留，避免与弹幕面板不一致地闪收。
            if (now() - (running.get(taskId).lastSeenAt || 0) <= SNAPSHOT_GRACE_MS) continue;
            running.delete(taskId);
          }
          if (running.size > 0) { ensureTimers(); schedulePollNow(); }
          render();
          break;
        }
        case 'stream_start':
          ensureTimers();
          render();
          break;
        case 'stream_end':
        case 'result':
        case 'error':
          // getIsStreaming() 翻 false 后 render 会收行；任务本身可能还在后台
          // 跑，那之后的可见性归左上角的后台任务卡，不占消息流。
          render();
          break;
        default:
          break;
      }
    }

    function dispose() {
      running.clear();
      if (el) { el.remove(); el = null; }
      stopTimersIfIdle();
    }

    // 速率角标（chat-token-rate.js）用它区分「AI 请求停了但后台在跑」和真卡死。
    return Object.freeze({ onEvent, dispose, runningCount: () => running.size });
  }

  const api = Object.freeze({ create: createBgActivity });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatBgActivity = api;
})(typeof window !== 'undefined' ? window : globalThis);
