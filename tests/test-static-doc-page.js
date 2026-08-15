'use strict';

// The classify state-machine visual map is a deliverable users open in a
// browser, so its URL is a contract: it lives under public/ and is served by the
// ordinary static-asset mount, not by a bespoke docs route.
//
// This test boots an isolated express instance on an ephemeral port with the
// real `createStaticAssetsRoutes` — the production code path — and asserts both
// halves of that contract: the page is reachable, and serving it did not turn
// public/docs/ into a browsable directory or a traversal foothold.

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { createStaticAssetsRoutes } = require('../src/routes/static-assets');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const DOC_PATH = '/docs/classify-state-machine-architecture';
const DOC_TITLE = '<title>MultiCC Classify 状态机审计</title>';

function startServer() {
  const app = express();
  createStaticAssetsRoutes({ express, fs, path, publicDir: PUBLIC_DIR }).mountRoutes(app);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function fetchPath(server, urlPath) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        contentType: res.headers['content-type'] || '',
        body,
      }));
    }).on('error', reject);
  });
}

test('classify architecture page is served over HTTP', async (t) => {
  const server = await startServer();
  t.after(() => new Promise(resolve => server.close(resolve)));

  // Both the extensionless and explicit forms must work: the first is what we
  // document, the second is what someone copies off the filesystem.
  for (const urlPath of [DOC_PATH, `${DOC_PATH}.html`]) {
    const res = await fetchPath(server, urlPath);
    assert.equal(res.status, 200, `${urlPath} status`);
    assert.match(res.contentType, /^text\/html/, `${urlPath} content-type`);
    assert.ok(res.body.includes(DOC_TITLE), `${urlPath} carries the deliverable's title`);
    // The page states its own canonical URL so a reader who saved a copy can get
    // back to the served one.
    assert.ok(res.body.includes(DOC_PATH), `${urlPath} states its served address`);
  }
});

test('serving the page does not expose the docs directory or the tree above it', async (t) => {
  const server = await startServer();
  t.after(() => new Promise(resolve => server.close(resolve)));

  const listing = await fetchPath(server, '/docs/');
  assert.notEqual(listing.status, 200, 'public/docs/ must not be browsable');

  // Only reviewed HTML pages are published. A sibling markdown source dropped
  // into the same directory later must not silently become web-reachable, so
  // this asserts the directory is not a general doc mount.
  const markdown = await fetchPath(server, '/docs/classify-state-machine-audit.md');
  assert.notEqual(markdown.status, 200, 'repository markdown must not be served');

  for (const attempt of [
    '/docs/../../server.js',
    '/../server.js',
    '/docs/%2e%2e/%2e%2e/server.js',
    '/%2e%2e%2fserver.js',
  ]) {
    const res = await fetchPath(server, attempt);
    assert.ok(
      !(res.status === 200 && res.body.includes('require(')),
      `traversal attempt must not return source: ${attempt} -> ${res.status}`,
    );
  }
});
