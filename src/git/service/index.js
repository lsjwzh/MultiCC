'use strict';

const { AsyncResource } = require('node:async_hooks');
const { defaultRepoActor } = require('../../repo-actor');
const { getNative } = require('../../native/binding');

module.exports = getNative().gitServiceApi(defaultRepoActor, process.execPath,
  callback => AsyncResource.bind(callback, 'MultiCCGitOperation'));
