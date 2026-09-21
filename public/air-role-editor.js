(function () {
  'use strict';
  const node = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };
  window.MultiCCAirRoles = {
    // `save` is the draft hook: when the caller passes it (a task that does not
    // exist yet — the directory's new-task composer), the edited bindings are
    // handed back instead of being written to a task that has no id.
    open({ taskId, roleBindings, api, onSaved, save: draftSave }) {
      const draft = typeof draftSave === 'function';
      const dialog = node('dialog'), form = node('form'), rows = node('div'), error = node('p');
      error.setAttribute('role', 'alert');
      const heading = node('h2', t('airRoleEditorHeading')), note = node('p', draft
        ? t('airRoleEditorDraftNote')
        : t('airRoleEditorSavedNote'));
      const add = node('button', t('airRoleEditorAddRole')), save = node('button', draft ? t('airRoleEditorUseRoles') : t('airRoleEditorSaveRoles')), close = node('button', t('airRoleEditorCancel'));
      const preset = node('select'), placeholder = node('option', t('airRoleEditorPresetPlaceholder')); placeholder.value = ''; preset.append(placeholder);
      preset.setAttribute('aria-label', t('airRoleEditorPresetAria')); preset.disabled = true;
      add.type = close.type = 'button'; save.type = 'submit'; save.className = 'primary';
      function row(binding = { name: '', prompt: '' }) {
        if (rows.children.length >= 8) return;
        const section = node('fieldset'), nameLabel = node('label', t('airRoleEditorNameLabel')), promptLabel = node('label', t('airRoleEditorPromptLabel'));
        const name = node('input'), prompt = node('textarea'), remove = node('button', t('airRoleEditorRemove'));
        name.value = binding.name; name.maxLength = 80; name.required = true;
        prompt.value = binding.prompt; prompt.rows = 4; prompt.maxLength = 40000; prompt.required = true;
        remove.type = 'button'; remove.onclick = () => section.remove();
        nameLabel.append(name); promptLabel.append(prompt); section.append(nameLabel, promptLabel, remove); rows.append(section);
      }
      for (const binding of roleBindings.bindings) row(binding);
      api('/api/agent-presets').then(data => {
        if (!dialog.isConnected) return;
        for (const p of data.presets || []) { const option = node('option', p.name || p.id); option.value = p.id; preset.append(option); }
        preset.disabled = false;
      }).catch(() => { placeholder.textContent = t('airRoleEditorPresetUnavailable'); });
      preset.onchange = async () => {
        if (!preset.value) return;
        preset.disabled = true;
        try { const value = await api(`/api/agent-presets/${encodeURIComponent(preset.value)}`); if (dialog.isConnected) row(value); }
        catch (e) { error.textContent = e.message; }
        finally { preset.disabled = false; preset.value = ''; }
      };
      add.onclick = () => row(); close.onclick = () => dialog.close();
      let request = null;
      form.onsubmit = async event => {
        event.preventDefault(); const bindings = [...rows.children].map(r => ({ name: r.querySelector('input').value, prompt: r.querySelector('textarea').value }));
        if (draft) {
          save.disabled = true; error.textContent = '';
          try { await draftSave(bindings); dialog.close(); }
          catch (e) { error.textContent = e.message; }
          finally { save.disabled = false; }
          return;
        }
        const fingerprint = JSON.stringify(bindings);
        if (!request || request.fingerprint !== fingerprint) request = { fingerprint, clientMsgId: crypto.randomUUID() };
        save.disabled = true; error.textContent = '';
        try {
          await api(`/api/air/tasks/${encodeURIComponent(taskId)}/roles`, { bindings, expectedVersion: roleBindings.version, clientMsgId: request.clientMsgId });
          dialog.close(); await onSaved();
        } catch (e) { error.textContent = e.message === 'role_version_conflict' ? t('airRoleEditorVersionConflict') : e.message; }
        finally { save.disabled = false; }
      };
      dialog.addEventListener('close', () => dialog.remove(), { once: true });
      form.append(heading, note, preset, rows, add, error, close, save); dialog.append(form); document.body.append(dialog); dialog.showModal();
    },
  };
})();
