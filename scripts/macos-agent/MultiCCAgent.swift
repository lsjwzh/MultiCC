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
import Dispatch
import CoreGraphics
import ApplicationServices
import AppKit
import Security
import IOKit
import IOKit.pwr_mgt
import Darwin
import CoreImage
import CoreMedia
import CoreVideo
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif
import ImageIO

let VERSION = "3"
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
let automationEventSource = CGEventSource(stateID: .privateState)

func deliverAutomationEvent(_ e: CGEvent, pid: pid_t?) {
  if let pid = pid { e.postToPid(pid) } else { e.post(tap: .cghidEventTap) }
}

func post(_ e: CGEvent?, pid: pid_t? = nil, flags: CGEventFlags = []) {
  guard let e = e else { return }
  // Every operation declares its modifiers. Never inherit flags from an event
  // source's earlier chord or the current system state for a plain click/type.
  e.flags = flags
  e.setIntegerValueField(.eventSourceUserData, value: EVENT_MARK)
  deliverAutomationEvent(e, pid: pid)
}

func click(_ p: CGPoint, right: Bool, count: Int) {
  let down: CGEventType = right ? .rightMouseDown : .leftMouseDown
  let up: CGEventType = right ? .rightMouseUp : .leftMouseUp
  let button: CGMouseButton = right ? .right : .left
  post(CGEvent(mouseEventSource: automationEventSource, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: button))
  for i in 1...max(1, min(count, 3)) {
    for type in [down, up] {
      let e = CGEvent(mouseEventSource: automationEventSource, mouseType: type, mouseCursorPosition: p, mouseButton: button)
      e?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
      post(e)
    }
    usleep(30_000)
  }
}

// Press at a, smooth-step through ~60Hz leftMouseDragged events, release at b.
// Always releases, even when the user pauses/cancels halfway (no stuck button).
func drag(_ a: CGPoint, _ b: CGPoint, ms: Int) -> Bool {
  post(CGEvent(mouseEventSource: automationEventSource, mouseType: .mouseMoved, mouseCursorPosition: a, mouseButton: .left))
  post(CGEvent(mouseEventSource: automationEventSource, mouseType: .leftMouseDown, mouseCursorPosition: a, mouseButton: .left))
  usleep(40_000)
  let steps = max(4, ms / 16)
  var lastPoint = a
  var completed = true
  for i in 1...steps {
    if control.isHalted || (humanInput.isActive && humanInput.isPaused) { completed = false; break }
    let t = Double(i) / Double(steps), e = t * t * (3 - 2 * t)
    let p = CGPoint(x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e)
    post(CGEvent(mouseEventSource: automationEventSource, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left))
    lastPoint = p
    usleep(16_000)
  }
  // Release where we actually stopped, never jump to the original destination
  // after a person has taken over. A partial drag needs fresh observation.
  let releasePoint = completed ? lastPoint : (CGEvent(source: nil)?.location ?? lastPoint)
  post(CGEvent(mouseEventSource: automationEventSource, mouseType: .leftMouseUp, mouseCursorPosition: releasePoint, mouseButton: .left))
  return completed
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
  let initialTarget = pid ?? focusedAppPid()
  for chunk in Array(text.utf16).chunked(20) {
    if !waitForHumanIdle() || screenLocked() || (pid == nil && focusedAppPid() != initialTarget) { return false }
    for keyDown in [true, false] {
      let e = CGEvent(keyboardEventSource: automationEventSource, virtualKey: 0, keyDown: keyDown)
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
  let src = automationEventSource
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
    post(e, pid: pid, flags: flags)
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

// MARK: - Resident power runtime
// The Agent owns display transitions even when the web server is stopped.
// Unlocking happens only when computer use requests it. While the lid is
// closed we keep the display active but turn off its backlight and the built-in
// keyboard backlight. This requires a scoped idle-display assertion.
func lidModeEnabled() -> Bool? {
  // Only MultiCC's explicit choice authorizes lid handling and auto-unlock.
  // Another application's SleepDisabled assertion must never grant consent.
  let path = "/Library/Application Support/multicc/power-intent"
  guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return false }
  return text.trimmingCharacters(in: .whitespacesAndNewlines) == "on"
}

func lidClosed() -> Bool? {
  let root = IOServiceGetMatchingService(kIOMasterPortDefault, IOServiceMatching("IOPMrootDomain"))
  guard root != 0 else { return nil }
  defer { IOObjectRelease(root) }
  return IORegistryEntryCreateCFProperty(root, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? Bool
}

func automaticUnlockAllowed() -> Bool {
  if lidModeEnabled() == true { return true }
  let path = "\(agentDir)/power-settings.json"
  if !FileManager.default.fileExists(atPath: path) { return hasUnlockPassword() } // legacy consent
  guard let data = FileManager.default.contents(atPath: path),
        let settings = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
  return settings["autoUnlock"] as? Bool == true
}

final class LidDisplayGuard {
  private let lock = NSLock()
  private var state: [String: Any] = ["owner": "agent", "enabled": false]
  func snapshot() -> [String: Any] { lock.lock(); defer { lock.unlock() }; return state }
  private struct SavedBrightness: Codable {
    var display: Float
    var keyboard: Float
    var active: Bool
  }
  private let savedPath = "\(agentDir)/lid-brightness.json"
  private var saved: SavedBrightness?
  private var idleAssertion = IOPMAssertionID(0)
  private var displayLibrary: UnsafeMutableRawPointer?
  private var displayLookupAttempted = false
  private typealias GetBrightness = @convention(c) (UInt32, UnsafeMutablePointer<Float>) -> Int32
  private typealias SetBrightness = @convention(c) (UInt32, Float) -> Int32
  private var getBrightness: GetBrightness?
  private var setBrightness: SetBrightness?

  private func displayID() -> CGDirectDisplayID? {
    var ids = [CGDirectDisplayID](repeating: 0, count: 32)
    var count: UInt32 = 0
    guard CGGetOnlineDisplayList(UInt32(ids.count), &ids, &count) == .success else { return nil }
    return ids.prefix(Int(count)).first(where: { CGDisplayIsBuiltin($0) != 0 })
  }

  private func displayFunctions() -> Bool {
    if getBrightness != nil && setBrightness != nil { return true }
    if displayLookupAttempted { return false }
    displayLookupAttempted = true
    displayLibrary = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_NOW)
    guard let library = displayLibrary,
          let get = dlsym(library, "DisplayServicesGetBrightness"),
          let set = dlsym(library, "DisplayServicesSetBrightness") else { return false }
    getBrightness = unsafeBitCast(get, to: GetBrightness.self)
    setBrightness = unsafeBitCast(set, to: SetBrightness.self)
    return true
  }

  private func readDisplay() -> Float? {
    guard displayFunctions(), let id = displayID(), let get = getBrightness else { return nil }
    var value: Float = -1
    guard get(id, &value) == 0, value.isFinite, value >= 0, value <= 1 else { return nil }
    return value
  }

  private func writeDisplay(_ value: Float) -> Bool {
    if let actual = readDisplay(), abs(actual - value) < 0.02 { return true }
    guard displayFunctions(), let id = displayID(), let set = setBrightness,
          set(id, value) == 0, let actual = readDisplay() else { return false }
    return abs(actual - value) < 0.02
  }

  private func readKeyboard() -> MCKeyboardBrightness? {
    var result = MCKeyboardBrightness()
    return MCKeyboardRead(&result) == 0 ? result : nil
  }

  private func writeKeyboard(_ value: Float) -> Bool {
    guard let before = readKeyboard() else { return false }
    if abs(before.brightness - value) < 0.02 &&
       (value != 0 || before.backlightLevel < 0.05) { return true }
    var actual = MCKeyboardBrightness()
    guard MCKeyboardSet(before.identifier, value, &actual) == 0,
          abs(actual.brightness - value) < 0.02 else { return false }
    // A successful setter can leave the physical backlight unchanged.
    return value != 0 || actual.backlightLevel < 0.05
  }

  private func persist(_ value: SavedBrightness) -> Bool {
    guard let data = try? JSONEncoder().encode(value) else { return false }
    do {
      try FileManager.default.createDirectory(atPath: agentDir, withIntermediateDirectories: true)
      try data.write(to: URL(fileURLWithPath: savedPath), options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: savedPath)
      saved = value
      return true
    } catch { return false }
  }

  private func holdDisplayAwake() -> Bool {
    if idleAssertion != 0 { return true }
    return IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
      IOPMAssertionLevel(kIOPMAssertionLevelOn), "MultiCC closed lid desktop" as CFString,
      &idleAssertion) == kIOReturnSuccess
  }

  private func releaseDisplayAssertion() {
    if idleAssertion != 0 { IOPMAssertionRelease(idleAssertion); idleAssertion = 0 }
  }

  private func restore() -> Bool {
    guard let value = saved, value.active else { releaseDisplayAssertion(); return true }
    let displayOK = writeDisplay(value.display)
    let keyboardOK = writeKeyboard(value.keyboard)
    if displayOK && keyboardOK && persist(SavedBrightness(display: value.display,
        keyboard: value.keyboard, active: false)) {
      releaseDisplayAssertion()
      return true
    }
    return false // Keep the durable original for the next open/restart retry.
  }

  private func recordOpenBrightness() {
    guard let display = readDisplay(), let keyboard = readKeyboard() else { return }
    let keyboardValue = keyboard.suppressed != 0 ? (saved?.keyboard ?? keyboard.brightness) : keyboard.brightness
    let next = SavedBrightness(display: display, keyboard: keyboardValue, active: false)
    if let old = saved, !old.active,
       abs(old.display - next.display) < 0.02,
       abs(old.keyboard - next.keyboard) < 0.02 { return }
    _ = persist(next)
  }

  private func darken() -> Bool {
    guard let value = saved, !value.active, holdDisplayAwake(),
          persist(SavedBrightness(display: value.display, keyboard: value.keyboard, active: true)) else { return false }
    if writeDisplay(0) && writeKeyboard(0) { return true }
    _ = restore()
    return false
  }

  func run() {
    if let data = FileManager.default.contents(atPath: savedPath) {
      saved = try? JSONDecoder().decode(SavedBrightness.self, from: data)
    }
    while true {
      let enabled = lidModeEnabled()
      let closed = lidClosed()
      var error: String? = enabled == nil ? "power-state-unavailable" : nil
      if closed == false {
        if !restore() { error = "brightness-restore-failed" }
        else if enabled == true && closed == false { recordOpenBrightness() }
      } else if enabled != true {
        // Disabling the mode while closed must not turn the backlight on inside
        // the lid. Restore the durable snapshot after the lid opens.
        releaseDisplayAssertion()
      } else if closed == true {
        if saved?.active == true {
          if !holdDisplayAwake() || !writeDisplay(0) || !writeKeyboard(0) {
            error = "brightness-action-failed"
          }
        } else if !darken() { error = "brightness-action-failed" }
        if error == nil && screenLocked() { error = "desktop-locked" }
      }
      lock.lock()
      state = ["owner": "agent", "enabled": enabled == true,
               "closed": closed as Any? ?? NSNull(), "mode": saved?.active == true ? "backlight-off" : "normal",
               "error": error as Any? ?? NSNull()]
      lock.unlock()
      Thread.sleep(forTimeInterval: closed == true ? 2 : 0.2)
    }
  }
}
let lidDisplayGuard = LidDisplayGuard()

// MARK: - Lock-screen auto-unlock
// The login password lives in the user's login keychain under a dedicated
// service; the server writes it (Air global settings) and we only read it here,
// at the moment of unlocking. It never appears in replies, logs or snapshots.
let UNLOCK_KEYCHAIN_SERVICE = "com.multicc.agent.unlock"
let UNLOCK_KEYCHAIN_ACCOUNT = NSUserName()

enum UnlockRead {
  case ok(String)          // read it
  case missing             // nothing stored yet
  case needsAuthorization  // item is there, macOS wants the user to allow this app (or nobody answered)
  case failed              // any other read failure
}

// The item is created by the server (/usr/bin/security) and, per security(1),
// "the application which creates an item is trusted to access its data without
// warning" — the agent is a different application identity, so reading it can
// raise a SecurityAgent authorization sheet. That sheet cannot be answered on a
// locked screen, so two rules here:
//   1. uiAllowed=false passes kSecUseAuthenticationUIFail: when user
//      interaction would be required the read fails immediately, no sheet.
//   2. every read is bounded. Even if the system still puts a sheet up, only
//      this one read gives up — the request loop never parks inside securityd
//      (status used to decrypt the password on every call, and one locked-screen
//      status call wedged the whole computer-use chain for minutes).
func readUnlockPassword(uiAllowed: Bool, seconds: Double = 5) -> UnlockRead {
  var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: UNLOCK_KEYCHAIN_SERVICE,
    kSecAttrAccount as String: UNLOCK_KEYCHAIN_ACCOUNT,
    kSecReturnData as String: true,
    kSecMatchLimit as String: kSecMatchLimitOne,
  ]
  // kSecUseAuthenticationUI is deprecated since macOS 11 (Apple points at
  // LAContext.interactionNotAllowed instead) but it is what securityd actually
  // honours for the legacy ACL prompts this item can raise, so it stays.
  // Letting the system ask is the default, so the key is only set when the read
  // must not prompt.
  if !uiAllowed { query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail }
  var result = UnlockRead.failed
  let done = DispatchSemaphore(value: 0)
  DispatchQueue.global(qos: .userInitiated).async {
    var item: CFTypeRef?
    switch SecItemCopyMatching(query as CFDictionary, &item) {
    case errSecSuccess:
      if let data = item as? Data, let text = String(data: data, encoding: .utf8) { result = .ok(text) }
    case errSecItemNotFound:
      result = .missing
    case errSecInteractionNotAllowed, errSecAuthFailed, errSecUserCanceled:
      result = .needsAuthorization
    default:
      break
    }
    done.signal()
  }
  if done.wait(timeout: .now() + seconds) == .timedOut { return .needsAuthorization }
  return result
}

// Presence only: attributes, never kSecReturnData. status is a hot read-only
// call, and an attributes-only query does not decrypt and cannot raise a sheet
// (the same thing `security find-generic-password` does without -w).
func hasUnlockPassword() -> Bool {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: UNLOCK_KEYCHAIN_SERVICE,
    kSecAttrAccount as String: UNLOCK_KEYCHAIN_ACCOUNT,
    kSecReturnAttributes as String: true,
    kSecMatchLimit as String: kSecMatchLimitOne,
  ]
  var item: CFTypeRef?
  return SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess
}

// Called by the server right after the password is saved, while the user is
// still sitting in front of an unlocked screen: this is where the one-time
// "allow MultiCC Agent to read this item" sheet belongs. Answer it once with
// 始终允许 and the ACL keeps a grant that outlives agent rebuilds (the app is
// Developer ID signed, so the ACL records its identity and not a cdhash).
func probeUnlockAuthorization(_ req: [String: Any]) -> [String: Any] {
  let seconds = min(120, max(1, num(req["seconds"]) ?? 25))
  switch readUnlockPassword(uiAllowed: req["allowUI"] as? Bool == true && !screenLocked(), seconds: seconds) {
  case .ok: return ["ok": true, "authorized": true, "powerProtocol": 1]
  case .missing: return ["ok": true, "authorized": false, "reason": "no-password"]
  case .needsAuthorization: return ["ok": true, "authorized": false, "reason": "waiting-for-user"]
  case .failed: return ["ok": true, "authorized": false, "reason": "read-failed"]
  }
}

func loginwindowPid() -> pid_t? {
  NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.loginwindow").first?.processIdentifier
}

// Bounded depth-first walk that stops at the first element matching `match`.
// Used against loginwindow's tree while locked: the lock-screen password field
// is LoginUIKit's UserPasswordTextField, falling back to any secure/text field.
func findElement(_ root: AXUIElement, seconds: Double = 3, _ match: (AXUIElement) -> Bool) -> AXUIElement? {
  var stack: [AXUIElement] = [root]
  var seen = VisitSet()
  var visited = 0
  let deadline = Date().addingTimeInterval(seconds)
  while let e = stack.popLast() {
    guard seen.insert(e) else { continue }
    if Date() > deadline || visited >= 2000 { break }
    visited += 1
    axPrepare(e)
    if match(e) { return e }
    for k in axChildren(e).prefix(250).reversed() { stack.append(k) }
  }
  return nil
}

func unlockScreen(_ req: [String: Any]) -> [String: Any] {
  guard screenLocked() else { return ["ok": false, "error": "the screen is not locked"] }
  if control.isHalted && !control.clearIdleHalt() {
    return refused("user-stopped", "the user pressed Esc to stop computer use", retrySafe: false)
  }
  guard automaticUnlockAllowed() else {
    return refused("auto-unlock-disabled", "enable automatic unlock in MultiCC settings first", retrySafe: false)
  }
  let password: String
  switch readUnlockPassword(uiAllowed: false) {
  case .ok(let p):
    password = p
  case .missing:
    return refused("no-password", "no unlock password in the macOS keychain; set it in Air global settings (macOS 电源) -> 自动解锁", retrySafe: false)
  case .needsAuthorization:
    // retrySafe: false 和 no-password 同一用意：这不是重试能解决的，只有用户在**解锁的**
    // 屏幕上点一次「始终允许」才行，所以回执要拦住调用方的重试循环，让它去告诉用户。
    return refused("password-needs-authorization", "the keychain item exists but macOS has not been told to let MultiCC Agent read it; open Air global settings (macOS 电源) -> 自动解锁 and press 确认授权, then click 始终允许 in the system sheet (once is enough)", retrySafe: false)
  case .failed:
    return refused("password-unreadable", "the unlock password could not be read from the keychain", retrySafe: true)
  }
  guard let pid = loginwindowPid() else { return ["ok": false, "error": "loginwindow is not running"] }
  let app = AXUIElementCreateApplication(pid)
  axPrepare(app, 1)
  let fieldMatch: (AXUIElement) -> Bool = { e in
    if axStr(axCopy(e, kAXIdentifierAttribute)) == "UserPasswordTextField" { return true }
    let role = axStr(axCopy(e, kAXRoleAttribute)) ?? ""
    return role == "AXSecureTextField" || role == "AXTextField"
  }
  guard let field = findElement(app, fieldMatch) else {
    return refused("no-password-field", "loginwindow password field not found (locked UI still settling); retry in a moment", retrySafe: true)
  }
  axPrepare(field)
  var settable: DarwinBoolean = false
  guard AXUIElementIsAttributeSettable(field, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else {
    return refused("unsupported", "the password field does not accept an accessibility value")
  }
  let err = AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, password as CFString)
  guard err == .success else { return indeterminate("ax_value", "AX set returned \(err.rawValue)") }
  // Submit: press the lock screen's login button if present, otherwise post
  // Return to loginwindow directly (Secure Input blocks reading, not posting).
  let buttonMatch: (AXUIElement) -> Bool = { e in
    guard axStr(axCopy(e, kAXRoleAttribute)) == "AXButton" else { return false }
    let title = axStr(axCopy(e, kAXTitleAttribute))?.lowercased() ?? ""
    return title.contains("log") || title.contains("unlock") || title.contains("登录") || title.contains("解锁")
  }
  var submitted = "return"
  if let button = findElement(app, seconds: 1, buttonMatch), axActions(button).contains(kAXPressAction) {
    submitted = "ax_press"
    _ = performDetached(button, kAXPressAction, grace: 1.5)
  } else {
    postChord(KEYCODES["return"]!, [], pid: pid)
  }
  // Verify: poll until the session reports unlocked (up to 8s).
  let deadline = Date().addingTimeInterval(8)
  while Date() < deadline {
    if !screenLocked() { return dispatched("ax_unlock", confirmed: true, ["submitted": submitted]) }
    usleep(100_000)
  }
  return indeterminate("ax_unlock", "password submitted (\(submitted)) but the screen is still locked; the password may be wrong or the lock UI changed")
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

// MARK: - Manual pause arbitration
// The agent assumes it owns the machine. Keyboard and mouse activity is never
// read as "the user": the text cursor the agent itself opens, its own clicks and
// typing all look like input to the OS, so guessing made it wait on itself
// forever. Only the pause button on the floating bar holds automation back, and
// cancel (or Esc, when the optional tap is installed) stops it.
final class HumanInputGate {
  private let lock = NSLock()
  private var active = false
  private var paused = false
  private var visibleUntil = -Double.infinity
  static let lingerSeconds = 3.0
  var isActive: Bool { lock.lock(); defer { lock.unlock() }; return active }
  var isPaused: Bool { lock.lock(); defer { lock.unlock() }; return paused }

  func setPaused(_ value: Bool) { lock.lock(); paused = value; lock.unlock() }
  func begin(at now: Double) { lock.lock(); active = true; visibleUntil = now; lock.unlock() }
  func end(at now: Double) { lock.lock(); active = false; visibleUntil = now + HumanInputGate.lingerSeconds; lock.unlock() }
  func snapshot(at now: Double) -> (phase: String, visible: Bool) {
    lock.lock(); defer { lock.unlock() }
    return (paused ? "paused" : "running", active || paused || now < visibleUntil)
  }
}
let humanInput = HumanInputGate()
func inputClock() -> Double { ProcessInfo.processInfo.systemUptime }

// Floating control bar: translucent, never takes focus, draggable so it can be
// moved off whatever the agent needs to reach. Buttons accept the first click
// because the panel is non-activating.
final class HUDDragView: NSView {
  private var grab = NSPoint.zero
  override var mouseDownCanMoveWindow: Bool { false }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) {
    guard let w = window else { return }
    let m = NSEvent.mouseLocation
    grab = NSPoint(x: m.x - w.frame.origin.x, y: m.y - w.frame.origin.y)
  }
  override func mouseDragged(with event: NSEvent) {
    guard let w = window else { return }
    let m = NSEvent.mouseLocation
    w.setFrameOrigin(NSPoint(x: m.x - grab.x, y: m.y - grab.y))
  }
  override func mouseUp(with event: NSEvent) {
    guard let w = window else { return }
    UserDefaults.standard.set(NSStringFromPoint(w.frame.origin), forKey: "computerUseBarOrigin")
  }
}
final class HUDButton: NSButton {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class ComputerUseHUD: NSObject {
  private var panel: NSPanel?
  private var label: NSTextField?
  private var pauseButton: NSButton?
  private var cancelButton: NSButton?
  private var previous = ""
  private var showButtons = true
  private let size = NSSize(width: 300, height: 38)

  @objc func togglePause() { humanInput.setPaused(!humanInput.isPaused); log(humanInput.isPaused ? "paused from the control bar" : "resumed from the control bar") }
  @objc func cancel() { control.userStop(); humanInput.setPaused(false) }

  private func startOrigin() -> NSPoint {
    if let saved = UserDefaults.standard.string(forKey: "computerUseBarOrigin") {
      let o = NSPointFromString(saved)
      let r = NSRect(origin: o, size: size)
      if NSScreen.screens.contains(where: { $0.frame.intersects(r) }) { return o }
    }
    let f = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 800, height: 600)
    return NSPoint(x: f.midX - size.width / 2, y: f.maxY - size.height - 12)
  }
  private func button(_ x: CGFloat, _ action: Selector) -> NSButton {
    let b = HUDButton(title: "", target: self, action: action)
    b.frame = NSRect(x: x, y: 7, width: 68, height: 24)
    b.bezelStyle = .rounded; b.controlSize = .small; b.font = .systemFont(ofSize: 12)
    return b
  }
  private func build() {
    let p = NSPanel(contentRect: NSRect(origin: startOrigin(), size: size),
                    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.level = .statusBar; p.isFloatingPanel = true; p.hidesOnDeactivate = false
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = true
    let view = HUDDragView(frame: NSRect(origin: .zero, size: size))
    view.wantsLayer = true; view.layer?.cornerRadius = 10
    view.layer?.backgroundColor = NSColor(white: 0.1, alpha: 0.6).cgColor
    let l = NSTextField(labelWithString: "")
    l.frame = NSRect(x: 12, y: 9, width: 140, height: 20)
    l.font = .systemFont(ofSize: 13, weight: .medium); l.textColor = .white
    view.addSubview(l)
    let pause = button(156, #selector(togglePause)), stop = button(226, #selector(cancel))
    stop.title = "取消"
    // A stop notice has nothing left to click, so its window carries no buttons.
    if showButtons { view.addSubview(pause); view.addSubview(stop) }
    p.contentView = view
    panel = p; label = l; pauseButton = pause; cancelButton = stop
  }

  func update() {
    let state = humanInput.snapshot(at: inputClock())
    let halted = control.isHalted
    // A cancel is a confirmation, not a state to sit in: its notice shows for a
    // few seconds and then the bar leaves, lease or no lease. Everything else
    // keeps the bar up for as long as the AI session holds the lease.
    let show = halted ? control.stopNoticeActive() : (state.visible || control.automationLeaseActive)
    guard show else { panel?.orderOut(nil); panel = nil; previous = ""; return }
    // A dead button bezel kept painting itself on the translucent panel when it
    // was only hidden, so a change of mode builds a fresh window instead.
    if panel == nil || showButtons == halted {
      panel?.orderOut(nil); panel = nil; previous = ""
      showButtons = !halted
      build()
    }
    let text = halted ? "已取消 · 自动操作已停止" : (state.phase == "paused" ? "已暂停" : "AI 正在操作")
    let title = state.phase == "paused" ? "继续" : "暂停"
    let key = text + "|" + title
    if key != previous {
      label?.stringValue = text; pauseButton?.title = title
      previous = key
    }
    panel?.orderFrontRegardless()
  }
}
let computerUseHUD = ComputerUseHUD()

// Wait in the mutation worker; the main run loop keeps painting the bar. Only an
// explicit pause holds automation, bounded so a forgotten pause cannot wedge the
// input lane forever.
func waitForHumanIdle() -> Bool {
  // Remote-screen input is the user's own manual control, not AI automation.
  if !humanInput.isActive { return !control.isHalted }
  let deadline = inputClock() + 300
  while !control.isHalted {
    if !humanInput.isPaused { return true }
    if inputClock() >= deadline { return false }
    usleep(20_000)
  }
  return false
}

// MARK: - Safety: Esc stop, one session at a time, protected targets

final class Control {
  private let lock = NSLock()
  private var halted = false
  private var haltedAt: Date?
  private var stopNoticeUntil = Date.distantPast
  private var active = 0
  private var lastMutationAt = Date.distantPast
  private var leaseHolder: String?
  private var leaseUntil = Date.distantPast
  static let leaseSeconds: TimeInterval = 120
  static let stopNoticeSeconds: TimeInterval = 4

  var isHalted: Bool { lock.lock(); defer { lock.unlock() }; return halted }

  // Esc only counts while we are driving the machine (or just were), so a user
  // pressing Esc in their own work an hour later is not a stop signal.
  // Esc / the cancel button is a ONE-SHOT cancel: it aborts the operation in
  // flight and nothing more. It must not latch — a cancel pressed once should
  // never block every later dispatch until someone runs resume.
  func userEsc() {
    lock.lock(); defer { lock.unlock() }
    if active > 0 || Date().timeIntervalSince(lastMutationAt) < 20 {
      if !halted { log("user pressed Esc: computer use stopped") }
      haltLocked()
    }
  }
  // The control bar's cancel button: unlike Esc it is an explicit click on our
  // own UI, so it stops regardless of whether an operation is in flight.
  func userStop() {
    lock.lock(); defer { lock.unlock() }
    if !halted { log("cancelled from the control bar: computer use stopped") }
    haltLocked()
  }
  private func haltLocked() {
    halted = true; haltedAt = Date()
    stopNoticeUntil = Date().addingTimeInterval(Control.stopNoticeSeconds)
  }
  // A halt with no operation in flight is the residue of a cancel that already
  // did its job. Clear it and report whether anything was cleared, so callers
  // can proceed instead of refusing forever.
  func clearIdleHalt() -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard halted, active == 0 else { return false }
    halted = false; stopNoticeUntil = Date.distantPast
    log("halt cleared: the cancelled operation already ended (one-shot cancel)")
    return true
  }
  // The stop is announced and then the bar leaves. The halt itself is a
  // one-shot marker: it clears when the interrupted operation ends (or at the
  // next dispatch, if none was running), so nobody needs to resume by hand.
  func stopNoticeActive(at now: Date = Date()) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return halted && stopNoticeUntil > now
  }
  // An AI session still holds the lease (renewed by each operation, dropped by
  // release): the control bar stays up through the model's thinking time between
  // operations instead of flashing like a toast. Manual remote control is not AI.
  var automationLeaseActive: Bool {
    lock.lock(); defer { lock.unlock() }
    if let h = leaseHolder, h != "remote-screen", leaseUntil > Date() { return true }
    return false
  }
  func resume(_ session: String) {
    lock.lock(); halted = false; stopNoticeUntil = Date.distantPast; lock.unlock()
    log("resumed by \(session)")
  }

  func holderConflict(_ session: String) -> String? {
    lock.lock(); defer { lock.unlock() }
    if let h = leaseHolder, h != session, leaseUntil > Date() { return h }
    return nil
  }
  func begin(_ session: String) {
    lock.lock(); active += 1; leaseHolder = session; leaseUntil = Date().addingTimeInterval(Control.leaseSeconds); lock.unlock()
  }
  func end() {
    lock.lock(); active -= 1; lastMutationAt = Date()
    // One-shot cancel: once the interrupted operation has ended, the halt flag
    // clears itself so the next dispatch proceeds without a manual resume.
    if active <= 0 && halted {
      halted = false; stopNoticeUntil = Date.distantPast
      log("halt cleared on operation end (one-shot cancel)")
    }
    lock.unlock()
  }
  func release(_ session: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard leaseHolder == session else { return false }
    leaseHolder = nil; return true
  }
  func snapshot() -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    var r: [String: Any] = ["halted": halted]
    let input = humanInput.snapshot(at: inputClock())
    r["inputState"] = input.visible ? (halted ? "stopped" : input.phase) : "idle"
    r["resumeSecondsLeft"] = 0
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
  if control.isHalted && !control.clearIdleHalt() {
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
  if let h = control.holderConflict(session) { return refused("busy", "another session (\(h)) is using the computer") }
  if control.isHalted && !control.clearIdleHalt() { return refused("user-stopped", "the user pressed Esc to stop computer use", retrySafe: false) }
  control.begin(session)
  let automation = session != "remote-screen"
  if automation {
    humanInput.begin(at: inputClock())
    DispatchQueue.main.sync { computerUseHUD.update() }
  }
  defer { if automation { humanInput.end(at: inputClock()) }; control.end() }
  guard waitForHumanIdle() else {
    return refused(control.isHalted ? "user-stopped" : "user-active",
                   "computer use paused from the control bar; nothing was sent", retrySafe: !control.isHalted)
  }
  // The user may have switched windows during the pause. Re-check protection
  // and refuse stale foreground/coordinate targets before delivering input.
  if screenLocked() { return refused("screen-locked", "screen locked while computer use was paused") }
  let current: pid_t?
  if let x = num(req["x"]), let y = num(req["y"]) { current = pidAt(CGPoint(x: x, y: y)) }
  else if req["pid"] == nil && req["on"] == nil && req["query"] == nil { current = focusedAppPid() }
  else { current = target }
  if current != target { return refused("stale", "input target changed while paused; observe the screen again") }
  if let pid = current, let b = bundleOf(pid), PROTECTED_APPS.contains(b) {
    return refused("protected-app", "target became protected while paused", retrySafe: false)
  }
  if automation { DispatchQueue.main.sync { computerUseHUD.update() } }
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
    return ["ok": true, "version": VERSION, "pid": Int(getpid()), "powerProtocol": 1]
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
            // Global top-left points, same domain as remote-screen pointer input:
            // lets scripts/remote-screen-probe.js prove a hover reached the OS.
            "cursor": (CGEvent(source: nil)?.location).map { [Int($0.x.rounded()), Int($0.y.rounded())] } ?? [],
            "unlockPassword": hasUnlockPassword(),
            "lidGuard": lidDisplayGuard.snapshot(),
            "control": control.snapshot(),
            "snapshots": snapshots.count,
            "chrome": chrome.snapshot()]
  case "request-permissions":
    // Adds this app to the lists in System Settings with the switch off; the
    // user still has to flip them. Nothing here can grant itself anything.
    // Input Monitoring is deliberately NOT requested: it exists only for the
    // optional Esc stop, and desktop computer use can always be cancelled with
    // the chat's stop button instead.
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let ax = AXIsProcessTrustedWithOptions(opts)
    let sr = CGRequestScreenCaptureAccess()
    return ["ok": true, "accessibility": ax, "screenRecording": sr]
  case "resume":
    control.resume(session)
    return ["ok": true, "halted": false]
  case "release":
    #if canImport(ScreenCaptureKit) && compiler(>=5.9)
    if session == "remote-screen", #available(macOS 14.0, *) { HttpScreenPointers.shared.releaseAll() }
    #endif
    return ["ok": control.release(session)]
  case "pointer":
    #if canImport(ScreenCaptureKit) && compiler(>=5.9)
    guard session == "remote-screen", #available(macOS 14.0, *) else { return refused("unsupported", "pointer is reserved for the remote screen viewer", retrySafe: false) }
    guard let viewer = req["viewer"] as? String, !viewer.isEmpty, viewer.count <= 64,
          let mask = num(req["mask"]), mask == 0 || mask == 1,
          let x = num(req["x"]), let y = num(req["y"]) else { return ["ok": false, "error": "viewer, mask, x and y are required"] }
    return HttpScreenPointers.shared.pointer(viewer, mask: Int(mask), x: Int(x), y: Int(y))
    #else
    return refused("unsupported", "live pointers require macOS 14 or newer", retrySafe: false)
    #endif
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
        post(CGEvent(mouseEventSource: automationEventSource, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
      } else if op == "click" {
        click(p, right: (req["button"] as? String) == "right", count: Int(num(req["count"]) ?? 1))
      } else {
        post(CGEvent(mouseEventSource: automationEventSource, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
        let amount = Int32(max(-200, min(200, num(req["amount"]) ?? -5)))
        post(CGEvent(scrollWheelEvent2Source: automationEventSource, units: .line, wheelCount: 1, wheel1: amount, wheel2: 0, wheel3: 0))
      }
      return dispatched("hid_events")
    }
  case "dragdown":
    // Press only; the live-drag path owns the release (rfbDragEnd). Reserved for the
    // remote-screen viewer — any other caller would leave the button stuck down.
    guard session == "remote-screen" else { return refused("unsupported", "dragdown is reserved for the remote screen viewer", retrySafe: false) }
    guard let x = num(req["x"]), let y = num(req["y"]) else { return ["ok": false, "error": "x and y are required"] }
    let a = CGPoint(x: x, y: y)
    return withMutation(req, session: session, target: pidAt(a), kind: .pointer) {
      post(CGEvent(mouseEventSource: automationEventSource, mouseType: .mouseMoved, mouseCursorPosition: a, mouseButton: .left))
      post(CGEvent(mouseEventSource: automationEventSource, mouseType: .leftMouseDown, mouseCursorPosition: a, mouseButton: .left))
      return dispatched("hid_events")
    }
  case "drag":
    guard let x = num(req["x"]), let y = num(req["y"]), let x2 = num(req["x2"]), let y2 = num(req["y2"]) else {
      return ["ok": false, "error": "x, y, x2 and y2 are required"]
    }
    let a = CGPoint(x: x, y: y), b = CGPoint(x: x2, y: y2)
    return withMutation(req, session: session, target: pidAt(a), kind: .pointer) {
      if !drag(a, b, ms: Int(max(80, min(3000, num(req["ms"]) ?? 300)))) {
        return ["ok": false, "outcome": "partial", "dispatched": "dispatched", "retrySafe": false,
                "reason": control.isHalted ? "user-stopped" : "user-active",
                "error": "drag interrupted by user input; button released. Observe before continuing"]
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
                "reason": control.isHalted ? "user-stopped" : "user-active",
                "error": "typing interrupted or target changed while paused; part of the text may have been sent"]
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
    let targetForPress = bgPid ?? focusedAppPid()
    return withMutation(req, session: session, target: targetForPress, kind: .keyboard) {
      for i in 0..<repeatCount {
        if !waitForHumanIdle() || screenLocked() || (bgPid == nil && focusedAppPid() != targetForPress) {
          return ["ok": false, "outcome": "partial", "dispatched": i > 0 ? "dispatched" : "none", "retrySafe": false,
                  "reason": control.isHalted ? "user-stopped" : "user-active",
                  "error": "input interrupted or target changed after \(i) of \(repeatCount) presses"]
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
  case "unlock":
    return unlockScreen(req)
  case "probe-unlock":
    return probeUnlockAuthorization(req)
  default:
    return ["ok": false, "error": "unknown op: \(op)"]
  }
}

// MARK: - Esc monitor (opportunistic bonus; the chat stop button is the primary stop)
// Listen-only: the key still reaches the app, we only raise the stop flag.

// Two listen-only taps watch for the user's Escape: HID level (first in line,
// before any other app's tap can swallow the key) and session level. Either
// one halting is enough. Counters are diagnostics only: key contents are never
// recorded, mouse events are counted to prove the tap is alive.
// Event types the optional Esc tap listens to (Esc itself plus mouse/keyboard
// counters for diagnostics); they no longer decide whether the user is "active".
let HUMAN_EVENT_TYPES: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .mouseMoved,
  .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
  .otherMouseDown, .otherMouseUp, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel]
final class EscTap {
  let name: String
  let location: CGEventTapLocation
  var port: CFMachPort?
  var keyDowns = 0, escapes = 0, mouse = 0
  init(_ name: String, _ location: CGEventTapLocation) { self.name = name; self.location = location }

  func install() {
    if port != nil { return }
    let types = HUMAN_EVENT_TYPES
    let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
    let me = Unmanaged.passUnretained(self).toOpaque()
    guard let tap = CGEvent.tapCreate(tap: location, place: .headInsertEventTap, options: .listenOnly,
                                      eventsOfInterest: mask, callback: { _, type, event, info in
      let me = Unmanaged<EscTap>.fromOpaque(info!).takeUnretainedValue()
      // Ignore ALL our synthetic input, including key-up and mouse movement.
      if event.getIntegerValueField(.eventSourceUserData) == EVENT_MARK { return Unmanaged.passUnretained(event) }
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
// Opportunistic only: install the taps when the user has already granted Input
// Monitoring (a leftover from an older MultiCC), and never ask for it. Stopping
// computer use is the chat's stop button's job; Esc is a nice extra when present.
func installEscMonitor() { guard CGPreflightListenEventAccess() else { return }; escTaps.forEach { $0.install() } }

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

// MARK: - RFB streaming server (「🖥 屏幕」流畅模式)
//
// A second unix socket (agentDir/rfb.sock) speaks a minimal RFB 3.8 server so
// the browser can run the stock noVNC client, security type None — the peer is authenticated by the MultiCC server (same-site WS +
// ticket, exactly like /ws/chat) and checked with getpeereid here, so no TCP
// port is opened. Frames come from an SCStream that renders each
// CMSampleBuffer into a BGRA bitmap at logical resolution, and the diff both
// finds dirty rows and narrows their column extent to 32px blocks, served on
// the client's FramebufferUpdateRequests (natural backpressure: no request, no
// bytes). Encoding follows what each client announced in SetEncodings:
//   - Tight clients (noVNC) are switched to full logical resolution with a
//     DesktopSize update and get JPEG for large changes, solid fills, and
//     zlib for small ones; every 64px tile sent as JPEG is re-sent lossless
//     once IT has been still for 300ms (a spinner elsewhere must not keep
//     the whole screen blurry), so text ends up sharp. Cursor pseudo-encoding lets
//     the viewer draw the pointer locally while it is driving.
//   - Clients that announce nothing (the Flutter App) keep Raw at
//     logical/RFB_DIV — full-res Raw is multi-MB per frame (a 2026-10-04
//     trace measured 247KB for ONE cursor move at 1470-wide bands).
// Pointer coordinates map RFB px → CGEvent points by the client's divisor. Input
// (PointerEvent/KeyEvent) is routed through handle() so every existing guard
// applies unchanged: single lease, Esc halt, lock-screen refusal, protected
// apps, terminal typing consent. Below macOS 14 (or builds without
// ScreenCaptureKit) the socket simply does not exist and the web UI falls
// back to JPEG polling.

#if canImport(ScreenCaptureKit) && compiler(>=5.9)
import zlib
import ImageIO

// Coalescing must cover EVERY accumulated change, including nested bands.
// Bounding-union (not the incoming band's bottom edge) avoids leaving pixels
// from an older frame permanently visible when a wide update is followed by
// a smaller cursor/animation update before the client asks for its next frame.
func mergeRfbDirtyRects(_ dirty: [CGRect], full: CGRect) -> [CGRect] {
  var merged: [CGRect] = []
  for r in dirty.sorted(by: { $0.minY < $1.minY }) {
    if let last = merged.last, last.maxY >= r.minY {
      merged[merged.count - 1] = last.union(r)
    } else { merged.append(r) }
  }
  let area = merged.reduce(CGFloat(0)) { $0 + $1.width * $1.height }
  return merged.count > 64 || area > full.width * full.height * 0.7 ? [full] : merged
}

// Raw-only clients get 1/RFB_DIV of logical resolution (bandwidth tier: 2
// keeps text readable on phones while cutting bytes 4x). Tight clients run at
// divisor 1. Pointer coords scale back up by the client's own divisor.
let RFB_DIV = 2
let RFB_ENC_RAW: Int32 = 0
let RFB_ENC_TIGHT: Int32 = 7
let RFB_PSEUDO_DESKTOP_SIZE: Int32 = -223
let RFB_PSEUDO_CURSOR: Int32 = -239
let RFB_PSEUDO_QUALITY0: Int32 = -32    // ...-23 = JPEG quality level 0...9
let RFB_TILE = 64                       // lossless-refinement granularity, client px

extension Data {
  mutating func appendBE(_ v: UInt16) { append(UInt8(v >> 8)); append(UInt8(v & 0xFF)) }
  mutating func appendBE(_ v: UInt32) {
    append(UInt8((v >> 24) & 0xFF)); append(UInt8((v >> 16) & 0xFF))
    append(UInt8((v >> 8) & 0xFF)); append(UInt8(v & 0xFF))
  }
}

func readFully(_ fd: Int32, _ n: Int) -> Data? {
  var out = Data(capacity: n)
  var tmp = [UInt8](repeating: 0, count: 4096)
  while out.count < n {
    let want = min(tmp.count, n - out.count)
    let r = tmp.withUnsafeMutableBytes { read(fd, $0.baseAddress, want) }
    if r < 0 && errno == EINTR { continue }
    if r <= 0 { return nil }
    out.append(contentsOf: tmp[0..<r])
  }
  return out
}

func writeAll(_ fd: Int32, _ d: Data) -> Bool {
  var off = 0
  return d.withUnsafeBytes { raw -> Bool in
    while off < d.count {
      let w = write(fd, raw.baseAddress! + off, d.count - off)
      if w < 0 && errno == EINTR { continue }
      if w <= 0 { return false }
      off += w
    }
    return true
  }
}

@available(macOS 14.0, *)
final class RfbClient: NSObject {
  let fd: Int32
  let cond = NSCondition()
  var closed = false
  var pendingRequest = false   // client is owed a FramebufferUpdate (cond)
  var servedAny = false        // has ever sent an update (cond) — idle keepalive vs dead capture
  var connectedAt = Date()
  // dirty band state, guarded by RfbScreen's lock
  var needsFull = true
  var framebufferSize: (w: Int, h: Int)?
  var dirty: [CGRect] = []
  // pointer state
  var lastMask = 0
  var downPos: CGPoint?
  var downAt = Date.distantPast
  // live touch drag: the left button is physically held down (see rfbLeftHeldMove)
  let dragLock = NSLock()
  var liveDrag = false         // mouse-down was posted, mouse-up still owed (dragLock)
  var dragDead = false         // this press may not start/continue a drag: refused, halted, locked (dragLock)
  var liveDragPos = CGPoint.zero
  var liveDragAt = Date.distantPast
  var lastClickAt = Date.distantPast
  var lastClickPos = CGPoint.zero
  var lastMoveAt = Date.distantPast
  var lastMovePos = CGPoint.zero
  var mods: Set<String> = []
  var hoverMoves = false       // H.264 viewer: no-button motion moves the real cursor (rfbHover)
  // negotiated state, guarded by RfbScreen's lock
  var div = RFB_DIV            // client framebuffer = logical / div
  var swapRB = false           // SetPixelFormat asked for RGBX (noVNC) instead of our BGRX
  var tight = false
  var cursorEnc = false
  var desktopSize = false
  var quality = 6              // Tight JPEG level 0...9 (noVNC default 6); -1 = lossless only
  var pendingResize = false
  var tileCols = 0             // RFB_TILE grid over the client framebuffer (Tight clients)
  var lossyTile: [Bool] = []   // last sent as JPEG, owes a lossless re-send
  var tileTouched: [Double] = []   // last change or JPEG send (timeIntervalSinceReferenceDate)
  var lastPointerAt = Date.distantPast
  var cursorKey = 0            // shape last sent with the cursor pseudo-encoding (0 = none)
  var zlib: AnyObject?         // Tight zlib stream 0 (RfbZlib), lives as long as the connection
  init(_ fd: Int32) { self.fd = fd }
  func wake() { cond.lock(); cond.broadcast(); cond.unlock() }
  var isClosed: Bool { cond.lock(); defer { cond.unlock() }; return closed }
  func requestUpdate() { cond.lock(); pendingRequest = true; cond.broadcast(); cond.unlock() }
  func beginUpdate() -> Bool {
    cond.lock(); defer { cond.unlock() }
    while !closed && !pendingRequest { cond.wait() }
    if closed { return false }
    // Consume BEFORE writing. A fast client can request the next update as
    // soon as the last byte is sent; never erase that new request afterwards.
    pendingRequest = false
    return true
  }
  func didServeUpdate() { cond.lock(); servedAny = true; cond.unlock() }
  func shutdown() {
    cond.lock()
    if closed { cond.unlock(); return }
    closed = true; cond.broadcast(); cond.unlock()
    // Unblock both threads, but only serveRfb owns close(fd). Multiple closes
    // could close a descriptor already reused by an unrelated connection.
    _ = Darwin.shutdown(fd, SHUT_RDWR)
  }
}

/// One persistent deflate stream (Tight stream 0). Each rect ends with
/// Z_SYNC_FLUSH so the client's inflator stays in lockstep and keeps the
/// dictionary across rects (noVNC inflates with expected-length reads).
@available(macOS 14.0, *)
final class RfbZlib {
  private let strm = UnsafeMutablePointer<z_stream>.allocate(capacity: 1)
  private var ok = false
  init(level: Int32) {
    strm.initialize(to: z_stream())
    ok = deflateInit_(strm, level, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK
  }
  deinit {
    if ok { deflateEnd(strm) }
    strm.deinitialize(count: 1)
    strm.deallocate()
  }
  func compress(_ input: [UInt8]) -> Data? {
    guard ok else { return nil }
    var src = input
    var out = Data()
    var buf = [UInt8](repeating: 0, count: 65536)
    let good = src.withUnsafeMutableBufferPointer { inp -> Bool in
      strm.pointee.next_in = inp.baseAddress
      strm.pointee.avail_in = uInt(inp.count)
      repeat {
        let r: Int32 = buf.withUnsafeMutableBufferPointer { o in
          strm.pointee.next_out = o.baseAddress
          strm.pointee.avail_out = uInt(o.count)
          return deflate(strm, Z_SYNC_FLUSH)
        }
        if r != Z_OK && r != Z_BUF_ERROR { return false }
        out.append(contentsOf: buf[0..<(buf.count - Int(strm.pointee.avail_out))])
      } while strm.pointee.avail_out == 0
      return true
    }
    if !good { ok = false }   // a broken stream cannot be resumed; the caller drops the client
    return good ? out : nil
  }
}

@available(macOS 14.0, *)
func rfbRectHeader(_ x: Int, _ y: Int, _ w: Int, _ h: Int, _ enc: Int32) -> Data {
  var d = Data(capacity: 12)
  d.appendBE(UInt16(x)); d.appendBE(UInt16(y)); d.appendBE(UInt16(w)); d.appendBE(UInt16(h))
  d.appendBE(UInt32(bitPattern: enc))
  return d
}

/// Tight "compact length": 7 bits per byte, at most 3 bytes.
@available(macOS 14.0, *)
func tightLength(_ n: Int) -> Data {
  var d = Data([UInt8(n & 0x7F)])
  if n > 0x7F {
    d[0] |= 0x80; d.append(UInt8((n >> 7) & 0x7F))
    if n > 0x3FFF { d[1] |= 0x80; d.append(UInt8((n >> 14) & 0xFF)) }
  }
  return d
}

@available(macOS 14.0, *)
func rfbJpeg(_ bgra: [UInt8], _ w: Int, _ h: Int, quality: Double) -> Data? {
  let out = NSMutableData()
  let info = CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.noneSkipFirst.rawValue)
  guard let provider = CGDataProvider(data: Data(bgra) as CFData),
        let img = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: info, provider: provider,
                          decode: nil, shouldInterpolate: false, intent: .defaultIntent),
        let dest = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else { return nil }
  CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
  return CGImageDestinationFinalize(dest) ? out as Data : nil
}

// Tight JPEG quality per noVNC level 0...9.
let RFB_JPEG_QUALITY: [Double] = [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.72, 0.8, 0.88, 0.95]

/// Current system cursor as a Cursor pseudo-encoding rect (BGRX pixels +
/// 1-bit mask, hotspot in x/y), at 1x point size: browsers draw cursor images
/// unscaled, so this matches what the user sees on the Mac.
@available(macOS 14.0, *)
func rfbCursorShape() -> (key: Int, rect: Data)? {
  let cur = NSCursor.currentSystem ?? NSCursor.arrow
  let img = cur.image
  let w = Int(img.size.width.rounded(.up)), h = Int(img.size.height.rounded(.up))
  guard w > 0, h > 0, w <= 128, h <= 128 else { return nil }
  var box = CGRect(x: 0, y: 0, width: CGFloat(w), height: CGFloat(h))
  let info = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
  guard let cg = img.cgImage(forProposedRect: &box, context: nil, hints: nil),
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: info) else { return nil }
  ctx.draw(cg, in: CGRect(x: 0, y: 0, width: CGFloat(w), height: CGFloat(h)))
  guard let base = ctx.data else { return nil }
  let p = base.bindMemory(to: UInt8.self, capacity: w * h * 4)
  let maskRow = (w + 7) / 8
  var pixels = [UInt8](repeating: 0, count: w * h * 4)
  var mask = [UInt8](repeating: 0, count: maskRow * h)
  for y in 0..<h {
    for x in 0..<w {
      let i = (y * w + x) * 4
      let a = Int(p[i + 3])
      guard a >= 128 else { continue }   // RFB cursors have a 1-bit mask: soft shadow is dropped
      for k in 0..<3 { pixels[i + k] = UInt8(min(255, Int(p[i + k]) * 255 / a)) }   // un-premultiply BGR
      mask[y * maskRow + x / 8] |= UInt8(0x80 >> (x % 8))
    }
  }
  let hx = min(w - 1, max(0, Int(cur.hotSpot.x))), hy = min(h - 1, max(0, Int(cur.hotSpot.y)))
  var hasher = Hasher()
  hasher.combine(pixels); hasher.combine(mask); hasher.combine(hx); hasher.combine(hy)
  var rect = rfbRectHeader(hx, hy, w, h, RFB_PSEUDO_CURSOR)
  rect.append(contentsOf: pixels); rect.append(contentsOf: mask)
  return (key: hasher.finalize() | 2, rect: rect)   // | 2: never 0 (none) or 1 (blank)
}

@available(macOS 14.0, *)
final class RfbScreen: NSObject, SCStreamOutput {
  static let shared = RfbScreen()
  // 1x1 fully transparent cursor: the viewer shows no local pointer while
  // the real one is baked into the frames.
  static let blankCursor: (key: Int, rect: Data) = {
    var d = rfbRectHeader(0, 0, 1, 1, RFB_PSEUDO_CURSOR)
    d.append(contentsOf: [0, 0, 0, 0, 0])
    return (key: 1, rect: d)
  }()
  private let lock = NSLock()
  private var stream: SCStream?
  private var config: SCStreamConfiguration?
  private let ciCtx = CIContext()
  private var clients: [RfbClient] = []
  private var w = 0, h = 0
  private var fb = [UInt8]()   // BGRA, w*h*4, logical resolution
  private(set) var hasFrame = false
  private var cursorHidden = false            // stream currently excludes the pointer
  private var cursorCheckAt = Date.distantPast
  private var shape = RfbScreen.blankCursor   // cached system cursor, refreshed ≤10Hz
  private var shapeAt = Date.distantPast

  var size: (w: Int, h: Int)? { lock.lock(); defer { lock.unlock() }; return w > 0 ? (w, h) : nil }

  private func acquire() -> String? {
    let sem = DispatchSemaphore(value: 0)
    var content: SCShareableContent?
    var errText: String?
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { c, e in
      content = c; if let e { errText = "shareable content: \(e.localizedDescription)" }; sem.signal()
    }
    if sem.wait(timeout: .now() + 5) == .timedOut { return "shareable content timed out" }
    guard let display = content?.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content?.displays.first else {
      return errText ?? "no displays"
    }
    let cfg = SCStreamConfiguration()
    cfg.showsCursor = true
    cfg.width = max(1, Int(display.width))   // logical points: 1px = 1pt
    cfg.height = max(1, Int(display.height))
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    cfg.queueDepth = 3
    let s = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: cfg, delegate: nil)
    do { try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "multicc.rfb.frames")) }
    catch { return "addStreamOutput: \(error.localizedDescription)" }
    var startErr: String?
    let sem2 = DispatchSemaphore(value: 0)
    s.startCapture { e in if let e { startErr = e.localizedDescription }; sem2.signal() }
    if sem2.wait(timeout: .now() + 5) == .timedOut { return "startCapture timed out" }
    if let startErr { return "startCapture: \(startErr)" }
    lock.lock()
    stream = s; config = cfg; cursorHidden = false
    w = max(1, Int(display.width)); h = max(1, Int(display.height))
    lock.unlock()
    return nil
  }

  private func releaseCapture() {
    lock.lock(); let s = stream; stream = nil; config = nil; lock.unlock()
    guard let s else { return }
    let sem = DispatchSemaphore(value: 0)
    s.stopCapture { _ in sem.signal() }
    _ = sem.wait(timeout: .now() + 2)
  }

  func attach(_ c: RfbClient) {
    lock.lock(); let wasEmpty = clients.isEmpty; clients.append(c); lock.unlock()
    if wasEmpty, let err = acquire() { log("rfb: \(err)") }
  }

  func detach(_ c: RfbClient) {
    lock.lock(); clients.removeAll { $0 === c }; let nowEmpty = clients.isEmpty; lock.unlock()
    if nowEmpty { releaseCapture() }
  }

  func markFull(_ c: RfbClient) {
    lock.lock(); c.needsFull = true; lock.unlock()
  }

  /// SetPixelFormat: we only ever emit 32bpp true colour; honour the R/B order.
  func setPixelFormat(_ c: RfbClient, _ pf: Data) {
    let b = [UInt8](pf)   // 3 padding + PIXEL_FORMAT
    guard b.count >= 16, b[3] == 32, b[6] != 0, b[5] == 0 else { return }
    lock.lock(); c.swapRB = b[13] == 0 && b[15] == 16; lock.unlock()
  }

  func setEncodings(_ c: RfbClient, _ encs: [Int32]) {
    lock.lock(); defer { lock.unlock() }
    c.tight = encs.contains(RFB_ENC_TIGHT)
    c.cursorEnc = encs.contains(RFB_PSEUDO_CURSOR)
    c.desktopSize = encs.contains(RFB_PSEUDO_DESKTOP_SIZE)
    if let q = encs.first(where: { $0 >= RFB_PSEUDO_QUALITY0 && $0 <= RFB_PSEUDO_QUALITY0 + 9 }) {
      c.quality = Int(q - RFB_PSEUDO_QUALITY0)
    } else { c.quality = -1 }
    // Level 6 regardless of the client's compress hint: ~10% smaller than
    // noVNC's default 2 on UI frames and cheap on any Mac that has SCK.
    if c.tight && c.zlib == nil { c.zlib = RfbZlib(level: 6) }   // never reset: the client inflator is persistent
    if c.tight && c.desktopSize && c.div != 1 { c.pendingResize = true }
    c.cursorKey = 0
  }

  /// Records viewer pointer activity; returns the client's divisor for coordinate mapping.
  func notePointer(_ c: RfbClient) -> Int {
    lock.lock(); defer { lock.unlock() }
    c.lastPointerAt = Date()
    return c.div
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen else { return }
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[AnyHashable: Any]]
    let status = (attachments?.first?[SCStreamFrameInfo.status] as? NSNumber)?.intValue ?? SCFrameStatus.complete.rawValue
    guard status == SCFrameStatus.complete.rawValue, let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let pw = CVPixelBufferGetWidth(pb), ph = CVPixelBufferGetHeight(pb)
    guard pw > 0, ph > 0 else { return }
    var next = [UInt8](repeating: 0, count: pw * ph * 4)
    let ci = CIImage(cvPixelBuffer: pb)
    next.withUnsafeMutableBytes { dst in
      ciCtx.render(ci, toBitmap: dst.baseAddress!, rowBytes: pw * 4,
                   bounds: CGRect(x: 0, y: 0, width: CGFloat(pw), height: CGFloat(ph)),
                   format: .BGRA8, colorSpace: CGColorSpaceCreateDeviceRGB())
    }
    lock.lock()
    defer { lock.unlock() }
    var bands: [CGRect] = []
    if pw != w || ph != h || fb.count != next.count {
      w = pw; h = ph; fb = next; hasFrame = true
      bands = [CGRect(x: 0, y: 0, width: CGFloat(pw), height: CGFloat(ph))]
    } else {
      // Row diff, but each band also narrows to the changed COLUMNS (32px
      // block granularity): a cursor move otherwise ships a full-width band
      // (1470x22 ≈ 130KB) where ~40px actually changed. memcmp, not slice
      // ==: this runs over the full logical-res frame up to 30 times/s.
      let rowBytes = pw * 4
      let blk = 32   // px granularity of the column bounds
      next.withUnsafeBytes { nb in
        fb.withUnsafeBytes { ob in
          let n = nb.baseAddress!, o = ob.baseAddress!
          func rowDiffers(_ y: Int) -> Bool { memcmp(n + y * rowBytes, o + y * rowBytes, rowBytes) != 0 }
          var y = 0
          while y < ph {
            guard rowDiffers(y) else { y += 1; continue }
            let y0 = y
            var bx0 = pw, bx1 = 0
            repeat {
              var b = 0
              while b < pw {
                let off = y * rowBytes + b * 4, len = (min(pw, b + blk) - b) * 4
                if memcmp(n + off, o + off, len) != 0 { bx0 = min(bx0, b); bx1 = max(bx1, min(pw, b + blk)) }
                b += blk
              }
              y += 1
            } while y < ph && rowDiffers(y)
            bands.append(CGRect(x: CGFloat(bx0), y: CGFloat(y0), width: CGFloat(bx1 - bx0), height: CGFloat(y - y0)))
          }
        }
      }
      if !bands.isEmpty { fb = next; hasFrame = true }
    }
    if bands.isEmpty { return }
    let full = CGRect(x: 0, y: 0, width: CGFloat(w), height: CGFloat(h))
    let now = Date().timeIntervalSinceReferenceDate
    for c in clients where !c.needsFull {
      c.dirty = mergeRfbDirtyRects(c.dirty + bands, full: full)
      if c.div == 1 { for b in bands { touchTiles(c, b, now, lossy: nil) } }
    }
    for c in clients { c.wake() }
  }

  /// Marks the RFB_TILE tiles under `r` (client px) as changed at `now`;
  /// `lossy` also sets/clears their owed-lossless flag. Caller holds the lock.
  private func touchTiles(_ c: RfbClient, _ r: CGRect, _ now: Double, lossy: Bool?) {
    guard c.tileCols > 0 else { return }
    let rows = c.lossyTile.count / c.tileCols
    let x0 = max(0, Int(r.minX) / RFB_TILE), x1 = min(c.tileCols - 1, (Int(r.maxX) - 1) / RFB_TILE)
    let y0 = max(0, Int(r.minY) / RFB_TILE), y1 = min(rows - 1, (Int(r.maxY) - 1) / RFB_TILE)
    guard x0 <= x1, y0 <= y1 else { return }
    for ty in y0...y1 {
      for tx in x0...x1 {
        c.tileTouched[ty * c.tileCols + tx] = now
        if let lossy { c.lossyTile[ty * c.tileCols + tx] = lossy }
      }
    }
  }

  /// JPEG tiles untouched for 300ms, as row runs, cleared from the owed set.
  /// Caller holds the lock.
  private func takeRefineRects(_ c: RfbClient, cw: Int, ch: Int) -> [CGRect] {
    guard c.tight, c.tileCols > 0 else { return [] }
    let now = Date().timeIntervalSinceReferenceDate
    let rows = c.lossyTile.count / c.tileCols
    var out: [CGRect] = []
    for ty in 0..<rows {
      var tx = 0
      while tx < c.tileCols {
        let i = ty * c.tileCols + tx
        guard c.lossyTile[i], now - c.tileTouched[i] >= 0.3 else { tx += 1; continue }
        let start = tx
        while tx < c.tileCols && c.lossyTile[ty * c.tileCols + tx] && now - c.tileTouched[ty * c.tileCols + tx] >= 0.3 {
          c.lossyTile[ty * c.tileCols + tx] = false
          tx += 1
        }
        let x = start * RFB_TILE, y = ty * RFB_TILE
        out.append(CGRect(x: x, y: y, width: min(cw, tx * RFB_TILE) - x, height: min(ch, y + RFB_TILE) - y))
      }
    }
    // Stack identical spans of adjacent rows into one rect.
    var merged: [CGRect] = []
    for r in out {
      if let i = merged.lastIndex(where: { $0.minX == r.minX && $0.width == r.width && $0.maxY == r.minY }) {
        merged[i] = merged[i].union(r)
      } else { merged.append(r) }
    }
    return merged
  }

  /// Pointer drawn by the viewer (cursor pseudo-encoding) while EVERY viewer
  /// is actively driving with a cursor-capable client: it then tracks their
  /// own mouse with zero latency and stops producing dirty rects. Anyone just
  /// watching (view-only, the Raw App, or idle for 10s) keeps it baked into
  /// the frames, so AI- or locally-driven pointer motion stays visible.
  private func syncCursorMode() {
    lock.lock()
    let now = Date()
    guard now.timeIntervalSince(cursorCheckAt) >= 0.1, let s = stream, let cfg = config else { lock.unlock(); return }
    cursorCheckAt = now
    let hide = !clients.isEmpty && clients.allSatisfy { $0.cursorEnc && now.timeIntervalSince($0.lastPointerAt) < 10 }
    let changed = hide != cursorHidden
    if changed { cursorHidden = hide; cfg.showsCursor = !hide }
    lock.unlock()
    if changed {
      s.updateConfiguration(cfg) { e in if let e { log("rfb: cursor mode: \(e.localizedDescription)") } }
    }
  }

  private func cursorUpdate(_ c: RfbClient) -> Data? {
    lock.lock()
    let wanted = c.cursorEnc, hidden = cursorHidden, stale = Date().timeIntervalSince(shapeAt) >= 0.1
    if hidden && stale { shapeAt = Date() }
    lock.unlock()
    guard wanted else { return nil }
    var next = RfbScreen.blankCursor
    if hidden {
      if stale, let s = rfbCursorShape() { lock.lock(); shape = s; lock.unlock() }
      lock.lock(); next = shape; lock.unlock()
      if next.key == RfbScreen.blankCursor.key { next = rfbCursorShape() ?? next }
    }
    lock.lock(); defer { lock.unlock() }
    if next.key == c.cursorKey { return nil }
    c.cursorKey = next.key
    return next.rect
  }

  /// Copies one client-px rect out of the logical framebuffer (2x2 box
  /// average for divisor 2). Caller holds the lock.
  private func pixels(_ x: Int, _ y: Int, _ rw: Int, _ rh: Int, div: Int) -> [UInt8] {
    if div == 1 {
      var d = [UInt8](repeating: 0, count: rw * rh * 4)
      for line in 0..<rh {
        let src = ((y + line) * w + x) * 4
        d.replaceSubrange((line * rw * 4)..<((line + 1) * rw * 4), with: fb[src..<(src + rw * 4)])
      }
      return d
    }
    var d = [UInt8](repeating: 0, count: rw * rh * 4)
    fb.withUnsafeBufferPointer { (src: UnsafeBufferPointer<UInt8>) -> Void in
      for cy in 0..<rh {
        for cx in 0..<rw {
          let sx = (x + cx) * div, sy = (y + cy) * div
          let sx2 = min(w - 1, sx + div - 1), sy2 = min(h - 1, sy + div - 1)
          let a = (sy * w + sx) * 4, b = (sy * w + sx2) * 4, c = (sy2 * w + sx) * 4, e = (sy2 * w + sx2) * 4
          let o = (cy * rw + cx) * 4
          for k in 0..<4 {
            var sum = Int(src[a + k]) + Int(src[b + k])
            sum += Int(src[c + k]) + Int(src[e + k])
            d[o + k] = UInt8((sum + 2) / 4)
          }
        }
      }
    }
    return d
  }

  /// Next FramebufferUpdate body for this client as encoded rectangles
  /// (12-byte header + payload each), or nil when there is nothing to send.
  func takeUpdate(_ c: RfbClient) -> [Data]? {
    syncCursorMode()
    var out: [Data] = []
    if let cur = cursorUpdate(c) { out.append(cur) }
    lock.lock()
    guard w > 0, h > 0, fb.count == w * h * 4 else { lock.unlock(); return out.isEmpty ? nil : out }
    let targetDiv = c.pendingResize ? 1 : c.div
    let cw = w / targetDiv, ch = h / targetDiv
    if let size = c.framebufferSize, c.pendingResize || size.w != cw || size.h != ch {
      guard c.desktopSize else {
        // No DesktopSize support: reconnect rather than patching
        // new-resolution pixels into the old client framebuffer.
        lock.unlock(); c.shutdown(); return nil
      }
      c.pendingResize = false
      c.div = targetDiv; c.framebufferSize = (cw, ch)
      c.needsFull = true; c.dirty = []
      c.tileCols = 0   // re-gridded below on the next update
      lock.unlock()
      out.append(rfbRectHeader(0, 0, cw, ch, RFB_PSEUDO_DESKTOP_SIZE))
      return out
    }
    let div = c.div
    if c.tight && c.tileCols == 0 {
      c.tileCols = (cw + RFB_TILE - 1) / RFB_TILE
      let tiles = c.tileCols * ((ch + RFB_TILE - 1) / RFB_TILE)
      c.lossyTile = [Bool](repeating: false, count: tiles)
      c.tileTouched = [Double](repeating: 0, count: tiles)
    }
    let fullC = CGRect(x: 0, y: 0, width: CGFloat(cw), height: CGFloat(ch))
    var rects: [CGRect] = []
    if c.needsFull {
      rects = [fullC]
    } else if !c.dirty.isEmpty {
      // logical-px dirty bands → client px, rounded outwards
      rects = mergeRfbDirtyRects(c.dirty, full: CGRect(x: 0, y: 0, width: CGFloat(w), height: CGFloat(h))).map { r in
        let x0 = Int(r.minX) / div, y0 = Int(r.minY) / div
        let x1 = min(cw, (Int(r.maxX) + div - 1) / div), y1 = min(ch, (Int(r.maxY) + div - 1) / div)
        return CGRect(x: CGFloat(x0), y: CGFloat(y0), width: CGFloat(max(0, x1 - x0)), height: CGFloat(max(0, y1 - y0)))
      }
    }
    // Lossless re-sends ride along with ordinary updates, so constant small
    // changes elsewhere never starve them.
    let refine = c.needsFull ? [] : takeRefineRects(c, cw: cw, ch: ch)
    if rects.isEmpty && refine.isEmpty { lock.unlock(); return out.isEmpty ? nil : out }
    c.needsFull = false
    c.dirty = []
    var jobs: [(x: Int, y: Int, w: Int, h: Int, px: [UInt8], lossless: Bool)] = []
    for (r, lossless) in rects.map({ ($0, false) }) + refine.map({ ($0, true) }) {
      let x = max(0, Int(r.minX)), y = max(0, Int(r.minY))
      let rw = min(cw - x, Int(r.width)), rh = min(ch - y, Int(r.height))
      guard rw > 0, rh > 0 else { continue }
      jobs.append((x, y, rw, rh, pixels(x, y, rw, rh, div: div), lossless))
    }
    let tight = c.tight, swapRB = c.swapRB, quality = c.quality, zlib = c.zlib as? RfbZlib
    lock.unlock()
    // Encode outside the lock: JPEG/deflate must not stall the capture callback.
    var sentLossy: [CGRect] = []
    for j in jobs {
      if !tight {
        var px = j.px
        if swapRB { var i = 0; while i < px.count { px.swapAt(i, i + 2); i += 4 } }
        var d = rfbRectHeader(j.x, j.y, j.w, j.h, RFB_ENC_RAW)
        d.append(contentsOf: px)
        out.append(d)
        continue
      }
      guard let zlib, let enc = encodeTight((j.x, j.y, j.w, j.h, j.px), zlib: zlib,
                                            jpegQuality: j.lossless ? -1 : quality, lossy: &sentLossy) else {
        c.shutdown(); return nil
      }
      out.append(contentsOf: enc)
    }
    if !sentLossy.isEmpty {
      let now = Date().timeIntervalSinceReferenceDate
      lock.lock(); for r in sentLossy { touchTiles(c, r, now, lossy: true) }; lock.unlock()
    }
    return out.isEmpty ? nil : out
  }

  /// Tight rects for one region: solid → fill, large → JPEG (recorded in
  /// `lossy` for the later lossless pass), otherwise zlib-compressed RGB.
  /// Tight caps rect width at 2048, so wider regions are tiled.
  private func encodeTight(_ j: (x: Int, y: Int, w: Int, h: Int, px: [UInt8]), zlib: RfbZlib,
                           jpegQuality: Int, lossy: inout [CGRect]) -> [Data]? {
    var out: [Data] = []
    let useJpeg = jpegQuality >= 0 && j.w * j.h >= 16384
    // zlib rects are cut into strips so one compact length (≤4MB) always fits.
    let maxRows = useJpeg ? j.h : max(1, 262144 / min(j.w, 2048))
    var tx = 0
    while tx < j.w {
      let tw = min(2048, j.w - tx)
      var ty = 0
      while ty < j.h {
        let th = min(maxRows, j.h - ty)
        var px = [UInt8](repeating: 0, count: tw * th * 4)
        for line in 0..<th {
          let src = ((ty + line) * j.w + tx) * 4
          px.replaceSubrange((line * tw * 4)..<((line + 1) * tw * 4), with: j.px[src..<(src + tw * 4)])
        }
        var d = rfbRectHeader(j.x + tx, j.y + ty, tw, th, RFB_ENC_TIGHT)
        let solid: Bool = px.withUnsafeBytes { raw in
          let p = raw.bindMemory(to: UInt32.self)
          let first = p[0] & 0x00FF_FFFF
          for i in 1..<p.count where p[i] & 0x00FF_FFFF != first { return false }
          return true
        }
        if solid {
          d.append(0x80); d.append(contentsOf: [px[2], px[1], px[0]])           // fill: TPIXEL is R,G,B
        } else if useJpeg, let jpeg = rfbJpeg(px, tw, th, quality: RFB_JPEG_QUALITY[min(9, jpegQuality)]) {
          d.append(0x90); d.append(tightLength(jpeg.count)); d.append(jpeg)
          lossy.append(CGRect(x: j.x + tx, y: j.y + ty, width: tw, height: th))
        } else {
          var rgb = [UInt8](repeating: 0, count: tw * th * 3)
          var i = 0, o = 0
          while i < px.count { rgb[o] = px[i + 2]; rgb[o + 1] = px[i + 1]; rgb[o + 2] = px[i]; i += 4; o += 3 }
          d.append(0x00)                                                        // basic, stream 0, copy filter
          if rgb.count < 12 { d.append(contentsOf: rgb) }
          else {
            guard let z = zlib.compress(rgb) else { return nil }
            d.append(tightLength(z.count)); d.append(z)
          }
        }
        out.append(d)
        ty += th
      }
      tx += tw
    }
    return out
  }
}

// X11 keysyms → our key names / modifiers (see parseChord for the grammar).
let RFB_SPECIAL_KEYS: [UInt32: String] = [
  0xFF08: "delete", 0xFF09: "tab", 0xFF0D: "return", 0xFF1B: "escape", 0xFFFF: "forwarddelete",
  0xFF50: "home", 0xFF51: "left", 0xFF52: "up", 0xFF53: "right", 0xFF54: "down",
  0xFF55: "pageup", 0xFF56: "pagedown", 0xFF57: "end", 0x0020: "space",
]
let RFB_MOD_KEYS: [UInt32: String] = [
  0xFFE1: "shift", 0xFFE2: "shift", 0xFFE3: "ctrl", 0xFFE4: "ctrl",
  0xFFE9: "alt", 0xFFEA: "alt", 0xFE03: "alt",
  0xFFE7: "cmd", 0xFFE8: "cmd", 0xFFEB: "cmd", 0xFFEC: "cmd",
]
// Punctuation keysyms → (US-layout base key, needs shift); only used when a
// ctrl/cmd/alt chord turns the printable path off.
let RFB_PUNCT_KEYS: [UInt32: (String, Bool)] = [
  0x21: ("1", true), 0x40: ("2", true), 0x23: ("3", true), 0x24: ("4", true), 0x25: ("5", true),
  0x5E: ("6", true), 0x26: ("7", true), 0x2A: ("8", true), 0x28: ("9", true), 0x29: ("0", true),
  0x3C: ("comma", true), 0x3E: ("period", true), 0x3F: ("slash", true), 0x3A: ("semicolon", true),
  0x7B: ("leftbracket", true), 0x7D: ("rightbracket", true), 0x7C: ("backslash", true),
  0x22: ("quote", true), 0x5F: ("minus", true), 0x2B: ("equal", true), 0x7E: ("grave", true),
  0x2C: ("comma", false), 0x2D: ("minus", false), 0x2E: ("period", false), 0x2F: ("slash", false),
  0x3B: ("semicolon", false), 0x3D: ("equal", false), 0x5B: ("leftbracket", false),
  0x5C: ("backslash", false), 0x5D: ("rightbracket", false), 0x27: ("quote", false), 0x60: ("grave", false),
]

@available(macOS 14.0, *)
func rfbInput(_ req: [String: Any]) {
  var req = req
  req["session"] = "remote-screen"
  let r = handle(req)
  if (r["ok"] as? Bool) != true { log("rfb input refused: \(r["reason"] ?? r["error"] ?? "?")") }
}

@available(macOS 14.0, *)
func rfbKey(_ c: RfbClient, down: Bool, keysym: UInt32) {
  if let mod = RFB_MOD_KEYS[keysym] {
    if down { c.mods.insert(mod) } else { c.mods.remove(mod) }
    return
  }
  guard down else { return }   // chords are posted down+up atomically on key-down
  let chordMods = c.mods.intersection(["ctrl", "cmd", "alt"])
  // Plain printable → unicode event, exactly like the type op (any layout/IME).
  if chordMods.isEmpty, keysym >= 0x20, keysym <= 0x10FFFF, keysym != 0xD,
     let scalar = Unicode.Scalar(keysym), Unicode.Scalar(keysym)!.properties.generalCategory != .format {
    rfbInput(["op": "type", "text": String(Character(scalar)), "allowTerminal": true, "allowSystem": true])
    return
  }
  var name = RFB_SPECIAL_KEYS[keysym]
  var shift = false
  if name == nil {
    if keysym >= 0x61 && keysym <= 0x7A { name = String(UnicodeScalar(keysym)!) }
    else if keysym >= 0x41 && keysym <= 0x5A { name = String(UnicodeScalar(keysym - 0x20)!).lowercased(); shift = true }
    else if keysym >= 0x30 && keysym <= 0x39 { name = String(UnicodeScalar(keysym)!) }
    else if keysym >= 0xFFBE && keysym <= 0xFFC9 { name = "f\(keysym - 0xFFBE + 1)" }
    else if let (base, needsShift) = RFB_PUNCT_KEYS[keysym] { name = base; shift = needsShift }
  }
  guard let key = name else { return }
  var parts: [String] = []
  for m in ["ctrl", "alt", "cmd"] where c.mods.contains(m) { parts.append(m) }
  if c.mods.contains("shift") || shift { parts.append("shift") }
  parts.append(key)
  rfbInput(["op": "press", "keys": parts.joined(separator: "+"), "allowTerminal": true, "allowSystem": true])
}

@available(macOS 14.0, *)
func rfbPointer(_ c: RfbClient, mask: Int, x rfbX: Int, y rfbY: Int) {
  // RFB framebuffer px → logical points (this client's framebuffer runs at 1/div)
  let div = RfbScreen.shared.notePointer(c)
  let x = rfbX * div, y = rfbY * div
  let p = CGPoint(x: CGFloat(x), y: CGFloat(y))
  let prev = c.lastMask
  c.lastMask = mask
  if mask == 0 && prev == 0 {
    if c.hoverMoves { rfbHover(c, p) }
    return
  }
  // Wheel buttons are transient pulses in RFB.
  if (mask & 0x08 != 0 && prev & 0x08 == 0) || (mask & 0x10 != 0 && prev & 0x10 == 0) {
    rfbInput(["op": "scroll", "x": x, "y": y, "amount": mask & 0x08 != 0 ? 3 : -3, "allowSystem": true])
    return
  }
  if mask & 0x04 != 0 && prev & 0x04 == 0 {
    rfbInput(["op": "click", "x": x, "y": y, "button": "right", "count": 1, "allowSystem": true])
    return
  }
  let left = mask & 0x01 != 0, wasLeft = prev & 0x01 != 0
  if left && !wasLeft {
    c.downPos = p; c.downAt = Date()
    c.dragLock.lock(); c.dragDead = false; c.dragLock.unlock()
  } else if left && wasLeft {
    rfbLeftHeldMove(c, p)
  } else if !left && wasLeft, let start = c.downPos {
    c.downPos = nil
    c.dragLock.lock(); let live = c.liveDrag, dead = c.dragDead; c.dragDead = false; c.dragLock.unlock()
    if live { rfbDragEnd(c, p); return }   // the drag already happened live: just let go where the finger lifted
    if dead { return }                     // refused / stopped mid-press: nothing more may be sent for it
    if hypot(p.x - start.x, p.y - start.y) > 8 {
      rfbInput(["op": "drag", "x": Int(start.x), "y": Int(start.y), "x2": x, "y2": y, "ms": 250, "allowSystem": true])
    } else {
      let now = Date()
      let dbl = now.timeIntervalSince(c.lastClickAt) < 0.35 && hypot(start.x - c.lastClickPos.x, start.y - c.lastClickPos.y) < 6
      c.lastClickAt = now; c.lastClickPos = start
      rfbInput(["op": "click", "x": Int(start.x), "y": Int(start.y), "count": dbl ? 2 : 1, "allowSystem": true])
    }
  }
}

// JPEG/crop viewers use ordered HTTP samples but the same native drag state,
// policy gate and idle-release watchdog as an RFB connection. No socket is owned.
@available(macOS 14.0, *)
final class HttpScreenPointers {
  static let shared = HttpScreenPointers()
  private let lock = NSLock()
  private var clients: [String: RfbClient] = [:]

  func pointer(_ viewer: String, mask: Int, x: Int, y: Int) -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    for key in Array(clients.keys) {
      if let c = clients[key], Date().timeIntervalSince(c.lastPointerAt) > 15 {
        rfbDragAbort(c); clients.removeValue(forKey: key)
      }
    }
    if clients[viewer] == nil {
      guard clients.count < 16 else { return ["ok": false, "error": "busy"] }
      let c = RfbClient(-1); c.div = 1; c.hoverMoves = true
      clients[viewer] = c
    }
    let c = clients[viewer]!
    rfbPointer(c, mask: mask, x: x, y: y)
    c.dragLock.lock(); let dead = c.dragDead; c.dragLock.unlock()
    return dead ? ["ok": false, "error": "drag-refused"] : ["ok": true]
  }

  func releaseAll() {
    lock.lock(); defer { lock.unlock() }
    for c in clients.values { rfbDragAbort(c) }
    clients.removeAll()
  }
}

// Live touch drag. A drag used to be replayed after the finger lifted (one "drag" op
// from the press point to the release point), so the remote never followed the finger
// and a scrollbar / window / selection only jumped at the end. Now, once the pointer
// leaves the 8pt click slop with the left button held, the button is pressed at the
// touch-down point (dragdown op: the full withMutation policy — protected apps, lease,
// halt, lock), moves stream as leftMouseDragged on the light rfbHover-style path (no
// per-sample AX hit test: a drag crosses many windows, withMutation would call that
// "stale"), and mouse-up ALWAYS follows: finger lift, disconnect, Esc, screen lock, or
// 10s without pointer traffic. The button can never be left stuck down.
let RFB_DRAG_SLOP: CGFloat = 8
let RFB_DRAG_IDLE_RELEASE: TimeInterval = 10

@available(macOS 14.0, *)
func rfbDragEnd(_ c: RfbClient, _ at: CGPoint?) {
  c.dragLock.lock()
  let was = c.liveDrag
  c.liveDrag = false
  let p = at ?? c.liveDragPos
  c.dragLock.unlock()
  guard was else { return }
  post(CGEvent(mouseEventSource: automationEventSource, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left))
}

/// Connection gone / session over: give the button back.
@available(macOS 14.0, *)
func rfbDragAbort(_ c: RfbClient) { rfbDragEnd(c, nil) }

@available(macOS 14.0, *)
func rfbDragWatchdog(_ c: RfbClient) {
  Thread.detachNewThread {
    while true {
      Thread.sleep(forTimeInterval: 0.5)
      c.dragLock.lock()
      let live = c.liveDrag, idle = Date().timeIntervalSince(c.liveDragAt)
      c.dragLock.unlock()
      if !live { return }
      if idle > RFB_DRAG_IDLE_RELEASE {
        log("rfb drag: released after \(Int(RFB_DRAG_IDLE_RELEASE))s without pointer traffic")
        rfbDragEnd(c, nil)
        return
      }
    }
  }
}

@available(macOS 14.0, *)
func rfbLeftHeldMove(_ c: RfbClient, _ p: CGPoint) {
  guard let start = c.downPos else { return }
  c.dragLock.lock(); let dead = c.dragDead, live = c.liveDrag; c.dragLock.unlock()
  if dead { return }
  if !live {
    guard hypot(p.x - start.x, p.y - start.y) > RFB_DRAG_SLOP else { return }
    let r = handle(["op": "dragdown", "x": Int(start.x), "y": Int(start.y), "allowSystem": true, "session": "remote-screen"])
    if (r["ok"] as? Bool) != true {
      log("rfb drag refused: \(r["reason"] ?? r["error"] ?? "?")")
      c.dragLock.lock(); c.dragDead = true; c.dragLock.unlock()
      return
    }
    c.dragLock.lock(); c.liveDrag = true; c.liveDragPos = start; c.liveDragAt = Date(); c.dragLock.unlock()
    rfbDragWatchdog(c)
  }
  rfbDragStep(c, p)
}

@available(macOS 14.0, *)
func rfbDragStep(_ c: RfbClient, _ p: CGPoint) {
  // Hard stops end the drag (button released) instead of silently dropping samples:
  // never keep dragging into a locked screen, after Esc, or under another session.
  guard AXIsProcessTrusted(), !screenLocked(), !(control.isHalted && !control.clearIdleHalt()),
        control.holderConflict("remote-screen") == nil else {
    rfbDragEnd(c, nil)
    c.dragLock.lock(); c.dragDead = true; c.dragLock.unlock()
    return
  }
  c.dragLock.lock(); c.liveDragPos = p; c.liveDragAt = Date(); c.dragLock.unlock()
  guard Date().timeIntervalSince(c.lastMoveAt) >= 0.012 else { return }   // ≤ ~80 Hz
  // A busy input lane just drops this sample; the mouse-up carries the final point.
  guard mutationLane.try() else { return }
  defer { mutationLane.unlock() }
  c.lastMoveAt = Date()
  post(CGEvent(mouseEventSource: automationEventSource, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left))
}

// Hover from the H.264 viewer. Its video shows the real cursor (nothing draws one
// locally), so without this the pointer only jumps on click. Moving the cursor acts
// on nothing, so it skips withMutation's per-app checks and its two AX hit tests per
// sample — but Esc halt, the lock screen and another session's lease still win, and
// a busy input lane just drops the sample (the browser sends the next within ~33ms
// and always flushes the final position). noVNC keeps hover local (Cursor pseudo-
// encoding) and never sets hoverMoves.
@available(macOS 14.0, *)
func rfbHover(_ c: RfbClient, _ p: CGPoint) {
  guard hypot(p.x - c.lastMovePos.x, p.y - c.lastMovePos.y) >= 1 else { return }
  guard AXIsProcessTrusted(), !screenLocked(), !(control.isHalted && !control.clearIdleHalt()),
        control.holderConflict("remote-screen") == nil, mutationLane.try() else { return }
  defer { mutationLane.unlock() }
  c.lastMoveAt = Date(); c.lastMovePos = p
  post(CGEvent(mouseEventSource: automationEventSource, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
}

@available(macOS 14.0, *)
func rfbSender(_ c: RfbClient) {
  while true {
    if !c.beginUpdate() { return }
    // Wait for content; if capture never produces a frame, drop the client so
    // the browser falls back to JPEG polling instead of hanging. Once a frame
    // HAS been served, a still screen must not kill the connection — answer
    // the pending incremental request with an empty update (n=0 keepalive):
    // SCStream only emits on change, so idle requests would otherwise time out.
    var rects = RfbScreen.shared.takeUpdate(c)
    var waitedMs = 0
    while rects == nil && !c.isClosed {
      if Date().timeIntervalSince(c.connectedAt) > 10 && !c.servedAny { c.shutdown(); return }
      if waitedMs >= 4000 {
        if c.servedAny { rects = []; break }
        c.shutdown(); return
      }
      usleep(20_000); waitedMs += 20
      rects = RfbScreen.shared.takeUpdate(c)
    }
    if c.isClosed { return }
    var msg = Data([0, 0])
    msg.appendBE(UInt16(rects!.count))
    for r in rects! { msg.append(r) }   // already encoded: header + payload
    if !writeAll(c.fd, msg) { c.shutdown(); return }
    c.didServeUpdate()
  }
}

@available(macOS 14.0, *)
func rfbSession(_ fd: Int32) {
  // A wedged receiver must not keep a write blocked forever.
  var sendTimeout = timeval(tv_sec: 8, tv_usec: 0)
  _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &sendTimeout, socklen_t(MemoryLayout<timeval>.size))
  var noSigPipe: Int32 = 1
  _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
  let client = RfbClient(fd)
  let senderDone = DispatchSemaphore(value: 0)
  var senderStarted = false
  RfbScreen.shared.attach(client)
  defer {
    rfbDragAbort(client)   // a live touch drag must never outlive its connection
    client.shutdown()
    if senderStarted { senderDone.wait() }
    RfbScreen.shared.detach(client)
  }
  guard writeAll(fd, Data("RFB 003.008\n".utf8)),
        readFully(fd, 12) != nil,
        writeAll(fd, Data([1, 1])), readFully(fd, 1)?.first == 1,   // security: None
        writeAll(fd, Data([0, 0, 0, 0])), readFully(fd, 1) != nil,  // SecurityResult ok + ClientInit
        let logical = RfbScreen.shared.size else { return }
  // Every client starts at the Raw tier; Tight+DesktopSize clients are
  // switched to full resolution right after their SetEncodings arrives.
  let size = (w: max(1, logical.w / RFB_DIV), h: max(1, logical.h / RFB_DIV))
  client.framebufferSize = size
  var si = Data()
  si.appendBE(UInt16(size.w)); si.appendBE(UInt16(size.h))
  si.append(contentsOf: [32, 24, 0, 1])                              // bpp, depth, LE, true-colour
  si.appendBE(UInt16(255)); si.appendBE(UInt16(255)); si.appendBE(UInt16(255))
  si.append(contentsOf: [16, 8, 0, 0, 0, 0])                         // shifts + padding
  let name = Data("MultiCC".utf8)
  si.appendBE(UInt32(name.count)); si.append(name)
  guard writeAll(fd, si) else { return }
  let sender = Thread { defer { senderDone.signal() }; rfbSender(client) }
  sender.name = "rfb-sender"
  senderStarted = true
  sender.start()
  reader: while true {
    guard let head = readFully(fd, 1) else { break }
    switch head[0] {
    case 0:                                                                 // SetPixelFormat: R/B order only
      guard let pf = readFully(fd, 19) else { break reader }
      RfbScreen.shared.setPixelFormat(client, pf)
    case 2:                                                                 // SetEncodings
      guard let b = readFully(fd, 3) else { break reader }
      let n = Int(b[1]) << 8 | Int(b[2])
      guard n >= 0, n <= 4096, let list = readFully(fd, n * 4) else { break reader }
      let e = [UInt8](list)
      var encodings: [Int32] = []
      encodings.reserveCapacity(n)
      var encodingIndex = 0
      while encodingIndex < n {
        let offset = encodingIndex * 4
        let raw = UInt32(e[offset]) << 24 | UInt32(e[offset + 1]) << 16
          | UInt32(e[offset + 2]) << 8 | UInt32(e[offset + 3])
        encodings.append(Int32(bitPattern: raw))
        encodingIndex += 1
      }
      RfbScreen.shared.setEncodings(client, encodings)
    case 3:
      guard let b = readFully(fd, 9) else { break reader }
      if b[0] == 0 { RfbScreen.shared.markFull(client) }
      client.requestUpdate()
    case 4:
      guard let b = readFully(fd, 7) else { break reader }
      rfbKey(client, down: b[0] == 1,
             keysym: UInt32(b[3]) << 24 | UInt32(b[4]) << 16 | UInt32(b[5]) << 8 | UInt32(b[6]))
    case 5:
      guard let b = readFully(fd, 5) else { break reader }
      rfbPointer(client, mask: Int(b[0]), x: Int(b[1]) << 8 | Int(b[2]), y: Int(b[3]) << 8 | Int(b[4]))
    case 6:                                                                 // ClientCutText: ignored
      guard let b = readFully(fd, 8) else { break reader }
      let n = Int(UInt32(b[4]) << 24 | UInt32(b[5]) << 16 | UInt32(b[6]) << 8 | UInt32(b[7]))
      guard n >= 0, n <= 1_000_000, readFully(fd, n) != nil else { break reader }
    default: break reader
    }
  }
}

@available(macOS 14.0, *)
func serveRfb() {
  let rfbPath = "\(agentDir)/rfb.sock"
  // 清掉上次进程留下的死文件再 bind：launchd 重启后旧 rfb.sock 还在，
  // bind 会 EADDRINUSE，RFB 监听就静默退出了（agent.log 2026-10-03 实录）。
  unlink(rfbPath)
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { return }
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(rfbPath.utf8CString)
  withUnsafeMutableBytes(of: &addr.sun_path) { raw in
    for (i, b) in bytes.prefix(raw.count - 1).enumerated() { raw[i] = UInt8(bitPattern: b) }
  }
  let bound = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0
    }
  }
  guard bound, listen(fd, 8) == 0 else { close(fd); log("rfb: cannot listen on \(rfbPath): \(String(cString: strerror(errno)))"); return }
  chmod(rfbPath, 0o600)
  log("rfb: serving \(rfbPath)")
  while true {
    let c = accept(fd, nil, nil)
    if c < 0 { continue }
    DispatchQueue.global().async {
      defer { close(c) }
      var uid: uid_t = 0, gid: gid_t = 0
      guard getpeereid(c, &uid, &gid) == 0, uid == getuid() else { return }
      rfbSession(c)
    }
  }
}

#endif

func serve() -> Never {
  // AppKit is initialized only in the daemon, never in the CLI client.
  _ = NSApplication.shared
  NSApp.setActivationPolicy(.accessory)
  mkdir(agentDir, 0o700)
  chmod(agentDir, 0o700)
  unlink(sockPath)
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0, withSockAddr({ bind(fd, $0, $1) }) == 0, listen(fd, 16) == 0 else {
    log("cannot listen on \(sockPath): \(String(cString: strerror(errno)))"); exit(1)
  }
  chmod(sockPath, 0o600)
  log("multicc-agent \(VERSION) serving \(sockPath) (accessibility=\(AXIsProcessTrusted()) screen=\(CGPreflightScreenCaptureAccess()))")

  if ProcessInfo.processInfo.environment["MULTICC_AGENT_POWER_DISABLED"] != "1" {
    Thread.detachNewThread { lidDisplayGuard.run() }
  }

  let interval = Double(ProcessInfo.processInfo.environment["MULTICC_AGENT_CHROME_INTERVAL"] ?? "") ?? 20
  Thread.detachNewThread { while true { chrome.tick(); Thread.sleep(forTimeInterval: interval) } }
  #if canImport(ScreenCaptureKit) && compiler(>=5.9)
  if #available(macOS 14.0, *) { Thread.detachNewThread { serveRfb() }; Thread.detachNewThread { serveH264() } }
  #endif

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
  Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    computerUseHUD.update()
  }
  Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in installEscMonitor() }
  // Must be AppKit's loop, not a bare RunLoop: only NSApplication.run() pulls
  // mouse events off the queue and hands them to windows, which the control
  // bar's buttons and dragging depend on. Timers and event taps keep working.
  NSApp.run()
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
  case "probe-unlock":
    if let s = rest.first, let n = Double(s) { req["seconds"] = n }
    req["allowUI"] = rest.contains("--allow-ui")
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
         unlock                              auto-unlock the locked screen from the keychain password
         probe-unlock [SECONDS] [--allow-ui]  check keychain access; prompts require --allow-ui
         move|click|rclick|dclick X Y | scroll X Y N | type TEXT | snap /abs.png [x y w h] | call JSON
  """)
  exit(0)
}
client(argv)
