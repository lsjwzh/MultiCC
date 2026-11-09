'use strict';
// Migration bridge only: Rust owns the records, crypto, recovery and writes.
// Promise sequencing preserves this handle's call order while crypto and I/O
// execute on native workers. Delete the facade once callers live in Rust.
const { getNative } = require('../native/runtime');
const TOKEN_PREFIX = 'mcr1';
const MIN_SECRET_LENGTH = 8;
const MAX_SECRET_LENGTH = 128;
function nativeError(error) {
  if (error?.code === 'GenericFailure') {
    const match = /^([A-Z_]+):\s*(.*)$/s.exec(error.message);
    if (match) { error.code = match[1]; error.message = match[2]; }
    if (error.code === 'STATE_CORRUPTED' || error.code === 'STATE_UNREADABLE') error.name = 'CorruptedStateError';
  }
  return error;
}
function parse(kind, value) { return JSON.parse(getNative().relayShareParse(kind, JSON.stringify(value ?? null))); }
function createProviderRelayShareStore(options = {}) {
  if (!options.file) throw new TypeError('provider relay share store requires { file }');
  let owner;
  try { owner = new (getNative().RustRelayShares)(options.file, options.keyFile); }
  catch (error) { throw nativeError(error); }
  let tail = Promise.resolve();
  function run(operation, input = null) {
    const encoded = JSON.stringify(input);
    const next = tail.then(async () => {
      try {
        const now = typeof options.now === 'function' && operation !== 'list' && operation !== 'getCredential' ? Number(options.now()) : undefined;
        const value = JSON.parse(await owner.run(operation, encoded, now));
        if (Array.isArray(value)) return value.map(Object.freeze);
        if (value?.share) Object.freeze(value.share);
        return value && typeof value === 'object' ? Object.freeze(value) : value;
      } catch (error) { throw nativeError(error); }
    });
    tail = next.catch(() => {});
    return next;
  }
  return Object.freeze({
    create: (input = {}) => run('create', input), list: (filter = {}) => run('list', filter),
    getCredential: id => run('getCredential', id ?? null), authorize: (input = {}) => run('authorize', input),
    revoke: id => run('revoke', id ?? null), revokeProvider: (appType, providerId) => run('revokeProvider', { appType, providerId }),
  });
}
module.exports = { MAX_SECRET_LENGTH, MIN_SECRET_LENGTH, TOKEN_PREFIX, createProviderRelayShareStore,
  parseCredential: value => parse('credential', value), relayRouteFromBaseUrl: value => parse('baseUrl', value), routeTarget: value => parse('target', value) };
