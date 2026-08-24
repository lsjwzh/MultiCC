'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('manage page exposes discoverable Fleet share/import entrypoints and loads the isolated controller', () => {
  const html = read('public/manage.html');
  const dashboard = html.indexOf('<script src="manage-dashboard.js"></script>');
  const sharing = html.indexOf('<script src="manage-fleet-sharing.js"></script>');
  const manage = html.indexOf('<script src="manage.js"></script>');
  assert.ok(dashboard >= 0 && dashboard < sharing && sharing < manage);
  assert.match(html, /onclick="openImportFleetModal\(\)"/);
  assert.match(html, /id="external-fleet-section"/);
  assert.match(html, /manage-fleet-sharing\.css/);

  const dashboardSource = read('public/manage-dashboard.js');
  assert.match(dashboardSource, /分享 Fleet/);
  assert.match(dashboardSource, /openFleetShareModal\(dirId\)/);
  assert.match(dashboardSource, /loadExternalFleets/);
});

test('Fleet sharing UI keeps passwords write-only and uses the bounded API surface', () => {
  const source = read('public/manage-fleet-sharing.js');
  assert.match(source, /id="fleet-share-password" type="password"/);
  assert.match(source, /id="fleet-import-password" type="password"/);
  assert.match(source, /\/api\/fleets\/\$\{encodeURIComponent\(activeFleetId\)\}\/share/);
  assert.match(source, /\/api\/external-fleets\/import/);
  assert.match(source, /只读快照/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  assert.doesNotMatch(source, /fleet\.password|record\.password|externalFleets[^\n]+password/);
});

test('Fleet share and import dialogs expose complete close controls', () => {
  const source = read('public/manage-fleet-sharing.js');
  const styles = read('public/manage-fleet-sharing.css');
  assert.match(source, /class="fs-modal-close"[^>]+onclick="closeFleetShareModal\(\)"[^>]+aria-label="关闭分享 Fleet 弹窗"/);
  assert.match(source, /class="fs-modal-close"[^>]+onclick="closeImportFleetModal\(\)"[^>]+aria-label="关闭导入 Fleet 弹窗"/);
  assert.match(source, /event\.target===this\)closeFleetShareModal\(\)/);
  assert.match(source, /event\.target===this\)closeImportFleetModal\(\)/);
  assert.match(source, /event\.key !== 'Escape'/);
  assert.match(source, /document\.addEventListener\('keydown', closeVisibleFleetModal\)/);
  assert.match(styles, /\.fs-modal-head\{/);
  assert.match(styles, /\.fs-modal-body\{[^}]*overflow-y:auto/);
  assert.match(styles, /\.fs-modal-close:focus-visible/);
});

test('public Fleet landing page explains snapshot scope without collecting a password', () => {
  const page = read('public/fleet-share.html');
  assert.match(page, /只读 Fleet 快照/);
  assert.match(page, /不会.*执行代码/);
  assert.doesNotMatch(page, /type="password"|\/api\//);
});
