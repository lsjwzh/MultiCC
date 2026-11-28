'use strict';
window.MultiCCArchiveInactive = async function ({ api, refresh, notice, t }) {
  const button = document.getElementById('archive-inactive');
  if (button.disabled || !window.confirm(t('airArchiveInactiveConfirm'))) return;
  button.disabled = true;
  try {
    const result = await api('/api/air/archive-inactive', {});
    await refresh();
    notice(t('airArchiveInactiveResult', { n: result.archived.length }));
  } catch (error) {
    notice(error.message);
  } finally {
    button.disabled = false;
  }
};
