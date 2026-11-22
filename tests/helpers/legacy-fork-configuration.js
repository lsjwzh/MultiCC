'use strict';

const { desiredSession, readConfiguration } = require('./session-pending-configuration-oracle');
const { normalizeSubagentInput } = require('./legacy-session-subagent');

// Transcript provenance and the next run's settings are independent. A stale
// saved route must not prevent copying history into a fresh, idle session.
function forkConfiguration(record, { validProviderId, validateProviderSelection, providers }) {
  const desired = desiredSession(record);
  const configuration = { cli: desired.cli, ...readConfiguration(desired) };
  const selection = validateProviderSelection(configuration.providerSelection, { cli: desired.cli, providers });
  const provider = validProviderId(desired.cli, configuration.provider);
  let reset = false;
  if (!provider.ok || !selection.ok) {
    Object.assign(configuration, { provider: undefined, providerSelection: null, model: null, subagent: null });
    reset = true;
  } else {
    configuration.provider = provider.value;
    configuration.providerSelection = selection.value;
    const subagent = normalizeSubagentInput({ ...configuration, validProviderId, providers });
    configuration.subagent = subagent.ok ? subagent.value : null;
    reset = !subagent.ok;
  }
  return { configuration, reset };
}

module.exports = { forkConfiguration };
