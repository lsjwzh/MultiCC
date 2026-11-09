'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { serveRemote } = require('./helpers/workspace-remote-server');
const native = require('./helpers/native-workspace-sharing');
const legacy = require('./helpers/legacy-workspace-sharing');
const TOKEN = `fleet_share_${'x'.repeat(32)}`;
const GRANT = 'g'.repeat(43);
const payload = { schemaVersion: 1, instanceId: 'remote', capability: { token: TOKEN, grant: GRANT },
  fleet: { id: 'workspace', name: 'Remote', sessions: [] } };
function fixture(t, origin, factory = native.createFleetSharing, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-workspace-remote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const externalFleetsFile = path.join(dir, 'external.json');
  fs.writeFileSync(externalFleetsFile, JSON.stringify({ schemaVersion: 1, fleets: { external: {
    id: 'external', sourceOrigin: origin, sourceInstanceId: 'remote', sourceFleetId: 'workspace',
    remoteToken: TOKEN, remoteGrant: GRANT, sessions: [], remoteName: 'Remote', importedAt: 1, refreshedAt: 1,
  } } }));
  return factory({ sharesFile: path.join(dir, 'shares.json'), externalFleetsFile,
    getDirectory: () => null, listSessions: () => [], now: () => 1800000000000, ...options });
}
function response(status, body, headers = {}) {
  return { status, headers: { get: key => headers[key] ?? null },
    text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
}
async function outcome(action) {
  try { return { value: await action() }; }
  catch (error) { return { error: Object.fromEntries(['code','message','status','category','detail','retryable',
    'action','scope','causeCode','upstreamRequestId','correlationId'].map(key => [key,error[key]])) }; }
}

test('remote URL and address policy match the frozen implementation', () => {
  const urls = [null, [], {}, 0, true, '', 'bad', `\ufeffhttp://127.0.0.1/fleet-share/${TOKEN}`, `\u0085http://127.0.0.1/fleet-share/${TOKEN}`, 'file:///tmp/a', 'ftp://host/a'];
  for (const host of ['localhost:3000','127.1:80','[::1]:80','EXAMPLE.test','例子.测试','user:pass@host']) {
    for (const suffix of ['', '/', '?a=b#part', '//']) {
      urls.push(`http://${host}/fleet-share/${TOKEN}${suffix}`, `https://${host}/api/fleet-shares/${TOKEN}/import${suffix}`);
    }
  }
  const result = (fn,value) => { try { return fn(value); } catch (e) { return [e.code,e.message,e.status]; } };
  for (const url of urls) assert.deepEqual(result(native.normalizeShareUrl,url),result(legacy.normalizeShareUrl,url),String(url));
  for (const value of ['',null,[],{},'0.1.2.3','0xff.1.2.3','127.1.2.3','169.254.1.2','224.1.2.3','192.168.1.2',
    '::','::1','::ffff:abc.1','::ffff:1..1.1','::ffff:169.254.1.2','::ffff:127.0.0.1','fe80::1','fd00::1','FF01::1','1..1.1']) {
    assert.equal(native.blockedAddress(value),legacy.blockedAddress(value),String(value));
  }
});

test('real HTTP remote errors preserve legacy status, message, metadata and header precedence', async t => {
  let current;
  const remote = await serveRemote(t, async () => current);
  const old = fixture(t,remote.origin,legacy.createFleetSharing);
  const next = fixture(t,remote.origin);
  let count = 0;
  const bodies = [null, 7, [], 'bad json', {}, { error: 'bad\ud800 text', detail:'detail\udfff' }, { error: 'no access', code: 'CUSTOM_ERROR', retryable:false },
    { error: { code:'EXPIRED',message:'expired',detail:'upstream\n detail',action:'login',scope:'session' } },
    { code:'bad code!',message:'message',category:'provider',requestId:'body-id',correlationId:'body-correlation' }];
  for (const status of [400,401,403,404,410,429,503]) for (const body of bodies) {
    current = response(status,body, {'x-multicc-request-id':'remote-id','x-request-id':'ignored-id','x-correlation-id':'upstream-correlation'});
    for (const method of ['import','refresh','ticket']) {
      const call = svc => method === 'import' ? svc.importExternal({shareUrl:`${remote.origin}/fleet-share/${TOKEN}`,password:'password'})
        : method === 'refresh' ? svc.refreshExternal('external') : svc.issueExternalWsTicket('external',{pathname:'/ws/chat',sessionId:'one'});
      assert.deepEqual(await outcome(() => call(next)),await outcome(() => call(old)),`${method} ${status} ${JSON.stringify(body)}`);
      count++;
    }
  }
  for (const status of [301,302,307,308]) {
    current = response(status,'', {location:`${remote.origin}/api/elsewhere`});
    assert.deepEqual(await outcome(() => next.refreshExternal('external')),await outcome(() => old.refreshExternal('external')));
    count++;
  }
  t.diagnostic(`${count} real HTTP error/redirect comparisons`);
});

test('raw responses, credential forwarding and post-mutation cache refresh remain compatible', async t => {
  const seen = [];
  const bytes = Buffer.from([0,255,0,128,9]);
  const remote = await serveRemote(t, async (url,init) => {
    seen.push({url,init});
    if (url.endsWith('/state')) return response(200,{...payload,fleet:{...payload.fleet,name:'Changed'}});
    return { status:201,headers:{get: key => ({'content-type':'application/octet-stream','cache-control':'no-store','x-request-id':'request-one'})[key]},arrayBuffer:async()=>bytes };
  });
  const next = fixture(t,remote.origin);
  const result = await next.proxyExternal('external',{method:'POST',pathname:'/api/sessions',
    headers:{accept:'binary','content-type':'application/octet-stream','x-correlation-id':'correlation',authorization:'discard-me',cookie:'discard-me'},body:bytes});
  assert.deepEqual(result.body,bytes); assert.equal(result.status,201); assert.equal(result.upstreamRequestId,'request-one');
  assert.equal(seen.length,2); assert.equal(seen[0].init.headers['x-multicc-fleet-token'],TOKEN);
  assert.equal(seen[0].init.headers['x-multicc-fleet-grant'],GRANT);
  assert.equal(seen[0].init.headers['x-correlation-id'],'correlation');
  assert.equal(seen[0].init.headers.authorization,undefined); assert.equal(seen[0].init.headers.cookie,undefined);
  assert.equal(next.listExternal()[0].remoteName,'Changed');
  const invalid = ['/elsewhere', '//example.invalid/api/test', 'http://example.invalid/api/test', '/api/../../x'];
  for (const pathname of invalid) await assert.rejects(next.proxyExternal('external',{pathname}), {code:'INVALID_REMOTE_PATH'});
  assert.equal(seen.length,2);
});

test('body stalls, chunk overflow, decompression overflow terminate', async t => {
  const http = require('node:http');
  const zlib = require('node:zlib');
  let mode = 'stall';
  const server = http.createServer((req,res) => {
    req.resume();
    if (mode === 'stall') { res.writeHead(200,{'content-type':'application/json'}); res.write('{'); }
    else if (mode === 'large') { res.writeHead(200,{'content-type':'application/json'}); res.end(' '.repeat(1024*1024+1)); }
    else if (mode === 'gzip') { res.setHeader('content-encoding','gzip'); res.end(zlib.gzipSync(Buffer.alloc(1024*1024+1,32))); }
    else if (mode === 'redirect') {res.writeHead(302,{location:'/other'});res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const next = fixture(t,origin);
  const deadline = fixture(t,origin,native.createFleetSharing,{fetchTimeoutMs:1000});
  const input = {shareUrl:`${origin}/fleet-share/${TOKEN}`,password:'password'};
  await assert.rejects(deadline.importExternal(input), {code:'REMOTE_TIMEOUT'});
  mode = 'large'; await assert.rejects(next.importExternal(input), {code:'REMOTE_RESPONSE_TOO_LARGE'});
  mode = 'gzip'; await assert.rejects(next.importExternal(input), {code:'REMOTE_RESPONSE_TOO_LARGE'});
});

test('transport rejects metadata names and mapped link-local addresses before connecting', async t => {
  const next = fixture(t,'http://127.0.0.1');
  for (const host of ['metadata.google.internal','metadata.google.internal.','instance-data','169.254.169.254','[::ffff:a9fe:a9fe]','0.1.2.3']) {
    await assert.rejects(next.importExternal({shareUrl:`http://${host}/fleet-share/${TOKEN}`,password:'password'}), {code:'UNSAFE_SHARE_URL'});
  }
});

test('successful JSON, compression, BOM and invalid ticket responses match legacy behavior', async t => {
  let current;
  const remote = await serveRemote(t,async()=>current);
  const old = fixture(t,remote.origin,legacy.createFleetSharing);
  const next = fixture(t,remote.origin);
  const variants = [
    response(200,'\ufeff'+JSON.stringify(payload)), response(200,'not-json'),
    response(200,JSON.stringify({...payload,capability:null})), response(204,''),
  ];
  for (current of variants) {
    const call = svc => svc.importExternal({shareUrl:`${remote.origin}/fleet-share/${TOKEN}`,password:'password'});
    assert.deepEqual(await outcome(()=>call(next)),await outcome(()=>call(old)));
  }
  for (const body of [{ticket:'x',wsOrigin:'ws://remote'}, {ticket:2,wsOrigin:'ws://remote'}, null, 'invalid']) {
    current = response(200,body);
    assert.deepEqual(await outcome(()=>next.issueExternalWsTicket('external',{pathname:'/ws/chat'})),
      await outcome(()=>old.issueExternalWsTicket('external',{pathname:'/ws/chat'})));
  }
  current = {status:200,headers:{get:name=>name==='content-encoding'?'gzip':null},
    arrayBuffer:async()=>require('node:zlib').gzipSync(Buffer.from(JSON.stringify(payload)))};
  assert.deepEqual(await next.refreshExternal('external'),await old.refreshExternal('external'));
});

test('HTTPS validates certificates and accepts the configured extra CA without leaking URLs', async t => {
  const {execFileSync} = require('node:child_process');
  const https = require('node:https');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'multicc-workspace-tls-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const key = path.join(dir,'key.pem'); const cert = path.join(dir,'cert.pem');
  const caKey = path.join(dir,'ca-key.pem'); const ca = path.join(dir,'ca.pem');
  const csr = path.join(dir,'server.csr'); const extensions = path.join(dir,'extensions.cnf');
  fs.writeFileSync(extensions,'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  const openssl = args => execFileSync('openssl',args,{stdio:'ignore'});
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout',caKey,'-out',ca,'-days','1','-subj','/CN=Test CA','-addext','basicConstraints=critical,CA:TRUE']);
  openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout',key,'-out',csr,'-subj','/CN=localhost']);
  openssl(['x509','-req','-in',csr,'-CA',ca,'-CAkey',caKey,'-CAcreateserial','-out',cert,'-days','1','-extfile',extensions]);
  const server = https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{req.resume();res.end(JSON.stringify(payload));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const origin=`https://127.0.0.1:${server.address().port}`;
  const next = fixture(t,origin);
  const saved = process.env.NODE_EXTRA_CA_CERTS;
  t.after(()=>{ if(saved===undefined) delete process.env.NODE_EXTRA_CA_CERTS; else process.env.NODE_EXTRA_CA_CERTS=saved; });
  delete process.env.NODE_EXTRA_CA_CERTS;
  await assert.rejects(next.importExternal({shareUrl:`${origin}/fleet-share/${TOKEN}`,password:'secret-password'}),error=>{
    assert.equal(error.code,'REMOTE_UNAVAILABLE');
    assert.equal(JSON.stringify(error).includes(TOKEN),false);
    assert.equal(JSON.stringify(error).includes('secret-password'),false);
    return true;
  });
  process.env.NODE_EXTRA_CA_CERTS=ca;
  const result = await next.refreshExternal('external');
  assert.equal(result.remoteName,'Remote');
});

test('remote repeated and Latin-1 headers preserve Fetch error metadata semantics', async t => {
  const http = require('node:http');
  let mode = 'duplicate';
  const server = http.createServer((req,res)=>{
    req.resume();res.statusCode=503;
    res.setHeader('x-multicc-request-id',mode==='duplicate'?['one','two']:'  ');
    res.setHeader('x-request-id','fallback');
    res.setHeader('x-correlation-id','caf\xe9');
    res.end(JSON.stringify({code:'OVERLOAD',error:'remote error'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const old=fixture(t,origin,legacy.createFleetSharing); const next=fixture(t,origin);
  for(mode of ['duplicate','blank']) {
    for(const method of ['import','refresh']) {
      const call = svc => method==='import'?svc.importExternal({shareUrl:`${origin}/fleet-share/${TOKEN}`,password:'password'}):svc.refreshExternal('external');
      assert.deepEqual(await outcome(()=>call(next)),await outcome(()=>call(old)));
    }
  }
});

const { start: startGateway, request: gatewayRequest } = require('./helpers/external-workspace-gateway');
function seedExternal(origin) {
  return { schemaVersion: 1, fleets: { external: { id: 'external', sourceOrigin: origin,
    sourceInstanceId: 'remote', sourceFleetId: 'workspace', remoteToken: TOKEN, remoteGrant: GRANT,
    remoteName: 'Remote', sessions: [{ id: 'one', label: 'Worker' }], sessionCount: 1,
    importedAt: 1, refreshedAt: 1 } } };
}
const authorized = { 'x-access-token': 'fixture-token' };
function normalizedHTTP(r) {
  const headers = { ...r.headers };
  for (const k of ['date', 'connection', 'keep-alive']) delete headers[k];
  let body = r.body;
  if (headers['content-encoding'] === 'gzip') {
    assert.equal(Number(headers['content-length']), r.bytes.length);
    body = require('node:zlib').gunzipSync(r.bytes).toString();
    delete headers['content-length']; // compressor output differs, decoded bytes and ETag must not
  }
  if (r.status === 200 && body.startsWith('{"ok":true,"fleet":')) {
    const value = JSON.parse(body); value.fleet.refreshedAt = 0;
    if (value.fleet.importedAt !== 1) value.fleet.importedAt = 0;
    body = JSON.stringify(value); delete headers.etag; delete headers['content-length'];
  }
  return { status: r.status, headers, body };
}
test('external workspace HTTP routes match Express and never enter the Node host', { timeout: 60000 }, async t => {
  let current = response(200, payload);
  const remote = await serveRemote(t, async () => current);
  const seed = seedExternal(remote.origin);
  const old = await startGateway(t, false, { seed });
  const next = await startGateway(t, true, { seed });
  const json = { ...authorized, 'content-type': 'application/json' };
  const base = '/api/external-fleets';
  let comparisons = 0;
  async function compare(method, url, headers = authorized, body = '') {
    const a = await gatewayRequest(old.port, method, url, headers, body);
    const b = await gatewayRequest(next.port, method, url, headers, body);
    assert.deepEqual(normalizedHTTP(b), normalizedHTTP(a), `${method} ${url}`); comparisons++;
    return b;
  }
  const listed = await compare('GET',base);
  await compare('GET',base,{...authorized,'if-none-match':listed.headers.etag});
  await compare('GET',base,{...authorized,'if-none-match':listed.headers.etag,'cache-control':'no-cache'});
  for (const route of [base, '/API/EXTERNAL-FLEETS/', base+'/external/remote/api/sessions?x=1',base+'/external/remote/api/directories']) {
    await compare('GET', route); await compare('HEAD', route);
  }
  for (const route of [base, base+'/import', base+'/missing', base+'/missing/refresh', base+'/missing/ws-ticket']) await compare('OPTIONS',route);
  await compare('DELETE',base+'/missing');
  await compare('POST',base+'/import',json,'{}');
  await compare('POST',base+'/external/refresh',json,'{}');
  await compare('POST',base+'/external/remote/api/update',json,'{"value":"中文"}');
  for (const suffix of ['/import','/%ZZ/refresh','/external/refresh','/external/remote/api/%ZZ']) {
    await compare('POST',base+suffix,json,'{bad');
    await compare('POST',base+suffix,{...json,'content-type':'application/json; charset=latin1'},'{}');
  }
  await compare('POST',base+'/%ZZ/refresh',json,'{}');
  await compare('POST',base+'/external/refresh',{...json,'content-encoding':'gzip'},require('node:zlib').gzipSync('{}'));
  await compare('GET',base,{}); // unauthorized non-local Host
  await compare('GET',base,{'x-forwarded-for':'127.0.0.1'});
  for (const message of ['remote grant expired','Bearer token-value token=secret /private/path?q=1',
    'SK_ABCDEFGHIJKLM sk_abcdefghijklm /a/b?tail', 'bad\ud800 text', 'x'.repeat(239)+'😀']) {
    current = response(403,{code:'REMOTE_AUTH_EXPIRED',error:message,detail:message,category:'remote',retryable:false,
      action:'login',scope:'session'}, {'x-request-id':'remote-request-11'});
    const r = await compare('POST',base+'/external/ws-ticket',json,'{"pathname":"/ws/chat"}');
    assert.equal(JSON.parse(r.body).upstreamRequestId,'remote-request-11');
    assert.equal(r.headers['x-multicc-upstream-request-id'],'remote-request-11');
  }
  for (const status of [200,204,404,503]) {
    current = response(status,'x'.repeat(2048), {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    await compare('GET',base+'/external/remote/api/raw',{...authorized,'accept-encoding':'gzip'});
  }
  current = response(200,{ticket:'remote-ticket',wsOrigin:'ws://remote'});
  await compare('POST',base+'/external/ws-ticket',json,'{"pathname":"/ws/chat"}');
  current = response(200,payload);
  await compare('POST',base+'/import',json,JSON.stringify({shareUrl:`${remote.origin}/fleet-share/${TOKEN}`,password:'password',alias:'Imported'}));
  // Both caches now include the changed name; compare after aligning wall-clock fields above.
  await compare('DELETE',base+'/external');
  await compare('GET',base);
  const hits = JSON.parse((await gatewayRequest(next.port,'GET','/fixture/state')).body).hits;
  assert.deepEqual(hits.filter(p=>!p.startsWith('/fixture/')),[]);
  assert.equal(fs.existsSync(path.join(next.dir,'fleet-shares.json')),false);
  t.diagnostic(`${comparisons} external HTTP comparisons; no external route entered Express`);
});

test('Rust gateway streams exact upload bytes and closes aborted or rejected upstreams', { timeout: 60000 }, async t => {
  const http = require('node:http');
  const crypto = require('node:crypto');
  const { once } = require('node:events');
  let mode = 'upload', total = 0, receivedHash, closed = 0, begun;
  const server = http.createServer(async (req,res) => {
    if (req.url.endsWith('/state')) { req.resume(); return res.end(JSON.stringify(payload)); }
    req.on('close',()=>closed++);
    if (begun) { begun(); begun = null; }
    if (mode === 'redirect') { res.writeHead(302,{location:'/elsewhere'}); return res.end(); }
    const hash = crypto.createHash('sha256');
    try {
      await new Promise(resolve=>setTimeout(resolve,50));
      for await (const chunk of req) { total+=chunk.length; hash.update(chunk); }
      receivedHash=hash.digest('hex'); res.end('done');
    } catch {} // client abort is the assertion target, not a fixture failure
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const next = await startGateway(t,true,{seed:seedExternal(`http://127.0.0.1:${server.address().port}`)});
  const url='/api/external-fleets/external/remote/api/upload';
  function begin() {
    let resolve, reject;
    const result = new Promise((a,b)=>{resolve=a;reject=b;});
    const req=http.request({host:'127.0.0.1',port:next.port,method:'PUT',path:url,
      headers:{...authorized,'content-type':'application/octet-stream'}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
    });
    req.on('error',reject); result.catch(()=>{}); return {req,result};
  }
  const first=begin(), expected=crypto.createHash('sha256');
  let backpressure=0;
  for(let i=0;i<96;i++) {
    const chunk=Buffer.alloc(100000,i);expected.update(chunk);
    if(!first.req.write(chunk)){backpressure++;await once(first.req,'drain');}
  }
  first.req.end();
  assert.deepEqual(await first.result,{status:200,body:'done'});
  assert.equal(total,9600000);assert.equal(receivedHash,expected.digest('hex'));assert.ok(backpressure>0);
  // Keep the body unfinished so dropping the client must close the pinned remote request.
  mode='abort';const baseline=closed;
  const started=new Promise(resolve=>{begun=resolve;});
  const aborted=begin();aborted.req.write(Buffer.alloc(100000));await started;aborted.req.destroy(new Error('test abort'));
  await assert.rejects(aborted.result,/test abort/);
  for(let i=0;i<100&&closed===baseline;i++) await new Promise(r=>setTimeout(r,20));
  assert.ok(closed>baseline,'upstream closes after upload client disconnect');
  mode='redirect';const rejected=begin();rejected.req.write('first');
  const r=await rejected.result;assert.equal(r.status,502);assert.equal(JSON.parse(r.body).code,'REMOTE_REDIRECT_REJECTED');rejected.req.destroy();
  const state=JSON.parse((await gatewayRequest(next.port,'GET','/fixture/state')).body);
  assert.deepEqual(state.hits.filter(p=>!p.startsWith('/fixture/')),[]);
});

test('gateway owns imported state through child restarts and failed saves publish no cache changes', {timeout:30000},async t=>{
  const remote=await serveRemote(t,async()=>response(200,{...payload,fleet:{...payload.fleet,name:'New name'}}));
  const next=await startGateway(t,true,{seed:seedExternal(remote.origin)});
  const initial=await gatewayRequest(next.port,'GET','/api/external-fleets',authorized);
  const file=path.join(next.dir,'external-fleets.json');
  // A failed durable save must keep the previously published snapshot.
  const original=fs.readFileSync(file);fs.unlinkSync(file);fs.mkdirSync(file);
  const failed=await gatewayRequest(next.port,'POST','/api/external-fleets/external/refresh',authorized);
  assert.equal(failed.status,500);assert.equal(JSON.parse(failed.body).code,'INTERNAL_ERROR');
  assert.equal((await gatewayRequest(next.port,'GET','/api/external-fleets',authorized)).body,initial.body);
  fs.rmdirSync(file);fs.writeFileSync(file,original);
  // The supervisor replaces only its Node child. Imported state remains gateway-owned.
  const before=JSON.parse((await gatewayRequest(next.port,'GET','/fixture/state')).body).pid;
  await gatewayRequest(next.port,'POST','/fixture/crash');
  let after=before;
  for(let i=0;i<100&&after===before;i++) {
    await new Promise(r=>setTimeout(r,30));
    try { after=JSON.parse((await gatewayRequest(next.port,'GET','/fixture/state')).body).pid||before; } catch {}
  }
  assert.notEqual(after,before);
  assert.equal((await gatewayRequest(next.port,'GET','/api/external-fleets',authorized)).body,initial.body);
  assert.equal((await gatewayRequest(next.port,'POST','/api/external-fleets/external/refresh',authorized)).status,200);
  const persisted=JSON.parse(fs.readFileSync(file));assert.equal(persisted.fleets.external.remoteName,'New name');
  assert.equal(fs.existsSync(path.join(next.dir,'fleet-shares.json')),false);
});
