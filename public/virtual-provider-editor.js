'use strict';
(function (root) {
  const doc = root.document;
  const node = (tag, text, className) => {
    const el = doc.createElement(tag); if (text) el.textContent = text;
    if (className) el.className = className; return el;
  };
  function open({ provider, providers, api, onSaved }) {
    const dialog = node('dialog', '', 'provider-dialog service-dialog');
    dialog.setAttribute('aria-label', '虚拟 Provider');
    dialog.style.cssText = 'width:min(680px,94vw);max-height:90dvh;overflow:auto';
    const form = node('form');
    const title = node('h2', provider ? '编辑虚拟 Provider' : '新建虚拟 Provider');
    const heading = node('div'); heading.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px';
    const close = node('button', '×'); close.type = 'button'; close.setAttribute('aria-label', '关闭'); close.onclick = () => dialog.close();
    heading.append(title, close);
    const intro = node('p', '将同一 CLI 下模型兼容的线路组合成一个可分享的入口。自动记录可获取的余量，跳过已耗尽或已到期成员；接收方无需重新导入。未知余量会尝试使用，未开始返回内容的明确拒绝才会切换。');
    const name = node('input'); name.name = 'name'; name.required = true; name.maxLength = 120;
    name.value = provider?.name || ''; name.placeholder = '例如：团队 Codex 组合';
    const nameLabel = node('label', '组合名称'); nameLabel.append(name);
    const cli = node('select'); cli.name = 'appType';
    for (const value of ['claude', 'codex']) { const o = node('option', value === 'claude' ? 'Claude' : 'Codex'); o.value = value; cli.append(o); }
    cli.value = provider?.appType || 'claude'; cli.disabled = !!provider;
    const cliLabel = node('label', 'CLI'); cliLabel.append(cli);
    const strategy = node('select'); strategy.name = 'strategy';
    for (const [value, label] of [['expiry', '优先使用即将到期的线路'], ['ordered', '按成员顺序使用']]) {
      const o = node('option', label); o.value = value; strategy.append(o);
    }
    strategy.value = provider?.virtual?.strategy || 'expiry';
    const strategyLabel = node('label', '选择策略'); strategyLabel.append(strategy);
    const hint = node('p', '到期时间可选，表示停止使用该线路的时间。官方账号会显示服务方提供的续费日期；额度重置时间不会被当作续费日期。');
    const list = node('div', '', 'virtual-provider-members');
    const error = node('p'); error.setAttribute('role', 'alert');
    const actions = node('div', '', 'schedule-form-actions');
    const cancel = node('button', '取消'); cancel.type = 'button'; cancel.onclick = () => dialog.close();
    const save = node('button', '保存组合', 'primary'); save.type = 'submit';
    actions.append(cancel, save);
    let members = (provider?.virtual?.members || []).map(m => ({ ...m }));
    function render() {
      list.replaceChildren();
      const candidates = providers.filter(p => p.appType === cli.value && !p.virtual);
      const ordered = [...members.map(m => candidates.find(p => p.id === m.id) || { id: m.id, name: '已删除的成员' }),
        ...candidates.filter(p => !members.some(m => m.id === p.id))];
      if (!ordered.length) list.append(node('p', '还没有可组合的线路，请先添加 API Key 或官方账号。'));
      for (const p of ordered) {
        const row = node('div'); row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 0;border-bottom:1px solid var(--border,#444)';
        const selected = members.find(m => m.id === p.id);
        const label = node('label'); label.style.cssText = 'display:flex;flex-direction:row;align-items:center;gap:8px;flex:1;min-width:150px';
        const check = node('input'); check.type = 'checkbox'; check.checked = !!selected;
        check.style.cssText = 'width:18px;height:18px;flex:0 0 18px;margin:0';
        check.dataset.memberId = p.id;
        label.append(check, doc.createTextNode(` ${p.name}`));
        check.onchange = () => { members = check.checked ? [...members, { id: p.id, expiresAt: null }] : members.filter(m => m.id !== p.id); render(); };
        const date = node('input'); date.type = 'datetime-local'; date.disabled = !selected;
        date.setAttribute('aria-label', `${p.name} 到期时间`); date.style.width = '195px';
        if (selected?.expiresAt) {
          const d = new Date(selected.expiresAt); date.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        }
        date.onchange = () => { if (selected) selected.expiresAt = date.value ? new Date(date.value).getTime() : null; };
        row.append(label, date);
        if (selected) for (const [delta, text] of [[-1, '↑'], [1, '↓']]) {
          const move = node('button', text); move.type = 'button'; move.setAttribute('aria-label', `${text === '↑' ? '上移' : '下移'} ${p.name}`);
          const i = members.indexOf(selected); move.disabled = i + delta < 0 || i + delta >= members.length;
          move.onclick = () => { [members[i], members[i + delta]] = [members[i + delta], members[i]]; render(); };
          row.append(move);
        }
        const detail = node('small', root.QuotaBarView?.resolveProviderLimit(p.limit)?.text || p.limit?.summaryText || '余量未知'); detail.style.cssText = 'flex-basis:100%;color:var(--muted)';
        if (p.subscription?.nextBillingAt) detail.append(doc.createTextNode(` · 下次续费 ${new Date(p.subscription.nextBillingAt).toLocaleDateString()}`));
        row.append(detail); list.append(row);
      }
    }
    cli.onchange = () => { members = []; render(); };
    form.onsubmit = async event => {
      event.preventDefault(); error.textContent = ''; save.disabled = true;
      try {
        const body = { name: name.value.trim(), virtual: { strategy: strategy.value, members } };
        if (!provider) body.appType = cli.value;
        await api(provider ? `/api/providers/${provider.appType}/${encodeURIComponent(provider.id)}` : '/api/providers', body, provider ? 'PATCH' : 'POST');
        dialog.close(); await onSaved?.();
      } catch (e) { error.textContent = e.message || '保存失败'; }
      finally { save.disabled = false; }
    };
    form.append(heading, intro, nameLabel, cliLabel, strategyLabel, hint, list, error, actions);
    dialog.append(form); doc.body.append(dialog); dialog.addEventListener('close', () => dialog.remove(), { once: true });
    render(); dialog.showModal();
  }
  root.MultiCCVirtualProvider = { open };
})(window);
