'use strict';

const WORKER_TYPE = 'worker';

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function assertDependencies(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('[role-worker] options are required');
  }
  if (!(options.records instanceof Map)) {
    throw new TypeError('[role-worker] records Map is required');
  }
  if (typeof options.mutate !== 'function') {
    throw new TypeError('[role-worker] mutate port is required');
  }
  if (typeof options.createSession !== 'function') {
    throw new TypeError('[role-worker] createSession port is required');
  }
  return options;
}

function roleWorkerSpec(preset, overrides = {}) {
  if (!preset || typeof preset !== 'object' || !clean(preset.id)) {
    throw new TypeError('[role-worker] preset id is required');
  }
  const prompt = clean(preset.prompt);
  const label = clean(overrides.label) || clean(preset.name);
  if (!prompt || !label) {
    throw new TypeError('[role-worker] preset prompt and name are required');
  }
  return {
    cli: clean(overrides.cli) || clean(preset.defaultCli) || 'codex',
    kind: 'chat',
    label,
    model: clean(overrides.model) || clean(preset.defaultModel) || null,
    provider: overrides.provider === undefined
      ? (clean(preset.defaultProviderId) || undefined)
      : clean(overrides.provider),
    effort: overrides.effort === undefined
      ? (clean(preset.defaultEffort) || null)
      : overrides.effort,
    agent: overrides.agent === undefined ? null : overrides.agent,
    rolePrompt: prompt,
    rolePresetId: clean(preset.id),
    type: WORKER_TYPE,
  };
}

function reusableRoleWorker(records, dirId, spec) {
  return [...records.values()].find(record => record
    && record.dirId === dirId
    && record.kind === 'chat'
    && (
      record.rolePresetId === spec.rolePresetId
      || (!record.rolePresetId
        && record.label === spec.label
        && clean(record.rolePrompt) === spec.rolePrompt)
    ));
}

function createRoleWorkerService(rawOptions) {
  const options = assertDependencies(rawOptions);
  const inFlight = new Map();

  async function ensure({ dir, preset, overrides = {} } = {}) {
    if (!dir || !clean(dir.id)) return { ok: false, error: 'directory not found' };
    const spec = roleWorkerSpec(preset, overrides);
    const key = `${dir.id}:${spec.rolePresetId}`;
    if (inFlight.has(key)) return inFlight.get(key);

    const operation = (async () => {
      const reusable = reusableRoleWorker(options.records, dir.id, spec);
      if (reusable) {
        const session = options.mutate('http.ensure-role-worker-refresh', records => {
          const current = records.get(reusable.id);
          if (!current || current.dirId !== dir.id || current.kind !== 'chat') {
            const error = new Error('role worker evidence changed');
            error.code = 'ROLE_WORKER_CHANGED';
            throw error;
          }
          current.label = spec.label;
          current.rolePrompt = spec.rolePrompt;
          current.rolePresetId = spec.rolePresetId;
          current.type = WORKER_TYPE;
          return current;
        });
        return { ok: true, id: session.id, session, reused: true };
      }

      const created = await options.createSession({
        dir,
        ...spec,
        persistence: 'required',
        persistenceSource: 'http.ensure-role-worker-create',
      });
      return created && created.ok
        ? { ...created, reused: !!created.reused }
        : created;
    })();

    inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (inFlight.get(key) === operation) inFlight.delete(key);
    }
  }

  return Object.freeze({ ensure });
}

module.exports = {
  WORKER_TYPE,
  createRoleWorkerService,
  reusableRoleWorker,
  roleWorkerSpec,
};
