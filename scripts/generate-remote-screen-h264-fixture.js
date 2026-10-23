'use strict';

// Regenerate tests/fixtures/remote-screen-h264/{agent-stream.bin,manifest.json}.
//
//   node scripts/generate-remote-screen-h264-fixture.js [--out <dir>]
//
// The fixture is the byte stream the macOS Agent writes to h264.sock for a
// known 12-frame quadrant scene. It is produced by the Agent's REAL encoder
// code: `H264Screen.makeSession` and `H264Screen.emit` are extracted verbatim
// from scripts/macos-agent/MultiCCAgentH264.swift and hosted in a stub class,
// so the session properties, AVCC→Annex B conversion, pts header and config
// JSON are the production ones. The bytes feed the server relay tests and the
// iOS/Flutter decoder tests without needing a Mac with screen-recording rights.
//
// macOS + Xcode command line tools only (xcrun swiftc + VideoToolbox). The bin
// is committed, so Linux CI never runs this; it only parses the fixture.
//
// Exports generate({ outDir }) -> manifest for tests/test-remote-screen-h264-fixture.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const H264_SOURCE = path.join(ROOT, 'scripts', 'macos-agent', 'MultiCCAgentH264.swift');
const AGENT_SOURCE = path.join(ROOT, 'scripts', 'macos-agent', 'MultiCCAgent.swift');
const DEFAULT_OUT = path.join(ROOT, 'tests', 'fixtures', 'remote-screen-h264');

const WIDTH = 1470;
const HEIGHT = 956;
const SPLIT = { x: 735, y: 478 };
const FRAME_COUNT = 12;
const FRAME_INTERVAL_US = 33333;
const SCENE_B_FROM = 6;

const START_CODE = Buffer.from([0, 0, 0, 1]);

// Scene A: red / green / blue / white quadrants (top-left red).
// Scene B: identical except the top-left quadrant turns yellow.
const COLOURS = {
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  white: [255, 255, 255],
  yellow: [255, 255, 0],
};

function probes(scene) {
  const topLeft = scene === 'A' ? COLOURS.red : COLOURS.yellow;
  return [
    { name: 'top-left', x: 0.25, y: 0.25, rgb: topLeft, tol: 48 },
    { name: 'top-right', x: 0.75, y: 0.25, rgb: COLOURS.green, tol: 48 },
    { name: 'bottom-left', x: 0.25, y: 0.75, rgb: COLOURS.blue, tol: 48 },
    { name: 'bottom-right', x: 0.75, y: 0.75, rgb: COLOURS.white, tol: 48 },
    // Corner stride detectors: a row-stride bug shears the bottom rows, so the
    // bottom corners are where that shows first.
    { name: 'corner-top-left', x: 0.03, y: 0.03, rgb: topLeft, tol: 48 },
    { name: 'corner-top-right', x: 0.97, y: 0.03, rgb: COLOURS.green, tol: 48 },
    { name: 'corner-bottom-left', x: 0.03, y: 0.97, rgb: COLOURS.blue, tol: 48 },
    { name: 'corner-bottom-right', x: 0.97, y: 0.97, rgb: COLOURS.white, tol: 48 },
  ];
}

// Same brace walker tests/test-macos-agent.js uses: slice one Swift func out
// of a source file including its body.
function extractFunc(source, name) {
  const start = source.indexOf(`func ${name}(`);
  if (start < 0) throw new Error(`func ${name} not found`);
  let end = source.indexOf('{', start);
  let depth = 1;
  while (depth && ++end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  if (depth !== 0) throw new Error(`unbalanced braces in func ${name}`);
  return source.slice(start, end + 1);
}

function buildSwift() {
  const h264 = fs.readFileSync(H264_SOURCE, 'utf8');
  const agent = fs.readFileSync(AGENT_SOURCE, 'utf8');

  const consts = h264.match(/^let H264_(CONFIG|KEY|DELTA|REQ_KEY): UInt8 = .*$/gm);
  if (!consts || consts.length !== 4) throw new Error('H264_* type constants not found in MultiCCAgentH264.swift');

  const extStart = agent.indexOf('extension Data {');
  const extEnd = agent.indexOf('func readFully(', extStart);
  if (extStart < 0 || extEnd < 0) throw new Error('Data.appendBE extension not found in MultiCCAgent.swift');
  const appendBE = agent.slice(extStart, extEnd);

  const message = extractFunc(h264, 'h264Message');
  const makeSession = extractFunc(h264, 'makeSession');
  const emit = extractFunc(h264, 'emit');

  return String.raw`import Foundation
import CoreMedia
import CoreVideo
import Darwin
import VideoToolbox

${consts.join('\n')}

${appendBE}

${message}

// --- harness ---------------------------------------------------------------
// Stubs replace the socket client and the capture side. makeSession and emit
// below are the Agent's own code, extracted verbatim (only the leading
// private access modifier is gone because extraction starts at the signature).
final class H264Client {
  var out = Data()
  func send(_ msg: Data, kind: UInt8) -> Bool { out.append(msg); return true }
}

final class FixtureEncoder {
  let lock = NSLock()
  var session: VTCompressionSession?
  var clients: [H264Client] = []
  var config: Data?
  func requestKey() {}

  ${makeSession}

  ${emit}
}

// --- scene ----------------------------------------------------------------
let W = ${WIDTH}
let H = ${HEIGHT}
let SPLIT_X = ${SPLIT.x}
let SPLIT_Y = ${SPLIT.y}
let FRAMES = ${FRAME_COUNT}
let SCENE_B_FROM = ${SCENE_B_FROM}
let FRAME_INTERVAL_US = ${FRAME_INTERVAL_US}

func quadrantRGB(_ x: Int, _ y: Int, _ scene: Int) -> (Int, Int, Int) {
  let left = x < SPLIT_X
  let top = y < SPLIT_Y
  if top && left { return scene == 0 ? (255, 0, 0) : (255, 255, 0) }
  if top { return (0, 255, 0) }
  if left { return (0, 0, 255) }
  return (255, 255, 255)
}

// BT.709 video range (limited) Y'CbCr, the matrix ScreenCaptureKit uses and
// the pixel format the Agent configures.
func toVideoRange(_ r: Int, _ g: Int, _ b: Int) -> (Int, Int, Int) {
  let rf = Double(r) / 255.0
  let gf = Double(g) / 255.0
  let bf = Double(b) / 255.0
  let luma = 0.2126 * rf + 0.7152 * gf + 0.0722 * bf
  func clamp(_ v: Double) -> Int {
    let n = Int(v.rounded())
    return n < 0 ? 0 : (n > 255 ? 255 : n)
  }
  return (
    clamp(16.0 + 219.0 * luma),
    clamp(128.0 + 224.0 * (bf - luma) / 1.8556),
    clamp(128.0 + 224.0 * (rf - luma) / 1.5748)
  )
}

func fill(_ pb: CVPixelBuffer, _ scene: Int) {
  let w = CVPixelBufferGetWidth(pb)
  let h = CVPixelBufferGetHeight(pb)
  CVPixelBufferLockBaseAddress(pb, [])
  defer { CVPixelBufferUnlockBaseAddress(pb, []) }

  let yBase = CVPixelBufferGetBaseAddressOfPlane(pb, 0)!.assumingMemoryBound(to: UInt8.self)
  let yStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
  for y in 0..<h {
    let row = yBase + y * yStride
    for x in 0..<w {
      let (r, g, b) = quadrantRGB(x, y, scene)
      row[x] = UInt8(toVideoRange(r, g, b).0)
    }
  }

  // NV12 chroma is half resolution; sample the top-left pixel of each 2x2
  // block (735 is odd, so the split stays on chroma sample 367 and the seam
  // is one pixel soft — irrelevant to the quadrant-centre probes).
  let cBase = CVPixelBufferGetBaseAddressOfPlane(pb, 1)!.assumingMemoryBound(to: UInt8.self)
  let cStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 1)
  let cw = (w + 1) / 2
  let ch = (h + 1) / 2
  for cy in 0..<ch {
    let row = cBase + cy * cStride
    for cx in 0..<cw {
      let (r, g, b) = quadrantRGB(cx * 2, cy * 2, scene)
      let (_, cb, cr) = toVideoRange(r, g, b)
      row[cx * 2] = UInt8(cb)
      row[cx * 2 + 1] = UInt8(cr)
    }
  }
}

func makePixelBuffer(_ w: Int, _ h: Int, scene: Int) -> CVPixelBuffer? {
  var attrs: [CFString: Any] = [:]
  attrs[kCVPixelBufferIOSurfacePropertiesKey] = [String: Any]() as CFDictionary
  var pb: CVPixelBuffer?
  guard CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                            attrs as CFDictionary, &pb) == kCVReturnSuccess, let pb else { return nil }
  CVBufferSetAttachment(pb, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
  CVBufferSetAttachment(pb, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
  CVBufferSetAttachment(pb, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
  fill(pb, scene)
  return pb
}

// --- driver ---------------------------------------------------------------
guard CommandLine.arguments.count > 1 else {
  FileHandle.standardError.write(Data("usage: encoder <out.bin>\n".utf8))
  exit(2)
}
let outPath = CommandLine.arguments[1]

let encoder = FixtureEncoder()
guard let vt = encoder.makeSession(W, H) else {
  FileHandle.standardError.write(Data("makeSession failed\n".utf8))
  exit(1)
}
encoder.session = vt
let client = H264Client()
encoder.clients = [client]

// Keep every pixel buffer alive until the session is drained: VideoToolbox may
// still reference them.
var keepAlive: [CVPixelBuffer] = []
keepAlive.reserveCapacity(FRAMES)

for index in 0..<FRAMES {
  let scene = index < SCENE_B_FROM ? 0 : 1
  guard let pb = makePixelBuffer(W, H, scene: scene) else {
    FileHandle.standardError.write(Data("pixel buffer \(index) failed\n".utf8))
    exit(1)
  }
  keepAlive.append(pb)
  let pts = CMTime(value: CMTimeValue(index * FRAME_INTERVAL_US), timescale: 1_000_000)
  let props: CFDictionary? = index == 0
    ? ([kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary)
    : nil
  let status = VTCompressionSessionEncodeFrame(vt, imageBuffer: pb, presentationTimeStamp: pts,
                                               duration: .invalid, frameProperties: props,
                                               infoFlagsOut: nil) { status, _, sb in
    guard status == noErr, let sb else { return }
    encoder.emit(sb)
  }
  guard status == noErr else {
    FileHandle.standardError.write(Data("encode \(index) failed: \(status)\n".utf8))
    exit(1)
  }
  // Drain after every frame so the output order (and Message numbering) is
  // deterministic.
  VTCompressionSessionCompleteFrames(vt, untilPresentationTimeStamp: .invalid)
}

guard !client.out.isEmpty else {
  FileHandle.standardError.write(Data("encoder produced no output\n".utf8))
  exit(1)
}
do {
  try client.out.write(to: URL(fileURLWithPath: outPath))
} catch {
  FileHandle.standardError.write(Data("write failed: \(error)\n".utf8))
  exit(1)
}
`;
}

// [type u8][len u32 BE][payload]
function parseMessages(stream) {
  const messages = [];
  let offset = 0;
  while (offset < stream.length) {
    if (offset + 5 > stream.length) throw new Error(`truncated message header at ${offset}`);
    const type = stream[offset];
    const payloadLength = stream.readUInt32BE(offset + 1);
    const length = 5 + payloadLength;
    if (offset + length > stream.length) throw new Error(`truncated message body at ${offset}`);
    const raw = stream.subarray(offset, offset + length);
    const payload = stream.subarray(offset + 5, offset + length);
    messages.push({
      type,
      offset,
      length,
      raw,
      payload,
      pts: type === 1 ? null : Number(payload.readBigUInt64BE(0)),
      annexB: type === 1 ? null : payload.subarray(8),
    });
    offset += length;
  }
  return messages;
}

function splitAnnexB(annexB) {
  const nals = [];
  let off = 0;
  while (off < annexB.length) {
    if (annexB.indexOf(START_CODE, off) !== off) throw new Error(`expected 4-byte start code at ${off}`);
    const start = off + 4;
    let next = annexB.indexOf(START_CODE, start);
    if (next < 0) next = annexB.length;
    if (next === start) throw new Error(`empty NAL unit at ${off}`);
    nals.push(annexB.subarray(start, next));
    off = next;
  }
  return nals;
}

const sceneOfPts = pts => (pts < SCENE_B_FROM * FRAME_INTERVAL_US ? 'A' : 'B');

function buildManifest(stream) {
  const messages = parseMessages(stream);
  if (messages.length === 0) throw new Error('encoder produced no messages');

  const configMessage = messages[0];
  if (configMessage.type !== 1) throw new Error(`first message is type ${configMessage.type}, expected config (1)`);
  const config = JSON.parse(configMessage.payload.toString('utf8'));
  if (config.width !== WIDTH || config.height !== HEIGHT) {
    throw new Error(`config is ${config.width}x${config.height}, expected ${WIDTH}x${HEIGHT}`);
  }

  const keyMessage = messages.find(m => m.type === 2);
  if (!keyMessage) throw new Error('no key frame in the stream');
  const keyNals = splitAnnexB(keyMessage.annexB);
  const types = keyNals.map(n => n[0] & 0x1f);
  if (types[0] !== 7 || types[1] !== 8 || types[2] !== 5) {
    throw new Error(`key frame NAL types are ${types.join(',')}, expected SPS/PPS/IDR first`);
  }
  const sps = keyNals[0];
  if (sps.length < 4) throw new Error('SPS too short to build a codec string');
  const codec = 'avc1.' + [1, 2, 3]
    .map(i => sps[i].toString(16).padStart(2, '0').toUpperCase())
    .join('');
  if (config.codec !== codec) {
    throw new Error(`config codec ${config.codec} does not match SPS profile bytes ${codec}`);
  }

  for (const m of messages) {
    if (m.type === 1) continue;
    if (m.type !== 2 && m.type !== 3) throw new Error(`unexpected message type ${m.type} at ${m.offset}`);
    const nalTypes = splitAnnexB(m.annexB).map(n => n[0] & 0x1f);
    if (m.type === 3 && (nalTypes.includes(5) || !nalTypes.includes(1))) {
      throw new Error(`delta frame at ${m.offset} has NAL types ${nalTypes.join(',')}: expected type 1 slices, no IDR`);
    }
  }

  const frames = messages.map((m, index) => ({
    index,
    type: m.type,
    offset: m.offset,
    length: m.length,
    sha256: crypto.createHash('sha256').update(m.raw).digest('hex'),
    pts: m.pts,
    scene: m.pts === null ? null : sceneOfPts(m.pts),
  }));

  const countA = frames.filter(f => f.scene === 'A').length;
  const countB = frames.filter(f => f.scene === 'B').length;
  if (countA < 4 || countB < 4) {
    throw new Error(`encoder emitted ${countA} scene-A and ${countB} scene-B frames; need at least 4 of each`);
  }

  return {
    description:
      'Agent-to-server h264.sock bytes for a 1470x956 quadrant scene, encoded by the real '
      + 'VideoToolbox code (H264Screen.makeSession + emit): scene A frames 0-5 '
      + '(red/green/blue/white), scene B frames 6-11 (top-left turns yellow). '
      + 'Each frame entry spans one complete [type u8][len u32 BE][payload] message.',
    generator: 'scripts/generate-remote-screen-h264-fixture.js',
    encoder: 'scripts/macos-agent/MultiCCAgentH264.swift H264Screen.makeSession + emit (verbatim)',
    consumers: [
      'tests/test-remote-screen-h264-fixture.js',
      'tests/helpers/remote-screen-e2e-harness.js',
      'app/test/remote_screen_e2e_test.dart',
      'app/integration_test/h264_decoder_test.dart',
    ],
    width: WIDTH,
    height: HEIGHT,
    codec: config.codec,
    split: { x: SPLIT.x, y: SPLIT.y },
    frames,
    probes: { A: probes('A'), B: probes('B') },
  };
}

function generate({ outDir = DEFAULT_OUT } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('remote-screen H.264 fixture generation needs macOS (VideoToolbox)');
  }
  try {
    execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' });
  } catch {
    throw new Error('xcrun --find swiftc failed: install the Xcode command line tools');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-h264-fixture-'));
  try {
    const swiftFile = path.join(tmp, 'main.swift');
    fs.writeFileSync(swiftFile, buildSwift());
    const binary = path.join(tmp, 'encode');
    execFileSync('xcrun', ['swiftc', swiftFile, '-O', '-o', binary], { timeout: 120000 });
    const streamFile = path.join(tmp, 'agent-stream.bin');
    execFileSync(binary, [streamFile], { timeout: 120000 });

    const stream = fs.readFileSync(streamFile);
    const manifest = buildManifest(stream);

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'agent-stream.bin'), stream);
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main(argv) {
  let outDir = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      if (!argv[i + 1]) throw new Error('--out needs a directory');
      outDir = path.resolve(argv[++i]);
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  const manifest = generate({ outDir });
  const size = fs.statSync(path.join(outDir, 'agent-stream.bin')).size;
  const count = scene => manifest.frames.filter(f => f.scene === scene).length;
  console.log(`wrote ${path.join(outDir, 'agent-stream.bin')} (${size} bytes, codec ${manifest.codec})`);
  console.log(`wrote ${path.join(outDir, 'manifest.json')} (${manifest.frames.length} messages, `
    + `${count('A')} scene-A / ${count('B')} scene-B frames)`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`generate-remote-screen-h264-fixture: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { generate, DEFAULT_OUT, WIDTH, HEIGHT, SPLIT, FRAME_COUNT, FRAME_INTERVAL_US };
