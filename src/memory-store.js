'use strict';

// Testable primitives for MultiCC's file-backed memory library.
//
// The chat server owns lifecycle policy (when to inject/review memory). This
// module owns deterministic folder selection and safe curated-entry writes so
// a single oversized README cannot hide an entire memory scope and agents have
// an atomic add/replace/remove path instead of rewriting files ad hoc.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENTRY_DELIMITER = '\n§\n';
const DEFAULT_CURATED_FILE = 'MEMORY.md';

const INVISIBLE_CHARS = new Set([
  '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
  '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
]);

const MEMORY_THREAT_PATTERNS = [
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, 'prompt_injection'],
  [/you\s+are\s+now\s+/i, 'role_hijack'],
  [/do\s+not\s+tell\s+the\s+user/i, 'deception_hide'],
  [/system\s+prompt\s+override/i, 'system_prompt_override'],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, 'disregard_rules'],
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'secret_exfiltration'],
  [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'secret_exfiltration'],
  [/authorized_keys/i, 'ssh_backdoor'],
];

function memoryFilePriority(name, primaryNames = []) {
  const lower = String(name || '').toLowerCase();
  const primary = new Set(primaryNames.map(item => String(item).toLowerCase()));
  if (primary.has(lower) || lower === 'memory.md' || lower === 'user.md') return 0;
  if (lower === '_curated.md') return 0;
  if (lower === '_auto.md') return 2;
  if (lower === 'readme.md') return 3;
  return 1;
}

function compactOmissionNotice(omitted, maxChars) {
  if (!omitted.length || maxChars <= 0) return '';
  const prefix = `（另有 ${omitted.length} 个记忆文件未完整注入：`;
  const suffix = '；需要时按路径读取）';
  if (prefix.length + suffix.length >= maxChars) {
    return `（另有 ${omitted.length} 个记忆文件未注入）`.slice(0, maxChars);
  }
  let names = '';
  for (const item of omitted) {
    const label = item.partial ? `${item.name}（节选）` : item.name;
    const next = names ? `${names}、${label}` : label;
    if (prefix.length + next.length + suffix.length > maxChars) break;
    names = next;
  }
  if (!names) return `（另有 ${omitted.length} 个记忆文件未注入）`.slice(0, maxChars);
  return `${prefix}${names}${names.split('、').length < omitted.length ? ' 等' : ''}${suffix}`;
}

function buildMemoryFolderSnapshot(dir, capChars, opts = {}) {
  const cap = Math.max(0, Number(capChars) || 0);
  let files;
  try {
    files = fs.readdirSync(dir).filter(file => file.toLowerCase().endsWith('.md'));
  } catch (_) {
    return { text: '', included: [], omitted: [], totalChars: 0 };
  }

  const records = [];
  for (const name of files) {
    let body;
    try { body = fs.readFileSync(path.join(dir, name), 'utf8').trim(); }
    catch (_) { continue; }
    if (!body) continue;
    records.push({
      name,
      body,
      priority: memoryFilePriority(name, opts.primaryNames || []),
    });
  }
  records.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  if (!records.length || cap === 0) return { text: '', included: [], omitted: [], totalChars: 0 };

  const fullLength = records.reduce((sum, item) => sum + `#### ${item.name}\n${item.body}`.length, 0);
  const needsOmissionNotice = fullLength > cap;
  const noticeReserve = needsOmissionNotice
    ? Math.min(360, Math.max(120, Math.floor(cap * 0.08)))
    : 0;
  const contentBudget = Math.max(0, cap - noticeReserve);
  const chunks = [];
  const included = [];
  const omitted = [];
  let total = 0;

  for (const item of records) {
    const chunk = `#### ${item.name}\n${item.body}`;
    if (total + chunk.length <= contentBudget) {
      chunks.push(chunk);
      included.push({ name: item.name, chars: chunk.length, partial: false });
      total += chunk.length;
      continue;
    }

    // Curated/primary files carry the highest-signal facts. Preserve a bounded
    // prefix when one of them alone is oversized, then keep scanning so an
    // unrelated large file never blocks smaller memories that still fit.
    const remaining = contentBudget - total;
    if (item.priority === 0 && remaining >= 240) {
      const marker = '\n（本文件超出本轮注入预算，以上为节选）';
      const clipped = chunk.slice(0, Math.max(0, remaining - marker.length)) + marker;
      chunks.push(clipped);
      included.push({ name: item.name, chars: clipped.length, partial: true });
      total += clipped.length;
      omitted.push({ name: item.name, partial: true });
    } else {
      omitted.push({ name: item.name, partial: false });
    }
  }

  // If every file was oversized and none was a recognized primary, retain a
  // bounded excerpt of the first file instead of returning only an error note.
  if (!chunks.length && records.length && contentBudget >= 240) {
    const first = records[0];
    const chunk = `#### ${first.name}\n${first.body}`;
    const marker = '\n（本文件超出本轮注入预算，以上为节选）';
    const clipped = chunk.slice(0, Math.max(0, contentBudget - marker.length)) + marker;
    chunks.push(clipped);
    included.push({ name: first.name, chars: clipped.length, partial: true });
    const existing = omitted.find(item => item.name === first.name);
    if (existing) existing.partial = true;
    else omitted.unshift({ name: first.name, partial: true });
    total += clipped.length;
  }

  if (omitted.length) {
    const separatorCost = chunks.length ? 2 : 0;
    const remaining = Math.max(0, cap - total - separatorCost);
    const notice = compactOmissionNotice(omitted, remaining);
    if (notice) {
      chunks.push(notice);
      total += separatorCost + notice.length;
    }
  }

  return { text: chunks.join('\n\n'), included, omitted, totalChars: total };
}

function readMemoryFolder(dir, capChars, opts) {
  return buildMemoryFolderSnapshot(dir, capChars, opts).text;
}

function scanMemoryContent(content) {
  for (const char of INVISIBLE_CHARS) {
    if (content.includes(char)) {
      return `content contains invisible unicode U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  for (const [pattern, id] of MEMORY_THREAT_PATTERNS) {
    if (pattern.test(content)) return `content matches blocked pattern: ${id}`;
  }
  return null;
}

function readCuratedEntries(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (!raw.trim()) return [];
  return [...new Set(raw.split(ENTRY_DELIMITER).map(item => item.trim()).filter(Boolean))];
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}

function curatedResponse(filePath, entries, charLimit, message) {
  const chars = entries.length ? ENTRY_DELIMITER.join(entries).length : 0;
  return {
    ok: true,
    message,
    file: filePath,
    entries,
    entryCount: entries.length,
    usage: { chars, limit: charLimit, percent: charLimit ? Math.floor(chars / charLimit * 100) : 0 },
    effective: 'current tool response; injected snapshot refreshes with the next native session',
  };
}

function applyCuratedMemoryAction({
  dir,
  action,
  content,
  oldText,
  charLimit = 2200,
  fileName = DEFAULT_CURATED_FILE,
}) {
  if (!dir) return { ok: false, error: 'memory directory is required' };
  if (!['add', 'replace', 'remove'].includes(action)) {
    return { ok: false, error: 'action must be add, replace, or remove' };
  }
  const filePath = path.join(dir, fileName);
  let entries;
  try { entries = readCuratedEntries(filePath); }
  catch (error) { return { ok: false, error: `memory read failed: ${error.message}` }; }

  const value = String(content == null ? '' : content).trim();
  const needle = String(oldText == null ? '' : oldText).trim();
  if (action === 'add' || action === 'replace') {
    if (!value) return { ok: false, error: 'content is required' };
    const threat = scanMemoryContent(value);
    if (threat) return { ok: false, error: `memory write blocked: ${threat}` };
  }

  let next = [...entries];
  let message;
  if (action === 'add') {
    if (next.includes(value)) return curatedResponse(filePath, next, charLimit, 'entry already exists');
    next.push(value);
    message = 'entry added';
  } else {
    if (!needle) return { ok: false, error: 'oldText is required' };
    const matches = next.map((entry, index) => entry.includes(needle) ? index : -1).filter(index => index >= 0);
    if (!matches.length) return { ok: false, error: `no entry matched: ${needle}` };
    if (matches.length > 1) return { ok: false, error: `multiple entries matched: ${needle}` };
    if (action === 'replace') {
      next[matches[0]] = value;
      next = [...new Set(next)];
      message = 'entry replaced';
    } else {
      next.splice(matches[0], 1);
      message = 'entry removed';
    }
  }

  const chars = next.length ? ENTRY_DELIMITER.join(next).length : 0;
  if (chars > charLimit) {
    return {
      ok: false,
      error: `memory would exceed limit (${chars}/${charLimit} chars); replace or remove entries first`,
      entries,
      usage: { chars: entries.length ? ENTRY_DELIMITER.join(entries).length : 0, limit: charLimit },
    };
  }

  try { atomicWrite(filePath, next.join(ENTRY_DELIMITER)); }
  catch (error) { return { ok: false, error: `memory write failed: ${error.message}` }; }
  return curatedResponse(filePath, next, charLimit, message);
}

module.exports = {
  DEFAULT_CURATED_FILE,
  ENTRY_DELIMITER,
  applyCuratedMemoryAction,
  buildMemoryFolderSnapshot,
  memoryFilePriority,
  readCuratedEntries,
  readMemoryFolder,
  scanMemoryContent,
};
