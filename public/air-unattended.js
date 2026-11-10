'use strict';

// Air「新任务」里的无人值守开关 —— 目标 / 判断标准 / 轮次上限 + 辅助 AI 补全判断标准。
// 这里是创建入口，不是会话中的接管面板（那个在 public/chat-unattended.js）：
// 打开开关后，第一条消息体带上 unattended: { goal?, criteria?, maxRounds? }，
// 由服务端在任务第一条消息落库时建 record.unattended（契约 docs/unattended-mode.md）。
//   目标留空 = 用任务正文；标准可选（每行一条，最多 12 条、每条 300 字）；
//   轮次 1..200，服务端缺省 30。
// 补全标准复用既有 POST /api/goal/precheck { task }，把返回的 criteria 填进文本框。
// 样式也归这个文件：air.css 不认识 quick-unattended-*，而这块只有本文件是主人。
(function initAirUnattended(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  const MAX_CRITERIA = 12;
  const CRITERION_MAX = 300;
  const GOAL_MAX = 2000;
  const ROUNDS_MAX = 200;
  const ROUNDS_DEFAULT = 30;

  let context = null;
  let styleNode = null;

  function style() {
    if (styleNode) return styleNode;
    styleNode = document.createElement('style');
    styleNode.textContent = `
      .quick-unattended {
        display: grid;
        gap: 9px;
        margin: 2px 0 8px;
        padding: 10px 12px;
        border: 1px solid var(--hairline);
        border-radius: 12px;
        background: var(--surface-soft, #f7f8fa);
      }
      .quick-unattended[hidden] { display: none; }
      .quick-unattended-field { display: grid; gap: 4px; }
      .quick-unattended-field > span { color: var(--muted); font-size: 11.5px; font-weight: 600; }
      .quick-unattended-field > textarea {
        width: 100%;
        box-sizing: border-box;
        resize: vertical;
        min-height: 44px;
        padding: 7px 9px;
        border: 1px solid var(--hairline);
        border-radius: 8px;
        background: #fff;
        color: var(--text);
        font: inherit;
        font-size: 12px;
        line-height: 1.5;
      }
      .quick-unattended-field > textarea:focus { border-color: var(--accent); outline: none; }
      .quick-unattended-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
      .quick-unattended-rounds { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11.5px; }
      .quick-unattended-rounds > input { width: 72px; }
      .quick-unattended-draft {
        padding: 5px 10px;
        border: 1px solid var(--hairline);
        border-radius: 8px;
        background: #fff;
        color: var(--text);
        font: inherit;
        font-size: 11.5px;
        cursor: pointer;
      }
      .quick-unattended-draft:hover:not(:disabled) { border-color: var(--accent); }
      .quick-unattended-draft:disabled { opacity: .55; cursor: default; }
      .quick-unattended-status { margin: 0; color: var(--faint); font-size: 11px; line-height: 1.5; }
      .quick-unattended-status.warn { color: var(--warn, #b7791f); }
      .quick-unattended-status.error { color: var(--danger); }
      .quick-unattended-status.ok { color: var(--accent); }
      .quick-unattended-toggle { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 11.5px; cursor: pointer; }
      .quick-unattended-toggle > input { margin: 0; accent-color: var(--accent); }
    `;
    return styleNode;
  }

  function mountStyle() {
    if (!styleNode) style();
    if (!styleNode.isConnected) document.head.append(styleNode);
  }

  const toggle = () => el('quick-task-unattended');
  const box = () => el('quick-unattended');
  const goalInput = () => el('quick-unattended-goal');
  const criteriaInput = () => el('quick-unattended-criteria');
  const roundsInput = () => el('quick-unattended-rounds');
  const draftBtn = () => el('quick-unattended-draft');
  const statusEl = () => el('quick-unattended-status');

  function tr(key, params) {
    if (context && typeof context.t === 'function') return context.t(key, params);
    return (typeof window.t === 'function' ? window.t(key, params) : key);
  }

  function syncVisible() {
    const target = box();
    if (target && toggle()) target.hidden = !toggle().checked;
  }

  function setStatus(text, kind) {
    const node = statusEl();
    if (!node) return;
    node.textContent = text || '';
    node.className = 'quick-unattended-status' + (kind ? ' ' + kind : '');
  }

  function clampRounds(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return ROUNDS_DEFAULT;
    return Math.max(1, Math.min(ROUNDS_MAX, parsed));
  }

  function parseCriteria(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .slice(0, MAX_CRITERIA)
      .map(line => line.slice(0, CRITERION_MAX));
  }

  // taskText 是「任务正文」：目标留空时按契约把它当默认目标。
  function collect(taskText) {
    if (!toggle() || !toggle().checked) return null;
    const goal = String((goalInput() && goalInput().value) || '').trim().slice(0, GOAL_MAX)
      || String(taskText || '').trim().slice(0, GOAL_MAX);
    const criteria = parseCriteria(criteriaInput() && criteriaInput().value);
    return {
      ...(goal ? { goal } : {}),
      ...(criteria.length ? { criteria } : {}),
      maxRounds: clampRounds(roundsInput() && roundsInput().value),
    };
  }

  function reset() {
    if (toggle()) toggle().checked = false;
    if (goalInput()) goalInput().value = '';
    if (criteriaInput()) criteriaInput().value = '';
    if (roundsInput()) roundsInput().value = String(ROUNDS_DEFAULT);
    setStatus('');
    syncVisible();
  }

  async function draft() {
    const button = draftBtn();
    if (!button || button.disabled) return;
    const task = String((goalInput() && goalInput().value) || '').trim()
      || String((el('quick-task-input') && el('quick-task-input').value) || '').trim();
    if (!task) {
      setStatus(tr('airUnattendedGoalRequired'), 'error');
      (el('quick-task-input') || goalInput())?.focus?.();
      return;
    }
    const request = context && typeof context.request === 'function' ? context.request : null;
    if (!request) return;
    button.disabled = true;
    button.textContent = tr('airUnattendedDrafting');
    setStatus('');
    try {
      const data = await request('/api/goal/precheck', { task });
      if (data && data.ok === false) throw new Error(data.error || tr('airUnattendedDraftFailed'));
      const criteria = Array.isArray(data && data.criteria) ? data.criteria : [];
      if (criteria.length && criteriaInput()) {
        criteriaInput().value = criteria
          .map(item => String(item || '').trim())
          .filter(Boolean)
          .slice(0, MAX_CRITERIA)
          .map(item => item.slice(0, CRITERION_MAX))
          .join('\n');
      }
      const issues = Array.isArray(data && data.issues) ? data.issues.filter(Boolean) : [];
      if (data && data.verdict === 'ok') {
        setStatus(tr('airUnattendedDraftOk'), 'ok');
      } else {
        setStatus(tr('airUnattendedDraftWarn', { issues: issues.join('；') || tr('airUnattendedDraftWarnShort') }), 'warn');
      }
    } catch (error) {
      setStatus(tr('airUnattendedDraftFailed') + '：' + String((error && error.message) || error || ''), 'error');
    } finally {
      button.disabled = false;
      button.textContent = tr('airUnattendedDraft');
    }
  }

  function bind(options) {
    context = options || {};
    if (!toggle() || !box()) return false;
    mountStyle();
    toggle().onchange = () => {
      if (toggle().checked) setStatus(tr('airUnattendedToggleHint'));
      else setStatus('');
      syncVisible();
    };
    if (draftBtn()) draftBtn().onclick = () => void draft();
    if (roundsInput()) {
      roundsInput().addEventListener('change', () => {
        roundsInput().value = String(clampRounds(roundsInput().value));
      });
    }
    syncVisible();
    return true;
  }

  window.MultiCCAirUnattended = Object.freeze({ bind, collect, reset, draft });
})(window);
