'use strict';

// Pre-resume size guard for the resume-capable CLI lanes beyond codex
// (zcode, kimi, codebuddy, qoder, dsh) — JavaScript facade.
//
// The behavior lives in native/core/src/native_session_guard.rs
// (NativeSessionGuard) and is exported by the Rust addon. This file only
// resolves the host-injected per-session home callbacks, passes the
// environment/logger defaults across, and replays the Rust log records on the
// injected logger. No walking, sizing, archiving or policy may return here —
// Node is frozen.
//
// Like the codex rollout these stores are append-only and grow without bound
// (observed in the wild: zcode rollouts at 17.7MB with no gate at all), so an
// oversized native session makes every resume slower and can eventually wedge
// startup. When the native history backing record.cliSessionId exceeds
// maxBytes (default 10MB) it is moved out of the vendor's store into a sibling
// multicc archive dir (never deleted) and the caller clears cliSessionId so the
// turn starts a fresh native session. Fail-open: any filesystem error returns
// action 'error' and the turn proceeds exactly as before.
//
// Store layouts (verified on disk 2026-10 unless noted):
//   zcode     <zcodeSessionHome>/.zcode/cli/rollout/model-io-sess_<id>.jsonl
//   kimi      provider lane: <kimiSessionHome>; providerless: $KIMI_CODE_HOME
//             or ~/.kimi-code; the id must appear in the transcript filename
//   codebuddy ~/.codebuddy/projects/<cwd-slug>/<id>.jsonl
//   qoder     ~/.qoder (Claude-compatible; degrade-safe matching)
//   dsh       ~/.dsh/sessions/<cwd-slug>/<id>/ — the id is the DIRECTORY name
//
// gemini/grok are deliberately not covered: both are ACP lanes whose bridge
// drops the replayed history. Archived entries older than the TTL
// (MULTICC_NATIVE_SESSION_ARCHIVE_TTL_DAYS, default 30, 0 disables) are swept
// on each successful archive, throttled to one pass per 6h.

const os = require('node:os');
const { getNative } = require('../native/runtime');

const DEFAULTS = getNative().nativeSessionGuardDefaults();

const DEFAULT_MAX_BYTES = DEFAULTS.maxBytes;
const ARCHIVE_DIRNAME = DEFAULTS.archiveDirname;
const DEFAULT_ARCHIVE_TTL_DAYS = DEFAULTS.archiveTtlDays;

function createNativeSessionGuard(deps = {}) {
    const homeDir = deps.homeDir || os.homedir();
    const logger = deps.logger || console;
    const env = deps.env || process.env;
    const zcodeSessionHomeFor = typeof deps.zcodeSessionHomeFor === 'function'
        ? deps.zcodeSessionHomeFor : null;
    const kimiSessionHomeFor = typeof deps.kimiSessionHomeFor === 'function'
        ? deps.kimiSessionHomeFor : null;
    const handle = new (getNative().RustNativeSessionGuard)({
        homeDir,
        kimiCodeHome: env.KIMI_CODE_HOME,
        zcodeHomesDir: deps.zcodeHomesDir || null,
        kimiHomesDir: deps.kimiHomesDir || null,
        maxBytes: deps.maxBytes !== undefined
            ? deps.maxBytes : env.MULTICC_NATIVE_SESSION_MAX_BYTES,
        archiveTtlDays: deps.archiveTtlDays !== undefined
            ? deps.archiveTtlDays : env.MULTICC_NATIVE_SESSION_ARCHIVE_TTL_DAYS,
    });
    const maxBytes = handle.maxBytes;
    const archiveTtlMs = handle.archiveTtlMs;

    function replay(envelope) {
        for (const log of envelope.logs) {
            try { logger[log.level]?.(log.name, log.fields); } catch (_) { /* logger must not block a turn */ }
        }
        return Object.freeze(envelope.result);
    }

    function handles(cli) { return handle.handles(cli); }

    // A host callback is the only thing in `enforce` that can throw outside
    // Rust's own fail-open handling; reproduce the legacy catch locally.
    function guardError(record, cli, error) {
        const message = String((error && error.message) || error);
        try { logger.warn?.('native_session_guard_error', { sessionId: record.id, cli, error: message }); } catch (_) {}
        return Object.freeze({ action: 'error', error: message });
    }

    function enforce(record, options = {}) {
        const cli = record && record.cli;
        if (!record || !handle.storeTruthy(cli) || !record.cliSessionId) {
            return Object.freeze({ action: 'skipped' });
        }
        const force = options.force === true;
        const homes = {};
        try {
            if (cli === 'zcode' && zcodeSessionHomeFor && record.id) {
                homes.zcodeSessionHome = zcodeSessionHomeFor(String(record.id));
            }
            if (cli === 'kimi' && record.provider && kimiSessionHomeFor && record.id) {
                homes.kimiSessionHome = kimiSessionHomeFor(String(record.id));
            }
        } catch (error) {
            return guardError(record, cli, error);
        }
        return replay(handle.enforce({
            cli,
            cliSessionId: record.cliSessionId,
            provider: record.provider,
            id: record.id,
        }, force, homes));
    }

    // Disabled and throttled sweeps never look at `options`, exactly like the
    // legacy guard: a null argument is only a TypeError when the sweep runs.
    function sweepExpiredArchives(options = {}) {
        if (archiveTtlMs <= 0) return replay(handle.sweep(true, 0));
        const nowMs = options.nowMs === undefined ? undefined : Number(options.nowMs);
        return replay(handle.sweep(options.force === true, nowMs));
    }

    return Object.freeze({ enforce, handles, sweepExpiredArchives, maxBytes, archiveTtlMs });
}

module.exports = {
    createNativeSessionGuard,
    DEFAULT_MAX_BYTES,
    DEFAULT_ARCHIVE_TTL_DAYS,
    ARCHIVE_DIRNAME,
};
