'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

function rawKeys(file) {
  const source = fs.readFileSync(file, 'utf8');
  const counts = new Map();
  for (const match of source.matchAll(/^\s*"([^"]+)"\s*:/gm)) {
    counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  }
  return counts;
}

function placeholders(value) {
  return [...String(value).matchAll(/\{([^}]+)\}/g)].map(m => m[1]).sort();
}

const files = {
  zh: path.join(root, 'app', 'assets', 'i18n', 'zh.json'),
  en: path.join(root, 'app', 'assets', 'i18n', 'en.json'),
};
const catalogs = Object.fromEntries(Object.entries(files).map(([locale, file]) => {
  const duplicates = [...rawKeys(file)].filter(([, count]) => count > 1);
  assert.deepStrictEqual(duplicates, [], `${locale} contains duplicate keys: ${duplicates.map(([key]) => key).join(', ')}`);
  return [locale, JSON.parse(fs.readFileSync(file, 'utf8'))];
}));

assert.deepStrictEqual(Object.keys(catalogs.en).sort(), Object.keys(catalogs.zh).sort(),
  'zh/en catalog keys must match exactly');
for (const key of Object.keys(catalogs.zh)) {
  assert.deepStrictEqual(placeholders(catalogs.en[key]), placeholders(catalogs.zh[key]),
    `placeholder mismatch for ${key}`);
}

const context = {
  window: {},
  document: { addEventListener() {}, querySelectorAll() { return []; }, documentElement: {} },
  localStorage: { getItem() { return 'zh'; }, setItem() {} },
  location: { reload() {} },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'public', 'i18n-catalog.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8'), context);

const webRefs = new Set();
for (const name of ['chat.html', 'chat.js', 'manage.html', 'manage.js']) {
  const source = fs.readFileSync(path.join(root, 'public', name), 'utf8');
  for (const match of source.matchAll(/(?:\btt|\bt)\(\s*(['"])([^'"\n]+)\1/g)) webRefs.add(match[2]);
  for (const match of source.matchAll(/data-i18n(?:-title|-placeholder|-aria-label|-value)?=["']([^"']+)["']/g)) webRefs.add(match[1]);
}
for (const locale of ['zh', 'en']) {
  const missing = [...webRefs].filter(key => !(key in context.window.I18N[locale]));
  assert.deepStrictEqual(missing, [], `${locale} Web catalog misses: ${missing.join(', ')}`);
}

console.log(`i18n catalogs OK: ${Object.keys(catalogs.zh).length} shared keys, ${webRefs.size} Web references`);
