(function (root) {
  'use strict';

  const CODE_RE = /^[0-9A-Z]{4}$/;

  function text(value) {
    return typeof value === 'string' ? value : value == null ? '' : String(value);
  }

  function codeOf(value) {
    const code = text(value).trim().toUpperCase();
    return CODE_RE.test(code) ? code : '';
  }

  function refId(ref) {
    return text(ref?.id || ref?.sourceMessageId || '').trim();
  }

  // Reading line for the scroll-spy: the last rendered message whose top is
  // above 34% of the viewport is the one the reader is on. Pure on purpose, so
  // the rule is testable without a layout engine; nodes with no measurable rect
  // are skipped instead of guessed.
  function currentCodeAt(nodes, lineY) {
    let code = '';
    for (const node of nodes || []) {
      const rect = typeof node?.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
      if (!rect || !Number.isFinite(rect.top) || rect.top > lineY) continue;
      code = codeOf(node?.dataset?.taskShortCode) || code;
    }
    return code;
  }

  // Page-level glue for an index jump, kept here so the fallback order is
  // testable: the requested segment's anchor first, then the task's own
  // boundaries — when a message was deleted, the nearest still-visible record is
  // one of those. Returns false only when nothing could be located, which is the
  // signal that the row should be reported as dead instead of looking live.
  function createAnchorJump({ findById, fetchAround, merge, locate, report = () => {} }) {
    return async function jump(ref, entry) {
      const anchors = [];
      const push = value => {
        const id = refId(value);
        if (id && !anchors.includes(id)) anchors.push(id);
      };
      push(ref);
      push(entry?.segments?.[0]?.firstMessageRef);
      push(entry?.firstMessageRef);
      push(entry?.lastMessageRef);
      for (const id of anchors) {
        try {
          if (!findById(id)) {
            const page = await fetchAround(id);
            if (page?.found !== true) continue;
            merge(page.messages, page);
          }
          if (locate(id) === true) return true;
        } catch (error) { report(error); }
      }
      return false;
    };
  }

  function createController(options = {}) {
    const doc = options.document || root.document;
    const messages = options.messagesEl;
    if (!doc || !messages) throw new TypeError('document and messagesEl are required');
    const storage = options.storage || root.localStorage;
    const translate = typeof options.translate === 'function'
      ? options.translate : key => key === 'taskIndexToggle' ? '任务索引' : key;
    const detach = typeof options.onDetach === 'function' ? options.onDetach : null;
    const loadIndex = typeof options.loadIndex === 'function' ? options.loadIndex : null;
    const navigate = typeof options.navigate === 'function' ? options.navigate : null;
    const onMissing = typeof options.onMissing === 'function' ? options.onMissing : null;
    // 「选为下一条输入目标」是显式动作：滚动与点击历史都只定位，不悄悄改发送
    // 目标。只有拿到这条配置时才渲染这个按钮。
    // The shell's cursor version travels with the directory read, so the write
    // can be conditional: two open pages choosing different targets must not
    // silently overwrite each other (the losing one is told to look again).
    let targetCursor = null;
    const selectTarget = options.selectTarget && typeof options.selectTarget === 'object'
      ? createTargetAction({ ...options.selectTarget, translate,
        cursor: () => targetCursor,
        // Keep the version we hold unless the answer carries a newer one: an
        // unknown cursor must not turn the next write unconditional.
        onCursor: value => { if (Number.isFinite(Number(value))) targetCursor = Number(value); },
        onStale: () => reload() }) : null;
    let open = false;
    try { open = storage?.getItem('multicc:task-index-open') === '1'; } catch (_) {}
    let sortMode = 'order';
    try { sortMode = storage?.getItem('multicc:task-index-sort') === 'code' ? 'code' : 'order'; } catch (_) {}
    let highlighted = null;
    let timer = null;
    let index = null;
    let loading = null;
    let pendingRef = null;
    let signature = '';
    let filterText = '';
    let currentCode = '';
    // 当前阅读位置所在的段（配合 currentCode 定位导航的起点）。
    let currentSegment = -1;
    let targetCode = '';
    // Set by a choice the server already accepted. It wins until the next reload,
    // so a read taken before that write cannot repaint the old target over it.
    let chosenTarget = '';
    let rendered = [];
    let filterBarNode = null;
    let navBarNode = null;
    let emptyNote = null;
    let sampled = false;
    // Search only appears once the directory is long enough to need it, so a
    // three-entry index stays a plain list.
    const MIN_FILTER_ENTRIES = 8;
    // Codes whose anchors could not be located in this conversation. They stay
    // in the directory (the task exists) but must not keep looking live.
    const dead = new Set();

    function isStale(entry) {
      return entry?.stale === true || (entry?.code ? dead.has(entry.code) : false);
    }

    function markDead(entry) {
      if (!entry?.code || dead.has(entry.code)) return;
      dead.add(entry.code);
      render();
    }

    const toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.id = 'task-index-toggle';
    toggle.className = 'task-index-toggle';
    toggle.textContent = '☷';
    toggle.title = translate('taskIndexToggle');
    toggle.setAttribute('aria-label', translate('taskIndexToggle'));
    toggle.setAttribute('aria-expanded', 'false');

    const rail = doc.createElement('aside');
    rail.id = 'task-index-rail';
    rail.className = 'task-index-rail';
    rail.hidden = true;
    rail.setAttribute('aria-label', translate('taskIndexLabel'));

    function clearHighlight() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      highlighted?.classList?.remove('task-index-target');
      highlighted = null;
    }

    function nodeFor(messageId) {
      if (!messageId) return null;
      const found = messages.querySelectorAll?.('.msg[data-msg-id]') || [];
      for (const node of found) if (node?.dataset?.msgId === messageId) return node;
      return null;
    }

    function domEntries() {
      const found = new Map();
      for (const node of messages.querySelectorAll('.msg[data-task-short-code]')) {
        const code = codeOf(node.dataset?.taskShortCode);
        if (!code || found.has(code)) continue;
        found.set(code, { code, node, taskId: text(node.dataset?.taskId).trim(),
          title: text(node.dataset?.taskName).trim(), segments: [], capabilities: {} });
      }
      return [...found.values()].sort((a, b) => a.code.localeCompare(b.code));
    }

    // Server entries keep the conversation order (first appearance) so the list
    // matches scrolling; the DOM fallback keeps its historical code order.
    function serverEntries() {
      const tasks = Array.isArray(index?.tasks) ? index.tasks : [];
      return tasks
        .filter(task => task && (codeOf(task.shortCode) || task.taskId))
        .map(task => ({
          code: codeOf(task.shortCode) || text(task.taskId).slice(-4).toUpperCase(),
          taskId: text(task.taskId).trim(),
          title: text(task.title).trim(),
          segments: Array.isArray(task.segments) ? task.segments : [],
          capabilities: task.capabilities && typeof task.capabilities === 'object' ? task.capabilities : {},
          stale: task.stale === true,
          target: task.target === true,
          node: null,
        }));
    }

    function entries() {
      return index && Array.isArray(index.tasks) ? serverEntries() : domEntries();
    }

    // 「按 4 字 ID 排序」只改呈现顺序，不改目录内容；默认仍是对话顺序，因为
    // 它对应滚动位置。
    function ordered() {
      const list = entries();
      return sortMode === 'code' ? [...list].sort((a, b) => a.code.localeCompare(b.code)) : list;
    }

    function matches(entry) {
      const needle = filterText.trim().toLowerCase();
      return !needle || `${entry.code} ${entry.title}`.toLowerCase().includes(needle);
    }

    // Filtering hides rows in place instead of rebuilding the rail: removing the
    // focused input from the document (which a re-render would do) blurs it, and
    // a directory you cannot type in would be worse than no search at all.
    function applyFilter() {
      let shown = 0;
      for (const item of rendered) {
        const keep = matches(item.entry);
        item.row.hidden = !keep;
        if (keep) shown += 1;
      }
      if (emptyNote) emptyNote.hidden = shown > 0;
      updateNav();
    }

    function activate(node) {
      if (!node) return false;
      clearHighlight();
      highlighted = node;
      highlighted.classList.add('task-index-target');
      highlighted.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      timer = setTimeout(clearHighlight, 3200);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return true;
    }

    function locate(entry, segment) {
      const ref = segment?.firstMessageRef || entry?.segments?.[0]?.firstMessageRef || null;
      const direct = entry?.node || nodeFor(refId(ref));
      if (direct) { pendingRef = null; return activate(direct); }
      if (!ref || !navigate) { markDead(entry); onMissing?.(entry); return false; }
      pendingRef = ref;
      let result;
      try { result = navigate(ref, entry); }
      catch (_) { pendingRef = null; markDead(entry); onMissing?.(entry); return false; }
      // The host paginates asynchronously: a jump into unloaded history only
      // proves it landed once the fetch says so. Reporting "missing" here is
      // what turns a silent dead click into something the user can understand.
      if (result && typeof result.then === 'function') {
        const attempt = pendingRef;
        void Promise.resolve(result).then(ok => {
          if (ok !== false) return;
          if (pendingRef === attempt) pendingRef = null;
          markDead(entry);
          onMissing?.(entry);
        }).catch(() => {
          if (pendingRef === attempt) pendingRef = null;
          markDead(entry);
          onMissing?.(entry);
        });
      } else if (result === false) {
        pendingRef = null;
        markDead(entry);
        onMissing?.(entry);
        return false;
      }
      return true;
    }

    // The search box is built once per directory change and is only ever
    // re-inserted as part of a fresh row set, never on a keystroke.
    function filterBar() {
      if (filterBarNode) return filterBarNode;
      const bar = doc.createElement('div');
      bar.className = 'task-index-filters';
      const input = doc.createElement('input');
      input.type = 'search';
      input.className = 'task-index-search';
      input.value = filterText;
      input.placeholder = translate('taskIndexSearch');
      input.setAttribute('aria-label', translate('taskIndexSearch'));
      input.oninput = event => { filterText = text(event?.target?.value ?? input.value); applyFilter(); };
      const sort = doc.createElement('button');
      sort.type = 'button';
      sort.className = 'task-index-sort';
      sort.textContent = '⇅';
      sort.dataset.sort = sortMode;
      sort.title = translate(sortMode === 'code' ? 'taskIndexSortCode' : 'taskIndexSortOrder');
      sort.setAttribute('aria-label', sort.title);
      sort.setAttribute('aria-pressed', String(sortMode === 'code'));
      sort.onclick = () => {
        sortMode = sortMode === 'code' ? 'order' : 'code';
        try { storage?.setItem('multicc:task-index-sort', sortMode); } catch (_) {}
        sort.dataset.sort = sortMode;
        sort.title = translate(sortMode === 'code' ? 'taskIndexSortCode' : 'taskIndexSortOrder');
        sort.setAttribute('aria-label', sort.title);
        sort.setAttribute('aria-pressed', String(sortMode === 'code'));
        render();
      };
      bar.append(input, sort);
      filterBarNode = bar;
      return bar;
    }

    // 上一段 / 下一段：按当前显示顺序（筛选与排序都算数）在「段」之间移动。
    // 它只做定位——滚动正文、高亮那一段——绝不移动输入游标。
    function segmentSteps() {
      const steps = [];
      for (const item of rendered) {
        if (item.row.hidden === true) continue;
        (item.entry.segments || []).forEach((segment, position) => steps.push({ entry: item.entry, segment, position }));
      }
      return steps;
    }

    function currentStep(steps) {
      if (!currentCode) return -1;
      const exact = steps.findIndex(step => step.entry.code === currentCode && step.position === currentSegment);
      return exact >= 0 ? exact : steps.findIndex(step => step.entry.code === currentCode);
    }

    function updateNav() {
      if (!navBarNode) return;
      const steps = segmentSteps();
      const at = currentStep(steps);
      navBarNode.children[0].disabled = !(at > 0);
      navBarNode.children[2].disabled = at < 0 ? steps.length === 0 : at >= steps.length - 1;
      navBarNode.children[1].textContent = `${at < 0 ? '-' : at + 1}/${steps.length}`;
    }

    function stepSegment(delta) {
      const steps = segmentSteps();
      const at = currentStep(steps);
      const next = at < 0 ? (delta > 0 ? 0 : -1) : at + delta;
      if (next < 0 || next >= steps.length) return false;
      const step = steps[next];
      const item = rendered.find(value => value.entry.code === step.entry.code);
      if (item) item.segment = step.position;
      currentCode = step.entry.code;
      currentSegment = step.position;
      applyCurrent();
      updateNav();
      return locate(step.entry, step.segment) !== false;
    }

    // 只有当真有一项拥有多段时才渲染（DOM 回退模式没有段边界，不会出现它）；
    // 一行一段的目录里「下一段」和点下一行是同一件事，加按钮只是噪音。
    function navBar() {
      if (navBarNode) return navBarNode;
      const bar = doc.createElement('div');
      bar.className = 'task-index-nav';
      const step = (name, label) => {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'task-index-step';
        button.dataset.step = name;
        button.textContent = name === 'prev' ? '‹' : '›';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.onclick = () => { stepSegment(name === 'prev' ? -1 : 1); };
        return button;
      };
      const position = doc.createElement('span');
      position.className = 'task-index-segpos';
      bar.append(step('prev', translate('taskIndexPrevSegment')), position,
        step('next', translate('taskIndexNextSegment')));
      navBarNode = bar;
      return bar;
    }

    function buildRow(entry) {
      const row = doc.createElement('div');
      row.className = 'task-index-row';
      // A task whose history was trimmed or whose anchors were deleted still
      // belongs in the directory, but its row must not look like a live one.
      if (isStale(entry)) row.dataset.stale = 'true';
      // `targetCode` already folds in the server's answer and the local choice.
      const isTarget = !!entry.code && !!targetCode && entry.code === targetCode;
      if (isTarget) row.dataset.target = 'true';
      const button = doc.createElement('button');
      button.type = 'button'; button.className = 'task-index-item';
      button.textContent = entry.code;
      button.title = entry.title ? `${entry.code} · ${entry.title}` : entry.code;
      button.setAttribute('aria-label', button.title);
      button.onclick = () => locate(entry, null);
      row.append(button);
      let strip = null;
      if (entry.segments.length > 1) {
        strip = doc.createElement('span');
        strip.className = 'task-index-segments';
        entry.segments.forEach((segment, position) => {
          const dot = doc.createElement('button');
          dot.type = 'button'; dot.className = 'task-index-segment';
          dot.textContent = '·';
          dot.title = translate('taskIndexSegmentLabel').replace('{n}', String(position + 1));
          dot.setAttribute('aria-label', `${entry.code} ${dot.title}`);
          dot.onclick = event => { event.stopPropagation?.(); locate(entry, segment); };
          strip.append(dot);
        });
        row.append(strip);
      }
      if (entry.taskId && selectTarget && entry.capabilities?.canSelectTarget !== false) {
        if (isTarget) {
          const mark = doc.createElement('span');
          mark.className = 'task-index-target-mark';
          mark.textContent = '◎';
          mark.title = translate('taskIndexIsTarget').replace('{code}', entry.code);
          mark.setAttribute('aria-label', mark.title);
          row.append(mark);
        } else {
          const action = doc.createElement('button');
          action.type = 'button'; action.className = 'task-index-select';
          action.textContent = '◎';
          action.title = translate('taskIndexSetTarget');
          action.setAttribute('aria-label', `${translate('taskIndexSetTarget')} ${entry.code}`);
          action.onclick = event => { event.stopPropagation(); void chooseTarget(entry); };
          row.append(action);
        }
      }
      if (entry.taskId && detach && entry.capabilities?.canDetach !== false) {
        const action = doc.createElement('button');
        action.type = 'button'; action.className = 'task-index-detach';
        action.textContent = '⤴';
        action.title = translate('taskIndexDetach');
        action.setAttribute('aria-label', `${translate('taskIndexDetach')} ${entry.code}`);
        action.onclick = event => { event.stopPropagation(); void detach(entry); };
        row.append(action);
      }
      return { row, entry, strip, segment: -1 };
    }

    async function chooseTarget(entry) {
      // The action reports its own failure; a failed choice must leave the
      // previous target (and the row that shows it) untouched.
      if (await selectTarget(entry) === false) return;
      chosenTarget = entry.code;
      targetCode = chosenTarget;
      render();
    }

    // Which segment of a task the reader is inside: the last of its anchors that
    // is already above the reading line. Anchors that are not loaded (or were
    // deleted) simply cannot win, so the highlight never jumps to a hidden one.
    function segmentIndexAt(entry, lineY) {
      let index = -1;
      (entry?.segments || []).forEach((segment, position) => {
        const node = nodeFor(refId(segment.firstMessageRef));
        const rect = typeof node?.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
        if (rect && Number.isFinite(rect.top) && rect.top <= lineY) index = position;
      });
      return index;
    }

    function applyCurrent() {
      if (!rendered.length) return;
      for (const item of rendered) {
        const isCurrent = !!currentCode && item.entry.code === currentCode;
        item.row.classList[isCurrent ? 'add' : 'remove']('task-index-current');
        if (!item.strip) continue;
        [...(item.strip.children || [])].forEach((dot, position) => {
          dot.classList[isCurrent && position === item.segment ? 'add' : 'remove']('task-index-current');
        });
      }
    }

    function sampleCurrent() {
      if (!open || rail.hidden || !rendered.length) return;
      const rect = typeof messages.getBoundingClientRect === 'function' ? messages.getBoundingClientRect() : null;
      const lineY = rect && Number.isFinite(rect.top) && Number.isFinite(rect.height)
        ? rect.top + rect.height * 0.34 : (Number(root.innerHeight) || 0) * 0.34;
      const nodes = messages.querySelectorAll?.('.msg[data-task-short-code]') || [];
      const code = currentCodeAt(nodes, lineY);
      if (!code) return;
      currentCode = code;
      const item = rendered.find(value => value.entry.code === code);
      if (item) item.segment = segmentIndexAt(item.entry, lineY);
      currentSegment = item ? item.segment : -1;
      applyCurrent();
      updateNav();
    }

    function scheduleSample() {
      if (sampled) return;
      sampled = true;
      const run = () => { sampled = false; sampleCurrent(); };
      if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(run);
      else setTimeout(run, 120);
    }

    function render() {
      const all = ordered();
      const list = all;
      const showFilters = all.length >= MIN_FILTER_ENTRIES;
      const showNav = list.some(entry => (entry.segments || []).length > 1);
      const next = JSON.stringify([sortMode, showFilters, targetCode, list.map(entry => [entry.code, entry.taskId, entry.title,
        isStale(entry), entry.target === true, entry.capabilities?.canDetach === true,
        entry.capabilities?.canSelectTarget === true, entry.segments.length])]);
      if (next !== signature) {
        signature = next;
        const serverTarget = all.find(entry => entry.target === true);
        targetCode = chosenTarget || serverTarget?.code || '';
        rendered = list.map(buildRow);
        const nodes = rendered.map(item => item.row);
        if (showFilters) {
          nodes.unshift(filterBar());
          emptyNote = doc.createElement('div');
          emptyNote.className = 'task-index-empty';
          emptyNote.textContent = translate('taskIndexNoMatch');
          emptyNote.hidden = true;
          nodes.push(emptyNote);
        } else emptyNote = null;
        // `order:-2` puts the nav above the filters on screen; inserting it in
        // the same order keeps the document and the layout telling one story.
        if (showNav) nodes.unshift(navBar());
        rail.replaceChildren(...nodes);
      }
      toggle.hidden = all.length === 0;
      rail.hidden = !open || all.length === 0;
      toggle.setAttribute('aria-expanded', String(!rail.hidden));
      applyFilter();
      applyCurrent();
      if (!rail.hidden) sampleCurrent();
      updateNav();
    }

    function reload() {
      if (!loadIndex) return null;
      if (loading) return loading;
      loading = Promise.resolve().then(loadIndex).then(value => {
        if (value && Array.isArray(value.tasks)) {
          index = value;
          targetCursor = Number.isFinite(Number(value.cursorVersion)) ? Number(value.cursorVersion) : null;
          // A fresh read is authoritative again: whatever it says about the
          // shell's input cursor replaces the local choice that asked for it.
          chosenTarget = '';
          render();
        }
        return value;
      }).catch(() => null).finally(() => { loading = null; });
      return loading;
    }

    toggle.onclick = () => {
      open = !open;
      try { storage?.setItem('multicc:task-index-open', open ? '1' : '0'); } catch (_) {}
      if (open) void reload();
      render();
    };
    doc.body.append(toggle, rail);
    // 滚动高亮当前段：滚动本身不改归属、不改发送目标，只是让目录跟着正文走。
    messages.addEventListener?.('scroll', scheduleSample, { passive: true });
    const Observer = root.MutationObserver;
    const observer = typeof Observer === 'function' ? new Observer(() => {
      if (pendingRef) {
        const node = nodeFor(refId(pendingRef));
        if (node) { pendingRef = null; activate(node); }
      }
      render();
    }) : null;
    observer?.observe(messages, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-task-short-code', 'data-task-id', 'data-task-name', 'data-msg-id'] });
    render();
    if (open) void reload();

    return Object.freeze({
      refresh: render,
      reload,
      dispose() {
        observer?.disconnect();
        messages.removeEventListener?.('scroll', scheduleSample);
        clearHighlight(); toggle.remove(); rail.remove();
      },
      toggle() { toggle.click(); },
      focusCode(code) {
        const value = entries().find(entry => entry.code === codeOf(code));
        return locate(value, null);
      },
      // Called by the host once an anchor fetched through history pagination is
      // in the DOM, so a jump to an unloaded turn still lands and highlights.
      markLocated(messageId) {
        const node = nodeFor(messageId);
        if (!node) return false;
        pendingRef = null;
        return activate(node);
      },
      isOpen: () => open,
      index: () => index,
    });
  }

  // Fork action for one index entry. The operation id is minted once per
  // attempt and reused on retry, so a lost response cannot create a duplicate
  // copy; the server dedupes on the same clientMsgId.
  function createDetachAction({ request, openUrl, confirm, alert, translate = key => key }) {
    const attempts = new Map();
    return async function detach(entry) {
      const taskId = text(entry?.taskId).trim();
      if (!taskId) return false;
      const code = codeOf(entry?.code) || taskId.slice(-4).toUpperCase();
      if (typeof confirm === 'function'
        && !(await confirm(translate('taskIndexDetachConfirm').replace('{code}', code), { okText: translate('taskIndexDetach') }))) return false;
      let clientMsgId = attempts.get(taskId);
      if (!clientMsgId) {
        clientMsgId = `index-${taskId}-${Date.now().toString(36)}`;
        attempts.set(taskId, clientMsgId);
      }
      try {
        const result = await request(`/api/task-shell-tasks/${encodeURIComponent(taskId)}/fork`, { clientMsgId });
        attempts.delete(taskId);
        const url = text(result?.url) || (result?.taskId ? `/air?task=${encodeURIComponent(result.taskId)}` : '');
        if (url) {
          if (typeof openUrl !== 'function' || !openUrl(url)) {
            alert?.(translate('taskIndexDetachOpen').replace('{url}', url));
          }
        }
        return true;
      } catch (error) {
        // The attempt id is intentionally kept for retry, so a response lost in
        // transit resolves to the same server-side operation instead of a copy.
        alert?.(translate('taskIndexDetachFailed').replace('{error}', text(error?.message || error)));
        return false;
      }
    };
  }

  // Explicit "the next message goes to this task". Separate from locate(): the
  // click that scrolls history must never move the input cursor by accident.
  function createTargetAction({ shellId, request, notify, alert, translate = key => key, cursor, onCursor, onStale }) {
    return async function selectTarget(entry) {
      const taskId = text(entry?.taskId).trim();
      if (!taskId || !request) return false;
      const id = text(typeof shellId === 'function' ? shellId() : shellId);
      if (!id) { alert?.(translate('taskAttributionNoShell')); return false; }
      try {
        const known = typeof cursor === 'function' ? cursor() : null;
        // Only a page that read the directory may make a conditional write; a
        // caller without that read keeps the unconditional contract.
        const result = await request(`/api/task-shells/${encodeURIComponent(id)}/select-target`,
          known == null ? { taskId } : { taskId, expectedCursorVersion: known });
        onCursor?.(result?.cursorVersion);
        notify?.(entry, result);
        return true;
      } catch (error) {
        // Someone moved the target first. That is not a failure of the choice:
        // read the directory again so the page shows the real current target,
        // and say so — a silent overwrite is what the server refused.
        if (text(error?.code) === 'stale_shell_cursor' && typeof onStale === 'function') {
          await onStale();
          alert?.(translate('taskIndexTargetStale'));
          return false;
        }
        alert?.(translate('taskIndexTargetFailed').replace('{error}', text(error?.message || error)));
        return false;
      }
    };
  }
  const api = { createController, createDetachAction, createAnchorJump, createTargetAction, currentCodeAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MultiCCTaskIndex = api;
})(typeof window !== 'undefined' ? window : globalThis);
