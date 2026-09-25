'use strict';

/**
 * The sidebar's CLI update badge: one small icon at the top-left of Air, a count
 * badge when a newer version of some chat CLI is published, and a popover that
 * names each one and upgrades it on demand.
 *
 * Where the numbers come from: `GET /api/cli/versions` reports both halves —
 * the version of the binary this host actually spawns (`<bin> --version`) and
 * the version published upstream (npm registry, cached server-side for a day).
 * This module never probes anything itself: the server does that once at
 * startup and then daily, so opening the page is a single cached read.
 *
 * qoder (curl-script install) and zcode (manual desktop install) have no
 * comparable published source. They are shown with their current version and an
 * explicit "can't check" — never as "up to date", and never with a fake update.
 *
 * Self-initialising, like air-ops.js: it needs no page data from air.js (which
 * is an IIFE exposing no context), only the DOM it owns.
 */
(function initAirCliUpdate(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);

  const POLL_MS = 2500;
  const MAX_WAIT_MS = 8 * 60 * 1000;

  // 产品名，不是文案：中文界面里也是这几个词，所以不进 i18n 词典。这张表和服务端
  // src/cli/cli-capability.js 的 DISPLAY 同源（web 侧走共享 CLI 目录
  // public/provider-catalog.js）—— 原本这里是第三份手抄副本，漏了 claude-exp/codex-exp
  // 两个车道，于是它们升级完在浮层里只剩内部 id。
  const cliLabel = cli => window.MultiCCProviderCatalog.cliDisplayName(cli);

  let lastState = null;
  let lastError = false;
  let opened = false;
  // 每一行各有各的升级任务: 不同 CLI 之间没有任何冲突(服务端只对「同一个安装目标」
  // 返回 409), 所以不再用一个全局开关把整块面板锁成「一次只能点一个」。
  // 刷新会重建行 DOM, 所以进度存在这里, render() 之后按 cli 复原。
  const inFlight = new Map(); // cli -> { phase: 'running', text }

  // ── Requests ───────────────────────────────────────────────────────────
  // auth-client.js already wraps window.fetch, so same-origin calls carry the
  // access token without this module reading it.
  async function raw(path, body, method) {
    const options = { headers: { 'Content-Type': 'application/json' }, cache: 'no-store' };
    if (body !== undefined) {
      options.method = method || 'POST';
      options.body = JSON.stringify(body);
    } else if (method) {
      options.method = method;
    }
    const response = await fetch(path, options);
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = null; }
    return { ok: response.ok, status: response.status, data: payload };
  }

  async function get(path) {
    const result = await raw(path);
    if (!result.ok) {
      const message = (result.data && (result.data.error || result.data.message)) || `HTTP ${result.status}`;
      throw new Error(message);
    }
    return result.data;
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  // 时间自己拼「HH:MM」，不用 toLocaleTimeString：后者跟系统区域走，英文界面下
  // 可能冒出非 ASCII 的上午/下午，而这一行会被英文模式的中文扫描用例扫到。
  function clockText(iso) {
    const at = new Date(iso);
    if (!Number.isFinite(at.getTime())) return '';
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  }

  function entries() {
    const versions = (lastState && lastState.versions) || {};
    return Object.keys(versions).map(cli => [cli, versions[cli] || {}]);
  }

  // ── Badge ──────────────────────────────────────────────────────────────
  function paintBadge() {
    const button = el('cli-update-btn');
    const icon = el('cli-update-icon');
    const badge = el('cli-update-badge');
    if (!button) return;
    const count = Number((lastState && lastState.updateCount) || 0);
    button.classList.toggle('has-update', count > 0);
    if (icon) icon.textContent = count > 0 ? '🆕' : '⇧';
    if (!badge) return;
    // 角标只在真有新版时出现 —— 平时这颗图标就该是「一切都好」的样子。
    if (count > 0) {
      badge.textContent = String(count);
      badge.hidden = false;
    } else {
      badge.hidden = true;
      badge.textContent = '';
    }
  }

  // ── Rows ───────────────────────────────────────────────────────────────
  function statusLine(entry) {
    if (!entry.available) return t('airCliUpdateNotInstalled');
    if (!entry.version) return t('airCliUpdateCheckFailed');
    // 箭头只属于「真的有新版」: 已是最新时也把 latest 写出来会读成一条升级预告。
    if (entry.updateAvailable && entry.latest) return `v${entry.version} → v${entry.latest}`;
    if (!entry.updateSource) return `v${entry.version} · ${t('airCliUpdateUnknownSource')}`;
    return `v${entry.version} · ${t('airCliUpdateCurrent')}`;
  }

  // 未安装的行给一颗「安装」按钮：点一下就跑 /api/cli/:cli/install 那条官方安装
  // 链路（和升级同一套 job/轮询/日志）。需要手动安装的 CLI（zcode 桌面版等）由
  // 服务端回 manual 文案，原样写进副标题。
  function rowMode(entry) {
    if (!entry.available) return 'install';
    return entry.updateAvailable ? 'upgrade' : null;
  }

  function buildRow(cli, entry) {
    const mode = rowMode(entry);
    const row = node('div', `cli-update-row${entry.updateAvailable ? ' is-update' : (mode === 'install' ? ' is-missing' : ' is-current')}`);
    const name = node('span', 'cli-update-name');
    name.append(node('strong', null, cliLabel(cli)));
    const status = node('small', 'cli-update-versions', statusLine(entry));
    name.append(status);
    row.append(name);
    if (!mode) return { row, status, button: null, mode };
    const button = node('button', mode === 'install' ? 'secondary' : 'primary',
      t(mode === 'install' ? 'airCliUpdateInstall' : 'airCliUpdateUpgrade'));
    button.type = 'button';
    row.append(button);
    return { row, status, button, mode };
  }

  function render() {
    const host = el('cli-update-rows');
    const summary = el('cli-update-summary');
    const checked = el('cli-update-checked');
    if (!host) return;
    host.replaceChildren();
    if (!lastState) {
      if (summary) summary.textContent = lastError ? t('airCliUpdateCheckFailed') : t('airCliUpdateChecking');
      if (checked) checked.textContent = '';
      return;
    }
    const rows = entries();
    const pending = rows.filter(([, entry]) => entry.updateAvailable);
    if (summary) {
      summary.textContent = pending.length
        ? t('airCliUpdateCount', { count: pending.length })
        : t('airCliUpdateAllCurrent');
    }
    // 要升级的排最前面：打开浮层就是为了看它们；未安装的垫底。
    const installed = rows.filter(([, e]) => !e.updateAvailable && e.available);
    const missing = rows.filter(([, e]) => !e.updateAvailable && !e.available);
    for (const [cli, entry] of [...pending, ...installed, ...missing]) {
      const built = buildRow(cli, entry);
      if (built.button) {
        built.button.onclick = () => { void startUpgrade(cli, built.status, built.button, built.mode); };
      }
      // 重建 DOM 不能把「正在升级」的那一行擦回原样: 另一个 CLI 升级完成触发的
      // refresh 会走到这里, 若不复原, 用户会以为任务没了。
      const live = inFlight.get(cli);
      if (live && live.phase === 'running') {
        if (built.status) built.status.textContent = live.text;
        if (built.button) built.button.disabled = true;
      }
      host.append(built.row);
    }
    if (checked && lastState.checkedAt) {
      checked.textContent = t('airCliUpdateCheckedAt', { time: clockText(lastState.checkedAt) });
    }
  }

  // ── Popover placement ──────────────────────────────────────────────────
  function place() {
    const panel = el('cli-update-pop');
    const anchor = el('cli-update-btn');
    if (!panel || !anchor || typeof anchor.getBoundingClientRect !== 'function') return;
    const rect = anchor.getBoundingClientRect();
    const width = panel.offsetWidth || 340;
    const viewport = Number(root.innerWidth) || 0;
    const left = viewport ? Math.min(Math.max(8, rect.right - width), Math.max(8, viewport - width - 8)) : 8;
    panel.style.top = `${Math.round(rect.bottom + 8)}px`;
    panel.style.left = `${Math.round(left)}px`;
  }

  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  }

  function onOutside(event) {
    const panel = el('cli-update-pop');
    const button = el('cli-update-btn');
    if (!panel) return;
    if (panel.contains(event.target) || (button && button.contains(event.target))) return;
    close();
  }

  function close() {
    const panel = el('cli-update-pop');
    const button = el('cli-update-btn');
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    opened = false;
    if (button) button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    root.removeEventListener('resize', close);
    root.removeEventListener('scroll', close, true);
  }

  function open() {
    const panel = el('cli-update-pop');
    const button = el('cli-update-btn');
    if (!panel || !button) return;
    panel.hidden = false;
    opened = true;
    button.setAttribute('aria-expanded', 'true');
    render();
    // 量宽度要在显示之后：hidden 的元素 offsetWidth 是 0，贴边会算错。
    place();
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    root.addEventListener('resize', close);
    // 浮层是 fixed 的：侧栏自己滚（窄屏整条抽屉可滚）时它不会跟着动，会悬在半空
    // 指向别处，所以一滚就收起。
    root.addEventListener('scroll', close, true);
  }

  // ── Upgrade ────────────────────────────────────────────────────────────
  // 进度写回「该行的副标题 + 浮层底部那一块日志」，不重建整块 —— 重建会把用户
  // 正在看的日志抹掉。多个 CLI 可以同时升级，所以日志行带产品名前缀，谁的就看得清。
  function paintProgress(cli, status, text, log) {
    if (status) status.textContent = text;
    const line = el('cli-update-log');
    if (!line) return;
    if (log == null) {
      line.textContent = '';
      line.hidden = true;
      return;
    }
    line.textContent = cli ? `[${cliLabel(cli)}] ${log}` : log;
    line.hidden = false;
    line.scrollTop = line.scrollHeight;
  }

  async function startUpgrade(cli, status, button, mode) {
    // 同一行不并行(服务端也会 409)，但别的行不受影响。
    const live = inFlight.get(cli);
    if (live && live.phase === 'running') return;
    const install = mode === 'install';
    const labels = install
      ? { running: 'airCliUpdateInstalling', done: 'airCliUpdateInstallDone', failed: 'airCliUpdateInstallFailed' }
      : { running: 'airCliUpdateUpgrading', done: 'airCliUpdateDone', failed: 'airCliUpdateFailed' };
    const name = cliLabel(cli);
    const entry = ((lastState && lastState.versions) || {})[cli] || {};
    // 安装一个还没有的 CLI 不影响任何现有会话，点了就装，不再多问一次；升级会
    // 换掉正在用的二进制，所以仍要确认。
    if (!install) {
      const inUse = Number(entry.inUseCount) || 0;
      const question = inUse > 0
        ? t('airCliUpdateConfirmBusy', { cli: name, count: inUse })
        : t('airCliUpdateConfirm', { cli: name });
      if (root.confirm && !root.confirm(question)) return;
    }

    button.disabled = true;
    let started;
    try {
      started = await raw(`/api/cli/${encodeURIComponent(cli)}/${install ? 'install' : 'upgrade'}`, {});
    } catch (error) {
      button.disabled = false;
      inFlight.delete(cli);
      paintProgress(cli, status, t(labels.failed, { error: error.message }), null);
      return;
    }
    const data = started.data || {};
    // 并发点击时服务端已经装好了：直接当完成处理。
    if (started.ok && data.alreadyInstalled) {
      inFlight.delete(cli);
      paintProgress(cli, status, t(labels.done), null);
      await refresh(true);
      return;
    }
    if (!started.ok || !data.jobId) {
      button.disabled = false;
      inFlight.delete(cli);
      paintProgress(cli, status, t(labels.failed, { error: data.error || `HTTP ${started.status}` }), null);
      return;
    }

    button.disabled = false;
    inFlight.set(cli, { phase: 'running', text: t(labels.running) });
    paintProgress(cli, status, t(labels.running), null);
    const startedAt = Date.now();
    for (;;) {
      let job = null;
      try {
        const state = await get(`/api/cli/install-status/${encodeURIComponent(data.jobId)}`);
        job = state && state.job;
      } catch (_) {
        job = null;
      }
      if (job) {
        if (job.status === 'done') {
          inFlight.delete(cli);
          paintProgress(cli, status, t(labels.done), job.logTail || '');
          await refresh(true);
          return;
        }
        if (job.status === 'error') {
          inFlight.delete(cli);
          // hint 是服务端查明的具体原因(网络/证书/新版本装到了别的位置)，比一行
          // 退出码有用得多，必须和日志一起给出来。
          const detail = job.hint ? `${job.logTail || ''}\n\n${job.hint}` : (job.logTail || '');
          paintProgress(cli, status, t(labels.failed, { error: job.error || '' }), detail);
          await refresh(false);
          return;
        }
        paintProgress(cli, status, t(labels.running), job.logTail || '');
      }
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        inFlight.delete(cli);
        paintProgress(cli, status, t('airCliUpdateTimeout'), null);
        return;
      }
      await sleep(POLL_MS);
    }
  }

  // ── Refresh ────────────────────────────────────────────────────────────
  // force=true 走 ?refresh=1：本地 `--version` 与上游 latest 都重新探一次。
  // 升级完必用 —— 否则会把升级前的缓存原样回放，角标不消失。
  async function refresh(force) {
    try {
      lastState = await get(force ? '/api/cli/versions?refresh=1' : '/api/cli/versions');
      lastError = false;
    } catch (_) {
      // 读失败不清空上一次的结果：一次网络抖动不该把「3 个 CLI 可升级」擦成空白。
      lastError = true;
    }
    paintBadge();
    if (opened) render();
    return lastState;
  }

  // ── Wiring ─────────────────────────────────────────────────────────────
  function initialize() {
    const button = el('cli-update-btn');
    if (!button) return; // not on the Air shell

    button.onclick = () => { if (opened) close(); else open(); };
    const closeButton = el('cli-update-close');
    if (closeButton) closeButton.onclick = () => close();
    const refreshButton = el('cli-update-refresh');
    if (refreshButton) {
      refreshButton.onclick = () => {
        refreshButton.disabled = true;
        void refresh(true).then(() => { refreshButton.disabled = false; });
      };
    }
    void refresh(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
})(typeof window !== 'undefined' ? window : null);
