'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { assertTestDir } = require('../src/paths');
const {
  BusinessPushRequestError,
  createBusinessPushService,
  validateBusinessPushRequest,
} = require('../src/business-push');

function validRequest(overrides = {}) {
  return {
    title: '策略提醒测试',
    body: '安全验收，不含真实交易建议',
    type: 'strategy-test',
    tag: 'strategy-test.us.apex',
    url: '/manage',
    dedupeKey: 'us:apex:NVDA:BUY:2026-08-08T03:00:00+08:00',
    ...overrides,
  };
}

function deliveryStats(
  subscriberCount,
  deliveryCount,
  failureCount,
  staleCount = 0,
  remainingSubscriberCount = subscriberCount - staleCount,
) {
  return {
    subscriberCount,
    deliveryCount,
    failureCount,
    staleCount,
    remainingSubscriberCount,
  };
}

function silentLogger() {
  const warnings = [];
  return {
    warnings,
    logger: { warn(message) { warnings.push(message); } },
  };
}

function tempReceiptFile(t) {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-business-push-')));
  t.after(() => {
    assertTestDir(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return path.join(root, 'push_notification_receipts.json');
}

function assertRequestError(run, code, field) {
  assert.throws(run, error => {
    assert.equal(error instanceof BusinessPushRequestError, true);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, code === 'IDEMPOTENCY_KEY_REUSE' ? 409 : 400);
    assert.equal(error.field, field);
    return true;
  });
}

test('strict schema rejects non-record bodies, missing fields, and unknown fields', () => {
  for (const input of [null, undefined, [], 'text', 7, true, new Date()]) {
    assertRequestError(() => validateBusinessPushRequest(input), 'INVALID_REQUEST_BODY', undefined);
  }

  const inherited = Object.create({ inherited: true });
  Object.assign(inherited, validRequest());
  assertRequestError(() => validateBusinessPushRequest(inherited), 'INVALID_REQUEST_BODY', undefined);

  for (const field of ['title', 'body', 'type', 'tag', 'url', 'dedupeKey']) {
    const input = validRequest();
    delete input[field];
    assertRequestError(() => validateBusinessPushRequest(input), 'MISSING_FIELD', field);
  }

  assertRequestError(
    () => validateBusinessPushRequest({ ...validRequest(), actions: [{ action: 'open' }] }),
    'UNKNOWN_FIELD',
    'actions',
  );
  const prototypeField = JSON.parse(JSON.stringify({ ...validRequest(), __proto__: 'unsafe' })
    .replace(/}$/, ',"__proto__":"unsafe"}'));
  assertRequestError(
    () => validateBusinessPushRequest(prototypeField),
    'UNKNOWN_FIELD',
    '__proto__',
  );

  const nullPrototype = Object.assign(Object.create(null), validRequest());
  assert.deepEqual(validateBusinessPushRequest(nullPrototype), validRequest());
});

test('all request fields require strings with no surrounding whitespace', () => {
  for (const field of ['title', 'body', 'type', 'tag', 'url', 'dedupeKey']) {
    for (const value of [null, 1, true, [], {}]) {
      assertRequestError(
        () => validateBusinessPushRequest(validRequest({ [field]: value })),
        'INVALID_FIELD_TYPE',
        field,
      );
    }
    for (const value of ['', ' ', ` ${validRequest()[field]}`, `${validRequest()[field]} `]) {
      assertRequestError(
        () => validateBusinessPushRequest(validRequest({ [field]: value })),
        'INVALID_FIELD_VALUE',
        field,
      );
    }
  }
});

test('control characters and code-point length limits are enforced', () => {
  const controlCases = [
    ['title', '测试\n伪造标题'],
    ['body', '安全\r伪造内容'],
    ['type', 'strategy\t-test'],
    ['tag', 'strategy\u0000test'],
    ['url', '/manage\u007f'],
    ['dedupeKey', 'key\u0001value'],
  ];
  for (const [field, value] of controlCases) {
    assertRequestError(
      () => validateBusinessPushRequest(validRequest({ [field]: value })),
      'INVALID_CONTROL_CHARACTER',
      field,
    );
  }

  assert.equal(
    validateBusinessPushRequest(validRequest({ body: '第一行\n第二行\t说明' })).body,
    '第一行\n第二行\t说明',
    'interior LF and tab remain valid in notification bodies',
  );
  assert.equal(
    validateBusinessPushRequest(validRequest({ title: '🚀'.repeat(80) })).title,
    '🚀'.repeat(80),
    'limits count Unicode code points instead of UTF-16 code units',
  );

  const tooLong = [
    ['title', 'a'.repeat(81)],
    ['body', 'a'.repeat(2001)],
    ['type', 'a'.repeat(65)],
    ['tag', 'a'.repeat(129)],
    ['url', `/${'a'.repeat(64)}`],
    ['dedupeKey', 'a'.repeat(257)],
  ];
  for (const [field, value] of tooLong) {
    assertRequestError(
      () => validateBusinessPushRequest(validRequest({ [field]: value })),
      'FIELD_TOO_LONG',
      field,
    );
  }
});

test('type, tag, URL, and idempotency key allowlists fail closed', () => {
  for (const type of ['chat-completed', 'strategy', 'STRATEGY-TEST']) {
    assertRequestError(
      () => validateBusinessPushRequest(validRequest({ type })),
      'UNSUPPORTED_NOTIFICATION_TYPE',
      'type',
    );
  }
  assert.equal(
    validateBusinessPushRequest(validRequest({ type: 'strategy-actionable' })).type,
    'strategy-actionable',
  );

  for (const tag of ['strategy/test', 'strategy test', '策略-test', 'strategy?test']) {
    assertRequestError(
      () => validateBusinessPushRequest(validRequest({ tag })),
      'INVALID_FIELD_VALUE',
      'tag',
    );
  }
  assert.equal(validateBusinessPushRequest(validRequest({ tag: 'a:B_c-1.2' })).tag, 'a:B_c-1.2');

  for (const url of [
    '/',
    '/api/push/test',
    '/manage?token=secret',
    '/manage#section',
    '//evil.example/manage',
    'https://evil.example/manage',
    'javascript:alert(1)',
    '/login',
  ]) {
    assertRequestError(
      () => validateBusinessPushRequest(validRequest({ url })),
      'UNSAFE_NOTIFICATION_URL',
      'url',
    );
  }

  for (const dedupeKey of ['key/value', 'key value', '策略:key', 'key?value']) {
    assertRequestError(
      () => validateBusinessPushRequest(validRequest({ dedupeKey })),
      'INVALID_FIELD_VALUE',
      'dedupeKey',
    );
  }
  const safeKey = 'cn|apex_d50|600000.SS|BUY|2026-08-08T10:00:00+08:00';
  assert.equal(validateBusinessPushRequest(validRequest({ dedupeKey: safeKey })).dedupeKey, safeKey);
});

test('a complete delivery returns auditable counts and strips server-only fields', async () => {
  const calls = [];
  const service = createBusinessPushService({
    async sendPushToAll(payload) {
      calls.push(payload);
      return deliveryStats(4, 4, 0);
    },
    logger: silentLogger().logger,
  });

  const result = await service.notify(validRequest({ type: 'strategy-actionable' }));
  assert.deepEqual(result, {
    statusCode: 200,
    body: {
      ok: true,
      delivered: true,
      deduped: false,
      dedupe_persisted: false,
      subscriber_count: 4,
      delivery_count: 4,
      failure_count: 0,
      stale_count: 0,
      remaining_subscriber_count: 4,
    },
  });
  assert.deepEqual(calls, [{
    title: '策略提醒测试',
    body: '安全验收，不含真实交易建议',
    type: 'strategy-actionable',
    tag: 'strategy-test.us.apex',
    url: '/manage',
  }]);
  assert.equal(Object.isFrozen(calls[0]), true);
  assert.equal(Object.hasOwn(calls[0], 'dedupeKey'), false);
});

test('zero subscribers, partial failure, full failure, and transport throw never report delivery', async () => {
  const scenarios = [
    {
      stats: deliveryStats(0, 0, 0),
      statusCode: 503,
      error: 'NO_PUSH_SUBSCRIBERS',
      partial: undefined,
    },
    {
      stats: deliveryStats(4, 3, 1),
      statusCode: 502,
      error: 'PUSH_DELIVERY_INCOMPLETE',
      partial: true,
    },
    {
      stats: deliveryStats(4, 0, 4, 1, 3),
      statusCode: 502,
      error: 'PUSH_DELIVERY_INCOMPLETE',
      partial: false,
    },
  ];
  for (const scenario of scenarios) {
    const service = createBusinessPushService({
      sendPushToAll: async () => scenario.stats,
      logger: silentLogger().logger,
    });
    const result = await service.notify(validRequest({ dedupeKey: `case:${scenario.error}:${scenario.partial}` }));
    assert.equal(result.statusCode, scenario.statusCode);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.delivered, false);
    assert.equal(result.body.deduped, false);
    assert.equal(result.body.error, scenario.error);
    assert.equal(result.body.subscriber_count, scenario.stats.subscriberCount);
    assert.equal(result.body.delivery_count, scenario.stats.deliveryCount);
    assert.equal(result.body.failure_count, scenario.stats.failureCount);
    if (scenario.partial === undefined) assert.equal(Object.hasOwn(result.body, 'partial'), false);
    else assert.equal(result.body.partial, scenario.partial);
  }

  const observed = silentLogger();
  const service = createBusinessPushService({
    async sendPushToAll() { throw new Error('secret transport detail'); },
    logger: observed.logger,
  });
  const result = await service.notify(validRequest({ dedupeKey: 'transport:throw' }));
  assert.equal(result.statusCode, 502);
  assert.deepEqual(result.body, {
    ok: false,
    delivered: false,
    deduped: false,
    subscriber_count: 0,
    delivery_count: 0,
    failure_count: 0,
    stale_count: 0,
    remaining_subscriber_count: 0,
    error: 'PUSH_DELIVERY_ERROR',
  });
  assert.equal(observed.warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret transport detail/);
});

test('invalid transport statistics fail closed instead of fabricating delivery', async () => {
  const invalidResults = [
    undefined,
    {},
    deliveryStats(2, 2, 1),
    deliveryStats(2, -1, 3),
    deliveryStats(2, 2, 0, 1, 3),
  ];
  for (let index = 0; index < invalidResults.length; index++) {
    const service = createBusinessPushService({
      sendPushToAll: async () => invalidResults[index],
      logger: silentLogger().logger,
    });
    const result = await service.notify(validRequest({ dedupeKey: `invalid:stats:${index}` }));
    assert.equal(result.statusCode, 502);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.delivered, false);
    assert.equal(result.body.error, 'INVALID_DELIVERY_RESULT');
  }
});

test('successful duplicate is sent once, while key reuse with another payload is rejected', async () => {
  let calls = 0;
  const service = createBusinessPushService({
    async sendPushToAll() { calls++; return deliveryStats(2, 2, 0); },
    logger: silentLogger().logger,
  });
  const input = validRequest({ dedupeKey: 'duplicate:success' });

  const first = await service.notify(input);
  const duplicate = await service.notify({ ...input });
  assert.equal(calls, 1);
  assert.equal(first.body.delivered, true);
  assert.equal(first.body.deduped, false);
  assert.equal(duplicate.body.delivered, true);
  assert.equal(duplicate.body.deduped, true);
  assert.equal(duplicate.body.delivery_count, 2);

  await assert.rejects(
    service.notify({ ...input, body: '同一事件键的不同内容' }),
    error => {
      assert.equal(error instanceof BusinessPushRequestError, true);
      assert.equal(error.code, 'IDEMPOTENCY_KEY_REUSE');
      assert.equal(error.field, 'dedupeKey');
      assert.equal(error.statusCode, 409);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('concurrent duplicate calls collapse into one transport operation', async () => {
  let release;
  let calls = 0;
  const transport = new Promise(resolve => { release = resolve; });
  const service = createBusinessPushService({
    sendPushToAll() { calls++; return transport; },
    logger: silentLogger().logger,
  });
  const input = validRequest({ dedupeKey: 'duplicate:concurrent' });

  const firstPromise = service.notify(input);
  const secondPromise = service.notify({ ...input });
  assert.equal(calls, 1);
  release(deliveryStats(3, 3, 0));
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(calls, 1);
  assert.equal(first.body.delivered, true);
  assert.equal(first.body.deduped, false);
  assert.equal(second.body.delivered, true);
  assert.equal(second.body.deduped, true);
});

test('failed attempts do not burn the idempotency key and can be retried', async () => {
  let calls = 0;
  const outcomes = [deliveryStats(2, 1, 1), deliveryStats(2, 2, 0)];
  const service = createBusinessPushService({
    async sendPushToAll() { return outcomes[calls++]; },
    logger: silentLogger().logger,
  });
  const input = validRequest({ dedupeKey: 'retry:after-failure' });

  const failed = await service.notify(input);
  const retried = await service.notify(input);
  const duplicate = await service.notify(input);
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body.delivered, false);
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.body.delivered, true);
  assert.equal(retried.body.deduped, false);
  assert.equal(duplicate.body.deduped, true);
  assert.equal(calls, 2);
});

test('receipt write failure does not deny an already completed delivery or resend in-process', async () => {
  let calls = 0;
  const observed = silentLogger();
  const service = createBusinessPushService({
    receiptsFile: '/unused/test-receipts.json',
    async sendPushToAll() { calls++; return deliveryStats(2, 2, 0); },
    writeJson() { throw new Error('token=receipt-secret'); },
    logger: observed.logger,
  });
  const input = validRequest({ dedupeKey: 'receipt:write-failure' });

  const delivered = await service.notify(input);
  const duplicate = await service.notify(input);
  assert.equal(delivered.body.delivered, true);
  assert.equal(delivered.body.dedupe_persisted, false);
  assert.equal(duplicate.body.delivered, true);
  assert.equal(duplicate.body.deduped, true);
  assert.equal(duplicate.body.dedupe_persisted, false);
  assert.equal(calls, 1);
  assert.equal(observed.warnings.length, 2);
  assert.doesNotMatch(observed.warnings.join('\n'), /receipt-secret/);
});

test('successful receipts persist without raw event data and dedupe across service instances', async t => {
  const receiptsFile = tempReceiptFile(t);
  let firstCalls = 0;
  const firstService = createBusinessPushService({
    receiptsFile,
    async sendPushToAll() { firstCalls++; return deliveryStats(4, 4, 0); },
    logger: silentLogger().logger,
    now: () => 1_000,
  });
  const input = validRequest({ dedupeKey: 'persistent:cross-instance' });
  const first = await firstService.notify(input);
  assert.equal(first.body.dedupe_persisted, true);
  assert.equal(firstCalls, 1);
  assert.equal(fs.existsSync(receiptsFile), true);

  const storedText = fs.readFileSync(receiptsFile, 'utf8');
  const stored = JSON.parse(storedText);
  assert.equal(stored.version, 1);
  assert.equal(Object.keys(stored.receipts).length, 1);
  assert.equal(fs.statSync(receiptsFile).mode & 0o777, 0o600);
  assert.doesNotMatch(storedText, /persistent:cross-instance/);
  assert.doesNotMatch(storedText, /安全验收/);

  let secondCalls = 0;
  const secondService = createBusinessPushService({
    receiptsFile,
    async sendPushToAll() { secondCalls++; return deliveryStats(4, 4, 0); },
    logger: silentLogger().logger,
    now: () => 1_001,
  });
  const duplicate = await secondService.notify(input);
  assert.equal(secondCalls, 0);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.body.delivered, true);
  assert.equal(duplicate.body.deduped, true);
  assert.equal(duplicate.body.dedupe_persisted, true);
  assert.equal(duplicate.body.subscriber_count, 4);
});

test('receipt TTL expiry and capacity eviction permit a fresh delivery', async t => {
  const ttlReceipts = tempReceiptFile(t);
  let now = 100;
  let ttlCalls = 0;
  const ttlService = createBusinessPushService({
    receiptsFile: ttlReceipts,
    ttlMs: 10,
    now: () => now,
    async sendPushToAll() { ttlCalls++; return deliveryStats(1, 1, 0); },
    logger: silentLogger().logger,
  });
  const ttlInput = validRequest({ dedupeKey: 'receipt:ttl' });
  await ttlService.notify(ttlInput);
  now = 110;
  assert.equal((await ttlService.notify(ttlInput)).body.deduped, true,
    'the exact TTL boundary is still covered');
  now = 111;
  assert.equal((await ttlService.notify(ttlInput)).body.deduped, false,
    'the first instant beyond TTL requires a new delivery');
  assert.equal(ttlCalls, 2);

  const capacityReceipts = tempReceiptFile(t);
  now = 1_000;
  let capacityCalls = 0;
  const capacityService = createBusinessPushService({
    receiptsFile: capacityReceipts,
    maxReceipts: 2,
    now: () => now,
    async sendPushToAll() { capacityCalls++; return deliveryStats(1, 1, 0); },
    logger: silentLogger().logger,
  });
  for (const suffix of ['oldest', 'middle', 'newest']) {
    await capacityService.notify(validRequest({ dedupeKey: `receipt:${suffix}` }));
    now++;
  }
  const stored = JSON.parse(fs.readFileSync(capacityReceipts, 'utf8'));
  assert.equal(Object.keys(stored.receipts).length, 2);
  const oldestAgain = await capacityService.notify(validRequest({ dedupeKey: 'receipt:oldest' }));
  assert.equal(oldestAgain.body.deduped, false);
  assert.equal(capacityCalls, 4);
});
