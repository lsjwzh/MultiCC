// Streaming TTS Service - Real-time audio output for AI responses
// Supports multiple providers: Edge TTS, OpenAI TTS, Volcano TTS

const WebSocket = require('ws');
const { spawn } = require('child_process');
const https = require('https');

// Configuration
const cfg = {
  defaultProvider: process.env.TTS_PROVIDER || 'edge',
  edge: {
    // Allow an absolute path override (e.g. when the binary lives in a Python
    // user-bin dir not on pm2's PATH). Falls back to looking up "edge-tts".
    command: process.env.EDGE_TTS_CMD || 'edge-tts',
    params: ['--voice', 'zh-CN-XiaoxiaoNeural'],
    sampleRate: 24000,
  },
  openai: {
    apiKey: process.env.OPENAI_TTS_API_KEY || '',
    url: 'https://api.openai.com/v1/audio/speech',
    model: 'tts-1',
    voice: 'alloy',
    sampleRate: 24000,
  },
  volcano: {
    appId: process.env.VOLC_TTS_APP_ID || '',
    accessToken: process.env.VOLC_TTS_ACCESS_TOKEN || '',
    url: 'wss://openspeech.bytedance.com/api/v1/sauc/bigmodel',
    resourceId: 'volc.bigasr.sauc.duration',
    sampleRate: 24000,
  },
};

function applyConfig(updates) {
  if (!updates) return;
  if (updates.TTS_PROVIDER) cfg.defaultProvider = updates.TTS_PROVIDER;
  if (updates.EDGE_TTS_VOICE !== undefined) cfg.edge.params[cfg.edge.params.indexOf('--voice') + 1] = `--voice ${updates.EDGE_TTS_VOICE}`;
  if (updates.OPENAI_TTS_API_KEY !== undefined) cfg.openai.apiKey = updates.OPENAI_TTS_API_KEY;
  if (updates.OPENAI_TTS_URL) cfg.openai.url = updates.OPENAI_TTS_URL;
  if (updates.OPENAI_TTS_MODEL) cfg.openai.model = updates.OPENAI_TTS_MODEL;
  if (updates.OPENAI_TTS_VOICE) cfg.openai.voice = updates.OPENAI_TTS_VOICE;
  if (updates.VOLC_TTS_APP_ID !== undefined) cfg.volcano.appId = updates.VOLC_TTS_APP_ID;
  if (updates.VOLC_TTS_ACCESS_TOKEN !== undefined) cfg.volcano.accessToken = updates.VOLC_TTS_ACCESS_TOKEN;
  if (updates.VOLC_TTS_URL) cfg.volcano.url = updates.VOLC_TTS_URL;
}

function providerStatus() {
  const status = {};
  
  // Edge TTS check
  try {
    const result = spawn('which', ['edge-tts']);
    result.on('error', () => { status.edge = { ready: false }; }); // 'which' missing — unlikely
    result.on('close', code => {
      status.edge = { ready: code === 0, command: 'edge-tts' };
    });
  } catch (e) {
    status.edge = { ready: false };
  }
  
  // OpenAI TTS check
  status.openai = {
    ready: !!cfg.openai.apiKey,
    model: cfg.openai.model,
    voice: cfg.openai.voice,
  };
  
  // Volcano TTS check
  status.volcano = {
    ready: !!(cfg.volcano.appId && cfg.volcano.accessToken),
    resourceId: cfg.volcano.resourceId,
  };
  
  return status;
}

// Edge TTS via command line. Returns a session handle with .stop() so the WS
// handler can interrupt playback; NOT a Promise (the caller does not await).
function edgeTtsSession(opts, cb) {
  const text = opts.text || '';
  if (!text) {
    cb.onError('Text is empty');
    return null;
  }

  const params = [
    '--voice', cfg.edge.params[1],
    '--text', text,
    '--write-media', '/dev/stdout',
    '--rate=+0%',
    '--volume=+0%',
  ];

  let settled = false;
  let stopped = false;
  let proc;
  try {
    proc = spawn(cfg.edge.command, params);
  } catch (e) {
    console.error('[TTS][edge] spawn threw:', e.message);
    cb.onError(`edge-tts 不可用：${e.message}`);
    return null;
  }

  let audioData = [];

  // CRITICAL: handle the 'error' event (ENOENT when edge-tts is not on PATH,
  // EACCES, etc.). Without this listener Node re-throws it as an unhandled
  // exception and crashes the whole server.
  proc.on('error', (err) => {
    if (settled) return;
    settled = true;
    console.error('[TTS][edge] spawn error:', err.message);
    cb.onError(`edge-tts 不可用：${err.message}（请安装 edge-tts 或在设置里切换 TTS 提供方）`);
  });

  proc.stdout.on('data', (chunk) => {
    if (!stopped) audioData.push(chunk);
  });

  proc.stderr.on('data', (err) => {
    console.error('[TTS][edge] stderr:', err.toString());
  });

  proc.on('close', (code) => {
    if (settled) return;
    settled = true;
    if (stopped) return; // interrupted via stop() — drop any partial audio
    if (code !== 0) {
      cb.onError(`edge-tts exited with code ${code}`);
      return;
    }
    cb.onReady(cfg.edge.sampleRate);
    for (const chunk of audioData) cb.onAudio(chunk);
    cb.onDone();
  });

  // Session handle: kill the child process to interrupt playback immediately.
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { proc.kill('SIGTERM'); } catch (_) {}
    },
  };
}

// OpenAI TTS API
async function openaiTtsSession(opts, cb) {
  const text = opts.text || '';
  if (!text) {
    cb.onError('Text is empty');
    return null;
  }

  const body = JSON.stringify({
    model: cfg.openai.model,
    input: text,
    voice: cfg.openai.voice,
    response_format: 'mp3',
  });

  const url = new URL(cfg.openai.url);
  
  return new Promise((resolve) => {
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.openai.apiKey}`,
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', (chunk) => errorData += chunk);
        res.on('end', () => {
          cb.onError(`OpenAI TTS failed: ${res.statusCode} - ${errorData.slice(0, 200)}`);
          resolve(null);
        });
        return;
      }

      const audioChunks = [];
      res.on('data', (chunk) => audioChunks.push(chunk));
      res.on('end', () => {
        cb.onReady(cfg.openai.sampleRate);
        for (const chunk of audioChunks) {
          cb.onAudio(chunk);
        }
        cb.onDone();
        resolve(null);
      });
    });

    req.on('error', (err) => {
      cb.onError(`OpenAI TTS request failed: ${err.message}`);
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

// Volcano TTS WebSocket
function volcanoTtsSession(opts, cb) {
  const text = opts.text || '';
  if (!text) {
    cb.onError('Text is empty');
    return null;
  }

  const ws = new WebSocket(cfg.volcano.url);
  let finished = false;

  ws.on('open', () => {
    ws.send(JSON.stringify({
      app: { appid: cfg.volcano.appId, token: cfg.volcano.accessToken },
      user: { uid: 'multicc' },
      audio: { format: 'pcm', rate: cfg.volcano.sampleRate },
      request: { operation: 'query', text, text_type: 'plain' },
    }));
    cb.onReady(cfg.volcano.sampleRate);
  });

  ws.on('message', (data, isBinary) => {
    if (finished || !isBinary) return;
    cb.onAudio(Buffer.from(data));
  });

  ws.on('error', (err) => {
    if (!finished) {
      finished = true;
      cb.onError(`Volcano TTS connection error: ${err.message}`);
    }
  });

  ws.on('close', () => {
    if (!finished) {
      finished = true;
      cb.onDone();
    }
  });

  return { stop: () => { finished = true; ws.close(); } };
}

// Factory function
function createTtsSession(provider, opts, cb) {
  switch (provider) {
    case 'volcano': return volcanoTtsSession(opts, cb);
    case 'openai': return openaiTtsSession(opts, cb);
    case 'edge':
    default: return edgeTtsSession(opts, cb);
  }
}

// WebSocket handler
function handleTtsWs(ws, req) {
  let session = null;

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (msg.type === 'start') {
      const provider = msg.provider || cfg.defaultProvider;
      const opts = { text: msg.text || '' };

      session = createTtsSession(provider, opts, {
        onReady(sampleRate) {
          ws.send(JSON.stringify({ type: 'ready', provider, sampleRate }));
        },
        onAudio(chunk) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(chunk);
          }
        },
        onDone() {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'done' }));
          }
        },
        onError(message) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message }));
          }
        },
      });

      if (!session) {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to create TTS session' }));
      }
    } else if (msg.type === 'stop') {
      // Provider sessions are expected to be handles with .stop(); guard for
      // any that still return a Promise (can't stop a Promise — don't crash).
      if (session && typeof session.stop === 'function') {
        try { session.stop(); } catch (_) {}
      }
      session = null;
    }
  });

  ws.on('close', () => {
    if (session && typeof session.stop === 'function') {
      try { session.stop(); } catch (_) {}
    }
    session = null;
  });
}

module.exports = {
  handleTtsWs,
  applyConfig,
  providerStatus,
  cfg,
};
