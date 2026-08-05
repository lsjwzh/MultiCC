'use strict';

// clearErrorFlagsForSucceededTurn is the close-time veto that keeps mid-stream
// error noise from classifying a turn that provably succeeded (durable final
// result + clean close) as an API error. The veto is only sound because
// turn.resultDurable is exclusively set for persisted non-error results, so a
// real API failure can never reach it — these tests pin both directions.

const assert = require('assert');
const { clearErrorFlagsForSucceededTurn } = require('../src/chat/turn-lifecycle');

function stateful(over = {}) {
  return {
    turn: { resultDurable: true },
    runner: { sawApiError: true, apiErrorRaw: { code: 'error' }, adapterError: 'boom' },
    cs: { _sawApiError: true, _adapterError: 'boom' },
    ...over,
  };
}

{
  // The incident shape: codex emitted a housekeeping error item mid-stream,
  // then exited 0 with the result durably saved.
  const { turn, runner, cs } = stateful();
  const cleared = clearErrorFlagsForSucceededTurn(turn, runner, cs, { code: 0, killReason: null });
  assert.strictEqual(cleared, true);
  assert.strictEqual(runner.sawApiError, false);
  assert.strictEqual(runner.apiErrorRaw, null);
  assert.strictEqual(runner.adapterError, null);
  assert.strictEqual(cs._sawApiError, false);
  assert.strictEqual(cs._adapterError, null);
}

{
  // Streaming path passes no exit code; a durable result alone is proof.
  const { turn, runner, cs } = stateful();
  const cleared = clearErrorFlagsForSucceededTurn(turn, runner, cs, { killReason: null });
  assert.strictEqual(cleared, true);
  assert.strictEqual(runner.sawApiError, false);
}

{
  // Non-zero exit keeps the flags: the classifier must still see them.
  const { turn, runner } = stateful();
  const cleared = clearErrorFlagsForSucceededTurn(turn, runner, null, { code: 1, killReason: null });
  assert.strictEqual(cleared, false);
  assert.strictEqual(runner.sawApiError, true);
  assert.ok(runner.apiErrorRaw);
}

{
  // User/lifecycle kills keep the flags.
  const { turn, runner } = stateful();
  const cleared = clearErrorFlagsForSucceededTurn(turn, runner, null, { code: 0, killReason: 'user' });
  assert.strictEqual(cleared, false);
  assert.strictEqual(runner.sawApiError, true);
}

{
  // No durable result → a real failure (e.g. turn.failed then exit 0) still
  // classifies; the veto must never swallow it.
  const { turn, runner } = stateful({ turn: { resultDurable: false } });
  const cleared = clearErrorFlagsForSucceededTurn(turn, runner, null, { code: 0, killReason: null });
  assert.strictEqual(cleared, false);
  assert.strictEqual(runner.sawApiError, true);
}

{
  // A clean turn with no flags is a no-op.
  const turn = { resultDurable: true };
  const runner = { sawApiError: false, apiErrorRaw: null, adapterError: null };
  const cleared = clearErrorFlagsForSucceededTurn(turn, runner, null, { code: 0, killReason: null });
  assert.strictEqual(cleared, false);
}

console.log('test-turn-error-veto: OK (6 assertions)');
