'use strict';

// Unit tests for src/session/handoff-zip.js — the zip container behind session
// handoff bundle v3. Everything is in-memory; no filesystem, no network.

const test = require('node:test');
const assert = require('assert');
const crypto = require('crypto');
const zlib = require('zlib');
const { createZip, readZip, looksLikeZip, crc32 } = require('../src/session/handoff-zip');

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
