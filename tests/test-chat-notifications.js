'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MODULE_FILE = path.join(ROOT, 'public', 'chat-notifications.js');

function fakeTarget(extra) {
  const listeners = new Map();
  return Object.assign({
    listeners,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  }, extra || {});
}

function loadModule() {
  const scheduled = new Map();
  let nextTimer = 1;
  const document = fakeTarget({
    visibilityState: 'hidden',
    createTextNode(text) { return { nodeType: 3, textContent: text }; },
  });
  const spoken = [];
  let cancelled = 0;
  const window = fakeTarget({
    document,
    location: {
      pathname: '/chat.html',
      search: '?session=safe-session&cwd=%2Ftmp%2Ffleet&token=SECRET&access_token=SECOND&api_key=THIRD&debug=1',
    },
    URL,
    setTimeout(fn, delay) {
      const id = nextTimer++;
      scheduled.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { scheduled.delete(id); },
    speechSynthesis: {
      speak(utterance) { spoken.push(utterance); },
      cancel() { cancelled++; },
    },
    SpeechSynthesisUtterance: class SpeechSynthesisUtterance {
      constructor(text) { this.text = text; }
    },
  });
  window.window = window;

  vm.runInNewContext(fs.readFileSync(MODULE_FILE, 'utf8'), {
    window,
    globalThis: window,
  }, { filename: MODULE_FILE });

  return {
    api: window.MultiCCChatNotifications,
    document,
    scheduled,
    spoken,
    get cancelled() { return cancelled; },
    window,
  };
}

function makeButton() {
  return fakeTarget({ style: {}, title: '' });
}

function makeToast() {
  const close = { className: 'toast-close' };
  return fakeTarget({
    style: {},
    className: '',
    textContent: '',
    children: [],
    querySelector(selector) { return selector === '.toast-close' ? close : null; },
    appendChild(child) { this.children.push(child); return child; },
  });
}

async function main() {
  const loaded = loadModule();
  const { api, document, window, scheduled, spoken } = loaded;

  assert.ok(Object.isFrozen(api));
  assert.deepStrictEqual(Array.from(api.dingFrequencies('completed')), [1046.5, 1567.98]);
  assert.deepStrictEqual(Array.from(api.dingFrequencies('error')), [783.99, 622.25]);
  assert.deepStrictEqual(Array.from(api.dingFrequencies('waiting')), [659.25]);

  const waitingPayload = JSON.parse(JSON.stringify(
    api.localNotificationPayload('alpha', '请确认', 'waiting', '/chat.html?session=alpha'),
  ));
  assert.deepStrictEqual(waitingPayload, {
    sessionId: 'alpha',
    type: 'waiting',
    title: 'MultiCC #alpha: 等待操作',
    body: '请确认',
    url: '/chat.html?session=alpha',
  });
  const errorPayload = JSON.parse(JSON.stringify(
    api.localNotificationPayload('alpha', '接口中断', 'error', '/chat.html?session=alpha'),
  ));
  assert.deepStrictEqual(errorPayload, {
    sessionId: 'alpha',
    type: 'error',
    title: 'MultiCC #alpha: 任务异常',
    body: '接口中断',
    url: '/chat.html?session=alpha',
  });
  assert.strictEqual(
    api.safeNotificationUrl(window.location, URL),
    '/chat.html?session=safe-session&cwd=%2Ftmp%2Ffleet',
  );

  const notifyBtn = makeButton();
  const notifyToast = makeToast();
  const preferences = [];
  const localNotifications = [];
  let clock = 10000;
  let pushSubscribed = true;
  let unsubscribed = 0;
  let preference = true;
  let sessionId = 'alpha';

  const controller = api.createNotificationController({
    window,
    document,
    notifyBtn,
    notifyToast,
    getSessionId: () => sessionId,
    getTaskNotifyEnabled: () => preference,
    setTaskNotifyEnabled: (id, enabled) => preferences.push([id, enabled]),
    getPushInfo: () => ({ subscribed: pushSubscribed }),
    isPushSubscribed: () => pushSubscribed,
    ensurePushSubscribed: async () => true,
    unsubscribePush: async () => { unsubscribed++; pushSubscribed = false; },
    showLocalTaskNotification: (payload) => localNotifications.push(payload),
    now: () => clock,
  });

  assert.strictEqual(controller.isEnabled(), true);
  assert.strictEqual(notifyBtn.style.background, '#1f6feb');
  assert.ok(notifyBtn.title.includes('系统通知已开启'));

  await notifyBtn.listeners.get('click')();
  assert.strictEqual(controller.isEnabled(), false);
  assert.deepStrictEqual(preferences.shift(), ['alpha', false]);
  assert.strictEqual(unsubscribed, 1);
  assert.strictEqual(notifyBtn.style.background, '#21262d');

  preference = true;
  sessionId = 'beta';
  controller.refreshPreference();
  assert.strictEqual(controller.isEnabled(), true);
  assert.ok(notifyBtn.title.includes('点击开启系统通知'));

  assert.strictEqual(api.normalizeNotificationType('completed'), 'succeeded',
    'legacy completed is a turn outcome, never task lifecycle done');
  assert.strictEqual(controller.speak('执行成功', 'succeeded'), true);
  assert.strictEqual(localNotifications.length, 1);
  assert.strictEqual(localNotifications[0].sessionId, 'beta');
  assert.strictEqual(localNotifications[0].url, '/chat.html?session=safe-session&cwd=%2Ftmp%2Ffleet');
  assert.strictEqual(spoken.length, 1);
  assert.strictEqual(spoken[0].text, '执行成功');
  assert.strictEqual(spoken[0].lang, 'zh-CN');
  assert.strictEqual(notifyToast.style.display, 'block');
  assert.strictEqual(notifyToast.className, 'succeeded');
  assert.ok([...scheduled.values()].some(timer => timer.delay === 15000));

  assert.strictEqual(controller.speak('重复执行成功', 'succeeded'), false, 'same-kind notification observes cooldown');
  assert.strictEqual(localNotifications.length, 1);
  assert.strictEqual(controller.speak('接口异常', 'error'), true, 'error has an independent cooldown bucket');
  assert.strictEqual(localNotifications[1].type, 'error');
  assert.ok(localNotifications[1].title.includes('任务异常'));
  clock += api.NOTIFY_COOLDOWN + 1;
  assert.strictEqual(controller.speak('再次执行成功', 'succeeded'), true);
  assert.strictEqual(localNotifications.length, 3);

  document.visibilityState = 'visible';
  clock += api.NOTIFY_COOLDOWN + 1;
  assert.strictEqual(controller.speak('等待操作', 'waiting'), true);
  assert.strictEqual(localNotifications.length, 3, 'visible tab uses ding instead of system notification');
  assert.strictEqual(spoken.length, 3, 'visible tab does not add speech');

  document.listeners.get('visibilitychange')();
  assert.strictEqual(notifyToast.style.display, 'none');
  assert.strictEqual(loaded.cancelled, 1);

  controller.destroy();
  assert.strictEqual(notifyBtn.listeners.has('click'), false);
  assert.strictEqual(window.listeners.has('multicc-push-state'), false);

  let releaseUnsubscribe;
  let racingUnsubscribes = 0;
  const raceButton = makeButton();
  const raceController = api.createNotificationController({
    window,
    document,
    notifyBtn: raceButton,
    getSessionId: () => 'race',
    getTaskNotifyEnabled: () => true,
    setTaskNotifyEnabled: () => {},
    getPushInfo: () => ({ subscribed: true }),
    isPushSubscribed: () => true,
    unsubscribePush: () => {
      racingUnsubscribes += 1;
      return new Promise(resolve => { releaseUnsubscribe = resolve; });
    },
  });
  const firstToggle = raceController.toggle();
  const secondToggle = raceController.toggle();
  assert.strictEqual(firstToggle, secondToggle, 'concurrent toggles share one in-flight operation');
  assert.strictEqual(raceButton.disabled, true);
  assert.strictEqual(racingUnsubscribes, 1);
  releaseUnsubscribe();
  await Promise.all([firstToggle, secondToggle]);
  assert.strictEqual(raceController.isEnabled(), false);
  assert.strictEqual(raceButton.disabled, false);
  raceController.destroy();

  const moduleSource = fs.readFileSync(MODULE_FILE, 'utf8');
  const chatSource = fs.readFileSync(path.join(ROOT, 'public', 'chat.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf8');
  assert.ok(!/\bfetch\s*\(/.test(moduleSource), 'notification module owns no network request');
  assert.ok(!/\b(import|export)\b/.test(moduleSource), 'module remains a classic script');
  assert.ok(!moduleSource.includes('tokenQS'), 'module never builds credential query strings');
  assert.strictEqual((chatSource.match(/function speakNotify\s*\(/g) || []).length, 1);
  assert.strictEqual((chatSource.match(/NOTIFY_COOLDOWN/g) || []).length, 0, 'notification policy has one implementation');
  assert.ok(chatSource.includes('MultiCCChatNotifications.createNotificationController'));
  const pwaAt = html.indexOf('<script src="pwa.js"></script>');
  const authAt = html.indexOf('<script src="auth-client.js"></script>');
  const notificationsAt = html.indexOf('<script src="chat-notifications.js"></script>');
  const chatAt = html.indexOf('<script src="chat.js"></script>');
  assert.ok(pwaAt >= 0 && pwaAt < notificationsAt);
  assert.ok(authAt >= 0 && authAt < notificationsAt);
  assert.ok(notificationsAt < chatAt);

  console.log('chat notification controller tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
