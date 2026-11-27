'use strict';

// Compatibility names: official and other outbound requests share one policy.
const { createOutbound, outboundFetch } = require('../../src/network/outbound');
const { parseMacSystemProxy } = require('../../src/native/binding').proxyPolicy;
function parseMacProxy(text) {
  const { httpProxy, httpsProxy } = parseMacSystemProxy(text);
  return { httpProxy, httpsProxy };
}
function createOfficialFetch(options) { return createOutbound(options).outboundFetch; }
module.exports = { parseMacProxy, createOfficialFetch, officialFetch: outboundFetch };
