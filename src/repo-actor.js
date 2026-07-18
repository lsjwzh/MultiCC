'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;
const NONINTERACTIVE_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '/usr/bin/false',
  SSH_ASKPASS: '/usr/bin/false',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new -oConnectTimeout=10',
};

function operationId(prefix = 'repo') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

function existingAncestor(input) {
  let current = path.resolve(input || process.cwd());
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function repoKeyFor(input) {
  let current = existingAncestor(input);
  try { if (!fs.statSync(current).isDirectory()) current = path.dirname(current); } catch (_) {}
  while (true) {
    const dotGit = path.join(current, '.git');
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return fs.realpathSync(dotGit);
      if (stat.isFile()) {
        const line = fs.readFileSync(dotGit, 'utf8').split(/\r?\n/, 1)[0];
        const match = /^gitdir:\s*(.+)$/i.exec(line);
        if (match) {
          const gitDir = path.resolve(current, match[1]);
          const marker = `${path.sep}worktrees${path.sep}`;
          const index = gitDir.lastIndexOf(marker);
          return fs.realpathSync(index >= 0 ? gitDir.slice(0, index) : gitDir);
        }
      }
    } catch (_) {}
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try { return fs.realpathSync(existingAncestor(input)); }
  catch (_) { return path.resolve(input || process.cwd()); }
}

class RepoActor {
  constructor(options = {}) {
    this.execFile = options.execFile || execFileAsync;
    this.queues = new Map();
    this.operations = new Map();
    this.leases = new Map();
    this.maxOperationHistory = options.maxOperationHistory || 500;
  }

  _queue(repoKey) {
    let queue = this.queues.get(repoKey);
    if (!queue) {
      queue = { tail: Promise.resolve(), depth: 0, running: null };
      this.queues.set(repoKey, queue);
    }
    return queue;
  }

  _trimHistory() {
    if (this.operations.size <= this.maxOperationHistory) return;
    for (const [id, op] of this.operations) {
      if (op.status === 'queued' || op.status === 'running') continue;
      this.operations.delete(id);
      if (this.operations.size <= this.maxOperationHistory) break;
    }
  }

  status(id) {
    const op = this.operations.get(id);
    return op ? { ...op, progress: [...op.progress] } : null;
  }

  queueDepth(input) {
    if (input) return this._queue(repoKeyFor(input)).depth;
    let total = 0;
    for (const queue of this.queues.values()) total += queue.depth;
    return total;
  }

  isLeased(sessionId) {
    return sessionId ? this.leases.get(sessionId) || null : null;
  }

  async run(input, kind, task, options = {}) {
    const repoKey = options.repoKey || repoKeyFor(input);
    const queue = this._queue(repoKey);
    const id = options.operationId || operationId(kind || 'repo');
    const queuedDepth = queue.depth + 1;
    const op = {
      operationId: id,
      kind: kind || 'git',
      repoKey,
      sessionId: options.sessionId || null,
      status: 'queued',
      queueDepth: queuedDepth,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      progress: [],
    };
    this.operations.set(id, op);
    this._trimHistory();
    queue.depth += 1;

    const execute = async () => {
      if (op.sessionId) {
        const held = this.leases.get(op.sessionId);
        if (held) {
          const error = new Error(`session/worktree is leased by ${held.operationId}`);
          error.code = 'SESSION_LEASED';
          throw error;
        }
        if (options.activeCheck && await options.activeCheck()) {
          const error = new Error('session/worktree is active');
          error.code = 'SESSION_ACTIVE';
          throw error;
        }
        this.leases.set(op.sessionId, { operationId: id, kind: op.kind, acquiredAt: Date.now() });
      }
      op.status = 'running';
      op.startedAt = Date.now();
      op.queueDepth = queue.depth;
      queue.running = id;
      const progress = (phase, detail = null) => {
        const event = { phase, detail, ts: Date.now(), queueDepth: queue.depth };
        op.progress.push(event);
        if (op.progress.length > 100) op.progress.shift();
        if (typeof options.onProgress === 'function') options.onProgress({ operationId: id, ...event });
      };
      const execGit = async (cwd, args, execOptions = {}) => {
        progress('git', { cwd, args: [...args] });
        try {
          const result = await this.execFile('git', args, {
            cwd,
            encoding: 'utf8',
            timeout: execOptions.timeout || DEFAULT_TIMEOUT_MS,
            maxBuffer: execOptions.maxBuffer || DEFAULT_MAX_BUFFER,
            killSignal: 'SIGKILL',
            env: { ...NONINTERACTIVE_ENV, ...(execOptions.env || {}) },
          });
          return String(result.stdout || '').trim();
        } catch (error) {
          if (error && error.stderr != null) error.stderr = String(error.stderr);
          throw error;
        }
      };
      progress('started');
      try {
        const value = await task({ operationId: id, repoKey, progress, execGit, queueDepth: () => queue.depth });
        op.status = 'completed';
        progress('completed');
        return value && typeof value === 'object'
          ? { ...value, operationId: id, queueDepth: queuedDepth }
          : { ok: true, value, operationId: id, queueDepth: queuedDepth };
      } catch (error) {
        op.status = 'failed';
        op.error = error && error.message ? error.message : String(error);
        progress('failed', { error: op.error });
        error.operationId = id;
        error.queueDepth = queuedDepth;
        throw error;
      } finally {
        op.finishedAt = Date.now();
        queue.running = null;
        if (op.sessionId) this.leases.delete(op.sessionId);
      }
    };

    const result = queue.tail.then(execute, execute);
    queue.tail = result.then(() => undefined, () => undefined).finally(() => {
      queue.depth -= 1;
      if (queue.depth === 0 && !queue.running) this.queues.delete(repoKey);
    });
    return result;
  }

  runGit(cwd, args, options = {}) {
    return this.run(cwd, options.kind || 'git', async ({ execGit }) => ({
      ok: true,
      stdout: await execGit(cwd, args, options),
    }), options).then(result => options.withMetadata ? result : result.stdout);
  }
}

const defaultRepoActor = new RepoActor();

module.exports = {
  RepoActor,
  defaultRepoActor,
  repoKeyFor,
  operationId,
  NONINTERACTIVE_ENV,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BUFFER,
};
