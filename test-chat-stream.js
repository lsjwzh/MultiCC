'use strict';
// Standalone proof for src/chat-stream.js — no server needed.
// Verifies: one warm process across turns, in-context memory, turn boundary on
// `result`, and the inject() continuation path (the "data returned" case).
const crypto = require('crypto');
const stream = require('./src/chat-stream');

const NAME = 'test-stream-' + Date.now();
const CLAUDE = process.env.CLAUDE_CMD || 'claude';
const T = Date.now();
const ts = () => `${((Date.now() - T) / 1000).toFixed(1)}s`;

function collectText(label) {
  let text = '';
  return {
    onEvent: (evt) => {
      if (evt.type === 'assistant' && evt.message?.content) {
        for (const b of evt.message.content) if (b.type === 'text') text += b.text;
      }
    },
    get text() { return text.trim(); },
    label,
  };
}

(async () => {
  stream.ensure(NAME, {
    cmd: CLAUDE,
    cwd: process.cwd(),
    sessionId: crypto.randomUUID(),
    model: 'haiku',
    sysPrompt: 'You are a terse test bot. Answer in as few words as possible.',
  });

  // Turn 1
  let c = collectText('turn1');
  console.log(`[${ts()}] send turn1`);
  await stream.send(NAME, 'Remember the secret word is BANANA. Reply just: OK', c.onEvent);
  console.log(`[${ts()}] turn1 done. reply="${c.text}" status=${JSON.stringify(stream.status(NAME))}`);

  // Turn 2 — proves in-context memory + same warm process (no --resume)
  c = collectText('turn2');
  console.log(`[${ts()}] send turn2 (same process should still be alive: ${stream.isAlive(NAME)})`);
  await stream.send(NAME, 'What was the secret word? Reply just the word.', c.onEvent);
  console.log(`[${ts()}] turn2 done. reply="${c.text}"  <-- expect BANANA`);

  // Simulate the user's case: model "waits for data", then a driver INJECTS it.
  c = collectText('wait');
  console.log(`[${ts()}] send a 'waiting' turn`);
  await stream.send(NAME, 'I am fetching a number from an API. Acknowledge with: WAITING', c.onEvent);
  console.log(`[${ts()}] waiting-turn done. reply="${c.text}"  (process idles, does NOT self-continue)`);

  c = collectText('inject');
  console.log(`[${ts()}] inject 'data returned' continuation`);
  await stream.inject(NAME, '[API returned] the number is 42. Now reply: GOT 42', c.onEvent);
  console.log(`[${ts()}] inject done. reply="${c.text}"  <-- expect GOT 42, in same context`);

  // Cancel / teardown
  console.log(`[${ts()}] status before close=${JSON.stringify(stream.status(NAME))}`);
  stream.close(NAME);
  console.log(`[${ts()}] closed. alive=${stream.isAlive(NAME)}`);
  setTimeout(() => process.exit(0), 500);
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
