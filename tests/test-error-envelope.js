'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  diagnosticText,
  fromHttpResponse,
  fromWsClose,
  normalize,
  presentation,
  visibleMessage,
} = require('../public/error-envelope');

test('coded HTTP errors keep the original code and message while redacting credentials', () => {
  const envelope = normalize({
    code: 'UPSTREAM_AUTH_403',
    error: { message: 'provider rejected token=super-secret for model glm-5' },
    requestId: 'remote-request-7',
    correlationId: 'correlation-9',
  }, { status: 403, source: 'external_fleet_ws_ticket', scope: 'session' });

  assert.equal(envelope.code, 'UPSTREAM_AUTH_403');
  assert.equal(envelope.message, 'provider rejected token=[redacted] for model glm-5');
  assert.equal(envelope.family, 'auth');
  assert.equal(envelope.retryable, false);
  assert.equal(visibleMessage(envelope),
    '[UPSTREAM_AUTH_403] provider rejected token=[redacted] for model glm-5');
  assert.doesNotMatch(JSON.stringify(envelope), /super-secret/);
});

test('Fleet capability tokens are redacted from original error text', () => {
  const token = `fleet_share_${'x'.repeat(32)}`;
  const envelope = normalize({ code: 'REMOTE_REJECTED', message: `bad capability ${token}` });
  assert.equal(envelope.message, 'bad capability fleet_share_[redacted]');
  assert.equal(diagnosticText(envelope).includes(token), false);
});

test('external Fleet failures are remote and retain cross-instance diagnostics', async () => {
  const response = {
    status: 502,
    headers: new Headers({
      'x-multicc-request-id': 'local-request-2',
      'x-multicc-upstream-request-id': 'remote-request-3',
      'x-correlation-id': 'correlation-4',
    }),
    async text() {
      return JSON.stringify({
        code: 'REMOTE_UNAVAILABLE',
        error: 'connect ECONNREFUSED 10.0.0.5:3000',
        category: 'remote',
        retryable: true,
      });
    },
  };
  const error = await fromHttpResponse(response, {
    source: 'external_fleet_ws_ticket', scope: 'session',
  });

  assert.equal(error.code, 'REMOTE_UNAVAILABLE');
  assert.equal(error.message, 'connect ECONNREFUSED 10.0.0.5:3000');
  assert.equal(error.family, 'remote');
  assert.equal(error.requestId, 'local-request-2');
  assert.equal(error.upstreamRequestId, 'remote-request-3');
  assert.equal(error.correlationId, 'correlation-4');
  assert.match(diagnosticText(error.envelope), /upstreamRequestId: remote-request-3/);
});

test('WebSocket close codes produce actionable connection envelopes', () => {
  const abnormal = fromWsClose({ code: 1006, reason: '' });
  assert.equal(abnormal.code, 'WS_CLOSE_1006');
  assert.equal(abnormal.family, 'network');
  assert.equal(abnormal.retryable, true);
  assert.match(presentation(abnormal, { retrySeconds: 2 }).message, /2s 后重试/);

  const policy = fromWsClose({ code: 1008, reason: 'grant expired' });
  assert.equal(policy.family, 'auth');
  assert.equal(policy.retryable, false);
  assert.equal(policy.message, 'grant expired');
});
