// Skill converter — transform skills between Claude Code, Codex, and Hermes formats.
//
// Three providers, three different SKILL.md frontmatter conventions:
//
//   Claude:  name, description, + optional version/metadata/allowed-tools
//   Codex:   name, description ONLY (spec says "no other fields")
//   Hermes:  name, description, display_name, version, metadata.hermes.tags/related
//            + two-level structure (category DESCRIPTION.md → sub-skill SKILL.md)
//
// This module provides:
//   1. Mechanical transforms (frontmatter strip/add, no AI needed)
//   2. AI-assisted deep conversion (rewrite instructions for target agent's tools)
//   3. Conversion cache (~/.agents/skills/<name>/.converted/<provider>/)
//
// Integration: called from server.js syncSharedSkills() when a new skill appears.

const fs = require('fs');
const path = require('path');
const os = require('os');

const AGENTS_ROOT = path.join(os.homedir(), '.agents', 'skills');
const CONVERTED_DIR = '.converted';

// ── Format specs ────────────────────────────────────────────────────────

const PROVIDERS = {
  claude: {
    dir: path.join(os.homedir(), '.claude', 'skills'),
    allowedFields: null, // all fields allowed
    extraFiles: [],
    description: 'Claude Code',
  },
  codex: {
    dir: path.join(os.homedir(), '.codex', 'skills'),
    allowedFields: new Set(['name', 'description']),
    extraFiles: ['agents/openai.yaml'],
    description: 'OpenAI Codex',
  },
  hermes: {
    dir: path.join(os.homedir(), '.hermes', 'skills'),
    requiredFields: ['name', 'description'],
    recommendedFields: ['display_name', 'version'],
    extraFiles: [],
    description: 'Hermes Agent',
  },
};

// ── Frontmatter parsing ─────────────────────────────────────────────────

function parseFrontmatter(text) {
  // Normalize line endings to LF before parsing
  let normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---\n'))
    return { fm: {}, body: text, rawFm: '' };
  const endIdx = normalized.indexOf('\n---', 4);
  if (endIdx === -1) return { fm: {}, body: normalized, rawFm: '' };
  const fmText = normalized.substring(4, endIdx);
  const body = normalized.substring(endIdx + 4).replace(/^\n+/, '');
  const fm = {};
  const lines = fmText.split('\n');
  for (const line of lines) {
    const indentMatch = line.match(/^(\s*)(\S.*)$/);
    if (!indentMatch) continue;
    const indent = indentMatch[1];
    const content = indentMatch[2];
    if (indent !== '') continue; // skip nested metadata blocks
    const kv = content.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[kv[1]] = val;
  }
  return { fm, body, rawFm: fmText };
}

function serializeFrontmatter(fm) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fm)) {
    const needsQuote = typeof value === 'string' &&
      (value.includes(':') || value.includes('#') || value.includes('"') || value.includes("'"));
    if (needsQuote) {
      lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// ── Mechanical transforms ───────────────────────────────────────────────

function normalizeFrontmatter(text, allowedFields) {
  const { fm, body } = parseFrontmatter(text);
  if (!allowedFields) return text; // no restriction — return as-is

  const stripped = {};
  for (const key of Object.keys(fm)) {
    if (allowedFields.has(key)) stripped[key] = fm[key];
  }
  return serializeFrontmatter(stripped) + '\n\n' + body;
}

function toHermesStandalone(canonicalText, skillName) {
  const { fm, body } = parseFrontmatter(canonicalText);
  const hermesFm = {};
  hermesFm.name = fm.name || skillName;
  hermesFm.description = fm.description || '';
  hermesFm.version = fm.version || '1.0.0';

  const displayName = fm.name
    ? fm.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : skillName;
  hermesFm.display_name = displayName;

  return serializeFrontmatter(hermesFm) + '\n\n' + body;
}

function generateOpenaiYaml(fm) {
  const displayName = fm.name
    ? fm.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : 'Skill';
  const shortDesc = (fm.description || '').slice(0, 120);
  const defaultPrompt = `Use the ${fm.name || 'skill'} skill when needed.`;

  return [
    `display_name: "${displayName}"`,
    `short_description: "${shortDesc.replace(/"/g, '\\"')}"`,
    `default_prompt: "${defaultPrompt.replace(/"/g, '\\"')}"`,
  ].join('\n') + '\n';
}

// ── Mechanical conversion ───────────────────────────────────────────────

function mechanicalConvert(sourceDir, targetProvider) {
  const sourceFile = path.join(sourceDir, 'SKILL.md');
  if (!fs.existsSync(sourceFile)) return null;
  const sourceText = fs.readFileSync(sourceFile, 'utf8');
  const { fm } = parseFrontmatter(sourceText);
  const result = { files: {} };

  switch (targetProvider) {
    case 'claude':
      result.files['SKILL.md'] = sourceText;
      break;
    case 'codex':
      result.files['SKILL.md'] = normalizeFrontmatter(sourceText, PROVIDERS.codex.allowedFields);
      result.files['agents/openai.yaml'] = generateOpenaiYaml(fm);
      break;
    case 'hermes':
      result.files['SKILL.md'] = toHermesStandalone(sourceText, path.basename(sourceDir));
      break;
    default:
      return null;
  }
  return result;
}

// ── Conversion cache ────────────────────────────────────────────────────

function convertedCachePath(skillName, provider) {
  return path.join(AGENTS_ROOT, skillName, CONVERTED_DIR, provider);
}

function isConverted(skillName, provider) {
  const cacheDir = convertedCachePath(skillName, provider);
  return fs.existsSync(path.join(cacheDir, 'SKILL.md'));
}

function writeConvertedCache(skillName, provider, files) {
  const cacheDir = convertedCachePath(skillName, provider);
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const targetPath = path.join(cacheDir, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf8');
  }
  fs.writeFileSync(path.join(cacheDir, '.converter-version'), '1', 'utf8');
}

// ── AI-assisted deep conversion ────────────────────────────────────────
//
// Mechanical transforms handle format-level changes (frontmatter fields).
// But when a skill's instructions reference tools specific to one agent,
// a real AI should rewrite the body for the target environment.
//
// We queue AI conversion requests; server.js provides a callback that spawns
// background chat sessions to do the actual rewriting.

let _aiConvertQueue = [];
let _aiConvertTimer = null;
let _aiConvertCallback = null;

function onAiConvertNeeded(callback) {
  _aiConvertCallback = callback;
}

function requestAiConvert(skillName, targetProvider) {
  if (isConverted(skillName, targetProvider)) return;
  const exists = _aiConvertQueue.some(e => e.skillName === skillName && e.provider === targetProvider);
  if (exists) return;
  _aiConvertQueue.push({ skillName, provider: targetProvider });

  if (!_aiConvertTimer) {
    _aiConvertTimer = setTimeout(() => {
      _aiConvertTimer = null;
      const batch = [..._aiConvertQueue];
      _aiConvertQueue = [];
      if (_aiConvertCallback) _aiConvertCallback(batch);
    }, 3000);
  }
}

function buildAiConvertPrompt(skillName, targetProvider) {
  const sourceDir = path.join(AGENTS_ROOT, skillName);
  const sourceFile = path.join(sourceDir, 'SKILL.md');
  const sourceText = fs.existsSync(sourceFile)
    ? fs.readFileSync(sourceFile, 'utf8')
    : '(no SKILL.md)';
  const convDir = convertedCachePath(skillName, targetProvider);
  const prov = PROVIDERS[targetProvider];

  let instructions = '';
  switch (targetProvider) {
    case 'codex':
      instructions = [
        `Convert this skill for OpenAI Codex. Rules:`,
        `1. Frontmatter MUST contain ONLY "name" and "description". Strip all other fields.`,
        `2. Make the description informative — it's the ONLY trigger Codex uses.`,
        `3. If the body references tools unavailable in Codex, note alternatives or adapt.`,
        `4. Generate a valid agents/openai.yaml: display_name, short_description, default_prompt.`,
        `5. Write SKILL.md → ${convDir}/SKILL.md`,
        `6. Write agents/openai.yaml → ${convDir}/agents/openai.yaml`,
        `7. Output "CONVERTED" on success.`,
      ].join('\n');
      break;
    case 'hermes':
      instructions = [
        `Convert this skill for Hermes Agent (Nous Research, Python-based). Rules:`,
        `1. Frontmatter: name, description, display_name, version, metadata.hermes.tags.`,
        `2. Derive a human-readable display_name from the skill name.`,
        `3. Add 2-4 relevant metadata.hermes.tags.`,
        `4. Hermes uses Python — adapt shell commands to Python alternatives where possible.`,
        `5. Write SKILL.md → ${convDir}/SKILL.md`,
        `6. Output "CONVERTED" on success.`,
      ].join('\n');
      break;
    default:
      instructions = `Convert the skill for ${prov.description}. Write to ${convDir}/SKILL.md.`;
  }

  return {
    prompt: `${instructions}\n\n--- SOURCE SKILL (${skillName}) ---\n${sourceText}`,
    outputDir: convDir,
    skillName,
    provider: targetProvider,
  };
}

// ── Main orchestrator ───────────────────────────────────────────────────

function ensureSkillConverted(skillName) {
  const sourceDir = path.join(AGENTS_ROOT, skillName);
  if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) {
    return { mechanical: [], queuedAi: [] };
  }

  const mechanical = [];
  const queuedAi = [];

  for (const provName of Object.keys(PROVIDERS)) {
    if (provName === 'claude') continue;
    if (isConverted(skillName, provName)) continue;

    const result = mechanicalConvert(sourceDir, provName);
    if (result) {
      writeConvertedCache(skillName, provName, result.files);
      mechanical.push(provName);
    }

    requestAiConvert(skillName, provName);
    queuedAi.push(provName);
  }

  return { mechanical, queuedAi };
}

function getLinkTarget(skillName, provider) {
  if (provider === 'claude') {
    const src = path.join(AGENTS_ROOT, skillName);
    return fs.existsSync(path.join(src, 'SKILL.md')) ? src : null;
  }

  const cached = convertedCachePath(skillName, provider);
  if (fs.existsSync(path.join(cached, 'SKILL.md'))) return cached;

  const src = path.join(AGENTS_ROOT, skillName);
  if (fs.existsSync(path.join(src, 'SKILL.md'))) return src;
  return null;
}

function conversionStatus(skillName) {
  const status = {};
  for (const provName of Object.keys(PROVIDERS)) {
    if (provName === 'claude') {
      status[provName] = 'native';
      continue;
    }
    const cached = isConverted(skillName, provName);
    const aiQueued = _aiConvertQueue.some(
      e => e.skillName === skillName && e.provider === provName
    );
    status[provName] = cached ? 'converted' : (aiQueued ? 'queued' : 'pending');
  }
  return status;
}

module.exports = {
  PROVIDERS,
  AGENTS_ROOT,
  CONVERTED_DIR,
  parseFrontmatter,
  serializeFrontmatter,
  normalizeFrontmatter,
  toHermesStandalone,
  generateOpenaiYaml,
  mechanicalConvert,
  ensureSkillConverted,
  buildAiConvertPrompt,
  convertedCachePath,
  isConverted,
  writeConvertedCache,
  getLinkTarget,
  onAiConvertNeeded,
  requestAiConvert,
  conversionStatus,
};
