'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const {
  UPLOAD_LIMITS,
  createUploadSuite,
  persistChatUpload,
} = require('../src/upload-middleware');

async function withServer(configure, run) {
  const app = express();
  configure(app);
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function formWith(files, fields = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  for (const file of files) form.append(file.field || 'file', new Blob([file.body], { type: file.type }), file.name);
  return form;
}

test('multer 2 upload policy accepts one compatible chat file and one audio file', async () => {
  const upload = createUploadSuite({ fileSize: 1024 });
  await withServer(app => {
    app.post('/chat', upload.chat, (req, res) => res.json({ name: req.file.originalname, size: req.file.size, type: req.file.mimetype }));
    app.post('/voice', upload.voice, (req, res) => res.json({ size: req.file.size, type: req.file.mimetype }));
  }, async base => {
    const chat = await fetch(`${base}/chat`, {
      method: 'POST', body: formWith([{ name: 'notes.txt', type: 'text/plain', body: 'hello' }]),
    });
    assert.equal(chat.status, 200);
    assert.deepEqual(await chat.json(), { name: 'notes.txt', size: 5, type: 'text/plain' });

    const voice = await fetch(`${base}/voice`, {
      method: 'POST', body: formWith([{ name: 'voice.wav', type: 'audio/wav', body: 'RIFF' }]),
    });
    assert.equal(voice.status, 200);
    assert.equal((await voice.json()).type, 'audio/wav');
  });
});

test('upload policy maps size, count, field and media errors without a generic 500', async () => {
  const upload = createUploadSuite({ fileSize: 8 });
  await withServer(app => {
    app.post('/chat', upload.chat, (req, res) => res.json({ ok: true }));
    app.post('/voice', upload.voice, (req, res) => res.json({ ok: true }));
  }, async base => {
    const cases = [
      {
        path: '/chat', status: 413, code: 'UPLOAD_FILE_TOO_LARGE',
        form: formWith([{ name: 'large.txt', type: 'text/plain', body: '123456789' }]),
      },
      {
        path: '/chat', status: 400, code: 'UPLOAD_TOO_MANY_PARTS',
        form: formWith([
          { name: 'a.txt', type: 'text/plain', body: 'a' },
          { name: 'b.txt', type: 'text/plain', body: 'b' },
        ]),
      },
      {
        path: '/chat', status: 400, code: 'UPLOAD_TOO_MANY_PARTS',
        form: formWith([{ name: 'a.txt', type: 'text/plain', body: 'a' }], { caption: 'not allowed' }),
      },
      {
        path: '/voice', status: 415, code: 'UPLOAD_UNSUPPORTED_MEDIA_TYPE',
        form: formWith([{ name: 'image.png', type: 'image/png', body: 'png' }]),
      },
      {
        path: '/chat', status: 415, code: 'UPLOAD_UNSUPPORTED_MEDIA_TYPE',
        form: formWith([{ name: 'binary.exe', type: 'application/x-msdownload', body: 'MZ' }]),
      },
    ];
    for (const item of cases) {
      const response = await fetch(`${base}${item.path}`, { method: 'POST', body: item.form });
      assert.equal(response.status, item.status);
      assert.equal((await response.json()).code, item.code);
    }
  });
});

test('shared admission gate rejects concurrent in-memory uploads with 429', async () => {
  const upload = createUploadSuite({ fileSize: 1024, maxActive: 1 });
  let enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  let releaseResolve;
  const release = new Promise(resolve => { releaseResolve = resolve; });
  await withServer(app => {
    app.post('/chat', upload.chat, async (req, res) => {
      enteredResolve();
      await release;
      res.json({ ok: true });
    });
  }, async base => {
    const first = fetch(`${base}/chat`, {
      method: 'POST', body: formWith([{ name: 'first.txt', type: 'text/plain', body: 'one' }]),
    });
    await entered;
    const second = await fetch(`${base}/chat`, {
      method: 'POST', body: formWith([{ name: 'second.txt', type: 'text/plain', body: 'two' }]),
    });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).code, 'UPLOAD_BUSY');
    releaseResolve();
    assert.equal((await first).status, 200);
  });
});

test('temporary chat storage is private and fails closed on count/byte quota', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-upload-policy-'));
  try {
    const first = persistChatUpload({ originalname: '..\\folder/unsafe.txt', buffer: Buffer.from('hello') }, {
      tmpDir: dir, maxFiles: 2, maxBytes: 8,
    });
    assert.equal(path.dirname(first.path), dir);
    assert.equal(first.name, 'unsafe.txt');
    if (process.platform !== 'win32') assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
    assert.throws(
      () => persistChatUpload({ originalname: 'second.txt', buffer: Buffer.from('more') }, {
        tmpDir: dir, maxFiles: 2, maxBytes: 8,
      }),
      error => error.code === 'UPLOAD_STORAGE_QUOTA_EXCEEDED' && error.status === 507,
    );
    assert.equal(UPLOAD_LIMITS.tempFiles, 200);
    assert.equal(UPLOAD_LIMITS.tempBytes, 512 * 1024 * 1024);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
