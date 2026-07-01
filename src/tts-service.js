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

// Edge TTS via command line
async function edgeTtsSession(opts, cb) {
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

  return new Promise((resolve) => {
    let settled = false;
    let proc;
    try {
      proc = spawn(cfg.edge.command, params);
    } catch (e) {
      // spawn() itself threw (very rare); treat like ENOENT.
      console.error('[TTS][edge] spawn threw:', e.message);
      cb.onError(`edge-tts 不可用：${e.message}`);
      resolve(null);
      return;
    }

    let audioData = [];

    // CRITICAL: handle the 'error' event (ENOENT when edge-tts is not on
    // PATH, EACCES, etc.). Without this listener Node re-throws it as an
    // unhandled exception and crashes the whole server — which is what killed
    // in-flight /api/voice/confirm requests and made S2S look "stuck".
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      console.error('[TTS][edge] spawn error:', err.message);
      cb.onError(`edge-tts 不可用：${err.message}（请安装 edge-tts 或在设置里切换 TTS 提供方）`);
      resolve(null);
    });

    proc.stdout.on('data', (chunk) => {
      // Save raw MP3 data
      audioData.push(chunk);
    });

    proc.stderr.on('data', (err) => {
      console.error('[TTS][edge] stderr:', err.toString());
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        cb.onError(`edge-tts exited with code ${code}`);
        resolve(null);
        return;
      }

      // Send ready signal
      cb.onReady(cfg.edge.sampleRate);

      // Send all audio chunks
      for (const chunk of audioData) {
        cb.onAudio(chunk);
      }
      cb.onDone();
      resolve(null);
    });
  });
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
      if (session) {
        session.stop();
        session = null;
      }
    }
  });

  ws.on('close', () => {
    if (session) {
      session.stop();
      session = null;
    }
  });
}

module.exports = {
  handleTtsWs,
  applyConfig,
  providerStatus,
  cfg,
};
