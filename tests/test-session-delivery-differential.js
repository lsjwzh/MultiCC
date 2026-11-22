'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const implementations = [require('./helpers/legacy-session-delivery'), require('../src/native/runtime').getSessionDeliveryApi()];

test('delivery validates synchronously and preserves coercion and metadata order', async () => {
  for (const implementation of implementations) {
    const calls=[];const trace=[];
    const delivery=implementation.createSessionDelivery({admit:(...args)=>{calls.push(args);return {ok:true};}});
    assert.throws(()=>delivery.deliver('', 'text'),{name:'TypeError',message:'[session-delivery] sessionId is required'});
    assert.throws(()=>delivery.deliver('s', '  '),{name:'TypeError',message:'[session-delivery] text is required'});
    const options=new Proxy({system:true,retry:true,originContinue:false,deliveryId:'d'}, {
      get(target,key,receiver){trace.push(`get:${String(key)}`);return Reflect.get(target,key,receiver);},
      ownKeys(target){trace.push('keys');return Reflect.ownKeys(target);},
    });
    await delivery.deliver({toString(){trace.push('session');return ' s ';}}, {toString(){trace.push('text');return 'payload';}}, options);
    assert.deepEqual(calls,[['s','🔇payload',{originContinue:true,deliveryId:'d'}]]);
    assert.deepEqual(trace,['session','text','get:kind','get:kind','get:system','keys','get:retry','get:originContinue','get:deliveryId']);
  }
});

test('admission rejections preserve values and exceptions become logged failures', async () => {
  for (const implementation of implementations) {
    const logs=[];const rejected={ok:false,code:'closed'};
    const delivery=implementation.createSessionDelivery({admit:()=>rejected,log:value=>logs.push(value)});
    assert.equal(await delivery.deliverContinuation('s','message'),rejected);
    assert.deepEqual(logs,['[session-delivery] continuation rejected for s: closed']);
    for (const admit of [()=>{throw Error('sync');}, async()=>{throw Error('async');}]) {
      const messages=[];const target=implementation.createSessionDelivery({admit,log:value=>messages.push(value)});
      assert.deepEqual(await target.deliverContinuation('s','message'),{ok:false,code:'delivery_failed'});
      assert.match(messages[0],/\[session-delivery\] continuation failed for s: (sync|async)/);
    }
  }
});

test('exported delivery kind set is live and controls validation', async () => {
  for (const implementation of implementations) {
    implementation.DELIVERY_KINDS.add('custom');
    try {
      const calls=[];const delivery=implementation.createSessionDelivery({admit:(...args)=>{calls.push(args);return true;}});
      assert.equal(await delivery.deliver('s','message',{kind:'custom'}),true);
      assert.equal(calls[0][2].kind,undefined);
    } finally { implementation.DELIVERY_KINDS.delete('custom'); }
  }
});

function caught(fn) {
  try { return { value:fn() }; }
  catch (error) { return { error:{ name:error?.name, message:error?.message, code:error?.code } }; }
}
test('factory and synchronous validation preserve defaults and getter failures', () => {
  const maker = [() => undefined, () => null, () => ({}), () => ({admit:1}),
    () => ({get admit(){throw new TypeError('admit getter');}}),
    () => ({admit(){},get log(){throw new TypeError('log getter');}})];
  for (const make of maker) {
    const values=implementations.map(impl=>caught(()=>impl.createSessionDelivery(make())));
    assert.deepEqual(values[1],values[0]);
  }
  for(const impl of implementations){
    const delivery=impl.createSessionDelivery({admit(){return true;}});
    for(const args of [[],['s'],['s','text',null],['s','text',{kind:'unknown'}],['s','text',{kind:Symbol('x')}]]) {
      const previous=implementations[0].createSessionDelivery({admit(){return true;}});
      assert.deepEqual(caught(()=>delivery.deliver(...args)),caught(()=>previous.deliver(...args)));
    }
    assert.equal(delivery.deliver.length,2);
    assert.equal(delivery.deliverContinuation.length,2);
    assert.equal(delivery.deliverSystem.length,2);
  }
});

test('metadata proxy traps, symbol keys, getters and coercion match the oracle', async () => {
  const outcomes=[];
  for(const impl of implementations){
    const trace=[];const token=Symbol('token');let captured;
    const options=new Proxy({kind:'continuation',system:true,retry:1,originContinue:false,[token]:'v',x:4},{
      get(t,k,r){trace.push(`get:${String(k)}`);return Reflect.get(t,k,r);},
      ownKeys(t){trace.push('ownKeys');return Reflect.ownKeys(t);},
      getOwnPropertyDescriptor(t,k){trace.push(`descriptor:${String(k)}`);return Reflect.getOwnPropertyDescriptor(t,k);},
    });
    const d=impl.createSessionDelivery({admit(id,message,meta){captured={id,message,keys:Reflect.ownKeys(meta).map(String),symbol:meta[token],meta};return {ok:true};}});
    await d.deliver({[Symbol.toPrimitive](hint){trace.push(`id:${hint}`);return ' s ';}},Symbol('message'),options);
    outcomes.push({trace,id:captured.id,message:captured.message,keys:captured.keys,symbol:captured.symbol,meta:{...captured.meta,[token]:undefined}});
  }
  // Each run uses a distinct Symbol: compare their names and value separately.
  delete outcomes[0].meta[Reflect.ownKeys(outcomes[0].meta).find(k=>typeof k==='symbol')];
  delete outcomes[1].meta[Reflect.ownKeys(outcomes[1].meta).find(k=>typeof k==='symbol')];
  assert.deepEqual(outcomes[1],outcomes[0]);
});

test('throwing input getters and rejected promises keep original identity and timing', async () => {
  for(const impl of implementations){
    const marker=Error('getter identity');const delivery=impl.createSessionDelivery({admit(){throw Error('must not run');}});
    assert.throws(()=>delivery.deliver('s','text',{get kind(){throw marker;}}),error=>error===marker);
    assert.throws(()=>delivery.deliver({toString(){throw marker;}},'text'),error=>error===marker);
    const traces=[];
    const d=impl.createSessionDelivery({admit(){return Promise.reject(marker);},log(v){traces.push(v);}});
    assert.deepEqual(await d.deliver('s','text'),{ok:false,code:'delivery_failed'});
    assert.deepEqual(traces,['[session-delivery] continuation failed for s: getter identity']);
  }
});

test('logger failures preserve synchronous and asynchronous failure boundaries', async () => {
  for(const impl of implementations){
    const marker=Error('logger');
    const sync=impl.createSessionDelivery({admit(){throw Error('admit');},log(){throw marker;}});
    assert.throws(()=>sync.deliver('s','x'),error=>error===marker);
    const async=impl.createSessionDelivery({admit(){return false;},log(){throw marker;}});
    await assert.rejects(async.deliver('s','x'),error=>error===marker);
  }
});

test('native API is cached and callback cycles can be collected', () => {
  const runtime=require('../src/native/runtime');
  assert.equal(runtime.getSessionDeliveryApi(),runtime.getSessionDeliveryApi());
  assert.equal(runtime.SESSION_DELIVERY_SYSTEM_PREFIX, runtime.getSessionDeliveryApi().SYSTEM_PREFIX);
  const {spawnSync}=require('node:child_process');
  const script=String.raw`
    const api=require(process.argv[1]).sessionDeliveryApi();
    function cycle(){let d;d=api.createSessionDelivery({admit(){return d;}});return new WeakRef(d);}
    function pendingCycle(){let d;d=api.createSessionDelivery({admit(){return new Promise(()=>{});},log(){return d;}});const pending=d.deliver('s','m');d.pending=pending;return new WeakRef(d);}
    (async()=>{const refs=[cycle(),pendingCycle()];for(let i=0;i<30;i++){await new Promise(r=>setImmediate(r));global.gc();}if(refs.some(weak=>weak.deref()!==undefined))throw Error('delivery callback cycle retained');})().catch(e=>{console.error(e);process.exitCode=1;});
  `;
  const result=spawnSync(process.execPath,['--expose-gc','-e',script,runtime.addonPath()],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr || String(result.error));
});

test('mutable kind set and UTF-16 error and log messages match', async () => {
  const lone='x\ud800';
  for (const impl of implementations) {
    const delivery=impl.createSessionDelivery({admit(){return false;},log(){}});
    assert.throws(()=>delivery.deliver('s','m',{kind:lone}),error=>error instanceof TypeError && error.message===`[session-delivery] unsupported kind: ${lone}`);
    impl.DELIVERY_KINDS.add(lone);
    try {
      const logs=[];const d=impl.createSessionDelivery({admit(){return false;},log(message){logs.push(message);}});
      assert.equal(await d.deliver('s','m',{kind:lone}),false);
      assert.deepEqual(logs,[`[session-delivery] ${lone} rejected for s: not_accepted`]);
    } finally {impl.DELIVERY_KINDS.delete(lone);}
  }
});

test('factory reads optional log getter twice and preserves a changing result', async () => {
  const results=[];
  for (const impl of implementations) {
    let reads=0;
    const options={admit(){return false;},get log(){reads++;return reads===1 ? ()=>{} : undefined;}};
    const delivery=impl.createSessionDelivery(options);
    const outcome=await delivery.deliver('s','m').then(value=>({value}),error=>({name:error.name,message:error.message}));
    results.push({reads,outcome});
  }
  assert.deepEqual(results[1],results[0]);
  assert.deepEqual(results[0],{reads:2,outcome:{name:'TypeError',message:'log is not a function'}});
});


test('compatibility consumers load before an addon is available', () => {
  const {spawnSync}=require('node:child_process');
  const script="require('./src/wait/injector'); require('./src/task-context-host');";
  const result=spawnSync(process.execPath,['-e',script],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,MULTICC_RUST_ADDON:'/__multicc_missing__/addon.node'},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr || String(result.error));
});
