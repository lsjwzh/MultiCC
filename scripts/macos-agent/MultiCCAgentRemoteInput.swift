// Remote-screen input shared by every client kind: KeyEvent/PointerEvent
// handling for the RFB (rfb.sock) and H.264 (h264.sock) readers plus the HTTP
// `pointer` samples. The readers only decode frames and call in here.
//
// Pointer bits: 0x01 left, 0x02 middle, 0x04 right, 0x08 wheel up, 0x10 wheel
// down, 0x20 wheel left, 0x40 wheel right. A rising left/middle/right edge
// presses at once through the full policy gate (halt, lock, lease, AX,
// protected apps); a refusal marks that press dead so its
// movement and release post nothing. Motion while held posts dragged events
// (≤ ~80 Hz, a busy input lane drops samples), the falling edge releases at
// the release point, and a sample with the same mask and position is a
// heartbeat that only refreshes the idle watchdog. Every posted mouse/scroll
// event carries the client's really-held modifier flags, and the button can
// never be left stuck down.
//
// Modifiers are really held: a modifier KeyEvent posts a real flagsChanged
// (left/right virtual key, cumulative flags) and is remembered per client, so
// mouse down/drag/up, scroll, hover and key chords carry those flags.
// Release-all runs on disconnect, Esc halt, screen lock, another session's
// lease, AX trust lost, the `release` op, 10 s without pointer traffic (buttons)
// and 30 s without input of any kind while a modifier is held.

import Foundation
import CoreGraphics
import AppKit

// HTTP `mods` (contract §5): keep only the known names, dedupe, order
// shift,ctrl,alt,cmd. A non-array or unknown string is dropped.
func httpMods(_ req: [String: Any]) -> [String] {
  guard let raw = req["mods"] as? [Any] else { return [] }
  return ["shift", "ctrl", "alt", "cmd"].filter { name in raw.contains { ($0 as? String) == name } }
}

// Virtual keys for the HTTP transient modifiers (left side, like parseChord).
let HTTP_MOD_KEYS: [String: CGKeyCode] = ["shift": 0x38, "ctrl": 0x3B, "alt": 0x3A, "cmd": 0x37]

func postModifierKey(_ name: String, down: Bool, flags: CGEventFlags, pid: pid_t? = nil) {
  guard let code = HTTP_MOD_KEYS[name] else { return }
  post(CGEvent(keyboardEventSource: automationEventSource, virtualKey: code, keyDown: down), pid: pid, flags: flags)
}

// Press the named modifiers for one HTTP operation, bounded like a chord:
// downs, the operation, then ups in reverse order.
func withTransientMods(_ mods: [String], pid: pid_t? = nil, _ body: (CGEventFlags) -> [String: Any]) -> [String: Any] {
  var down: [String] = []
  var flags: CGEventFlags = []
  for name in ["shift", "ctrl", "alt", "cmd"] where mods.contains(name) {
    flags.insert(MODIFIERS[name] ?? [])
    postModifierKey(name, down: true, flags: flags, pid: pid)
    down.append(name)
  }
  defer {
    for name in down.reversed() {
      flags.remove(MODIFIERS[name] ?? [])
      postModifierKey(name, down: false, flags: flags, pid: pid)
    }
  }
  return body(flags)
}

#if canImport(ScreenCaptureKit) && compiler(>=5.9)

// X11 keysyms → our key names / modifiers (see parseChord for the grammar).
let RFB_SPECIAL_KEYS: [UInt32: String] = [
  0xFF08: "delete", 0xFF09: "tab", 0xFF0D: "return", 0xFF1B: "escape", 0xFFFF: "forwarddelete",
  0xFF50: "home", 0xFF51: "left", 0xFF52: "up", 0xFF53: "right", 0xFF54: "down",
  0xFF55: "pageup", 0xFF56: "pagedown", 0xFF57: "end", 0x0020: "space",
]
// Modifier keysyms → (flag name, left/right virtual key). Meta/Super are ⌘,
// Alt/ISO_Level3/Mode_switch are ⌥ (contract §3). Left and right stay separate.
let RFB_MOD_KEYS: [UInt32: (name: String, code: CGKeyCode)] = [
  0xFFE1: ("shift", 0x38), 0xFFE2: ("shift", 0x3C),
  0xFFE3: ("ctrl", 0x3B), 0xFFE4: ("ctrl", 0x3E),
  0xFFE7: ("cmd", 0x37), 0xFFE8: ("cmd", 0x36),
  0xFFE9: ("alt", 0x3A), 0xFFEA: ("alt", 0x3D),
  0xFFEB: ("cmd", 0x37), 0xFFEC: ("cmd", 0x36),
  0xFE03: ("alt", 0x3A), 0xFF7E: ("alt", 0x3A),
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

let RFB_DRAG_IDLE_RELEASE: TimeInterval = 10   // buttons: no pointer traffic
let RFB_MOD_IDLE_RELEASE: TimeInterval = 30    // modifiers: no input at all
let RFB_BUTTONS: [(bit: Int, down: CGEventType, drag: CGEventType, up: CGEventType, button: CGMouseButton)] = [
  (0x01, .leftMouseDown, .leftMouseDragged, .leftMouseUp, .left),
  (0x02, .otherMouseDown, .otherMouseDragged, .otherMouseUp, .center),
  (0x04, .rightMouseDown, .rightMouseDragged, .rightMouseUp, .right),
]

@available(macOS 14.0, *)
func rfbInput(_ req: [String: Any]) {
  var req = req
  req["session"] = "remote-screen"
  let r = handle(req)
  if (r["ok"] as? Bool) != true { log("rfb input refused: \(r["reason"] ?? r["error"] ?? "?")") }
}

// MARK: - Held modifiers

@available(macOS 14.0, *)
func rfbDeriveMods(_ c: RfbClient) {
  c.mods = Set(c.heldModKeysyms.keys.compactMap { RFB_MOD_KEYS[$0]?.name })
}

// Cumulative flags of what is physically down for this client. Caller holds inputLock.
@available(macOS 14.0, *)
func rfbFlagsLocked(_ c: RfbClient) -> CGEventFlags {
  var f: CGEventFlags = []
  for keysym in c.heldModKeysyms.keys {
    if let m = RFB_MOD_KEYS[keysym] { f.insert(MODIFIERS[m.name] ?? []) }
  }
  for name in c.transientDown { f.insert(MODIFIERS[name] ?? []) }
  return f
}

@available(macOS 14.0, *)
func rfbFlags(_ c: RfbClient) -> CGEventFlags {
  c.inputLock.lock(); defer { c.inputLock.unlock() }
  return rfbFlagsLocked(c)
}

// Press or release one modifier for one client. Two keysyms can share a
// virtual key (Meta_L/Super_L): post the down once, the up when the last goes.
@available(macOS 14.0, *)
func rfbModifier(_ c: RfbClient, down: Bool, keysym: UInt32, _ mod: (name: String, code: CGKeyCode)) {
  if down && (!AXIsProcessTrusted() || screenLocked() || (control.isHalted && !control.clearIdleHalt())
              || control.holderConflict("remote-screen") != nil) {
    rfbReleaseAll(c)
    return
  }
  c.inputLock.lock()
  c.inputAt = Date()
  if down {
    if c.heldModKeysyms[keysym] != nil { c.inputLock.unlock(); return }
    let already = c.heldModKeysyms.values.contains(mod.code)
    c.heldModKeysyms[keysym] = mod.code
    rfbDeriveMods(c)
    let flags = rfbFlagsLocked(c)
    if !already {
      post(CGEvent(keyboardEventSource: automationEventSource, virtualKey: mod.code, keyDown: true), flags: flags)
    }
    c.inputLock.unlock()
    rfbStartWatchdog(c)
  } else {
    guard c.heldModKeysyms.removeValue(forKey: keysym) != nil else { c.inputLock.unlock(); return }
    rfbDeriveMods(c)
    let still = c.heldModKeysyms.values.contains(mod.code)
    let flags = rfbFlagsLocked(c)
    if !still {
      post(CGEvent(keyboardEventSource: automationEventSource, virtualKey: mod.code, keyDown: false), flags: flags)
    }
    c.inputLock.unlock()
  }
}

// HTTP pointer mods: pressed with the button and released with it. Unlike a
// stream client's modifiers these do not outlive the gesture.
@available(macOS 14.0, *)
func rfbSyncTransientMods(_ c: RfbClient, wanted: Set<String>) {
  guard c.transientMods else { return }
  c.inputLock.lock()
  var flags = rfbFlagsLocked(c)
  for name in ["shift", "ctrl", "alt", "cmd"] where wanted.contains(name) && !c.transientDown.contains(name) {
    flags.insert(MODIFIERS[name] ?? [])
    postModifierKey(name, down: true, flags: flags)
    c.transientDown.insert(name)
  }
  for name in ["cmd", "alt", "ctrl", "shift"] where !wanted.contains(name) && c.transientDown.contains(name) {
    flags.remove(MODIFIERS[name] ?? [])
    postModifierKey(name, down: false, flags: flags)
    c.transientDown.remove(name)
  }
  c.inputLock.unlock()
}

// MARK: - Buttons

// Click count is decided at press time: same button, within the double-click
// interval (clamped 0.3…0.6 s) and within 6 pt of the last press → +1, max 3.
// A press that becomes a drag clears that button's history on release (see
// rfbReleaseButtons), so drag A→B then click at A counts 1, not 2.
@available(macOS 14.0, *)
func rfbClickCount(_ c: RfbClient, bit: Int, at p: CGPoint, now: Date) -> Int {
  let interval = min(0.6, max(0.3, NSEvent.doubleClickInterval))
  c.inputLock.lock()
  var count = 1
  if let last = c.buttonLastAt[bit], let lastPos = c.buttonLastPos[bit],
     now.timeIntervalSince(last) <= interval, hypot(p.x - lastPos.x, p.y - lastPos.y) <= 6 {
    count = min(3, (c.buttonCount[bit] ?? 1) + 1)
  }
  c.buttonCount[bit] = count
  c.buttonLastAt[bit] = now
  c.buttonLastPos[bit] = p
  c.inputLock.unlock()
  return count
}

@available(macOS 14.0, *)
func rfbPressButton(_ c: RfbClient, down: CGEventType, button: CGMouseButton,
                    at p: CGPoint, count: Int) -> Bool {
  let r = withMutation(["op": "pointer", "x": Int(p.x), "y": Int(p.y), "allowSystem": true],
                       session: "remote-screen", target: pidAt(p), kind: .pointer) {
    if c.transientMods {
      c.inputLock.lock(); let wanted = c.wantedTransientMods; c.inputLock.unlock()
      rfbSyncTransientMods(c, wanted: wanted)
    }
    let flags = rfbFlags(c)
    let e = CGEvent(mouseEventSource: automationEventSource, mouseType: down, mouseCursorPosition: p, mouseButton: button)
    e?.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, min(3, count))))
    post(e, flags: flags)
    return dispatched("hid_events")
  }
  return (r["ok"] as? Bool) == true
}

// Release the given buttons (all by default) at the release point, or at the
// last known position when a watchdog gives them back.
@available(macOS 14.0, *)
func rfbReleaseButtons(_ c: RfbClient, at point: CGPoint?, only: Int = 0x07) {
  c.inputLock.lock()
  let held = c.heldButtons & only & 0x07
  let p = point ?? c.lastPointerPos
  let clicks = c.buttonClick
  c.heldButtons &= ~held
  for spec in RFB_BUTTONS where held & spec.bit != 0 {
    c.buttonClick.removeValue(forKey: spec.bit)
    // A button that travelled more than 6 pt from its press point was a drag,
    // not a click: drop the click history so the next press starts at 1.
    if let down = c.buttonDownPos.removeValue(forKey: spec.bit),
       hypot(p.x - down.x, p.y - down.y) > 6 {
      c.buttonCount.removeValue(forKey: spec.bit)
      c.buttonLastAt.removeValue(forKey: spec.bit)
      c.buttonLastPos.removeValue(forKey: spec.bit)
    }
  }
  let flags = rfbFlagsLocked(c)
  c.inputLock.unlock()
  guard held != 0 else { return }
  for spec in RFB_BUTTONS where held & spec.bit != 0 {
    let e = CGEvent(mouseEventSource: automationEventSource, mouseType: spec.up, mouseCursorPosition: p, mouseButton: spec.button)
    e?.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, clicks[spec.bit] ?? 1)))
    post(e, flags: flags)
  }
}

@available(macOS 14.0, *)
func rfbReleaseModifiers(_ c: RfbClient) {
  c.inputLock.lock()
  let held = c.heldModKeysyms
  c.heldModKeysyms.removeAll()
  rfbDeriveMods(c)
  let flags = rfbFlagsLocked(c)
  c.inputLock.unlock()
  var released = Set<CGKeyCode>()
  for code in held.values where !released.contains(code) {
    released.insert(code)
    post(CGEvent(keyboardEventSource: automationEventSource, virtualKey: code, keyDown: false), flags: flags)
  }
}

// Hard stop / disconnect / `release`: give every button and modifier back.
@available(macOS 14.0, *)
func rfbReleaseAll(_ c: RfbClient) {
  rfbReleaseButtons(c, at: nil)
  rfbSyncTransientMods(c, wanted: [])
  rfbReleaseModifiers(c)
  c.inputLock.lock(); c.wantedTransientMods = []; c.inputLock.unlock()
}

@available(macOS 14.0, *)
func rfbStartWatchdog(_ c: RfbClient) {
  c.inputLock.lock()
  if c.watchdogRunning { c.inputLock.unlock(); return }
  c.watchdogRunning = true
  c.inputLock.unlock()
  Thread.detachNewThread { rfbWatchdog(c) }
}

// Hard stops release at once; otherwise the 10 s button timer and the 30 s
// modifier timer are the safety net for a client that vanished (heartbeats
// refresh both, so they only fire on a real stall or disconnect).
@available(macOS 14.0, *)
func rfbWatchdog(_ c: RfbClient) {
  while true {
    Thread.sleep(forTimeInterval: 0.5)
    if !AXIsProcessTrusted() || screenLocked() || (control.isHalted && !control.clearIdleHalt())
        || control.holderConflict("remote-screen") != nil {
      rfbReleaseAll(c)
      c.inputLock.lock(); c.watchdogRunning = false; c.inputLock.unlock()
      return
    }
    c.inputLock.lock()
    let buttons = c.heldButtons & 0x07
    let modifierHeld = !c.heldModKeysyms.isEmpty || !c.transientDown.isEmpty
    let pointerIdle = Date().timeIntervalSince(c.lastPointerAt)
    let inputIdle = Date().timeIntervalSince(c.inputAt)
    c.inputLock.unlock()
    if buttons != 0 && pointerIdle > RFB_DRAG_IDLE_RELEASE {
      log("rfb input: released buttons after \(Int(RFB_DRAG_IDLE_RELEASE))s without pointer traffic")
      rfbReleaseButtons(c, at: nil)
      if c.transientMods { rfbSyncTransientMods(c, wanted: []) }
    }
    if modifierHeld && inputIdle > RFB_MOD_IDLE_RELEASE {
      log("rfb input: released modifiers after \(Int(RFB_MOD_IDLE_RELEASE))s without input")
      rfbReleaseAll(c)
    }
    c.inputLock.lock()
    let still = (c.heldButtons & 0x07) != 0 || !c.heldModKeysyms.isEmpty || !c.transientDown.isEmpty
    if !still { c.watchdogRunning = false }
    c.inputLock.unlock()
    if !still { return }
  }
}

// MARK: - Pointer

@available(macOS 14.0, *)
func rfbPointer(_ c: RfbClient, mask: Int, x rfbX: Int, y rfbY: Int) {
  // RFB framebuffer px → logical points (this client's framebuffer runs at 1/div)
  let div = RfbScreen.shared.notePointer(c)
  let x = rfbX * div, y = rfbY * div
  let p = CGPoint(x: CGFloat(x), y: CGFloat(y))
  let now = Date()
  c.inputLock.lock()
  let prev = c.lastMask
  let previous = c.lastPointerPos
  c.lastMask = mask
  c.lastPointerPos = p
  c.inputAt = now
  let heartbeat = mask == prev && p == previous
  c.inputLock.unlock()
  // Same mask, same position: a heartbeat. It refreshed the idle timers above
  // and posts nothing (clients send one every 3 s while a button is held).
  if heartbeat { return }

  // Wheel bits are pulses (mask|bit, then mask): one scroll per rising edge.
  let wheelUp = (mask & 0x08) != 0 && (prev & 0x08) == 0
  let wheelDown = (mask & 0x10) != 0 && (prev & 0x10) == 0
  let wheelLeft = (mask & 0x20) != 0 && (prev & 0x20) == 0
  let wheelRight = (mask & 0x40) != 0 && (prev & 0x40) == 0
  if wheelUp || wheelDown || wheelLeft || wheelRight {
    let v = Int32(wheelUp ? 3 : (wheelDown ? -3 : 0))
    let h = Int32(wheelLeft ? 3 : (wheelRight ? -3 : 0))   // 0x20 scrolls left
    _ = withMutation(["op": "scroll", "x": x, "y": y, "allowSystem": true],
                     session: "remote-screen", target: pidAt(p), kind: .pointer) {
      let flags = rfbFlags(c)
      post(CGEvent(scrollWheelEvent2Source: automationEventSource, units: .line,
                   wheelCount: h != 0 ? 2 : 1, wheel1: v, wheel2: h, wheel3: 0), flags: flags)
      return dispatched("hid_events")
    }
  }

  let buttons = mask & 0x07, was = prev & 0x07
  let pressed = buttons & ~was, released = was & ~buttons
  for spec in RFB_BUTTONS where pressed & spec.bit != 0 {
    let count = rfbClickCount(c, bit: spec.bit, at: p, now: now)
    if rfbPressButton(c, down: spec.down, button: spec.button, at: p, count: count) {
      c.inputLock.lock()
      c.heldButtons |= spec.bit
      c.buttonClick[spec.bit] = count
      c.buttonDownPos[spec.bit] = p
      c.inputLock.unlock()
      rfbStartWatchdog(c)
    } else {
      // Refused: this press may not move or click. Like any hard stop it also
      // releases modifiers, so nothing can stay held over a refusal.
      c.inputLock.lock(); c.deadButtons |= spec.bit; c.inputLock.unlock()
      rfbReleaseAll(c)
    }
  }
  // Release before motion so the dragged stream ends at the release point.
  if released != 0 { rfbReleaseButtons(c, at: p, only: released) }
  c.inputLock.lock(); let held = c.heldButtons & 0x07; c.inputLock.unlock()
  if buttons != 0 {
    // A sample that only pressed (or only repeated the heartbeat point) must not
    // also emit a zero-distance dragged event; motion starts with the next sample.
    if held & buttons != 0, pressed == 0, p != previous { rfbDragMove(c, p) }
  } else if mask == 0 && prev == 0, c.hoverMoves {
    rfbHover(c, p)
  }
  if released != 0 {
    c.inputLock.lock()
    c.deadButtons &= ~released
    let idle = (c.heldButtons & 0x07) == 0
    c.inputLock.unlock()
    if idle && c.transientMods {
      rfbSyncTransientMods(c, wanted: [])
      c.inputLock.lock(); c.wantedTransientMods = []; c.inputLock.unlock()
    }
  }
}

// Motion with a button physically held: dragged events on the light path (no
// per-sample AX hit test — a drag crosses windows and withMutation would call
// that "stale"), but hard stops still end it and give the button back.
@available(macOS 14.0, *)
func rfbDragMove(_ c: RfbClient, _ p: CGPoint) {
  guard AXIsProcessTrusted(), !screenLocked(), !(control.isHalted && !control.clearIdleHalt()),
        control.holderConflict("remote-screen") == nil else {
    rfbReleaseAll(c)
    return
  }
  c.inputLock.lock()
  let held = c.heldButtons & 0x07
  // A button that moves away from its press point is a drag, not a click: drop
  // its click history now, even if it comes back before release.
  for spec in RFB_BUTTONS where held & spec.bit != 0 {
    if let down = c.buttonDownPos[spec.bit], hypot(p.x - down.x, p.y - down.y) > 6 {
      c.buttonCount.removeValue(forKey: spec.bit)
      c.buttonLastAt.removeValue(forKey: spec.bit)
      c.buttonLastPos.removeValue(forKey: spec.bit)
    }
  }
  let due = Date().timeIntervalSince(c.lastMoveAt) >= 0.012   // ≤ ~80 Hz
  if due { c.lastMoveAt = Date() }
  let flags = rfbFlagsLocked(c)
  c.inputLock.unlock()
  // A busy input lane just drops this sample; the mouse-up carries the final point.
  guard due, held != 0, mutationLane.try() else { return }
  defer { mutationLane.unlock() }
  for spec in RFB_BUTTONS where held & spec.bit != 0 {
    post(CGEvent(mouseEventSource: automationEventSource, mouseType: spec.drag, mouseCursorPosition: p, mouseButton: spec.button), flags: flags)
  }
}

// Mask-0 motion with no button held moves the real cursor for every client
// kind (the H.264 video shows the real cursor; noVNC still draws its own from
// the Cursor pseudo-encoding). Moving acts on nothing, so it skips the
// per-app checks and the two AX hit tests per sample, but Esc halt, the lock
// screen and another session's lease still win, and a busy lane drops it.
@available(macOS 14.0, *)
func rfbHover(_ c: RfbClient, _ p: CGPoint) {
  c.inputLock.lock()
  let moved = hypot(p.x - c.lastMovePos.x, p.y - c.lastMovePos.y)
  let flags = rfbFlagsLocked(c)
  c.inputLock.unlock()
  guard moved >= 1 else { return }
  guard AXIsProcessTrusted(), !screenLocked(), !(control.isHalted && !control.clearIdleHalt()),
        control.holderConflict("remote-screen") == nil, mutationLane.try() else { return }
  defer { mutationLane.unlock() }
  c.inputLock.lock(); c.lastMoveAt = Date(); c.lastMovePos = p; c.inputLock.unlock()
  post(CGEvent(mouseEventSource: automationEventSource, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left), flags: flags)
}

// MARK: - Keyboard

@available(macOS 14.0, *)
func rfbKey(_ c: RfbClient, down: Bool, keysym: UInt32) {
  if let mod = RFB_MOD_KEYS[keysym] {
    rfbModifier(c, down: down, keysym: keysym, mod)
    return
  }
  guard down else { return }   // chords are posted down+up atomically on key-down
  c.inputLock.lock()
  c.inputAt = Date()
  let held = c.mods.union(c.transientDown)
  c.inputLock.unlock()
  let chordMods = held.intersection(["ctrl", "cmd", "alt"])
  // X11 functional keysyms are not Unicode: 0xFF08 is BackSpace, whereas
  // U+FF08 is a fullwidth left parenthesis. Tagged Unicode remains unambiguous.
  let taggedUnicode = (keysym & 0xFF000000) == 0x01000000
  let codepoint = taggedUnicode ? (keysym & 0x00FFFFFF) : keysym
  let functional = !taggedUnicode && (0xFE00...0xFFFF).contains(keysym)
  // Retain raw codepoints outside the reserved range for older H.264 clients.
  if chordMods.isEmpty, !functional, codepoint >= 0x20, codepoint <= 0x10FFFF,
     let scalar = Unicode.Scalar(codepoint), scalar.properties.generalCategory != .format {
    rfbInput(["op": "type", "text": String(Character(scalar)), "allowTerminal": true, "allowSystem": true])
    return
  }
  var name = RFB_SPECIAL_KEYS[keysym]
  var shift = false
  if name == nil {
    if keysym >= 0x61 && keysym <= 0x7A { name = String(UnicodeScalar(keysym)!) }
    else if keysym >= 0x41 && keysym <= 0x5A { name = String(UnicodeScalar(keysym + 0x20)!); shift = true }
    else if keysym >= 0x30 && keysym <= 0x39 { name = String(UnicodeScalar(keysym)!) }
    else if keysym >= 0xFFBE && keysym <= 0xFFC9 { name = "f\(keysym - 0xFFBE + 1)" }
    else if let (base, needsShift) = RFB_PUNCT_KEYS[keysym] { name = base; shift = needsShift }
  }
  guard let key = name else { return }
  var parts: [String] = []
  for m in ["ctrl", "alt", "cmd"] where held.contains(m) { parts.append(m) }
  if held.contains("shift") || shift { parts.append("shift") }
  parts.append(key)
  rfbInput(["op": "press", "keys": parts.joined(separator: "+"), "allowTerminal": true, "allowSystem": true])
}

// MARK: - HTTP samples and release

// JPEG/crop viewers use ordered HTTP samples but the same native pointer state,
// policy gate and idle watchdog as a stream connection. No socket is owned.
@available(macOS 14.0, *)
final class HttpScreenPointers {
  static let shared = HttpScreenPointers()
  private let lock = NSLock()
  private var clients: [String: RfbClient] = [:]

  func pointer(_ viewer: String, mask: Int, x: Int, y: Int, mods: [String]) -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    for key in Array(clients.keys) {
      if let c = clients[key], Date().timeIntervalSince(c.lastPointerAt) > 15 {
        rfbReleaseAll(c); clients.removeValue(forKey: key)
      }
    }
    if clients[viewer] == nil {
      guard clients.count < 16 else { return ["ok": false, "error": "busy"] }
      let c = RfbClient(-1); c.div = 1; c.hoverMoves = true; c.transientMods = true
      clients[viewer] = c
    }
    let c = clients[viewer]!
    // Mods only change while no button is held: they are pressed with the
    // button and released with it, never swapped mid-drag.
    c.inputLock.lock()
    if (c.heldButtons & 0x07) == 0 { c.wantedTransientMods = Set(mods) }
    c.inputLock.unlock()
    rfbPointer(c, mask: mask, x: x, y: y)
    c.inputLock.lock(); let dead = c.deadButtons & 0x01 != 0; c.inputLock.unlock()
    return dead ? ["ok": false, "error": "drag-refused"] : ["ok": true]
  }

  func releaseAll() {
    lock.lock(); defer { lock.unlock() }
    for c in clients.values { rfbReleaseAll(c) }
    clients.removeAll()
  }
}

// Every live stream client, so the `release` op can give back what they hold.
@available(macOS 14.0, *)
final class RfbInputRegistry {
  static let shared = RfbInputRegistry()
  private let lock = NSLock()
  private var clients: [ObjectIdentifier: RfbClient] = [:]

  func add(_ c: RfbClient) { lock.lock(); clients[ObjectIdentifier(c)] = c; lock.unlock() }
  func remove(_ c: RfbClient) { lock.lock(); clients.removeValue(forKey: ObjectIdentifier(c)); lock.unlock() }
  func releaseAll() {
    lock.lock(); let all = Array(clients.values); lock.unlock()
    for c in all { rfbReleaseAll(c) }
  }
}

@available(macOS 14.0, *)
func rfbRegisterClient(_ c: RfbClient) { RfbInputRegistry.shared.add(c) }

@available(macOS 14.0, *)
func rfbRemoveClient(_ c: RfbClient) { RfbInputRegistry.shared.remove(c) }

@available(macOS 14.0, *)
func rfbReleaseAllInput() {
  RfbInputRegistry.shared.releaseAll()
  HttpScreenPointers.shared.releaseAll()
}

#endif
