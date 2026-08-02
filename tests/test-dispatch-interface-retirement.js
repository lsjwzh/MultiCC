'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { routePostTurn } = require('../src/chat/post-turn-router');

const ROOT = path.join(__dirname, '..');

test('legacy HTTP and assistant-marker dispatch implementations are removed', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'src/dispatch/markers.js')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'src/dispatch/legacy-commander-route.js')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'src/routes/dispatch-contract.js')), false);
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.doesNotMatch(server, /app\.post\(['"]\/api\/(?:v1\/)?sessions\/:id\/dispatch/);
});

test('marker-shaped assistant prose is inert for ordinary and Commander turns', () => {
  for (const sessionType of ['normal', 'commander']) {
    const routed = routePostTurn({
      turnId: `turn-${sessionType}`,
      sessionId: `session-${sessionType}`,
      sessionType,
      finalText: '<<route target="worker-1">do it</route>>\n<<dispatch target="worker-2">do it</dispatch>>',
    });
    assert.deepEqual(routed.effects, []);
  }
});

test('the only executable cross-session interface advertised to agents is MCP', () => {
  const prompt = fs.readFileSync(path.join(ROOT, 'src/routes/agent-resources.js'), 'utf8');
  const mcp = fs.readFileSync(path.join(ROOT, 'scripts/multicc-router-mcp.js'), 'utf8');
  assert.match(prompt, /MCP/);
  assert.match(prompt, /dispatch_master/);
  assert.match(mcp, /enum: \['sync', 'async'\]/);
  assert.match(mcp, /name: 'route_task'/);
});
