(function () {
  'use strict';
  const node = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };
  window.MultiCCAirRoles = {
    open({ taskId, roleBindings, api, onSaved }) {
      const dialog = node('dialog'), form = node('form'), rows = node('div'), error = node('p');
      error.setAttribute('role', 'alert');
      const heading = node('h2', '角色上下文'), note = node('p', '保存后对下一条新消息生效。正在执行和已经排队的消息保留原角色。');
      const add = node('button', '＋ 添加角色'), save = node('button', '保存角色'), close = node('button', '取消');
      add.type = close.type = 'button'; save.type = 'submit'; save.className = 'primary';
      function row(binding = { name: '', prompt: '' }) {
        if (rows.children.length >= 8) return;
        const section = node('fieldset'), nameLabel = node('label', '角色名称'), promptLabel = node('label', '角色说明');
        const name = node('input'), prompt = node('textarea'), remove = node('button', '移除');
        name.value = binding.name; name.maxLength = 80; name.required = true;
        prompt.value = binding.prompt; prompt.rows = 4; prompt.maxLength = 40000; prompt.required = true;
        remove.type = 'button'; remove.onclick = () => section.remove();
        nameLabel.append(name); promptLabel.append(prompt); section.append(nameLabel, promptLabel, remove); rows.append(section);
      }
      for (const binding of roleBindings.bindings) row(binding);
      add.onclick = () => row(); close.onclick = () => dialog.close();
      let request = null;
      form.onsubmit = async event => {
        event.preventDefault(); const bindings = [...rows.children].map(r => ({ name: r.querySelector('input').value, prompt: r.querySelector('textarea').value }));
        const fingerprint = JSON.stringify(bindings);
        if (!request || request.fingerprint !== fingerprint) request = { fingerprint, clientMsgId: crypto.randomUUID() };
        save.disabled = true; error.textContent = '';
        try {
          await api(`/api/air/tasks/${encodeURIComponent(taskId)}/roles`, { bindings, expectedVersion: roleBindings.version, clientMsgId: request.clientMsgId });
          dialog.close(); await onSaved();
        } catch (e) { error.textContent = e.message === 'role_version_conflict' ? '角色已在其他页面更新，请关闭后重新打开。' : e.message; }
        finally { save.disabled = false; }
      };
      dialog.addEventListener('close', () => dialog.remove(), { once: true });
      form.append(heading, note, rows, add, error, close, save); dialog.append(form); document.body.append(dialog); dialog.showModal();
    },
  };
})();
