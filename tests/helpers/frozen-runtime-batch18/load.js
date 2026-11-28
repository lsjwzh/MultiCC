'use strict';
// Test-only CommonJS loading. Frozen bytes never import the candidate binding.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
function count(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
// Frozen contract of the already-native dependency at 4dd9f2c. No candidate
// exports are read, even when the candidate accounting implementation changes.
const counters = {
  codexCumulativeUsage(value) {
    const cached = count(value.cache_read_input_tokens == null ? value.cached_input_tokens : value.cache_read_input_tokens) ?? 0;
    const input = count(value.input_tokens) ?? 0;
    const fresh = value.cache_read_input_tokens == null ? Math.max(0, input - cached) : input;
    return { fresh, cached, cacheWrite: count(value.cache_creation_input_tokens) ?? 0,
      output: count(value.output_tokens) ?? 0, reasoning: count(value.reasoning_output_tokens) ?? 0 };
  },
  usageTokenComponents(input, read, write, output) {
    const freshInputTokens = count(input) ?? 0, cacheReadTokens = count(read) ?? 0, cacheWriteTokens = count(write) ?? 0;
    return { freshInputTokens, cacheReadTokens, cacheWriteTokens,
      consumedInputTokens: freshInputTokens + cacheReadTokens + cacheWriteTokens, outputTokens: count(output) ?? 0 };
  },
};
function load(name, binding = {}, modules = {}) {
  const file = path.join(__dirname, name + '.js');
  const instance = new Module(file, module);
  instance.filename = file;
  instance.paths = Module._nodeModulePaths(__dirname);
  instance.require = id => {
    if (Object.hasOwn(modules, id)) return modules[id];
    if (id === './native/binding' || id === '../native/binding') return {
      getNative: () => counters, getTurnProgress: () => ({ field: () => ({}) }), ...binding,
    };
    return require(id);
  };
  instance._compile(fs.readFileSync(file, 'utf8'), file);
  return instance.exports;
}
module.exports = { load };
