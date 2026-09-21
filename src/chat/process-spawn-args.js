'use strict';

function processSpawnArgs(invocation, settingsFile = null) {
  const args = [...invocation.args];
  if (settingsFile) {
    const hasPromptSeparator = args.at(-1) === '--';
    if (hasPromptSeparator) args.pop();
    args.push('--settings', settingsFile);
    if (hasPromptSeparator) args.push('--');
  }
  args.push(invocation.payload);
  return args;
}

module.exports = { processSpawnArgs };
