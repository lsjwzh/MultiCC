'use strict';
// A fake `codex app-server` for bridge / resident-lane tests: answers
// initialize, thread/start, thread/resume and turn/start over JSON-RPC,
// announcing each turn it starts. It logs every request it receives, which is
// how a test distinguishes a reused thread from a re-opened one.
//
// Env knobs read at runtime:
//   FAKE_CODEX_LOG      request log path (required)
//   FAKE_CODEX_VERSION  version reported in the initialize userAgent
//   FAKE_CODEX_HOLD_MS  hold `turn/completed` back this long (mid-turn cancel)

const fs = require('node:fs');
const path = require('node:path');

const SCRIPT = `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
const log=process.env.FAKE_CODEX_LOG;
let turn=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);fs.appendFileSync(log,line+'\\n');
  const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');
  if(m.method==='initialize')out({id:m.id,result:{userAgent:'fake/'+(process.env.FAKE_CODEX_VERSION||'0.154.0')+' (test)',codexHome:'/tmp/codex',platformFamily:'unix',platformOs:'linux'}});
  if(m.method==='thread/start'){out({id:m.id,result:{thread:{id:'thread-resident'}}});out({method:'thread/started',params:{thread:{id:'thread-resident'}}});}
  if(m.method==='thread/resume')out({id:m.id,result:{thread:{id:m.params.threadId}}});
  if(m.method==='turn/start'){turn+=1;const id='turn-'+turn;out({id:m.id,result:{turn:{id}}});
    const finish=()=>{out({method:'item/agentMessage/delta',params:{itemId:'a'+turn,delta:'OK'+turn}});
      out({method:'turn/completed',params:{turn:{id,status:'completed'}}});};
    const hold=Number(process.env.FAKE_CODEX_HOLD_MS||0);
    if(hold)setTimeout(finish,hold);else finish();}
});
setInterval(()=>{},1000);
`;

function writeFakeAppServer(root) {
  const bin = path.join(root, 'codex');
  fs.writeFileSync(bin, SCRIPT, { mode: 0o755 });
  return bin;
}

module.exports = { writeFakeAppServer };
