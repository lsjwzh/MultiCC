'use strict';

// Cross-instance workspace sharing. Legacy Fleet API/data names are retained
// for existing clients. Rust owns records, password checks, scoped policy and
// durable writes. Imported workspaces and uploads are owned by the gateway;
// this facade supplies only the source workspace live directory/session ports.

const { getNative } = require('./native/runtime');

const SCHEMA_VERSION = 1;
const TOKEN_RE = /^fleet_share_[A-Za-z0-9_-]{24,96}$/;
const MAX_PASSWORD_BYTES = 1024;
const MAX_REMOTE_BODY_BYTES = 1024 * 1024;
const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const GRANT_RE = /^[A-Za-z0-9_-]{43,128}$/;

class FleetSharingError extends Error {
  constructor(code, message, status = 400, metadata = {}) {
    super(message);
    this.name = 'FleetSharingError';
    this.code = code;
    this.status = status;
    this.category = metadata.category || null;
    this.detail = metadata.detail || message;
    this.retryable = typeof metadata.retryable === 'boolean' ? metadata.retryable : null;
    this.action = metadata.action || null;
    this.scope = metadata.scope || 'request';
    this.causeCode = metadata.causeCode || null;
    this.upstreamRequestId = metadata.upstreamRequestId || null;
    this.correlationId = metadata.correlationId || null;
  }
}

// Native policy/state; this facade only adapts the remaining live host ports.
function unwrap(raw) {
  const result = JSON.parse(raw);
  if (result.ok) return result.value;
  const error = result.error;
  if (error.code === 'WORKSPACE_SHARING_INTERNAL') throw new Error(error.message);
  throw new FleetSharingError(error.code, error.message, error.status, error.metadata);
}
function parseNative(kind, value) {
  return unwrap(getNative().workspaceSharingParse(kind, JSON.stringify(value ?? null)));
}
function validateFleetPayload(value) { return parseNative('payload', value); }
function normalizeShareUrl(value) { return parseNative('url', value); }
function blockedAddress(value) { return parseNative('blockedAddress', value); }

// Construct outside createFleetSharing: closures from that function share a
// lexical environment containing its native owner, even when this callback
// only mentions the WeakRef. This isolated environment contains no owner.
function workspaceDirectoryReader(getDirectory) {
  const directoryPort = new WeakRef(getDirectory);
  return (_error, id) => {
    try {
      const read = directoryPort.deref();
      return read ? !!read(id) : null;
    } catch { return null; }
  };
}

// One synchronous host snapshot; no persisted copy or authorization decision.
// Keep both ports weak and outside the facade's lexical scope (see above).
function workspaceContextReader(getDirectory, listSessions) {
  const directoryPort = new WeakRef(getDirectory);
  const membersPort = new WeakRef(listSessions);
  return (_error, input) => {
    try {
      const readDirectory = directoryPort.deref(), readMembers = membersPort.deref();
      if (!readDirectory || !readMembers) return null;
      const { id, membersOnly } = JSON.parse(input);
      if (membersOnly) return JSON.stringify({ members: readMembers(id).map(session => ({ id: session.id })) });
      const directory = readDirectory(id);
      return JSON.stringify({ directory: directory || null, members: directory ? readMembers(directory.id) : [] });
    } catch { return null; }
  };
}

function createFleetSharing({
  sharesFile,
  getDirectory,
  listSessions,
  authSecurity,
  now = () => Date.now(),
} = {}) {
  if (!sharesFile) throw new TypeError('fleet sharing files are required');
  if (typeof getDirectory !== 'function' || typeof listSessions !== 'function') {
    throw new TypeError('fleet sharing directory/session ports are required');
  }

  const owner = new (getNative().RustWorkspaceSharing)(sharesFile);
  // Native creates shares; this port only reads the authoritative live map.
  // A weak capture lets callback -> facade -> native cycles be collected.
  require('./gateway-child').connectWorkspaceControl(owner, workspaceDirectoryReader(getDirectory),
    workspaceContextReader(getDirectory, listSessions), authSecurity);
  let tail = Promise.resolve();
  const query = (operation, input = null) => unwrap(owner.query(operation, JSON.stringify(input), Number(now())));
  function run(operation, input = null) {
    const encoded = JSON.stringify(input);
    const next = tail.then(async () => unwrap(await owner.run(operation, encoded, Number(now()))));
    tail = next.catch(() => {});
    return next;
  }
  function createShare(id, options = {}) {
    return run('createShare', { id, options, directory: !!getDirectory(id) });
  }
  const listShares = id => query('listShares', id);
  const revokeShare = (id, token) => run('revokeShare', { id, token });
  // Library compatibility only. Production HTTP calls the native workflow directly.
  async function accessSharedFleet(token, password) {
    return unwrap(await owner.importShare(JSON.stringify({ token, password }),
      workspaceDirectoryReader(getDirectory), workspaceContextReader(getDirectory, listSessions), Number(now())));
  }
  function authorizeRequest(input = {}) {
    const request = { ...input, webSocket: false };
    const plan = query('authorizePlan', request);
    if (typeof plan === 'boolean') return plan;
    const members = listSessions(plan.workspaceId).map(session => ({ id: session.id }));
    return query('authorizeMembers', { ...request, members });
  }

  return Object.freeze({
    accessSharedFleet,
    authorizeRequest,
    createShare,
    listShares,
    revokeShare,
  });
}

module.exports = {
  DEFAULT_FETCH_TIMEOUT_MS,
  FleetSharingError,
  MAX_PASSWORD_BYTES,
  MAX_PROXY_BODY_BYTES,
  MAX_REMOTE_BODY_BYTES,
  GRANT_RE,
  SCHEMA_VERSION,
  TOKEN_RE,
  blockedAddress,
  createFleetSharing,
  normalizeShareUrl,
  validateFleetPayload,
};
