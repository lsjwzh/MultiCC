'use strict';
(() => {
  const form = document.getElementById('route-form');
  const fields = form.elements;
  const status = document.getElementById('status');
  function mode() { document.getElementById('public-risk').hidden = fields.access.value !== 'public'; fields.ack.required = fields.access.value === 'public'; }
  async function api(path = '', method = 'GET', body) {
    const response = await fetch('/api/service-routes' + path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (response.status === 401 || response.redirected) { location.href = '/login?redirect=' + encodeURIComponent(location.pathname); throw new Error('请先登录'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '操作失败');
    return result;
  }
  function reset() { fields.name.readOnly = false; document.getElementById('form-title').textContent = '添加路由'; setTimeout(mode, 0); }
  async function load() {
    const { routes } = await api();
    const list = document.getElementById('routes'); list.replaceChildren();
    if (!routes.length) list.textContent = '尚未配置路由。';
    for (const route of routes) {
      const row = document.createElement('article');
      const link = document.createElement('a'); link.href = '/services/' + route.name + '/'; link.textContent = link.pathname; link.target = '_blank'; link.rel = 'noopener';
      const info = document.createElement('p'); info.textContent = `${route.target} · ${route.access === 'public' ? '⚠ 免密码公开' : 'MultiCC 鉴权'} · ${route.enabled ? '已启用' : '已停用'}`;
      const edit = document.createElement('button'); edit.textContent = '编辑 / 停用'; edit.onclick = () => {
        fields.name.value = route.name; fields.name.readOnly = true; fields.target.value = route.target; fields.access.value = route.access; fields.enabled.checked = route.enabled; fields.ack.checked = false; mode(); document.getElementById('form-title').textContent = '编辑路由'; form.scrollIntoView({ behavior: 'smooth' });
      };
      const del = document.createElement('button'); del.textContent = '删除'; del.onclick = async () => {
        if (!confirm('删除路由 ' + route.name + '？')) return;
        try { await api('/' + route.name, 'DELETE'); await load(); status.textContent = '路由已删除。'; } catch (err) { status.textContent = err.message; }
      };
      row.append(link, info, edit, del); list.append(row);
    }
  }
  fields.access.onchange = () => { fields.ack.checked = false; mode(); };
  form.onreset = reset;
  form.onsubmit = async event => {
    event.preventDefault();
    try {
      await api('/' + fields.name.value, 'PUT', { target: fields.target.value, access: fields.access.value, enabled: fields.enabled.checked, acknowledgePublicRisk: fields.ack.checked });
      form.reset(); await load(); status.textContent = '已保存，路由配置立即生效。';
    } catch (err) { status.textContent = err.message; }
  };
  mode(); load().catch(err => { status.textContent = err.message; });
})();
