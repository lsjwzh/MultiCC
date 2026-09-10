'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskShellStore } = require('../src/task-shell/store');
const { createTaskFactsRepository } = require('../src/task-routing/facts');

const definition = () => ({id:'p1',runId:'r1',attemptId:'a1',sourceTaskId:'A',targetTaskId:'B'});
const evaluation = state => ({state,eligible:state==='ready',blockers:state==='ready'?[]:['waiting_integration'],requiresAtomicRecheck:true});
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'multicc-facts-test-'));
  const file=path.join(dir,'store.sqlite');const stores=[];
  const open=()=>{const store=createTaskShellStore(file);stores.push(store);return store;};
  t.after(()=>{for(const s of stores)s.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {open,file};
}
test('immutable facts and proposals survive reopen without modifying legacy authority', t => {
  const f=fixture(t),store=f.open(),repo=createTaskFactsRepository(store);
  store.set('task','A',{id:'A',title:'original'});store.set('shell','s1',{currentTaskId:'A'});
  const fact={id:'r1',outcome:'succeeded'};
  assert.deepEqual(repo.appendFact('run-result',fact),fact);
  assert.deepEqual(repo.appendFact('run-result',{outcome:'succeeded',id:'r1'}),fact);
  assert.throws(()=>repo.appendFact('run-result',{...fact,outcome:'error'}),{code:'immutable_fact_conflict'});
  repo.createProposal(definition());
  const reopened=createTaskFactsRepository(f.open());
  assert.deepEqual(reopened.getFact('run-result','r1'),fact);
  assert.equal(reopened.getProposal('p1').state,'pending');
  assert.deepEqual(store.get('task','A'),{id:'A',title:'original'});
  assert.deepEqual(store.get('shell','s1'),{currentTaskId:'A'});
  assert.equal(store.get('task','B'),null);
});
test('proposal update and outbox are atomic when event persistence fails', t => {
  const f=fixture(t),store=f.open(),repo=createTaskFactsRepository(store);repo.createProposal(definition());
  const failing=createTaskFactsRepository({...store,set(kind,id,body){
    if(kind==='task-first:event')throw new Error('disk failure');return store.set(kind,id,body);
  }});
  assert.throws(()=>failing.recordEvaluation('p1',{expectedVersion:1,evaluation:evaluation('ready'),eventId:'e1'}),/disk failure/);
  assert.equal(repo.getProposal('p1').version,1);assert.deepEqual(repo.pendingEvents(),[]);
});
test('two SQLite connections reject stale writes; identical event retry survives later changes', t => {
  const f=fixture(t),a=createTaskFactsRepository(f.open()),b=createTaskFactsRepository(f.open());
  a.createProposal(definition());
  const request={expectedVersion:1,evaluation:evaluation('ready'),eventId:'e1'};
  const first=a.recordEvaluation('p1',request);
  assert.throws(()=>b.recordEvaluation('p1',{...request,eventId:'e2'}),{code:'proposal_version_conflict'});
  b.recordEvaluation('p1',{expectedVersion:2,evaluation:evaluation('pending'),eventId:'e2'});
  assert.deepEqual(b.recordEvaluation('p1',request),first);
  assert.equal(a.getProposal('p1').version,3);
  assert.equal(a.createProposal(definition()).version,3);
  assert.throws(()=>a.createProposal({...definition(),targetTaskId:'C'}),{code:'proposal_definition_conflict'});
  assert.throws(()=>a.recordEvaluation('p1',{...request,evaluation:evaluation('pending')}),{code:'event_id_conflict'});
});
test('outbox acknowledgment is replay-safe and pending delivery survives restart', t => {
  const f=fixture(t),repo=createTaskFactsRepository(f.open());repo.createProposal(definition());
  repo.recordEvaluation('p1',{expectedVersion:1,evaluation:evaluation('pending'),eventId:'e1'});
  const again=createTaskFactsRepository(f.open());assert.equal(again.pendingEvents().length,1);
  assert.deepEqual(again.acknowledge('e1'),again.acknowledge('e1'));assert.deepEqual(repo.pendingEvents(),[]);
});
test('invalid storage inputs fail before partial state or bypass of actual application', t => {
  const f=fixture(t),repo=createTaskFactsRepository(f.open());repo.createProposal(definition());
  for(const fact of [{id:'x',value:NaN},{id:'x',value:undefined},{id:'x',value:1n},{id:'../x'}]) {
    assert.throws(()=>repo.appendFact('run-result',fact));
  }
  assert.throws(()=>repo.appendFact('task',{id:'B'}),{code:'invalid_fact_kind'});
  assert.throws(()=>repo.recordEvaluation('p1',{expectedVersion:1,eventId:'e1',evaluation:evaluation('applied')}),{code:'invalid_evaluation'});
  assert.throws(()=>repo.recordEvaluation('p1',{expectedVersion:1,eventId:'e1',evaluation:{...evaluation('ready'),blockers:['dirty']}}),{code:'invalid_evaluation'});
  assert.equal(repo.getProposal('p1').version,1);assert.deepEqual(repo.pendingEvents(),[]);
});
test('stale candidate cannot be silently revived', t => {
  const f=fixture(t),repo=createTaskFactsRepository(f.open());repo.createProposal(definition());
  repo.recordEvaluation('p1',{expectedVersion:1,evaluation:evaluation('stale'),eventId:'e1'});
  assert.throws(()=>repo.recordEvaluation('p1',{expectedVersion:2,evaluation:evaluation('ready'),eventId:'e2'}),{code:'proposal_terminal'});
});
