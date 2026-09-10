'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { inventoryWorkspaces } = require('../src/workspace/inventory');

const directories=[{id:'d1'},{id:'d2'}];
const observed=(canonicalPath='/work/ws',branch='work')=>({canonicalPath,gitCommonDir:'/repo/.git',branch,
  exists:true,dirty:false,gitOperation:false,ignoredAccounted:true});
test('legacy owner and task sessions group once without changing any record', () => {
  const input={directories,sessions:[
    {id:'shell',dirId:'d1',worktreePath:'/work/ws',branch:'work'},
    {id:'task',dirId:'d1',workspaceOwnerSessionId:'shell',taskBoundTaskId:'A'},
    {id:'other',dirId:'d1',workspaceOwnerSessionId:'shell',taskBoundTaskId:'B'},
  ],observations:{'/work/ws':observed()}};
  const before=structuredClone(input),result=inventoryWorkspaces(input);
  assert.equal(result.counts.workspaces,1);assert.deepEqual(result.workspaces[0].taskIds,['A','B']);
  assert.equal(result.workspaces[0].canAdopt,false);assert.equal(result.workspaces[0].canReclaim,false);
  assert.ok(result.workspaces[0].reasons.includes('writers_unverified'));assert.deepEqual(input,before);
});
test('canonical path aliases share preview identity, same branch in two paths is flagged', () => {
  const sessions=[{id:'a',dirId:'d1',worktreePath:'/alias',branch:'work'},
    {id:'b',dirId:'d1',worktreePath:'/work/ws',branch:'work'}];
  const observations={'/alias':observed(),'/work/ws':observed()};
  assert.equal(inventoryWorkspaces({sessions,directories,observations}).counts.workspaces,1);
  sessions.push({id:'c',dirId:'d1',worktreePath:'/work/other',branch:'work'});
  observations['/work/other']=observed('/work/other');
  const result=inventoryWorkspaces({sessions,directories,observations});
  assert.equal(result.counts.workspaces,2);assert.ok(result.workspaces.every(w=>w.reasons.includes('branch_multiple_paths')));
});
test('unknown, dirty, ignored and execution state remain distinct retention reasons', () => {
  const result=inventoryWorkspaces({directories,sessions:[
    {id:'a',dirId:'d1',worktreePath:'/work/a',taskState:{classifyState:'D'}},
    {id:'b',dirId:'d1',worktreePath:'/work/b',kind:'terminal'},
  ],observations:{'/work/b':{...observed('/work/b'),dirty:true,ignoredAccounted:false}}});
  assert.ok(result.workspaces[0].reasons.includes('filesystem_unverified'));
  for(const code of ['dirty','ignored_files_unaccounted','execution_dependency'])assert.ok(result.workspaces[1].reasons.includes(code));
  assert.ok(result.workspaces.every(w=>w.canReclaim===false));
});
test('missing owners, cycles, paths and directories never silently resolve to a clean workspace', () => {
  const result=inventoryWorkspaces({directories,sessions:[
    {id:'missing',dirId:'d1',workspaceOwnerSessionId:'lost'},
    {id:'a',dirId:'d1',workspaceOwnerSessionId:'b'},
    {id:'b',dirId:'d1',workspaceOwnerSessionId:'a'},
    {id:'relative',dirId:'d1',worktreePath:'../../somewhere'},
    {id:'directory',dirId:'unknown'},
    {id:'empty',dirId:'d1'},
  ]});
  assert.equal(result.counts.workspaces,0);
  for(const code of ['owner_missing','owner_cycle','path_not_absolute','directory_missing'])assert.ok(result.issues.some(i=>i.code===code));
  assert.equal(result.unallocated.find(x=>x.sessionId==='empty').state,'no_declared_worktree');
  assert.equal(result.unallocated.find(x=>x.sessionId==='missing').state,'unresolved');
});
test('retired workspaces are marked outside preview coverage, never silently forgotten', () => {
  const result=inventoryWorkspaces({directories,sessions:[{id:'a',dirId:'d1',retiredWorktrees:[{path:'/old/ws'}]}]});
  assert.equal(result.unallocated[0].state,'unresolved');
  assert.ok(result.issues.some(x=>x.code==='retired_workspaces_uninspected'));
});
test('conflicting declared branch and path ownership require review', () => {
  const result=inventoryWorkspaces({directories,sessions:[
    {id:'owner',dirId:'d1',worktreePath:'/work/ws',branch:'one'},
    {id:'child',dirId:'d2',workspaceOwnerSessionId:'owner',worktreePath:'/work/other',branch:'two'},
  ]});
  const child=result.workspaces.find(w=>w.sessionIds.includes('child'));
  for(const code of ['owner_path_mismatch','owner_directory_mismatch','branch_conflict'])assert.ok(child.reasons.includes(code));
});
test('CLI requires explicit snapshot and leaves input and filesystem unchanged', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'multicc-inventory-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const input=path.join(dir,'input.json');const bytes=JSON.stringify({directories,sessions:[{id:'s1',dirId:'d1'}]});
  fs.writeFileSync(input,bytes);
  const script=path.resolve(__dirname,'../scripts/task-workspace-inventory.js');
  const output=execFileSync(process.execPath,[script,'--input',input],{cwd:dir,encoding:'utf8'});
  assert.equal(JSON.parse(output).mode,'read-only-preview');assert.equal(fs.readFileSync(input,'utf8'),bytes);
  assert.deepEqual(fs.readdirSync(dir),['input.json']);
  assert.throws(()=>execFileSync(process.execPath,[script],{cwd:dir,stdio:'pipe'}));
});
