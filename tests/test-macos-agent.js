'use strict';

// com.multicc.agent: build through the real installer (temp paths, launchctl
// off), then run `serve` and drive it with the client. Clicks and captures are
// not exercised — they depend on grants and would move the real pointer — but
// every refusal path and the Chrome watchdog are. macOS with Swift only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const INSTALLER = path.join(__dirname, '..', 'scripts', 'install-agent.sh');
const hasSwift = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc']).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tiered platform support: macOS 11 is the floor and its newest toolchain is
// Swift 5.5, so code OUTSIDE a `#if compiler(>=5.6+)` gate must stay 5.5
// syntax (the local compiler cannot catch that — hence this scan). Code inside
// such a gate is compiled only by newer toolchains and may use anything.
// Newer APIs are caught by the build itself (deployment target 11.0).
test('agent + scroll sources: ungated code stays Swift 5.5 compatible (macOS 11 floor)', () => {
  const sources = [
    path.join(__dirname, '..', 'scripts', 'macos-agent', 'MultiCCAgent.swift'),
    path.join(__dirname, '..', 'scripts', 'macos-agent', 'AgentPermissions.swift'),
    path.join(__dirname, '..', 'skills', 'multicc-computer-use', 'scripts', 'scroll.swift'),
  ];
  const rules = [
    // if let x { / guard let x else / , let x { — Swift 5.7 shorthand bindings
    [/\b(?:if|guard|while)\b[^=\n]*?\b(?:let|var) [A-Za-z_]\w*\s*(?:,|\{|else\b)/, 'optional binding shorthand (5.7)'],
    [/(?:=|return)\s*(?:if|switch)\s/, 'if/switch expression (5.9)'],
    [/#unavailable|\bany [A-Z]\w*[\s,)>\]]|\bconsume\b|\bborrowing\b|\bconsuming\b/, 'Swift 5.6+ keyword'],
    [/#\/|\bRegex</, 'regex literal (5.7)'],
  ];
  for (const file of sources) {
    const gate = [];   // one entry per open #if: true when it requires a compiler newer than 5.5
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const directive = line.trim();
      if (/^#if\b/.test(directive)) {
        const m = directive.match(/compiler\(>=\s*(\d+)\.(\d+)/);
        gate.push(!!m && (Number(m[1]) > 5 || (Number(m[1]) === 5 && Number(m[2]) > 5)));
        return;
      }
      if (/^#endif\b/.test(directive)) { gate.pop(); return; }
      if (gate.some(Boolean)) return;
      const code = line.replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
      for (const [re, what] of rules) {
        assert.ok(!re.test(code), `${path.basename(file)}:${i + 1} uses ${what}: ${line.trim()}`);
      }
    });
  }
});

test('Agent permission prompts are targeted, queued and never fabricate grants', { skip: !hasSwift, timeout: 60000 }, t => {
  const root = fs.mkdtempSync(path.join('/tmp', 'mcagent-permissions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let source = fs.readFileSync(path.join(__dirname, '../scripts/macos-agent/AgentPermissions.swift'), 'utf8');
  // Execute production scheduling with only OS authorization APIs replaced.
  // Tests must never show real TCC dialogs or alter the developer's grants.
  for (const name of ['AXIsProcessTrusted', 'AXIsProcessTrustedWithOptions', 'CGPreflightScreenCaptureAccess', 'CGRequestScreenCaptureAccess']) {
    source = source.replace(new RegExp(`\\b${name}\\b`, 'g'), `fake${name}`);
  }
  source += `
var axGranted = false, screenGranted = false
var prompts: [String] = []
func fakeAXIsProcessTrusted() -> Bool { axGranted }
func fakeCGPreflightScreenCaptureAccess() -> Bool { screenGranted }
func fakeAXIsProcessTrustedWithOptions(_ options: CFDictionary) -> Bool { prompts.append("accessibility"); return true }
func fakeCGRequestScreenCaptureAccess() -> Bool { prompts.append("screenRecording"); return true }
func drain() { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) }
let screen = requestAgentPermissions(["permission": "screenRecording"])
precondition(screen["ok"] as? Bool == true && screen["screenRecording"] as? Bool == false)
precondition(prompts.isEmpty, "socket response must precede a potentially modal prompt")
drain()
precondition(prompts == ["screenRecording"], "must not request unrelated Accessibility")
prompts = []
_ = requestAgentPermissions(["permission": "accessibility"])
drain()
precondition(prompts == ["accessibility"])
prompts = []
for value: Any in ["listenAccess", "toString", 1] {
  precondition(requestAgentPermissions(["permission": value])["ok"] as? Bool == false)
}
drain()
precondition(prompts.isEmpty, "invalid permission must not prompt")
_ = requestAgentPermissions([:])
drain()
precondition(prompts == ["accessibility", "screenRecording"], "legacy first-install client must still work")
prompts = []; axGranted = true; screenGranted = true
let ready = requestAgentPermissions([:])
drain()
precondition(prompts.isEmpty && ready["screenRecording"] as? Bool == true, "existing grants must not prompt")
print("Permission request regression OK")
`;
  const file = path.join(root, 'main.swift'), binary = path.join(root, 'permissions-tests');
  fs.writeFileSync(file, source);
  execFileSync('xcrun', ['swiftc', file, '-o', binary], { timeout: 60000 });
  assert.match(execFileSync(binary, [], { encoding: 'utf8', timeout: 5000 }), /Permission request regression OK/);
});

// Live touch drag holds the real left button down while a finger is on the phone.
// The inputs that must always give it back can't be exercised here (they'd move the
// real pointer), so pin the structure that guarantees it.
test('remote screen live drag: every exit path releases the button, dragdown is viewer-only', () => {
  const dir = path.join(__dirname, '..', 'scripts', 'macos-agent');
  const src = fs.readFileSync(path.join(dir, 'MultiCCAgent.swift'), 'utf8');
  const h264 = fs.readFileSync(path.join(dir, 'MultiCCAgentH264.swift'), 'utf8');
  const body = (name) => {
    const at = src.indexOf(`func ${name}(`);
    assert.ok(at > 0, `${name} exists`);
    const next = src.indexOf('\n}\n', at);
    return src.slice(at, next);
  };
  // press goes through the full policy gate and only for the remote-screen session
  const handleCase = src.slice(src.indexOf('case "dragdown":'), src.indexOf('case "drag":'));
  assert.match(handleCase, /session == "remote-screen"/);
  assert.match(handleCase, /withMutation\(/);
  assert.match(handleCase, /\.leftMouseDown/);
  assert.doesNotMatch(handleCase, /\.leftMouseUp/);
  // release: lift, disconnect (RFB + H.264 sessions), idle watchdog, hard stops
  assert.match(body('rfbPointer'), /if live \{ rfbDragEnd\(c, p\); return \}/);
  assert.match(src, /defer \{\s*rfbDragAbort\(client\)/);
  assert.match(h264, /defer \{ rfbDragAbort\(client\.input\);/);
  assert.match(body('rfbDragWatchdog'), /RFB_DRAG_IDLE_RELEASE/);
  const step = body('rfbDragStep');
  for (const guard of ['AXIsProcessTrusted()', 'screenLocked()', 'control.isHalted', 'holderConflict("remote-screen")']) {
    assert.ok(step.includes(guard), `rfbDragStep stops on ${guard}`);
  }
  assert.match(step, /rfbDragEnd\(c, nil\)/);
  assert.match(body('rfbDragEnd'), /\.leftMouseUp/);
  // a refused press must not be retried on every move sample
  assert.match(body('rfbLeftHeldMove'), /c\.dragDead = true/);
});

test('HTTP fallback native pointer: held moves dispatch live; release, refusal and viewer teardown are safe', { skip: !hasSwift, timeout: 60000 }, t => {
  const root = fs.mkdtempSync('/tmp/multicc-http-pointer-native-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(__dirname, '../scripts/macos-agent/MultiCCAgent.swift'), 'utf8');
  const body = name => {
    const start = source.indexOf(`func ${name}(`);
    assert.ok(start > 0);
    let end = source.indexOf('{', start), depth = 1;
    while (depth && ++end < source.length) {
      if (source[end] === '{') depth++;
      if (source[end] === '}') depth--;
    }
    return source.slice(start, end + 1);
  };
  const client = source.slice(source.indexOf('final class RfbClient:'), source.indexOf('/// One persistent deflate stream'));
  const http = source.slice(source.indexOf('final class HttpScreenPointers {'), source.indexOf('// Live touch drag.'));
  const file = path.join(root, 'main.swift');
  fs.writeFileSync(file, `import Foundation
import CoreGraphics
import Darwin
let RFB_DIV = 2
let RFB_DRAG_SLOP: CGFloat = 8
let automationEventSource = CGEventSource(stateID: .privateState)
let mutationLane = NSLock()
var events: [CGEventType] = []
var refused = false
func post(_ event: CGEvent?) { if let event = event { events.append(event.type) } }
func log(_ text: String) {}
func AXIsProcessTrusted() -> Bool { true }
func screenLocked() -> Bool { false }
final class Control {
  var isHalted = false
  func clearIdleHalt() -> Bool { false }
  func holderConflict(_ session: String) -> String? { nil }
}
let control = Control()
final class RfbScreen {
  static let shared = RfbScreen()
  func notePointer(_ c: RfbClient) -> Int { c.lastPointerAt = Date(); return c.div }
}
func handle(_ request: [String: Any]) -> [String: Any] {
  if !refused { events.append(.leftMouseDown) }
  return ["ok": !refused]
}
func rfbInput(_ request: [String: Any]) { events.append(.otherMouseDown) }
func rfbHover(_ c: RfbClient, _ p: CGPoint) {}
func rfbDragWatchdog(_ c: RfbClient) {}
${client}
${body('rfbPointer')}
${body('rfbDragEnd')}
${body('rfbDragAbort')}
${body('rfbLeftHeldMove')}
${body('rfbDragStep')}
${http}
let pointers = HttpScreenPointers.shared
_ = pointers.pointer("a", mask: 1, x: 100, y: 100)
precondition(events.isEmpty)
_ = pointers.pointer("a", mask: 1, x: 140, y: 100)
precondition(events == [.leftMouseDown, .leftMouseDragged], "drag must dispatch before lift")
_ = pointers.pointer("a", mask: 0, x: 150, y: 100)
precondition(events.last == .leftMouseUp)
events.removeAll()
_ = pointers.pointer("b", mask: 1, x: 10, y: 10)
_ = pointers.pointer("b", mask: 1, x: 50, y: 10)
pointers.releaseAll()
precondition(events == [.leftMouseDown, .leftMouseDragged, .leftMouseUp])
events.removeAll(); refused = true
_ = pointers.pointer("c", mask: 1, x: 10, y: 10)
let result = pointers.pointer("c", mask: 1, x: 50, y: 10)
precondition(result["ok"] as? Bool == false)
_ = pointers.pointer("c", mask: 1, x: 70, y: 10)
_ = pointers.pointer("c", mask: 0, x: 70, y: 10)
precondition(events.isEmpty, "refused input must not retry or click on release")
print("HTTP pointer native OK")
`);
  const binary = path.join(root, 'pointer-tests');
  execFileSync('xcrun', ['swiftc', file, '-o', binary], { timeout: 30000 });
  assert.match(execFileSync(binary, [], { encoding: 'utf8', timeout: 10000 }), /HTTP pointer native OK/);
});

// Wire golden (tests/fixtures/remote-screen-wire.json), the Agent half: the real
// h264Session reader (real readFully over a socketpair) must decode the bytes the
// App sends — and the real h264Message must frame what the App parses — exactly
// as the shared table says. The App and bridge halves assert the same table.
test('H.264 wire golden: the agent decodes client input and frames output exactly as the shared table', { skip: !hasSwift, timeout: 60000 }, t => {
  const wire = require('./fixtures/remote-screen-wire.json');
  const root = fs.mkdtempSync('/tmp/multicc-h264-wire-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = fs.readFileSync(path.join(__dirname, '../scripts/macos-agent/MultiCCAgent.swift'), 'utf8');
  const h264 = fs.readFileSync(path.join(__dirname, '../scripts/macos-agent/MultiCCAgentH264.swift'), 'utf8');
  const fn = (source, name) => {
    const start = source.indexOf(`func ${name}(`);
    assert.ok(start > 0, `func ${name} not found`);
    let end = source.indexOf('{', start), depth = 1;
    while (depth && ++end < source.length) {
      if (source[end] === '{') depth++;
      if (source[end] === '}') depth--;
    }
    return source.slice(start, end + 1);
  };
  const consts = h264.match(/^let H264_(CONFIG|KEY|DELTA|PONG|REQ_KEY|CAP|PING): UInt8 = .*$/gm);
  assert.equal(consts.length, 7);
  const be = agent.slice(agent.indexOf('extension Data {'), agent.indexOf('func readFully('));
  const bytes = hex => `[${Buffer.from(hex, 'hex').join(', ')}]`;
  const expectCalls = c => c.kind === 'pointer' ? [`pointer ${c.mask} ${c.x} ${c.y}`]
    : c.kind === 'key' ? [`key ${c.down ? 1 : 0} ${c.keysym}`]
      : c.kind === 'cap' ? [`cap ${c.kbps}`]
        : c.kind === 'ping' ? [`ping ${c.token}`] : ['key-request'];
  const rateControl = wire.clientRateControlToAgent;
  const streams = [
    ...wire.clientToAgent.map(c => ({ name: c.name, hex: c.hex, calls: expectCalls(c) })),
    ...rateControl.map(c => ({ name: c.name, hex: c.hex, calls: expectCalls(c) })),
    { name: 'all input back to back', hex: wire.clientToAgent.map(c => c.hex).join(''), calls: wire.clientToAgent.flatMap(expectCalls) },
    { name: 'rate control back to back', hex: rateControl.map(c => c.hex).join(''), calls: rateControl.flatMap(expectCalls) },
    ...wire.rejectedByBridge.map(c => ({ name: c.name, hex: c.hex, calls: c.agentCalls })),
  ];
  const file = path.join(root, 'main.swift');
  fs.writeFileSync(file, `import Foundation
import Darwin
${consts.join('\n')}
final class RfbClient { var div = 1; var hoverMoves = false; init(_ fd: Int32) {} }
final class H264Client {
  let fd: Int32; let input: RfbClient; var isClosed = false
  init(_ fd: Int32) { self.fd = fd; input = RfbClient(fd) }
  func shutdown() { isClosed = true }
}
var calls: [String] = []
final class H264Screen {
  static let shared = H264Screen()
  func attach(_ c: H264Client) -> Bool { true }
  func detach(_ c: H264Client) {}
  func requestKey() { calls.append("key-request") }
  func setCapability(_ c: H264Client, kbps: Int) { calls.append("cap \\(kbps)") }
  func ping(_ c: H264Client, token: UInt32) { calls.append("ping \\(token)") }
}
func rfbPointer(_ c: RfbClient, mask: Int, x: Int, y: Int) { calls.append("pointer \\(mask) \\(x) \\(y)") }
func rfbKey(_ c: RfbClient, down: Bool, keysym: UInt32) { calls.append("key \\(down ? 1 : 0) \\(keysym)") }
func rfbDragAbort(_ c: RfbClient) {}
${be}
${fn(agent, 'readFully')}
${fn(h264, 'h264Message')}
${fn(h264, 'h264Session')}
func decode(_ input: [UInt8]) -> [String] {
  var fds: [Int32] = [0, 0]
  precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
  _ = input.withUnsafeBytes { write(fds[1], $0.baseAddress, input.count) }
  close(fds[1])
  calls = []
  h264Session(fds[0])
  close(fds[0])
  return calls
}
${streams.map(s => `print("in\\t" + decode(${bytes(s.hex)}).joined(separator: ","))`).join('\n')}
${wire.agentToClient.map(f => `print("out\\t" + h264Message(${f.type}, Data(${bytes(f.hex.slice(10))})).map { String(format: "%02x", $0) }.joined())`).join('\n')}
`);
  const binary = path.join(root, 'wire');
  execFileSync('xcrun', ['swiftc', file, '-o', binary], { timeout: 60000 });
  const lines = execFileSync(binary, [], { encoding: 'utf8', timeout: 10000 }).trim().split('\n').map(l => l.split('\t'));
  const got = lines.filter(l => l[0] === 'in').map(l => (l[1] ? l[1].split(',') : []));
  streams.forEach((s, i) => assert.deepEqual(got[i], s.calls, s.name));
  const framed = lines.filter(l => l[0] === 'out').map(l => l[1]);
  assert.deepEqual(framed, wire.agentToClient.map(f => f.hex));
});

test('computer use: input dispatch clears inherited modifiers and preserves explicit chords', { skip: !hasSwift, timeout: 60000 }, t => {
  const root = fs.mkdtempSync('/tmp/multicc-input-flags-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(__dirname, '../scripts/macos-agent/MultiCCAgent.swift'), 'utf8');
  const post = source.slice(source.indexOf('func post('), source.indexOf('func click('));
  const chord = source.slice(source.indexOf('func postChord('), source.indexOf('func runTool('));
  const file = path.join(root, 'main.swift');
  fs.writeFileSync(file, `import Foundation
import CoreGraphics
import Darwin
let EVENT_MARK: Int64 = 0x4D43_4341
let automationEventSource = CGEventSource(stateID: .privateState)
var captured: [(CGEvent, pid_t?)] = []
// Replace only the OS transport: production event configuration and chord
// construction run unchanged, without posting keys or moving the real pointer.
func deliverAutomationEvent(_ event: CGEvent, pid: pid_t?) { captured.append((event, pid)) }
${post}
${chord}
let inherited: CGEventFlags = [.maskCommand, .maskShift, .maskControl, .maskAlternate, .maskSecondaryFn]
var events: [CGEvent] = []
for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .leftMouseDragged] {
  events.append(CGEvent(mouseEventSource: automationEventSource, mouseType: type,
                        mouseCursorPosition: CGPoint(x: 12, y: 34), mouseButton: .left)!)
}
events.append(CGEvent(scrollWheelEvent2Source: automationEventSource, units: .line,
                      wheelCount: 1, wheel1: 3, wheel2: 0, wheel3: 0)!)
for down in [true, false] {
  events.append(CGEvent(keyboardEventSource: automationEventSource, virtualKey: 7, keyDown: down)!)
}
for event in events {
  let originalType = event.type
  event.flags = inherited
  post(event, pid: 42)
  let delivered = captured.last!
  precondition(delivered.0.flags.isEmpty, "plain input inherited modifiers")
  precondition(delivered.0.type == originalType, "dispatch changed event type")
  precondition(delivered.0.getIntegerValueField(.eventSourceUserData) == EVENT_MARK)
  precondition(delivered.1 == 42, "dispatch lost the target PID")
}
let count = captured.count
post(nil)
precondition(captured.count == count, "nil events must not dispatch")
let requested: CGEventFlags = [.maskCommand, .maskShift]
captured = []
postChord(5, requested, pid: 123)
precondition(captured.count == 2)
precondition(captured[0].0.type == .keyDown && captured[1].0.type == .keyUp)
for (event, pid) in captured {
  precondition(event.flags == requested, "explicit chord modifiers were lost")
  precondition(event.getIntegerValueField(.keyboardEventKeycode) == 5)
  precondition(pid == 123)
}
// A subsequent unmodified chord must not retain modifiers from its predecessor.
postChord(36, [], pid: nil)
for (event, pid) in captured.suffix(2) {
  precondition(event.flags.isEmpty && pid == nil)
}
let dirty = events[0]
dirty.flags = inherited
post(dirty, flags: .maskControl)
precondition(captured.last!.0.flags == .maskControl, "explicit flags must replace, not merge with, inherited flags")
print("Input flags OK: plain events cleared, chords preserved, next operation isolated")
`);
  const binary = path.join(root, 'input-flags-tests');
  execFileSync('xcrun', ['swiftc', file, '-o', binary], { timeout: 30000 });
  assert.match(execFileSync(binary, [], { encoding: 'utf8', timeout: 10000 }), /Input flags OK/);
});

test('computer use: only the control bar pauses dispatch; own cursor/keyboard activity never does; cancel and Esc stop', { skip: !hasSwift, timeout: 60000 }, t => {
  const root = fs.mkdtempSync('/tmp/multicc-input-native-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(__dirname, '../scripts/macos-agent/MultiCCAgent.swift'), 'utf8');
  const gate = source.slice(source.indexOf('final class HumanInputGate {'), source.indexOf('// Floating control bar'));
  const control = source.slice(source.indexOf('final class Control {'), source.indexOf('// Password prompts,'));
  const wait = source.slice(source.indexOf('func waitForHumanIdle()'), source.indexOf('// MARK: - Safety:'));
  const mutation = source.slice(source.indexOf('enum MutKind'), source.indexOf('// MARK: - Operations'));
  assert.ok(!/func sampleHumanInput|func recordHumanInput/.test(source), 'automatic keyboard/mouse detection must stay removed');
  const hud = source.slice(source.indexOf('final class ComputerUseHUD'), source.indexOf('let computerUseHUD ='));
  assert.match(hud, /halted \? control\.stopNoticeActive\(\) : \(state\.visible \|\| control\.automationLeaseActive\)/,
    'the cancelled notice must expire on its own instead of riding the lease');
  assert.match(hud, /if showButtons \{ view\.addSubview\(pause\); view\.addSubview\(stop\) \}/,
    'a stop notice must not carry dead buttons');
  assert.match(hud, /if panel == nil \|\| showButtons == halted/, 'a mode change must rebuild the bar, not mutate it');
  const file = path.join(root, 'main.swift');
  fs.writeFileSync(file, `import Foundation
import CoreGraphics
import Darwin
let EVENT_MARK: Int64 = 0x4D43_4341
func log(_ s: String) {}
${gate}
${control}
${wait}
// Native integration harness: real arbitration/locking; stub only OS target
// queries and dispatch so no real pointer/key is touched.
var targetPid: pid_t = 42
var locked = false
func AXIsProcessTrusted() -> Bool { true }
func screenLocked() -> Bool { locked }
func bundleOf(_ pid: pid_t) -> String? { "test.app" }
func pidAt(_ point: CGPoint) -> pid_t? { targetPid }
func focusedAppPid() -> pid_t? { targetPid }
func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }
func refused(_ reason: String, _ message: String, retrySafe: Bool = true) -> [String: Any] {
  ["ok": false, "reason": reason, "dispatched": "none", "retrySafe": retrySafe]
}
let PROTECTED_APPS: Set<String> = [], SYSTEM_SURFACES: Set<String> = [], TERMINALS: Set<String> = []
final class HUD { func update() {} }
let computerUseHUD = HUD()
${mutation}
// Gate state machine: running by default, paused only by an explicit call,
// bar visible while active / paused / briefly after finishing.
let g = HumanInputGate()
precondition(!g.snapshot(at: 0).visible)
g.begin(at: 0)
precondition(g.snapshot(at: 0).phase == "running" && g.snapshot(at: 0).visible)
g.setPaused(true)
precondition(g.snapshot(at: 5).phase == "paused")
g.setPaused(false)
precondition(g.snapshot(at: 5).phase == "running")
g.end(at: 10)
precondition(g.snapshot(at: 12.9).visible)
precondition(!g.snapshot(at: 13.1).visible)
g.setPaused(true)
precondition(g.snapshot(at: 100).visible) // a paused bar stays reachable between operations
g.setPaused(false)
precondition(!g.snapshot(at: 100).visible)
DispatchQueue.global().async {
  // 1. No pause requested: dispatch is immediate, whatever the OS thinks the
  //    keyboard/mouse (or the agent's own text cursor) are doing.
  let t0 = inputClock()
  let direct = withMutation(["pid": 42], session: "test", target: 42, kind: .pointer) { ["ok": true] }
  precondition(direct["ok"] as? Bool == true && inputClock() - t0 < 0.5, "dispatch waited without a pause request")
  precondition(control.release("test"))
  // 2. Pause from the bar holds dispatch until resumed.
  humanInput.setPaused(true)
  let t1 = inputClock()
  DispatchQueue.global().asyncAfter(deadline: .now() + 1) { humanInput.setPaused(false) }
  let held = withMutation(["pid": 42], session: "test", target: 42, kind: .pointer) {
    precondition(inputClock() - t1 >= 0.9, "dispatch ran while paused")
    return ["ok": true]
  }
  precondition(held["ok"] as? Bool == true)
  precondition(control.release("test"))
  // 3. Cancel from the bar stops dispatch and clears a pending pause.
  humanInput.setPaused(true)
  DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { control.userStop(); humanInput.setPaused(false) }
  let cancelled = withMutation(["pid": 42], session: "test", target: 42, kind: .keyboard) { fatalError("cancel did not prevent dispatch") }
  precondition(cancelled["reason"] as? String == "user-stopped")
  precondition(cancelled["retrySafe"] as? Bool == false)
  precondition(!humanInput.isPaused)
  // A stop notice is bounded while an operation is active. The cancellation
  // marker clears once that operation ends; the next call needs no resume.
  let notice = Control()
  notice.begin("notice-test")
  notice.userStop()
  let stoppedAt = Date()
  precondition(notice.isHalted && notice.stopNoticeActive(at: stoppedAt))
  precondition(!notice.stopNoticeActive(at: stoppedAt.addingTimeInterval(Control.stopNoticeSeconds + 0.1)))
  notice.end()
  precondition(!notice.isHalted && !notice.stopNoticeActive(at: Date()))
  precondition(!control.isHalted && !control.stopNoticeActive(at: Date()))
  let afterCancel = withMutation(["pid": 42], session: "test", target: 42, kind: .keyboard) { ["ok": true] }
  precondition(afterCancel["ok"] as? Bool == true, "one-shot cancel must not latch across operations")
  precondition(control.release("test"))
  // 4. Esc (optional tap) still stops while driving.
  DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { control.userEsc() }
  let escaped = withMutation(["pid": 42], session: "test", target: 42, kind: .keyboard) {
    usleep(300_000)
    precondition(control.isHalted, "Esc must stop the operation in flight")
    let whileHalted = withMutation(["pid": 42], session: "test", target: 42, kind: .keyboard) { fatalError("Esc did not prevent dispatch") }
    precondition(whileHalted["reason"] as? String == "user-stopped")
    precondition(whileHalted["retrySafe"] as? Bool == false)
    return ["ok": true]
  }
  _ = escaped
  precondition(!control.isHalted, "Esc cancellation must clear when the operation ends")
  let afterEsc = withMutation(["pid": 42], session: "test", target: 42, kind: .keyboard) { ["ok": true] }
  precondition(afterEsc["ok"] as? Bool == true)
  precondition(control.release("test"))
  // 5. Manual remote control is never delayed by a pause.
  humanInput.setPaused(true)
  let remoteStarted = inputClock()
  let remote = withMutation(["pid": 42], session: "remote-screen", target: 42, kind: .pointer) { ["ok": true] }
  precondition(remote["ok"] as? Bool == true && inputClock() - remoteStarted < 0.5,
               "manual remote control was delayed by the automation pause")
  precondition(control.release("remote-screen"))
  humanInput.setPaused(false)
  // 6. Stale target and screen lock still refuse.
  targetPid = 43
  let stale = withMutation([:], session: "test", target: 42, kind: .keyboard) { fatalError("stale target received input") }
  precondition(stale["reason"] as? String == "stale")
  targetPid = 42
  DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { locked = true }
  usleep(300_000)
  let lockReply = withMutation(["pid": 42], session: "test", target: 42, kind: .keyboard) { fatalError("locked screen received input") }
  precondition(lockReply["reason"] as? String == "screen-locked")
  print("Computer use OK: default running, bar pause/resume, cancel, Esc, remote unaffected, stale target, screen lock")
  exit(0)
}
RunLoop.main.run()
`);
  const binary = path.join(root, 'input-tests');
  execFileSync('xcrun', ['swiftc', file, '-o', binary], { timeout: 30000 });
  assert.match(execFileSync(binary, [], { encoding: 'utf8', timeout: 20000 }), /Computer use OK/);
});

test('RFB native regressions: nested dirty regions cover latest pixels and fast requests are never lost', { skip: !hasSwift, timeout: 90000 }, t => {
  const root = fs.mkdtempSync('/tmp/multicc-rfb-native-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(__dirname, '../scripts/macos-agent/MultiCCAgent.swift'), 'utf8');
  const merge = source.slice(source.indexOf('func mergeRfbDirtyRects('), source.indexOf('extension Data {'));
  const data = source.slice(source.indexOf('extension Data {'), source.indexOf('func readFully('));
  const clientStart = source.indexOf('final class RfbClient: NSObject');
  const client = source.slice(clientStart, source.indexOf('\n@available(', clientStart));
  const senderStart = source.indexOf('func rfbSender(');
  const sender = source.slice(senderStart, source.indexOf('\n@available(', senderStart));
  const file = path.join(root, 'main.swift');
  fs.writeFileSync(file, `import Foundation
import CoreGraphics
import Darwin
${merge}
${data}
${client}
final class RfbScreen {
  static let shared = RfbScreen()
  func takeUpdate(_ client: RfbClient) -> [Data]? { return [] }
}
var sent = 0
var active: RfbClient!
func writeAll(_ fd: Int32, _ data: Data) -> Bool {
  sent += 1
  if sent == 1 { active.requestUpdate() } // request arrives before writeAll returns
  else { active.shutdown() }
  return true
}
${sender}
let full = CGRect(x: 0, y: 0, width: 64, height: 48)
let large = CGRect(x: 4, y: 4, width: 16, height: 24)
let small = CGRect(x: 8, y: 8, width: 2, height: 2)
let merged = mergeRfbDirtyRects([large, small], full: full)
precondition(merged.count == 1 && merged[0] == large, "nested change shrank the earlier dirty region")
// Apply the emitted rects from the latest framebuffer to an old client image.
var latest = [Int](repeating: 0, count: 64 * 48)
for y in 4..<28 { for x in 4..<20 { latest[y * 64 + x] = 3 } }
for y in 8..<10 { for x in 8..<10 { latest[y * 64 + x] = 9 } }
var displayed = [Int](repeating: 0, count: 64 * 48)
for r in merged {
  for y in Int(r.minY)..<Int(r.maxY) {
    for x in Int(r.minX)..<Int(r.maxX) { displayed[y * 64 + x] = latest[y * 64 + x] }
  }
}
precondition(displayed == latest, "old/new frame pixels remain mixed")
// Every source pixel must still be covered after repeated coalescing, and the
// queue stays bounded even when a slow client misses hundreds of captures.
var state: UInt64 = 17
func next(_ limit: Int) -> Int { state = state &* 6364136223846793005 &+ 1; return Int((state >> 32) % UInt64(limit)) }
var dirty: [CGRect] = []
var original: [CGRect] = []
for _ in 0..<180 {
  let x = next(60), y = next(44)
  let r = CGRect(x: x, y: y, width: 1 + next(64 - x), height: 1 + next(48 - y))
  original.append(r)
  dirty = mergeRfbDirtyRects(dirty + [r], full: full)
  precondition(dirty.count <= 64)
  for y in 0..<48 { for x in 0..<64 {
    let p = CGPoint(x: CGFloat(x) + 0.5, y: CGFloat(y) + 0.5)
    if original.contains(where: { $0.contains(p) }) {
      precondition(dirty.contains(where: { $0.contains(p) }), "a pending source pixel was dropped")
    }
  } }
}
active = RfbClient(-1)
active.requestUpdate()
rfbSender(active)
precondition(sent == 2, "fast next-frame request was erased")
// Multiple shutdown callers must never close a descriptor owned by serveRfb.
var fds: [Int32] = [-1, -1]
precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
let connection = RfbClient(fds[0])
connection.shutdown(); connection.shutdown()
precondition(fcntl(fds[0], F_GETFD) >= 0, "shutdown closed the shared descriptor")
close(fds[0]); close(fds[1])
print("RFB regression OK: coherent latest frame, 180 accumulated updates, fast next request, single fd owner")
`);
  const binary = path.join(root, 'rfb-tests');
  execFileSync('xcrun', ['swiftc', '-O', file, '-o', binary], { timeout: 60000 });
  assert.match(execFileSync(binary, [], { encoding: 'utf8', timeout: 5000 }), /RFB regression OK/);
});

test('agent: installer build, client/server protocol and chrome watchdog', { skip: !hasSwift, timeout: 240000 }, async (t) => {
  const root = fs.mkdtempSync(path.join('/tmp', 'mcagent-'));
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    MULTICC_AGENT_APP: path.join(root, 'MultiCC Agent.app'),
    MULTICC_AGENT_PLIST: path.join(root, 'agent.plist'),
    MULTICC_AGENT_DIR: path.join(root, 'd'),
    MULTICC_AGENT_LINK: path.join(root, 'bin', 'multicc-agent'),
    MULTICC_AGENT_NO_LAUNCHCTL: '1',
    // Ad-hoc: a test must not reach into the developer's keychain.
    MULTICC_AGENT_SIGN_IDENTITY: '-',
    MULTICC_AGENT_POWER_DISABLED: '1',
  };
  const bin = path.join(env.MULTICC_AGENT_APP, 'Contents/MacOS/MultiCCAgent');

  execFileSync('/bin/sh', [INSTALLER, 'install'], { env });
  const firstBuild = fs.statSync(bin).mtimeMs;
  const firstUUID = execFileSync('xcrun', ['dwarfdump', '--uuid', bin], { encoding: 'utf8' });
  const infoPath = path.join(env.MULTICC_AGENT_APP, 'Contents/Info.plist');
  const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPath], { encoding: 'utf8' }));
  assert.equal(info.CFBundleIconFile, 'AgentIcon.icns');
  const iconPath = path.join(env.MULTICC_AGENT_APP, 'Contents/Resources/AgentIcon.icns');
  assert.equal(fs.readFileSync(iconPath).subarray(0, 4).toString(), 'icns');
  const firstIcon = fs.statSync(iconPath).mtimeMs;
  assert.match(execFileSync('/usr/bin/vtool', ['-show-build', bin], { encoding: 'utf8' }), /minos 11\.0/);
  assert.equal(fs.statSync(env.MULTICC_AGENT_DIR).mode & 0o777, 0o700);
  assert.match(spawnSync('/usr/bin/codesign', ['-dv', env.MULTICC_AGENT_APP], { encoding: 'utf8' }).stderr, /Identifier=com\.multicc\.agent/);
  const out = execFileSync('/bin/sh', [INSTALLER, 'install'], { env, encoding: 'utf8' });
  assert.match(out, /binary up to date/);
  assert.match(out, /requirement cdhash/);
  assert.equal(fs.statSync(bin).mtimeMs, firstBuild, 'reinstall must not rebuild (would revoke grants)');
  assert.equal(fs.statSync(iconPath).mtimeMs, firstIcon, 'no-op install must preserve sealed resources');
  fs.rmSync(iconPath);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Delete :CFBundleIconFile', infoPath]);
  const repaired = execFileSync('/bin/sh', [INSTALLER, 'install'], { env, encoding: 'utf8' });
  assert.match(repaired, /binary up to date/);
  assert.equal(execFileSync('xcrun', ['dwarfdump', '--uuid', bin], { encoding: 'utf8' }), firstUUID,
    'resource re-signing may touch Mach-O, but icon repair must not recompile it');
  assert.equal(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', infoPath], { encoding: 'utf8' }).trim(), 'AgentIcon.icns');
  assert.ok(fs.existsSync(iconPath));
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', env.MULTICC_AGENT_APP]);
  const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', env.MULTICC_AGENT_PLIST], { encoding: 'utf8' }));
  assert.deepEqual(plist.LimitLoadToSessionType, ['Aqua']);
  assert.equal(plist.AbandonProcessGroup, true);

  // Watchdog against a port nothing listens on, with a launch script that
  // only leaves a marker, starting paused.
  const marker = path.join(root, 'launched');
  const launch = path.join(root, 'launch.sh');
  fs.writeFileSync(launch, `#!/bin/bash\necho x >> '${marker}'\n`);
  fs.writeFileSync(path.join(env.MULTICC_AGENT_DIR, 'config.json'),
    JSON.stringify({ chrome: { enabled: true, port: 9, launch } }));
  const pause = path.join(env.MULTICC_AGENT_DIR, 'chrome.pause');
  fs.writeFileSync(pause, '');

  const server = spawn(bin, ['serve'], { env: { ...env, MULTICC_AGENT_CHROME_INTERVAL: '0.2' }, stdio: 'ignore' });
  t.after(() => server.kill());
  const call = (...args) => {
    const r = spawnSync(bin, args, { env, encoding: 'utf8' });
    return { code: r.status, body: JSON.parse(r.stdout.trim().split('\n').pop()) };
  };
  for (let i = 0; i < 50 && !fs.existsSync(path.join(env.MULTICC_AGENT_DIR, 'agent.sock')); i++) await sleep(100);
  assert.equal(fs.statSync(path.join(env.MULTICC_AGENT_DIR, 'agent.sock')).mode & 0o777, 0o600);

  assert.equal(call('ping').body.ok, true);
  assert.deepEqual(call('call', '{"op":"rm"}'), { code: 1, body: { ok: false, error: 'unknown op: rm' } });
  assert.equal(call('snap', '/tmp/../etc/x.png').body.ok, false);
  assert.equal(call('snap', 'rel.png').body.ok, false);
  assert.equal(call('call', '{"op":"type","text":""}').body.ok, false);

  // Chords parse against the ported Peekaboo key table without posting anything.
  assert.deepEqual(call('call', '{"op":"press","keys":"cmd+shift+g","dryRun":true}').body,
    { ok: true, keyCode: 5, flags: 0x120000, key: 'g' });
  assert.equal(call('call', '{"op":"press","keys":"cmd+,","dryRun":true}').body.key, 'comma');
  assert.match(call('call', '{"op":"press","keys":"cmd+foo","dryRun":true}').body.error, /unknown key: foo/);
  assert.match(call('call', '{"op":"press","keys":"a+b","dryRun":true}').body.error, /more than one/);
  // Element ops without a snapshot are refused before anything is sent.
  for (const args of [['click-el', 'elem_1'], ['set', 'elem_1', 'x'], ['click-text', 'Save']]) {
    const r = call(...args);
    assert.equal(r.code, 1);
    assert.equal(r.body.outcome, 'refused');
    assert.equal(r.body.dispatched, 'none');
  }
  // Background cmd+q would silently quit an app the user cannot see.
  const bg = call('call', '{"op":"press","keys":"cmd+q","pid":1}').body;
  assert.equal(bg.reason, 'dangerous-background-hotkey');
  assert.equal(call('resume').body.ok, true);
  const status = call('status').body;
  assert.equal(status.version, '3');
  assert.equal(typeof status.screenLocked, 'boolean');
  assert.equal(typeof status.unlockPassword, 'boolean');
  // status 是 computer-use 高频调用的只读操作，只能查条目属性；一旦它真去解密密码，
  // 就会命中钥匙串 ACL 授权框（这个 ad-hoc 测试 agent 当然不在 ACL 里），而锁屏时那个
  // 框点不到 —— 实测 mcu.sh status 在这台机器上卡过 120 秒。这里用「秒级返回」把它钉住：
  // 改回解密的话，要么弹框（这个测试会挂到超时），要么慢到分钟级。
  const statusStarted = Date.now();
  assert.equal(typeof call('status').body.unlockPassword, 'boolean');
  assert.ok(Date.now() - statusStarted < 2000, 'status must not decrypt the keychain item');
  // 未锁屏时 unlock 必须拒绝，且绝不能因为钥匙串里有/没密码就副作用。
  const unlock = call('call', '{"op":"unlock"}').body;
  assert.equal(unlock.ok, false);
  assert.match(unlock.error, /screen is not locked/);
  // Platform tiers: the legacy capture backend is always available as the
  // last resort; newer ones are listed first when this OS/build has them.
  assert.equal(status.platform.captureBackends.at(-1), 'screencapture');
  assert.match(status.platform.os, /^\d+\.\d+\.\d+$/);
  assert.equal(status.platform.settingsApp,
    Number(status.platform.os.split('.')[0]) >= 13 ? 'System Settings' : 'System Preferences');
  assert.match(call('call', '{"op":"snap","path":"/tmp/x.png","backend":"nope"}').body.error,
    /not available|screen-recording-not-granted/);
  assert.equal(status.control.halted, false);
  assert.equal(status.control.inputState, 'idle');
  assert.equal(typeof status.control.resumeSecondsLeft, 'number');

  await sleep(1200);
  assert.ok(!fs.existsSync(marker), 'paused watchdog never launches');
  let chrome = call('status').body.chrome;
  assert.equal(chrome.paused, true);
  assert.ok(chrome.misses >= 2);

  fs.rmSync(pause);
  for (let i = 0; i < 30 && !fs.existsSync(marker); i++) await sleep(100);
  await sleep(800);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'x\n', 'launched exactly once (90s back-off)');
  chrome = call('status').body.chrome;
  assert.equal(chrome.launches, 1);
  assert.match(chrome.lastLaunchResult, /^exit 0/);

  server.kill();
  await sleep(200);
  assert.equal(call('ping').code, 3, 'client reports agent-not-running');

  execFileSync('/bin/sh', [INSTALLER, 'uninstall'], { env });
  assert.ok(!fs.existsSync(env.MULTICC_AGENT_APP) && !fs.existsSync(env.MULTICC_AGENT_PLIST));
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Auto-provisioning: installing/updating MultiCC installs/updates the agent ──
const { createMacosAgentProvisioner } = require('../src/macos-agent-provision');
const { sourceHash, readShippedBuild } = require('../src/macos-agent-build');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { MACOS_AGENT_FILES } = require('../scripts/desktop-bundle-server');

function provisionFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-prov-'));
  const root = path.join(tmp, 'root');
  fs.mkdirSync(path.join(root, 'scripts', 'macos-agent'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'install-agent.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(root, 'scripts', 'macos-agent', 'MultiCCAgent.swift'), '// v1\n');
  fs.writeFileSync(path.join(root, 'scripts', 'macos-agent', 'LidBrightnessBridge.h'), '// header\n');
  fs.writeFileSync(path.join(root, 'scripts', 'macos-agent', 'LidBrightnessBridge.m'), '// bridge\n');
  fs.writeFileSync(path.join(root, 'scripts', 'macos-agent', 'MultiCCAgentH264.swift'), '// h264\n');
  fs.writeFileSync(path.join(root, 'scripts', 'macos-agent', 'AgentPermissions.swift'), '// permissions\n');
  fs.writeFileSync(path.join(root, 'scripts', 'macos-agent', 'AgentIcon.icns'), 'icns-fixture');
  fs.writeFileSync(path.join(root, 'scripts', 'macos-agent', 'agent-build.json'), JSON.stringify({ build: 2, sourceSha256: sourceHash(root) }));
  const env = {
    MULTICC_AGENT_APP: path.join(tmp, 'MultiCC Agent.app'),
    MULTICC_AGENT_PLIST: path.join(tmp, 'agent.plist'),
    MULTICC_AGENT_DIR: path.join(tmp, 'agent'),
    MULTICC_AGENT_LINK: path.join(tmp, 'bin', 'multicc-agent'),
  };
  const bin = path.join(env.MULTICC_AGENT_APP, 'Contents', 'MacOS', 'MultiCCAgent');
  const installed = (source) => {
    const res = path.join(env.MULTICC_AGENT_APP, 'Contents', 'Resources');
    fs.mkdirSync(path.join(env.MULTICC_AGENT_APP, 'Contents', 'MacOS'), { recursive: true });
    fs.mkdirSync(res, { recursive: true });
    fs.writeFileSync(bin, '');
    fs.chmodSync(bin, 0o755);
    fs.mkdirSync(path.dirname(env.MULTICC_AGENT_LINK), { recursive: true });
    try { fs.symlinkSync(bin, env.MULTICC_AGENT_LINK); } catch (_) { /* already linked */ }
    const hash = crypto.createHash('sha256').update(source);
    for (const file of ['LidBrightnessBridge.h', 'LidBrightnessBridge.m', 'MultiCCAgentH264.swift', 'AgentPermissions.swift'])
      hash.update(fs.readFileSync(path.join(root, 'scripts', 'macos-agent', file)));
    fs.writeFileSync(path.join(res, 'source.sha256'), `${hash.digest('hex')}\n`);
    fs.copyFileSync(path.join(root, 'scripts', 'macos-agent', 'AgentIcon.icns'), path.join(res, 'AgentIcon.icns'));
    fs.writeFileSync(env.MULTICC_AGENT_PLIST, '');
  };
  const calls = [];
  const exits = { install: 0, 'request-permissions': 0, ping: 0 };
  const spawnFake = (file, args) => {
    const sub = args[args.length - 1];
    calls.push([path.basename(file), sub]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => { child.stdout.emit('data', `ran ${sub}\n`); child.emit('close', exits[sub]); });
    return child;
  };
  const logs = [];
  const desktopEnv = path.join(tmp, 'desktop-multicc.env');
  const make = (over = {}) => createMacosAgentProvisioner({
    rootDir: root, home: tmp, platform: 'darwin', env, spawn: spawnFake, desktopApps: [], desktopEnvFile: desktopEnv,
    logger: { log: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) }, ...over,
  });
  const stampOf = () => fs.readFileSync(path.join(env.MULTICC_AGENT_APP, 'Contents', 'Resources', 'source.sha256'), 'utf8').trim();
  // What install-agent.sh writes after each install.
  const writeRecord = (over = {}) => {
    fs.mkdirSync(env.MULTICC_AGENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.MULTICC_AGENT_DIR, 'install.json'), JSON.stringify({
      build: 2, sourceSha256: stampOf(), app: env.MULTICC_AGENT_APP, installerKind: 'desktop', installerVersion: '9.9.9',
      installerRoot: '/Applications/MultiCC.app/Contents/Resources/app-server', installedAt: '2026-10-28T00:00:00Z', ...over,
    }));
  };
  return { tmp, root, env, installed, calls, exits, logs, make, desktopEnv, stampOf, writeRecord };
}

test('agent build number: agent-build.json pins the shipped Agent sources (bump on every source change)', () => {
  const root = path.join(__dirname, '..');
  const shipped = readShippedBuild(root);
  assert.ok(shipped.build >= 1, 'agent-build.json must carry a positive build number');
  assert.equal(shipped.sourceSha256, sourceHash(root),
    'Agent sources changed: run `node src/macos-agent-build.js bump` so other MultiCC copies can tell this build is newer');
  // install-agent.sh hashes the same files in the same order.
  const installer = fs.readFileSync(INSTALLER, 'utf8');
  const hashed = installer.match(/SUM="\$\(cat ([^|]+)\|/)[1].match(/macos-agent\/([\w.]+)/g).map(m => m.slice('macos-agent/'.length));
  assert.deepEqual(['MultiCCAgent.swift', ...hashed], require('../src/macos-agent-build').AGENT_SOURCE_FILES);
});

test('agent provisioning: copies sharing one Agent never downgrade it and never replace another copy\'s same build', async () => {
  const f = provisionFixture();
  // A newer build, whoever installed it, is shared as is.
  f.installed('// newer code\n');
  f.writeRecord({ build: 3 });
  assert.deepEqual(f.make().plan(), { action: 'skip', reason: 'installed-newer', installedBuild: 3, shippedBuild: 2 });
  // Same build, different code, another copy's install: left alone and named;
  // only the user's explicit replace goes ahead.
  f.writeRecord({ build: 2 });
  const conflict = f.make().plan();
  assert.equal(conflict.action, 'skip');
  assert.equal(conflict.reason, 'other-owner');
  assert.deepEqual([conflict.owner.kind, conflict.owner.version], ['desktop', '9.9.9']);
  assert.equal(f.make().plan({ replace: true }).reason, 'source-changed');
  // Same build installed by this very copy: a developer iterating, so update.
  f.writeRecord({ build: 2, installerRoot: fs.realpathSync(f.root) });
  assert.equal(f.make().plan().reason, 'source-changed');
  // An older build is upgraded.
  f.writeRecord({ build: 1 });
  assert.deepEqual(f.make().plan(), { action: 'update', reason: 'source-changed' });
  assert.equal(f.make().inspect().installed.build, 1);
  // Same code is current no matter who installed it.
  f.installed('// v1\n');
  f.writeRecord({ build: 2 });
  assert.deepEqual(f.make().plan(), { action: 'skip', reason: 'up-to-date' });
  assert.equal(f.make().inspect().installed.build, 2);

  // A copy that predates the record replaced the recorded Agent: it ranks as
  // build 0, is upgraded back, and the replacement is reported.
  f.installed('// legacy copy\n');
  const p = f.make();
  const seen = p.inspect();
  assert.equal(seen.installed.build, 0);
  assert.equal(seen.installed.owner, null);
  assert.equal(seen.replaced.previousBuild, 2);
  f.calls.length = 0;
  const upgraded = await p.ensure();
  assert.equal(upgraded.action, 'update');
  assert.ok(upgraded.replaced, 'the replacement must reach the settings card');
  assert.ok(f.logs.some(l => l.startsWith('WARN') && l.includes('replaced by another MultiCC')));

  // The installer refuses to drop a real signature (exit 75): nothing changed,
  // nothing to ping, retried at the next start.
  f.calls.length = 0;
  f.exits.install = 75;
  const deferred = await f.make().ensure();
  assert.deepEqual([deferred.ok, deferred.action, deferred.reason], [true, 'skip', 'signing-unavailable']);
  assert.deepEqual(f.calls, [['sh', 'install']]);
  fs.rmSync(f.tmp, { recursive: true, force: true });
});

test('agent provisioning: a new shipped build upgrades another copy on startup and stays current after restart', async t => {
  const f = provisionFixture();
  t.after(() => fs.rmSync(f.tmp, { recursive: true, force: true }));
  const shipped = readShippedBuild(path.join(__dirname, '..'));
  assert.ok(shipped.build > 1);
  const nextSource = '// keyboard fix in the updated MultiCC package\n';
  fs.writeFileSync(path.join(f.root, 'scripts/macos-agent/MultiCCAgent.swift'), nextSource);
  fs.writeFileSync(path.join(f.root, 'scripts/macos-agent/agent-build.json'), JSON.stringify({
    build: shipped.build, sourceSha256: sourceHash(f.root),
  }));
  f.installed('// previous Agent\n');
  f.writeRecord({ build: shipped.build - 1 });
  const config = path.join(f.env.MULTICC_AGENT_DIR, 'config.json');
  const settings = '{"chrome":{"enabled":false},"userChoice":"keep"}\n';
  fs.writeFileSync(config, settings);
  const calls = [];
  const spawnInstaller = (file, args) => {
    const sub = args.at(-1);
    calls.push([path.basename(file), sub]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (sub === 'install') {
        f.installed(nextSource);
        f.writeRecord({ build: shipped.build, installerRoot: fs.realpathSync(f.root) });
      }
      child.emit('close', 0);
    });
    return child;
  };
  const startup = f.make({ spawn: spawnInstaller });
  assert.deepEqual(startup.plan(), { action: 'update', reason: 'source-changed' });
  const result = await startup.ensure();
  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(result.action, 'update');
  assert.deepEqual(calls, [['sh', 'install'], ['MultiCCAgent', 'ping']], 'an upgrade must not request permissions again');
  assert.equal(startup.inspect().installed.build, shipped.build);
  assert.equal(f.stampOf(), sourceHash(f.root));
  assert.equal(fs.readFileSync(config, 'utf8'), settings);
  // A new provisioner models the next MultiCC process starting with this package.
  calls.length = 0;
  const restarted = f.make({ spawn: spawnInstaller });
  assert.deepEqual(restarted.plan(), { action: 'skip', reason: 'up-to-date' });
  assert.equal((await restarted.ensure()).action, 'skip');
  assert.deepEqual(calls, [], 'an unchanged restart must not reinstall or restart the Agent');
});

test('agent provisioning: names the desktop copies that still use the old install rule', () => {
  const f = provisionFixture();
  const desk = path.join(f.tmp, 'Apps', 'MultiCC.app');
  const server = path.join(desk, 'Contents', 'Resources', 'app-server');
  fs.mkdirSync(path.join(server, 'scripts', 'macos-agent'), { recursive: true });
  fs.writeFileSync(path.join(server, 'package.json'), '{"version":"2.11.3"}');
  const others = () => f.make({ desktopApps: [desk] }).inspect().others;
  assert.deepEqual(others(), [{ kind: 'desktop', app: desk, version: '2.11.3', legacyRules: true, autoInstallDisabled: false }]);
  fs.writeFileSync(f.desktopEnv, 'PORT=3000\nMULTICC_AGENT_AUTO_INSTALL=0\n');
  assert.equal(others()[0].autoInstallDisabled, true);
  fs.writeFileSync(path.join(server, 'scripts', 'macos-agent', 'agent-build.json'), '{"build":2}');
  assert.equal(others()[0].legacyRules, false);
  // A copy never lists itself, and knows it is the desktop app.
  const inside = f.make({ desktopApps: [desk], rootDir: server }).inspect();
  assert.deepEqual(inside.others, []);
  assert.equal(inside.self.kind, 'desktop');
  assert.equal(inside.self.version, '2.11.3');
  assert.equal(f.make().inspect().self.kind, 'package');
  fs.rmSync(f.tmp, { recursive: true, force: true });
});

test('agent provisioning: decides install / update / skip from what is on disk', () => {
  const f = provisionFixture();
  assert.deepEqual(f.make({ platform: 'linux' }).plan(), { action: 'skip', reason: 'not-macos' });
  assert.equal(f.make({ env: { ...f.env, MULTICC_AGENT_AUTO_INSTALL: '0' } }).plan().reason, 'disabled-by-env');
  assert.equal(f.make({ rootDir: path.join(f.tmp, 'nowhere') }).plan().reason, 'installer-not-shipped');
  assert.deepEqual(f.make().plan(), { action: 'install', reason: 'not-installed' });
  f.installed('// v1\n');
  assert.deepEqual(f.make().plan(), { action: 'skip', reason: 'up-to-date' });
  const oldBin = path.join(f.tmp, 'User Applications', 'MultiCC Agent.app/Contents/MacOS/MultiCCAgent');
  fs.mkdirSync(path.dirname(oldBin), { recursive: true });
  fs.writeFileSync(oldBin, '');
  fs.chmodSync(oldBin, 0o755);
  fs.rmSync(f.env.MULTICC_AGENT_LINK);
  fs.symlinkSync(oldBin, f.env.MULTICC_AGENT_LINK);
  assert.deepEqual(f.make().plan(), { action: 'update', reason: 'client-location-changed' });
  fs.rmSync(f.env.MULTICC_AGENT_LINK);
  f.installed('// v1\n');
  fs.rmSync(path.join(f.env.MULTICC_AGENT_APP, 'Contents/Resources/AgentIcon.icns'));
  assert.deepEqual(f.make().plan(), { action: 'update', reason: 'icon-changed' });
  f.installed('// v1\n');
  fs.writeFileSync(path.join(f.env.MULTICC_AGENT_APP, 'Contents/Resources/AgentIcon.icns'), 'old-icon');
  assert.deepEqual(f.make().plan(), { action: 'update', reason: 'icon-changed' });
  f.installed('// v1\n');
  // 装上了但跑不起来（预编译二进制丢过 0755：mktemp 建 0600、cp 保留目标权限）：
  // 时间戳与哈希都对得上，只有执行位能揭穿它，所以必须由这里判成「要修」。
  fs.chmodSync(path.join(f.env.MULTICC_AGENT_APP, 'Contents', 'MacOS', 'MultiCCAgent'), 0o644);
  assert.deepEqual(f.make().plan(), { action: 'install', reason: 'not-executable' });
  f.installed('// v1\n');
  fs.rmSync(f.env.MULTICC_AGENT_LINK);
  assert.deepEqual(f.make().plan(), { action: 'install', reason: 'client-link-missing' });
  f.installed('// v1\n');
  fs.writeFileSync(path.join(f.root, 'scripts', 'macos-agent', 'MultiCCAgent.swift'), '// v2\n');
  assert.deepEqual(f.make().plan(), { action: 'update', reason: 'source-changed' });
  f.installed('// v2\n');
  fs.writeFileSync(path.join(f.root, 'scripts', 'macos-agent', 'LidBrightnessBridge.m'), '// bridge v2\n');
  assert.deepEqual(f.make().plan(), { action: 'update', reason: 'source-changed' });
  f.installed('// v2\n');
  fs.rmSync(f.env.MULTICC_AGENT_PLIST);
  assert.deepEqual(f.make().plan(), { action: 'update', reason: 'launch-agent-missing' });
  fs.mkdirSync(f.env.MULTICC_AGENT_DIR, { recursive: true });
  fs.writeFileSync(path.join(f.env.MULTICC_AGENT_DIR, 'auto-install-disabled'), '');
  assert.equal(f.make().plan().reason, 'uninstalled-by-user');
  fs.rmSync(f.tmp, { recursive: true, force: true });
});

test('agent provisioning: runs the installer in the background, asks for grants only on first install, never throws', async () => {
  const f = provisionFixture();
  const p = f.make();
  const [a, b] = [p.ensure(), p.ensure()];
  assert.equal(a, b, 'single-flight');
  const first = await a;
  assert.equal(first.ok, true);
  assert.deepEqual(f.calls, [['sh', 'install'], ['MultiCCAgent', 'request-permissions'], ['MultiCCAgent', 'ping']]);
  assert.equal(first.ready, true, 'a half-install must be visible here, not only as "unlock is not ready" later');

  f.calls.length = 0;
  f.installed('// v1\n');
  fs.writeFileSync(path.join(f.root, 'scripts', 'macos-agent', 'MultiCCAgent.swift'), '// v2\n');
  const update = await f.make().ensure();
  assert.equal(update.action, 'update');
  assert.deepEqual(f.calls, [['sh', 'install'], ['MultiCCAgent', 'ping']], 'an update keeps the existing grants: no prompts');

  // 装完 launchd 说成功、进程却起不来（旧版丢执行位的现场）：如实报出来，别当成装好了。
  f.calls.length = 0;
  f.exits.ping = 3;
  const silent = await f.make().ensure();
  assert.equal(silent.ok, true);
  assert.equal(silent.ready, false);
  assert.ok(f.logs.some((l) => l.startsWith('WARN') && l.includes('not answering')));
  f.exits.ping = 0;

  f.calls.length = 0;
  f.exits.install = 3;
  const failed = await f.make().ensure();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /ran install/);
  assert.ok(f.logs.some((l) => l.startsWith('WARN') && l.includes('exit 3')));

  const exploding = f.make({ spawn: () => { throw new Error('spawn EACCES'); } });
  assert.equal((await exploding.ensure()).ok, false);
  fs.rmSync(f.tmp, { recursive: true, force: true });
});

test('agent provisioning: the default installation probe uses global Applications', t => {
  const f = provisionFixture();
  t.after(() => fs.rmSync(f.tmp, { recursive: true, force: true }));
  const accesses = [];
  const fixtureFs = Object.create(fs);
  fixtureFs.accessSync = (file, mode) => {
    accesses.push(file);
    if (file.startsWith('/Applications/MultiCC Agent.app/')) throw new Error('fixture: not installed');
    return fs.accessSync(file, mode);
  };
  const env = { ...f.env };
  delete env.MULTICC_AGENT_APP;
  assert.deepEqual(f.make({ fs: fixtureFs, env }).plan(), { action: 'install', reason: 'not-installed' });
  assert.ok(accesses.includes('/Applications/MultiCC Agent.app/Contents/MacOS/MultiCCAgent'));
});

test('installer: keeps a really signed Agent instead of falling back to ad-hoc, and records who installed it', { skip: process.platform !== 'darwin', timeout: 60000 }, t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-signer-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const prebuilt = path.join(tmp, 'prebuilt');
  fs.mkdirSync(prebuilt);
  fs.copyFileSync('/usr/bin/true', path.join(prebuilt, 'MultiCCAgent'));
  const repoRoot = path.join(__dirname, '..');
  fs.writeFileSync(path.join(prebuilt, 'source.sha256'), `${sourceHash(repoRoot)}\n`);
  // An empty keychain, as `security find-identity -v` reports one whose
  // certificate is "not yet valid" (clock at 1970 right after boot).
  const shim = path.join(tmp, 'shim');
  fs.mkdirSync(shim);
  fs.writeFileSync(path.join(shim, 'security'), '#!/bin/sh\necho "     0 valid identities found"\n', { mode: 0o755 });
  const env = {
    PATH: `${shim}:${process.env.PATH}`, HOME: process.env.HOME,
    MULTICC_AGENT_PREBUILT: prebuilt,
    MULTICC_AGENT_APP: path.join(tmp, 'MultiCC Agent.app'),
    MULTICC_AGENT_PLIST: path.join(tmp, 'agent.plist'),
    MULTICC_AGENT_DIR: path.join(tmp, 'agent'),
    MULTICC_AGENT_LINK: path.join(tmp, 'bin', 'multicc-agent'),
    MULTICC_AGENT_NO_LAUNCHCTL: '1',
    MULTICC_AGENT_POWER_DISABLED: '1',
  };
  execFileSync('/bin/sh', [INSTALLER, 'install'], { env: { ...env, MULTICC_AGENT_SIGN_IDENTITY: '-' } });
  const record = JSON.parse(fs.readFileSync(path.join(env.MULTICC_AGENT_DIR, 'install.json'), 'utf8'));
  assert.equal(record.build, readShippedBuild(repoRoot).build);
  assert.equal(record.sourceSha256, sourceHash(repoRoot));
  assert.equal(record.app, env.MULTICC_AGENT_APP);
  assert.equal(record.installerRoot, fs.realpathSync(repoRoot));
  assert.equal(record.installerKind, 'source', 'a checkout (or worktree) installs as source');
  assert.equal(record.installerVersion, require('../package.json').version);

  // Pretend the installed Agent carries a real signature.
  const signerStamp = path.join(env.MULTICC_AGENT_APP, 'Contents', 'Resources', 'signer');
  fs.writeFileSync(signerStamp, 'A1B2C3D4\n');
  const plistBefore = fs.readFileSync(env.MULTICC_AGENT_PLIST, 'utf8');
  const kept = spawnSync('/bin/sh', [INSTALLER, 'install'], { env, encoding: 'utf8' });
  assert.equal(kept.status, 75, kept.stderr);
  assert.match(kept.stderr, /A1B2C3D4 is not usable right now/);
  assert.equal(fs.readFileSync(signerStamp, 'utf8'), 'A1B2C3D4\n', 'the installed Agent must stay untouched');
  assert.equal(fs.readFileSync(env.MULTICC_AGENT_PLIST, 'utf8'), plistBefore);
  // Choosing ad-hoc on purpose still works.
  execFileSync('/bin/sh', [INSTALLER, 'install'], { env: { ...env, MULTICC_AGENT_SIGN_IDENTITY: '-' } });
  assert.equal(fs.readFileSync(signerStamp, 'utf8'), '-\n');
  execFileSync('/bin/sh', [INSTALLER, 'uninstall'], { env });
  assert.equal(fs.existsSync(path.join(env.MULTICC_AGENT_DIR, 'install.json')), false);
});

test('agent provisioning: packages ship the installer, and the installer prefers a matching prebuilt binary', { skip: process.platform !== 'darwin', timeout: 60000 }, () => {
  for (const file of MACOS_AGENT_FILES) assert.ok(fs.existsSync(path.join(__dirname, '..', file)), file);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-prebuilt-'));
  const prebuilt = path.join(tmp, 'prebuilt');
  fs.mkdirSync(prebuilt);
  // Any Mach-O stands in for the agent; only the copy path is under test.
  fs.copyFileSync('/usr/bin/true', path.join(prebuilt, 'MultiCCAgent'));
  const sourceDir = path.join(__dirname, '..', 'scripts', 'macos-agent');
  const hash = crypto.createHash('sha256');
  for (const file of ['MultiCCAgent.swift', 'LidBrightnessBridge.h', 'LidBrightnessBridge.m', 'MultiCCAgentH264.swift', 'AgentPermissions.swift'])
    hash.update(fs.readFileSync(path.join(sourceDir, file)));
  fs.writeFileSync(path.join(prebuilt, 'source.sha256'), `${hash.digest('hex')}\n`);
  const env = {
    ...process.env,
    MULTICC_AGENT_PREBUILT: prebuilt,
    MULTICC_AGENT_APP: path.join(tmp, 'MultiCC Agent.app'),
    MULTICC_AGENT_PLIST: path.join(tmp, 'agent.plist'),
    MULTICC_AGENT_DIR: path.join(tmp, 'agent'),
    MULTICC_AGENT_LINK: path.join(tmp, 'bin', 'multicc-agent'),
    MULTICC_AGENT_NO_LAUNCHCTL: '1',
    MULTICC_AGENT_SIGN_IDENTITY: '-',
    MULTICC_AGENT_POWER_DISABLED: '1',
  };
  const bin = path.join(env.MULTICC_AGENT_APP, 'Contents', 'MacOS', 'MultiCCAgent');
  const out = execFileSync('/bin/sh', [INSTALLER, 'install'], { env, encoding: 'utf8' });
  assert.match(out, /using prebuilt binary/);
  // 复制路径会经 mktemp（0600），cp 又保留目标权限：装完必须显式 0755，否则 launchd
  // 根本起不来，而界面上看是「已安装」。
  assert.equal(fs.statSync(bin).mode & 0o777, 0o755, 'the copied binary must be executable');
  assert.equal(fs.readFileSync(path.join(env.MULTICC_AGENT_APP, 'Contents', 'Resources', 'source.sha256'), 'utf8').trim(),
    fs.readFileSync(path.join(prebuilt, 'source.sha256'), 'utf8').trim());

  // Simulate the old per-user location and the new shared Applications folder.
  // Never touch /Applications or the real user's launchd/keychain in a test.
  const globalApp = path.join(tmp, 'Applications', 'MultiCC Agent.app');
  const config = path.join(env.MULTICC_AGENT_DIR, 'config.json');
  const settings = '{"chrome":{"enabled":false},"userChoice":"keep"}\n';
  fs.writeFileSync(config, settings);
  const requirement = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', env.MULTICC_AGENT_APP], { encoding: 'utf8' }).stderr.match(/CDHash=(\w+)/)[1];
  const migrated = execFileSync('/bin/sh', [INSTALLER, 'install'], { env: {
    ...env, MULTICC_AGENT_APP: globalApp, MULTICC_AGENT_LEGACY_APP: env.MULTICC_AGENT_APP,
  }, encoding: 'utf8' });
  assert.match(migrated, /binary up to date/);
  assert.match(migrated, /migrated to/);
  assert.equal(fs.existsSync(env.MULTICC_AGENT_APP), false, 'the old Applications folder must no longer show a duplicate App');
  assert.ok(fs.existsSync(globalApp));
  assert.equal(fs.realpathSync(env.MULTICC_AGENT_LINK), fs.realpathSync(path.join(globalApp, 'Contents/MacOS/MultiCCAgent')));
  const migratedPlist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', env.MULTICC_AGENT_PLIST], { encoding: 'utf8' }));
  assert.equal(migratedPlist.ProgramArguments[0], path.join(globalApp, 'Contents/MacOS/MultiCCAgent'));
  assert.equal(fs.readFileSync(config, 'utf8'), settings);
  const backups = fs.readdirSync(env.MULTICC_AGENT_DIR).filter(name => name.startsWith('legacy-app-backup.'));
  assert.equal(backups.length, 1);
  assert.ok(fs.existsSync(path.join(env.MULTICC_AGENT_DIR, backups[0], 'MultiCC Agent.app')));
  const migratedRequirement = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', globalApp], { encoding: 'utf8' }).stderr.match(/CDHash=(\w+)/)[1];
  assert.equal(migratedRequirement, requirement, 'moving a current App must preserve its signed identity');
  fs.rmSync(globalApp, { recursive: true });

  // A failed destination copy must keep the old launcher and bundle usable.
  execFileSync('/bin/sh', [INSTALLER, 'install'], { env });
  const oldPlist = fs.readFileSync(env.MULTICC_AGENT_PLIST, 'utf8');
  const oldLink = fs.realpathSync(env.MULTICC_AGENT_LINK);
  const blockedApp = path.join(tmp, 'not-a-directory.app');
  fs.writeFileSync(blockedApp, 'fixture: occupied destination');
  const failedMigration = spawnSync('/bin/sh', [INSTALLER, 'install'], { env: {
    ...env, MULTICC_AGENT_APP: blockedApp, MULTICC_AGENT_LEGACY_APP: env.MULTICC_AGENT_APP,
  }, encoding: 'utf8' });
  assert.notEqual(failedMigration.status, 0);
  assert.equal(fs.realpathSync(env.MULTICC_AGENT_LINK), oldLink);
  assert.equal(fs.readFileSync(env.MULTICC_AGENT_PLIST, 'utf8'), oldPlist);
  assert.equal(fs.readFileSync(config, 'utf8'), settings);
  assert.ok(fs.existsSync(env.MULTICC_AGENT_APP));

  // 包在路上丢了执行位（zip 不带 unix 模式）也要能用预编译那份，而不是退回本地编译
  // ——用户机器上通常没有 Xcode 命令行工具，那条路只会失败。
  fs.rmSync(env.MULTICC_AGENT_APP, { recursive: true, force: true });
  fs.chmodSync(path.join(prebuilt, 'MultiCCAgent'), 0o644);
  const restored = execFileSync('/bin/sh', [INSTALLER, 'install'], { env, encoding: 'utf8' });
  assert.match(restored, /using prebuilt binary/);
  assert.equal(fs.statSync(bin).mode & 0o777, 0o755);

  // uninstall stops auto-install until the next manual install
  execFileSync('/bin/sh', [INSTALLER, 'uninstall'], { env });
  assert.ok(fs.existsSync(path.join(env.MULTICC_AGENT_DIR, 'auto-install-disabled')));
  execFileSync('/bin/sh', [INSTALLER, 'install'], { env });
  assert.ok(!fs.existsSync(path.join(env.MULTICC_AGENT_DIR, 'auto-install-disabled')));
  fs.rmSync(tmp, { recursive: true, force: true });
});


// Execute the production encoder and Swift dispatch with OS input stubbed out.
// These regressions must never type into the developer's foreground app.
test('remote keyboard: H.264 separates functional keys from Unicode text', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../public/chat-remote-screen-h264.js'), 'utf8');
  const start = source.indexOf('  const KEYSYMS =');
  const end = source.indexOf('  class H264View');
  assert.ok(start >= 0 && end > start);
  const encode = vm.runInNewContext(source.slice(start, end) + '\nkeysymOf;');
  const named = { Backspace: 0xff08, Delete: 0xffff, Enter: 0xff0d, Tab: 0xff09,
    Escape: 0xff1b, ArrowLeft: 0xff51, Home: 0xff50, End: 0xff57, F1: 0xffbe, F12: 0xffc9 };
  for (const [key, expected] of Object.entries(named)) assert.equal(encode({ key }), expected, key);
  for (const key of ['a', 'A', ' ', '(', 'é', '中', '（', '）', '😀']) {
    const cp = key.codePointAt(0);
    assert.equal(encode({ key }), cp <= 255 ? cp : 0x01000000 + cp, key);
  }
  assert.notEqual(encode({ key: '（' }), encode({ key: 'Backspace' }));
  for (const key of ['Dead', 'Process', 'Unidentified', 'ab', '']) assert.equal(encode({ key }), 0, key);
});

test('remote keyboard: Swift dispatch preserves deletion, navigation, shortcuts and text', { skip: !hasSwift, timeout: 60000 }, t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mcagent-keyboard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(__dirname, '../scripts/macos-agent/MultiCCAgent.swift'), 'utf8');
  const start = source.indexOf('let RFB_SPECIAL_KEYS:');
  const end = source.indexOf('@available(macOS 14.0, *)\nfunc rfbPointer', start);
  assert.ok(start >= 0 && end > start);
  const cases = [];
  const press = (ks, key, mods = []) => cases.push({ ks, mods, expected: [['press', key]] });
  const text = (ks, value) => cases.push({ ks, mods: [], expected: [['type', value]] });
  const special = [[0xff08, 'delete'], [0xffff, 'forwarddelete'], [0xff09, 'tab'],
    [0xff0d, 'return'], [0xff1b, 'escape'], [0xff50, 'home'], [0xff51, 'left'],
    [0xff52, 'up'], [0xff53, 'right'], [0xff54, 'down'], [0xff55, 'pageup'],
    [0xff56, 'pagedown'], [0xff57, 'end']];
  for (let n = 1; n <= 12; n++) special.push([0xffbd + n, `f${n}`]);
  for (const [ks, key] of special) {
    press(ks, key);
    press(ks, `shift+${key}`, [0xffe1]);
  }
  press(0xff08, 'cmd+delete', [0xffe7]);
  press(0xff08, 'alt+delete', [0xffe9]);
  press(0x63, 'cmd+c', [0xffe7]);
  for (let ks = 0x41; ks <= 0x5a; ks++) {
    press(ks, `cmd+shift+${String.fromCharCode(ks).toLowerCase()}`, [0xffe7, 0xffe1]);
  }
  for (const value of ['a', 'A', ' ', '(', 'é', '中', '（', '）', '😀']) {
    const cp = value.codePointAt(0);
    text(cp <= 255 ? cp : 0x01000000 + cp, value);
  }
  text(0x4e2d, '中'); // Older H.264 raw-codepoint clients.
  text(0x1f600, '😀');
  for (const ks of [0, 0xfe01, 0xff63, 0xd800, 0x01110000, 0x0100200d]) {
    cases.push({ ks, mods: [], expected: [] });
  }
  const exercise = cases.map(({ ks, mods }) => `
    calls = []
    do {
      let client = RfbClient()
      for mod: UInt32 in [${mods}] { rfbKey(client, down: true, keysym: mod) }
      rfbKey(client, down: true, keysym: ${ks})
      rfbKey(client, down: false, keysym: ${ks})
      for mod: UInt32 in [${mods}] { rfbKey(client, down: false, keysym: mod) }
      precondition(client.mods.isEmpty)
      results.append(calls)
    }`).join('\n');
  const file = path.join(root, 'main.swift');
  fs.writeFileSync(file, `import Foundation
class RfbClient { var mods: Set<String> = [] }
var calls: [[String]] = []
func log(_ message: String) {}
func handle(_ req: [String: Any]) -> [String: Any] {
  precondition(req["session"] as? String == "remote-screen")
  precondition(req["allowTerminal"] as? Bool == true && req["allowSystem"] as? Bool == true)
  let op = req["op"] as! String
  calls.append([op, req[op == "type" ? "text" : "keys"] as! String])
  return ["ok": true]
}
${source.slice(start, end)}
var results: [[[String]]] = []
if #available(macOS 14.0, *) { ${exercise} }
print(String(data: try JSONSerialization.data(withJSONObject: results), encoding: .utf8)!)
`);
  const actual = JSON.parse(execFileSync('swift', [file], { encoding: 'utf8', timeout: 55000 }));
  assert.equal(actual.length, cases.length);
  for (let i = 0; i < cases.length; i++) {
    assert.deepEqual(actual[i], cases[i].expected, `keysym=0x${cases[i].ks.toString(16)} mods=${cases[i].mods}`);
  }
  t.diagnostic(`${cases.length} production Swift dispatch cases passed`);
});
