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

  // 产品名，不是文案：中文界面里也是这几个词，所以不进 i18n 词典。
  const CLI_LABELS = Object.freeze({
    claude: 'Claude Code',
    codex: 'Codex',
    opencode: 'OpenCode',
    zcode: 'ZCode',
    qoder: 'Qoder CN',
    kimi: 'Kimi Code',
    codebuddy: 'WorkBuddy',
    dsh: 'DSH',
  });

  let lastState = null;
  let lastError = false;
  let opened = false;
  let upgrade = null; // { cli, jobId } —— 同一时刻只跑一个升级

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

  function buildRow(cli, entry) {
    const row = node('div', `cli-update-row${entry.updateAvailable ? ' is-update' : ' is-current'}`);
    const name = node('span', 'cli-update-name');
    name.append(node('strong', null, CLI_LABELS[cli] || cli));
    const status = node('small', 'cli-update-versions', statusLine(entry));
    name.append(status);
    row.append(name);
    if (!entry.updateAvailable) return { row, status, button: null };
    const button = node('button', 'primary', t('airCliUpdateUpgrade'));
    button.type = 'button';
    row.append(button);
    return { row, status, button };
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
    // 要升级的排最前面：打开浮层就是为了看它们。
    for (const [cli, entry] of [...pending, ...rows.filter(([, e]) => !e.updateAvailable)]) {
      const built = buildRow(cli, entry);
      if (built.button) {
        built.button.onclick = () => { void startUpgrade(cli, built.status, built.button); };
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
  // 同一时刻只跑一个升级，所以进度写回「该行的副标题 + 浮层底部那一块日志」，
  // 不重建整块 —— 重建会把用户正在看的日志抹掉。
  function paintProgress(status, text, log) {
    if (status) status.textContent = text;
    const line = el('cli-update-log');
    if (!line) return;
    if (log == null) {
      line.textContent = '';
      line.hidden = true;
      return;
    }
    line.textContent = log;
    line.hidden = false;
    line.scrollTop = line.scrollHeight;
  }

  async function startUpgrade(cli, status, button) {
    if (upgrade) return;
    const name = CLI_LABELS[cli] || cli;
    const entry = ((lastState && lastState.versions) || {})[cli] || {};
    const inUse = Number(entry.inUseCount) || 0;
    const question = inUse > 0
      ? t('airCliUpdateConfirmBusy', { cli: name, count: inUse })
      : t('airCliUpdateConfirm', { cli: name });
    if (root.confirm && !root.confirm(question)) return;

    button.disabled = true;
    let started;
    try {
      started = await raw(`/api/cli/${encodeURIComponent(cli)}/upgrade`, {});
    } catch (error) {
      button.disabled = false;
      paintProgress(status, t('airCliUpdateFailed', { error: error.message }), null);
      return;
    }
    const data = started.data || {};
    if (!started.ok || !data.jobId) {
      button.disabled = false;
      paintProgress(status, t('airCliUpdateFailed', { error: data.error || `HTTP ${started.status}` }), null);
      return;
    }

    button.disabled = false;
    upgrade = { cli, jobId: data.jobId };
    paintProgress(status, t('airCliUpdateUpgrading'), null);
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
          upgrade = null;
          paintProgress(status, t('airCliUpdateDone'), job.logTail || '');
          await refresh(true);
          return;
        }
        if (job.status === 'error') {
          upgrade = null;
          paintProgress(status, t('airCliUpdateFailed', { error: job.error || '' }), job.logTail || '');
          await refresh(false);
          return;
        }
        paintProgress(status, t('airCliUpdateUpgrading'), job.logTail || '');
      }
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        upgrade = null;
        paintProgress(status, t('airCliUpdateTimeout'), null);
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
