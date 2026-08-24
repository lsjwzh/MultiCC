'use strict';

const { installWsBackpressure } = require('../ws-backpressure');
const { isInternalExecutionSlot } = require('../session/public-session-access');

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
    authSecurity,
    voiceAsr,
    ttsService,
    workspaceRuntime,
    auxQueue,
    auxSessionId,
    loadChatHistory,
    sessions,
    persistedSessions,
    createSession,
    sendWs,
    resolveCwd,
    tmuxWriteInput,
    tmuxResize,
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

  wss.on('connection', async (ws, req) => {
    if (getShuttingDown()) {
      ws.close(1012, 'server shutting down');
      return;
    }
    if (!isRequestPeerAllowed(req)) {
      metrics.inc('multicc_ws_public_peer_rejected_total');
      ws.close(4003, 'Direct public access disabled');
      return;
    }
    const urlObj = new URL(req.url, 'http://localhost');
    const addressedSessionId = urlObj.pathname === '/ws/chat'
      ? urlObj.searchParams.get('session')
      : SESSIONLESS_WS_PATHS.has(urlObj.pathname) ? null : urlObj.searchParams.get('id');
    const addressedDirectoryId = urlObj.pathname === '/ws/workspace'
      ? urlObj.searchParams.get('dirId') : null;
    installWsBackpressure(ws, {
      onMetric: (name, value, op) => op === 'set' ? metrics.set(name, value) : metrics.inc(name, value),
      onLog: (event, fields) => logger.warn(event, { ...fields, correlationId: ws._correlationId }),
    });

    // A valid share token replaces normal auth only for its scoped chat.
    let sharePerm = null;
    if (urlObj.pathname === '/ws/chat' && urlObj.searchParams.get('share')) {
      const access = share.access(urlObj.searchParams.get('share'), {
        cookies: parseCookies(req.headers.cookie),
      });
      if (access && access.sessionId === urlObj.searchParams.get('session')) {
        sharePerm = access.access;
      }
      if (!sharePerm) {
        ws.close(4003, 'Forbidden');
        return;
      }
    }

    // External clients exchange HTTP auth for a one-use, path-bound ticket.
    if (!sharePerm) {
      const ip = req.socket.remoteAddress;
      const local = isLocalRequest(req);
      const cookies = parseCookies(req.headers.cookie);
      const accessToken = getAccessToken();
      const ticket = accessToken
        && authSecurity.consumeWsTicket(urlObj.searchParams.get('ticket'), urlObj.pathname);
      const legacyCookie = accessToken && allowLegacyWsCookie && cookies.multicc_auth
        && authSecurity.verifyCookie(cookies.multicc_auth);
      const legacyToken = accessToken && allowLegacyWsToken
        && authSecurity.verifyAccessToken(urlObj.searchParams.get('token'));
      if (ticket) ws._correlationId = ticket.correlationId || ticket.requestId;
      if (ticket && ((ticket.fleetSessionId && ticket.fleetSessionId !== addressedSessionId)
          || (ticket.fleetDirectoryId && ticket.fleetDirectoryId !== addressedDirectoryId))) {
        metrics.inc('multicc_ws_fleet_scope_denied_total');
        ws.close(4003, 'Forbidden');
        return;
      }
      if (legacyCookie || legacyToken) {
        metrics.inc('multicc_ws_legacy_auth_total');
        logger.warn('legacy_ws_auth', {
          path: urlObj.pathname,
          mode: legacyToken ? 'query' : 'cookie',
          ip,
        });
      }
      if (!local && (!accessToken || (!ticket && !legacyCookie && !legacyToken))) {
        metrics.inc('multicc_ws_auth_denied_total');
        ws.close(4003, 'Forbidden');
        return;
      }
    }

    if (addressedSessionId
        && isInternalExecutionSlot(persistedSessions.get(addressedSessionId))) {
      sendWs(ws, {
        type: 'error',
        error: 'Session does not exist.',
        data: 'Session does not exist.\r\n',
      });
      ws.close();
      return;
    }

    if (urlObj.pathname === '/ws/chat') {
      ws._sharePerm = sharePerm;
      return handleChatWs(ws, req, urlObj);
    }
    if (urlObj.pathname === '/ws/voice') {
      return voiceAsr.handleVoiceWs(ws, req, urlObj);
    }
    if (urlObj.pathname === '/ws/tts') {
      return ttsService.handleTtsWs(ws, req);
    }
    if (urlObj.pathname === '/ws/workspace') {
      return workspaceRuntime.attachWorkspace(ws, urlObj);
    }
    if (urlObj.pathname === '/ws/meta') {
      return workspaceRuntime.attachMeta(ws);
    }
    if (urlObj.pathname === '/ws/aux') {
      auxQueue.attachClient(ws);
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      sendWs(ws, {
        type: 'aux_init',
        status: auxQueue.getStatus(),
        health: { ...auxQueue.health },
      });
      const history = loadChatHistory(auxSessionId);
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
        const message = `Failed to launch ${cliLabel}: ${error.message}\r\n`
          + `Make sure "${cliLabel === 'qoder' ? 'qoderclicn' : cliLabel}" is installed and available in PATH.\r\n`
          + `You can also set the ${cliLabel.toUpperCase()}_CMD environment variable.\r\n`;
        sendWs(ws, { type: 'error', data: message });
        ws.close();
        return;
      }
    }

    session.clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    sendWs(ws, { type: 'session_id', id: sessionId, cli: session.cli || 'claude' });

    // The most recent input client owns resize; the pane uses the maximum
    // dimensions requested by all clients.
    let inputBuf = '';
    let firstResize = true;
    ws.on('message', raw => {
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
    });

    function detach() {
      session.clients.delete(ws);
      if (session.primaryClient === ws) session.primaryClient = null;
      applyMaxClientSize(session);
    }

    ws.on('close', () => {
      detach();
      console.log(`[multicc] Client left session ${sessionId} (${session.clients.size} remaining)`);
    });
    ws.on('error', error => {
      console.error('[multicc] WebSocket error:', error.message);
      detach();
    });
  });

  const wsPingInterval = setInterval(() => {
    wss.clients.forEach(client => {
      if (client.isAlive === false) return client.terminate();
      client.isAlive = false;
      client.ping();
    });
  }, 30000);
  wss.on('close', () => clearInterval(wsPingInterval));
  return { wsPingInterval };
}

module.exports = { mountWsConnectionRouter };
