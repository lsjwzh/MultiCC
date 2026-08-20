(function attachMultiCCChatScheduledSend(global) {
  'use strict';

  var MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;
  var UNIT_SECONDS = Object.freeze({ seconds: 1, minutes: 60, hours: 3600, days: 86400 });

  function translate(key, params) {
    try {
      if (typeof global.t === 'function') return global.t(key, params);
    } catch (_) {}
    var fallbacks = {
      scheduleSend: '定时发送',
      scheduleSendTitle: '定时发送消息',
      scheduleSendHint: '到期时空闲立即执行，正在执行任务就进入 FIFO。',
      scheduleDelayLabel: '多久后',
      scheduleSeconds: '秒',
      scheduleMinutes: '分钟',
      scheduleHours: '小时',
      scheduleDays: '天',
      scheduleCreate: '设为定时消息',
      scheduleCreating: '正在保存…',
      schedulePending: '待执行的定时消息',
      schedulePendingCount: '{n} 条待执行',
      scheduleNone: '暂无定时消息',
      scheduleMessageRequired: '请先在输入框填写要发送的消息',
      scheduleInvalidDelay: '请输入 1 秒到 7 天之间的时间',
      scheduleCreated: '已安排在 {time} 自动投递',
      scheduleCreateFailed: '创建定时消息失败：{error}',
      scheduleFetchFailed: '读取定时消息失败：{error}',
      scheduleCancel: '取消',
      scheduleCancelling: '取消中…',
      scheduleCancelFailed: '取消失败：{error}',
      scheduleClose: '关闭',
      scheduleDueAt: '执行时间：{time}',
      scheduleDueNow: '即将投递',
      scheduleRemainingSeconds: '{n} 秒后',
      scheduleRemainingMinutes: '{n} 分钟后',
      scheduleRemainingHours: '{n} 小时后',
      scheduleRemainingDays: '{n} 天后',
    };
    var text = fallbacks[key] || key;
    return text.replace(/\{(\w+)\}/g, function (_, name) {
      return params && Object.prototype.hasOwnProperty.call(params, name)
        ? String(params[name]) : '{' + name + '}';
    });
  }

  function parseDelaySeconds(value, unit) {
    var amount = Number(value);
    var multiplier = UNIT_SECONDS[String(unit || '')];
    if (!Number.isFinite(amount) || amount <= 0 || !multiplier) return null;
    var seconds = Math.round(amount * multiplier);
    return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= MAX_DELAY_SECONDS
      ? seconds : null;
  }

  function formatRemaining(dueAt, now) {
    var remaining = Math.max(0, Number(dueAt) - Number(now == null ? Date.now() : now));
    if (remaining <= 0) return translate('scheduleDueNow');
    var seconds = Math.ceil(remaining / 1000);
    if (seconds < 60) return translate('scheduleRemainingSeconds', { n: seconds });
    var minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return translate('scheduleRemainingMinutes', { n: minutes });
    var hours = Math.ceil(minutes / 60);
    if (hours < 24) return translate('scheduleRemainingHours', { n: hours });
    return translate('scheduleRemainingDays', { n: Math.ceil(hours / 24) });
  }

  function formatDueAt(value) {
    var date = new Date(Number(value));
    if (!Number.isFinite(date.getTime())) return '—';
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).format(date);
    } catch (_) { return date.toLocaleString(); }
  }

  function defaultClientScheduleId(now, random) {
    try {
      if (global.crypto && typeof global.crypto.randomUUID === 'function') {
        return 'schedule-' + global.crypto.randomUUID();
      }
    } catch (_) {}
    var at = Number(now == null ? Date.now() : now);
    var entropy = Number(random == null ? Math.random() : random);
    return 'schedule-' + at.toString(36) + '-' + entropy.toString(36).slice(2, 12);
  }

  function createScheduledMessageApi(options) {
    var opts = options || {};
    var fetchImpl = opts.fetch;
    var sessionId = String(opts.sessionId || '').trim();
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
    if (!sessionId) throw new TypeError('sessionId is required');
    var base = '/api/sessions/' + encodeURIComponent(sessionId) + '/scheduled-messages';

    async function decode(response) {
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok || data.ok !== true) {
        var error = new Error(data.error || data.code || ('HTTP ' + response.status));
        error.code = data.code || null;
        error.status = response.status;
        throw error;
      }
      return data;
    }

    return Object.freeze({
      async create(message, delaySeconds, clientScheduleId) {
        return decode(await fetchImpl(base, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': clientScheduleId,
          },
          body: JSON.stringify({ message: message, delaySeconds: delaySeconds }),
        }));
      },
      async list() {
        return decode(await fetchImpl(base, { credentials: 'same-origin', cache: 'no-store' }));
      },
      async cancel(messageId) {
        return decode(await fetchImpl(base + '/' + encodeURIComponent(messageId), {
          method: 'DELETE', credentials: 'same-origin',
        }));
      },
    });
  }

  function collectAttachmentPaths(attachArea) {
    var chips = attachArea && typeof attachArea.querySelectorAll === 'function'
      ? Array.from(attachArea.querySelectorAll('.attach-chip[data-path]')) : [];
    return {
      chips: chips,
      paths: chips.map(function (chip) { return String(chip.dataset && chip.dataset.path || '').trim(); })
        .filter(Boolean),
    };
  }

  function createController(options) {
    var opts = options || {};
    var input = opts.input;
    var attachArea = opts.attachArea || null;
    var api = opts.api;
    var decorate = typeof opts.decorate === 'function' ? opts.decorate : function (text) { return text; };
    var makeId = typeof opts.makeId === 'function' ? opts.makeId : defaultClientScheduleId;
    var onCreated = typeof opts.onCreated === 'function' ? opts.onCreated : function () {};
    var pendingAttempt = null;
    if (!input || !api || typeof api.create !== 'function') {
      throw new TypeError('input and scheduled message api are required');
    }

    function draft() {
      var typedText = String(input.value || '').trim();
      var attachments = collectAttachmentPaths(attachArea);
      var text = typedText;
      if (attachments.paths.length) text += (text ? ' ' : '') + attachments.paths.join(' ');
      var decorated = decorate(text);
      if (typeof decorated === 'string' && decorated.trim()) text = decorated.trim();
      return { typedText: typedText, text: text, chips: attachments.chips };
    }

    function clearDraft(chips) {
      input.value = '';
      if (input.style) input.style.height = 'auto';
      for (var chip of chips) if (chip && typeof chip.remove === 'function') chip.remove();
      if (attachArea && attachArea.classList && typeof attachArea.classList.toggle === 'function') {
        attachArea.classList.toggle('has-items', !!attachArea.children.length);
      }
      try {
        if (typeof input.dispatchEvent === 'function' && typeof global.Event === 'function') {
          input.dispatchEvent(new global.Event('input', { bubbles: true }));
        }
      } catch (_) {}
    }

    return Object.freeze({
      async schedule(value, unit) {
        var delaySeconds = parseDelaySeconds(value, unit);
        if (!delaySeconds) {
          var delayError = new Error(translate('scheduleInvalidDelay'));
          delayError.code = 'invalid_delay';
          throw delayError;
        }
        var message = draft();
        if (!message.typedText) {
          var messageError = new Error(translate('scheduleMessageRequired'));
          messageError.code = 'message_required';
          throw messageError;
        }
        var fingerprint = message.text + '\0' + delaySeconds;
        if (!pendingAttempt || pendingAttempt.fingerprint !== fingerprint) {
          pendingAttempt = { fingerprint: fingerprint, id: makeId() };
        }
        var result = await api.create(message.text, delaySeconds, pendingAttempt.id);
        pendingAttempt = null;
        clearDraft(message.chips);
        onCreated(result.scheduledMessage);
        return result;
      },
      draft: draft,
    });
  }

  function addStyles(documentRef) {
    if (documentRef.getElementById('scheduled-send-styles')) return;
    var style = documentRef.createElement('style');
    style.id = 'scheduled-send-styles';
    style.textContent = [
      '#schedule-send-btn{position:relative}',
      '#schedule-send-btn .schedule-badge{position:absolute;right:-4px;top:-5px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;background:#d29922;color:#0d1117;font:700 10px/16px system-ui;text-align:center}',
      '#schedule-send-panel{position:fixed;z-index:12000;width:min(440px,calc(100vw - 16px));max-height:min(62vh,520px);display:flex;flex-direction:column;background:#161b22;border:1px solid #30363d;border-radius:12px;box-shadow:0 16px 48px #000a;color:#c9d1d9;overflow:hidden}',
      '#schedule-send-panel[hidden]{display:none}',
      '.schedule-head{display:flex;align-items:center;gap:8px;padding:11px 12px;border-bottom:1px solid #30363d}',
      '.schedule-title{flex:1;font-size:14px;font-weight:700;color:#f0f6fc}',
      '.schedule-close,.schedule-cancel{border:1px solid #30363d;background:#21262d;color:#c9d1d9;border-radius:7px;cursor:pointer}',
      '.schedule-close{width:30px;height:30px;font-size:18px}',
      '.schedule-body{padding:12px;overflow:auto}',
      '.schedule-hint{margin-bottom:10px;color:#8b949e;font-size:11px;line-height:1.45}',
      '.schedule-controls{display:grid;grid-template-columns:minmax(0,1fr) minmax(90px,auto) auto;gap:7px;align-items:end}',
      '.schedule-field{display:flex;flex-direction:column;gap:4px;color:#8b949e;font-size:11px}',
      '.schedule-field input,.schedule-field select{height:36px;box-sizing:border-box;border:1px solid #30363d;border-radius:7px;background:#0d1117;color:#c9d1d9;padding:0 9px;font-size:14px}',
      '.schedule-submit{height:36px;border:0;border-radius:7px;background:#238636;color:#fff;padding:0 12px;font-weight:650;cursor:pointer;white-space:nowrap}',
      '.schedule-submit:hover{background:#2ea043}.schedule-submit:disabled{opacity:.55;cursor:default}',
      '.schedule-status{min-height:18px;margin:8px 0 2px;font-size:11px;color:#8b949e}.schedule-status.ok{color:#3fb950}.schedule-status.error{color:#f85149}',
      '.schedule-list-head{display:flex;justify-content:space-between;gap:8px;margin:10px 0 6px;padding-top:9px;border-top:1px solid #21262d;font-size:12px;font-weight:650}',
      '.schedule-count{color:#8b949e;font-size:11px;font-weight:400}',
      '.schedule-empty{padding:14px 6px;text-align:center;color:#6e7681;font-size:12px}',
      '.schedule-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:9px 0;border-top:1px solid #21262d}',
      '.schedule-item:first-child{border-top:0}.schedule-message{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#c9d1d9}',
      '.schedule-time{margin-top:4px;color:#6e7681;font-size:10px}.schedule-remaining{color:#d29922;margin-left:6px}',
      '.schedule-cancel{align-self:center;padding:5px 9px;font-size:11px}.schedule-cancel:hover{border-color:#f85149;color:#ff7b72}.schedule-cancel:disabled{opacity:.55}',
      'body.task-mode #schedule-send-btn,body.task-mode #schedule-send-panel{display:none!important}',
      '@media(max-width:420px){#schedule-send-btn{order:2;width:44px;height:44px}.schedule-controls{grid-template-columns:1fr 1fr}.schedule-submit{grid-column:1/-1}.schedule-field input,.schedule-field select,.schedule-submit{height:42px;font-size:16px}}',
    ].join('');
    (documentRef.head || documentRef.documentElement).appendChild(style);
  }

  function install(options) {
    var opts = options || {};
    var doc = opts.document || global.document;
    var locationRef = opts.location || global.location;
    if (!doc || !locationRef) return null;
    var params = new URLSearchParams(locationRef.search || '');
    var sessionId = String(params.get('session') || '').trim();
    if (!sessionId || params.get('task')) return null;
    var inputBar = doc.getElementById('input-bar');
    var input = doc.getElementById('input');
    var sendButton = doc.getElementById('send-btn');
    if (!inputBar || !input || !sendButton || doc.getElementById('schedule-send-btn')) return null;
    addStyles(doc);

    var button = doc.createElement('button');
    button.id = 'schedule-send-btn';
    button.type = 'button';
    button.className = 'input-action-btn';
    button.title = translate('scheduleSend');
    button.setAttribute('aria-label', translate('scheduleSend'));
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.textContent = '⏱';
    var badge = doc.createElement('span');
    badge.className = 'schedule-badge';
    badge.hidden = true;
    button.appendChild(badge);
    inputBar.insertBefore(button, sendButton);

    var panel = doc.createElement('section');
    panel.id = 'schedule-send-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'schedule-send-title');

    var head = doc.createElement('div');
    head.className = 'schedule-head';
    var title = doc.createElement('div');
    title.id = 'schedule-send-title';
    title.className = 'schedule-title';
    title.textContent = translate('scheduleSendTitle');
    var close = doc.createElement('button');
    close.type = 'button';
    close.className = 'schedule-close';
    close.title = translate('scheduleClose');
    close.setAttribute('aria-label', translate('scheduleClose'));
    close.textContent = '×';
    head.append(title, close);

    var body = doc.createElement('div');
    body.className = 'schedule-body';
    var hint = doc.createElement('div');
    hint.className = 'schedule-hint';
    hint.textContent = translate('scheduleSendHint');
    var controls = doc.createElement('div');
    controls.className = 'schedule-controls';
    var amountLabel = doc.createElement('label');
    amountLabel.className = 'schedule-field';
    amountLabel.appendChild(doc.createTextNode(translate('scheduleDelayLabel')));
    var amount = doc.createElement('input');
    amount.type = 'number';
    amount.min = '1';
    amount.max = String(MAX_DELAY_SECONDS);
    amount.step = '1';
    amount.value = '10';
    amount.inputMode = 'decimal';
    amountLabel.appendChild(amount);
    var unitLabel = doc.createElement('label');
    unitLabel.className = 'schedule-field';
    unitLabel.appendChild(doc.createTextNode('\u00a0'));
    var unit = doc.createElement('select');
    for (var choice of [
      ['seconds', 'scheduleSeconds'], ['minutes', 'scheduleMinutes'],
      ['hours', 'scheduleHours'], ['days', 'scheduleDays'],
    ]) {
      var option = doc.createElement('option');
      option.value = choice[0];
      option.textContent = translate(choice[1]);
      if (choice[0] === 'minutes') option.selected = true;
      unit.appendChild(option);
    }
    unitLabel.appendChild(unit);
    var submit = doc.createElement('button');
    submit.type = 'button';
    submit.className = 'schedule-submit';
    submit.textContent = translate('scheduleCreate');
    controls.append(amountLabel, unitLabel, submit);
    var status = doc.createElement('div');
    status.className = 'schedule-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    var listHead = doc.createElement('div');
    listHead.className = 'schedule-list-head';
    var listTitle = doc.createElement('span');
    listTitle.textContent = translate('schedulePending');
    var count = doc.createElement('span');
    count.className = 'schedule-count';
    listHead.append(listTitle, count);
    var list = doc.createElement('div');
    list.className = 'schedule-list';
    body.append(hint, controls, status, listHead, list);
    panel.append(head, body);
    doc.body.appendChild(panel);

    var api = createScheduledMessageApi({
      fetch: opts.fetch || global.fetch.bind(global), sessionId: sessionId,
    });
    var controller = createController({
      input: input,
      attachArea: doc.getElementById('attach-area'),
      api: api,
      decorate: function (text) {
        var dispatch = global.MultiCCChatDispatchHint;
        return dispatch && typeof dispatch.decorate === 'function' ? dispatch.decorate(text) : text;
      },
    });
    var items = [];
    var refreshTimer = null;
    var refreshTicks = 0;

    function setStatus(message, kind) {
      status.textContent = message || '';
      status.className = 'schedule-status' + (kind ? ' ' + kind : '');
    }

    function updateBadge() {
      badge.textContent = items.length > 99 ? '99+' : String(items.length);
      badge.hidden = items.length === 0;
      count.textContent = translate('schedulePendingCount', { n: items.length });
    }

    function render() {
      list.replaceChildren();
      updateBadge();
      if (!items.length) {
        var empty = doc.createElement('div');
        empty.className = 'schedule-empty';
        empty.textContent = translate('scheduleNone');
        list.appendChild(empty);
        return;
      }
      for (var item of items) {
        var row = doc.createElement('div');
        row.className = 'schedule-item';
        var detail = doc.createElement('div');
        var message = doc.createElement('div');
        message.className = 'schedule-message';
        message.textContent = String(item.message || '');
        message.title = String(item.message || '');
        var time = doc.createElement('div');
        time.className = 'schedule-time';
        time.textContent = translate('scheduleDueAt', { time: formatDueAt(item.dueAt) });
        var remaining = doc.createElement('span');
        remaining.className = 'schedule-remaining';
        remaining.dataset.dueAt = String(item.dueAt || '');
        remaining.textContent = formatRemaining(item.dueAt);
        time.appendChild(remaining);
        detail.append(message, time);
        var cancel = doc.createElement('button');
        cancel.type = 'button';
        cancel.className = 'schedule-cancel';
        cancel.textContent = translate('scheduleCancel');
        cancel.addEventListener('click', async function (event) {
          var target = event.currentTarget;
          var id = target.dataset.messageId;
          target.disabled = true;
          target.textContent = translate('scheduleCancelling');
          try {
            await api.cancel(id);
            items = items.filter(function (entry) { return entry.id !== id; });
            render();
          } catch (error) {
            target.disabled = false;
            target.textContent = translate('scheduleCancel');
            setStatus(translate('scheduleCancelFailed', { error: error.message }), 'error');
          }
        });
        cancel.dataset.messageId = item.id;
        row.append(detail, cancel);
        list.appendChild(row);
      }
    }

    function updateCountdowns() {
      list.querySelectorAll('.schedule-remaining[data-due-at]').forEach(function (node) {
        node.textContent = formatRemaining(node.dataset.dueAt);
      });
    }

    async function refresh(showError) {
      try {
        var result = await api.list();
        items = Array.isArray(result.scheduledMessages) ? result.scheduledMessages : [];
        render();
      } catch (error) {
        if (showError !== false) setStatus(translate('scheduleFetchFailed', { error: error.message }), 'error');
      }
    }

    function positionPanel() {
      var rect = inputBar.getBoundingClientRect();
      panel.style.left = Math.max(8, Math.min(
        (global.innerWidth - Math.min(440, global.innerWidth - 16)) / 2,
        global.innerWidth - panel.offsetWidth - 8,
      )) + 'px';
      panel.style.bottom = Math.max(8, global.innerHeight - rect.top + 8) + 'px';
    }

    function openPanel() {
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      positionPanel();
      refresh(true);
      refreshTicks = 0;
      if (!refreshTimer) refreshTimer = global.setInterval(function () {
        updateCountdowns();
        if (++refreshTicks % 15 === 0) refresh(false);
      }, 1000);
      amount.focus();
    }

    function closePanel() {
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (refreshTimer) global.clearInterval(refreshTimer);
      refreshTimer = null;
      input.focus();
    }

    button.addEventListener('click', function () { panel.hidden ? openPanel() : closePanel(); });
    close.addEventListener('click', closePanel);
    submit.addEventListener('click', async function () {
      submit.disabled = true;
      submit.textContent = translate('scheduleCreating');
      setStatus('', '');
      try {
        var result = await controller.schedule(amount.value, unit.value);
        var scheduled = result.scheduledMessage || {};
        setStatus(translate('scheduleCreated', { time: formatDueAt(scheduled.dueAt) }), 'ok');
        await refresh(false);
      } catch (error) {
        var key = error.code === 'message_required' ? 'scheduleMessageRequired'
          : error.code === 'invalid_delay' ? 'scheduleInvalidDelay' : 'scheduleCreateFailed';
        setStatus(translate(key, { error: error.message }), 'error');
      } finally {
        submit.disabled = false;
        submit.textContent = translate('scheduleCreate');
      }
    });
    panel.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closePanel();
    });
    global.addEventListener('resize', function () { if (!panel.hidden) positionPanel(); });
    refresh(false);

    return Object.freeze({
      api: api, controller: controller, open: openPanel, close: closePanel,
      refresh: refresh, panel: panel, button: button,
    });
  }

  var api = Object.freeze({
    MAX_DELAY_SECONDS: MAX_DELAY_SECONDS,
    parseDelaySeconds: parseDelaySeconds,
    formatRemaining: formatRemaining,
    defaultClientScheduleId: defaultClientScheduleId,
    createScheduledMessageApi: createScheduledMessageApi,
    createController: createController,
    install: install,
  });
  global.MultiCCChatScheduledSend = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global.document && global.__multiccScheduledSendNoAutoInstall !== true) install();
})(typeof window !== 'undefined' ? window : globalThis);
