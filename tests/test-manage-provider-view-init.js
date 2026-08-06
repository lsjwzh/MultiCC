'use strict';

// Regression test: setView('provider') must auto-call setProvTab for the
// active provider tab, so the prov-new-card doesn't appear in isolation.
// See commit aba73da / docs/architecture-map-state-and-quota.md (坏味道 #1).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function extractInlineScript(html, needle) {
  const scripts = [];
  let idx = 0;
  while ((idx = html.indexOf('<script>', idx)) !== -1) {
    const end = html.indexOf('</script>', idx);
    if (end === -1) break;
    const code = html.slice(idx + 8, end);
    if (code.includes(needle)) scripts.push(code);
    idx = end + 9;
  }
  return scripts;
}

test('setView("provider") auto-calls setProvTab with the active tab', () => {
  const html = read('public/manage.html');
  const scripts = extractInlineScript(html, 'window.setView');
  assert.ok(scripts.length > 0, 'should find an inline script with setView');

  let lastSetProvTabArg = null;
  const activeTabPtab = 'anthropic';
  const timers = [];

  const context = {
    console,
    URLSearchParams,
    JSON,
    setTimeout(fn) { const t = setTimeout(fn); timers.push(t); return t; },
    clearTimeout(id) { clearTimeout(id); },
    setInterval() { return 1; },
    clearInterval() {},
    location: { search: '' },
    document: {
      body: { dataset: {}, classList: { remove() {}, add() {}, contains() { return false; }, toggle() {} } },
      querySelector(sel) {
        if (sel === '#prov-tabs .prov-tab.active') {
          return { dataset: { ptab: activeTabPtab } };
        }
        return null;
      },
      querySelectorAll() { return []; },
      getElementById() { return null; },
    },
    // setProvTab is defined elsewhere in the HTML — stub it so setView can call it
    setProvTab(name) { lastSetProvTabArg = name; },
    // These globals are referenced by setView / setProvTab
    loadMemoryGraph() {},
    MultiCCManageQwenAudio: { loadPanel() {} },
    TITLES: {
      overview: ['Overview', ''],
      provider: ['Provider 配置', ''],
    },
  };

  context.window = context;
  vm.createContext(context);

  for (const code of scripts) {
    vm.runInContext(code, context, { filename: 'manage.html' });
  }

  // Act: simulate navigating to the provider view
  context.setView('provider');

  // Assert: setProvTab was called with the active tab's name
  assert.equal(lastSetProvTabArg, activeTabPtab,
    'setView("provider") must auto-call setProvTab("' + activeTabPtab + '")');
});

test('setView("overview") does not call setProvTab', () => {
  const html = read('public/manage.html');
  const scripts = extractInlineScript(html, 'window.setView');

  let setProvTabCalled = false;
  const context = {
    console,
    URLSearchParams,
    JSON,
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    location: { search: '' },
    document: {
      body: { dataset: {}, classList: { remove() {}, add() {}, contains() { return false; }, toggle() {} } },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getElementById() { return null; },
    },
    setProvTab() { setProvTabCalled = true; },
    loadMemoryGraph() {},
    MultiCCManageQwenAudio: { loadPanel() {} },
    TITLES: {
      overview: ['Overview', ''],
      provider: ['Provider 配置', ''],
    },
  };

  context.window = context;
  vm.createContext(context);

  for (const code of scripts) {
    vm.runInContext(code, context, { filename: 'manage.html' });
  }

  context.setView('overview');
  assert.equal(setProvTabCalled, false,
    'setView("overview") must not call setProvTab');
});
