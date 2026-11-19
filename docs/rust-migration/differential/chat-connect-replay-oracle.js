'use strict';
// Generates the exhaustive comparison corpus for
// multicc_core::chat_connect_replay from the frozen Node implementation
// tests/helpers/legacy-chat-connect-replay.js.
//
//   node docs/rust-migration/differential/chat-connect-replay-oracle.js
//
// The fact space is small enough to enumerate completely, so the corpus is
// every reachable combination rather than a sample. Each case records the
// facts, the ordered steps and the buffer length the session is left with:
// the inline `cs.streamReplay = []` is a state mutation the kernel has to
// reproduce, not just a skipped send.
const fs = require('node:fs');
const path = require('node:path');
const { connectPlan } = require('../../../tests/helpers/legacy-chat-connect-replay');

const cases = [];
for (const replayMessages of [0, 1, 3]) {
  for (const lastRole of ['assistant', 'user']) {
    for (const isStreaming of [false, true]) {
      for (const buffered of [0, 1, 12]) {
        for (const hasTokenUsage of [false, true]) {
          for (const hasSeed of [false, true]) {
            const messages = Array.from({ length: replayMessages }, (_, i) => ({
              role: i === replayMessages - 1 ? lastRole : 'user',
            }));
            const cs = {
              isStreaming,
              streamReplay: Array.from({ length: buffered }, (_, i) => ({ seq: i })),
            };
            const steps = connectPlan({
              replayMessages: messages,
              cs,
              sessionTokenUsage: hasTokenUsage ? { total: 1 } : null,
              taskStateSeed: () => (hasSeed ? { type: 'task_state' } : null),
            });
            cases.push({
              facts: {
                replayMessages,
                lastMessageIsAssistant: replayMessages > 0 && lastRole === 'assistant',
                isStreaming,
                bufferedEvents: buffered,
                hasTokenUsage,
                hasTaskStateSeed: hasSeed,
              },
              steps,
              // What the session's buffer holds once the connect path is done.
              bufferAfter: cs.streamReplay.length,
            });
          }
        }
      }
    }
  }
}
const out = path.join(__dirname, 'chat-connect-replay-golden.json');
fs.writeFileSync(out, `${JSON.stringify({ cases }, null, 2)}\n`);
console.log(`wrote ${cases.length} cases to ${path.relative(process.cwd(), out)}`);
