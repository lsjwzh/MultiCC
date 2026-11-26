'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { getNative } = require('../native/binding');

require('../portable-git').addToPath();
module.exports = getNative().repoActorApi({
  process, path: require('node:path'), fs: require('node:fs'),
  randomBytes: require('node:crypto').randomBytes, execFile: promisify(execFile),
  makeClass: initialize => class RepoActor {
    constructor(options = {}) { initialize(this, options); }
  },
});
