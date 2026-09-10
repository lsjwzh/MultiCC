(function () {
  'use strict';
  const node = (tag, text) => { const e = document.createElement(tag); if (text) e.textContent = text; return e; };
  function dialog(title, build) {
    const d = node('dialog'), form = node('form'), error = node('p'); error.setAttribute('role', 'alert');
    const cancel = node('button', '取消'), submit = node('button', '保存'); cancel.type = 'button'; submit.className = 'primary';
    cancel.onclick = () => d.close(); form.append(node('h2', title));
    const save = build(form); form.append(error, cancel, submit);
    form.onsubmit = async event => { event.preventDefault(); submit.disabled = true; error.textContent = '';
      try { await save(); d.close(); } catch (e) { error.textContent = e.message; } finally { submit.disabled = false; } };
    d.onclose = () => d.remove(); d.append(form); document.body.append(d); d.showModal();
  }
  function field(form, title, tag = 'input') { const label = node('label', title), input = node(tag); label.append(input); form.append(label); return input; }
  async function request(url, body, method = 'POST') {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok || result.ok === false) throw new Error(result.message || result.error || result.code); return result;
  }
  window.MultiCCAirSettings = {
    directory(onSaved) {
      dialog('添加工作目录', form => {
        const name = field(form, '名称'), path = field(form, '本机绝对路径'); name.required = path.required = true;
        name.maxLength = 100; path.placeholder = '/Users/you/projects/example';
        form.append(node('p', '添加目录后，可在其中创建任务并按需附加角色。'));
        return async () => { const result = await request('/api/directories', { name: name.value, path: path.value, create: false }); await onSaved(result); };
      });
    },
    configuration(entry, clis, onSaved) {
      dialog('任务 AI 配置', form => {
        const cli = field(form, 'AI 工具', 'select'), model = field(form, '模型（留空跟随默认）'), effort = field(form, '思考强度（留空跟随默认）');
        for (const name of clis) { const option = node('option', name); option.value = name; cli.append(option); }
        cli.value = entry.configuration.cli || 'claude'; model.value = entry.configuration.model || ''; model.maxLength = 100;
        effort.value = entry.configuration.effort || ''; effort.placeholder = 'low / medium / high';
        form.append(node('p', '更改 AI 配置需要任务空闲；任务历史和工作区保持归属于当前任务。'));
        return async () => {
          const base = `/api/sessions/${encodeURIComponent(entry.sessionId)}`;
          try {
            if (cli.value !== entry.configuration.cli) await request(base + '/switch-cli', { cli: cli.value });
            await request(base, { model: model.value || null, effort: effort.value || null }, 'PATCH');
          } finally { await onSaved(); }
        };
      });
    },
  };
})();
