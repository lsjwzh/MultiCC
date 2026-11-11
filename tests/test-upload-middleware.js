'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const {
  UPLOAD_LIMITS,
  createUploadSuite,
  mapUploadError,
  voiceMimeAllowed,
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

test('multer 2 voice upload policy accepts one compatible audio file', async () => {
  const upload = createUploadSuite({ fileSize: 1024 });
  await withServer(app => {
    app.post('/voice', upload.voice, (req, res) => res.json({ name: req.file.originalname, size: req.file.size, type: req.file.mimetype }));
  }, async base => {
    const voice = await fetch(`${base}/voice`, {
      method: 'POST', body: formWith([{ name: 'voice.wav', type: 'audio/wav', body: 'RIFF' }]),
    });
    assert.equal(voice.status, 200);
    assert.deepEqual(await voice.json(), { name: 'voice.wav', size: 4, type: 'audio/wav' });
  });
});

test('voice upload policy maps size, count, field and media errors without a generic 500', async () => {
  const upload = createUploadSuite({ fileSize: 8 });
  await withServer(app => {
    app.post('/voice', upload.voice, (req, res) => res.json({ ok: true }));
  }, async base => {
    const cases = [
      {
        status: 413, code: 'UPLOAD_FILE_TOO_LARGE',
        form: formWith([{ name: 'large.wav', type: 'audio/wav', body: '123456789' }]),
      },
      {
        status: 400, code: 'UPLOAD_TOO_MANY_PARTS',
        form: formWith([
          { name: 'a.wav', type: 'audio/wav', body: 'a' },
          { name: 'b.wav', type: 'audio/wav', body: 'b' },
        ]),
      },
      {
        status: 400, code: 'UPLOAD_TOO_MANY_PARTS',
        form: formWith([{ name: 'a.wav', type: 'audio/wav', body: 'a' }], { caption: 'not allowed' }),
      },
      {
        status: 415, code: 'UPLOAD_UNSUPPORTED_MEDIA_TYPE',
        form: formWith([{ name: 'image.png', type: 'image/png', body: 'png' }]),
      },
      {
        status: 415, code: 'UPLOAD_UNSUPPORTED_MEDIA_TYPE',
        form: formWith([{ name: 'notes.txt', type: 'text/plain', body: 'hello' }]),
      },
    ];
    for (const item of cases) {
      const response = await fetch(`${base}/voice`, { method: 'POST', body: item.form });
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
    app.post('/voice', upload.voice, async (req, res) => {
      enteredResolve();
      await release;
      res.json({ ok: true });
    });
  }, async base => {
    const first = fetch(`${base}/voice`, {
      method: 'POST', body: formWith([{ name: 'first.wav', type: 'audio/wav', body: 'one' }]),
    });
    await entered;
    const second = await fetch(`${base}/voice`, {
      method: 'POST', body: formWith([{ name: 'second.wav', type: 'audio/wav', body: 'two' }]),
    });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).code, 'UPLOAD_BUSY');
    releaseResolve();
    assert.equal((await first).status, 200);
  });
});

test('voice mime allowlist and upload limits stay pinned', () => {
  for (const mime of ['audio/wav', 'audio/webm;codecs=opus', 'video/webm', 'application/ogg', 'AUDIO/MPEG']) {
    assert.equal(voiceMimeAllowed(mime), true, mime);
  }
  for (const mime of ['image/png', 'text/plain', 'video/mp4', 'application/pdf', '', undefined]) {
    assert.equal(voiceMimeAllowed(mime), false, String(mime));
  }
  assert.equal(mapUploadError(Object.assign(new Error('too large'), { code: 'LIMIT_FILE_SIZE' })).code, 'UPLOAD_FILE_TOO_LARGE');
  assert.equal(mapUploadError(new Error('boom')).code, 'UPLOAD_FAILED');
  assert.equal(UPLOAD_LIMITS.fileSize, 25 * 1024 * 1024);
  assert.equal(UPLOAD_LIMITS.files, 1);
  assert.equal(UPLOAD_LIMITS.maxActive, 4);
});
