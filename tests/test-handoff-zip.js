'use strict';

// Unit + differential tests for the Rust ZIP container (former
// src/session/handoff-zip.js) behind session handoff bundle v3 and plugin
// package unpacking. Everything is in-memory; no filesystem, no network.

const test = require('node:test');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { getNative } = require('../src/native/runtime');
const legacy = require('./helpers/legacy-handoff-zip');

const api = () => getNative().handoffZipApi();
const createZip = (entries, opts) => api().createZip(entries, opts);
const readZip = (buf, opts) => api().readZip(buf, opts);
const looksLikeZip = buf => api().looksLikeZip(buf);
const crc32 = buf => api().crc32(buf);

test('createZip/readZip round-trips text, binary, unicode names and empty files', () => {
  const entries = [
    { name: 'manifest.json', data: JSON.stringify({ hello: '世界' }) },
    { name: 'skills/团队-skill/SKILL.md', data: '---\nname: team\n---\nbody' },
    { name: 'assets/shot.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x00, 0x0d]) },
    { name: 'empty.txt', data: '' },
  ];
  const zip = createZip(entries);
  assert.ok(looksLikeZip(zip));
  assert.ok(!looksLikeZip(Buffer.from('not a zip at all........')));
  const back = readZip(zip);
  assert.equal(back.length, entries.length);
  const byName = Object.fromEntries(back.map(e => [e.name, e.data]));
  assert.equal(byName['manifest.json'].toString('utf8'), JSON.stringify({ hello: '世界' }));
  assert.equal(byName['skills/团队-skill/SKILL.md'].toString('utf8'), '---\nname: team\n---\nbody');
  assert.deepEqual(byName['assets/shot.png'], Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x00, 0x0d]));
  assert.equal(byName['empty.txt'].length, 0);
});

test('createZip compresses compressible data and stores incompressible data', () => {
  const text = ('lorem ipsum dolor sit amet ').repeat(500);
  const zip = createZip([{ name: 'big.txt', data: text }]);
  assert.ok(zip.length < text.length, 'deflate should shrink repeated text');
  const pngLike = crypto.randomBytes(4096); // truly incompressible
  const zip2 = createZip([{ name: 'noise.bin', data: pngLike }]);
  assert.ok(zip2.length >= pngLike.length, 'incompressible data is stored, not inflated');
  assert.equal(readZip(zip2)[0].data.length, pngLike.length);
});

test('readZip rejects tampered payloads (CRC), truncation and non-zip input', () => {
  const zip = createZip([{ name: 'a.txt', data: 'abcdef' }]);
  // Corrupt one byte inside the compressed payload region (after the 30-byte
  // header + 5-byte name).
  const tampered = Buffer.from(zip);
  tampered[40] ^= 0xff;
  assert.throws(() => readZip(tampered), /CRC mismatch|inflate failed|size mismatch/);
  assert.throws(() => readZip(zip.slice(0, zip.length - 10)), /not a zip|truncated|not found/);
  assert.throws(() => readZip(Buffer.from('garbage'.padEnd(64, '!'))), /not a zip/);
  assert.throws(() => readZip(Buffer.alloc(10)), /too short/);
});

test('createZip rejects unsafe names and duplicates; readZip rejects traversal entries', () => {
  assert.throws(() => createZip([{ name: '../evil.txt', data: 'x' }]), /traversal/);
  assert.throws(() => createZip([{ name: '/abs.txt', data: 'x' }]), /absolute/);
  assert.throws(() => createZip([{ name: 'a\\b.txt', data: 'x' }]), /unsafe/);
  assert.throws(() => createZip([{ name: 'x'.repeat(300), data: 'x' }]), /too long/);
  assert.throws(() => createZip([
    { name: 'dup.txt', data: '1' }, { name: 'dup.txt', data: '2' }]), /duplicate/);
  assert.throws(() => createZip([]), /non-empty/);

  // Hand-built archive with a traversal name must be refused on read even
  // though the writer would never emit one.
  const evil = createZip([{ name: 'ok.txt', data: 'fine' }]);
  const evilName = Buffer.from('../escape.txt');
  const payload = Buffer.from('nope');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8); // store
  local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(crc32(payload), 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(evilName.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14);
  cd.writeUInt32LE(crc32(payload), 16);
  cd.writeUInt32LE(payload.length, 20);
  cd.writeUInt32LE(payload.length, 24);
  cd.writeUInt16LE(evilName.length, 28);
  cd.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + evilName.length, 12);
  eocd.writeUInt32LE(30 + evilName.length + payload.length, 16);
  const archive = Buffer.concat([local, evilName, payload, cd, evilName, eocd]);
  assert.ok(looksLikeZip(archive));
  assert.throws(() => readZip(archive), /traversal/);
  assert.equal(readZip(evil).length, 1);
});

test('entry count and total size caps are enforced on read and write', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ name: `f${i}.txt`, data: 'x'.repeat(100) }));
  const zip = createZip(many);
  assert.throws(() => readZip(zip, { maxEntries: 4 }), /too many zip entries/);
  assert.throws(() => createZip(many, { maxEntries: 4 }), /too many zip entries/);
  const big = [{ name: 'big.bin', data: Buffer.alloc(64 * 1024, 1) }];
  const zipBig = createZip(big, { maxTotalBytes: 1024 * 1024 });
  assert.throws(() => readZip(zipBig, { maxTotalBytes: 16 * 1024 }), /total uncompressed/);
  assert.throws(() => createZip(big, { maxTotalBytes: 16 * 1024 }), /total uncompressed/);
});

test('zip is deflated with raw streams so standard tools agree on the bytes', () => {
  const data = Buffer.from('zip-compatible payload '.repeat(64), 'utf8');
  const zip = createZip([{ name: 'z.txt', data }]);
  // Locate the deflated bytes (30-byte local header + 5-byte name) and confirm
  // they are a raw deflate stream — i.e. what unzip/other tools expect.
  const start = 30 + 5;
  const compSize = zip.readUInt32LE(18);
  const method = zip.readUInt16LE(8);
  assert.equal(method, 8);
  const inflated = zlib.inflateRawSync(zip.slice(start, start + compSize));
  assert.equal(inflated.toString('utf8'), data.toString('utf8'));
});

test('Rust handoffZip matches frozen legacy Node oracle across formats, modes and errors', () => {
  assert.equal(
    fs.existsSync(path.join(__dirname, '..', 'src', 'session', 'handoff-zip.js')),
    false,
    'retired Node module must not exist under src/',
  );

  // CRC32 differential across empty, ASCII, UTF-8, and random binary inputs
  for (const sample of [
    Buffer.alloc(0),
    Buffer.from('123456789'),
    Buffer.from('你好，世界'),
    Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01, 0xfe]),
    crypto.randomBytes(1024),
  ]) {
    assert.equal(crc32(sample), legacy.crc32(sample));
    assert.equal(getNative().handoffZipCrc32(sample), legacy.crc32(sample));
  }

  // Bidirectional interop: Rust writer ↔ legacy reader, legacy writer ↔ Rust reader
  const corpus = [
    { name: 'dir/', data: '' },
    { name: 'dir/plugin.json', data: '{"id":"demo"}', mode: 0o100644 },
    { name: 'dir/bin/run', data: '#!/bin/sh\necho hi\n', mode: 0o100755 },
    { name: 'dir/no-mode.txt', data: 'plain text '.repeat(80) },
    { name: 'dir/non-int-mode.txt', data: 'float', mode: 12.5 },
    { name: 'dir/str-coerce.txt', data: 12345 },
    { name: 'dir/raw.bin', data: crypto.randomBytes(512) },
  ];

  const rustZip = createZip(corpus);
  const legacyZip = legacy.createZip(corpus);
  assert.equal(looksLikeZip(rustZip), legacy.looksLikeZip(rustZip));
  assert.equal(looksLikeZip(legacyZip), legacy.looksLikeZip(legacyZip));
  for (const nonZip of [null, undefined, '', 'PK\x03\x04', 123, {}, Buffer.from('PK\x03')]) {
    assert.equal(looksLikeZip(nonZip), legacy.looksLikeZip(nonZip));
  }

  const fromRustByLegacy = legacy.readZip(rustZip);
  const fromRustByRust = readZip(rustZip);
  const fromLegacyByRust = readZip(legacyZip);
  const fromLegacyByLegacy = legacy.readZip(legacyZip);

  assert.deepEqual(fromRustByRust, fromRustByLegacy);
  assert.deepEqual(fromLegacyByRust, fromLegacyByLegacy);
  assert.deepEqual(fromRustByRust, fromLegacyByLegacy);

  // Error parity for unsafe names, control chars, drive letters, Zip64, bad dir, non-buffer
  const badNames = [
    '',
    '../escape',
    'a/../b',
    '/root',
    'C:drive.txt',
    'z:drive.txt',
    'a\\b',
    'a\0b',
    'a\x01b',
    'a\x1fb',
    'a\x7fb',
    'a'.repeat(241),
  ];
  for (const bad of badNames) {
    let legacyErr;
    let rustErr;
    try { legacy.createZip([{ name: bad, data: 'x' }]); } catch (e) { legacyErr = e.message; }
    try { createZip([{ name: bad, data: 'x' }]); } catch (e) { rustErr = e.message; }
    assert.ok(legacyErr, `legacy should reject ${JSON.stringify(bad)}`);
    assert.equal(rustErr, legacyErr, `error message parity for ${JSON.stringify(bad)}`);
  }

  // Non-empty directory entry rejected identically
  const badDirZip = legacy.createZip([{ name: 'dir/', data: 'non-empty' }]);
  let legacyDirErr;
  let rustDirErr;
  try { legacy.readZip(badDirZip); } catch (e) { legacyDirErr = e.message; }
  try { readZip(badDirZip); } catch (e) { rustDirErr = e.message; }
  assert.equal(rustDirErr, legacyDirErr);

  // Zip64 sentinel rejected identically
  const zip64 = Buffer.from(legacyZip);
  zip64.writeUInt16LE(0xffff, zip64.length - 12);
  assert.throws(() => readZip(zip64), /zip64/);
  assert.throws(() => legacy.readZip(zip64), /zip64/);

  // Non-buffer input to readZip
  for (const badBuf of [null, undefined, 'not-a-buffer', 42]) {
    assert.throws(() => readZip(badBuf), /too short/);
    assert.throws(() => legacy.readZip(badBuf), /too short/);
  }
});

test('createHandoffZipService merges default and per-call options identically', () => {
  const rustSvc = api().createHandoffZipService({ maxEntries: 2, maxTotalBytes: 20 });
  const legacySvc = legacy.createHandoffZipService({ maxEntries: 2, maxTotalBytes: 20 });

  const twoSmall = [{ name: 'a.txt', data: '12345' }, { name: 'b.txt', data: '67890' }];
  const threeSmall = [...twoSmall, { name: 'c.txt', data: '1' }];
  const twoBig = [{ name: 'a.txt', data: 'x'.repeat(25) }];

  const z = rustSvc.createZip(twoSmall);
  assert.equal(rustSvc.looksLikeZip(z), true);
  assert.deepEqual(rustSvc.readZip(z), legacySvc.readZip(z));

  assert.throws(() => rustSvc.createZip(threeSmall), /too many zip entries \(3 > 2\)/);
  assert.throws(() => legacySvc.createZip(threeSmall), /too many zip entries \(3 > 2\)/);
  assert.throws(() => rustSvc.createZip(twoBig), /total uncompressed/);
  assert.throws(() => legacySvc.createZip(twoBig), /total uncompressed/);

  // Per-call override raises cap
  const z3 = rustSvc.createZip(threeSmall, { maxEntries: 5 });
  assert.throws(() => rustSvc.readZip(z3), /too many zip entries \(3 > 2\)/);
  assert.equal(rustSvc.readZip(z3, { maxEntries: 5 }).length, 3);
  assert.equal(legacySvc.readZip(z3, { maxEntries: 5 }).length, 3);
});
