'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHostPrompts } = require('../src/chat/host-prompts');
const prompt = createHostPrompts({ PORT: '3000' }).multiccImgHint;

test('worktree prompt distinguishes same-session busy from real sync conflicts', () => {
  assert.match(prompt, /does not call "its own session's sync" endpoint/);
  assert.match(prompt, /returns HTTP 409 busy by design/);
  assert.match(prompt, /Self-sync: align with the local base branch directly with Git/);
  assert.match(prompt, /git status --short/);
  assert.match(prompt, /git rev-list --left-right --count HEAD\.\.\.main/);
  assert.match(prompt, /only `0 0` means fully aligned/);
  assert.match(prompt, /Stop and report when dirty, of unclear ownership, or in conflict/);
  assert.match(prompt, /do not mistake the endpoint's `unmerged` wording for a Git index conflict/);
});
