'use strict';

// The running bridge remains the oracle until its native transport replaces it.
// ACP wire data is JSON; these cases compare serialized bytes as well as data.
const test = require('node:test');
const assert = require('node:assert/strict');
const legacy = require('./helpers/load-legacy-acp-bridge');
const { getNative } = require('../src/native/binding');

function native(input) {
  return getNative().acpBridgeKernel(JSON.stringify(input));
}
function compare(input, fn) {
  let result;
  try { result = { ok: true, value: fn() }; }
  catch (error) { result = { ok: false, message: error.message }; }
  assert.equal(native(input), JSON.stringify(result), JSON.stringify(input));
}

test('ACP argv parsing matches the existing bridge, including missing values and repeated options', () => {
  const cases = [
    [], ['--agent-bin', 'agy'], ['--agent-bin', '', '--', 'x'],
    ['--agent-bin', 'agy', '--resident'],
    ['--agent-bin', 'opencode', '--agent-arg', 'acp', '--label', '中文', '--', 'hello', 'world'],
    ['--agent-bin', 'x', '--model', 'old', '--model', 'new', '--mode', 'build', '--effort', 'high', '--session-id', 's', '--', 'x'],
    ['--agent-bin', 'x', '--router-mcp', 'node', 'router.js', '--native-usage', 'opencode', '--', ''],
    ['--agent-bin', 'x', '--router-mcp'],
    ['--agent-bin', 'x', '--resident', '--agent-arg'],
    ['--unknown', 'unused', '--agent-bin', 'x', '--resident', '--label'],
  ];
  for (const args of cases) compare({ operation: 'parseArgs', args }, () => legacy.parseArgs(args));
});

test('ACP router environment matches the bridge and does not include unrelated values', () => {
  const routers = [null, {}, {command:'node'}, {command:'node',script:'router.js'}];
  const environments = [{}, { MULTICC_SESSION_ID:'one', MULTICC_BASE_URL:'http://localhost', MULTICC_TURN_ID:'turn',
    MULTICC_ORIGIN_DISPATCH_ID:'d', MULTICC_ROUTER_CAPABILITY:'token', MULTICC_IMAGE_BRIDGE:'yes', EXTRA:'secret' },
  { MULTICC_SESSION_ID:0, MULTICC_BASE_URL:false, MULTICC_TURN_ID:42, MULTICC_ORIGIN_DISPATCH_ID:['x',2] }];
  for (const router of routers) for (const env of environments)
    compare({ operation:'routerMcpServers', router, env }, () => legacy.routerMcpServers(router, env));
});

test('ACP permission selection preserves precedence and the original option', () => {
  const cases = [null, {}, [], [null], [{kind:'reject_once',optionId:'no'}],
    [{kind:'allow_once',optionId:'one'}, {kind:'allow_always',optionId:'always',extra:1}],
    [{kind:'allow_read',optionId:'custom'}, {kind:'allow_once',optionId:'once'}],
    [false, {kind:'deny'}], [{kind:17}, {kind:['allow', 'once']}]];
  for (const options of cases)
    compare({ operation:'pickPermissionOption', options }, () => legacy.pickPermissionOption(options));
});

test('ACP usage conversion matches Number coercion and JSON serialization', () => {
  const cases = [null, false, 'text', {}, [], {inputTokens:'42',outputTokens:'invalid',cachedReadTokens:true},
    {inputTokens:0,outputTokens:-1,cachedWriteTokens:'0x10',thoughtTokens:0},
    {inputTokens:[1],outputTokens:[],cachedReadTokens:{},thoughtTokens:null},
    {thoughtTokens:'3',cachedReadTokens:2.5}];
  for (const usage of cases)
    compare({ operation:'normalizeUsage', usage }, () => legacy.normalizeUsage(usage));
});

test('ACP JSON-RPC wire envelopes match Node object spread and key ordering', () => {
  const messages = [
    {id:1,method:'initialize',params:{protocolVersion:1}},
    {method:'session/cancel',params:{sessionId:'会话'}},
    {id:'c',result:{outcome:{outcome:'selected',optionId:'yes'}}},
    {id:3,error:{code:-32601,message:'not found'}},
    {jsonrpc:'override',id:0,params:null},
  ];
  for (const message of messages)
    compare({ operation:'rpcFrame', message }, () => ({ jsonrpc:'2.0', ...message }));
});
