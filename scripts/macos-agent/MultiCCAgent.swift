// com.multicc.agent — MultiCC's per-user desktop agent (the second half of the
// UU Remote split; the root half is scripts/multicc-powerd.sh).
//
// Why a separate user-session process instead of more work for the root daemon:
// clicks and screen capture only reach the logged-in user's WindowServer
// session, and macOS grants Accessibility / Screen Recording to a specific
// program. Grants given to a bare `node` or `cliclick` break when that binary
// is replaced; this agent lives at one fixed path inside "MultiCC Agent.app",
// launchd starts it in the user's Aqua session, so ONE grant covers every
// click and screenshot MultiCC performs, regardless of which CLI asked.
//
// Two jobs:
//   serve  — answer one-line JSON requests on ~/.multicc/agent/agent.sock
//            (dir 0700, socket 0600, peer uid must equal ours) with a FIXED
//            set of operations: no command execution, no paths beyond the
//            screenshot target.
//   chrome — keep the CDP automation Chrome (default :9222) reachable by
//            running the configured launch script when it has been down for
//            two consecutive probes.
// Anything else on the command line is the client: `MultiCCAgent click 10 20`.
//
// Element observation and actions (see / click-by-element / set / press) are
// ported from Peekaboo and AXorcist, public-API paths only:
//   Copyright (c) 2025 Peter Steinberger — MIT License
//   https://github.com/openclaw/Peekaboo  https://github.com/openclaw/AXorcist
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions: The above copyright
//   notice and this permission notice shall be included in all copies or
//   substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
//   WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
// What was taken: the AX walk shape (batched attribute reads, 0.2s per-call
// messaging timeout, depth/count/children limits, actionable-role set, elem_N
// ids), snapshot ids/TTL and staleness rules, element re-resolution scoring,
// text-query scoring, detached AXPress with a grace period, the hotkey table,
// and typed outcomes (dispatched / retrySafe). Not taken: SkyLight
// SLEventPostToPid and CGEventSetWindowLocation (private, fragile).
import Foundation
import CoreGraphics
import ApplicationServices
import AppKit
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif
import ImageIO

let VERSION = "2"
let home = FileManager.default.homeDirectoryForCurrentUser.path
let agentDir = ProcessInfo.processInfo.environment["MULTICC_AGENT_DIR"] ?? "\(home)/.multicc/agent"
let sockPath = "\(agentDir)/agent.sock"
let configPath = "\(agentDir)/config.json"
let pausePath = "\(agentDir)/chrome.pause"
// Stamped on every event we post, so the Esc monitor never mistakes our own
// synthetic Escape for the user's.
let EVENT_MARK: Int64 = 0x4D43_4341

func log(_ s: String) {
  FileHandle.standardError.write("\(ISO8601DateFormatter().string(from: Date())) \(s)\n".data(using: .utf8)!)
}

// MARK: - Outcomes (Peekaboo DesktopActionOutcome, reduced)
// Every mutating reply says whether anything reached the target and whether a
// retry is safe. Refused = nothing was sent, retry is safe unless the refusal
// itself says to stop. Dispatched = input was delivered; do NOT blindly retry,
// look at the screen first.

func refused(_ reason: String, _ message: String, retrySafe: Bool = true) -> [String: Any] {
  ["ok": false, "outcome": "refused", "dispatched": "none", "retrySafe": retrySafe, "reason": reason, "error": message]
}

func dispatched(_ mechanism: String, confirmed: Bool = false, _ extra: [String: Any] = [:]) -> [String: Any] {
  var r: [String: Any] = ["ok": true, "outcome": confirmed ? "confirmed_change" : "dispatched_unverified",
                          "dispatched": "dispatched", "retrySafe": false, "mechanism": mechanism]
  for (k, v) in extra { r[k] = v }
  return r
}

func indeterminate(_ mechanism: String, _ message: String) -> [String: Any] {
  ["ok": false, "outcome": "indeterminate", "dispatched": "maybe", "retrySafe": false, "mechanism": mechanism, "error": message]
}

// MARK: - Low-level input

func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

func post(_ e: CGEvent?, pid: pid_t? = nil) {
  guard let e = e else { return }
  e.setIntegerValueField(.eventSourceUserData, value: EVENT_MARK)
  if let pid = pid { e.postToPid(pid) } else { e.post(tap: .cghidEventTap) }
}

func click(_ p: CGPoint, right: Bool, count: Int) {
  let down: CGEventType = right ? .rightMouseDown : .leftMouseDown
  let up: CGEventType = right ? .rightMouseUp : .leftMouseUp
  let button: CGMouseButton = right ? .right : .left
  post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: button))
  for i in 1...max(1, min(count, 3)) {
    for type in [down, up] {
      let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button)
      e?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
      post(e)
    }
    usleep(30_000)
  }
}

extension Array {
  func chunked(_ n: Int) -> [[Element]] {
    stride(from: 0, to: count, by: n).map { Array(self[$0..<Swift.min($0 + n, count)]) }
  }
}

// Unicode events rather than keycodes: works for Chinese without touching the
// clipboard, independent of the active input method. Returns false when the
// user stopped us halfway.
func typeText(_ text: String, pid: pid_t?) -> Bool {
  for chunk in Array(text.utf16).chunked(20) {
    if control.isHalted { return false }
    for keyDown in [true, false] {
      let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: keyDown)
      chunk.withUnsafeBufferPointer { e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
      post(e, pid: pid)
    }
    usleep(10_000)
  }
  return true
}

// Key table and aliases: Peekaboo HotkeyService+Planning.swift.
let KEY_ALIASES: [String: String] = [
  "command": "cmd", "meta": "cmd", "win": "cmd", "control": "ctrl", "option": "alt", "opt": "alt",
  "function": "fn", "enter": "return", "esc": "escape", "backspace": "delete", "del": "delete",
  "spacebar": "space", "page_up": "pageup", "page_down": "pagedown", "forward_delete": "forwarddelete",
  "arrow_left": "left", "arrow_right": "right", "arrow_down": "down", "arrow_up": "up",
  "[": "leftbracket", "]": "rightbracket", "=": "equal", "-": "minus", "'": "quote", ";": "semicolon",
  "\\": "backslash", ",": "comma", "/": "slash", ".": "period", "`": "grave", "caps_lock": "capslock",
]
let MODIFIERS: [String: CGEventFlags] = [
  "cmd": .maskCommand, "shift": .maskShift, "alt": .maskAlternate, "ctrl": .maskControl, "fn": .maskSecondaryFn,
]
let KEYCODES: [String: CGKeyCode] = [
  "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08,
  "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11, "1": 0x12,
  "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "equal": 0x18, "9": 0x19, "7": 0x1A,
  "minus": 0x1B, "8": 0x1C, "0": 0x1D, "rightbracket": 0x1E, "o": 0x1F, "u": 0x20, "leftbracket": 0x21,
  "i": 0x22, "p": 0x23, "return": 0x24, "l": 0x25, "j": 0x26, "quote": 0x27, "k": 0x28,
  "semicolon": 0x29, "backslash": 0x2A, "comma": 0x2B, "slash": 0x2C, "n": 0x2D, "m": 0x2E,
  "period": 0x2F, "tab": 0x30, "space": 0x31, "grave": 0x32, "delete": 0x33, "escape": 0x35,
  "capslock": 0x39, "clear": 0x47, "help": 0x72, "home": 0x73, "pageup": 0x74, "forwarddelete": 0x75,
  "end": 0x77, "pagedown": 0x79, "f1": 0x7A, "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
  "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64, "f9": 0x65,
  "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
]

enum ChordError: Error { case bad(String) }

// "cmd+shift+g", "return", "cmd+," — exactly one non-modifier key.
func parseChord(_ s: String) throws -> (CGKeyCode, CGEventFlags, String) {
  var parts = s.split(whereSeparator: { $0 == "+" || $0 == " " }).map(String.init)
  if s.hasSuffix("++") { parts.append("+") }
  var flags: CGEventFlags = []
  var key: (CGKeyCode, String)?
  for raw in parts {
    let lower = raw.lowercased()
    let name = KEY_ALIASES[lower] ?? lower
    if let f = MODIFIERS[name] { flags.insert(f); continue }
    guard let code = KEYCODES[name] else { throw ChordError.bad("unknown key: \(raw)") }
    if key != nil { throw ChordError.bad("more than one non-modifier key in \(s)") }
    key = (code, name)
  }
  guard let key = key else { throw ChordError.bad("no key in \(s)") }
  return (key.0, flags, key.1)
}

func postChord(_ code: CGKeyCode, _ flags: CGEventFlags, pid: pid_t?) {
  let src = CGEventSource(stateID: .hidSystemState)
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
    e?.flags = flags
    post(e, pid: pid)
    usleep(1_000)
  }
}

func runTool(_ path: String, _ args: [String]) -> (Int32, String) {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: path)
  p.arguments = args
  let pipe = Pipe()
  p.standardError = pipe
  p.standardOutput = pipe
  do { try p.run() } catch { return (-1, "\(error)") }
  p.waitUntilExit()
  let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  return (p.terminationStatus, out.trimmingCharacters(in: .whitespacesAndNewlines))
}

// MARK: - Accessibility helpers

let AX_READ_TIMEOUT: Float = 0.2

func axPrepare(_ e: AXUIElement, _ t: Float = AX_READ_TIMEOUT) { AXUIElementSetMessagingTimeout(e, t) }

func axCopy(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}

func axStr(_ v: CFTypeRef?) -> String? {
  guard let v = v else { return nil }
  if let s = v as? String { return s }
  if CFGetTypeID(v) == CFBooleanGetTypeID() { return nil }
  if let n = v as? NSNumber { return n.stringValue }
  return nil
}

func axElement(_ v: CFTypeRef?) -> AXUIElement? {
  guard let v = v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
  return (v as! AXUIElement)
}

func axPoint(_ v: CFTypeRef?) -> CGPoint? {
  guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  var p = CGPoint.zero
  return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

func axSize(_ v: CFTypeRef?) -> CGSize? {
  guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  var s = CGSize.zero
  return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

func axFrame(_ e: AXUIElement) -> CGRect? {
  guard let p = axPoint(axCopy(e, kAXPositionAttribute)), let s = axSize(axCopy(e, kAXSizeAttribute)) else { return nil }
  return CGRect(origin: p, size: s)
}

func axChildren(_ e: AXUIElement) -> [AXUIElement] {
  (axCopy(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func axActions(_ e: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(e, &names) == .success, let n = names as? [String] else { return [] }
  return n
}

func pidOf(_ e: AXUIElement) -> pid_t? {
  var pid: pid_t = 0
  return AXUIElementGetPid(e, &pid) == .success ? pid : nil
}

func focusedAppPid() -> pid_t? {
  let sys = AXUIElementCreateSystemWide()
  axPrepare(sys, 1)
  guard let app = axElement(axCopy(sys, kAXFocusedApplicationAttribute)) else { return nil }
  return pidOf(app)
}

func pidAt(_ p: CGPoint) -> pid_t? {
  let sys = AXUIElementCreateSystemWide()
  axPrepare(sys, 1)
  var hit: AXUIElement?
  guard AXUIElementCopyElementAtPosition(sys, Float(p.x), Float(p.y), &hit) == .success, let hit = hit else { return nil }
  return pidOf(hit)
}

func bundleOf(_ pid: pid_t) -> String? { NSRunningApplication(processIdentifier: pid)?.bundleIdentifier }

func resolveApp(_ target: String?) -> pid_t? {
  guard let t = target?.trimmingCharacters(in: .whitespaces), !t.isEmpty else { return focusedAppPid() }
  if t.lowercased().hasPrefix("pid:") { return pid_t(t.dropFirst(4)) }
  let needle = t.lowercased()
  let apps = NSWorkspace.shared.runningApplications
  // Exact bundle id, exact display name, then the bundle id's last component
  // (display names are localized: Finder is 访达 on a Chinese system), and
  // only then a substring of the display name.
  let exact = apps.first { $0.bundleIdentifier?.lowercased() == needle }
    ?? apps.first { $0.localizedName?.lowercased() == needle }
    ?? apps.first { $0.bundleIdentifier?.lowercased().split(separator: ".").last.map(String.init) == needle }
  return (exact ?? apps.first { ($0.localizedName?.lowercased() ?? "").contains(needle) })?.processIdentifier
}

// While the screen is locked every app reports the application element itself
// as its "window" (observed on macOS 15), so those are discarded.
func appWindow(_ app: AXUIElement) -> AXUIElement? {
  func real(_ w: AXUIElement?) -> AXUIElement? { w.flatMap { CFEqual($0, app) ? nil : $0 } }
  for attr in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
    if let w = real(axElement(axCopy(app, attr))) { return w }
  }
  return ((axCopy(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).lazy.compactMap { real($0) }.first
}

// Input while locked lands in the login window's password field.
func screenLocked() -> Bool {
  ((CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
}

// One batched IPC per node; per-attribute fallback when the app rejects batching.
let DESC_ATTRS: [String] = [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
                            kAXIdentifierAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute,
                            "AXPlaceholderValue"]

func axBatch(_ e: AXUIElement) -> [CFTypeRef?] {
  var out: CFArray?
  if AXUIElementCopyMultipleAttributeValues(e, DESC_ATTRS as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out) == .success,
     let arr = out as? [AnyObject], arr.count == DESC_ATTRS.count {
    return arr.map { v in
      let ref = v as CFTypeRef
      if CFGetTypeID(ref) == AXValueGetTypeID() && AXValueGetType(ref as! AXValue) == .axError { return nil }
      return ref
    }
  }
  return DESC_ATTRS.map { axCopy(e, $0) }
}

// MARK: - Observation (see) and snapshots

let ACTIONABLE_ROLES: Set<String> = [
  "AXButton", "AXPopUpButton", "AXMenuButton", "AXTextField", "AXTextArea", "AXSearchField", "AXSecureTextField",
  "AXLink", "AXCheckBox", "AXRadioButton", "AXMenuItem", "AXMenuBarItem", "AXComboBox", "AXSlider", "AXTab",
  "AXDisclosureTriangle", "AXIncrementor", "AXColorWell",
]
// Only actionable when they actually expose AXPress (checked per node).
let PRESS_CANDIDATE_ROLES: Set<String> = ["AXGroup", "AXImage", "AXCell", "AXRow", "AXOutlineItem", "AXStaticText"]
let TEXT_ROLES: Set<String> = ["AXStaticText", "AXHeading"]
let TEXT_INPUT_ROLES: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXSecureTextField", "AXComboBox"]

struct Elem {
  let id: String
  let role: String
  let title: String?
  let desc: String?
  let value: String?
  let identifier: String?
  let placeholder: String?
  let frame: CGRect
  let enabled: Bool
  let actionable: Bool
  let ref: AXUIElement
}

final class Snapshot {
  let id: String
  let pid: pid_t
  let app: String
  let bundle: String?
  let session: String
  let window: AXUIElement?
  let windowTitle: String?
  let windowFrame: CGRect?
  let elements: [Elem]
  let created = Date()
  var consumed = false
  init(id: String, pid: pid_t, app: String, bundle: String?, session: String, window: AXUIElement?,
       windowTitle: String?, windowFrame: CGRect?, elements: [Elem]) {
    self.id = id; self.pid = pid; self.app = app; self.bundle = bundle; self.session = session
    self.window = window; self.windowTitle = windowTitle; self.windowFrame = windowFrame; self.elements = elements
  }
}

final class SnapshotStore {
  private let lock = NSLock()
  private var items: [Snapshot] = []
  static let ttl: TimeInterval = 600

  func put(_ s: Snapshot) {
    lock.lock(); defer { lock.unlock() }
    items.append(s)
    if items.count > 25 { items.removeFirst(items.count - 25) }
  }
  // "latest" means the newest snapshot this session took; sessions never act
  // on each other's observations by accident.
  func get(_ id: String, session: String) -> Snapshot? {
    lock.lock(); defer { lock.unlock() }
    if id == "latest" { return items.last { $0.session == session } }
    return items.first { $0.id == id }
  }
  var count: Int { lock.lock(); defer { lock.unlock() }; return items.count }
}
let snapshots = SnapshotStore()

func clean(_ s: String?, _ max: Int = 120) -> String? {
  guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
  return t.count > max ? String(t.prefix(max)) + "…" : t
}

func newSnapshotId() -> String {
  "ps1_" + (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
}

// AX trees are not trees: some apps return an ancestor among an element's
// children, so every walk de-duplicates with CFEqual (as Peekaboo does).
struct VisitSet {
  private var seen: [CFHashCode: [AXUIElement]] = [:]
  mutating func insert(_ e: AXUIElement) -> Bool {
    let h = CFHash(e)
    if let list = seen[h], list.contains(where: { CFEqual($0, e) }) { return false }
    seen[h, default: []].append(e)
    return true
  }
}

struct Limits { var maxDepth = 12; var maxElements = 300; var maxVisited = 3000; var maxChildren = 250; var seconds = 8.0 }

func walk(_ root: AXUIElement, _ lim: Limits, includeText: Bool) -> ([Elem], String?) {
  var elems: [Elem] = []
  var truncated: String?
  var visited = 0
  let deadline = Date().addingTimeInterval(lim.seconds)
  var stack: [(AXUIElement, Int)] = [(root, 0)]
  var seen = VisitSet()
  while let (e, depth) = stack.popLast() {
    guard seen.insert(e) else { continue }
    if Date() > deadline { truncated = "deadline"; break }
    if visited >= lim.maxVisited { truncated = "maxVisited"; break }
    visited += 1
    axPrepare(e)
    let a = axBatch(e)
    let role = axStr(a[0]) ?? ""
    var actionable = ACTIONABLE_ROLES.contains(role)
    if !actionable && PRESS_CANDIDATE_ROLES.contains(role) { actionable = axActions(e).contains(kAXPressAction) }
    let title = clean(axStr(a[1])), desc = clean(axStr(a[2]))
    // Never read a password field's value into the snapshot.
    let value = role == "AXSecureTextField" ? nil : clean(axStr(a[3]))
    let keep = actionable || (includeText && TEXT_ROLES.contains(role) && (title ?? desc ?? value) != nil)
    if keep, let p = axPoint(a[5]), let s = axSize(a[6]), s.width > 5, s.height > 5 {
      if elems.count >= lim.maxElements { truncated = "maxElements"; break }
      elems.append(Elem(id: "elem_\(elems.count)", role: role, title: title, desc: desc, value: value,
                        identifier: clean(axStr(a[4]), 80), placeholder: clean(axStr(a[8])),
                        frame: CGRect(origin: p, size: s), enabled: (a[7] as? NSNumber)?.boolValue ?? true,
                        actionable: actionable, ref: e))
    }
    guard depth < lim.maxDepth else { truncated = truncated ?? "maxDepth"; continue }
    let kids = axChildren(e)
    if kids.count > lim.maxChildren { truncated = truncated ?? "maxChildren" }
    for k in kids.prefix(lim.maxChildren).reversed() { stack.append((k, depth + 1)) }
  }
  return (elems, truncated)
}

func rect(_ r: CGRect) -> [Int] { [Int(r.minX.rounded()), Int(r.minY.rounded()), Int(r.width.rounded()), Int(r.height.rounded())] }

func elemDict(_ e: Elem) -> [String: Any] {
  var d: [String: Any] = ["id": e.id, "role": String(e.role.dropFirst(2)).lowercased(), "frame": rect(e.frame)]
  if let l = e.desc ?? e.title ?? e.placeholder { d["label"] = l }
  if let t = e.title, t != d["label"] as? String { d["title"] = t }
  if let v = e.value, v != d["label"] as? String { d["value"] = v }
  if let i = e.identifier { d["ident"] = i }
  if !e.enabled { d["enabled"] = false }
  if !e.actionable { d["actionable"] = false }
  return d
}

func see(_ req: [String: Any], session: String) -> [String: Any] {
  if !AXIsProcessTrusted() { return refused("accessibility-not-granted", "grant Accessibility to MultiCC Agent") }
  guard let pid = resolveApp(req["app"] as? String) else { return ["ok": false, "error": "app not found"] }
  let app = AXUIElementCreateApplication(pid)
  axPrepare(app, 1)
  let window = appWindow(app)
  if let window = window { axPrepare(window) }
  var lim = Limits()
  if let n = num(req["maxElements"]) { lim.maxElements = max(1, min(1000, Int(n))) }
  if let n = num(req["maxDepth"]) { lim.maxDepth = max(1, min(40, Int(n))) }
  let (elems, truncated) = walk(window ?? app, lim, includeText: (req["includeText"] as? Bool) ?? true)
  let running = NSRunningApplication(processIdentifier: pid)
  let snap = Snapshot(id: newSnapshotId(), pid: pid, app: running?.localizedName ?? "pid \(pid)",
                      bundle: running?.bundleIdentifier, session: session, window: window,
                      windowTitle: window.flatMap { clean(axStr(axCopy($0, kAXTitleAttribute))) },
                      windowFrame: window.flatMap { axFrame($0) }, elements: elems)
  snapshots.put(snap)
  var r: [String: Any] = ["ok": true, "snapshot": snap.id, "pid": Int(pid), "app": snap.app,
                          "elements": elems.map(elemDict), "ttlSeconds": Int(SnapshotStore.ttl)]
  if let b = snap.bundle { r["bundle"] = b }
  if let t = snap.windowTitle { r["window"] = t }
  if let f = snap.windowFrame { r["windowFrame"] = rect(f) }
  if let truncated = truncated { r["truncated"] = truncated }
  if window == nil { r["noWindow"] = true }
  if screenLocked() { r["screenLocked"] = true }
  return r
}

// Text query scoring (Peekaboo ClickService.resolveTargetElement): exact beats
// substring, identifiers beat labels beat titles beat values, buttons win ties,
// then the element nearer the top.
func matchQuery(_ q: String, _ els: [Elem]) -> Elem? {
  let ql = q.lowercased()
  func score(_ e: Elem) -> Int {
    var best = 0
    let fields: [(String?, Int, Int)] = [(e.identifier, 400, 200), (e.desc, 350, 160), (e.title, 300, 120),
                                         (e.value, 200, 80), (e.placeholder, 150, 50)]
    for (field, exact, partial) in fields {
      guard let f = field?.lowercased() else { continue }
      if f == ql { best = max(best, exact) } else if f.contains(ql) { best = max(best, partial) }
    }
    if best == 0 { return 0 }
    let buttonBonus = e.role == "AXButton" ? 20 : 0
    return best + buttonBonus + (e.actionable ? 10 : 0)
  }
  var best: (Elem, Int)?
  for e in els where e.enabled {
    let s = score(e)
    guard s > 0 else { continue }
    if let b = best, b.1 > s || (b.1 == s && b.0.frame.minY <= e.frame.minY) { continue }
    best = (e, s)
  }
  return best?.0
}

func frameScore(_ a: CGRect, _ b: CGRect) -> Int {
  if a.equalTo(b) { return 250 }
  let d = hypot(a.midX - b.midX, a.midY - b.midY)
  if d <= 4 { return 180 }
  if d <= 12 { return 100 }
  let inter = a.intersection(b)
  guard !inter.isNull, a.width * a.height > 0 else { return 0 }
  return inter.width * inter.height / (a.width * a.height) >= 0.75 ? 100 : 0
}

enum Resolved { case ok(AXUIElement, CGRect); case stale(String) }

// Staleness rules from Peekaboo: expired, already used, process gone, window
// gone or resized. A moved window shifts the expected frame. The kept AX
// reference is tried first; otherwise the window is re-walked and scored.
func resolveLive(_ s: Snapshot, _ el: Elem) -> Resolved {
  if Date().timeIntervalSince(s.created) > SnapshotStore.ttl { return .stale("snapshot expired") }
  if s.consumed { return .stale("snapshot already drove an action") }
  if kill(s.pid, 0) != 0 { return .stale("target process is gone") }
  var dx: CGFloat = 0, dy: CGFloat = 0
  if let w = s.window, let old = s.windowFrame {
    axPrepare(w)
    guard let now = axFrame(w) else { return .stale("target window is gone") }
    if abs(now.width - old.width) > 4 || abs(now.height - old.height) > 4 { return .stale("target window was resized") }
    dx = now.minX - old.minX; dy = now.minY - old.minY
  }
  let expected = el.frame.offsetBy(dx: dx, dy: dy)
  axPrepare(el.ref)
  if axStr(axCopy(el.ref, kAXRoleAttribute)) == el.role, let f = axFrame(el.ref),
     hypot(f.midX - expected.midX, f.midY - expected.midY) <= 12 {
    return .ok(el.ref, f)
  }
  guard let root = s.window else { return .stale("element moved") }
  var best: (AXUIElement, CGRect, Int)?
  var stack: [(AXUIElement, Int)] = [(root, 0)]
  var visited = 0
  let deadline = Date().addingTimeInterval(5)
  var seen = VisitSet()
  while let (e, depth) = stack.popLast(), visited < 4000, Date() < deadline {
    guard seen.insert(e) else { continue }
    visited += 1
    axPrepare(e)
    let a = axBatch(e)
    if let p = axPoint(a[5]), let sz = axSize(a[6]) {
      let f = CGRect(origin: p, size: sz)
      var sc = frameScore(f, expected)
      if let id = el.identifier, clean(axStr(a[4]), 80) == id { sc += 500 }
      for (have, want) in [(clean(axStr(a[1])), el.title), (clean(axStr(a[2])), el.desc), (clean(axStr(a[3])), el.value)] {
        if let want = want, have == want { sc += 180 }
      }
      if axStr(a[0]) == el.role { sc += 50 }
      if sc > (best?.2 ?? 0) { best = (e, f, sc) }
    }
    if depth < 30 { for k in axChildren(e).prefix(250).reversed() { stack.append((k, depth + 1)) } }
  }
  if let best = best, best.2 >= 180 { return .ok(best.0, best.1) }
  return .stale("element no longer matches")
}

final class Box<T> { var v: T; init(_ v: T) { self.v = v } }

// AXUIElementPerformAction blocks while a menu or modal it opened is up, so it
// runs detached with a grace period (Peekaboo DetachedAXActionRunner).
// nil = still running after the grace period (typically: it opened a modal).
func performDetached(_ e: AXUIElement, _ action: String, grace: Double) -> AXError? {
  AXUIElementSetMessagingTimeout(e, 3)
  let sem = DispatchSemaphore(value: 0)
  let box = Box<AXError>(.failure)
  Thread.detachNewThread { box.v = AXUIElementPerformAction(e, action as CFString); sem.signal() }
  return sem.wait(timeout: .now() + grace) == .success ? box.v : nil
}

// MARK: - Safety: Esc stop, one session at a time, protected targets

final class Control {
  private let lock = NSLock()
  private var halted = false
  private var haltedAt: Date?
  private var active = 0
  private var lastMutationAt = Date.distantPast
  private var leaseHolder: String?
  private var leaseUntil = Date.distantPast
  static let leaseSeconds: TimeInterval = 120

  var isHalted: Bool { lock.lock(); defer { lock.unlock() }; return halted }

  // Esc only counts while we are driving the machine (or just were), so a user
  // pressing Esc in their own work an hour later is not a stop signal.
  func userEsc() {
    lock.lock(); defer { lock.unlock() }
    if active > 0 || Date().timeIntervalSince(lastMutationAt) < 20 {
      if !halted { log("user pressed Esc: computer use stopped") }
      halted = true; haltedAt = Date()
    }
  }
  func resume(_ session: String) { lock.lock(); halted = false; lock.unlock(); log("resumed by \(session)") }

  func holderConflict(_ session: String) -> String? {
    lock.lock(); defer { lock.unlock() }
    if let h = leaseHolder, h != session, leaseUntil > Date() { return h }
    return nil
  }
  func begin(_ session: String) {
    lock.lock(); active += 1; leaseHolder = session; leaseUntil = Date().addingTimeInterval(Control.leaseSeconds); lock.unlock()
  }
  func end() { lock.lock(); active -= 1; lastMutationAt = Date(); lock.unlock() }
  func release(_ session: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard leaseHolder == session else { return false }
    leaseHolder = nil; return true
  }
  func snapshot() -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    var r: [String: Any] = ["halted": halted]
    if let h = leaseHolder, leaseUntil > Date() { r["leaseHolder"] = h; r["leaseSecondsLeft"] = Int(leaseUntil.timeIntervalSinceNow) }
    if let t = haltedAt, halted { r["haltedAt"] = ISO8601DateFormatter().string(from: t) }
    return r
  }
}
let control = Control()
let mutationLane = NSLock()

// Password prompts, System Settings (where the agent could grant itself more
// power) and the login window are for the user's hands only, no override.
let PROTECTED_APPS: Set<String> = ["com.apple.systempreferences", "com.apple.SecurityAgent", "com.apple.loginwindow",
                                   "com.apple.Passwords", "com.apple.keychainaccess"]
// Shared system UI (Peekaboo's background-only denylist); override with allowSystem.
let SYSTEM_SURFACES: Set<String> = ["com.apple.controlcenter", "com.apple.notificationcenterui", "com.apple.Spotlight",
                                    "com.apple.systemuiserver", "com.apple.Siri", "com.apple.Passwords.MenuBarExtra"]
// Keystrokes here are shell commands (Claude's "equivalent to shell access");
// clicks are fine, typing needs allowTerminal after the user agreed.
let TERMINALS: Set<String> = ["com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty",
                              "net.kovidgoyal.kitty", "org.alacritty", "com.github.wez.wezterm", "co.zeit.hyper",
                              "com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92", "dev.zed.Zed"]

enum MutKind { case pointer, keyboard }

func withMutation(_ req: [String: Any], session: String, target: pid_t?, kind: MutKind,
                  _ body: () -> [String: Any]) -> [String: Any] {
  if !AXIsProcessTrusted() { return refused("accessibility-not-granted", "grant Accessibility to MultiCC Agent") }
  if screenLocked() { return refused("screen-locked", "the screen is locked; input would go to the login window. Wait for the user") }
  if control.isHalted {
    return refused("user-stopped", "the user pressed Esc to stop computer use: stop and ask the user; only run resume when they say so", retrySafe: false)
  }
  if let h = control.holderConflict(session) {
    return refused("busy", "another session (\(h)) is using the computer; wait or ask the user")
  }
  if let pid = target, let b = bundleOf(pid) {
    if PROTECTED_APPS.contains(b) { return refused("protected-app", "\(b) is for the user to operate (passwords, permissions, System Settings)", retrySafe: false) }
    if SYSTEM_SURFACES.contains(b) && !((req["allowSystem"] as? Bool) ?? false) {
      return refused("system-surface", "\(b) is shared system UI; pass allowSystem only if the task really needs it", retrySafe: false)
    }
    if kind == .keyboard && TERMINALS.contains(b) && !((req["allowTerminal"] as? Bool) ?? false) {
      return refused("terminal", "typing into \(b) is running shell commands; use your own shell tool, or pass allowTerminal after the user agrees", retrySafe: false)
    }
  }
  // One actor on the pointer/keyboard at a time, with Peekaboo's single 15s budget.
  let deadline = Date().addingTimeInterval(15)
  while !mutationLane.try() {
    if Date() > deadline { return refused("timeout", "input lane busy for 15s; nothing was sent") }
    usleep(20_000)
  }
  defer { mutationLane.unlock() }
  if control.isHalted { return refused("user-stopped", "the user pressed Esc to stop computer use", retrySafe: false) }
  control.begin(session)
  defer { control.end() }
  return body()
}

// MARK: - Operations (the whole attack surface; keep it small)

func elementFromRequest(_ req: [String: Any], session: String) -> (Snapshot, Elem)? {
  guard let snap = snapshots.get((req["snapshot"] as? String) ?? "latest", session: session) else { return nil }
  if let on = req["on"] as? String { return snap.elements.first { $0.id == on }.map { (snap, $0) } }
  if let q = req["query"] as? String, !q.isEmpty { return matchQuery(q, snap.elements).map { (snap, $0) } }
  return nil
}

func elementClick(_ req: [String: Any], session: String) -> [String: Any] {
  guard let (snap, el) = elementFromRequest(req, session: session) else {
    return refused("not-found", "no such snapshot or element; run see first")
  }
  let right = (req["button"] as? String) == "right"
  let count = Int(num(req["count"]) ?? 1)
  let strategy = (req["strategy"] as? String) ?? "auto"
  let info: [String: Any] = ["element": el.id, "label": el.desc ?? el.title ?? el.value ?? ""]
  return withMutation(req, session: session, target: snap.pid, kind: .pointer) {
    switch resolveLive(snap, el) {
    case .stale(let why):
      return refused("stale", "\(why); run see again")
    case .ok(let e, let f):
      snap.consumed = true
      if strategy != "synth" && count == 1 {
        let action = right ? "AXShowMenu" : kAXPressAction
        if axActions(e).contains(action) {
          switch performDetached(e, action, grace: right ? 0.5 : 2.0) {
          case .some(.success): return dispatched("ax_press", info)
          case .none: return dispatched("ax_press", info.merging(["note": "action still running (a menu or dialog probably opened)"]) { a, _ in a })
          case .some(let err): return indeterminate("ax_press", "AX action returned \(err.rawValue); look before retrying")
          }
        }
        if !right && TEXT_INPUT_ROLES.contains(el.role) {
          AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
          if (axCopy(e, kAXFocusedAttribute) as? NSNumber)?.boolValue == true {
            return dispatched("ax_focus", confirmed: true, info)
          }
        }
        if strategy == "action" {
          snap.consumed = false
          return refused("unsupported", "element has no \(action); use strategy synth")
        }
      }
      let p = CGPoint(x: f.midX, y: f.midY)
      click(p, right: right, count: count)
      return dispatched("hid_events", info.merging(["point": [Int(p.x), Int(p.y)]]) { a, _ in a })
    }
  }
}

func setValue(_ req: [String: Any], session: String) -> [String: Any] {
  guard let value = req["value"] as? String, value.count <= 20000 else { return ["ok": false, "error": "value is required (max 20000 chars)"] }
  guard let (snap, el) = elementFromRequest(req, session: session) else {
    return refused("not-found", "no such snapshot or element; run see first")
  }
  return withMutation(req, session: session, target: snap.pid, kind: .keyboard) {
    switch resolveLive(snap, el) {
    case .stale(let why):
      return refused("stale", "\(why); run see again")
    case .ok(let e, _):
      var settable: DarwinBoolean = false
      guard AXUIElementIsAttributeSettable(e, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else {
        return refused("unsupported", "value is not settable here; click it and use type instead")
      }
      snap.consumed = true
      let err = AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, value as CFString)
      if err != .success { return indeterminate("ax_value", "AX set returned \(err.rawValue)") }
      if el.role == "AXSecureTextField" { return dispatched("ax_value", ["element": el.id]) }
      return dispatched("ax_value", confirmed: axStr(axCopy(e, kAXValueAttribute)) == value, ["element": el.id])
    }
  }
}

// Cmd+Q/W/H/M sent to a background app closes or hides it without the user
// seeing why (Peekaboo BackgroundHotkeyPolicy).
let DANGEROUS_BACKGROUND_KEYS: Set<String> = ["q", "w", "h", "m"]

// MARK: - Platform tiers
// One source, several implementations chosen by what the running system (and
// the toolchain that compiled us) supports. Three gates, from outer to inner:
//   compile time  #if canImport(...) && compiler(>=X) — an older SDK/toolchain
//                 (macOS 11 ships Swift 5.5) simply leaves the block out; code
//                 inside may use newer Swift syntax.
//   link time     newer frameworks are weak-linked by the installer, so the
//                 same binary still launches on an older system.
//   run time      if #available picks the implementation; a failure in the
//                 newer path falls back to the older one and says so.
// Floor: macOS 11. Everything outside a gate must build and run there.

enum Platform {
  static let os = ProcessInfo.processInfo.operatingSystemVersion
  static var osString: String { "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)" }
  /// macOS 13 renamed System Preferences to System Settings (and the panes).
  static var settingsApp: String { os.majorVersion >= 13 ? "System Settings" : "System Preferences" }
  static var screenRecordingPane: String {
    os.majorVersion >= 13 ? "Privacy & Security > Screen & System Audio Recording"
                          : "Security & Privacy > Privacy > Screen Recording"
  }

  /// Capture backends this build + this OS can use, best first.
  static var captureBackends: [String] {
    var list: [String] = []
    #if canImport(ScreenCaptureKit) && compiler(>=5.9)
    if #available(macOS 14.0, *) { list.append("screencapturekit") }
    #endif
    list.append("screencapture")
    return list
  }

  static var snapshot: [String: Any] {
    ["os": osString, "captureBackends": captureBackends, "settingsApp": settingsApp,
     "screenRecordingPane": screenRecordingPane]
  }
}

func writePNG(_ image: CGImage, to path: String) -> Bool {
  guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL,
                                                   "public.png" as CFString, 1, nil) else { return false }
  CGImageDestinationAddImage(dest, image, nil)
  return CGImageDestinationFinalize(dest)
}

/// Legacy tier (macOS 11+): the system screencapture tool. It runs as our
/// child, so it is covered by OUR Screen Recording grant.
func captureWithTool(_ path: String, rect: [Int]?) -> String? {
  var args = ["-x"]
  if let r = rect { args += ["-R", r.map(String.init).joined(separator: ",")] }
  let (code, out) = runTool("/usr/sbin/screencapture", args + [path])
  return code == 0 ? nil : "screencapture failed: \(out)"
}

#if canImport(ScreenCaptureKit) && compiler(>=5.9)
/// macOS 14+ tier: in-process ScreenCaptureKit screenshot of the main display
/// at native pixel resolution — no subprocess. Completion handlers rather than
/// async/await, so no Swift concurrency runtime is needed on older systems.
@available(macOS 14.0, *)
func captureWithScreenCaptureKit(_ path: String, rect: [Int]?) -> String? {
  let sem = DispatchSemaphore(value: 0)
  var content: SCShareableContent?
  var failure: String?
  SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { c, e in
    content = c; failure = e.map { "shareable content: \($0.localizedDescription)" }; sem.signal()
  }
  if sem.wait(timeout: .now() + 5) == .timedOut { return "shareable content timed out" }
  guard let displays = content?.displays else { return failure ?? "no displays" }
  guard let display = displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? displays.first else {
    return "main display not found"
  }
  // Native pixels, same as screencapture (CGDisplayPixelsWide reports points on Retina).
  let mode = CGDisplayCopyDisplayMode(display.displayID)
  let scale = CGFloat(mode?.pixelWidth ?? display.width) / max(CGFloat(mode?.width ?? display.width), 1)
  let config = SCStreamConfiguration()
  config.showsCursor = false
  var size = CGSize(width: display.width, height: display.height)
  if let r = rect, r.count == 4 {
    config.sourceRect = CGRect(x: r[0], y: r[1], width: r[2], height: r[3])
    size = CGSize(width: r[2], height: r[3])
  }
  config.width = Int(size.width * scale)
  config.height = Int(size.height * scale)
  let filter = SCContentFilter(display: display, excludingWindows: [])
  var image: CGImage?
  SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { img, e in
    image = img; failure = e.map { "screenshot: \($0.localizedDescription)" }; sem.signal()
  }
  if sem.wait(timeout: .now() + 10) == .timedOut { return "screenshot timed out" }
  guard let img = image else { return failure ?? "no image" }
  return writePNG(img, to: path) ? nil : "could not write \(path)"
}
#endif

/// Tries the backends best-first (or only the one the caller forced) and
/// reports which one produced the file.
func capture(_ path: String, rect: [Int]?, forced: String?) -> [String: Any] {
  var tried: [String] = []
  for backend in Platform.captureBackends where forced == nil || forced == backend {
    var err: String?
    switch backend {
    case "screencapturekit":
      #if canImport(ScreenCaptureKit) && compiler(>=5.9)
      if #available(macOS 14.0, *) { err = captureWithScreenCaptureKit(path, rect: rect) }
      #endif
    default:
      err = captureWithTool(path, rect: rect)
    }
    if let e = err { tried.append("\(backend): \(e)"); continue }
    var r: [String: Any] = ["ok": true, "path": path, "backend": backend]
    if !tried.isEmpty { r["fellBackFrom"] = tried }
    return r
  }
  if tried.isEmpty { return ["ok": false, "error": "capture backend \(forced ?? "?") not available on macOS \(Platform.osString)"] }
  return ["ok": false, "error": tried.joined(separator: "; ")]
}

func handle(_ req: [String: Any]) -> [String: Any] {
  let op = req["op"] as? String ?? ""
  let session = String(((req["session"] as? String) ?? "anonymous").prefix(128))
  switch op {
  case "ping":
    return ["ok": true, "version": VERSION, "pid": Int(getpid())]
  case "status":
    return ["ok": true, "version": VERSION,
            "accessibility": AXIsProcessTrusted(),
            "screenRecording": CGPreflightScreenCaptureAccess(),
            "postEvents": CGPreflightPostEventAccess(),
            "platform": Platform.snapshot,
            "escMonitor": escMonitorInstalled,
            "listenAccess": CGPreflightListenEventAccess(),
            "escTaps": Dictionary(uniqueKeysWithValues: escTaps.map { ($0.name, $0.snapshot) }),
            "screenLocked": screenLocked(),
            "control": control.snapshot(),
            "snapshots": snapshots.count,
            "chrome": chrome.snapshot()]
  case "request-permissions":
    // Adds this app to the lists in System Settings with the switch off; the
    // user still has to flip them. Nothing here can grant itself anything.
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let ax = AXIsProcessTrustedWithOptions(opts)
    let sr = CGRequestScreenCaptureAccess()
    if !escMonitorInstalled { _ = CGRequestListenEventAccess() }
    return ["ok": true, "accessibility": ax, "screenRecording": sr]
  case "resume":
    control.resume(session)
    return ["ok": true, "halted": false]
  case "release":
    return ["ok": control.release(session)]
  case "see":
    return see(req, session: session)
  case "set":
    return setValue(req, session: session)
  case "click" where req["on"] != nil || req["query"] != nil:
    return elementClick(req, session: session)
  case "move", "click", "scroll":
    guard let x = num(req["x"]), let y = num(req["y"]) else { return ["ok": false, "error": "x and y are required"] }
    let p = CGPoint(x: x, y: y)
    return withMutation(req, session: session, target: pidAt(p), kind: .pointer) {
      if op == "move" {
        post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
      } else if op == "click" {
        click(p, right: (req["button"] as? String) == "right", count: Int(num(req["count"]) ?? 1))
      } else {
        post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
        let amount = Int32(max(-200, min(200, num(req["amount"]) ?? -5)))
        post(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: amount, wheel2: 0, wheel3: 0))
      }
      return dispatched("hid_events")
    }
  case "type":
    guard let text = req["text"] as? String, !text.isEmpty, text.count <= 4000 else {
      return ["ok": false, "error": "text is required (max 4000 chars)"]
    }
    let bgPid = num(req["pid"]).map { pid_t($0) }
    var target = bgPid ?? focusedAppPid()
    var pair: (Snapshot, Elem)?
    if req["on"] != nil || req["query"] != nil {
      guard let found = elementFromRequest(req, session: session) else {
        return refused("not-found", "no such snapshot or element; run see first")
      }
      pair = found; target = found.0.pid
    }
    return withMutation(req, session: session, target: target, kind: .keyboard) {
      if let (snap, el) = pair {
        switch resolveLive(snap, el) {
        case .stale(let why): return refused("stale", "\(why); run see again")
        case .ok(let e, _):
          snap.consumed = true
          AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
          usleep(80_000)
        }
      }
      if !typeText(text, pid: bgPid) {
        return ["ok": false, "outcome": "partial", "dispatched": "dispatched", "retrySafe": false,
                "reason": "user-stopped", "error": "the user pressed Esc while typing; part of the text was sent"]
      }
      return dispatched(bgPid == nil ? "hid_events" : "pid_events")
    }
  case "press":
    guard let keys = req["keys"] as? String else { return ["ok": false, "error": "keys is required, e.g. cmd+shift+g"] }
    let chord: (CGKeyCode, CGEventFlags, String)
    do { chord = try parseChord(keys) } catch ChordError.bad(let m) { return ["ok": false, "error": m] } catch { return ["ok": false, "error": "\(error)"] }
    let repeatCount = max(1, min(50, Int(num(req["repeat"]) ?? 1)))
    if (req["dryRun"] as? Bool) == true {
      return ["ok": true, "keyCode": Int(chord.0), "flags": NSNumber(value: chord.1.rawValue), "key": chord.2]
    }
    let bgPid = num(req["pid"]).map { pid_t($0) }
    if bgPid != nil && chord.1.contains(.maskCommand) && DANGEROUS_BACKGROUND_KEYS.contains(chord.2) {
      return refused("dangerous-background-hotkey", "cmd+\(chord.2) to a background app closes or hides it; bring it forward instead", retrySafe: false)
    }
    return withMutation(req, session: session, target: bgPid ?? focusedAppPid(), kind: .keyboard) {
      for i in 0..<repeatCount {
        if control.isHalted {
          return ["ok": false, "outcome": "partial", "dispatched": i > 0 ? "dispatched" : "none", "retrySafe": false,
                  "reason": "user-stopped", "error": "the user pressed Esc after \(i) of \(repeatCount) presses"]
        }
        postChord(chord.0, chord.1, pid: bgPid)
      }
      return dispatched(bgPid == nil ? "hid_events" : "pid_events")
    }
  case "snap":
    // The only caller input is the output file (absolute, .png, no "..") and
    // optionally which backend to use (see Platform tiers).
    guard let path = req["path"] as? String, path.hasPrefix("/"), path.hasSuffix(".png"),
          !path.contains("/../") else { return ["ok": false, "error": "path must be an absolute .png path"] }
    if !CGPreflightScreenCaptureAccess() {
      return ["ok": false, "error": "screen-recording-not-granted",
              "hint": "\(Platform.settingsApp) > \(Platform.screenRecordingPane)"]
    }
    var rect: [Int]?
    if let r = req["rect"] as? [NSNumber], r.count == 4 { rect = r.map { $0.intValue } }
    return capture(path, rect: rect, forced: req["backend"] as? String)
  default:
    return ["ok": false, "error": "unknown op: \(op)"]
  }
}

// MARK: - Esc monitor (Claude Code's global stop; Peekaboo has none)
// Listen-only: the key still reaches the app, we only raise the stop flag.

// Two listen-only taps watch for the user's Escape: HID level (first in line,
// before any other app's tap can swallow the key) and session level. Either
// one halting is enough. Counters are diagnostics only: key contents are never
// recorded, mouse events are counted to prove the tap is alive.
final class EscTap {
  let name: String
  let location: CGEventTapLocation
  var port: CFMachPort?
  var keyDowns = 0, escapes = 0, mouse = 0
  init(_ name: String, _ location: CGEventTapLocation) { self.name = name; self.location = location }

  func install() {
    if port != nil { return }
    let types: [CGEventType] = [.keyDown, .leftMouseDown, .rightMouseDown, .mouseMoved]
    let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
    let me = Unmanaged.passUnretained(self).toOpaque()
    guard let tap = CGEvent.tapCreate(tap: location, place: .headInsertEventTap, options: .listenOnly,
                                      eventsOfInterest: mask, callback: { _, type, event, info in
      let me = Unmanaged<EscTap>.fromOpaque(info!).takeUnretainedValue()
      switch type {
      case .tapDisabledByTimeout, .tapDisabledByUserInput:
        if let p = me.port { CGEvent.tapEnable(tap: p, enable: true) }
      case .keyDown:
        me.keyDowns += 1
        if event.getIntegerValueField(.keyboardEventKeycode) == 0x35,
           event.getIntegerValueField(.eventSourceUserData) != EVENT_MARK {
          me.escapes += 1
          control.userEsc()
        }
      default:
        me.mouse += 1
      }
      return Unmanaged.passUnretained(event)
    }, userInfo: me) else { return }
    port = tap
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    log("esc monitor installed (\(name))")
  }

  var snapshot: [String: Any] {
    ["installed": port != nil, "enabled": port.map { CGEvent.tapIsEnabled(tap: $0) } ?? false,
     "keyDowns": keyDowns, "escapes": escapes, "mouseEvents": mouse]
  }
}
let escTaps = [EscTap("hid", .cghidEventTap), EscTap("session", .cgSessionEventTap)]
var escMonitorInstalled: Bool { escTaps.contains { $0.port != nil } }
func installEscMonitor() { escTaps.forEach { $0.install() } }

// MARK: - Chrome keep-alive

final class ChromeWatch {
  private let lock = NSLock()
  private var up = false, misses = 0, launches = 0
  private var lastLaunch: Date?, lastProbe: Date?, lastResult = ""

  struct Config { var enabled = false; var port = 9222; var launch = "" }

  func config() -> Config {
    var c = Config()
    guard let data = FileManager.default.contents(atPath: configPath),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let ch = root["chrome"] as? [String: Any] else { return c }
    c.enabled = ch["enabled"] as? Bool ?? false
    c.port = (ch["port"] as? NSNumber)?.intValue ?? 9222
    c.launch = ch["launch"] as? String ?? ""
    return c
  }

  func probe(_ port: Int) -> Bool {
    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/json/version")!)
    req.timeoutInterval = 3
    let sem = DispatchSemaphore(value: 0)
    let ok = Box(false)
    URLSession.shared.dataTask(with: req) { _, resp, _ in
      ok.v = (resp as? HTTPURLResponse)?.statusCode == 200
      sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 5)
    return ok.v
  }

  func tick() {
    let c = config()
    let alive = probe(c.port)
    lock.lock(); up = alive; lastProbe = Date(); misses = alive ? 0 : misses + 1
    let misses_ = misses, recent = lastLaunch.map { Date().timeIntervalSince($0) < 90 } ?? false
    lock.unlock()
    // Two consecutive misses (~40s) before acting: skills routinely
    // `pkill` Chrome and relaunch it themselves with --refresh; relaunching in
    // between would make their launch script see ":9222 already up" and skip
    // the refresh. chrome.pause lets a script hold the watchdog off explicitly.
    guard c.enabled, !alive, misses_ >= 2, !recent, !c.launch.isEmpty,
          !FileManager.default.fileExists(atPath: pausePath) else { return }
    lock.lock(); lastLaunch = Date(); launches += 1; lock.unlock()
    log("chrome :\(c.port) down for \(misses_) probes, running \(c.launch)")
    let (code, out) = runTool("/bin/bash", [c.launch])
    lock.lock(); lastResult = "exit \(code): \(out.suffix(300))"; lock.unlock()
    log("chrome launch \(lastResult)")
  }

  func snapshot() -> [String: Any] {
    let c = config()
    lock.lock(); defer { lock.unlock() }
    let f = ISO8601DateFormatter()
    return ["enabled": c.enabled, "port": c.port, "up": up, "misses": misses, "launches": launches,
            "paused": FileManager.default.fileExists(atPath: pausePath),
            "lastProbeAt": lastProbe.map { f.string(from: $0) } ?? "",
            "lastLaunchAt": lastLaunch.map { f.string(from: $0) } ?? "", "lastLaunchResult": lastResult]
  }
}
let chrome = ChromeWatch()

// MARK: - Socket plumbing

func withSockAddr<T>(_ body: (UnsafePointer<sockaddr>, socklen_t) -> T) -> T {
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(sockPath.utf8CString)
  withUnsafeMutableBytes(of: &addr.sun_path) { raw in
    for (i, b) in bytes.prefix(raw.count - 1).enumerated() { raw[i] = UInt8(bitPattern: b) }
  }
  return withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { body($0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
  }
}

func readLine(_ fd: Int32) -> Data {
  var data = Data(); var byte: UInt8 = 0
  while data.count < 65536, read(fd, &byte, 1) == 1 {
    if byte == 10 { break }
    data.append(byte)
  }
  return data
}

func writeJSON(_ fd: Int32, _ obj: [String: Any]) {
  var data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"ok\":false}".utf8)
  data.append(10)
  _ = data.withUnsafeBytes { write(fd, $0.baseAddress, data.count) }
}

func serve() -> Never {
  mkdir(agentDir, 0o700)
  chmod(agentDir, 0o700)
  unlink(sockPath)
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0, withSockAddr({ bind(fd, $0, $1) }) == 0, listen(fd, 16) == 0 else {
    log("cannot listen on \(sockPath): \(String(cString: strerror(errno)))"); exit(1)
  }
  chmod(sockPath, 0o600)
  log("multicc-agent \(VERSION) serving \(sockPath) (accessibility=\(AXIsProcessTrusted()) screen=\(CGPreflightScreenCaptureAccess()))")

  let interval = Double(ProcessInfo.processInfo.environment["MULTICC_AGENT_CHROME_INTERVAL"] ?? "") ?? 20
  Thread.detachNewThread { while true { chrome.tick(); Thread.sleep(forTimeInterval: interval) } }

  Thread.detachNewThread {
    while true {
      let c = accept(fd, nil, nil)
      if c < 0 { continue }
      DispatchQueue.global().async {
        defer { close(c) }
        var uid: uid_t = 0, gid: gid_t = 0
        guard getpeereid(c, &uid, &gid) == 0, uid == getuid() else {
          writeJSON(c, ["ok": false, "error": "peer uid mismatch"]); return
        }
        let line = readLine(c)
        guard let req = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
          writeJSON(c, ["ok": false, "error": "request must be one JSON object per line"]); return
        }
        writeJSON(c, handle(req))
      }
    }
  }

  // The main run loop hosts the Esc event tap (and keeps NSWorkspace fresh).
  // The tap needs Accessibility; retry until it is granted.
  installEscMonitor()
  Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in installEscMonitor() }
  RunLoop.main.run()
  exit(0)
}

// MARK: - Client

func printSee(_ r: [String: Any]) {
  var head = "snapshot \(r["snapshot"] ?? "") app=\(r["app"] ?? "") pid=\(r["pid"] ?? "")"
  if let w = r["window"] { head += " window=\"\(w)\"" }
  if let f = r["windowFrame"] as? [Int] { head += " frame=\(f.map(String.init).joined(separator: ","))" }
  if let t = r["truncated"] { head += " truncated=\(t)" }
  if r["noWindow"] != nil { head += " NO-WINDOW" }
  if r["screenLocked"] != nil { head += " SCREEN-LOCKED" }
  print(head)
  for e in (r["elements"] as? [[String: Any]]) ?? [] {
    var line = "\(e["id"] ?? "") \(e["role"] ?? "")"
    if let l = e["label"] { line += " \"\(l)\"" }
    if let t = e["title"] { line += " title=\"\(t)\"" }
    if let v = e["value"] { line += " value=\"\(v)\"" }
    if let f = e["frame"] as? [Int] { line += " @\(f[0]),\(f[1]) \(f[2])x\(f[3])" }
    if e["enabled"] != nil { line += " [disabled]" }
    if e["actionable"] != nil { line += " [text]" }
    print(line)
  }
}

func client(_ args: [String]) -> Never {
  var req: [String: Any] = ["op": args[0]]
  var rest = Array(args.dropFirst())
  let json = rest.contains("--json")
  rest.removeAll { $0 == "--json" }
  let usage = { (s: String) -> Never in print("usage: \(s)"); exit(2) }
  switch args[0] {
  case "call":
    guard let s = rest.first, let obj = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] else {
      usage("MultiCCAgent call '{\"op\":\"...\"}'")
    }
    req = obj
  case "move", "click", "rclick", "dclick":
    guard rest.count >= 2, let x = Double(rest[0]), let y = Double(rest[1]) else { usage("\(args[0]) X Y") }
    req = ["op": args[0] == "move" ? "move" : "click", "x": x, "y": y,
           "button": args[0] == "rclick" ? "right" : "left", "count": args[0] == "dclick" ? 2 : 1]
  case "click-el", "rclick-el", "dclick-el":
    guard let id = rest.first else { usage("\(args[0]) ELEM_ID [SNAPSHOT]") }
    req = ["op": "click", "on": id, "snapshot": rest.count > 1 ? rest[1] : "latest",
           "button": args[0] == "rclick-el" ? "right" : "left", "count": args[0] == "dclick-el" ? 2 : 1]
  case "click-text":
    guard !rest.isEmpty else { usage("click-text TEXT") }
    req = ["op": "click", "query": rest.joined(separator: " "), "snapshot": "latest"]
  case "scroll":
    guard rest.count >= 3, let x = Double(rest[0]), let y = Double(rest[1]), let a = Double(rest[2]) else {
      usage("scroll X Y AMOUNT (negative = down)")
    }
    req = ["op": "scroll", "x": x, "y": y, "amount": a]
  case "type":
    req["text"] = rest.joined(separator: " ")
  case "type-el":
    guard rest.count >= 2 else { usage("type-el ELEM_ID TEXT") }
    req = ["op": "type", "on": rest[0], "snapshot": "latest", "text": rest.dropFirst().joined(separator: " ")]
  case "set":
    guard rest.count >= 2 else { usage("set ELEM_ID VALUE") }
    req = ["op": "set", "on": rest[0], "snapshot": "latest", "value": rest.dropFirst().joined(separator: " ")]
  case "press":
    guard let k = rest.first else { usage("press CHORD [REPEAT]  e.g. press cmd+shift+g, press return 3") }
    req = ["op": "press", "keys": k]
    if rest.count > 1, let n = Int(rest[1]) { req["repeat"] = n }
  case "see":
    if let a = rest.first { req["app"] = a }
  case "snap":
    guard let path = rest.first else { usage("snap /abs/out.png [x y w h]") }
    req["path"] = path
    if rest.count >= 5 { req["rect"] = rest[1...4].compactMap { Int($0) } }
    if let b = ProcessInfo.processInfo.environment["MULTICC_AGENT_CAPTURE"], !b.isEmpty { req["backend"] = b }
  default: break
  }
  if req["session"] == nil, let s = ProcessInfo.processInfo.environment["MULTICC_SESSION_ID"], !s.isEmpty {
    req["session"] = s
  }
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard withSockAddr({ connect(fd, $0, $1) }) == 0 else {
    print("{\"ok\":false,\"error\":\"agent-not-running\",\"socket\":\"\(sockPath)\"}"); exit(3)
  }
  writeJSON(fd, req)
  var reply = Data()
  var buf = [UInt8](repeating: 0, count: 65536)
  while true {
    let n = read(fd, &buf, buf.count)
    if n <= 0 { break }
    reply.append(contentsOf: buf[0..<n])
    if reply.last == 10 { break }
  }
  let obj = (try? JSONSerialization.jsonObject(with: reply)) as? [String: Any]
  if args[0] == "see", !json, let obj = obj, obj["ok"] as? Bool == true {
    printSee(obj)
  } else {
    print(String(data: reply, encoding: .utf8)?.trimmingCharacters(in: .newlines) ?? "")
  }
  exit((obj?["ok"] as? Bool ?? false) ? 0 : 1)
}

let argv = Array(CommandLine.arguments.dropFirst())
if argv.first == "serve" { serve() }
if argv.isEmpty || argv.first == "help" {
  print("""
  usage: MultiCCAgent serve | ping | status | request-permissions | resume | release
         see [APP|pid:N] [--json]            list elements of APP's front window (default: focused app)
         click-el|rclick-el|dclick-el ID     act on an element from the latest see (AXPress first)
         click-text TEXT                     best text match from the latest see
         set ID VALUE | type-el ID TEXT      write/type into an element
         press CHORD [N]                     e.g. cmd+shift+g, return, escape
         move|click|rclick|dclick X Y | scroll X Y N | type TEXT | snap /abs.png [x y w h] | call JSON
  """)
  exit(0)
}
client(argv)
