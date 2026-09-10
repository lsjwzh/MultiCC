(function () {
  'use strict';
  const $ = id => document.getElementById(id), params = new URLSearchParams(location.search);
  let data, directoryId = params.get('dir'), taskId = params.get('task'), entry, mode = 'tasks', timer, epoch = 0, stopped = false, loading = false;
  const stored = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (_) { return fallback; } };
  let favorites = stored('air:favorites', []); if (!Array.isArray(favorites)) favorites = [];
  const stateNames = { active: '进行中', succeeded: '本轮成功', unknown: '结果待核验', failed: '执行失败', cancelled: '已取消', workspace_execution_capacity: '等待执行名额', workspace_resident_capacity: '等待目录容量', workspace_restore_capacity: '等待目录准备名额', planned: '执行时准备目录', resident: '目录已准备', retained: '目录已保留', hibernated: '目录已休眠', reserved: '准备执行', materializing: '正在准备目录', starting: '正在启动', running: '执行中', uncertain: '等待核实执行状态', idle: '空闲', queued: '排队中', waiting: '等待回复', inbox: '待处理', doing: '进行中', done: '已完成', archived: '已归档' };
  const label = x => stateNames[x] || x || '';
  async function api(path, body) { const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const result = await response.json(); if (!response.ok || result.ok === false) throw new Error(result.message || result.error || result.code || `HTTP ${response.status}`); return result; }
  function node(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; }
  function notice(text = '') { $('notice').textContent = text; }
  function saveDraft() { const doc = $('conversation').contentDocument, input = doc?.getElementById('message'); if (taskId && input) sessionStorage.setItem(`air:draft:${taskId}`, input.value); }
  function navigate(dir, task = null) { saveDraft(); directoryId = dir; taskId = task; mode = 'tasks'; entry = null; history.pushState({}, '', '/air?' + new URLSearchParams({ ...(dir ? { dir } : {}), ...(task ? { task } : {}) })); document.body.classList.remove('nav-open'); render(); void refreshEntry(); }
  function resourceText(r) { if (r?.capacityReason) return label(r.capacityReason); return r?.lease && r.lease !== 'idle' ? label(r.lease) : label(r?.residency); }
  function renderDirectories() {
    const search = $('directory-search').value.toLowerCase();
    $('directory-grid').replaceChildren(...data.directories.filter(d => `${d.name} ${d.path}`.toLowerCase().includes(search)).map(d => { const button = node('button'); button.append(node('strong', '▱ ' + d.name), node('small', d.path), node('small', `${data.tasks.filter(t => t.dirId === d.id).length} 个任务`)); button.onclick = () => navigate(d.id); return button; }));
  }
  function render() {
    if (!data) return;
    if (!directoryId && taskId) directoryId = data.tasks.find(t => t.id === taskId)?.dirId;
    if (!directoryId || !data.directories.some(d => d.id === directoryId)) directoryId = data.directories[0]?.id || null;
    const dir = data.directories.find(d => d.id === directoryId);
    $('directory-name').textContent = dir?.name || '先添加工作目录'; $('directory-path').textContent = dir?.path || '';
    $('create').disabled = !dir; $('favorite').textContent = favorites.includes(directoryId) ? '★' : '☆';
    $('favorites').replaceChildren(...data.directories.filter(d => favorites.includes(d.id)).slice(0, 5).map(d => { const b = node('button', '▱ ' + d.name, d.id === directoryId ? 'selected' : ''); b.onclick = () => navigate(d.id); return b; }));
    $('directory-library').hidden = mode !== 'library'; $('task-layout').hidden = mode === 'library'; renderDirectories();
    const search = $('task-search').value.toLowerCase(), filter = $('status-filter').value;
    const tasks = data.tasks.filter(t => (mode === 'activity' ? t.resource.lease !== 'idle' : t.dirId === directoryId) && t.title?.toLowerCase().includes(search) && (filter === 'all' || (filter === 'archived' ? t.status === 'archived' : !['done', 'archived'].includes(t.status))));
    $('task-list-title').textContent = mode === 'activity' ? '跨目录执行' : '任务'; $('task-count').textContent = tasks.length;
    $('tasks').replaceChildren(...tasks.map(t => { const b = node('button', null, t.id === taskId ? 'selected' : ''); b.append(node('strong', t.title), node('small', `${label(t.status)} · ${resourceText(t.resource)}`)); b.onclick = () => navigate(t.dirId, t.id); return b; }));
    if (!tasks.length) $('tasks').append(node('small', '这里还没有符合条件的任务。'));
    $('legacy-sessions').replaceChildren(...data.sessions.filter(s => s.kind === 'terminal' && s.dirId === directoryId).map(s => { const a = node('a', `›_ ${s.label}`); a.href = `/?id=${encodeURIComponent(s.id)}`; return a; }));
    $('empty').hidden = !!taskId; $('task-header').hidden = !taskId; $('conversation').hidden = !taskId;
    if (!taskId) { $('conversation').removeAttribute('src'); $('task-details').hidden = true; }
    if (taskId) { const target = `/task-shell.html?board=1&task=${encodeURIComponent(taskId)}&air=1`; if ($('conversation').getAttribute('src') !== target) $('conversation').src = target; }
  }
  async function refreshEntry() {
    const selected = taskId; if (!selected) return;
    try { const result = await api(`/api/air/tasks/${encodeURIComponent(selected)}`); if (taskId !== selected) return; entry = result; $('roles-toggle').disabled = entry.readOnly || !entry.roleBindings; $('ai-capsule').disabled = entry.readOnly;
      $('task-title').textContent = entry.task.title; $('task-state').textContent = `${label(entry.execution.status)} · ${resourceText(entry.resource)}`; $('ai-capsule').textContent = [entry.configuration.cli, entry.configuration.model || '默认模型'].filter(Boolean).join(' · ');
      const dl = node('dl'); for (const [key, value] of [['任务', entry.task.id], ['目录', entry.resource.path || '首次执行时准备'], ['分支', entry.resource.branch || '尚未创建'], ['资源状态', resourceText(entry.resource)], ['上下文角色', entry.roleBindings ? (entry.roleBindings.bindings.map(b => b.name).join('、') || '无附加角色') + ` · 版本 ${entry.roleBindings.version}` : entry.configuration.rolePresetId || '本任务配置'], ['本轮结果', entry.attribution.run ? label(entry.attribution.run.outcome) : '尚无已核验的本轮结果'], ['代码交付', entry.attribution.integration ? (entry.attribution.integration.baselineCurrent ? '已合入基分支，版本已核验' : '有合并记录，基分支变化后待核验') : '尚无覆盖本轮代码的合并凭证'], ['归属', entry.attribution.candidate ? `建议归入：${entry.attribution.candidate.title}（${entry.attribution.candidate.state === 'stale' ? '已有新输入，候选已过期' : '等待交付与现场核验'}）` : '本轮保持在当前任务；自动重归属等待集成与现场凭证']]) dl.append(node('dt', key), node('dd', value));
      $('task-details').replaceChildren(dl); const reasons = { view_changed: '已有新输入或视图变化', final_run_result_required: '等待最终执行结果', run_not_succeeded: '本轮未成功或仍需回答', code_observation_required: '代码版本尚未核实', integration_receipt_required: '等待本轮代码合入基分支', baseline_revalidation_required: '基分支已变化，需要重新核验交付', source_writer_barrier_required: '尚不能确认源工作目录持续停写' }; if (entry.attribution.candidate) { const list = node('ul'); for (const reason of entry.attribution.blockers) list.append(node('li', reasons[reason] || '等待核验')); $('task-details').append(list); } const reconcile = node('button', '重新核验合并记录'); reconcile.onclick = async () => { reconcile.disabled = true; try { await api(`/api/air/tasks/${encodeURIComponent(selected)}/delivery/reconcile`, {}); await refreshEntry(); notice('合并记录已核验；任务归属仍以交付条件为准。'); } catch (error) { notice(error.message); } finally { reconcile.disabled = false; } }; $('task-details').append(reconcile); if (entry.roleBindings && !entry.readOnly) { const role = node('button', '编辑角色上下文'); role.onclick = () => MultiCCAirRoles.open({ taskId: selected, roleBindings: entry.roleBindings, api, onSaved: refreshEntry }); $('task-details').append(role); }
    } catch (error) { if (taskId === selected) notice(error.message); }
  }
  async function refresh() { if (loading) return; loading = true; try { data = await api('/api/air'); notice(data.migration?.errors?.length ? `有 ${data.migration.errors.length} 份历史任务等待核验，原记录与工作区已保留。` : ''); render(); await refreshEntry(); } catch (error) { notice(error.message); } finally { loading = false; } }
  $('library').onclick = () => { mode = 'library'; document.body.classList.remove('nav-open'); render(); $('directory-search').focus(); };
  $('activity').onclick = () => { mode = 'activity'; document.body.classList.remove('nav-open'); render(); };
  $('directory-search').oninput = renderDirectories; $('task-search').oninput = render; $('status-filter').onchange = render; $('refresh').onclick = async () => { await refresh(); try { await $('conversation').contentWindow?.MultiCCTaskBoardEntry?.refresh?.(); } catch (error) { notice(error.message); } };
  $('favorite').onclick = () => { if (!directoryId) return; if (favorites.includes(directoryId)) favorites = favorites.filter(id => id !== directoryId); else if (favorites.length < 5) favorites.push(directoryId); else return notice('侧栏最多收藏 5 个目录，其余可从工作目录中搜索。'); localStorage.setItem('air:favorites', JSON.stringify(favorites)); render(); };
  $('mobile-nav').onclick = () => document.body.classList.toggle('nav-open');
  $('add-directory').onclick = () => MultiCCAirSettings.directory(async dir => { await refresh(); navigate(dir.id); });
  $('ai-capsule').onclick = () => { if (entry?.sessionId && !entry.readOnly) MultiCCAirSettings.configuration(entry, data.clis, refreshEntry); };
  $('roles-toggle').onclick = () => { if (entry?.roleBindings && !entry.readOnly) MultiCCAirRoles.open({ taskId, roleBindings: entry.roleBindings, api, onSaved: refreshEntry }); };
  $('details-toggle').onclick = () => { $('task-details').hidden = !$('task-details').hidden; $('details-toggle').setAttribute('aria-expanded', String(!$('task-details').hidden)); };
  $('create').onclick = () => { if (!data || !directoryId) return; $('create-directory').textContent = data.directories.find(d => d.id === directoryId)?.path || ''; $('cli').replaceChildren(...data.clis.map(cli => { const option = node('option', cli); option.value = cli; return option; })); $('new-task-dialog').showModal(); };
  $('close-dialog').onclick = () => $('new-task-dialog').close();
  let createAttempt = null;
  $('new-task-form').onsubmit = async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.target)); if (!values.model) delete values.model; if (!values.rolePrompt) delete values.rolePrompt; const fingerprint = JSON.stringify([directoryId, values]); if (!createAttempt || createAttempt.fingerprint !== fingerprint) createAttempt = { fingerprint, clientMsgId: crypto.randomUUID() }; $('create-submit').disabled = true; $('create-error').textContent = ''; try { const result = await api('/api/air/tasks', { dirId: directoryId, ...values, clientMsgId: createAttempt.clientMsgId }); createAttempt = null; $('new-task-dialog').close(); event.target.reset(); await refresh(); navigate(directoryId, result.taskId); } catch (error) { $('create-error').textContent = error.message; } finally { $('create-submit').disabled = false; } };
  $('conversation').onload = () => { const selected = taskId, doc = $('conversation').contentDocument, input = doc?.getElementById('message'); if (!selected || !input) return; const draft = sessionStorage.getItem(`air:draft:${selected}`); if (draft != null) input.value = draft; input.addEventListener('input', () => sessionStorage.setItem(`air:draft:${selected}`, input.value)); };
  window.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('library').click(); } if (e.key === 'Escape') document.body.classList.remove('nav-open'); });
  window.addEventListener('popstate', () => { saveDraft(); const next = new URLSearchParams(location.search); taskId = next.get('task'); directoryId = next.get('dir'); mode = 'tasks'; render(); void refreshEntry(); });
  window.addEventListener('pagehide', () => { saveDraft(); stopped = true; epoch++; clearTimeout(timer); });
  window.addEventListener('pageshow', e => { if (e.persisted) { stopped = false; epoch++; poll(); } });
  async function poll(e = epoch) { if (stopped || e !== epoch) return; if (!document.hidden || !data) await refresh(); if (!stopped && e === epoch) timer = setTimeout(() => poll(e), 2500); }
  poll();
})();
