'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getNative, pathSafety } = require('../native/binding');

const PKG_ROOT = path.resolve(__dirname, '../..');
const ports = { fs, os, path, process, pkgRoot: PKG_ROOT };
let api;
function pathsApi() { return api ??= getNative().appPathsApi(ports); }

function createPaths(options = {}) { return pathsApi().createPaths(options); }
function resolveDataDir(override) { return pathsApi().resolveDataDir(override); }
function assertTestDir(dir) { return pathsApi().assertTestDir(dir); }

module.exports = {
  createPaths,
  resolveDataDir,
  assertTestDir,
  isHomeOrAbove: pathSafety.isHomeOrAbove,
  realPathOf: pathSafety.realPathOf,
  PKG_ROOT,
};
