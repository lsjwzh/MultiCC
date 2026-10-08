'use strict';

// Both sidebar switches consume the same settings DTO as the global panel.
(function (root) {
  root.MultiCCAirPowerShortcuts = { attach({ api, notice, openSetup }) {
    const lid = document.getElementById('air-lid-sleep');
    const unlock = document.getElementById('air-auto-unlock');
    let state = null, busy = false;
    function paint(value) {
      state = value;
      for (const [node, enabled] of [[lid, value.enabled], [unlock, value.unlockPassword?.enabled]]) {
        node.hidden = !value.available;
        node.classList.toggle('on', !!enabled);
        node.setAttribute('aria-pressed', String(!!enabled));
        node.disabled = busy || !!value.error;
      }
      unlock.hidden = !value.available || !value.unlockPassword?.available;
      unlock.disabled = busy || !!value.enabled || !!value.unlockPassword?.error;
      lid.title = t(value.enabled ? 'airLidSleepOnTitle' : 'airLidSleepOffTitle');
      unlock.title = t(value.enabled ? 'airGlobalUnlockIncluded' : value.unlockPassword?.enabled ? 'airGlobalUnlockSaved' : 'airGlobalUnlockOff');
    }
    async function refresh() {
      if (busy) return;
      try { paint(await api('/api/settings/power')); }
      catch (_) { lid.disabled = true; unlock.disabled = true; }
    }
    async function toggle(action) {
      if (busy || !state) return;
      const wanted = !(action === 'lid' ? state.enabled : state.unlockPassword?.enabled);
      if (wanted && !state.unlockPassword?.set) { root.MultiCCAirMore?.close(); openSetup(action); return; }
      busy = true;
      paint(state);
      try {
        const result = await api(action === 'lid' ? '/api/settings/power' : '/api/settings/power/auto-unlock', { enabled: wanted }, 'POST');
        paint(result);
        root.dispatchEvent(new CustomEvent('multicc-power-changed', { detail: result }));
        notice(t(action === 'lid'
          ? (result.enabled ? 'airLidSleepOn' : result.systemSleepDisabled ? 'airGlobalPowerExternal' : 'airLidSleepOff')
          : (result.unlockPassword?.enabled ? 'airGlobalUnlockSaved' : 'airGlobalUnlockOff')));
        if (action === 'lid' && wanted && result.enabled) {
          try {
            const permissions = await api('/api/system/agent-permissions');
            if (permissions.ok && permissions.applicable === true && (!permissions.accessibility || !permissions.screenRecording)) {
              root.MultiCCAirMore?.close();
              openSetup('permissions');
            }
          } catch (_) { /* The switch succeeded; a permission check may be retried in Global Settings. */ }
        }
      } catch (error) {
        notice(t('airGlobalPowerFailed', { message: error.message }));
        if (error.code === 'unlock_setup_required' || error.code === 'unlock_authorization_required' || error.code === 'unlock_permissions_required') { root.MultiCCAirMore?.close(); openSetup(error.code === 'unlock_permissions_required' ? 'permissions' : action); }
      } finally {
        busy = false;
        paint(state);
        await refresh();
      }
    }
    lid.onclick = () => { void toggle('lid'); };
    unlock.onclick = () => { void toggle('unlock'); };
    root.addEventListener('multicc-power-changed', event => paint(event.detail));
    root.addEventListener('multicc-more-opened', () => { void refresh(); });
    return { refresh };
  } };
})(window);
