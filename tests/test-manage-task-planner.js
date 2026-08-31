'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/manage.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/manage-task-planner.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/manage-task-planner.css'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(root, 'app/assets/i18n/zh.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'app/assets/i18n/en.json'), 'utf8'));

test('manage shell exposes the first-class Task Center view', () => {
  assert.match(html, /manage-task-planner\.css/);
  assert.match(html, /class="nav-item" data-view="tasks"/);
  assert.match(html, /class="view planner-view" data-view="tasks"/);
  assert.match(html, /allowedViews = \[[^\]]*'tasks'/);
  assert.match(html, /manage-task-planner\.js/);
});

test('planner keeps workflow, runtime, and history identity independent', () => {
  assert.match(js, /Object\.freeze\(\['inbox', 'ready', 'doing', 'review', 'done'\]\)/);
  assert.match(js, /task\.recordType === 'planned'/);
  assert.match(js, /task\.recordType !== 'planned'/);
  assert.match(js, /statusUi\.taskStatus/);
  assert.match(js, /sourceTaskId: task\.id/);
});

test('planner mutations use task revisions and idempotent sends', () => {
  assert.match(js, /Math\.max\(1, Number\(task && task\.planningRevision\)/);
  assert.match(js, /const openRevision = Math\.max\(1, Number\(task\.planningRevision\)/);
  assert.match(js, /handleDrawerAction\(task\.id, action\.dataset\.drawerAction, action, openRevision\)/);
  assert.match(js, /expectedRevisionBody\(task, \{[\s\S]*?workflowStage: targetStage,[\s\S]*?\}, openRevision\)/);
  assert.match(js, /\/api\/task-board\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/move/);
  assert.match(js, /\/api\/task-board\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/update/);
  assert.match(js, /sendIdForTask\(taskId\)/);
  assert.match(js, /state\.sendIds\.delete/);
  assert.match(js, /isConflict\(error\)/);
  assert.match(js, /id="planner-edit-title" name="title" maxlength="40"/);
});

test('planner refresh and responsive access paths are wired', () => {
  assert.match(js, /const epoch = \+\+state\.loadEpoch/);
  assert.match(js, /incomingRevision < state\.revision/);
  assert.match(js, /window\.onTaskBoardUpdate/);
  assert.match(js, /name="workflowStage"/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /\.planner-column\.is-mobile-active/);
});

test('planner copy is present in both generated source catalogs', () => {
  const required = [
    'plannerTaskCenter', 'plannerBoard', 'plannerHistory', 'plannerNeedsMe',
    'plannerNewTask', 'plannerSaveInbox', 'plannerSaveStart', 'plannerAcceptance',
  ];
  for (const key of required) {
    assert.equal(typeof zh[key], 'string', `missing zh.${key}`);
    assert.equal(typeof en[key], 'string', `missing en.${key}`);
    assert.ok(zh[key].length > 0 && en[key].length > 0, `empty planner copy: ${key}`);
  }
});
