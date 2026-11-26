'use strict';

const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const { installNativeQueue } = require('./native-queue');
const { createWsHost } = require('./ws-host');
const { startChatBridge } = require('../gateway-child');
const { getNative } = require('../native/binding');
const isInternalExecutionSlot = record => getNative().sessionIsInternalExecutionSlot(record);

const WS_PING_INTERVAL_MS = 30_000;
const SESSIONLESS_WS_PATHS = new Set([
  '/ws/voice', '/ws/tts', '/ws/workspace', '/ws/meta', '/ws/aux',
]);

function mountWsConnectionRouter(wss, deps) {
  const {
    metrics,
    logger,
    share,
    parseCookies,
    isLocalRequest,
    isRequestPeerAllowed = () => true,
    authSecurity, machines,
    voiceAsr,
    ttsService,
    workspaceRuntime,
    auxQueue,
    auxSessionId,
    loadChatHistory,
    // The Aux replay only slices the transcript; the view avoids cloning it.
    viewChatHistory = loadChatHistory,
    sessions,
    persistedSessions,
    createSession,
    sendWs,
    resolveCwd,
    tmuxWriteInput,
    tmuxResize,
    tmuxCaptureSnapshot,
    applyMaxClientSize,
    pushOnInput,
    handleChatWs,
    getShuttingDown,
    getAccessToken,
    allowLegacyWsCookie,
    allowLegacyWsToken,
    fs,
    path,
    os,
  } = deps;

  // One native owner for every connection this router accepts: the registry
  // (what used to be a WeakMap), the heartbeat windows and the per-connection
  // send queue all live in Rust. Node keeps the timer cadence and the raw
  // socket transport through these ports.
  // The composition root may hand in the host (the chat replay hub shares it);
  // a router mounted on its own builds a private one.
  const wsHost = deps.wsHost || createWsHost();
  // Per-connection port views created by installNativeQueue, keyed by the
  // host's connection id; the schedule port looks them up to fire the retry
  // timer against the right `sendFrame` closure.
  const connPortsById = new Map();
  const wsPorts = {
    ping(socket) { socket.ping(); },
    terminate(socket) { socket.terminate(); },
    // A synchronous throw crosses back into the kernel as the close failure
    // that falls back to `terminate` — do not catch here.
    close(socket, code, reason) { socket.close(code, reason); },
    schedule(id, ms) {
      const timer = setTimeout(() => {
        const connPorts = connPortsById.get(id);
        if (!connPorts) return;
        try { wsHost.flushClient(id, connPorts); } catch (_) {}
      }, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return timer;
    },
    cancelSchedule(timer) { clearTimeout(timer); },
    metric(name, value, op) {
      try { op === 'set' ? metrics.set(name, value) : metrics.inc(name, value); } catch (_) {}
    },
    backpressureLog(socket, event, fields) {
      try { logger.warn(event, { ...fields, correlationId: socket._correlationId }); } catch (_) {}
    },
    // The native session fan-out and replay burst address one connection's
    // `sendFrame` view through this lookup instead of holding JS sockets.
    connPort(id) { return connPortsById.get(id); },
    heartbeatTimeout(fields, socket, missedPongs) {
      try {
        logger.warn('ws_pong_timeout', { ...fields, correlationId: socket._correlationId, missedPongs });
      } catch (_) {}
    },
    now: () => Date.now(),
  };
  wsHost.bindPorts(wsPorts);

  wss.on('connection', async (ws, req) => {
    const urlObj = new URL(req.url, 'http://localhost');
    // `/ws/workspace` and `/ws/meta` (unless it is the Air protocol) are owned
    // by the native subscription owner: it owns the liveness window and the
    // send queue for those sockets. They still register here so the registry
    // and the close log see every socket in one place.
    const nativeSocket = workspaceRuntime.ownsSocket?.(urlObj) === true;
    const addressedSessionId = urlObj.pathname === '/ws/chat'
      ? urlObj.searchParams.get('session')
      : SESSIONLESS_WS_PATHS.has(urlObj.pathname) ? null : urlObj.searchParams.get('id');
    const addressedDirectoryId = urlObj.pathname === '/ws/workspace'
      ? urlObj.searchParams.get('dirId') : null;
    const fields = {
      connectionId: randomUUID(),
      path: urlObj.pathname, // Never log query strings containing auth credentials.
      sessionId: addressedSessionId,
      directoryId: addressedDirectoryId,
    };
    const connectedAt = Date.now();
    const connId = wsHost.attach(ws, fields, nativeSocket, connectedAt);
    // The chat handler joins this connection to its session by id.
    Object.defineProperty(ws, '_multiccConnId', { value: connId, configurable: true });
    // Install before dispatch: every WS route needs protocol-level liveness.
    ws.on('pong', () => {
      try { wsHost.onPong(connId); } catch (_) {}
    });
    ws.once('close', (code, reason) => {
      // The router's listener runs before the runtime's detach listener, so the
      // native heartbeat record is still available for this log line.
      const nativeStats = nativeSocket ? workspaceRuntime.socketStats?.(ws) : null;
      const record = (() => {
        try { return wsHost.detach(connId, wsPorts); } catch (_) { return null; }
      })();
      connPortsById.delete(connId);
      logger.info('ws_connection_closed', {
        ...fields,
        correlationId: ws._correlationId,
        code,
        reason: reason.toString(),
        durationMs: Math.max(0, Date.now() - connectedAt),
        // Same handshake flags used by ws 8.x to populate CloseEvent.wasClean.
        wasClean: ws._closeFrameReceived === true && ws._closeFrameSent === true,
        heartbeatTimedOut: nativeStats ? nativeStats.timedOut === true : record?.timedOut === true,
        missedPongs: nativeStats ? nativeStats.missedPongs : (record?.missedPongs ?? 0),
      });
    });
    // Admission is decided in Rust. `multicc_core::ws_admission` owns the
    // ordered gate sequence -- shutdown, public peer, share token, one-use
    // ticket, machine grant, fleet scope, the legacy credentials, the final
    // auth denial and the internal-slot refusal -- together with the metrics,
    // the deprecation warning, the socket annotations and the position of the
    // send queue. Node owns the facts and carries the plan out.
    //
    // Every fact below is a pure read, so they are all collected before the
    // decision. The credential checks are guarded on that credential having
    // been sent at all rather than on its opt-in flag, and the kernel owns the
    // conjunction they used to sit in. The two lookups that must not happen
    // speculatively ask the kernel first: the share table is consulted only
    // for a chat socket presenting a `share` parameter, and the one-use ticket
    // is consumed only when admission actually reaches the auth phase.
    const cookies = parseCookies(req.headers.cookie);
    const shareParam = urlObj.searchParams.get('share') || '';
    const tokenParam = urlObj.searchParams.get('token');
    const authCookie = cookies.multicc_auth || null;
    const facts = {
      shuttingDown: !!getShuttingDown(),
      peerAllowed: !!isRequestPeerAllowed(req),
      path: urlObj.pathname,
      shareParam,
      sessionParam: urlObj.searchParams.get('session'),
      addressedSessionId,
      addressedDirectoryId,
      shareAccess: null,
      local: !!isLocalRequest(req),
      accessToken: !!getAccessToken(),
      hasTicketParam: urlObj.searchParams.has('ticket'),
      ticket: null,
      allowLegacyWsCookie: !!allowLegacyWsCookie,
      allowLegacyWsToken: !!allowLegacyWsToken,
      authCookie: !!authCookie,
      cookieValid: !!(authCookie && authSecurity?.verifyCookie?.(authCookie)),
      tokenValid: !!(tokenParam && authSecurity?.verifyAccessToken?.(tokenParam)),
      machinesPresent: !!machines,
      machineActive: false,
      ip: req.socket.remoteAddress ?? null,
      sessionInternalSlot: !!(addressedSessionId
        && isInternalExecutionSlot(persistedSessions.get(addressedSessionId))),
      nativeSocket,
    };
    // Both lookups are gated by the kernel, which owns the conditions they
    // used to sit under. The JS-side parameter check in front of each is a
    // necessary condition the kernel re-checks, not a second copy of the rule.
    if (shareParam && getNative().wsAdmissionNeedsShareRecord(JSON.stringify(facts))) {
      facts.shareAccess = share.access(shareParam, { cookies }) || null;
    }
    if (facts.hasTicketParam
        && getNative().wsAdmissionNeedsTicket(JSON.stringify(facts))) {
      facts.ticket = authSecurity?.consumeWsTicket?.(urlObj.searchParams.get('ticket'),
        urlObj.pathname) || null;
      facts.machineActive = !!(facts.ticket?.machineGrantId
        && machines?.active(facts.ticket.machineGrantId));
    }
    let admitted = false;
    let closed = false;
    for (const step of JSON.parse(getNative().wsAdmissionPlan(JSON.stringify(facts)))) {
      if (step.op === 'metric') { metrics.inc(step.name); continue; }
      if (step.op === 'installSendQueue') {
        installNativeQueue(ws, wsHost, connId, wsPorts, connPortsById);
        continue;
      }
      if (step.op === 'machineGrant') { ws._machineGrantId = step.value; continue; }
      if (step.op === 'correlationId') {
        // A ticket with neither identity left `ws._correlationId` undefined,
        // which the close log omits rather than reporting as null.
        ws._correlationId = step.value === null ? undefined : step.value;
        continue;
      }
      if (step.op === 'legacyWarning') {
        logger.warn('legacy_ws_auth', {
          path: step.path,
          mode: step.mode,
          ip: step.ip === null ? undefined : step.ip,
        });
        continue;
      }
      if (step.op === 'sharePermission') { ws._sharePerm = step.value; continue; }
      if (step.op === 'sessionMissing') {
        sendWs(ws, {
          type: 'error',
          error: 'Session does not exist.',
          data: 'Session does not exist.\r\n',
        });
        continue;
      }
      if (step.op === 'close') {
        // A null code is `ws.close()` with no arguments: an empty close frame.
        if (step.code === null) ws.close(); else ws.close(step.code, step.reason);
        closed = true;
        break;
      }
      if (step.op === 'accept') admitted = true;
    }
    if (closed || !admitted) return;

    if (urlObj.pathname === '/ws/chat') {
      return handleChatWs(ws, req, urlObj);
    }
    if (urlObj.pathname === '/ws/voice') {
      return voiceAsr.handleVoiceWs(ws, req, urlObj);
    }
    if (urlObj.pathname === '/ws/tts') {
      return ttsService.handleTtsWs(ws, req);
    }
    if (urlObj.pathname === '/ws/workspace') {
      return workspaceRuntime.attachWorkspace(ws, urlObj, fields);
    }
    if (urlObj.pathname === '/ws/meta') {
      return workspaceRuntime.attachMeta(ws, urlObj, fields);
    }
    if (urlObj.pathname === '/ws/aux') {
      auxQueue.attachClient(ws);
      sendWs(ws, {
        type: 'aux_init',
        status: auxQueue.getStatus(),
        health: { ...auxQueue.health },
      });
      const history = viewChatHistory(auxSessionId);
      sendWs(ws, { type: 'aux_history', messages: history.slice(-100) });
      return;
    }

    const sessionId = urlObj.searchParams.get('id') || '';
    let session;
    if (sessionId && sessions.has(sessionId)) {
      session = sessions.get(sessionId);
      console.log(`[multicc] Client attached to session ${sessionId} (${session.clients.size + 1} total)`);
    } else {
      const persisted = persistedSessions.get(sessionId);
      if (!persisted) {
        sendWs(ws, {
          type: 'error',
          data: `Session ${sessionId} does not exist.\r\n`
            + 'Create one in the dashboard first (Manage → pick a directory → + Terminal).\r\n',
        });
        ws.close();
        return;
      }
      if (persisted.kind && persisted.kind !== 'terminal') {
        sendWs(ws, {
          type: 'error',
          data: `Session ${sessionId} is a ${persisted.kind} session, not a terminal.\r\n`,
        });
        ws.close();
        return;
      }
      console.log(`[multicc] Spawning terminal session ${sessionId}`);
      try {
        session = await createSession(sessionId);
      } catch (error) {
        const cliLabel = persisted.cli || 'claude';
        const BINARY_NAMES = { qoder: 'qoderclicn', codebuddy: 'codebuddy', dsh: 'dsh', grok: 'grok', agy: 'agy', commandcode: 'command-code', pi: 'pi' };
        const binaryName = BINARY_NAMES[cliLabel] || cliLabel;
        const missingTmux = error.code === 'ENOENT' && error.path === 'tmux';
        const missingCli = error.code === 'ENOENT'
          && String(error.path || '').split(/[\\/]/).pop() === binaryName;
        const hint = missingTmux
          ? '登录终端依赖 tmux，但后台服务找不到它。请在 MultiCC 目录运行 ./multicc install-terminal，完成后刷新本页。\r\n'
          : missingCli
            ? `Make sure "${binaryName}" is installed and available in PATH.\r\n`
              + `You can also set the ${binaryName.toUpperCase()}_CMD environment variable.\r\n`
            : 'Terminal setup failed. Check the error above for the failing dependency or working directory.\r\n';
        const message = `Failed to launch ${cliLabel}: ${error.message}\r\n` + hint;
        logger.warn('terminal_launch_failed', {
          sessionId, cli: cliLabel, code: error.code || null,
          dependency: missingTmux ? 'tmux' : missingCli ? binaryName : null,
        });
        sendWs(ws, { type: 'error', data: message });
        ws.close();
        return;
      }
    }

    sendWs(ws, { type: 'session_id', id: sessionId, cli: session.cli || 'claude' });

    // The most recent input client owns resize; the pane uses the maximum
    // dimensions requested by all clients.
    let inputBuf = '';
    let firstResize = true;
    const onClientMessage = raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'input') {
          for (const ch of msg.data) {
            if (ch === '\r' || ch === '\n') {
              const cleanLine = inputBuf.trim()
                .replace(/\x1b(?:\[[0-9;?]*[A-Za-z~]|.)/g, '');
              const cdMatch = cleanLine.match(/^cd(?:\s+(.+))?$/);
              if (cdMatch) {
                const arg = (cdMatch[1] || '').trim().replace(/^["']|["']$/g, '');
                const nextCwd = resolveCwd(session.cwd, arg);
                session.cwd = nextCwd;
                console.log(`[multicc] Session ${session.id} cwd → ${nextCwd}`);
              }
              inputBuf = '';
            } else if (ch === '\x03' || ch === '\x15') {
              inputBuf = '';
            } else if (ch === '\x7f' || ch === '\b') {
              inputBuf = inputBuf.slice(0, -1);
            } else if (ch >= ' ') {
              inputBuf += ch;
            }
          }
          session.primaryClient = ws;
          tmuxWriteInput(session.id, msg.data);
          session.lastActivity = new Date();
          if (msg.data.includes('\r') || msg.data.includes('\n')) pushOnInput(session.id);
        } else if (msg.type === 'resize') {
          const cols = Math.max(1, msg.cols);
          const rows = Math.max(1, msg.rows);
          ws._desiredCols = cols;
          ws._desiredRows = rows;
          if (firstResize && session.clients.size <= 1) {
            firstResize = false;
            tmuxResize(session.id, cols + 1, rows);
            session.appliedCols = cols + 1;
            session.appliedRows = rows;
          }
          applyMaxClientSize(session);
        } else if (msg.type === 'upload') {
          const { tempId, name, mime, data } = msg;
          const original = (name && path.extname(name).replace(/^\./, '')) || '';
          const ext = original.replace(/[^a-z0-9]/gi, '').slice(0, 10)
            || (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8);
          const tempPath = path.join(os.tmpdir(), `multicc_${Date.now()}.${ext}`);
          fs.writeFileSync(tempPath, Buffer.from(data, 'base64'), { mode: 0o600 });
          console.log(`[multicc] Saved upload: ${tempPath}`);
          sendWs(ws, { type: 'file_saved', tempId, path: tempPath, name });
        }
      } catch (error) {
        console.error('[multicc] Bad message:', error.message, error.stack);
      }
    };

    function detach() {
      session.clients.delete(ws);
      if (session.primaryClient === ws) session.primaryClient = null;
      applyMaxClientSize(session);
    }

    // Attach order is deliberate: the snapshot has to be the first thing this client
    // sees, and the client's own resize — which is what makes the TUI repaint — has to
    // land after it. Otherwise the repaint races the snapshot and the loser is a stale
    // or half-wiped screen. So messages arriving mid-capture are held, not handled, and
    // close/error are wired up front so a client that leaves mid-capture is not added
    // to the fan-out with nothing left to remove it.
    let attached = false;
    const heldMessages = [];
    ws.on('message', raw => { if (attached) onClientMessage(raw); else heldMessages.push(raw); });
    ws.on('close', () => {
      detach();
      console.log(`[multicc] Client left session ${sessionId} (${session.clients.size} remaining)`);
    });
    ws.on('error', error => {
      console.error('[multicc] WebSocket error:', error.message);
      detach();
    });

    // After a refresh, a return from background, or a network blip the terminal must
    // not be blank: those screens are work the user cannot see otherwise. capture-pane
    // already carries 500 lines of scrollback (src/tmux.js). An all-whitespace capture
    // is skipped so a brand-new pane is not pushed a screenful of blank lines.
    let snapshot = '';
    try {
      if (typeof tmuxCaptureSnapshot === 'function') snapshot = (await tmuxCaptureSnapshot(sessionId)) || '';
    } catch (_) {}
    if (ws.readyState !== WebSocket.OPEN) return;
    if (snapshot.trim()) sendWs(ws, { type: 'snapshot', data: snapshot });
    session.clients.add(ws);
    attached = true;
    for (const raw of heldMessages.splice(0)) onClientMessage(raw);
  });

  const wsPingInterval = setInterval(() => {
    // One shared cadence; every window decision (ping, miss count, the ~90s
    // terminate) is native. A port failure must not kill the sweep.
    try { wsHost.tick(wsPorts); } catch (error) {
      logger.warn('ws_heartbeat_tick_failed', { error: String((error && error.message) || error) });
    }
    // The workspace sockets' windows and timeout are decided (and acted on)
    // by their own native owner.
    workspaceRuntime.tickHeartbeat?.();
  }, WS_PING_INTERVAL_MS);
  // Under the front door every /ws/chat client socket reaches this router as a
  // virtual socket from the chat bridge, through the same 'connection' event.
  const chatBridge = startChatBridge({ wss, logger });
  wss.on('close', () => {
    if (chatBridge) chatBridge.stop();
    clearInterval(wsPingInterval);
    try { wsHost.close(wsPorts); } catch (_) {}
    connPortsById.clear();
  });
  return { wsPingInterval };
}

module.exports = { mountWsConnectionRouter };
