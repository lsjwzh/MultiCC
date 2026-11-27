'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const WebSocket = require('ws');
const { outboundAgent } = require('../native/binding').outbound;

// Preserve the SDK's response interceptors ($return_headers, payload decoding)
// without changing its shared axios singleton or trusting axios' proxy discovery.
function createLarkHttpInstance(base) {
  const request = (config) => base.request({
    ...config, httpAgent: outboundAgent, httpsAgent: outboundAgent, proxy: false,
  });
  request.request = request;
  for (const method of ['get', 'delete', 'head', 'options']) {
    request[method] = (url, config) => request({ ...config, url, method });
  }
  for (const method of ['post', 'put', 'patch']) {
    request[method] = (url, data, config) => request({ ...config, url, data, method });
  }
  return request;
}

let discordWs;
function loadDiscordWs() {
  if (discordWs) return discordWs;
  // discord.js 14 / @discordjs/ws 1.x exposes buildStrategy, but does not
  // forward a WebSocket agent or factory. Load its strategy in a private module
  // instance with only the ws constructor replaced. Neither require.cache nor
  // the global WebSocket / shared ws package is mutated.
  const discordRequire = Module.createRequire(require.resolve('discord.js'));
  const filename = discordRequire.resolve('@discordjs/ws');
  const localRequire = Module.createRequire(filename);
  class OutboundWebSocket extends WebSocket {
    constructor(url, protocols, options) {
      super(url, protocols, { ...options, agent: outboundAgent });
    }
  }
  OutboundWebSocket.WebSocket = OutboundWebSocket;
  const scoped = new Module(filename, module);
  scoped.filename = filename;
  scoped.paths = Module._nodeModulePaths(path.dirname(filename));
  let injected = false;
  scoped.require = (id) => {
    if (id === 'ws') {
      injected = true;
      return OutboundWebSocket;
    }
    return localRequire(id);
  };
  scoped._compile(fs.readFileSync(filename, 'utf8'), filename);
  if (!injected || typeof scoped.exports.SimpleShardingStrategy !== 'function') {
    throw new Error('Discord SDK 网络接口已变化，无法安全应用代理');
  }
  discordWs = scoped.exports;
  return discordWs;
}

function buildDiscordStrategy(manager) {
  const { SimpleShardingStrategy } = loadDiscordWs();
  return new SimpleShardingStrategy(manager);
}

module.exports = { createLarkHttpInstance, buildDiscordStrategy };
