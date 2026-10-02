'use strict';
(function (root) {
  if (!root) return;
  function render(host, { api, t, devices: initial, refreshHealth = () => {} }) {
    let devices = initial;
    let busy = false;
    const make = (tag, text) => {
      const element = document.createElement(tag);
      if (text != null) element.textContent = text;
      return element;
    };
    const section = make('section');
    section.className = 'admin-panel air-bark-devices';
    section.append(make('h2', t('barkPhonesTitle')), make('p', t('barkPhonesScope')));
    const list = make('div');
    const details = make('details');
    details.open = devices.length === 0;
    details.append(make('summary', t('barkAddPhone')));
    const install = make('a', t('barkInstall'));
    install.href = 'https://apps.apple.com/app/id1403753865';
    install.target = '_blank';
    install.rel = 'noopener noreferrer';
    details.append(make('p', t('barkStepOne')), install, make('p', t('barkStepTwo')));
    const name = make('input');
    name.id = 'bark-device-name';
    name.maxLength = 60;
    name.placeholder = t('barkNameHint');
    const address = make('input');
    address.id = 'bark-device-address';
    address.type = 'password';
    address.autocomplete = 'new-password';
    address.spellcheck = false;
    address.placeholder = 'https://api.day.app/…';
    const field = (label, input) => {
      const row = make('label'); row.className = 'air-aux-field';
      row.append(make('span', label), input); return row;
    };
    details.append(field(t('barkPhoneName'), name), field(t('barkAddress'), address), make('p', t('barkStepThree')));
    const actions = make('div'); actions.className = 'air-push-actions';
    const status = make('p'); status.setAttribute('role', 'status'); status.id = 'bark-device-status';
    const say = (key, error = false) => { status.textContent = t(key); status.className = error ? 'error' : ''; };
    const errorKey = error => {
      const message = String(error?.message || '');
      if (message.includes('device_already_added')) return 'barkDuplicate';
      if (message.includes('invalid_bark_address')) return 'barkInvalidAddress';
      if (message.includes('invalid_device_name')) return 'barkNeedName';
      return 'barkActionFailed';
    };
    const lock = value => {
      busy = value;
      for (const el of section.querySelectorAll('button,input')) el.disabled = value;
    };
    const button = (text, fn) => {
      const b = make('button', text); b.type = 'button'; b.onclick = fn; return b;
    };
    async function perform(body) {
      const data = await api('/api/push/bark-devices', body);
      if (data?.error) throw new Error(data.error);
      if (Array.isArray(data?.devices)) { devices = data.devices; paintList(); }
      return data;
    }
    async function act(device, action, extra = {}) {
      if (busy) return;
      if (action === 'remove' && !root.confirm(t('barkRemoveConfirm'))) return;
      lock(true); say('barkWorking');
      try {
        await perform({ action, id: device.id, ...extra });
        say(action === 'test' ? 'barkTestAccepted' : 'barkSaved');
        void refreshHealth();
      } catch (error) { say(action === 'test' ? 'barkTestFailed' : errorKey(error), true); }
      finally { lock(false); }
    }
    function paintList() {
      list.replaceChildren();
      if (!devices.length) list.append(make('p', t('barkNoPhones')));
      for (const d of devices) {
        const row = make('div'); row.className = 'air-bark-phone'; row.dataset.deviceId = d.id;
        row.style.cssText = 'padding:12px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere';
        row.append(make('strong', d.legacy && d.name === '原有手机' ? t('barkLegacyPhone') : d.name));
        row.append(make('p', t(d.enabled ? 'barkPhoneEnabled' : 'barkPhoneDisabled')));
        const controls = make('div'); controls.className = 'air-push-actions';
        controls.append(button(t('barkTestPhone'), () => act(d, 'test')),
          button(t(d.enabled ? 'barkDisable' : 'barkEnable'), () => act(d, 'update', { enabled: !d.enabled })),
          button(t('rename'), () => {
            const value = root.prompt(t('barkPhoneName'), d.name);
            if (value != null) void act(d, 'update', { name: value });
          }), button(t('barkRemove'), () => act(d, 'remove')));
        row.append(controls); list.append(row);
      }
      if (busy) lock(true);
    }
    actions.append(button(t('barkPaste'), async () => {
      try { address.value = await navigator.clipboard.readText(); }
      catch (_) { say('barkPasteManually'); address.focus(); }
    }), button(t('barkAddAndTest'), async () => {
      if (busy) return;
      if (!name.value.trim()) { say('barkNeedName', true); return; }
      if (!address.value.trim()) { say('barkInvalidAddress', true); return; }
      lock(true); say('barkWorking');
      let saved = false;
      try {
        const data = await perform({ action: 'add', name: name.value.trim(), url: address.value.trim() });
        saved = true; address.value = ''; name.value = ''; details.open = false;
        await perform({ action: 'test', id: data.id });
        say('barkTestAccepted');
        void refreshHealth();
      } catch (error) { say(saved ? 'barkAddedTestFailed' : errorKey(error), true); }
      finally { lock(false); }
    }));
    details.append(actions);
    section.append(list, details, status, make('p', t('barkReminderLimit')));
    paintList(); host.replaceChildren(section);
  }
  root.MultiCCBarkDevices = { render };
})(typeof window !== 'undefined' ? window : null);
