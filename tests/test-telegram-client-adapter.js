'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  createTelegramClient,
  resolveTelegramBotConstructor,
} = require('../plugins/bridges/telegram-client-adapter');

class FakeTelegramBot extends EventEmitter {
  static instances = [];

  constructor(token, options) {
    super();
    this.token = token;
    this.options = options;
    this.calls = [];
    FakeTelegramBot.instances.push(this);
  }

  async startPolling() { this.calls.push(['startPolling']); }
  async stopPolling(options) { this.calls.push(['stopPolling', options]); }
  async openWebHook() { this.calls.push(['openWebHook']); }
  async closeWebHook() { this.calls.push(['closeWebHook']); }
  async sendMessage(chatId, text, options) {
    this.calls.push(['sendMessage', chatId, text, options]);
    return { message_id: 7, chat: { id: chatId }, text };
  }
}

test('Telegram SDK stays lazy and supports 1.x named CommonJS export polling lifecycle', async () => {
  FakeTelegramBot.instances.length = 0;
  let loads = 0;
  const client = createTelegramClient({
    token: 'test-token',
    transport: 'polling',
    polling: { interval: 25 },
    sdkLoader: () => { loads += 1; return { TelegramBot: FakeTelegramBot }; },
  });
  assert.equal(loads, 1);
  const bot = FakeTelegramBot.instances[0];
  assert.deepEqual(bot.options, {
    polling: { interval: 25, autoStart: false },
    webHook: false,
  });
  assert.deepEqual(bot.calls, [], 'constructor must not auto-start polling');

  let inbound = null;
  client.onMessage(message => { inbound = message; });
  await client.start();
  bot.emit('message', { chat: { id: 42 }, text: 'hello' });
  assert.equal(inbound.text, 'hello');
  assert.equal(client.isRunning(), true);

  const sent = await client.sendMessage(42, 'reply', { disable_notification: true });
  assert.equal(sent.message_id, 7);
  await client.stop();
  assert.equal(client.isRunning(), false);
  assert.deepEqual(bot.calls, [
    ['startPolling'],
    ['sendMessage', 42, 'reply', { disable_notification: true }],
    ['stopPolling', { cancel: true, reason: 'MultiCC bridge stopped' }],
  ]);
});

test('webhook lifecycle uses autoOpen:false and never starts polling', async () => {
  FakeTelegramBot.instances.length = 0;
  const client = createTelegramClient({
    token: 'webhook-token',
    transport: 'webhook',
    webhook: { host: '127.0.0.1', port: 9443, secretToken: 'not-a-real-secret' },
    sdkLoader: () => ({ default: FakeTelegramBot }),
  });
  const bot = FakeTelegramBot.instances[0];
  assert.deepEqual(bot.options, {
    polling: false,
    webHook: { host: '127.0.0.1', port: 9443, secretToken: 'not-a-real-secret', autoOpen: false },
  });
  await client.start();
  await client.stop();
  assert.deepEqual(bot.calls, [['openWebHook'], ['closeWebHook']]);
});

test('legacy direct constructor export remains accepted behind the adapter', () => {
  assert.equal(resolveTelegramBotConstructor(FakeTelegramBot), FakeTelegramBot);
  assert.equal(resolveTelegramBotConstructor({ TelegramBot: FakeTelegramBot }), FakeTelegramBot);
  assert.equal(resolveTelegramBotConstructor({ default: FakeTelegramBot }), FakeTelegramBot);
  assert.throws(() => resolveTelegramBotConstructor({}), error => error.code === 'TELEGRAM_SDK_EXPORT_INVALID');
});

test('failed transport start remains stoppable for fail-safe cleanup', async () => {
  class PartiallyStartedBot extends FakeTelegramBot {
    async startPolling() {
      this.calls.push(['startPolling']);
      throw new Error('simulated polling failure');
    }
  }
  const client = createTelegramClient({
    token: 'failure-token',
    transport: 'polling',
    sdkLoader: () => ({ TelegramBot: PartiallyStartedBot }),
  });
  const bot = PartiallyStartedBot.instances.at(-1);
  await assert.rejects(client.start(), /simulated polling failure/);
  assert.equal(client.isRunning(), false);
  await client.stop();
  assert.deepEqual(bot.calls, [
    ['startPolling'],
    ['stopPolling', { cancel: true, reason: 'MultiCC bridge stopped' }],
  ]);
});

test('installed 1.x package can be loaded and constructed without network activation', async () => {
  const client = createTelegramClient({ token: '000000:test-only-token', transport: 'polling' });
  assert.equal(client.isRunning(), false);
  await client.stop();
});

test('Telegram bridge has no eager SDK import and disabled startup remains isolated', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'bridges', 'telegram-bridge.js'), 'utf8');
  const adapter = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'bridges', 'telegram-client-adapter.js'), 'utf8');
  assert.equal(/require\(['"]node-telegram-bot-api['"]\)/.test(bridge), false);
  assert.equal((adapter.match(/require\(['"]node-telegram-bot-api['"]\)/g) || []).length, 1);
  assert.match(bridge, /createTelegramClient\(\{ token: _config\.botToken, transport: 'polling' \}\)/);
});
