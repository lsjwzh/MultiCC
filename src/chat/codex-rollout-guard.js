'use strict';

// Pre-resume size guard for codex native sessions — JavaScript facade.
//
// The behavior lives in native/core/src/native_session_guard.rs
// (CodexRolloutGuard) and is exported by the Rust addon. This file only
// resolves the host-injected per-session home callbacks and the migration hook,
// passes the environment/logger defaults across, and replays the Rust log
// records on the injected logger. No walking, sizing, archiving or policy may
// return here — Node is frozen.
//
// A codex rollout (~/.codex/sessions/…/rollout-*-<thread_id>.jsonl) is an
// append-only log: raw tool outputs and base64 image_generation payloads make
// it grow without bound while codex's context-window compaction only governs
// the request payload, never the file. On `codex exec resume <thread_id>` the
// CLI loads and rebuilds history from that file BEFORE any compaction runs,
// and with an oversized rollout it hangs internally. The guard runs at chat
// turn admission: if the rollout backing the persisted cliSessionId exceeds
// maxBytes the file is moved out of codex's sessions tree (archived, not
// deleted) and the caller drops cliSessionId so the turn starts a fresh
// thread. Fail-open by design.

const os = require('node:os');
const { getNative } = require('../native/runtime');

const DEFAULTS = getNative().codexRolloutGuardDefaults();

const DEFAULT_MAX_ROLLOUT_BYTES = DEFAULTS.maxBytes;
const ARCHIVE_DIRNAME = DEFAULTS.archiveDirname;
const DEFAULT_ARCHIVE_TTL_DAYS = DEFAULTS.archiveTtlDays;

function createCodexRolloutGuard(deps = {}) {
    const homeDir = deps.homeDir || os.homedir();
    const codexSessionHomeFor = typeof deps.codexSessionHomeFor === 'function'
        ? deps.codexSessionHomeFor : null;
    const prepareCodexSessionHome = typeof deps.prepareCodexSessionHome === 'function'
        ? deps.prepareCodexSessionHome : null;
    const logger = deps.logger || console;
    const handle = new (getNative().RustCodexRolloutGuard)({
        homeDir,
        codexHomesDir: deps.codexHomesDir || null,
        codexSessionHomesDir: deps.codexSessionHomesDir || null,
        maxBytes: deps.maxBytes !== undefined
            ? deps.maxBytes : process.env.MULTICC_CODEX_ROLLOUT_MAX_BYTES,
        archiveTtlDays: deps.archiveTtlDays !== undefined
            ? deps.archiveTtlDays : process.env.MULTICC_CODEX_ROLLOUT_ARCHIVE_TTL_DAYS,
    });
    const maxBytes = handle.maxBytes;
    const archiveTtlMs = handle.archiveTtlMs;

    function replay(envelope) {
        for (const log of envelope.logs) {
            try { logger[log.level]?.(log.name, log.fields); } catch (_) { /* logger must not block a turn */ }
        }
        return Object.freeze(envelope.result);
    }

    // Host-owned inputs are projected here; every decision stays in Rust.
    function prepare(record) {
        if (!(record.provider && prepareCodexSessionHome && record.id)) {
            if (record.provider && codexSessionHomeFor && record.id) {
                return { codexHome: codexSessionHomeFor(String(record.id)) };
            }
            return null;
        }
        let migration;
        try {
            migration = prepareCodexSessionHome({
                logicalSessionId: record.id,
                nativeSessionId: record.cliSessionId,
            });
        } catch (error) {
            return {
                errorCode: String((error && error.code) || ''),
                errorMessage: String((error && error.message) || error),
            };
        }
        if (migration && migration.sessionsDir) return { sessionsDir: migration.sessionsDir };
        if (codexSessionHomeFor && record.id) {
            return { codexHome: codexSessionHomeFor(String(record.id)) };
        }
        return null;
    }

    function enforce(record, options = {}) {
        const isCodex = record && (record.cli === 'codex' || record.cli === 'codex-exp');
        if (!isCodex || !record.cliSessionId) return Object.freeze({ action: 'skipped' });
        const force = options.force === true;
        let prepared;
        try {
            prepared = prepare(record);
        } catch (error) {
            prepared = {
                errorCode: String((error && error.code) || ''),
                errorMessage: String((error && error.message) || error),
            };
        }
        return replay(handle.enforce({
            cli: record.cli,
            cliSessionId: record.cliSessionId,
            provider: record.provider,
            id: record.id,
        }, force, prepared));
    }

    // Disabled and throttled sweeps never look at `options`, exactly like the
    // legacy guard: a null argument is only a TypeError when the sweep runs.
    function sweepExpiredArchives(options = {}) {
        if (archiveTtlMs <= 0) return replay(handle.sweep(true, 0));
        const nowMs = options.nowMs === undefined ? undefined : Number(options.nowMs);
        return replay(handle.sweep(options.force === true, nowMs));
    }

    return Object.freeze({ enforce, sweepExpiredArchives, maxBytes, archiveTtlMs });
}


// 准入检查与重建通知集中在守卫模块，避免回合引擎继续增长。
function enforceCodexRolloutForTurn({ guard, persisted, sessionName, logger,
    rememberActiveCliState, savePersistedSessionsBestEffort, chatBroadcast, appendEvent }) {
    const guardResult = guard.enforce(persisted);
    if (guardResult.action === 'blocked') {
        logger.error('codex_rollout_guard_blocked', { sessionId: sessionName, code: guardResult.code });
        chatBroadcast(sessionName, { type: 'error', code: guardResult.code,
            error: 'Codex 原生会话历史无法唯一定位；为避免恢复到错误上下文，本轮已阻止。请检查重复的 rollout 文件。' });
        return guardResult;
    }
    if (guardResult.action === 'not_found') {
        persisted.cliSessionId = null;
        persisted._streamSessionId = null;
        rememberActiveCliState(persisted);
        savePersistedSessionsBestEffort('runtime.codex-history-missing');
        logger.warn('codex_rollout_missing_recovered', { sessionId: sessionName });
        chatBroadcast(sessionName, { type: 'system', subtype: 'warning',
            message: 'Codex 原生历史文件已缺失，已自动新建会话上下文并继续本条消息。' });
    }
    if (guardResult.action === 'archived') {
        persisted.cliSessionId = null;
        savePersistedSessionsBestEffort();
        logger.warn('codex_rollout_archived', { sessionId: sessionName,
            archivedCliSessionId: guardResult.cliSessionId, maxBytes: guardResult.maxBytes,
            archived: guardResult.archived.map(item => ({ file: item.file, sizeBytes: item.sizeBytes, archivedTo: item.archivedTo })) });
        appendEvent(persisted.dirId, 'codex_rollout_archived',
            `codex rollout 超过 ${(guardResult.maxBytes / 1048576).toFixed(0)}MB 已归档，本轮将重建上下文`, sessionName);
        chatBroadcast(sessionName, { type: 'system', subtype: 'rollout_archived',
            message: `codex 原生会话历史过大（rollout > ${Math.round(guardResult.maxBytes / 1048576)}MB），已归档并重建上下文；旧历史文件保留在归档目录，未删除。` });
    }
    return guardResult;
}

module.exports = {
    enforceCodexRolloutForTurn,
    createCodexRolloutGuard,
    DEFAULT_MAX_ROLLOUT_BYTES,
    DEFAULT_ARCHIVE_TTL_DAYS,
    ARCHIVE_DIRNAME,
};
