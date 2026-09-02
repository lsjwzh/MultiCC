(function () {
  'use strict';

  const STEP_KEY = 'multicc_onboard_step';
  const DONE_KEY = 'multicc_onboard_done';
  const LANG_KEY = 'multicc_lang';

  const COPY = {
    zh: {
      close: '关闭',
      skip: '跳过',
      prev: '上一步',
      next: '下一步',
      done: '完成',
      continueInChat: '打开对话后继续',
      fillExample: '填入只读示例',
      step: '新手引导 {n}/4',
      step1Title: '选择一个工作区',
      step1Body: '工作区就是你希望 AI 帮忙处理的文件夹。首次体验可选一个资料较少的文件夹；MultiCC 会在独立副本中工作，不会直接覆盖原文件。',
      step2Title: '开始一段对话',
      step2Body: '进入工作区后点“开始对话”。MultiCC 会自动使用已经就绪的 AI 服务；CLI、模型和终端等开发者选项可以以后再设置。',
      step3Title: '获取第一份安全结果',
      step3Body: '先让 AI 只读了解文件夹，不做任何修改。点下面填入示例，再按发送；收到 AI 的有效回复后，引导会自动进入最后一步。',
      step4Title: '第一份结果已经完成',
      step4Body: '现在你可以继续追问。如果以后允许 AI 修改文件，MultiCC 会保留独立副本，并在应用到主工作区前展示影响范围。',
      example: '先不要修改任何文件。请概括这个工作区里有哪些内容，并告诉我最值得先看的三个文件。'
    },
    en: {
      close: 'Close',
      skip: 'Skip',
      prev: 'Back',
      next: 'Next',
      done: 'Done',
      continueInChat: 'Continue after opening a chat',
      fillExample: 'Insert read-only example',
      step: 'Onboarding {n}/4',
      step1Title: 'Choose a workspace',
      step1Body: 'A workspace is the folder you want AI to help with. Start with a small folder. MultiCC works in an isolated copy and does not overwrite the original files directly.',
      step2Title: 'Start a conversation',
      step2Body: 'Open the workspace and choose “Start a conversation.” MultiCC uses an AI service that is already ready; CLI, model, and terminal controls can wait until later.',
      step3Title: 'Get your first safe result',
      step3Body: 'Begin with a read-only request. Insert the example below and send it. The guide advances automatically after a real AI response arrives.',
      step4Title: 'Your first result is ready',
      step4Body: 'You can keep asking follow-up questions. If you later allow file edits, MultiCC keeps an isolated copy and shows the impact before applying changes.',
      example: 'Do not modify any files yet. Summarize what is in this workspace and tell me the three files I should read first.'
    }
  };

  const STEPS = {
    1: {
      page: 'manage',
      selector: 'button[onclick*="openNewDirectoryModal"], [data-i18n="newDirectory"]',
      title: 'step1Title',
      body: 'step1Body'
    },
    2: {
      page: 'manage',
      selector: 'button[onclick*="showNewSessionMenu"], .add-new',
      title: 'step2Title',
      body: 'step2Body'
    },
    3: {
      page: 'chat',
      selector: '#input',
      title: 'step3Title',
      body: 'step3Body',
      fill: true
    },
    4: {
      page: 'chat',
      selector: '#messages',
      title: 'step4Title',
      body: 'step4Body'
    }
  };

  let activeStep = null;
  let currentTarget = null;
  let spotlight = null;
  let card = null;
  let waitTimer = null;
  let resultObserver = null;
  let resultBaseline = null;
  let stopResultTrigger = null;

  function lang() {
    try {
      return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'zh';
    } catch (_) {
      return 'zh';
    }
  }

  function text(key, params) {
    let value = (COPY[lang()] && COPY[lang()][key]) || COPY.zh[key] || key;
    if (params) {
      Object.keys(params).forEach((name) => {
        value = value.replace(new RegExp('\\{' + name + '\\}', 'g'), params[name]);
      });
    }
    return value;
  }

  function pageName() {
    if (document.getElementById('role-btn') && document.getElementById('input')) return 'chat';
    if (document.getElementById('topbar') && document.getElementById('content')) return 'manage';
    return '';
  }

  function getStoredStep() {
    try {
      const raw = parseInt(localStorage.getItem(STEP_KEY) || '1', 10);
      return Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 4) : 1;
    } catch (_) {
      return 1;
    }
  }

  function setStoredStep(step) {
    try {
      localStorage.setItem(STEP_KEY, String(step));
    } catch (_) {}
  }

  function isDone() {
    try {
      return localStorage.getItem(DONE_KEY) === '1';
    } catch (_) {
      return true;
    }
  }

  function markDone() {
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch (_) {}
  }

  function restart(step) {
    try {
      localStorage.removeItem(DONE_KEY);
    } catch (_) {}
    start(step || (pageName() === 'chat' ? 3 : 1));
  }

  function injectStyle() {
    if (document.getElementById('multicc-tour-style')) return;
    const style = document.createElement('style');
    style.id = 'multicc-tour-style';
    style.textContent = `
      .multicc-tour-spotlight {
        position: fixed;
        z-index: 19000;
        pointer-events: none;
        border-radius: 12px;
        box-shadow:
          0 0 0 9999px rgba(1, 4, 9, .72),
          0 0 0 2px #58a6ff,
          0 0 28px rgba(88, 166, 255, .45);
        transition: left .16s ease, top .16s ease, width .16s ease, height .16s ease;
      }
      .multicc-tour-card {
        position: fixed;
        z-index: 19001;
        width: min(360px, calc(100vw - 28px));
        max-height: calc(100vh - 28px);
        overflow: auto;
        padding: 16px;
        color: #c9d1d9;
        background: #161b22;
        border: 1px solid #30363d;
        border-radius: 12px;
        box-shadow: 0 18px 60px rgba(0, 0, 0, .42);
        font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .multicc-tour-card h3 {
        margin: 4px 28px 8px 0;
        color: #f0f6fc;
        font-size: 16px;
        line-height: 1.35;
      }
      .multicc-tour-card p {
        margin: 0 0 14px;
        color: #8b949e;
      }
      .multicc-tour-eyebrow {
        color: #58a6ff;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: .02em;
      }
      .multicc-tour-close {
        position: absolute;
        top: 10px;
        right: 10px;
        width: 28px;
        height: 28px;
        display: grid;
        place-items: center;
        border: 1px solid transparent;
        border-radius: 8px;
        color: #8b949e;
        background: transparent;
        cursor: pointer;
        font-size: 18px;
      }
      .multicc-tour-close:hover {
        color: #f0f6fc;
        background: #21262d;
        border-color: #30363d;
      }
      .multicc-tour-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .multicc-tour-spacer { flex: 1 1 auto; }
      .multicc-tour-btn {
        border: 1px solid #30363d;
        border-radius: 8px;
        padding: 7px 10px;
        color: #c9d1d9;
        background: #21262d;
        cursor: pointer;
        font-size: 13px;
        line-height: 1.2;
      }
      .multicc-tour-btn:hover {
        color: #f0f6fc;
        border-color: #58a6ff;
      }
      .multicc-tour-btn.primary {
        color: #fff;
        background: #238636;
        border-color: #2ea043;
      }
      .multicc-tour-btn.fill {
        margin: 0 0 14px;
        color: #58a6ff;
        background: rgba(88, 166, 255, .08);
        border-color: rgba(88, 166, 255, .35);
      }
      @media (max-width: 520px) {
        .multicc-tour-card {
          left: 14px !important;
          right: 14px !important;
          width: auto;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function findTarget(step) {
    const spec = STEPS[step];
    if (!spec) return null;
    const nodes = Array.from(document.querySelectorAll(spec.selector));
    return nodes.find(visible) || null;
  }

  function waitForTarget(step, callback) {
    const started = Date.now();
    clearTimeout(waitTimer);
    const tick = () => {
      const target = findTarget(step);
      if (target || Date.now() - started > 3000) {
        callback(target);
        return;
      }
      waitTimer = setTimeout(tick, 120);
    };
    tick();
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function ensureElements() {
    injectStyle();
    if (!spotlight) {
      spotlight = document.createElement('div');
      spotlight.className = 'multicc-tour-spotlight';
      document.body.appendChild(spotlight);
    }
    if (!card) {
      card = document.createElement('div');
      card.className = 'multicc-tour-card';
      document.body.appendChild(card);
    }
  }

  function updateGeometry() {
    if (!activeStep || !card || !spotlight) return;

    const target = currentTarget && document.body.contains(currentTarget) && visible(currentTarget)
      ? currentTarget
      : null;

    const margin = 10;
    let rect = null;
    if (target) {
      rect = target.getBoundingClientRect();
      spotlight.style.display = 'block';
      // Clamp the spotlight inside the viewport so it never produces a
      // horizontal scrollbar or gets clipped on phone screens.
      const left = Math.max(8, Math.min(rect.left - margin, innerWidth - rect.width - margin - 8));
      const top = Math.max(8, Math.min(rect.top - margin, innerHeight - rect.height - margin - 8));
      spotlight.style.left = `${left}px`;
      spotlight.style.top = `${top}px`;
      spotlight.style.width = `${rect.width + margin * 2}px`;
      spotlight.style.height = `${rect.height + margin * 2}px`;
    } else {
      spotlight.style.display = 'none';
    }

    const cardRect = card.getBoundingClientRect();
    const pad = 14;
    const width = Math.min(360, window.innerWidth - pad * 2);
    let left = Math.round((window.innerWidth - width) / 2);
    let top = Math.round((window.innerHeight - cardRect.height) / 2);

    if (rect) {
      left = clamp(rect.left, pad, window.innerWidth - width - pad);
      const below = rect.bottom + margin + 12;
      const above = rect.top - cardRect.height - margin - 12;
      if (below + cardRect.height < window.innerHeight - pad) top = below;
      else if (above > pad) top = above;
      else top = clamp(rect.bottom + 12, pad, window.innerHeight - cardRect.height - pad);
    }

    card.style.left = `${left}px`;
    card.style.top = `${clamp(top, pad, Math.max(pad, window.innerHeight - cardRect.height - pad))}px`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function renderCard() {
    const spec = STEPS[activeStep];
    const showPrev = activeStep > 1 && !(pageName() === 'chat' && activeStep === 3);
    const nextLabel = activeStep === 2 && pageName() === 'manage'
      ? text('continueInChat')
      : activeStep === 4
        ? text('done')
        : text('next');
    const fill = spec.fill
      ? `<button class="multicc-tour-btn fill" type="button" data-tour-action="fill">${escapeHtml(text('fillExample'))}</button>`
      : '';

    card.innerHTML = `
      <button class="multicc-tour-close" type="button" data-tour-action="close" aria-label="${escapeHtml(text('close'))}">&times;</button>
      <div class="multicc-tour-eyebrow">${escapeHtml(text('step', { n: activeStep }))}</div>
      <h3>${escapeHtml(text(spec.title))}</h3>
      <p>${escapeHtml(text(spec.body))}</p>
      ${fill}
      <div class="multicc-tour-actions">
        <button class="multicc-tour-btn" type="button" data-tour-action="skip">${escapeHtml(text('skip'))}</button>
        <span class="multicc-tour-spacer"></span>
        ${showPrev ? `<button class="multicc-tour-btn" type="button" data-tour-action="prev">${escapeHtml(text('prev'))}</button>` : ''}
        <button class="multicc-tour-btn primary" type="button" data-tour-action="next">${escapeHtml(nextLabel)}</button>
      </div>
    `;
    card.onclick = onCardClick;
  }

  function show(step) {
    const spec = STEPS[step];
    if (!spec || spec.page !== pageName()) return;
    activeStep = step;
    setStoredStep(step);
    ensureElements();
    renderCard();

    if (step === 3) armFirstResultObserver();
    else stopFirstResultObserver();

    waitForTarget(step, (target) => {
      if (activeStep !== step) return;
      if (!target) {
        advanceMissing();
        return;
      }
      currentTarget = target;
      try {
        target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      } catch (_) {
        target.scrollIntoView();
      }
      setTimeout(updateGeometry, 180);
      updateGeometry();
    });
  }

  function stopFirstResultObserver() {
    if (resultObserver) resultObserver.disconnect();
    if (stopResultTrigger) stopResultTrigger();
    resultObserver = null;
    resultBaseline = null;
    stopResultTrigger = null;
  }

  function armFirstResultObserver() {
    stopFirstResultObserver();
    const messages = document.getElementById('messages');
    if (!messages || typeof MutationObserver !== 'function') return;
    const count = (selector) => messages.querySelectorAll(selector).length;
    resultBaseline = {
      users: count('.msg.user'),
      assistants: count('.msg.assistant'),
      sent: false
    };
    const input = document.getElementById('input');
    const sendButton = document.getElementById('send-btn');
    const markSent = () => {
      if (!resultBaseline) return;
      resultBaseline.users = count('.msg.user');
      resultBaseline.assistants = count('.msg.assistant');
      resultBaseline.sent = true;
    };
    const markEnter = (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) markSent();
    };
    sendButton?.addEventListener('click', markSent, true);
    sendButton?.addEventListener('touchend', markSent, true);
    input?.addEventListener('keydown', markEnter, true);
    stopResultTrigger = () => {
      sendButton?.removeEventListener('click', markSent, true);
      sendButton?.removeEventListener('touchend', markSent, true);
      input?.removeEventListener('keydown', markEnter, true);
    };
    resultObserver = new MutationObserver(() => {
      if (activeStep !== 3 || !resultBaseline) return;
      const users = count('.msg.user');
      const assistants = count('.msg.assistant');
      const latest = Array.from(messages.querySelectorAll('.msg.assistant')).pop();
      if (resultBaseline.sent
          && users > resultBaseline.users
          && assistants > resultBaseline.assistants
          && latest
          && latest.textContent.trim().length > 0) {
        show(4);
      }
    });
    resultObserver.observe(messages, { childList: true, subtree: true, characterData: true });
  }

  function start(step) {
    const firstStep = Math.min(Math.max(parseInt(step || 1, 10), 1), 4);
    if (STEPS[firstStep].page !== pageName()) {
      show(pageName() === 'chat' ? 3 : 1);
      return;
    }
    show(firstStep);
  }

  function cleanup(done) {
    clearTimeout(waitTimer);
    stopFirstResultObserver();
    activeStep = null;
    currentTarget = null;
    if (spotlight) spotlight.remove();
    if (card) card.remove();
    spotlight = null;
    card = null;
    if (done) markDone();
  }

  function next() {
    if (activeStep === 4) {
      setStoredStep(4);
      cleanup(true);
      return;
    }
    if (activeStep === 2 && pageName() === 'manage') {
      setStoredStep(3);
      cleanup(false);
      return;
    }
    show(activeStep + 1);
  }

  function prev() {
    if (activeStep <= 1) return;
    show(activeStep - 1);
  }

  function advanceMissing() {
    if (!activeStep) return;
    if (activeStep === 2 && pageName() === 'manage') {
      setStoredStep(3);
      cleanup(false);
      return;
    }
    if (activeStep >= 4) {
      cleanup(true);
      return;
    }
    const candidate = activeStep + 1;
    if (STEPS[candidate] && STEPS[candidate].page === pageName()) show(candidate);
    else {
      setStoredStep(candidate);
      cleanup(false);
    }
  }

  function fillExample() {
    const input = document.getElementById('input');
    if (!input) return;
    input.value = text('example');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    updateGeometry();
  }

  function onCardClick(ev) {
    const action = ev.target && ev.target.getAttribute('data-tour-action');
    if (!action) return;
    ev.preventDefault();
    if (action === 'close' || action === 'skip') cleanup(true);
    else if (action === 'next') next();
    else if (action === 'prev') prev();
    else if (action === 'fill') fillExample();
  }

  function autoStart() {
    if (isDone()) return;
    const page = pageName();
    const step = getStoredStep();
    if (page === 'manage' && step <= 2) start(step);
    if (page === 'manage' && step > 2) return;
    if (page === 'chat' && step >= 3) start(step);
  }

  window.startOnboarding = function () {
    restart(1);
  };

  window.addEventListener('resize', updateGeometry);
  window.addEventListener('scroll', updateGeometry, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && activeStep) cleanup(true);
  });
  document.addEventListener('DOMContentLoaded', autoStart);
})();
