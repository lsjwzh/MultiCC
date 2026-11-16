#!/usr/bin/env node
'use strict';

// Reconciles docs/rust-migration/node-surface-ledger.json against the runtime
// capture in docs/backend-runtime-inventory.md. Run it after every
// `node scripts/capture-backend-routes.js`: a cluster that gained or lost a
// route, a route no cluster claims, or a middleware layer that is not placed in
// a group all fail here instead of leaving the ledger quietly stale.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LEDGER = path.join(ROOT, 'docs/rust-migration/node-surface-ledger.json');
const INVENTORY = path.join(ROOT, 'docs/backend-runtime-inventory.md');

function parseInventory(text) {
  const lines = text.split('\n');
  const routes = [];
  for (const line of lines) {
    const cells = line.split('|').map(cell => cell.trim());
    if (cells.length >= 6 && /^[\w./-]+\.js:\d+$/.test(cells[1]) && /^[A-Z, ]+$/.test(cells[2])) {
      routes.push({ source: cells[1].replace(/:\d+$/, ''), methods: cells[2], route: cells[3].replace(/^"|"$/g, '') });
    }
  }
  const start = lines.findIndex(line => /^## Middleware and router order/.test(line));
  const layers = [];
  const seen = new Map();
  if (start >= 0) {
    for (const line of lines.slice(start)) {
      const cells = line.split('|').map(cell => cell.trim());
      if (cells.length >= 7 && /^\d+$/.test(cells[2])) {
        const mount = cells[4].replace(/\\\//g, '/').replace(/^\/\^|\(\?=.*$/g, '').replace(/\\\?/g, '?').replace(/\/\?$/, '') || '/';
        const base = `${cells[3]}@${mount}`;
        seen.set(base, (seen.get(base) || 0) + 1);
        layers.push({ position: Number(cells[2]), name: cells[3], key: `${base}#${seen.get(base)}` });
      }
    }
  }
  return { routes, layers };
}

function fileMatches(pattern, file) {
  if (!pattern.includes('*')) return pattern === file;
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${source}$`).test(file);
}

function reconcile(ledger, inventory) {
  const problems = [];
  const perCluster = new Map(ledger.clusters.map(cluster => [cluster.id, 0]));
  for (const route of inventory.routes) {
    const hits = ledger.clusters.filter(cluster => cluster.files.some(pattern => fileMatches(pattern, route.source)));
    if (hits.length === 0) problems.push(`route not claimed by any cluster: ${route.source} ${route.methods} ${route.route}`);
    else if (hits.length > 1) problems.push(`route claimed by ${hits.length} clusters: ${route.source} (${hits.map(h => h.id).join(', ')})`);
    else perCluster.set(hits[0].id, perCluster.get(hits[0].id) + 1);
  }
  for (const cluster of ledger.clusters) {
    const actual = perCluster.get(cluster.id);
    if (actual !== cluster.routes) problems.push(`cluster ${cluster.id}: ledger says ${cluster.routes} routes, capture has ${actual}`);
  }
  const claimed = ledger.clusters.reduce((sum, cluster) => sum + cluster.routes, 0);
  if (claimed !== inventory.routes.length) problems.push(`ledger clusters total ${claimed} routes, capture has ${inventory.routes.length}`);
  if (ledger.capture.routes !== inventory.routes.length) problems.push(`ledger.capture.routes=${ledger.capture.routes}, capture has ${inventory.routes.length}`);

  const placed = new Map();
  for (const group of ledger.middleware.groups) {
    for (const key of group.layers) {
      if (placed.has(key)) problems.push(`middleware layer ${key} is in two groups: ${placed.get(key)} and ${group.id}`);
      placed.set(key, group.id);
    }
    if (group.count !== group.layers.length) problems.push(`middleware group ${group.id}: count=${group.count} but ${group.layers.length} layers`);
  }
  for (const layer of inventory.layers) {
    if (!placed.has(layer.key)) problems.push(`middleware layer not placed in any group: ${layer.key}`);
  }
  const known = new Set(inventory.layers.map(layer => layer.key));
  for (const key of placed.keys()) {
    if (!known.has(key)) problems.push(`ledger places a middleware layer that is not in the capture: ${key}`);
  }
  if (ledger.middleware.total !== inventory.layers.length) problems.push(`ledger.middleware.total=${ledger.middleware.total}, capture has ${inventory.layers.length}`);
  return problems;
}

function main() {
  const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  const inventory = parseInventory(fs.readFileSync(INVENTORY, 'utf8'));
  const problems = reconcile(ledger, inventory);
  if (problems.length) {
    for (const problem of problems) console.error(`ledger drift: ${problem}`);
    process.exitCode = 1;
    return;
  }
  const states = {};
  for (const cluster of ledger.clusters) states[cluster.state] = (states[cluster.state] || 0) + cluster.routes;
  console.log(JSON.stringify({ routes: inventory.routes.length, middleware: inventory.layers.length, clusters: ledger.clusters.length, byState: states }));
}

if (require.main === module) main();
module.exports = { parseInventory, reconcile, fileMatches };
