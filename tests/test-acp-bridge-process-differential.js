'use strict';

// Compare both bridges against the same scripted ACP agent. Request traces and
// emitted JSONL are compared as bytes; cwd and synthetic capability are shared.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const frozen = path.join(__dirname, 'helpers/legacy-acp-bridge.cjs');
const virtualPath = path.join(root, 'src/cli-adapters/acp-bridge.cjs');
const gateway = process.env.MULTICC_TEST_ACP_GATEWAY || require('../src/native/binding').gatewayPath();
const wrapper = `const fs=require('node:fs'),Module=require('node:module'),path=require('node:path');
const virtual=process.env.ACP_TEST_VIRTUAL, m=new Module(virtual,module);m.filename=virtual;m.paths=Module._nodeModulePaths(path.dirname(virtual));
process.argv=[process.execPath,virtual,...process.argv.slice(1)];m._compile(fs.readFileSync(process.env.ACP_TEST_ORACLE,'utf8')+'\\nmain();',virtual);`;
const agent = `
const readline=require('node:readline'), fs=require('node:fs');
const mode=process.argv[2], log=process.env.ACP_TEST_LOG;
const record=x=>fs.appendFileSync(log,JSON.stringify(x)+'\\n');
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+(mode==='carriage-return'?'\\r':'\\n'));
record({start:{args:process.argv.slice(2),cwd:process.cwd(),session:process.env.MULTICC_SESSION_ID,capability:process.env.MULTICC_ROUTER_CAPABILITY}});
let pending=null;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);record(m);
 if(m.id!=null&&!m.method){if(pending){const p=pending;pending=null;p(m)}return;}
 const reply=result=>send({id:m.id,result});
 if(m.method==='initialize')return reply({agentCapabilities:mode==='resume'?{sessionCapabilities:{resume:true}}:(mode==='no-resume'?{}:{loadSession:true}),agentInfo:{name:'fake'},authMethods:[{id:'login',description:'run login'}]});
 if(m.method==='session/load'||m.method==='session/resume'){
  if(mode==='fallback')return send({id:m.id,error:{code:-32001,message:'lost'}});
  if(m.method==='session/load')send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'replay'}}}});
  return reply({configOptions:[{id:'model',category:'model',currentValue:'base',options:[{value:'base'},{value:'fast'}]}]});
 }
 if(m.method==='session/new'){
  if(mode==='auth')return send({id:m.id,error:{code:-32000,message:'Authentication required'}});
  if(mode==='legacy-config')return reply({sessionId:'sess-new',models:{currentModelId:'base',availableModels:[{modelId:'base'},{modelId:'fast'}]},modes:{availableModes:[{id:'plan'}]}});
  if(mode==='config-all'||mode==='config-fail')return reply({sessionId:'sess-new',configOptions:[
   {id:'model',category:'model',currentValue:'base',options:[{options:[{value:'base'},{value:'fast'}]}]},
   {id:'mode',category:'mode',currentValue:'build',options:[{value:'build'},{value:'plan'}]},
   {id:'reasoning',category:'thought_level',currentValue:'low',options:[{value:'low'},{value:'high'}]}]});
  return reply({sessionId:'sess-new',configOptions:[{id:'model',category:'model',currentValue:'base',options:[{value:'base'},{value:'fast'}]}]});
 }
 if(m.method==='session/set_model'||m.method==='session/set_mode')return reply({});
 if(m.method==='session/set_config_option'){
  if(mode==='config-fail'&&m.params.configId==='mode')return send({id:m.id,error:{code:400,message:'mode denied'}});
  if(mode==='config-all'||mode==='config-fail')return reply({});
  return reply({configOptions:[]});
 }
 if(m.method==='session/cancel'){if(pending){const p=pending;pending=null;p(null)}return;}
 if(m.method==='session/prompt'){
  const sid=m.params.sessionId;
  if(mode==='cancel'){pending=()=>reply({stopReason:'cancelled'});return;}
  if(mode==='ignore-cancel'){pending=()=>{};return;}
  if(mode==='exit-early')return process.exit(17);
  if(mode==='invalid-utf8')process.stdout.write(Buffer.concat([Buffer.from('{"method":"session/update","params":{"sessionId":"'+sid+'","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"'),Buffer.from([255]),Buffer.from('"}}}}\\n')]));
  if(mode==='no-permission'){
   pending=()=>reply({stopReason:'end_turn'});
   return send({id:'permission-1',method:'session/request_permission',params:{options:[]}});
  }
  if(mode==='unknown-request'){
   pending=()=>reply({stopReason:'end_turn'});
   return send({id:'permission-1',method:'fs/read_text_file',params:{}});
  }
  if(mode==='native-usage'||mode==='native-usage-rpc'){
   const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.env.ACP_TEST_DB);
   const insert=db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
   for(const [id,time,input] of [['new1',2,100],['new2',3,200]]) insert.run(id,sid,time,JSON.stringify({role:'assistant',tokens:{input,output:10,cache:{read:5,write:0}}}));
   db.close(); return reply({stopReason:'end_turn',...(mode==='native-usage-rpc'?{usage:{inputTokens:7,outputTokens:3}}:{})});
  }
  if(mode==='rpc-error')return send({id:m.id,error:{code:-32603,message:'Internal error',data:{errorName:'ContextOverflowError',statusCode:400,authorization:'secret'}}});
  send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'usage_update',used:10,size:100}}});
  send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'你好'}}}});
  pending=answer=>reply({stopReason:'end_turn',usage:{inputTokens:4,outputTokens:2,cachedReadTokens:1},answer:answer?.result});
  return send({id:'permission-1',method:'session/request_permission',params:{toolCall:{title:'read',kind:'read'},options:[{kind:'deny',optionId:'no'},{kind:'allow_once',optionId:'yes'}]}});
 }
});`;

async function run(kind, mode, args = [], action = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-acp-diff-'));
  const agentPath = path.join(dir, 'agent.cjs'); const log = path.join(dir, 'agent.log');
  fs.writeFileSync(agentPath, agent);
  let dbPath;
  if (mode.startsWith('native-usage')) {
    dbPath=path.join(dir,'opencode','opencode.db'); fs.mkdirSync(path.dirname(dbPath),{recursive:true});
    const db=new (require('better-sqlite3'))(dbPath);
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)');
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('old','sess-old',1,JSON.stringify({role:'assistant',tokens:{input:9999,output:999}})); db.close();
  }
  const env = { ...process.env, ACP_TEST_LOG:log, ACP_TEST_ORACLE:frozen, ACP_TEST_VIRTUAL:virtualPath,
    MULTICC_SESSION_ID:'session-test', MULTICC_ROUTER_CAPABILITY:'cap-test',
    ...(dbPath ? { XDG_DATA_HOME:dir, ACP_TEST_DB:dbPath } : {}) };
  const common = ['--agent-bin', process.execPath, '--agent-arg', agentPath, '--agent-arg', mode,
    '--agent-arg', '文字', '--label', 'Fake', '--router-mcp', '/router/node', '/router/server', ...args];
  const cmd = kind === 'legacy' ? process.execPath : gateway;
  const argv = kind === 'legacy' ? ['-e',wrapper,'--',...common] : ['acp-bridge',...common];
  return await new Promise((resolve, reject) => {
    const startedAt=Date.now();
    const child = spawn(cmd,argv,{cwd:dir,env,stdio:['pipe','pipe','pipe']});
    let stdout='', stderr='', cancelled=false, signalledAgain=false, started=false, completed=0;
    const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`timeout ${kind} ${mode}: ${stdout} ${stderr}`));},8000);
    const poll = action === 'signal' || action === 'signal-twice' || action === 'resident-cancel' || action === 'resident-eof' ? setInterval(()=>{
      if (!cancelled && fs.existsSync(log) && fs.readFileSync(log,'utf8').includes('session/prompt')) {cancelled=true; if(action==='signal'||action==='signal-twice')child.kill('SIGTERM'); else if(action==='resident-eof')child.stdin.end(); else child.stdin.write(JSON.stringify({type:'cancel'})+'\n');}
      if (action==='signal-twice' && cancelled && !signalledAgain && fs.existsSync(log) && fs.readFileSync(log,'utf8').includes('session/cancel')) { signalledAgain=true; child.kill('SIGTERM'); }
    },10) : null;
    child.stdout.on('data',chunk=>{
      stdout+=chunk;
      if(action?.startsWith('resident') && !started && stdout.includes('multicc/session')) {
        started=true; child.stdin.write(JSON.stringify({text:'first'})+'\n');
        if(action==='resident-two') child.stdin.write(JSON.stringify({text:'second',model:'fast'})+'\n');
      }
      if(action === 'resident-error' && stdout.includes('multicc/error')) child.stdin.end();
      if(action?.startsWith('resident')) {
        const seen=(stdout.match(/multicc\/turnEnd/g)||[]).length;
        if(seen>completed) {completed=seen; if(completed===(action==='resident-two'?2:1))child.stdin.end();}
      }
    }); child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',reject);
    child.on('close',(code,signal)=>{
      clearTimeout(timeout);if(poll)clearInterval(poll);
      const trace=fs.existsSync(log)?fs.readFileSync(log,'utf8'):'';
      // Agent script path and cwd differ between the independent runs.
      const normalize=s=>s.split(dir).join('<DIR>');
      fs.rmSync(dir,{recursive:true,force:true});
      resolve({code,signal,stdout:normalize(stdout),trace:normalize(trace),stderr:normalize(stderr),elapsedMs:Date.now()-startedAt});
    });
  });
}
async function compare(mode,args,action) {
  const old=await run('legacy',mode,args,action), actual=await run('native',mode,args,action);
  assert.equal(actual.code,old.code,`exit ${mode}: ${actual.stderr}`);
  assert.equal(actual.stdout,old.stdout,`output ${mode}`);
  assert.equal(actual.trace,old.trace,`agent wire ${mode}`);
  if (action==='signal-twice') assert.ok(actual.elapsedMs<1200, `second signal did not stop promptly: ${actual.elapsedMs}ms`);
}

test('one shot: spawn argv/env, model negotiation, permissions and usage',()=>compare('ok',['--model','fast','--','hello']));
test('session/load suppresses replay',()=>compare('load',['--session-id','sess-old','--','continue']));
test('session/resume is preferred',()=>compare('resume',['--session-id','sess-old','--','continue']));
test('failed restore emits notice before creating a new session',()=>compare('fallback',['--session-id','sess-old','--','continue']));
test('unknown model fails before prompting',()=>compare('ok',['--model','unknown','--','hello']));
test('authentication errors preserve hints',()=>compare('auth',['--','hello']));
test('structured RPC errors are bounded and forwarded',()=>compare('rpc-error',['--','hello']));
test('SIGTERM cancels the active turn',()=>compare('cancel',['--','hello'],'signal'));

test('OpenCode native usage excludes earlier turns',()=>compare('native-usage',['--native-usage','opencode','--session-id','sess-old','--','hi']));
test('OpenCode reported usage retains native context',()=>compare('native-usage-rpc',['--native-usage','opencode','--session-id','sess-old','--','hi']));
test('resident mode queues turns and switches models',()=>compare('ok',['--resident'],'resident-two'));
test('resident cancellation settles an active prompt',()=>compare('cancel',['--resident'],'resident-cancel'));

test('empty permission options return a cancelled outcome',()=>compare('no-permission',['--','hello']));
test('unsupported client requests receive a method-not-found response',()=>compare('unknown-request',['--','hello']));
test('agent early exit rejects its active prompt',()=>compare('exit-early',['--','hello']));
test('invalid UTF-8 is replaced before parsing agent output',()=>compare('invalid-utf8',['--','hello']));
test('missing agent reports the failure without retrying the prompt',()=>compare('ok',['--agent-bin','/nonexistent/multicc-acp-agent','--','hello']));
test('rejected models emit the legacy ACP and JSON events without a Node child', () => {
  const { execFileSync } = require('node:child_process');
  for (const lane of ['acp','legacy']) for (const suggestion of ['', 'provider/new']) {
    const message = `模型 provider/old 已不在可用列表中（可能已下架或改名）。${suggestion ? `建议改用 ${suggestion}。` : ''}`;
    const expected = lane === 'legacy'
      ? { type:'error', error:{ data:{ message, code:'invalid_request_model', category:'invalid_request_model', statusCode:404 } } }
      : { method:'multicc/error', params:{ message, code:'invalid_request_model', category:'invalid_request_model' } };
    assert.equal(execFileSync(gateway,['acp-model-error',lane,'provider/old',suggestion],{encoding:'utf8'}), `${JSON.stringify(expected)}\n`);
  }
});

test('resident prompt errors retain a failing bridge exit status',()=>compare('rpc-error',['--resident'],'resident-error'));

test('resident stdin closes while a prompt is active',()=>compare('cancel',['--resident'],'resident-eof'));

test('legacy model and mode negotiation use their dedicated RPC methods',()=>compare('legacy-config',['--model','fast','--mode','plan','--effort','high','--','hello']));
test('grouped model, mode and reasoning options retain their order',()=>compare('config-all',['--model','fast','--mode','plan','--effort','high','--','hello']));
test('optional mode errors are notices and do not prevent the prompt',()=>compare('config-fail',['--mode','plan','--effort','high','--','hello']));
test('an agent without restore support starts a new session with a notice',()=>compare('no-resume',['--session-id','sess-old','--','hello']));

test('carriage-return-only protocol lines are accepted',()=>compare('carriage-return',['--','hello']));

test('a second termination signal interrupts the cancellation grace period',()=>compare('ignore-cancel',['--','hello'],'signal-twice'));
