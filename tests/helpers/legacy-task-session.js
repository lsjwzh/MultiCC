'use strict';
// Seed an upgrade fixture while the isolated server is stopped. Production
// creation APIs now create tasks, so they cannot manufacture legacy role data.
const { createPaths, assertTestDir } = require('../../src/paths');
const { readJson, writeJsonAtomic } = require('../../src/state/store');
module.exports = async function legacySession({ dataDir, dirId, id, stop, start }) {
  assertTestDir(dataDir);
  await stop();
  const file = createPaths({ dataDir }).sessionsFile;
  const records = readJson(file, { legacyIsArray: true }).data;
  if (records.some(r => r.id === id)) throw new Error('duplicate legacy fixture');
  records.push({ id, dirId, kind: 'chat', cli: 'codex', label: id, autoCommit: false });
  writeJsonAtomic(file, records, { kind: 'sessions', schemaVersion: 1 });
  await start();
  return { id };
};
