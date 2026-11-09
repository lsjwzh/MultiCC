'use strict';
// Test-only buffered adapter to the same external runtime hosted by Axum.
// No network orchestration, state ownership or streaming implementation in JS.
const source = require('../../src/fleet-sharing');
const { getNative } = require('../../src/native/runtime');
function unwrap(raw) {
  const result = JSON.parse(raw);
  if (result.ok) return result.value;
  const e = result.error;
  if (e.code === 'WORKSPACE_SHARING_INTERNAL') throw new Error(e.message);
  throw new source.FleetSharingError(e.code, e.message, e.status, e.metadata);
}
function createFleetSharing(options) {
  const owner = new (getNative().RustExternalWorkspaces)(options.externalFleetsFile);
  const now = () => Number(options.now ? options.now() : Date.now());
  const query = (op, input = null) => unwrap(owner.query(op, JSON.stringify(input), now()));
  async function run(op, id, request, context, body) {
    const bytes = body == null ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const result = await owner.run(op, JSON.stringify({ id, request, context }), bytes, now(), options.fetchTimeoutMs);
    const value = unwrap(result.metadata);
    return op === 'proxyExternal' ? { ...value, body: result.body } : value;
  }
  return { ...source.createFleetSharing(options),
    listExternal: () => query('listExternal'),
    externalAuthority: id => query('externalAuthority', id),
    importExternal: (request, context) => run('importExternal', null, request, context),
    refreshExternal: (id, context) => run('refreshExternal', id, null, context),
    removeExternal: id => run('removeExternal', id),
    issueExternalWsTicket: (id, request, context) => run('issueExternalWsTicket', id, request, context),
    proxyExternal: (id, request) => run('proxyExternal', id, request, null, request.body),
  };
}
module.exports = { ...source, createFleetSharing };
