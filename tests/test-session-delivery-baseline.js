'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const implementations = [require('./helpers/legacy-session-delivery'), require('../src/session/delivery')];

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
