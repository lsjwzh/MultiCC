'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.resolve(__dirname, '../../../src');
const cache = new Map();

// Compile the byte-for-byte baseline under its original module filename.
// Unchanged dependencies keep Node's ordinary resolution and cache.
function from(filename, fallback = Module.createRequire(filename)) {
  return function load(id) {
    if (!id.startsWith('.')) return fallback(id);
    const absolute = path.resolve(path.dirname(filename), id);
    const relative = path.relative(root, absolute);
    const key = relative.endsWith('.js') ? relative.slice(0, -3) : relative;
    const source = path.join(__dirname, key + '.js.txt');
    if (key.startsWith('..' + path.sep) || !fs.existsSync(source)) return fallback(id);
    return frozen(key);
  };
}

function frozen(name) {
  if (cache.has(name)) return cache.get(name).exports;
  const filename = path.join(root, name + '.js');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = from(filename);
  cache.set(name, loaded);
  try {
    loaded._compile(fs.readFileSync(path.join(__dirname, name + '.js.txt'), 'utf8'), filename);
    loaded.loaded = true;
    return loaded.exports;
  } catch (error) {
    cache.delete(name);
    throw error;
  }
}

module.exports = { from, frozen };
