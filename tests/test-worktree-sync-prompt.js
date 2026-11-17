'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHostPrompts } = require('../src/chat/host-prompts');
const prompt = createHostPrompts({ PORT: '3000' }).multiccImgHint;

test('worktree prompt distinguishes same-session busy from real sync conflicts', () => {
  assert.match(prompt, /not the required path for an agent to sync itself \(a running session gets 409 busy by design\)/);
  assert.match(prompt, /Self-sync: align with the local base branch directly with Git/);
  assert.match(prompt, /git status --short/);
  assert.match(prompt, /git rev-list --left-right --count HEAD\.\.\.main/);
  assert.match(prompt, /only `0 0` means fully aligned/);
  assert.match(prompt, /stop and report when dirty, conflicted or of unclear ownership/);
  assert.match(prompt, /do not mistake the endpoint's `unmerged` wording for a Git index conflict/);
});

test('commit guidance respects Git configuration without imposing a language', () => {
  assert.doesNotMatch(prompt, /commit messages .*must be written in English/);
  assert.doesNotMatch(prompt, /release notes .*must be written in English/);
  assert.match(prompt, /Let Git use the user’s own configuration, command arguments and environment/);
});
