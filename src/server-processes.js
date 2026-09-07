'use strict';

// OS-backed process discovery shared by manual and button-triggered restarts.
// Never trust a stale pidfile or match every Node process.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function processTable() {
  if (process.platform === 'win32') {
    const raw = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(raw).map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId,
      born: String(p.CreationDate), command: p.CommandLine || '' }));
  }
  const raw = cp.execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,args='],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  return raw.split('\n').flatMap(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), born: m[3], command: m[4] }] : [];
  });
}

function processCwd(pid) {
  try {
    if (process.platform === 'linux') return fs.realpathSync(`/proc/${pid}/cwd`);
    if (process.platform === 'darwin') {
      const result = cp.execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
        { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      return result.split('\n').find(line => line.startsWith('n'))?.slice(1);
    }
  } catch (_) { /* A process may exit between enumeration and inspection. */ }
  return null;
}

function sameProcess(a, b) {
  return !!a && !!b && a.pid === b.pid && a.born === b.born && a.command === b.command;
}
function isServer(record, config, cwd = processCwd) {
  if (record.pid === process.pid || record.pid <= 1) return false;
  const command = record.command.replace(/"/g, '');
  const executable = command.startsWith(config.execPath + ' ') ? config.execPath
    : command.match(/^(?:\S*[/\\])?node(?:js|\.exe)?(?=\s)/)?.[0];
  if (!executable) return false;
  const args = command.slice(executable.length).trim();
  if (/(?:^|\s)(?:-e|--eval|-p|--print)(?:\s|=|$)/.test(args)) return false;
  const mainEntry = entry => {
    const at = (` ${args} `).indexOf(` ${entry} `);
    return at >= 0 && /^(?:--[\w-]+(?:=[^\s]+)?\s+)*$/.test(args.slice(0, at));
  };
  if (mainEntry(config.entry)) return true;
  // Relative server.js is the normal manager launch, so PID files and absolute
  // command matching alone cannot identify duplicates. Resolve its real cwd.
  return (mainEntry('server.js') || mainEntry('./server.js'))
    && cwd(record.pid) === config.rootDir;
}
function descendants(table, roots, excluded = new Set([process.pid])) {
  const selected = new Map(roots.map(p => [p.pid, p]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of table) {
      if (!excluded.has(record.pid) && selected.has(record.ppid) && !selected.has(record.pid)) {
        selected.set(record.pid, record); changed = true;
      }
    }
  }
  for (const pid of excluded) selected.delete(pid);
  return selected;
}
function signalVerified(record, signal, table = processTable()) {
  if (!sameProcess(record, table.find(p => p.pid === record.pid))) return false;
  try { process.kill(record.pid, signal); return true; }
  catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
}

function protectedAncestors(table, roots) {
  const excluded = new Set();
  const servers = new Set(roots.map(p => p.pid));
  let pid = process.pid;
  while (pid > 1 && !servers.has(pid) && !excluded.has(pid)) {
    excluded.add(pid); pid = table.find(p => p.pid === pid)?.ppid || 0;
  }
  return excluded;
}
async function stopServers(config, { graceMs = 65000, log = console.log } = {}) {
  let table = processTable();
  const roots = table.filter(p => isServer(p, config));
  const excluded = protectedAncestors(table, roots);
  const owned = descendants(table, roots, excluded);
  log('Stopping MultiCC PID(s): ' + (roots.map(p => p.pid).join(', ') || 'none'));
  for (const root of roots) signalVerified(root, 'SIGINT', table);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    table = processTable();
    const live = [...owned.values()].filter(p => sameProcess(p, table.find(n => n.pid === p.pid)));
    for (const [pid, record] of descendants(table, live, excluded)) owned.set(pid, record);
    if (!roots.some(p => sameProcess(p, table.find(n => n.pid === p.pid)))) break;
    await sleep(250);
  }
  table = processTable();
  for (const record of [...owned.values()].reverse()) signalVerified(record, 'SIGTERM', table);
  await sleep(250);
  table = processTable();
  for (const record of [...owned.values()].reverse()) signalVerified(record, 'SIGKILL', table);
  for (let attempt = 0; attempt < 20; attempt++) {
    table = processTable();
    if (![...owned.values()].some(p => sameProcess(p, table.find(n => n.pid === p.pid)))) {
      log('MultiCC stopped'); return;
    }
    await sleep(100);
  }
  throw new Error('old MultiCC processes did not exit; refusing to start a duplicate');
}
module.exports = { processTable, isServer, sameProcess, descendants, stopServers, protectedAncestors };
if (require.main === module) {
  const rootDir = fs.realpathSync(process.argv[3]);
  const config = { rootDir, entry: path.join(rootDir, 'server.js'), execPath: process.execPath };
  if (process.argv[2] === 'list') {
    for (const p of processTable().filter(p => isServer(p, config))) console.log(p.pid);
  } else if (process.argv[2] === 'owner') {
    const owner = processTable().find(p => p.pid === Number(process.argv[4]));
    if (!owner) process.exitCode = 1;
    else console.log(JSON.stringify(owner));
  } else if (process.argv[2] === 'lock-alive') {
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(rootDir, 'logs', 'restart.lock', 'owner.json'), 'utf8'));
      process.exitCode = sameProcess(owner, processTable().find(p => p.pid === owner.pid)) ? 0 : 1;
    } catch (_) { process.exitCode = 1; }
  } else if (process.argv[2] === 'stop') {
    stopServers(config).catch(error => { console.error(error.message); process.exitCode = 1; });
  } else { console.error('Expected list or stop'); process.exitCode = 1; }
}
