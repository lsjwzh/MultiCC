'use strict';

// Dialog-local request ownership and stable controls. Rendering never starts a
// request; empty/error results settle, and invalidated requests cannot publish.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCRunConfigControls = api;
})(typeof window !== 'undefined' ? window : null, function () {
  function createCatalogLoader({ request, normalize, onLoaded }) {
    const catalogs = new Map(), errors = new Map(), pending = new Map();
    let generation = 0, closed = false;
    function invalidate() { ++generation; catalogs.clear(); errors.clear(); pending.clear(); }
    function load(cli) {
      if (closed) return Promise.reject(new Error('catalog_closed'));
      if (catalogs.has(cli)) return Promise.resolve(catalogs.get(cli));
      if (errors.has(cli)) return Promise.reject(errors.get(cli));
      if (pending.has(cli)) return pending.get(cli);
      const started = generation;
      const promise = Promise.resolve().then(() => {
        if (closed) throw new Error('catalog_closed');
        return started === generation ? request(cli) : load(cli);
      }).then(raw => {
        if (closed) throw new Error('catalog_closed');
        if (started !== generation) return load(cli);
        const catalog = normalize(raw);
        catalogs.set(cli, catalog);
        onLoaded(catalog);
        return catalog;
      }).catch(error => {
        if (!closed && started !== generation) return load(cli);
        if (!closed) errors.set(cli, error);
        throw error;
      }).finally(() => { if (pending.get(cli) === promise) pending.delete(cli); });
      pending.set(cli, promise);
      return promise;
    }
    return { catalogs, errors, load, invalidate, close() { closed = true; invalidate(); } };
  }

  function text(node, value) { if (node.textContent !== value) node.textContent = value; }
  function setValue(node, value) { if (node.value !== value) node.value = value; }
  function syncChildren(host, nodes) {
    const keep = new Set(nodes);
    for (const child of [...host.children]) if (!keep.has(child)) child.remove();
    nodes.forEach((node, index) => {
      const before = host.children[index] || null;
      if (before === node) return;
      if (host.moveBefore && node.parentNode === host) host.moveBefore(node, before);
      else host.insertBefore(node, before);
    });
  }

  // Reuse option/group nodes, including when a genuine catalog change adds or
  // removes models. Unchanged polling responses perform no child mutations.
  function syncOptions(select, entries) {
    const oldOptions = new Map([...select.options].map(node => [node.value, node]));
    const oldGroups = new Map([...select.children].filter(node => node.tagName === 'OPTGROUP')
      .map(node => [node.label, node]));
    const children = [], groups = new Map();
    for (const entry of entries) {
      const node = oldOptions.get(entry.value) || select.ownerDocument.createElement('option');
      // An explicit empty value differs from an absent value attribute: without
      // it, changing the label also changes the option's submitted value.
      if (node.getAttribute('value') !== entry.value) node.value = entry.value;
      text(node, entry.label);
      if (node.disabled !== !!entry.disabled) node.disabled = !!entry.disabled;
      if (!entry.group) { children.push(node); continue; }
      if (!groups.has(entry.group)) {
        const group = oldGroups.get(entry.group) || select.ownerDocument.createElement('optgroup');
        if (group.label !== entry.group) group.label = entry.group;
        groups.set(entry.group, { node: group, children: [] });
        children.push(group);
      }
      groups.get(entry.group).children.push(node);
    }
    for (const group of groups.values()) syncChildren(group.node, group.children);
    syncChildren(select, children);
  }

  function createModelPicker({ select, custom, search, ai, customLabel }) {
    let binding = null, entries = [], customEdited = false;
    select.addEventListener('change', () => { customEdited = select.value === '__custom__'; });
    custom.addEventListener('input', () => { customEdited = true; });
    function paint(keep) {
      const needle = search.value.trim().toLowerCase();
      syncOptions(select, entries.filter(item => !needle || !item.value
        || item.value === '__custom__' || item.value === keep
        || `${item.label} ${item.value}`.toLowerCase().includes(needle)));
    }
    search.oninput = () => { const keep = select.value; paint(keep); setValue(select, keep); };
    return {
      update(value, cli, preferred, state) {
        const key = JSON.stringify([cli, value]);
        const same = key === binding;
        const editing = same && (customEdited || custom.ownerDocument.activeElement === custom)
          && select.value === '__custom__' && custom.value.trim() === preferred;
        binding = key;
        if (!same) { setValue(search, ''); customEdited = false; }
        let choices = ai.buildModelChoices(value, state);
        choices = [...new Set(Array.isArray(choices) && choices.length ? choices : ['', '__custom__'])];
        entries = choices.map(choice => ({ value: choice,
          label: choice === '__custom__' ? customLabel() : ai.modelChoiceLabel(choice, value, state),
          group: ai.modelChoiceGroup ? ai.modelChoiceGroup(choice, state) : '',
        }));
        search.hidden = !search.value && choices.filter(choice => choice && choice !== '__custom__').length <= 12;
        let wanted = ai.normalizeModel(value, preferred || '', state);
        if (!wanted) wanted = ai.defaultModelChoice(value, state) || '';
        const known = choices.includes(wanted);
        const chosen = editing ? '__custom__' : known ? wanted
          : wanted && choices.includes('__custom__') ? '__custom__' : choices[0];
        paint(chosen);
        setValue(select, chosen);
        if (!editing) setValue(custom, known ? '' : wanted);
        custom.hidden = select.value !== '__custom__';
      },
    };
  }

  // A row's draft object is its identity, so duplicate providers and reordering
  // stay distinct. Event handlers read the latest projection, never an old index.
  function createPoolList({ host, el, mark, tt, onCli, onModel, onCustom, onTier, onRemove, onMove }) {
    const doc = host.ownerDocument, views = new Map();
    let dragged = null;
    function create() {
      const node = el(doc, 'div', 'rc-row'), rank = el(doc, 'span', 'rc-rank');
      node.draggable = true;
      const main = el(doc, 'div', 'rc-row-main'), first = el(doc, 'div', 'rc-row-l1');
      const chip = el(doc, 'span', 'rc-cli-chip'), cli = el(doc, 'select', 'rc-chip rc-row-cli');
      cli.setAttribute('aria-label', tt('runConfigRowCli', '用哪个 CLI 跑这条线路'));
      chip.append(cli);
      const name = el(doc, 'b', 'rc-line-name');
      first.append(chip, name);
      const second = el(doc, 'div', 'rc-row-l2'), issue = el(doc, 'span', 'rc-issue');
      const model = el(doc, 'select', 'rc-select rc-row-model'), custom = el(doc, 'input', 'rc-row-model-custom');
      model.setAttribute('aria-label', tt('runConfigRowModel', '模型'));
      custom.maxLength = 100;
      const tier = el(doc, 'select', 'rc-select rc-row-tier');
      tier.setAttribute('aria-label', tt('runConfigRowTier', '档位'));
      const ops = el(doc, 'span', 'rc-ops'), handle = el(doc, 'button', 'rc-handle', '⠿');
      handle.type = 'button'; handle.title = tt('runConfigRowDrag', '拖动排序');
      const remove = el(doc, 'button', 'rc-remove', '✕');
      remove.type = 'button'; remove.title = tt('runConfigRowRemove', '移除这条线路');
      ops.append(handle, remove); main.append(first, second); node.append(rank, main, ops);
      const view = { node, rank, chip, cli, name, first, second, issue, model, custom, tier, item: null, badge: null, icon: null };
      cli.onchange = () => onCli(view.item.key, cli.value);
      model.onchange = () => { view.customEdited = model.value === '__custom__'; custom.hidden = !view.customEdited; onModel(view.item.key, model.value); };
      custom.oninput = () => { view.customEdited = true; onCustom(view.item.key, custom.value); };
      tier.onchange = () => onTier(view.item.key, tier.value);
      remove.onclick = () => onRemove(view.item.key);
      node.ondragstart = event => { dragged = view.item.key; if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; };
      node.ondragover = event => { event.preventDefault(); node.classList.add('rc-drop'); };
      node.ondragleave = () => node.classList.remove('rc-drop');
      node.ondragend = () => { dragged = null; node.classList.remove('rc-drop'); };
      node.ondrop = event => {
        event.preventDefault(); node.classList.remove('rc-drop');
        if (dragged) onMove(dragged, view.item.key);
        dragged = null;
      };
      return view;
    }
    return {
      update(items) {
        const keys = new Set(items.map(item => item.key));
        for (const [key, view] of views) if (!keys.has(key)) { view.node.remove(); views.delete(key); }
        const nodes = items.map((item, index) => {
          const view = views.get(item.key) || create();
          views.set(item.key, view);
          const same = view.item && view.item.cli === item.cli;
          const editing = same && (view.customEdited || doc.activeElement === view.custom)
            && view.model.value === '__custom__' && view.custom.value.trim() === item.wanted;
          if (!same) view.customEdited = false;
          view.item = item;
          view.node.dataset.providerId = item.id; view.node.dataset.cli = item.cli;
          text(view.rank, String(index + 1)); text(view.name, item.name);
          if (!same) { view.icon?.remove(); view.icon = mark(doc, item.cli, 's'); view.chip.insertBefore(view.icon, view.cli); }
          syncOptions(view.cli, item.clis); setValue(view.cli, item.cli);
          if (view.cli.title !== item.cliTitle) view.cli.title = item.cliTitle;
          if (item.badge) {
            if (!view.badge) { view.badge = item.badge; view.first.append(view.badge); }
            else { text(view.badge, item.badge.textContent); view.badge.title = item.badge.title; view.badge.style.cssText = item.badge.style.cssText; }
          } else { view.badge?.remove(); view.badge = null; }
          view.node.classList.toggle('rc-warn', !!item.issue);
          if (item.issue) {
            text(view.issue, `⚠ ${item.issue}`); syncChildren(view.second, [view.issue]);
          } else {
            syncOptions(view.model, item.models);
            const known = item.models.some(choice => choice.value === item.wanted);
            const chosen = editing ? '__custom__' : known ? item.wanted : item.wanted ? '__custom__' : item.models[0].value;
            setValue(view.model, chosen);
            if (!editing) setValue(view.custom, known ? '' : item.wanted);
            view.custom.hidden = chosen !== '__custom__';
            syncOptions(view.tier, item.tiers); setValue(view.tier, item.tier);
            syncChildren(view.second, [view.model, view.custom, ...(item.tiers.length ? [view.tier] : [])]);
          }
          return view.node;
        });
        const scroll = host.scrollTop;
        syncChildren(host, nodes);
        host.scrollTop = scroll;
      },
    };
  }

  function createSubagentSummaries({ tt, clean, subagentFamilyLabel }) {
    // 同步预览（dry run）→ 状态行文案。preview 的形状：
    //   { state:'loading' }
    //   { state:'ready', family, counts:{applied,deferred,unchanged,skipped,kept} }
    //   { state:'error', error }
    //   { state:'unavailable' }   ← 503：服务端加载的原生模块还是旧的，没有同步接口
    // 只产出 {tone, text}，不碰 DOM —— tests/test-run-config.js 直接调。
    function syncSummary(preview) {
      if (!preview || typeof preview !== 'object') return { tone: 'idle', text: '' };
      if (preview.state === 'loading') {
        return { tone: 'loading', text: tt('runConfigSyncChecking', '正在检查要更新的任务…') };
      }
      if (preview.state === 'error') {
        return { tone: 'error', text: tt('runConfigSyncPreviewFailed', '无法读取同步预览：{error}', { error: clean(preview.error) }) };
      }
      if (preview.state === 'unavailable') {
        return { tone: 'error', text: tt('runConfigSyncUnavailable', '服务端加载的原生模块是旧版本，暂不支持同步。重启一次 MultiCC 会自动按当前代码重新编译加载，之后改这个设置不需要再重启。') };
      }
      const counts = preview.counts && typeof preview.counts === 'object' ? preview.counts : {};
      const applied = Number(counts.applied) || 0;
      const deferred = Number(counts.deferred) || 0;
      const skipped = Number(counts.skipped) || 0;
      const kept = Number(counts.kept) || 0;
      const total = applied + deferred;
      // 单独设置过子 agent 的任务同步不碰：单独说一句，免得以为漏了。
      const suffix = (kept > 0 ? tt('runConfigSyncKeptSuffix', '，{k} 个单独设置过的保持不变', { k: kept }) : '')
        + (skipped > 0 ? tt('runConfigSyncSkippedSuffix', '，{k} 个跳过', { k: skipped }) : '');
      if (total > 0) {
        return {
          tone: 'ready',
          text: (total === 1
            ? tt('runConfigSyncPreviewOne', '将更新 1 个任务')
            : tt('runConfigSyncPreview', '将更新 {n} 个任务', { n: total })) + suffix,
        };
      }
      return {
        tone: 'ready',
        text: tt('runConfigSyncNothing', '没有需要更新的 {cli} 任务',
          { cli: subagentFamilyLabel(preview.family) || '' }) + suffix,
      };
    }

    // 清除全局默认前的确认文案（清除的 dry run 计数）：恢复随主的是跟随全局的任务。
    function clearSummary(preview) {
      const counts = preview && preview.counts && typeof preview.counts === 'object' ? preview.counts : {};
      return tt('runConfigClearPreview', '清除后 {n} 个跟随全局的 {cli} 任务恢复随主，新建任务也不再默认使用；单独设置过的 {k} 个不受影响。', {
        n: (Number(counts.applied) || 0) + (Number(counts.deferred) || 0), k: Number(counts.kept) || 0,
        cli: subagentFamilyLabel(preview && preview.family) || '' });
    }

    return { syncSummary, clearSummary };
  }

  return Object.freeze({ createCatalogLoader, createModelPicker, createPoolList, createSubagentSummaries, syncOptions });
});
