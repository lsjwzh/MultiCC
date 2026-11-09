'use strict';

// Claude transcript governor — JavaScript facade.
//
// The behavior lives in native/core/src/transcript_prune.rs and is exported by
// the Rust addon. This file only names the exports, injects the host home
// directory, and keeps the legacy option/argument spellings. No trimming,
// parsing or policy logic may return here — Node is frozen.

const os = require('os');
const { getNative } = require('../native/runtime');

const DEFAULTS = getNative().transcriptPruneDefaults();

const cwdArg = cwd => String(cwd || '');
// `findTranscriptFile`/`maybePrune` only use the id when it is truthy, and then
// interpolate it into a filename.
const sessionArg = session => (session ? String(session) : null);

function claudeProjectDir(cwd) {
  return getNative().transcriptProjectDir(cwdArg(cwd), os.homedir());
}

function findTranscriptFile(cwd, cliSessionId) {
  return getNative().transcriptFind(cwdArg(cwd), sessionArg(cliSessionId), os.homedir());
}

function pruneFile(file, options = {}) {
  return getNative().transcriptPruneFile(file ? String(file) : null, options);
}

function maybePrune(cwd, sessionId, opts = {}) {
  return pruneFile(findTranscriptFile(cwd, sessionId), opts);
}

function measureFile(file, options = {}) {
  return getNative().transcriptMeasureFile(file ? String(file) : null, options);
}

function measure(cwd, sessionId, opts = {}) {
  return measureFile(findTranscriptFile(cwd, sessionId), opts);
}

module.exports = {
  maybePrune,
  pruneFile,
  measure,
  measureFile,
  findTranscriptFile,
  claudeProjectDir,
  isRealUserTurn: value => getNative().transcriptRealUserTurn(value),
  isSubstantiveTurn: value => getNative().transcriptSubstantiveTurn(value),
  userVisibleText: value => getNative().transcriptUserVisibleText(value),
  triggersFor: (metrics, thresholds) => getNative().transcriptTriggersFor(metrics, thresholds),
  compactCutIndex: lines => getNative().transcriptCompactCutIndex(lines),
  DEFAULT_MAX_BYTES: DEFAULTS.maxBytes,
  DEFAULT_TARGET_TOKENS: DEFAULTS.targetTokens,
  DEFAULT_HARD_MAX_TOKENS: DEFAULTS.hardMaxTokens,
  DEFAULT_MAX_ENTRY_BYTES: DEFAULTS.maxEntryBytes,
  DEFAULT_HARD_ENTRY_BYTES: DEFAULTS.hardEntryBytes,
  DEFAULT_KEEP_TURNS_LADDER: DEFAULTS.keepTurnsLadder,
  DEFAULT_SCAN_MIN_BYTES: DEFAULTS.scanMinBytes,
  DEFAULT_TOKEN_WATERMARK: DEFAULTS.tokenWatermark,
};
