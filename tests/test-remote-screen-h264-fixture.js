'use strict';

// Committed H.264 fixture: tests/fixtures/remote-screen-h264/agent-stream.bin is
// the exact byte stream the macOS Agent writes to h264.sock (one
// [type u8][len u32 BE][payload] message per frame), produced by the REAL
// VideoToolbox code H264Screen.makeSession + emit. It carries a 12-frame
// quadrant scene: A (frames 0-5: red/green/blue/white) then B (6-11: the
// top-left quadrant turns yellow).
//
// It is replayed through the real server by tests/helpers/remote-screen-e2e-harness.js
// and decoded on an iOS simulator by app/test/remote_screen_e2e_test.dart and
// app/integration_test/h264_decoder_test.dart, which check pixel colours.
// Regenerate with scripts/generate-remote-screen-h264-fixture.js.
//
// Test 1 is pure Node (runs on Linux CI). Test 2 proves the probe expectations
// with ffmpeg as an independent decoder. Test 3 re-runs the real encoder.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'remote-screen-h264');
const BIN_PATH = path.join(FIXTURE_DIR, 'agent-stream.bin');
const MANIFEST_PATH = path.join(FIXTURE_DIR, 'manifest.json');

const WIDTH = 1470;
const HEIGHT = 956;
const START_CODE = Buffer.from([0, 0, 0, 1]);
const FRAME_INTERVAL_US = 33333;
const SCENE_B_FROM = 6;
const FRAME_RGB_BYTES = WIDTH * HEIGHT * 3;

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const hasSwift = process.platform === 'darwin'
  && spawnSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }).status === 0;

// [type u8][len u32 BE][payload]
function parseMessages(buffer) {
  const messages = [];
  let offset = 0;
  while (offset < buffer.length) {
    assert.ok(offset + 5 <= buffer.length, `truncated message header at ${offset}`);
    const type = buffer[offset];
    const payloadLength = buffer.readUInt32BE(offset + 1);
    const length = 5 + payloadLength;
    assert.ok(offset + length <= buffer.length, `truncated message body at ${offset}`);
    messages.push({
      type,
      offset,
      length,
      raw: buffer.subarray(offset, offset + length),
      payload: buffer.subarray(offset + 5, offset + length),
    });
    offset += length;
  }
  return messages;
}

// The Agent always writes 4-byte start codes; a 3-byte one would mean the
// AVCC→Annex B conversion drifted.
function splitAnnexB(annexB) {
  const nals = [];
  let offset = 0;
  while (offset < annexB.length) {
    assert.equal(annexB.subarray(offset, offset + 4).toString('hex'), '00000001',
      `NAL ${nals.length} has no 4-byte start code at ${offset}`);
    const start = offset + 4;
    let next = annexB.indexOf(START_CODE, start);
    if (next < 0) next = annexB.length;
    nals.push(annexB.subarray(start, next));
    offset = next;
  }
  return nals;
}

const nalType = nal => nal[0] & 0x1f;
const ptsOf = message => Number(message.payload.readBigUInt64BE(0));
const codecFromSps = sps => 'avc1.' + [1, 2, 3]
  .map(i => sps[i].toString(16).padStart(2, '0').toUpperCase())
  .join('');

function decodeRgb(messages) {
  // Strip the 8-byte pts header from every video message and let ffmpeg parse
  // the concatenated Annex B stream (SPS/PPS ride on the key frame).
  const input = Buffer.concat(messages
    .filter(m => m.type === 2 || m.type === 3)
    .map(m => m.payload.subarray(8)));
  return execFileSync('ffmpeg',
    ['-loglevel', 'error', '-f', 'h264', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { input, maxBuffer: 256 * 1024 * 1024, timeout: 120000 });
}

function assertProbes(rgb, frameIndex, probes) {
  for (const probe of probes) {
    const x = Math.min(WIDTH - 1, Math.max(0, Math.floor(probe.x * WIDTH)));
    const y = Math.min(HEIGHT - 1, Math.max(0, Math.floor(probe.y * HEIGHT)));
    const offset = frameIndex * FRAME_RGB_BYTES + (y * WIDTH + x) * 3;
    const got = [rgb[offset], rgb[offset + 1], rgb[offset + 2]];
    const delta = Math.max(...got.map((v, i) => Math.abs(v - probe.rgb[i])));
    assert.ok(delta <= probe.tol,
      `probe ${probe.name} at frame ${frameIndex} decoded [${got}] expected [${probe.rgb}] (delta ${delta} > tol ${probe.tol})`);
  }
}

test('fixture: Agent wire framing, codec string and manifest match the committed bytes', () => {
  const bin = fs.readFileSync(BIN_PATH);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const messages = parseMessages(bin);
  assert.ok(messages.length >= 6, `expected at least config + key + 4 frames, got ${messages.length}`);

  // Message 0: config JSON.
  assert.equal(messages[0].type, 1);
  const config = JSON.parse(messages[0].payload.toString('utf8'));
  assert.equal(config.width, WIDTH);
  assert.equal(config.height, HEIGHT);
  assert.match(config.codec, /^avc1\.[0-9A-F]{6}$/);

  // Message 1: key frame = pts header + SPS, PPS, IDR.
  assert.equal(messages[1].type, 2);
  assert.ok(messages[1].payload.length > 8);
  const keyNals = splitAnnexB(messages[1].payload.subarray(8));
  assert.deepEqual(keyNals.map(nalType), [7, 8, 5]);
  assert.equal(config.codec, codecFromSps(keyNals[0]));

  // Everything after the key frame: delta messages with slices only.
  for (const message of messages.slice(2)) {
    assert.equal(message.type, 3);
    const types = splitAnnexB(message.payload.subarray(8)).map(nalType);
    assert.ok(types.includes(1), `delta at ${message.offset} has no type-1 slice: ${types.join(',')}`);
    assert.ok(!types.includes(5), `delta at ${message.offset} contains an IDR: ${types.join(',')}`);
  }

  // Manifest is a faithful index of the bin.
  assert.equal(manifest.width, config.width);
  assert.equal(manifest.height, config.height);
  assert.equal(manifest.codec, config.codec);
  assert.deepEqual(manifest.split, { x: 735, y: 478 });
  assert.equal(manifest.frames.length, messages.length);
  for (let i = 0; i < messages.length; i++) {
    const frame = manifest.frames[i];
    const message = messages[i];
    assert.equal(frame.index, i);
    assert.equal(frame.type, message.type);
    assert.equal(frame.offset, message.offset);
    assert.equal(frame.length, message.length);
    assert.equal(frame.sha256, crypto.createHash('sha256').update(message.raw).digest('hex'));
    if (message.type === 1) {
      assert.equal(frame.pts, null);
      assert.equal(frame.scene, null);
    } else {
      assert.equal(frame.pts, ptsOf(message));
      assert.equal(frame.scene, frame.pts < SCENE_B_FROM * FRAME_INTERVAL_US ? 'A' : 'B');
    }
  }

  const videoPts = messages.filter(m => m.type !== 1).map(ptsOf);
  for (let i = 1; i < videoPts.length; i++) {
    assert.ok(videoPts[i] > videoPts[i - 1], `pts not increasing at frame ${i}: ${videoPts[i - 1]} -> ${videoPts[i]}`);
  }
  const countA = manifest.frames.filter(f => f.scene === 'A').length;
  const countB = manifest.frames.filter(f => f.scene === 'B').length;
  assert.ok(countA >= 4, `only ${countA} scene-A frames`);
  assert.ok(countB >= 4, `only ${countB} scene-B frames`);
  assert.equal(countA + countB, videoPts.length);

  // Probes cover both scenes with the same names, so a decoded-frame check can
  // be applied at any resolution.
  assert.deepEqual(manifest.probes.A.map(p => p.name), manifest.probes.B.map(p => p.name));
  for (const probe of [...manifest.probes.A, ...manifest.probes.B]) {
    assert.ok(probe.x >= 0 && probe.x <= 1 && probe.y >= 0 && probe.y <= 1, `probe ${probe.name} is not a fraction`);
    assert.equal(probe.rgb.length, 3);
    assert.ok(probe.tol > 0);
  }
  assert.deepEqual(manifest.probes.A[0].rgb, [255, 0, 0]);
  assert.deepEqual(manifest.probes.B[0].rgb, [255, 255, 0]);
});

test('fixture: ffmpeg (independent decoder) sees the expected scene colours', { skip: !hasFfmpeg, timeout: 120000 }, () => {
  const messages = parseMessages(fs.readFileSync(BIN_PATH));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const videoFrames = messages.filter(m => m.type !== 1).length;

  const rgb = decodeRgb(messages);
  assert.equal(rgb.length, videoFrames * FRAME_RGB_BYTES,
    `decoder produced ${rgb.length} bytes for ${videoFrames} frames`);

  assertProbes(rgb, 0, manifest.probes.A);
  assertProbes(rgb, videoFrames - 1, manifest.probes.B);
});

test('generator: the real VideoToolbox code still yields the same fixture structure', { skip: !hasSwift, timeout: 180000 }, t => {
  const { generate } = require('../scripts/generate-remote-screen-h264-fixture');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-h264-fixture-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const generated = generate({ outDir });
  const generatedBin = fs.readFileSync(path.join(outDir, 'agent-stream.bin'));
  const generatedMessages = parseMessages(generatedBin);
  const committedMessages = parseMessages(fs.readFileSync(BIN_PATH));
  const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  // Hardware encoder bytes may differ across machines, so compare structure.
  assert.equal(generated.width, WIDTH);
  assert.equal(generated.height, HEIGHT);
  assert.match(generated.codec, /^avc1\.[0-9A-F]{6}$/);
  assert.deepEqual(generated.split, committed.split);

  const config = JSON.parse(generatedMessages[0].payload.toString('utf8'));
  assert.equal(generated.codec, config.codec);
  assert.equal(config.width, WIDTH);
  assert.equal(config.height, HEIGHT);
  assert.equal(generatedMessages[0].type, 1);
  assert.equal(generatedMessages[1].type, 2);
  const keyNals = splitAnnexB(generatedMessages[1].payload.subarray(8));
  assert.deepEqual(keyNals.slice(0, 3).map(nalType), [7, 8, 5]);
  assert.equal(config.codec, codecFromSps(keyNals[0]));

  assert.deepEqual(generatedMessages.map(m => m.type), committedMessages.map(m => m.type));
  assert.deepEqual(generated.frames.map(f => f.scene), committed.frames.map(f => f.scene));
  assert.ok(generated.frames.filter(f => f.scene === 'A').length >= 4);
  assert.ok(generated.frames.filter(f => f.scene === 'B').length >= 4);

  if (hasFfmpeg) {
    const videoFrames = generatedMessages.filter(m => m.type !== 1).length;
    const rgb = decodeRgb(generatedMessages);
    assert.equal(rgb.length, videoFrames * FRAME_RGB_BYTES);
    assertProbes(rgb, 0, generated.probes.A);
    assertProbes(rgb, videoFrames - 1, generated.probes.B);
  }
});
