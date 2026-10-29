'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {execFile,spawnSync}=require('node:child_process');
const net=require('node:net');
const binary=process.env.PLUGIN_TEST_BIN||path.resolve(__dirname,'../target/release/chrome-proxy-launcher');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
const close=s=>new Promise(r=>{s.closeAllConnections();s.close(r)});
test('生产启动入口自动加载、重开指纹和会话 Cookie 保持、断代理不直连', {skip:!process.env.CHROME_TEST_BIN,timeout:90000},async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'multicc-auto-'));
 const run=(cmd,input)=>new Promise((resolve,reject)=>{const c=execFile(binary,[cmd],{env:{...process.env,HOME:home,MULTICC_CDP_GATEWAY:'0'},timeout:45000},(e,out)=>{try{resolve(JSON.parse(out))}catch(_){reject(e||new Error(out))}});c.stdin.end(JSON.stringify(input));});
 let id; t.after(async()=>{if(id)await run('stop',{id});fs.rmSync(home,{recursive:true,force:true});});
 const chromeWrapper=path.join(home,'chrome');
 fs.writeFileSync(chromeWrapper, '#!/bin/sh\nexec '+"'"+process.env.CHROME_TEST_BIN.replaceAll("'", "'\\''")+"'"+' --headless=new --use-mock-keychain --disable-background-networking "$@"\n',{mode:0o700});
 const samples=[];let hits=0;
 const target=http.createServer((req,res)=>{
  hits++;
  if(req.url.startsWith('/sample')){samples.push(JSON.parse(decodeURIComponent(req.url.split('?')[1])));res.end('ok');return;}
  res.setHeader('Content-Type','text/html');
  res.end(`<script>const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d');x.fillStyle='rgb(80,120,160)';x.fillRect(0,0,64,64);const b=x.getImageData(0,0,64,64).data;let h=2166136261;for(const v of b)h=Math.imul(h^v,16777619);const old=document.cookie;document.cookie='session_test=yes;path=/';fetch('/sample?'+encodeURIComponent(JSON.stringify({hash:h>>>0,cookie:old})));setTimeout(()=>location.reload(),2000);</script>`);
 });await listen(target);t.after(()=>close(target));
 const origin=`http://127.0.0.1:${target.address().port}`;
 const proxy=http.createServer((req,res)=>{if(!req.url.startsWith(origin+'/')){res.writeHead(502);res.end();return;}http.get(req.url,{headers:{cookie:req.headers.cookie||''}},up=>{res.writeHead(up.statusCode,up.headers);up.pipe(res)}).on('error',()=>res.end());});
 proxy.on('connect',(_,s)=>{s.on('error',()=>{});s.end('HTTP/1.1 502 Bad Gateway\r\n\r\n',()=>s.destroy());});await listen(proxy);t.after(()=>close(proxy));
 const saved=await run('save',{name:'automatic',chromePath:chromeWrapper,proxy:{scheme:'http',host:'127.0.0.1',port:proxy.address().port}});assert.equal(saved.ok,true);id=saved.data.profile.id;
 async function sample(){for(let i=0;i<150;i++){if(samples.length)return samples.shift();await delay(50)}throw new Error('网页没有回传首段脚本样本，hits='+hits);}
 const first=await run('launch',{id,url:origin+'/',checkProxy:false});assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.data.fingerprint.installationVerified,true);
 const command=spawnSync('ps',['-p',String(first.data.pid),'-o','command='],{encoding:'utf8'}).stdout;
 assert.match(command,/--remote-debugging-pipe/);assert.doesNotMatch(command,/--remote-debugging-port/);
 assert.equal(fs.existsSync(path.join(first.data.userDataDir,'DevToolsActivePort')),false);
 process.kill(first.data.supervisorPid,0); // 一次性 launch 请求已退出，监督进程仍存活。
 const a=await sample();let raw=2166136261;for(let i=0;i<4096;i++)for(const b of [80,120,160,255])raw=Math.imul(raw^b,16777619);assert.notEqual(a.hash,raw>>>0,'首段脚本必须已受保护');
 const stopped=await run('stop',{id});assert.equal(stopped.ok,true,JSON.stringify(stopped));samples.length=0;
 for(let i=0;i<30;i++){try{process.kill(first.data.supervisorPid,0);await delay(50)}catch(_){break}}
 assert.throws(()=>process.kill(first.data.supervisorPid,0),{code:'ESRCH'});
 const second=await run('launch',{id,url:origin+'/',checkProxy:false});assert.equal(second.ok,true,JSON.stringify(second));
 const b=await sample();assert.equal(a.hash,b.hash);assert.match(b.cookie,/session_test=yes/,'会话 Cookie 必须跨重开保留');
 await close(proxy);await delay(500);const before=hits;await delay(2500);assert.equal(hits,before,'断开代理后不得直连测试站');
});


test('不支持自动加载或配置损坏时明确失败，不伪报加载成功', t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'multicc-auto-fail-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const run=(command,input)=>{
  const r=spawnSync(binary,[command],{env:{...process.env,HOME:home,MULTICC_CDP_GATEWAY:'0'},input:JSON.stringify(input),encoding:'utf8',timeout:5000});
  assert.ifError(r.error);return JSON.parse(r.stdout);
 };
 const saved=run('save',{name:'unsupported',chromePath:'/usr/bin/true',proxy:{scheme:'http',host:'127.0.0.1',port:1}});
 const id=saved.data.profile.id;
 const rejected=run('launch',{id,checkProxy:false});assert.equal(rejected.ok,false);assert.match(rejected.error,/浏览器|管道/);
 const root=path.join(home,'.multicc/plugins-data/chrome-proxy-launcher');
 assert.equal(fs.existsSync(path.join(root,'run',id+'.pid')),false);
 const identity=path.join(root,'fingerprints',id,'identity.json');fs.writeFileSync(identity,'damaged');
 const damaged=run('launch',{id,checkProxy:false});assert.equal(damaged.ok,false);assert.match(damaged.error,/配置损坏/);
 assert.equal(fs.readFileSync(identity,'utf8'),'damaged');
 const injected=run('launch',{id,checkProxy:false,url:'--remote-debugging-port=9222'});
 assert.equal(injected.ok,false);assert.match(injected.error,/不能是启动参数/);
});

// Exercise the actual launch command and supervisor, with blank test profiles
// and a headless browser. No desktop focus, personal Chrome or real proxy is used.
test('isolated launches register with Agent and allow full background CDP, with or without fingerprinting',
 {skip:!process.env.CHROME_TEST_BIN||!process.env.MULTICC_CDP_BIN,timeout:60000},async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'multicc-control-'));
 const gatewayDir=path.join(home,'gateway');fs.mkdirSync(gatewayDir);
 const env={...process.env,HOME:home,MULTICC_CDP_GATEWAY:'1',MULTICC_CDP_DIR:gatewayDir,MULTICC_CDP_SOCK:path.join(gatewayDir,'cdp.sock'),MULTICC_CDP_IDLE_EXIT_SECS:'30'};
 const gatewayRequest=body=>new Promise((resolve,reject)=>{
  const s=net.createConnection(env.MULTICC_CDP_SOCK);let buffer='';
  s.setTimeout(3000,()=>s.destroy(new Error('gateway timeout')));
  s.on('connect',()=>s.write(JSON.stringify(body)+'\n'));s.on('error',reject);
  s.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n')){resolve(JSON.parse(buffer.split('\n')[0]));s.destroy();}});
 });
 const run=(cmd,input)=>new Promise((resolve,reject)=>{const c=execFile(binary,[cmd],{env,timeout:20000},(error,out)=>{
  if(error)return reject(error);try{resolve(JSON.parse(out));}catch(e){reject(e);}});c.stdin.end(JSON.stringify(input));});
 const wrapper=path.join(home,'chrome');
 fs.writeFileSync(wrapper,'#!/bin/sh\nexec '+"'"+process.env.CHROME_TEST_BIN.replaceAll("'","'\\''")+"'"+' --headless=new --use-mock-keychain --disable-background-networking "$@"\n',{mode:0o700});
 const mbrowser=path.resolve(__dirname,'../../../skills/multicc-browser/bin/mbrowser');
 const api=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',async()=>{
  let result;
  if(req.method==='GET'&&req.url==='/api/plugins')result={plugins:[{id:'chrome-proxy-launcher',name:'Isolation',commands:['list','launch','stop','browser-read']}]};
  else{const request=JSON.parse(body);const reply=await run(request.command,request.input);result=reply.ok?reply.data:{error:reply.error};}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
 });});await listen(api);
 const mbEnv={...env,MULTICC_BASE_URL:`http://127.0.0.1:${api.address().port}`,MULTICC_DATA_DIR:path.join(home,'state'),MBROWSER_PROFILES_DIR:path.join(home,'mb-profiles'),MBROWSER_ISO_DATA_ROOT:path.join(home,'.multicc/plugins-data'),MULTICC_SESSION_ID:'control-fixture'};
 const mb=args=>new Promise((resolve,reject)=>execFile(process.execPath,[mbrowser,...args],{env:mbEnv,timeout:15000},(error,out,err)=>error?reject(new Error(err||error.message)):resolve(out)));
 const profiles=[];const clients=[];
 t.after(async()=>{
  for(const id of profiles)await mb(['stop','iso:'+id]).catch(()=>{});
  await close(api);
  for(const c of clients)c.destroy();
  for(const id of profiles)await run('stop',{id});
  await gatewayRequest({op:'shutdown',force:true}).catch(()=>{});
  for(let i=0;i<30;i++){try{await gatewayRequest({op:'ping'});await delay(50);}catch(_){break;}}
  fs.rmSync(home,{recursive:true,force:true});
 });
 for(const automaticFingerprint of [true,false]){
  const saved=await run('save',{name:`control-${automaticFingerprint}`,chromePath:wrapper,proxy:{scheme:'http',host:'127.0.0.1',port:1}});
  assert.equal(saved.ok,true,JSON.stringify(saved));const id=saved.data.profile.id;profiles.push(id);
  const launched=await run('launch',{id,checkProxy:false,automaticFingerprint,url:'about:blank'});
  assert.equal(launched.ok,true,JSON.stringify(launched));
  assert.equal(launched.data.browserControl.protocol,'multicc-browser-control-v1');
  assert.match(launched.data.browserControl.wsUrl,/^pipe:\/\/\//);
  assert.equal(fs.existsSync(path.join(launched.data.userDataDir,'DevToolsActivePort')),false);
 }
 let status;
 for(let i=0;i<150;i++){
  status=await gatewayRequest({op:'status'}).catch(()=>null);
  if(status?.upstreams?.filter(s=>s.state==='ready').length===2)break;
  await delay(100);
 }
 assert.equal(status?.upstreams?.filter(s=>s.state==='ready').length,2,'both browsers register before a caller requests control');
 for(const id of profiles){
  const listing=await run('list',{});const profile=listing.data.profiles.find(p=>p.id===id);
  assert.equal(profile.browserControl.protocol,'multicc-browser-control-v1');
  const socket=net.createConnection(env.MULTICC_CDP_SOCK);clients.push(socket);
  let buffer='';let nextId=0;const waiting=new Map();let ready;
  const readyPromise=new Promise(resolve=>{ready=resolve;});
  socket.on('error',()=>{});
  socket.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){
   const at=buffer.indexOf('\n');const frame=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
   if(frame.phase==='ready')ready();if(frame.id&&waiting.has(frame.id)){waiting.get(frame.id)(frame);waiting.delete(frame.id);}
  }});
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  socket.write(JSON.stringify({op:'cdp',wsUrl:profile.browserControl.wsUrl})+'\n');
  await Promise.race([readyPromise,delay(5000).then(()=>{throw new Error('CDP lane not ready');})]);
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
   const requestId=++nextId;const timer=setTimeout(()=>{waiting.delete(requestId);reject(new Error(method+' timeout'));},5000);
   waiting.set(requestId,frame=>{clearTimeout(timer);assert.equal(frame.error,undefined,JSON.stringify(frame));resolve(frame.result);});
   socket.write(JSON.stringify({id:requestId,method,params,...(sessionId?{sessionId}:{})})+'\n');
  });
  const target=await call('Target.createTarget',{url:'about:blank',background:true});
  const attached=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
  const session=attached.sessionId;
  await call('Runtime.evaluate',{expression:`document.body.innerHTML='<input id="input"><button id="button" onclick="this.textContent=String(Number(this.textContent)+1)">0</button>'`},session);
  await call('Runtime.evaluate',{expression:'document.querySelector("input").focus()'},session);
  await call('Input.insertText',{text:id},session);
  await call('Emulation.setFocusEmulationEnabled',{enabled:true},session);
  const point=await call('Runtime.evaluate',{expression:'(()=>{const r=document.querySelector("button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',returnByValue:true},session);
  await call('Input.dispatchMouseEvent',{type:'mousePressed',...point.result.value,button:'left',clickCount:1},session);
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',...point.result.value,button:'left',clickCount:1},session);
  const clicked=await call('Runtime.evaluate',{expression:'document.querySelector("button").textContent',returnByValue:true},session);
  assert.equal(clicked.result.value,'1','background mouse events trigger the button');
  const value=await call('Runtime.evaluate',{expression:'document.querySelector("input").value',returnByValue:true},session);
  assert.equal(value.result.value,id,'input is delivered in the chosen identity');
  const screenshot=await call('Page.captureScreenshot',{},session);assert.ok(screenshot.data.length>100);
  const [,read]=await Promise.all([call('Runtime.evaluate',{expression:'21*2',returnByValue:true},session),run('browser-read',{protocol:'multicc-browser-read-v1',requestId:require('node:crypto').randomUUID(),profileId:id,sourceRevision:{profileCreatedAt:profile.createdAt,profileUpdatedAt:profile.updatedAt,subscription:null,confidence:'public_metadata'},action:'status',origins:['https://example.com']})]);
  assert.equal(read.ok,true,JSON.stringify(read));
  await call('Target.closeTarget',{targetId:target.targetId});
 }
 for(const id of profiles){
  assert.match(await mb(['open','about:blank','-p','iso:'+id]),/open/);
  const evaluated=JSON.parse(await mb(['eval','21*2','-p','iso:'+id,'--json']));
  assert.match(JSON.stringify(evaluated),/42/,'mbrowser uses the Agent channel for general page commands');
  await mb(['close','-p','iso:'+id]);
 }
 await gatewayRequest({op:'shutdown',force:true});
 for(let i=0;i<30;i++){try{await gatewayRequest({op:'ping'});await delay(50);}catch(_){break;}}
 await new Promise((resolve,reject)=>execFile(env.MULTICC_CDP_BIN,['endpoint','--ws','ws://127.0.0.1:1/unused'],{env,timeout:10000},error=>error?reject(error):resolve()));
 let reconnected;
 for(let i=0;i<150;i++){
  reconnected=await gatewayRequest({op:'status'});
  if(reconnected.upstreams?.filter(s=>s.state==='ready').length===2)break;
  await delay(100);
 }
 assert.equal(reconnected.upstreams.filter(s=>s.state==='ready').length,2,'supervisors re-register after a gateway restart');
 for(const id of profiles){
  await mb(['open','about:blank','-p','iso:'+id]);
  assert.match(await mb(['eval','42','-p','iso:'+id]),/42/,'the existing mbrowser daemon reattaches without relaunching Chrome');
  await mb(['close','-p','iso:'+id]);
 }
 assert.equal((await gatewayRequest({op:'status'})).upstreams.length,2,'commands reuse registered browser connections');
});
