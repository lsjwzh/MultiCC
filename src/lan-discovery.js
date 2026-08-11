'use strict';

const net = require('node:net');
const os = require('node:os');
const { isLoopbackHost } = require('./network-policy');

const SERVICE_TYPE = 'multicc';
const SERVICE_PROTOCOL = 'tcp';
const SERVICE_TXT = Object.freeze({ pv: '1', product: 'multicc' });
const LOOPBACK_BLOCKS = new net.BlockList();
LOOPBACK_BLOCKS.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_BLOCKS.addAddress('::1', 'ipv6');
LOOPBACK_BLOCKS.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

function isLoopbackBind(host) {
  if (isLoopbackHost(host)) return true;
  const family = net.isIP(host);
  return family === 4
    ? LOOPBACK_BLOCKS.check(host, 'ipv4')
    : family === 6 && LOOPBACK_BLOCKS.check(host, 'ipv6');
}

function eligibilityFailure(state = {}) {
  const host = String(state.host || '').trim();
  if (state.shuttingDown) return 'shutting_down';
  if (!state.listening) return 'not_listening';
  if (!host || isLoopbackBind(host)) return 'loopback_bind';
  if (state.allowRemote !== true) return 'remote_not_allowed';
  if (!String(state.accessToken || '')) return 'missing_access_token';
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535) return 'invalid_port';
  return null;
}

function truncateDnsLabel(value, maxBytes = 63) {
  const chars = Array.from(String(value || ''));
  while (chars.length && Buffer.byteLength(chars.join(''), 'utf8') > maxBytes) chars.pop();
  return chars.join('');
}

function instanceName(hostname) {
  const host = String(hostname || '').trim().split('.')[0] || 'Server';
  return truncateDnsLabel(`MultiCC ${host}`) || 'MultiCC Server';
}

function serviceOptions(state, hostname) {
  const host = String(state.host || '').trim();
  const family = net.isIP(host);
  const options = {
    name: instanceName(hostname),
    type: SERVICE_TYPE,
    protocol: SERVICE_PROTOCOL,
    port: state.port,
    txt: { ...SERVICE_TXT },
  };

  // Never publish an address family or a concrete interface the HTTP server
  // did not bind. Wildcard IPv6 is normally dual-stack, so it remains open.
  if (host === '0.0.0.0') options.disabledIpv6 = true;
  else if (host !== '::' && family) {
    options.restrictedAddresses = [host];
    if (family === 4) options.disabledIpv6 = true;
  }
  return options;
}

function defaultResponderFactory() {
  // Lazy loading keeps an optional discovery failure off the HTTP boot path.
  return require('@homebridge/ciao').getResponder();
}

function createLanDiscoveryRuntime({
  readState,
  responderFactory = defaultResponderFactory,
  getHostname = os.hostname,
  logger = console,
} = {}) {
  if (typeof readState !== 'function') throw new TypeError('readState must be a function');

  let responder = null;
  let active = false;
  let activeKey = null;
  let operation = Promise.resolve();

  function log(level, event, fields = {}) {
    const writer = logger && logger[level];
    if (typeof writer === 'function') writer.call(logger, event, fields);
  }

  async function closeCurrent() {
    const current = responder;
    const wasActive = active;
    responder = null;
    active = false;
    activeKey = null;
    if (!current) return wasActive;
    try {
      // ciao requires exactly one shutdown per acquired responder so goodbye
      // records are sent and its UDP sockets are released.
      await current.shutdown();
      if (wasActive) log('info', 'lan_discovery_stopped');
    } catch (error) {
      log('warn', 'lan_discovery_stop_failed', { error: error && error.message });
    }
    return wasActive;
  }

  async function reconcileNow() {
    let state;
    try {
      state = readState() || {};
    } catch (error) {
      log('warn', 'lan_discovery_state_failed', { error: error && error.message });
      await closeCurrent();
      return false;
    }

    const failure = eligibilityFailure(state);
    if (failure) {
      await closeCurrent();
      return false;
    }

    const host = String(state.host).trim();
    const nextKey = `${host}:${state.port}`;
    if (active && activeKey === nextKey) return true;
    await closeCurrent();

    let nextResponder = null;
    try {
      nextResponder = responderFactory();
      const options = serviceOptions(state, getHostname());
      const service = nextResponder.createService(options);
      responder = nextResponder;
      activeKey = nextKey;
      await service.advertise();
      active = true;
      log('info', 'lan_discovery_published', {
        host,
        port: state.port,
        service: `_${SERVICE_TYPE}._${SERVICE_PROTOCOL}`,
        instance: options.name,
      });
      return true;
    } catch (error) {
      if (responder === nextResponder) {
        responder = null;
        activeKey = null;
      }
      if (nextResponder) {
        try { await nextResponder.shutdown(); }
        catch (shutdownError) {
          log('warn', 'lan_discovery_stop_failed', { error: shutdownError && shutdownError.message });
        }
      }
      log('warn', 'lan_discovery_publish_failed', { error: error && error.message });
      return false;
    }
  }

  function enqueue(fn) {
    const result = operation.then(fn, fn);
    operation = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    reconcile: () => enqueue(reconcileNow),
    stop: () => enqueue(closeCurrent),
    status: () => ({ active, key: activeKey }),
  };
}

module.exports = {
  SERVICE_PROTOCOL,
  SERVICE_TXT,
  SERVICE_TYPE,
  createLanDiscoveryRuntime,
  eligibilityFailure,
  instanceName,
  serviceOptions,
};
