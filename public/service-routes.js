'use strict';
(() => {
  const form = document.getElementById('route-form');
  const fields = form.elements;
  const routesList = document.getElementById('routes');
  const editor = document.getElementById('editor-panel');
  const status = document.getElementById('status');
  const saveButton = document.getElementById('save-button');
  const cancelButton = document.getElementById('cancel-button');
  const icons = {
    external: '<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M11 4h5v5M9 11l7-7M16 11v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4"/></svg>',
    edit: '<svg aria-hidden="true" viewBox="0 0 20 20"><path d="m13.5 3.5 3 3-9 9-4 1 1-4 9-9Z"/><path d="m11.5 5.5 3 3"/></svg>',
    delete: '<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M4 6h12M8 3h4l1 3H7l1-3ZM6 6l.7 11h6.6L14 6M8.5 9v5M11.5 9v5"/></svg>',
    empty: '<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M5 4.5h10a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 14V6A1.5 1.5 0 0 1 5 4.5Z"/><path d="M7 8h6M7 11h4"/></svg>',
  };
  let toastTimer;

  function showStatus(message, isError = false) {
    clearTimeout(toastTimer);
    status.textContent = message;
    status.classList.toggle('error', isError);
    status.hidden = false;
    toastTimer = setTimeout(() => { status.hidden = true; }, isError ? 6000 : 3500);
  }

  function mode() {
    const isPublic = fields.access.value === 'public';
    document.getElementById('public-risk').hidden = !isPublic;
    fields.ack.required = isPublic;
  }

  function updatePreview() {
    const name = fields.name.value.trim() || 'my-app';
    document.getElementById('path-preview').textContent = `/services/${name}/`;
  }

  async function api(path = '', method = 'GET', body) {
    const response = await fetch('/api/service-routes' + path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 401 || response.redirected) {
      location.href = '/login?redirect=' + encodeURIComponent(location.pathname);
      throw new Error('请先登录');
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '操作失败');
    return result;
  }

  function resetEditor() {
    fields.name.readOnly = false;
    document.getElementById('form-kicker').textContent = '创建配置';
    document.getElementById('form-title').textContent = '添加新路由';
    saveButton.querySelector('span').textContent = '保存路由';
    cancelButton.hidden = true;
    setTimeout(() => { mode(); updatePreview(); }, 0);
  }

  function beginEdit(route) {
    fields.name.value = route.name;
    fields.name.readOnly = true;
    fields.target.value = route.target;
    fields.access.value = route.access;
    fields.enabled.checked = route.enabled;
    fields.ack.checked = false;
    document.getElementById('form-kicker').textContent = '编辑配置';
    document.getElementById('form-title').textContent = route.name;
    saveButton.querySelector('span').textContent = '保存更改';
    cancelButton.hidden = false;
    mode();
    updatePreview();
    editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => fields.target.focus(), 320);
  }

  function updateStats(routes) {
    document.getElementById('stat-total').textContent = routes.length;
    document.getElementById('stat-active').textContent = routes.filter(route => route.enabled).length;
    document.getElementById('stat-private').textContent = routes.filter(route => route.access === 'private').length;
    document.getElementById('route-count').textContent = `${routes.length} 条路由`;
  }

  function createButton(label, icon, className, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `icon-button ${className || ''}`.trim();
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML = icon;
    button.addEventListener('click', onClick);
    return button;
  }

  function renderRoute(route) {
    const row = document.createElement('article');
    row.className = 'route-card' + (route.enabled ? '' : ' disabled');
    const content = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'route-card-head';
    const state = document.createElement('span');
    state.className = 'route-state';
    state.title = route.enabled ? '已启用' : '已停用';
    const link = document.createElement('a');
    link.className = 'route-link';
    link.href = '/services/' + route.name + '/';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = `/services/${route.name}/`;
    link.insertAdjacentHTML('beforeend', icons.external);
    const badge = document.createElement('span');
    badge.className = 'badge' + (route.access === 'public' ? ' public' : '');
    badge.textContent = route.access === 'public' ? '公开' : '鉴权保护';
    head.append(state, link, badge);
    const targetLabel = document.createElement('span');
    targetLabel.className = 'route-target-label';
    targetLabel.textContent = '上游地址';
    const target = document.createElement('code');
    target.className = 'route-target';
    target.textContent = route.target;
    target.title = route.target;
    content.append(head, targetLabel, target);

    const actions = document.createElement('div');
    actions.className = 'route-actions';
    const edit = createButton(`编辑 ${route.name}`, icons.edit, '', () => beginEdit(route));
    const remove = createButton(`删除 ${route.name}`, icons.delete, 'danger', async () => {
      if (!confirm('删除路由 ' + route.name + '？此操作无法撤销。')) return;
      remove.disabled = true;
      try {
        await api('/' + route.name, 'DELETE');
        if (fields.name.readOnly && fields.name.value === route.name) form.reset();
        await load();
        showStatus(`路由 ${route.name} 已删除。`);
      } catch (err) {
        remove.disabled = false;
        showStatus(err.message, true);
      }
    });
    actions.append(edit, remove);
    row.append(content, actions);
    return row;
  }

  async function load() {
    routesList.setAttribute('aria-busy', 'true');
    const { routes } = await api();
    routesList.replaceChildren();
    updateStats(routes);
    if (!routes.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = `<div><span class="empty-state-icon">${icons.empty}</span><h3>还没有服务路由</h3><p>创建第一条路由，将本机服务接入统一入口。</p></div>`;
      routesList.append(empty);
    } else {
      routes.forEach(route => routesList.append(renderRoute(route)));
    }
    routesList.setAttribute('aria-busy', 'false');
  }

  document.getElementById('add-route-btn').addEventListener('click', () => {
    form.reset();
    editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => fields.name.focus(), 320);
  });
  fields.name.addEventListener('input', updatePreview);
  fields.access.addEventListener('change', () => { fields.ack.checked = false; mode(); });
  form.addEventListener('reset', resetEditor);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    saveButton.disabled = true;
    const name = fields.name.value;
    try {
      await api('/' + name, 'PUT', {
        target: fields.target.value,
        access: fields.access.value,
        enabled: fields.enabled.checked,
        acknowledgePublicRisk: fields.ack.checked,
      });
      form.reset();
      await load();
      showStatus(`路由 ${name} 已保存并立即生效。`);
    } catch (err) {
      showStatus(err.message, true);
    } finally {
      saveButton.disabled = false;
    }
  });

  mode();
  updatePreview();
  load().catch(err => {
    routesList.setAttribute('aria-busy', 'false');
    routesList.replaceChildren();
    updateStats([]);
    showStatus(err.message, true);
  });
})();
