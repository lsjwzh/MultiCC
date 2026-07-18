// Voice domain — STT vocabulary learning, prompt building, and the OpenRouter
// refinement call. Extracted from server.js as the first real leaf module.
//
// Config (OPENROUTER_*/WHISPER_*) is hot-reloaded from the settings UI at
// runtime. It lives in the mutable `cfg` object — NOT as module-level `let`s —
// so callers see updates through `voice.cfg.X`. Never destructure `cfg`: that
// would snapshot the value and miss later applyEnvUpdates() changes (the exact
// stale-binding bug that splitting server.js could have introduced).
const fs = require('fs');
const { createPaths } = require('./paths');
const { atomicWriteJson } = require('./runtime-security');

const RUNTIME_PATHS = createPaths({ dataDir: process.env.MULTICC_DATA_DIR });
const VOICE_EXAMPLES_FILE = RUNTIME_PATHS.voiceExamplesFile;
const WHISPER_VOCAB_FILE = RUNTIME_PATHS.whisperVocabFile;

// Mutable runtime config, keyed by env var name for trivial applyEnvUpdates().
const cfg = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001',
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  WHISPER_API_KEY: process.env.WHISPER_API_KEY || '',
  WHISPER_BASE_URL: process.env.WHISPER_BASE_URL || 'https://openrouter.ai/api/v1',
  WHISPER_MODEL: process.env.WHISPER_MODEL || 'whisper-large-v3-turbo',
  WHISPER_LANGUAGE: process.env.WHISPER_LANGUAGE || 'zh',
  WHISPER_PROMPT: process.env.WHISPER_PROMPT || '',
};

// Apply a batch of env-keyed updates (from the settings route) onto cfg.
// Only the voice keys are touched; unrelated keys (ASR_*, etc.) are ignored.
function applyEnvUpdates(updates) {
  for (const k of Object.keys(cfg)) {
    if (updates[k] !== undefined) cfg[k] = updates[k];
  }
}

function loadVoiceExamples() {
  try {
    if (fs.existsSync(VOICE_EXAMPLES_FILE)) {
      const data = JSON.parse(fs.readFileSync(VOICE_EXAMPLES_FILE, 'utf8'));
      return Array.isArray(data) ? data.slice(-5) : [];
    }
  } catch (_) {}
  return [];
}

function appendVoiceExample(entry) {
  let data = [];
  try {
    if (fs.existsSync(VOICE_EXAMPLES_FILE)) {
      data = JSON.parse(fs.readFileSync(VOICE_EXAMPLES_FILE, 'utf8'));
      if (!Array.isArray(data)) data = [];
    }
  } catch (_) {}
  data.push(entry);
  if (data.length > 50) data = data.slice(-50);
  try {
    atomicWriteJson(VOICE_EXAMPLES_FILE, data);
  } catch (e) {
    console.error('[multicc] Failed to write voice_examples.json:', e.message);
  }
}

// ── Whisper vocabulary (user-corrected terms) ──
function loadWhisperVocab() {
  try {
    if (fs.existsSync(WHISPER_VOCAB_FILE)) {
      const data = JSON.parse(fs.readFileSync(WHISPER_VOCAB_FILE, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (_) {}
  return [];
}

function saveWhisperVocab(vocab) {
  try {
    atomicWriteJson(WHISPER_VOCAB_FILE, vocab);
  } catch (e) {
    console.error('[multicc] Failed to write whisper_vocab.json:', e.message);
  }
}

/**
 * Extract correction terms by diffing raw STT output against user's final edit.
 * Segments text into tokens, finds words the user replaced/added.
 * Returns an array of { wrong, correct } pairs.
 */
function extractCorrections(raw, userFinal) {
  if (!raw || !userFinal || raw === userFinal) return [];

  // Tokenize: split into Chinese chars / English words / mixed tokens
  const tokenize = s => s.match(/[a-zA-Z][a-zA-Z0-9_./-]*/g) || [];

  const rawTokens = new Set(tokenize(raw).map(t => t.toLowerCase()));
  const finalTokens = tokenize(userFinal);

  const corrections = [];
  for (const token of finalTokens) {
    // Token appears in userFinal but NOT in raw → user corrected something to this
    if (token.length > 1 && !rawTokens.has(token.toLowerCase())) {
      corrections.push(token);
    }
  }
  return corrections;
}

/**
 * Merge new correction terms into whisper_vocab.json (deduplicated).
 * Each entry: { term, count, lastSeen }
 */
function mergeWhisperVocab(newTerms) {
  if (!newTerms || newTerms.length === 0) return;
  const vocab = loadWhisperVocab();
  const termMap = new Map(vocab.map(v => [v.term.toLowerCase(), v]));

  for (const term of newTerms) {
    const key = term.toLowerCase();
    if (termMap.has(key)) {
      const existing = termMap.get(key);
      existing.count = (existing.count || 1) + 1;
      existing.lastSeen = new Date().toISOString();
      // Keep the casing from the latest correction
      existing.term = term;
    } else {
      termMap.set(key, { term, count: 1, lastSeen: new Date().toISOString() });
    }
  }

  // Sort by count desc, keep top 100
  const sorted = [...termMap.values()].sort((a, b) => b.count - a.count).slice(0, 100);
  saveWhisperVocab(sorted);
  console.log(`[multicc/stt] Whisper vocab updated: ${sorted.length} terms, added: ${newTerms.join(', ')}`);
}

// ── Backfill: seed whisper_vocab.json from existing voice_examples on first run ──
function backfillWhisperVocab() {
  try {
    if (fs.existsSync(WHISPER_VOCAB_FILE)) return; // already initialized
    if (!fs.existsSync(VOICE_EXAMPLES_FILE)) return;
    const examples = JSON.parse(fs.readFileSync(VOICE_EXAMPLES_FILE, 'utf8'));
    if (!Array.isArray(examples)) return;
    const allTerms = [];
    for (const ex of examples) {
      const corrections = extractCorrections(ex.raw, ex.userFinal);
      allTerms.push(...corrections);
    }
    if (allTerms.length > 0) {
      mergeWhisperVocab(allTerms);
      console.log(`[multicc/stt] Backfilled whisper_vocab.json from ${examples.length} voice examples`);
    }
  } catch (e) {
    console.error('[multicc/stt] Backfill error:', e.message);
  }
}

/**
 * Build a prompt for Whisper STT to improve recognition of technical terms.
 * Sources (in order):
 *   1. WHISPER_PROMPT — user-configured static terms (from settings / .env)
 *   2. whisper_vocab.json — auto-accumulated from user corrections (feedback)
 * Whisper prompt limit is ~224 tokens, so we keep it concise.
 */
function buildWhisperPrompt() {
  const parts = [];

  // 1. User-configured static prompt (highest priority)
  if (cfg.WHISPER_PROMPT) parts.push(cfg.WHISPER_PROMPT.trim());

  // 2. Load accumulated vocabulary from user corrections
  try {
    const vocab = loadWhisperVocab();
    if (vocab.length > 0) {
      // Already sorted by count desc in mergeWhisperVocab; take top 40
      const terms = vocab.slice(0, 40).map(v => v.term);
      parts.push(terms.join(', '));
    }
  } catch (_) {}

  const prompt = parts.join('. ');
  // Whisper prompt is limited to ~224 tokens; truncate to ~500 chars as safety margin
  return prompt.length > 500 ? prompt.slice(0, 500) : prompt;
}

/**
 * Call OpenRouter API with streaming for voice refinement.
 * Replaces the old CLI spawn approach for much lower latency.
 * Supports concurrent requests (no sequential queue needed).
 */
async function callVoiceAPI(prompt, { reqId, onStart, onFirstToken, onChunk, onDone, onError }) {
  if (typeof onStart === 'function') onStart();

  if (!cfg.OPENROUTER_API_KEY) {
    onError('OPENROUTER_API_KEY 环境变量未设置');
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 60000);

  try {
    const apiStart = Date.now();
    console.log(`[multicc/voice][${reqId}] Sending request to OpenRouter (model: ${cfg.OPENROUTER_MODEL})`);
    const response = await fetch(`${cfg.OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: cfg.OPENROUTER_MODEL,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter API ${response.status}: ${errText.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstTokenSent = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              if (!firstTokenSent) {
                firstTokenSent = true;
                if (typeof onFirstToken === 'function') onFirstToken(Date.now() - apiStart);
              }
              onChunk(content);
            }
          } catch (_) { /* skip non-JSON lines */ }
        }
      }
    } finally {
      reader.releaseLock();
    }

    clearTimeout(timeout);
    onDone();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      onChunk('[超时：AI处理超过60秒，已中止]');
      onDone();
    } else {
      onError(err.message);
    }
  }
}

// Seed vocab on first load (was an IIFE at server.js module scope).
backfillWhisperVocab();
console.log(`[multicc/voice] Voice API initialized (OpenRouter, model: ${cfg.OPENROUTER_MODEL})`);

module.exports = {
  cfg,
  applyEnvUpdates,
  loadVoiceExamples,
  appendVoiceExample,
  loadWhisperVocab,
  saveWhisperVocab,
  extractCorrections,
  mergeWhisperVocab,
  buildWhisperPrompt,
  callVoiceAPI,
};
