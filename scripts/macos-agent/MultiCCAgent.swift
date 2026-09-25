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
import Foundation
import CoreGraphics
import ApplicationServices

let VERSION = "1"
let home = FileManager.default.homeDirectoryForCurrentUser.path
let agentDir = ProcessInfo.processInfo.environment["MULTICC_AGENT_DIR"] ?? "\(home)/.multicc/agent"
let sockPath = "\(agentDir)/agent.sock"
let configPath = "\(agentDir)/config.json"
let pausePath = "\(agentDir)/chrome.pause"

func log(_ s: String) {
  FileHandle.standardError.write("\(ISO8601DateFormatter().string(from: Date())) \(s)\n".data(using: .utf8)!)
}

// MARK: - Operations (the whole attack surface; keep it small)

func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }

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

func typeText(_ text: String) {
  // Unicode events rather than keycodes: works for Chinese without touching
  // the clipboard, independent of the active input method.
  for chunk in Array(text.utf16).chunked(20) {
    for keyDown in [true, false] {
      let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: keyDown)
      chunk.withUnsafeBufferPointer { e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
      post(e)
    }
    usleep(10_000)
  }
}

extension Array {
  func chunked(_ n: Int) -> [[Element]] {
    stride(from: 0, to: count, by: n).map { Array(self[$0..<Swift.min($0 + n, count)]) }
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

func handle(_ req: [String: Any]) -> [String: Any] {
  let op = req["op"] as? String ?? ""
  switch op {
  case "ping":
    return ["ok": true, "version": VERSION, "pid": Int(getpid())]
  case "status":
    return ["ok": true, "version": VERSION,
            "accessibility": AXIsProcessTrusted(),
            "screenRecording": CGPreflightScreenCaptureAccess(),
            "chrome": chrome.snapshot()]
  case "request-permissions":
    // Adds this app to both lists in System Settings with the switch off; the
    // user still has to flip them. Nothing here can grant itself anything.
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let ax = AXIsProcessTrustedWithOptions(opts)
    let sr = CGRequestScreenCaptureAccess()
    return ["ok": true, "accessibility": ax, "screenRecording": sr]
  case "move", "click", "scroll":
    guard let x = num(req["x"]), let y = num(req["y"]) else { return ["ok": false, "error": "x and y are required"] }
    let p = CGPoint(x: x, y: y)
    if !AXIsProcessTrusted() { return ["ok": false, "error": "accessibility-not-granted"] }
    if op == "move" {
      post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    } else if op == "click" {
      click(p, right: (req["button"] as? String) == "right", count: Int(num(req["count"]) ?? 1))
    } else {
      post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
      let amount = Int32(max(-200, min(200, num(req["amount"]) ?? -5)))
      post(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: amount, wheel2: 0, wheel3: 0))
    }
    return ["ok": true]
  case "type":
    guard let text = req["text"] as? String, !text.isEmpty, text.count <= 4000 else {
      return ["ok": false, "error": "text is required (max 4000 chars)"]
    }
    if !AXIsProcessTrusted() { return ["ok": false, "error": "accessibility-not-granted"] }
    typeText(text)
    return ["ok": true]
  case "snap":
    // screencapture runs as our child, so it is covered by OUR Screen Recording
    // grant. The only caller input is the output file: absolute, .png, no "..".
    guard let path = req["path"] as? String, path.hasPrefix("/"), path.hasSuffix(".png"),
          !path.contains("/../") else { return ["ok": false, "error": "path must be an absolute .png path"] }
    if !CGPreflightScreenCaptureAccess() { return ["ok": false, "error": "screen-recording-not-granted"] }
    var args = ["-x"]
    if let r = req["rect"] as? [NSNumber], r.count == 4 {
      args += ["-R", r.map { String($0.intValue) }.joined(separator: ",")]
    }
    let (code, out) = runTool("/usr/sbin/screencapture", args + [path])
    return code == 0 ? ["ok": true, "path": path] : ["ok": false, "error": "screencapture failed: \(out)"]
  default:
    return ["ok": false, "error": "unknown op: \(op)"]
  }
}

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
    var ok = false
    URLSession.shared.dataTask(with: req) { _, resp, _ in
      ok = (resp as? HTTPURLResponse)?.statusCode == 200
      sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 5)
    return ok
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

func client(_ args: [String]) -> Never {
  var req: [String: Any] = ["op": args[0]]
  let rest = Array(args.dropFirst())
  switch args[0] {
  case "call":
    guard let s = rest.first, let obj = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] else {
      print("usage: MultiCCAgent call '{\"op\":\"...\"}'"); exit(2)
    }
    req = obj
  case "move", "click", "rclick", "dclick":
    guard rest.count >= 2, let x = Double(rest[0]), let y = Double(rest[1]) else { print("usage: \(args[0]) X Y"); exit(2) }
    req = ["op": args[0] == "move" ? "move" : "click", "x": x, "y": y,
           "button": args[0] == "rclick" ? "right" : "left", "count": args[0] == "dclick" ? 2 : 1]
  case "scroll":
    guard rest.count >= 3, let x = Double(rest[0]), let y = Double(rest[1]), let a = Double(rest[2]) else {
      print("usage: scroll X Y AMOUNT (negative = down)"); exit(2)
    }
    req = ["op": "scroll", "x": x, "y": y, "amount": a]
  case "type":
    req["text"] = rest.joined(separator: " ")
  case "snap":
    guard let path = rest.first else { print("usage: snap /abs/out.png [x y w h]"); exit(2) }
    req["path"] = path
    if rest.count >= 5 { req["rect"] = rest[1...4].compactMap { Int($0) } }
  default: break
  }
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard withSockAddr({ connect(fd, $0, $1) }) == 0 else {
    print("{\"ok\":false,\"error\":\"agent-not-running\",\"socket\":\"\(sockPath)\"}"); exit(3)
  }
  writeJSON(fd, req)
  let reply = readLine(fd)
  print(String(data: reply, encoding: .utf8) ?? "")
  let ok = (try? JSONSerialization.jsonObject(with: reply) as? [String: Any])?["ok"] as? Bool ?? false
  exit(ok ? 0 : 1)
}

let argv = Array(CommandLine.arguments.dropFirst())
if argv.first == "serve" { serve() }
if argv.isEmpty || argv.first == "help" {
  print("usage: MultiCCAgent serve | ping | status | request-permissions | move|click|rclick|dclick X Y | scroll X Y N | type TEXT | snap /abs.png [x y w h] | call JSON")
  exit(0)
}
client(argv)
