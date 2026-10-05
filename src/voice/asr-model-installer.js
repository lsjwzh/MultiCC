'use strict';

// Local ASR model installer — the half of on-device speech that does not ride
// along with `npm install`.
//
// The sherpa-onnx addon ships inside the package, but the weights it loads are
// ~229MB and live outside both the repo and the app bundle, in
// ~/.multicc/asr-models. Until they are there `modelFilesExist()` is false,
// `isAvailable()` is false, and every voice path silently falls back to cloud
// Whisper — which meant a standalone install (no repo, no scripts/) could never
// reach on-device ASR at all. This module fetches exactly the three files
// src/voice/asr-local.js reads, straight to their final paths:
//
//   <root>/silero_vad.onnx                        streaming VAD
//   <root>/<SV_DIR>/tokens.txt                    recognizer vocabulary
//   <root>/<SV_DIR>/model.int8.onnx               recognizer weights
//
// No tar and no bzip2: the upstream GitHub release only publishes a .tar.bz2,
// but the same model is served file-by-file from HuggingFace, so this works on
// Windows too (scripts/setup-local-asr.sh stays as the manual Unix path).
//
// Three rules this module must never break:
//   1. it never throws into a caller — every failure is a status, because the
//      server must boot and speak even when the download cannot happen;
//   2. one download per process no matter how many callers ask (single flight),
//      and never more than one at a time across processes (a lock file);
//   3. it stays completely inert when ASR_LOCAL is off — the CI containers set
//      exactly that, so the gates never pull 229MB.
const fs = require('fs');
const path = require('path');
const { Transform, Readable } = require('stream');
const { pipeline } = require('stream/promises');

const SV_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
const HF = `https://huggingface.co/csukuangfj/${SV_DIR}/resolve/main`;
const HF_MIRROR = `https://hf-mirror.com/csukuangfj/${SV_DIR}/resolve/main`;
const GH = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
const GH_PROXY = `https://gh-proxy.com/${GH}`;

// Smallest first: the two sub-megabyte files land immediately and the progress
// bar is then driven by the weights alone. `bytes` is the upstream
// content-length, used only to size the bar before the first response header
// arrives — truncation is detected against the *response's* own length, so a
// re-uploaded artifact can never be mistaken for a corrupt one.
const ARTIFACTS = Object.freeze([
  Object.freeze({
    id: 'tokens', rel: `${SV_DIR}/tokens.txt`, bytes: 315894,
    sources: [`${HF}/tokens.txt`, `${HF_MIRROR}/tokens.txt`],
  }),
  Object.freeze({
    id: 'vad', rel: 'silero_vad.onnx', bytes: 643854,
    sources: [`${GH}/silero_vad.onnx`, `${GH_PROXY}/silero_vad.onnx`],
  }),
  Object.freeze({
    id: 'recognizer', rel: `${SV_DIR}/model.int8.onnx`, bytes: 239233841,
    sources: [`${HF}/model.int8.onnx`, `${HF_MIRROR}/model.int8.onnx`],
  }),
]);

const TOTAL_BYTES = ARTIFACTS.reduce((sum, a) => sum + a.bytes, 0);
// A stalled transfer is the normal failure on a long CN chain; without this the
// socket can sit open forever and the bar never moves.
const IDLE_TIMEOUT_MS = 60000;
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

function isOff(value) {
  return value === 'off' || value === '0' || value === 'false' || value === false;
}

async function sizeOf(file) {
  try { return (await fs.promises.stat(file)).size; } catch (_) { return 0; }
}

function createAsrModelInstaller(deps = {}) {
  const asrLocal = deps.asrLocal;
  if (!asrLocal || typeof asrLocal.modelFilesExist !== 'function') {
    throw new TypeError('asr model installer requires the local ASR service');
  }
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const log = deps.log || console;
  const now = deps.now || Date.now;
  // Host-owned arming switch. False by default so a host composed in a test
  // never reaches the network; server.js opts in explicitly.
  const armed = deps.autoDownload === true;
  const idleTimeoutMs = Number(deps.idleTimeoutMs) || IDLE_TIMEOUT_MS;

  let state = 'missing';
  let error = null;
  let current = null;
  let doneBytes = 0;
  let totalBytes = TOTAL_BYTES;
  let startedAt = 0;
  let finishedAt = 0;
  let bytesPerSec = 0;
  let inflight = null;
  let abort = null;
  let lastSample = { at: 0, bytes: 0 };

  function rootDir() {
    return typeof asrLocal.modelRoot === 'function' ? asrLocal.modelRoot() : '';
  }

  function autoDownloadEnabled() {
    if (!armed) return false;
    if (isOff(process.env.ASR_LOCAL_AUTO_DOWNLOAD)) return false;
    return !isOff(asrLocal.cfg ? asrLocal.cfg.ASR_LOCAL : process.env.ASR_LOCAL);
  }

  // ── status ────────────────────────────────────────────────────────────────
  // The one shape the settings route returns and the panel renders. Copy lives
  // in i18n, keyed off `state`, so the server never ships user-facing prose.
  function status() {
    const filesReady = asrLocal.modelFilesExist();
    const addonReady = typeof asrLocal.addonAvailable === 'function' ? asrLocal.addonAvailable() : true;
    let phase = state;
    if (phase !== 'downloading' && phase !== 'failed') {
      if (isOff(asrLocal.cfg ? asrLocal.cfg.ASR_LOCAL : process.env.ASR_LOCAL)) phase = 'disabled';
      // No addon is "unsupported" whether or not the weights are here: on a
      // platform without a sherpa-onnx prebuilt (macOS 11–14) there is nothing
      // to load, and offering a 229MB download that cannot help would be a lie.
      else if (!addonReady) phase = 'unsupported';
      else if (filesReady) phase = 'ready';
      else phase = 'missing';
    }
    const percent = totalBytes ? Math.min(100, Math.round((doneBytes / totalBytes) * 1000) / 10) : 0;
    return {
      state: phase,
      ready: filesReady && addonReady,
      filesReady,
      addonReady,
      modelDir: rootDir(),
      totalBytes,
      doneBytes,
      percent,
      bytesPerSec: Math.round(bytesPerSec),
      etaSec: bytesPerSec > 0 && doneBytes < totalBytes
        ? Math.ceil((totalBytes - doneBytes) / bytesPerSec) : 0,
      currentFile: current,
      error,
      startedAt,
      finishedAt,
      autoDownload: autoDownloadEnabled(),
    };
  }

  function tick(artifact, contentLength) {
    if (contentLength > 0) {
      // Recompute the total against the response's own length so a re-uploaded
      // artifact cannot drive the bar past 100%.
      const index = ARTIFACTS.indexOf(artifact);
      totalBytes = ARTIFACTS.slice(0, index).reduce((sum, a) => sum + a.bytes, 0)
        + contentLength
        + ARTIFACTS.slice(index + 1).reduce((sum, a) => sum + a.bytes, 0);
    }
    const at = now();
    if (!lastSample.at) { lastSample = { at, bytes: doneBytes }; return; }
    if (at - lastSample.at < 1000) return;
    const instant = ((doneBytes - lastSample.bytes) * 1000) / (at - lastSample.at);
    // Exponential smoothing: a raw per-second rate jitters far too much to
    // render as an ETA.
    bytesPerSec = bytesPerSec ? bytesPerSec * 0.6 + instant * 0.4 : instant;
    lastSample = { at, bytes: doneBytes };
  }

  // ── one artifact, mirrors in order, resumable ─────────────────────────────
  async function fetchArtifact(artifact, root, controller) {
    const signal = controller.signal;
    const dest = path.join(root, artifact.rel);
    const part = `${dest}.part`;
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    // `base` is what the artifacts before this one contributed; `received`
    // already starts at the resumed offset, so the two never overlap.
    const base = ARTIFACTS.slice(0, ARTIFACTS.indexOf(artifact))
      .reduce((sum, a) => sum + a.bytes, 0);
    doneBytes = base;
    current = artifact.id;

    let lastError = null;
    for (const url of artifact.sources) {
      const have = await sizeOf(part);
      try {
        const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
        const res = await fetchImpl(url, { headers, signal, redirect: 'follow' });
        if (!res || !res.ok) {
          // 416 = the part file is already the whole artifact; treat the file as
          // complete rather than restarting a 229MB download over a stale byte.
          if (res && res.status === 416 && have > 0) { await fs.promises.rename(part, dest); return; }
          throw new Error(`HTTP ${res ? res.status : 'no response'}`);
        }
        if (!res.body) throw new Error('响应没有内容体');
        const resuming = res.status === 206 && have > 0;
        const length = Number(res.headers.get('content-length')) || 0;
        const expected = resuming ? have + length : length;
        let received = resuming ? have : 0;
        // A stalled socket is the normal failure on a long CN chain, and without
        // this the bar would simply stop moving and never recover. refresh() on
        // every chunk pushes the deadline out; it fires only after a real gap.
        const guard = setTimeout(() => { try { controller.abort(); } catch (_) {} }, idleTimeoutMs);
        guard.unref?.();
        const counter = new Transform({
          transform(chunk, _enc, cb) {
            received += chunk.length;
            doneBytes = base + received;
            tick(artifact, expected);
            guard.refresh?.();
            cb(null, chunk);
          },
        });
        try {
          await pipeline(
            Readable.fromWeb(res.body), counter,
            fs.createWriteStream(part, { flags: resuming ? 'a' : 'w' }),
          );
        } finally { clearTimeout(guard); }
        if (expected > 0 && received !== expected) {
          throw new Error(`传输不完整（${received}/${expected} 字节）`);
        }
        await fs.promises.rename(part, dest);
        return;
      } catch (e) {
        if (signal?.aborted) throw e;
        lastError = e;
        log.error?.(`[multicc/asr-install] ${artifact.id} from ${new URL(url).host} failed: ${e.message}`);
      }
    }
    throw lastError || new Error('没有可用的下载源');
  }

  // ── cross-process lock ────────────────────────────────────────────────────
  // Two servers sharing one ~/.multicc (a dev worktree plus the installed copy)
  // would otherwise write the same 229MB twice. The lock is advisory: a stale
  // one is reclaimed, and any failure to take it just means "somebody else is
  // doing it", never an error the user sees.
  async function acquireLock(root) {
    const lock = path.join(root, '.download.lock');
    try {
      await fs.promises.mkdir(root, { recursive: true });
      let age = Infinity;
      try { age = now() - (await fs.promises.stat(lock)).mtimeMs; } catch (_) {}
      if (age < LOCK_STALE_MS) return null;
      await fs.promises.writeFile(lock, `${process.pid}\n`);
      return lock;
    } catch (_) { return null; }
  }

  async function releaseLock(lock) {
    if (!lock) return;
    try { await fs.promises.unlink(lock); } catch (_) {}
  }

  // ── the download itself ───────────────────────────────────────────────────
  async function run(reason) {
    const root = rootDir();
    if (!root) { state = 'failed'; error = 'model directory is not configured'; return status(); }
    if (asrLocal.modelFilesExist()) { state = 'ready'; return status(); }
    // Every state assignment up to the first await is synchronous, so the route
    // that just called start() already reads "downloading" on its own status()
    // instead of the stale "missing" the panel would otherwise show for a poll.
    state = 'downloading'; error = null; current = null;
    startedAt = now(); finishedAt = 0; doneBytes = 0; totalBytes = TOTAL_BYTES;
    bytesPerSec = 0; lastSample = { at: 0, bytes: 0 };
    // The abort handle exists before the first await: a Cancel that lands while
    // the lock is still being taken is a real cancellation, not a no-op the
    // transfer then ignores.
    const controller = new AbortController();
    abort = controller;
    const lock = await acquireLock(root);
    // No lock means another process owns the transfer. "downloading" is the
    // honest answer; its progress is not ours to report.
    if (!lock) { abort = null; return status(); }
    if (controller.signal.aborted) {
      state = 'failed'; error = '下载已取消'; abort = null;
      await releaseLock(lock);
      return status();
    }
    log.log?.(`[multicc/asr-install] downloading ${(TOTAL_BYTES / 1048576).toFixed(0)}MB to ${root} (${reason})`);
    try {
      for (const artifact of ARTIFACTS) {
        await fetchArtifact(artifact, root, controller);
      }
      doneBytes = totalBytes;
      finishedAt = now();
      state = asrLocal.modelFilesExist() ? 'ready' : 'failed';
      if (state === 'failed') error = '下载完成但模型文件校验失败';
      else {
        log.log?.(`[multicc/asr-install] models ready in ${((finishedAt - startedAt) / 1000).toFixed(0)}s`);
        // Load the recognizer now so the first utterance is not a cold start.
        if (typeof asrLocal.warmup === 'function') Promise.resolve().then(() => asrLocal.warmup()).catch(() => {});
      }
    } catch (e) {
      state = 'failed';
      error = controller.signal.aborted ? '下载已取消' : (e && e.message) || String(e);
      log.error?.(`[multicc/asr-install] failed: ${error}`);
    } finally {
      abort = null; current = null;
      await releaseLock(lock);
    }
    return status();
  }

  // Single flight. Every caller — boot, the panel button, a retry — joins the
  // one in-flight promise instead of starting a second 229MB transfer.
  function start(reason = 'manual') {
    if (inflight) return inflight;
    inflight = run(reason).finally(() => { inflight = null; });
    return inflight;
  }

  function cancel() {
    if (abort) { try { abort.abort(); } catch (_) {} return true; }
    return false;
  }

  // Boot hook. Deliberately silent: when the download cannot happen there is
  // nothing to tell a user who never asked for it.
  function maybeAutoDownload() {
    if (!autoDownloadEnabled()) return null;
    if (asrLocal.modelFilesExist()) return null;
    // No addon means the weights could never be loaded — this machine has no
    // sherpa-onnx prebuilt (macOS 11–14, an arch without one). Pulling 229MB
    // that cannot be used is the one outcome worse than not downloading. The
    // panel says the same thing in words ("本机不支持"), so the two agree.
    if (typeof asrLocal.addonAvailable === 'function' && !asrLocal.addonAvailable()) return null;
    if (inflight) return inflight;
    return start('boot');
  }

  return Object.freeze({
    status,
    start,
    cancel,
    maybeAutoDownload,
    autoDownloadEnabled,
    ARTIFACTS,
    TOTAL_BYTES,
  });
}

module.exports = { createAsrModelInstaller, ARTIFACTS, TOTAL_BYTES, SV_DIR };
