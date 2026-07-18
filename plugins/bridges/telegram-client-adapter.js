'use strict';

// Narrow compatibility boundary for node-telegram-bot-api.  Version 0.6x
// exported the constructor directly; 1.x CommonJS exports it as
// { TelegramBot, default }.  The bridge never needs to know which shape was
// loaded and the SDK remains lazy until a bridge is explicitly started.

class TelegramClientAdapterError extends Error {
  constructor(message, code = 'TELEGRAM_ADAPTER_ERROR', cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TelegramClientAdapterError';
    this.code = code;
  }
}

function loadTelegramSdk() {
  try {
    return require('node-telegram-bot-api');
  } catch (error) {
    throw new TelegramClientAdapterError(
      'node-telegram-bot-api 未安装或无法加载，请先运行 npm install',
      'TELEGRAM_SDK_UNAVAILABLE',
      error,
    );
  }
}

function resolveTelegramBotConstructor(sdk) {
  const Constructor = typeof sdk === 'function'
    ? sdk
    : (sdk && (sdk.TelegramBot || sdk.default));
  if (typeof Constructor !== 'function') {
    throw new TelegramClientAdapterError(
      'node-telegram-bot-api 导出不兼容',
      'TELEGRAM_SDK_EXPORT_INVALID',
    );
  }
  return Constructor;
}

function createTelegramClient({
  token,
  transport = 'polling',
  polling = {},
  webhook = {},
  sdkLoader = loadTelegramSdk,
} = {}) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw new TelegramClientAdapterError('Telegram Bot Token required', 'TELEGRAM_TOKEN_REQUIRED');
  if (transport !== 'polling' && transport !== 'webhook') {
    throw new TelegramClientAdapterError('Telegram transport must be polling or webhook', 'TELEGRAM_TRANSPORT_INVALID');
  }

  const TelegramBot = resolveTelegramBotConstructor(sdkLoader());
  // Disable constructor auto-start/open so listeners are installed before any
  // update or transport error can arrive.  start() is the only activation edge.
  const options = transport === 'polling'
    ? { polling: { ...polling, autoStart: false }, webHook: false }
    : { polling: false, webHook: { ...webhook, autoOpen: false } };
  const bot = new TelegramBot(cleanToken, options);
  let running = false;
  let startAttempted = false;

  function on(event, listener) {
    if (!bot || typeof bot.on !== 'function') {
      throw new TelegramClientAdapterError('Telegram SDK event API unavailable', 'TELEGRAM_EVENT_API_UNAVAILABLE');
    }
    bot.on(event, listener);
    return client;
  }

  const client = Object.freeze({
    transport,
    onMessage: listener => on('message', listener),
    onPollingError: listener => on('polling_error', listener),
    onWebhookError: listener => on('webhook_error', listener),
    async start() {
      if (running || startAttempted) return;
      const method = transport === 'polling' ? 'startPolling' : 'openWebHook';
      if (typeof bot[method] !== 'function') {
        throw new TelegramClientAdapterError(`Telegram SDK ${method} unavailable`, 'TELEGRAM_LIFECYCLE_API_UNAVAILABLE');
      }
      startAttempted = true;
      await bot[method]();
      running = true;
    },
    async stop() {
      // A transport may allocate resources before its start promise rejects.
      // Preserve that attempted state so the bridge's failure cleanup can
      // still invoke the matching SDK close method.
      if (!running && !startAttempted) return;
      const method = transport === 'polling' ? 'stopPolling' : 'closeWebHook';
      if (typeof bot[method] !== 'function') {
        running = false;
        startAttempted = false;
        throw new TelegramClientAdapterError(`Telegram SDK ${method} unavailable`, 'TELEGRAM_LIFECYCLE_API_UNAVAILABLE');
      }
      try {
        await bot[method](...(transport === 'polling' ? [{ cancel: true, reason: 'MultiCC bridge stopped' }] : []));
      } finally {
        running = false;
        startAttempted = false;
      }
    },
    async sendMessage(chatId, text, options) {
      if (typeof bot.sendMessage !== 'function') {
        throw new TelegramClientAdapterError('Telegram SDK sendMessage unavailable', 'TELEGRAM_SEND_API_UNAVAILABLE');
      }
      return bot.sendMessage(chatId, text, options);
    },
    isRunning: () => running,
  });
  return client;
}

module.exports = {
  TelegramClientAdapterError,
  createTelegramClient,
  loadTelegramSdk,
  resolveTelegramBotConstructor,
};
