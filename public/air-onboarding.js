'use strict';

(function (root) {
  const $ = id => document.getElementById(id);
  function saved(key) {
    try { return localStorage.getItem(key) === 'true'; } catch (_) { return false; }
  }
  function remember(key) {
    try { localStorage.setItem(key, 'true'); } catch (_) {}
  }
  let dismissed = saved('air:setup-dismissed');
  let started = saved('air:setup-started');
  const remoteFinishedKey = 'air:setup-remote-control-finished';
  let remoteFinished = saved(remoteFinishedKey);
  let desktopPermissions = null;
  let context;
  function render(next) {
    context = next;
    if (!next.data) return;
    const { data, auxConfigured, setMode, api } = next;
    const done = [auxConfigured === true, data.directories.length > 0, data.tasks.length > 0];
    const count = done.filter(Boolean).length;
    const incomplete = count < 3 && auxConfigured !== null;
    if (incomplete && !dismissed && !started) {
      started = true;
      remember('air:setup-started');
    }
    const localMac = desktopPermissions?.applicable === true && desktopPermissions.local === true;
    if (started && !remoteFinished && localMac && desktopPermissions.ok === true &&
        desktopPermissions.accessibility === true && desktopPermissions.screenRecording === true) {
      remoteFinished = true;
      remember(remoteFinishedKey);
    }
    const showRemote = started && !remoteFinished && localMac && auxConfigured !== null;
    $('setup-card').hidden = (!incomplete && !showRemote) || dismissed;
    $('setup-step-remote').hidden = !showRemote;
    $('setup-dismiss').hidden = !incomplete;
    $('onboarding-entry').hidden = !incomplete && !showRemote;
    $('onboarding-entry-guide').hidden = !incomplete;
    $('onboarding-entry-remote').hidden = incomplete || !showRemote;
    $('onboarding-progress').textContent = count + ' / 3';
    $('setup-progress').value = count;
    $('setup-progress').setAttribute('aria-valuetext', count + ' / 3');
    const current = done.indexOf(false);
    for (let i = 0; i < 3; i++) {
      const step = $('setup-step-' + i);
      step.classList.toggle('done', done[i]);
      step.classList.toggle('current', i === current);
      step.classList.toggle('upcoming', !done[i] && i !== current);
      step.querySelector('.setup-number').textContent = done[i] ? '✓' : String(i + 1);
      if (i === current) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
    }
    $('setup-first-task').disabled = !done[0] || !done[1];
    $('setup-provider').onclick = () => setMode('provider');
    $('setup-aux').onclick = () => setMode('aux');
    $('setup-project').onclick = () => $('add-directory').click();
    $('setup-example').onclick = next.example;
    $('setup-first-task').onclick = () => $('create').click();
    $('setup-remote-configure').onclick = () => root.MultiCCAirAgentPermissions.show(api);
    $('setup-remote-skip').onclick = () => {
      remoteFinished = true;
      remember(remoteFinishedKey);
      render(context);
    };
    $('setup-dismiss').onclick = () => {
      dismissed = true;
      remember('air:setup-dismissed');
      render(context);
    };
    $('onboarding-entry').onclick = () => {
      dismissed = false;
      try { localStorage.removeItem('air:setup-dismissed'); } catch (_) {}
      setMode('overview'); render(context);
      $(incomplete ? 'setup-card' : 'setup-step-remote').scrollIntoView({ block: 'start' });
    };
  }
  root.addEventListener('multicc-agent-permissions', event => {
    desktopPermissions = event.detail;
    if (context) render(context);
  });
  root.MultiCCAirOnboarding = { render };
})(window);
