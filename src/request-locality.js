'use strict';
// Request adaptation only. The addon reads borrowed req/socket/header values;
// native/core/http_gate owns the same policy for Node and the Axum gateway.
const { getNative } = require('./native/runtime');
const call = (operation, value) => getNative().requestLocality(operation, value);
const constants = call('constants', null);
module.exports = {
  LOOPBACK_ADDRESSES: Object.freeze(new Set(constants.loopback)),
  FORWARDING_HEADERS: Object.freeze(new Set(constants.forwarding)),
  requestHost: req => call('host', req),
  hasForwardingMetadata: req => call('forwarded', req),
  isExternalProxyRequest: req => call('external', req),
  isLocalRequest: req => call('local', req),
  isPrivateNetworkAddress: value => call('private-address', value),
  isPrivateRequestPeer: req => call('private-peer', req),
};
