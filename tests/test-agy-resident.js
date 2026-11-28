'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { once } = require('node:events');
const binding = require('../src/native/binding');
const chatStream = require('../src/chat/chat-stream');
const bin = path.join(__dirname, 'helpers', 'fake-agy-stream.cjs');
const unix = { skip: process.platform === 'win32', timeout: 30000 };

async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await sleep(20);
  }
  assert.fail('等待模拟进程状态变化超时');
}

function setup(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-resident-'));
  const log = path.join(root, 'log');
  fs.writeFileSync(log, '');
  const env = { PATH: process.env.PATH, HOME: root, AGY_TEST_LOG: log, ...extra };
  const rows = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const sessionName = path.basename(root);
  const native = binding.getNative();
  const provider = binding.cliAdapters.createAgyAdapter({ cmd: bin });
  const cs = { cli: 'agy', cwd: root, chatTurnCount: 0 };
  const persisted = { cli: 'agy', dirId: 'd' };
  let ended, notices = [], effects = false;
  const events = [];
  const ports = {
    env, crypto: require('node:crypto'), getPort: () => 30, getClaudeOfficialViaProxy: () => false,
    providerRouterRuntime: { buildChildEnv: (base, _, markers) => ({env: {...base, ...markers}}) },
    providers: { prepareResidentChildEnv() {}, settingsOverrideFor() {} }, secretsVault: { applyEnvOverlay() {} },
    claudeSettingsExtra() {}, rememberActiveCliState() {}, savePersistedSessionsBestEffort() {},
    spawnContractOf: () => '配置', gatewayPath: binding.gatewayPath, getWorkspaceAdmission: () => null,
    routerToolHost: { prepareResidentMcp() {}, refreshPersistentProcess(_, e) { e.MULTICC_ROUTER_CAPABILITY = '模拟'; }, releasePersistentProcess() {} },
    createAdapterCompletion: () => ({}), createRunnerOwnership: (_, spec) => spec,
    isCurrentTurnRunner: (chat, turn, runner) => chat._activeTurn === turn && chat._activeRunner === runner,
    attemptRuntime: { acceptEvent: () => true, snapshot: () => ({ sideEffectObserved: effects }) },
    applyAdapterChatEvent(_, __, record, ___, event) {
      for (const item of provider.decodeEvent(event)) {
        events.push(item);
        if (item.type === 'session_started') record.cliSessionId = item.sessionId;
        if (item.type === 'session_init') record.reportedModel = item.model;
      }
    },
    turnTiming: { markFirstByte() {}, markSent() {}, markSpawned() {}, abort() {} },
    managedContext: { contextSent() {} }, getBackgroundTaskRuntime: () => ({ reapSessionShadows: () => 0 }),
    chatBroadcast: (_, notice) => notices.push(notice), logger: { warn() {}, error() {} },
    meaningfulTurnOutput: () => false, turnHasSideEffects: () => effects, sanitizeApiErrorMessage: s => s,
    chatStream, finalizeCompletionStream(pending, hook) {
      pending.catch(hook.onRejected).then(hook.finalize).catch(err => ended.reject(err));
    },
    finalizeStreamingTurn() { ended.resolve(); },
    runChatTurnStreaming(sessionName, cs, persisted, prepared, provider, turn, prepareInvocation, autoTurn, apiRetryAttempt) {
      return native.chatRunStreaming(ports, { sessionName, cs, persisted, prepared, provider, turn, prepareInvocation, autoTurn, apiRetryAttempt });
    },
  };
  t.after(async () => { await chatStream.closeAndWait(sessionName); fs.rmSync(root, { force:true, recursive:true }); });
  const send = (userText, options = {}) => {
    effects = !!options.effects;
    const input = { contextLayers: [], userText, suffix: '', rolePrompt: '首轮角色',
      historyHandle: { isFirstTurn: !persisted.cliSessionId, cliSessionId: persisted.cliSessionId },
      spawnOpts: { agyAccountKey: options.account || sessionName, rawModel: options.model, effectiveModel: options.model || persisted.reportedModel, rawEffort: options.effort } };
    const prepared = { invocation: provider.buildInvocation(input), invocationEnvelope: input, binding: {}, attempt: {} };
    cs.chatTurnCount++;
    return new Promise((resolve, reject) => {
      ended = { resolve, reject };
      ports.runChatTurnStreaming(sessionName, cs, persisted, prepared, provider, { turnId: String(cs.chatTurnCount) });
    });
  };
  return { cs, env, rows, events, notices, send, root, sessionName, pids: () => rows().filter(r => r.argv).map(r => r.pid) };
}

test('应用入口连续多轮复用，按轮用量、角色和启动配置各自隔离', unix, async t => {
  const h = setup(t);
  await h.send('第一轮');
  await h.send('第二轮');
  await h.send('第三轮');
  assert.equal(h.pids().length, 1);
  assert.deepEqual(h.events.filter(e => e.type === 'complete').map(e => e.usage.input_tokens), [11, 11, 11]);
  assert.equal(h.rows().filter(e => e.content?.includes('[Role prompt]')).length, 1);
  await h.send('改模型', {model:'gemini-4-carbon'});
  h.env.MULTICC_TEST_KEY = '变更';
  await h.send('改环境', {model:'gemini-4-carbon'});
  const config = path.join(h.root,'.gemini/config');
  fs.mkdirSync(config,{recursive:true});
  fs.writeFileSync(path.join(config,'mcp_config.json'),'{"mcpServers":{}}');
  await h.send('改 MCP', {model:'gemini-4-carbon'});
  await h.send('改强度', {model:'gemini-4-carbon', effort:'high'});
  await h.send('改账号', {model:'gemini-4-carbon', effort:'high', account:'另一个测试账号'});
  h.cs.cwd = config;
  await h.send('改目录', {model:'gemini-4-carbon', effort:'high', account:'另一个测试账号'});
  assert.equal(new Set(h.pids()).size, 7);
  for (const r of h.rows().filter(r => r.argv).slice(1)) assert.ok(r.argv.includes('模拟会话'));
});

test('帮助探测降级和显式关闭均逐轮启动，保留恢复 ID', unix, async t => {
  for (const env of [{ AGY_TEST_OLD:'1' }, { MULTICC_AGY_RESIDENT:'0' }]) {
    const h = setup(t,env);
    await h.send('第一轮'); await h.send('第二轮');
    assert.equal(new Set(h.pids()).size, 2);
    assert.ok(h.rows().filter(r => r.argv).every(r => r.argv.includes('-p')));
    assert.ok(h.rows().findLast(r => r.argv).argv.includes('模拟会话'));
  }
  const trial = setup(t, { AGY_TEST_BAD_HELP: '1' });
  await trial.send('假阳性探测');
  assert.equal(trial.rows().filter(r => r.content).length, 1);
  assert.equal(trial.events.at(-1).type, 'complete');
});

test('常驻强度拒绝仅在无输出、无工具及无副作用时重试一次', unix, async t => {
  for (const [text, effects, count] of [['强度拒绝',false,2],['纯诊断强度拒绝',false,2],
    ['先调用工具强度拒绝',false,1], ['先输出文本强度拒绝',false,1], ['强度拒绝',true,1], ['持续拒绝强度拒绝',false,2]]) {
    const h = setup(t);
    await h.send(text,{model:'gemini-4-carbon',effort:'high',effects});
    const processes = h.rows().filter(r => r.argv);
    assert.equal(processes.length,count);
    assert.ok(processes[0].argv.includes('--effort'));
    assert.equal(h.notices.length,count-1);
    if (count===2) assert.ok(!processes[1].argv.includes('--effort'));
    assert.equal(h.events.at(-1).type, count===2 && !text.includes('持续拒绝') ? 'complete' : 'error');
  }
});

const gone = pid => { try { process.kill(pid,0);return false; } catch(e) {return e.code === 'ESRCH';} };
test('取消与进程异常退出后下一轮恢复', unix, async t => {
  const h = setup(t);
  const pending = h.send('持续工具');
  await until(() => h.rows().some(r => r.tool));
  h.cs._activeRunner.killReason='user_cancel';
  chatStream.cancel(h.sessionName);
  await pending;
  await until(() => gone(h.rows().find(r => r.tool).tool));
  await h.send('无输出崩溃'); await h.send('恢复');
  assert.equal(new Set(h.pids()).size,3);
  assert.equal(h.events.at(-1).type,'complete');
});

test('宿主遭 SIGKILL 后，进行中的 agy 和工具进程共同退出', unix, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-parent-'));
  const log=path.join(root,'log'); fs.writeFileSync(log,'');
  const host=spawn(process.execPath,['-e',`
    const p=require('node:child_process').spawn(process.argv[1],['agy-stream-bridge',process.argv[2]],{detached:true,stdio:['pipe','ignore','ignore']});
    p.stdin.write(JSON.stringify({text:'持续工具'})+'\\n');
  `,binding.gatewayPath(),bin],{env:{PATH:process.env.PATH,HOME:root,AGY_TEST_LOG:log}});
  const closed=once(host,'close');
  t.after(()=>{host.kill('SIGKILL');fs.rmSync(root,{force:true,recursive:true});});
  const rows=()=>fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  await until(()=>rows().some(r=>r.tool));
  const {pid,tool}=rows().find(r=>r.tool);
  host.kill('SIGKILL'); await closed;
  await until(()=>gone(pid) && gone(tool));
});
