'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scheduledSend = require('../public/chat-scheduled-send.js');

test('delay parsing supports seconds through days and enforces the seven-day boundary', () => {
  assert.equal(scheduledSend.parseDelaySeconds(30, 'seconds'), 30);
  assert.equal(scheduledSend.parseDelaySeconds(10, 'minutes'), 600);
  assert.equal(scheduledSend.parseDelaySeconds(1.5, 'hours'), 5400);
  assert.equal(scheduledSend.parseDelaySeconds(7, 'days'), 604800);
  assert.equal(scheduledSend.parseDelaySeconds(8, 'days'), null);
  assert.equal(scheduledSend.parseDelaySeconds(0, 'minutes'), null);
  assert.equal(scheduledSend.parseDelaySeconds('nope', 'hours'), null);
  assert.equal(scheduledSend.parseDelaySeconds(1, 'weeks'), null);
  assert.match(scheduledSend.formatRemaining(31_000, 1_000), /30/);
  assert.match(scheduledSend.formatRemaining(3_601_000, 1_000), /1/);
});

test('scheduled message API scopes create, list and cancel requests to one encoded session', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: options.method === 'POST' ? 201 : 200,
      async json() {
        if (options.method === 'POST') return { ok: true, scheduledMessage: { id: 'scheduled:1' } };
        if (options.method === 'DELETE') return { ok: true, id: 'scheduled:1' };
        return { ok: true, scheduledMessages: [] };
      },
    };
  };
  const api = scheduledSend.createScheduledMessageApi({ fetch, sessionId: 'chat/a b' });
  await api.create('later', 600, 'retry-key');
  await api.list();
  await api.cancel('scheduled:1');

  assert.equal(calls[0].url, '/api/sessions/chat%2Fa%20b/scheduled-messages');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'retry-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), { message: 'later', delaySeconds: 600 });
  assert.equal(calls[1].options.cache, 'no-store');
  assert.equal(calls[2].url, '/api/sessions/chat%2Fa%20b/scheduled-messages/scheduled%3A1');
  assert.equal(calls[2].options.method, 'DELETE');
});

test('controller includes uploaded paths and routing decoration, clearing the draft only after success', async () => {
  const created = [];
  const chips = ['/tmp/a.png', '/tmp/b.txt'].map(value => ({
    dataset: { path: value }, removed: false,
    remove() { this.removed = true; },
  }));
  const attachArea = {
    children: chips,
    classList: { toggle() {} },
    querySelectorAll() { return chips; },
  };
  const input = { value: '检查附件', style: { height: '80px' }, dispatchEvent() {} };
  const controller = scheduledSend.createController({
    input,
    attachArea,
    makeId: () => 'stable-id',
    decorate: text => text + '\n\n[Dispatch] none',
    api: {
      async create(message, delaySeconds, id) {
        created.push({ message, delaySeconds, id });
        return { ok: true, scheduledMessage: { id: 'scheduled-1', dueAt: 1000 } };
      },
    },
  });

  const result = await controller.schedule(2, 'hours');
  assert.equal(result.scheduledMessage.id, 'scheduled-1');
  assert.deepEqual(created, [{
    message: '检查附件 /tmp/a.png /tmp/b.txt\n\n[Dispatch] none',
    delaySeconds: 7200,
    id: 'stable-id',
  }]);
  assert.equal(input.value, '');
  assert.equal(input.style.height, 'auto');
  assert.equal(chips.every(chip => chip.removed), true);
});

test('controller keeps the draft and reuses its idempotency key after an ambiguous failure', async () => {
  const input = { value: '不要重复投递', style: {} };
  const ids = [];
  let calls = 0;
  const controller = scheduledSend.createController({
    input,
    makeId: () => 'same-retry-key',
    api: {
      async create(_message, _delay, id) {
        ids.push(id);
        if (++calls === 1) throw new Error('connection reset after commit');
        return { ok: true, scheduledMessage: { id: 'scheduled-1' } };
      },
    },
  });

  await assert.rejects(controller.schedule(10, 'minutes'), /connection reset/);
  assert.equal(input.value, '不要重复投递');
  await controller.schedule(10, 'minutes');
  assert.deepEqual(ids, ['same-retry-key', 'same-retry-key']);
  assert.equal(input.value, '');
});

test('chat page loads the isolated scheduler before chat boot without exceeding its line budget', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/chat.html'), 'utf8');
  const scheduler = source.indexOf('chat-scheduled-send.js');
  const chatBoot = source.indexOf('<script src="chat.js"></script>');
  assert.ok(scheduler > 0 && scheduler < chatBoot);
  assert.equal(source.split('\n').length - 1 <= 3000, true);
  const moduleSource = fs.readFileSync(path.join(__dirname, '../public/chat-scheduled-send.js'), 'utf8');
  assert.equal(moduleSource.includes('.innerHTML'), false,
    'scheduled message content must stay on textContent-only render paths');
});
