'use strict';

// ════════════════════════════════════════════════════════════════════
// src/message-composer.js
// Unified message construction module.
//
// composeMessage() produces a normalized MessageEnvelope consumed by each CLI
// adapter's buildInvocation(envelope) factory.
//
// This module depends ONLY on the injected `deps` bag -- it never requires
// server.js, so it has no circular dependency and is independently unit-testable.
//
// IRON RULE (zero behavior change): the prompt text rendered from an envelope
// is byte-for-byte identical to today's promptText. contextLayers replicate the
// today prepend chain with each layer carrying its own trailing separator; no
// extra separators are inserted by renderPrompt.
// ════════════════════════════════════════════════════════════════════

/**
 * @typedef {'goal-limit'|'gateway'|'dispatch-context'|'cross-agent-notes'} ContextLayerKind
 */

/**
 * A single ordered prefix layer of the prompt.
 *
 * @typedef {Object} ContextLayer
 * @property {ContextLayerKind} kind  - discriminator (unique within an envelope)
 * @property {number} order           - explicit sort key: 10=goal-limit, 20=gateway/dispatch-context, 30=cross-agent-notes
 * @property {string} text            - complete block INCLUDING its own trailing separator; concatenated with no extra separator
 */

/**
 * Per-turn session handle driving --session-id vs --resume (per-turn path only).
 *
 * @typedef {Object} HistoryHandle
 * @property {boolean} isFirstTurn    - true -> --session-id, false -> --resume (claude per-turn)
 * @property {string|null} cliSessionId
 */

/**
 * Raw spawn options. Values are RAW (persisted.model / persisted.effort) -- each
 * CLI adapter's buildInvocation() resolves/maps them via shared helpers
 * (configArgsFor / codexModelConfigArg / resolveSessionWireModel / cliEffortLevel ...).
 * composeMessage does NOT pre-parse, preserving today's per-CLI resolution behavior.
 *
 * @typedef {Object} SpawnOpts
 * @property {'per-turn'|'streaming'} mode
 * @property {string|null} rawModel          - persisted.model (raw; shape resolves via helpers)
 * @property {string|null} rawEffort         - persisted.effort (raw; shape resolves via helpers)
 * @property {string|null|undefined} effectiveModel - host-resolved model used by model-aware effort policy
 * @property {number} maxTurns               - goalLimits.maxRounds || 0
 * @property {boolean} ultracode             - !bare && type!=='aux' && normalizeEffort(effort)==='ultracode'
 * @property {string[]} disallowedTools      - claude-only
 * @property {string|undefined} providerModel
 * @property {string[]|undefined} providerModels
 * @property {boolean|undefined} skipDefaultModel
 */

/**
 * The normalized message envelope produced by composeMessage and consumed by
 * each adapter's buildInvocation(envelope).
 *
 * @typedef {Object} MessageEnvelope
 * @property {string} imgHint                - = MULTICC_IMG_HINT (codex invocation needs it as a standalone block)
 * @property {string|null} rolePrompt        - = resolveRolePrompt(persisted); non-Claude adapters inline it
 * @property {string} systemPrompt           - = rolePrompt ? imgHint+'\n\n'+rolePrompt : imgHint
 * @property {ContextLayer[]} contextLayers  - ordered prefix layers, sorted by order ascending
 * @property {string} userText               - raw user message
 * @property {string} suffix                 - ultracode trigger suffix or ''
 * @property {HistoryHandle} historyHandle
 * @property {SpawnOpts} spawnOpts
 */

// ════════════════════════════════════════════════════════════════════
// validateEnvelope
// ════════════════════════════════════════════════════════════════════

/**
 * Validate a MessageEnvelope's runtime invariants.
 *
 * Behavior is environment-dependent (grafted from design A4):
 *  - dev (NODE_ENV !== 'production'): throws an Error listing all violations
 *  - prod (NODE_ENV === 'production'): console.warn the violations and return void (non-blocking)
 *
 * Invariants checked:
 * 1. userText is a non-empty string
 * 2. contextLayers is an array; each layer has non-empty text, a unique kind,
 *    and layers are sorted by order ascending (non-decreasing)
 * 3. spawnOpts.ultracode === true  ->  suffix is non-empty
 * 4. systemPrompt === (rolePrompt ? imgHint+'\n\n'+rolePrompt : imgHint)
 *
 * @param {MessageEnvelope} env
 * @returns {void}
 */
function validateEnvelope(env) {
  const isProd = process.env.NODE_ENV === 'production';
  const violations = [];

  if (!env || typeof env !== 'object') {
    violations.push('envelope must be an object');
  } else {
    // 1. userText non-empty
    if (typeof env.userText !== 'string' || !env.userText) {
      violations.push('userText must be a non-empty string');
    }

    // 2. contextLayers: non-empty text, unique kind, order ascending
    if (!Array.isArray(env.contextLayers)) {
      violations.push('contextLayers must be an array');
    } else {
      const seenKinds = new Set();
      let prevOrder = -Infinity;
      for (const layer of env.contextLayers) {
        if (!layer || typeof layer.text !== 'string' || !layer.text) {
          violations.push(`empty layer text (kind: ${layer && layer.kind})`);
        }
        if (layer && layer.kind != null) {
          if (seenKinds.has(layer.kind)) {
            violations.push(`duplicate layer kind: ${layer.kind}`);
          }
          seenKinds.add(layer.kind);
        }
        if (layer && typeof layer.order === 'number') {
          if (layer.order < prevOrder) {
            violations.push(`contextLayers not sorted by order asc (kind=${layer.kind} order=${layer.order} after ${prevOrder})`);
          }
          prevOrder = layer.order;
        }
      }
    }

    // 3. ultracode requires suffix
    if (env.spawnOpts && env.spawnOpts.ultracode === true && (typeof env.suffix !== 'string' || !env.suffix)) {
      violations.push('ultracode===true requires a non-empty suffix');
    }

    // 4. systemPrompt derivation consistency
    const expectedSys = env.rolePrompt ? `${env.imgHint}\n\n${env.rolePrompt}` : env.imgHint;
    if (env.systemPrompt !== expectedSys) {
      violations.push('systemPrompt derivation mismatch (expected rolePrompt ? imgHint+\\n\\n+rolePrompt : imgHint)');
    }
  }

  if (violations.length) {
    const msg = `[message-composer] envelope validation: ${violations.join('; ')}`;
    if (isProd) {
      console.warn(msg);
      return;
    }
    throw new Error(msg);
  }
}

// ════════════════════════════════════════════════════════════════════
// composeMessage
// ════════════════════════════════════════════════════════════════════

/**
 * Template method: assemble a MessageEnvelope from all sources. Replaces
 * runChatTurn's inline promptText assembly (server.js:9035-9075).
 *
 * SIDE EFFECTS (non-idempotent): when cross-agent notes exist AND bare===false,
 * marks them delivered + saveNotes + appendEvent + workspaceBroadcast +
 * chatBroadcast, matching server.js:9043-9053 exactly. The notes layer is
 * constructed and its side effects fired in the same step, mirroring today's
 * inline coupling.
 *
 * The envelope's spawnOpts carry RAW values (rawModel=persisted.model,
 * rawEffort=persisted.effort, rawAgent=persisted.agent). Per-CLI resolution/mapping is deferred to each
 * adapter's buildInvocation(envelope) so per-CLI behavior is
 * preserved bit-for-bit.
 *
 * @param {Object} input
 * @param {string} input.text                       - raw user message
 * @param {Object} input.persisted                  - persistedSessions.get(name)
 * @param {string} input.sessionName
 * @param {Object} input.opts
 * @param {boolean} input.opts.isFirstTurn          - drives --session-id vs --resume (per-turn)
 * @param {Object|undefined} input.opts.goalLimits  - { maxRounds, maxBudget }
 * @param {'per-turn'|'streaming'} [input.opts.mode='per-turn']
 * @param {boolean} [input.opts.bare=false]         - true: skip contextLayers + suffix (continue/retry paths)
 * @param {string|undefined} input.opts.providerModel
 * @param {string[]|undefined} input.opts.providerModels
 * @param {boolean|undefined} input.opts.skipDefaultModel
 * @param {string[]} [input.opts.disallowedTools=[]]
 * @param {Object} input.deps - injected dependencies (avoids a circular require of server.js):
 *   { resolveRolePrompt, multiccImgHint, buildCliHandoffPrompt, buildGatewayPrompt, buildDispatchContextPrompt,
 *     buildGoalLimitNote, pendingNotesFor, saveNotes, appendEvent, workspaceBroadcast,
 *     chatBroadcast, normalizeEffort, cliEffortLevel }
 * @returns {MessageEnvelope}
 */
function composeMessage({ text, persisted, sessionName, opts, deps }) {
  const {
    isFirstTurn,
    goalLimits,
    mode = 'per-turn',
    bare = false,
    providerModel,
    providerModels,
    skipDefaultModel,
    disallowedTools = [],
  } = opts || {};

  // ── System prompt (single computation point; today rolePrompt is resolved at server.js:9077) ──
  const rolePrompt = deps.resolveRolePrompt(persisted);
  const imgHint = deps.multiccImgHint;
  const systemPrompt = rolePrompt ? `${imgHint}\n\n${rolePrompt}` : imgHint;

  // ── Context layers ──
  // Today's assembly (server.js:9035-9068) prepends in this order:
  //   notes (9042)  ->  gateway/dispatch (9055-9060)  ->  goal (9067)
  // Each prepend places that layer outermost, so the final left-to-right order is:
  //   goal > gateway/dispatch > notes > userText
  // We assign explicit order keys (10/20/30) so renderPrompt's sort reproduces
  // this exact ordering regardless of push sequence.
  const contextLayers = [];
  if (!bare) {
    // order 10: goal-limit (today server.js:9065-9068). buildGoalLimitNote already
    // returns text ending in '\n\n'.
    if (goalLimits) {
      const note = deps.buildGoalLimitNote(goalLimits);
      if (note) contextLayers.push({ kind: 'goal-limit', order: 10, text: note });
    }

    // order 15: one-shot cross-CLI handoff. This is a bounded checkpoint of
    // visible messages + task/git state, never a vendor transcript conversion.
    // It remains pending until the target CLI produces a successful result.
    if (typeof deps.buildCliHandoffPrompt === 'function') {
      const handoff = deps.buildCliHandoffPrompt(persisted);
      if (handoff) contextLayers.push({ kind: 'cli-handoff', order: 15, text: handoff });
    }

    // order 20: gateway OR dispatch-context (mutually exclusive; today server.js:9055-9060).
    // buildGatewayPrompt('') returns the system block ending in '\n\n' and satisfies
    //   buildGatewayPrompt('') + X === buildGatewayPrompt(X)  (byte-verified).
    // buildDispatchContextPrompt returns text ending in '\n'.
    if (persisted.type === 'gateway') {
      contextLayers.push({ kind: 'gateway', order: 20, text: deps.buildGatewayPrompt('') });
    } else if (persisted.type !== 'aux') {
      const dc = deps.buildDispatchContextPrompt(sessionName);
      if (dc) contextLayers.push({ kind: 'dispatch-context', order: 20, text: dc });
    }

    // order 30: cross-agent notes (today server.js:9036-9054, including side effects).
    const pendingNotes = deps.pendingNotesFor(sessionName).slice(0, 10);
    if (pendingNotes.length) {
      let block = '[multicc 跨 agent 留言 — 来自同目录下的其他 agent]\n';
      for (const n of pendingNotes) block += `- 来自「${n.fromLabel}」：${n.body}\n`;
      block += '[留言结束]\n\n';
      if (block.length > 4000) block = block.slice(0, 4000) + '\n…(截断)\n\n';
      contextLayers.push({ kind: 'cross-agent-notes', order: 30, text: block });

      // SIDE EFFECTS (today server.js:9043-9053; non-idempotent -- fires once per
      // composeMessage call that finds pending notes).
      const now = Date.now();
      for (const n of pendingNotes) { n.delivered = true; n.deliveredAt = now; }
      deps.saveNotes();
      deps.appendEvent(persisted.dirId, 'note_delivered', `${pendingNotes.length} 条留言已送达`, sessionName);
      deps.workspaceBroadcast(persisted.dirId, {
        type: 'note_pending', sessionId: sessionName, count: deps.pendingNotesFor(sessionName).length,
      });
      deps.chatBroadcast(sessionName, {
        type: 'system', subtype: 'agent_notes',
        notes: pendingNotes.map(n => ({ from: n.fromLabel, body: n.body })),
      });
    }
  }

  // ── Suffix (today server.js:9073-9074) ──
  // ultracode trigger word appended to the user message. Today this is appended
  // to the fully-assembled promptText; renderPrompt places it after userText,
  // which is byte-equivalent (layers + userText + suffix).
  const ultracode = !bare
    && persisted.type !== 'aux'
    && deps.normalizeEffort(persisted.effort) === 'ultracode';
  const suffix = ultracode
    ? '\n\n[Use ultracode mode: orchestrate this task with the Workflow tool.]'
    : '';

  const envelope = {
    imgHint,
    rolePrompt,
    systemPrompt,
    contextLayers: contextLayers.sort((a, b) => a.order - b.order),
    userText: text,
    suffix,
    historyHandle: {
      isFirstTurn,
      cliSessionId: persisted.cliSessionId || null,
    },
    spawnOpts: {
      mode,
      // RAW values -- shape() resolves per CLI (iron rule #5: no pre-parsing here).
      rawModel: persisted.model != null ? persisted.model : null,
      rawEffort: persisted.effort != null ? persisted.effort : null,
      rawAgent: persisted.agent != null ? persisted.agent : null,
      maxTurns: goalLimits ? (goalLimits.maxRounds || 0) : 0,
      ultracode,
      disallowedTools,
      providerModel,
      providerModels,
      skipDefaultModel,
    },
  };

  validateEnvelope(envelope);
  return envelope;
}

// ════════════════════════════════════════════════════════════════════
// renderPrompt
// ════════════════════════════════════════════════════════════════════

/**
 * Render the full prompt text from an envelope.
 *
 *   renderPrompt = contextLayers.sort(order).map(text).join('') + userText + suffix
 *
 * Layers are sorted by order ascending (defensive copy -- does not mutate the
 * envelope) and joined with NO separator. Each layer's text already carries its
 * own trailing separator, matching today's direct-concatenation assembly
 * (byte-for-byte equivalent to server.js:9035-9075).
 *
 * @param {MessageEnvelope} envelope
 * @returns {string}
 */
function renderPrompt(envelope) {
  return [...envelope.contextLayers]
    .sort((a, b) => a.order - b.order)
    .map((l) => l.text)
    .join('') + envelope.userText + envelope.suffix;
}

module.exports = { composeMessage, renderPrompt, validateEnvelope };
