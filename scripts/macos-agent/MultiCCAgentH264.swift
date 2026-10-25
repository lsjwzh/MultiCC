// MARK: - H.264 streaming server (「🖥 屏幕」高清流畅模式)
//
// A third unix socket (agentDir/h264.sock) streams the main display as H.264
// encoded by VideoToolbox (hardware), so a moving screen costs a fraction of
// the bytes Tight/JPEG needs. The MultiCC server relays it unchanged to the
// browser (WebCodecs) over /ws/remote-screen?mode=h264 — through the existing
// tunnel, or later a WebRTC DataChannel; both carry this exact framing.
//
// Agent → server, one message per frame:
//   [type u8][len u32 BE][payload]
//     type 1  config  payload = JSON {"codec":"avc1.PPCCLL","width":W,"height":H,
//                                     "inputWidth":IW,"inputHeight":IH}
//                     width/height = encode size (shrinks when the rate controller
//                     picks a smaller scale); inputWidth/inputHeight = the main
//                     display in logical points, which is the pointer domain and
//                     never changes.
//     type 2  key     payload = [pts µs u64 BE][Annex B, SPS/PPS first]
//     type 3  delta   payload = [pts µs u64 BE][Annex B]
//     type 4  pong    payload = [token u32 BE][applied kbps u32 BE]
// Server → agent:
//     0x4B 'K'                 request a key frame (after drops / decoder reset)
//     0x42 'B' + kbps u32 BE   cap the shared encoder at this client's link budget
//                              (0 = revoke). The encoder runs at the smallest cap
//                              of all clients; with no cap it keeps the default.
//     0x50 'P' + token u32 BE  ping; answered at once with type 4 pong so the
//                              client measures RTT and reads the applied rate.
//     4 + 7 bytes              RFB KeyEvent     ┐ coordinates are logical points;
//     5 + 5 bytes              RFB PointerEvent ┘ routed through rfbKey/rfbPointer,
//                                                 so every input guard applies; no-button
//                                                 motion moves the cursor (rfbHover).
//
// The H.264 encoder is one global singleton shared by every viewer, so the rate
// cap is a minimum over clients. A cap also picks the capture scale (1.0 / 0.75 /
// 0.5) from bits per logical pixel, because shrinking the wrong-resolution buffer
// queues just as badly as overshooting the bitrate.
// Frames are produced only on change (SCStream idles on a still screen); a
// still screen gets two delayed "refine" re-encodes of the last image so text
// sharpens after motion, and a key request on a still screen re-encodes the
// last image as a key frame. A slow reader never stalls the encoder: each
// client drops delta frames past a small queue and waits for the next key.

#if canImport(ScreenCaptureKit) && compiler(>=5.9)
import ScreenCaptureKit
import VideoToolbox

let H264_CONFIG: UInt8 = 1
let H264_KEY: UInt8 = 2
let H264_DELTA: UInt8 = 3
let H264_PONG: UInt8 = 4
let H264_REQ_KEY: UInt8 = 0x4B
let H264_CAP: UInt8 = 0x42
let H264_PING: UInt8 = 0x50
let H264_MAX_PENDING = 4            // queued frames per client before deltas are dropped
let H264_REFINE_DELAYS = [0.35, 1.2]  // seconds after the last change
let H264_MIN_KBPS = 300             // floor of the adaptive range: below this text turns to mush
let H264_SCALE_MIN_INTERVAL = 2.0   // seconds between two scale changes
let H264_SCALE_UP_HOLD = 5.0        // seconds the upscale condition must hold
let H264_SCALES: [Double] = [1.0, 0.75, 0.5]

func h264Message(_ type: UInt8, _ payload: Data) -> Data {
  var d = Data([type])
  d.appendBE(UInt32(payload.count))
  d.append(payload)
  return d
}

@available(macOS 14.0, *)
final class H264Client {
  let fd: Int32
  let input: RfbClient   // pointer/modifier state for rfbPointer/rfbKey (framebuffer = logical, div 1)
  private let queue = DispatchQueue(label: "multicc.h264.client")
  private let lock = NSLock()
  private var pending = 0
  private var needKey = true
  private var closed = false
  private var cap = 0   // kbps this client wants the shared encoder capped at; 0 = no cap
  init(_ fd: Int32) { self.fd = fd; input = RfbClient(fd); input.div = 1; input.hoverMoves = true }

  var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }

  /// This client's requested ceiling in kbps (0 = none).
  var capKbps: Int { lock.lock(); defer { lock.unlock() }; return cap }

  func setCapKbps(_ kbps: Int) {
    lock.lock(); cap = max(0, kbps); lock.unlock()
  }

  func shutdown() {
    lock.lock(); let was = closed; closed = true; lock.unlock()
    if !was { _ = Darwin.shutdown(fd, SHUT_RDWR) }
  }

  /// Queues one message; returns false when a delta was dropped (caller asks for a key).
  func send(_ msg: Data, kind: UInt8) -> Bool {
    lock.lock()
    if closed { lock.unlock(); return true }
    if kind == H264_DELTA && (needKey || pending >= H264_MAX_PENDING) {
      let starving = !needKey
      needKey = true
      lock.unlock()
      return !starving
    }
    if kind == H264_KEY { needKey = false }
    pending += 1
    lock.unlock()
    queue.async { [self] in
      let ok = writeAll(fd, msg)
      lock.lock(); pending -= 1; lock.unlock()
      if !ok { shutdown() }
    }
    return true
  }
}

@available(macOS 14.0, *)
final class H264Screen: NSObject, SCStreamOutput {
  static let shared = H264Screen()
  private let lock = NSLock()
  private let encodeQueue = DispatchQueue(label: "multicc.h264.encode")
  private var stream: SCStream?
  private var display: SCDisplay?    // kept for updateConfiguration (scale changes)
  private var session: VTCompressionSession?
  private var clients: [H264Client] = []
  private var config: Data?          // last config message, replayed to new clients
  private var last: CVPixelBuffer?   // encodeQueue only
  private var forceKey = true        // encodeQueue only
  private var generation = 0         // encodeQueue only: invalidates pending refines
  // Geometry and applied rate are read from h264Session threads (ping) and the
  // encode queue, so they live under `lock`.
  private var inputW = 0             // main display in logical points = pointer domain
  private var inputH = 0
  private var encodedW = 0           // current capture/encode size (after the scale)
  private var encodedH = 0
  private var appliedKbps = 0        // rate actually set on the encoder
  // Rate-controller state: encodeQueue only.
  private var scale = 1.0
  private var lastScaleAt = Date.distantPast
  private var upscaleSince: Date?
  private var rateCheckScheduled = false

  /// Default rate when nobody caps: ~3 bits/pixel/s at logical resolution keeps
  /// text legible while scrolling; still frames are sharpened by refine passes.
  /// Caller must not hold `lock`.
  private func defaultKbps(_ w: Int, _ h: Int) -> Int {
    max(1500, min(12000, w * h * 3 / 1000))
  }

  private func makeSession(_ w: Int, _ h: Int, kbps: Int) -> VTCompressionSession? {
    var s: VTCompressionSession?
    let lowLatency = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue] as CFDictionary
    if VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h), codecType: kCMVideoCodecType_H264,
                                  encoderSpecification: lowLatency, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                  outputCallback: nil, refcon: nil, compressionSessionOut: &s) != noErr {
      s = nil
      guard VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h), codecType: kCMVideoCodecType_H264,
                                       encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                       outputCallback: nil, refcon: nil, compressionSessionOut: &s) == noErr else { return nil }
    }
    guard let s else { return nil }
    let props: [CFString: Any] = [
      kVTCompressionPropertyKey_RealTime: true,
      kVTCompressionPropertyKey_AllowFrameReordering: false,
      kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_ConstrainedHigh_AutoLevel,
      kVTCompressionPropertyKey_ExpectedFrameRate: 30,
      kVTCompressionPropertyKey_MaxKeyFrameInterval: 1800,
      kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 60,
    ]
    for (k, v) in props { VTSessionSetProperty(s, key: k, value: v as CFTypeRef) }
    applyRate(s, kbps: kbps)
    VTCompressionSessionPrepareToEncodeFrames(s)
    return s
  }

  /// AverageBitRate plus a 1-second DataRateLimits window (1.5× the budget in
  /// bytes) so a key frame cannot burst far past the cap the link negotiated.
  private func applyRate(_ s: VTCompressionSession, kbps: Int) {
    let rate = max(H264_MIN_KBPS, kbps)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: (rate * 1000) as CFTypeRef)
    let limits: [CFNumber] = [NSNumber(value: Double(rate) * 1000.0 / 8.0 * 1.5), NSNumber(value: 1.0)]
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_DataRateLimits, value: limits as CFArray)
  }

  /// Smallest cap among clients, clamped into [H264_MIN_KBPS, default]; no caps
  /// means the default formula. 0 = capture is not running.
  private func effectiveKbps() -> Int {
    lock.lock()
    let w = inputW, h = inputH
    let caps = clients.map { $0.capKbps }.filter { $0 > 0 }
    lock.unlock()
    guard w > 0, h > 0 else { return 0 }
    let fallback = defaultKbps(w, h)
    guard let cap = caps.min() else { return fallback }
    return min(fallback, max(H264_MIN_KBPS, cap))
  }

  /// Encode scale for a rate: bits per logical pixel per second. Below ~0.6 the
  /// encoder spends everything on motion, so drop resolution instead.
  private func scaleFor(_ kbps: Int) -> Double {
    lock.lock(); let area = max(1, inputW * inputH); lock.unlock()
    let bpp = Double(kbps) * 1000.0 / Double(area)
    if bpp >= 1.2 { return 1.0 }
    if bpp >= 0.6 { return 0.75 }
    return 0.5
  }

  private func streamConfiguration(_ w: Int, _ h: Int) -> SCStreamConfiguration {
    let cfg = SCStreamConfiguration()
    cfg.showsCursor = true
    cfg.width = w
    cfg.height = h
    cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    cfg.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    cfg.queueDepth = 4
    return cfg
  }

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
    // 4:2:0 needs even dimensions; logical points, like the RFB Tight tier.
    let logicalW = max(2, Int(display.width)), logicalH = max(2, Int(display.height))
    let w = logicalW & ~1, h = logicalH & ~1
    lock.lock(); inputW = logicalW; inputH = logicalH; encodedW = w; encodedH = h; lock.unlock()
    let kbps = effectiveKbps()
    guard let vt = makeSession(w, h, kbps: kbps) else { return "VTCompressionSessionCreate failed" }
    let cfg = streamConfiguration(w, h)
    let s = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: cfg, delegate: nil)
    do { try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: encodeQueue) }
    catch { VTCompressionSessionInvalidate(vt); return "addStreamOutput: \(error.localizedDescription)" }
    var startErr: String?
    let sem2 = DispatchSemaphore(value: 0)
    s.startCapture { e in if let e { startErr = e.localizedDescription }; sem2.signal() }
    if sem2.wait(timeout: .now() + 5) == .timedOut { VTCompressionSessionInvalidate(vt); return "startCapture timed out" }
    if let startErr { VTCompressionSessionInvalidate(vt); return "startCapture: \(startErr)" }
    lock.lock(); stream = s; session = vt; self.display = display; appliedKbps = kbps; lock.unlock()
    encodeQueue.async { [self] in scale = 1.0; lastScaleAt = Date() }
    return nil
  }

  private func releaseCapture() {
    lock.lock(); let s = stream, vt = session; stream = nil; session = nil; display = nil; config = nil; lock.unlock()
    if let s {
      let sem = DispatchSemaphore(value: 0)
      s.stopCapture { _ in sem.signal() }
      _ = sem.wait(timeout: .now() + 2)
    }
    encodeQueue.sync {
      last = nil; forceKey = true; generation += 1
      resetScaleState()
      if let vt { VTCompressionSessionCompleteFrames(vt, untilPresentationTimeStamp: .invalid); VTCompressionSessionInvalidate(vt) }
    }
  }

  /// encodeQueue only.
  private func resetScaleState() {
    scale = 1.0
    upscaleSince = nil
    lastScaleAt = Date.distantPast
  }

  func attach(_ c: H264Client) -> Bool {
    lock.lock(); let wasEmpty = clients.isEmpty; clients.append(c); let cfg = config; lock.unlock()
    if wasEmpty, let err = acquire() {
      log("h264: \(err)")
      lock.lock(); clients.removeAll { $0 === c }; lock.unlock()
      return false
    }
    if let cfg { _ = c.send(cfg, kind: H264_CONFIG) }
    recomputeRate()
    requestKey()
    return true
  }

  func detach(_ c: H264Client) {
    lock.lock(); clients.removeAll { $0 === c }; let nowEmpty = clients.isEmpty; lock.unlock()
    if nowEmpty { releaseCapture() } else { recomputeRate() }
  }

  /// A client set/revoked its rate cap (0x42 'B'): re-derive the shared rate and
  /// possibly the capture scale for everyone.
  func setCapability(_ c: H264Client, kbps: Int) {
    c.setCapKbps(kbps)
    recomputeRate()
  }

  /// 0x50 'P': answer on this client's connection at once with the rate actually
  /// on the encoder, so the client can measure RTT against a known send time.
  func ping(_ c: H264Client, token: UInt32) {
    lock.lock(); let kbps = appliedKbps; lock.unlock()
    var payload = Data()
    payload.appendBE(token)
    payload.appendBE(UInt32(max(0, kbps)))
    // Not a delta: the delta drop rules must never swallow a pong.
    _ = c.send(h264Message(H264_PONG, payload), kind: H264_PONG)
  }

  /// Re-derives the shared bitrate (and scale) after a cap / client change.
  private func recomputeRate() {
    lock.lock(); let running = session != nil; lock.unlock()
    guard running else { return }
    encodeQueue.async { [self] in rateTick() }
  }

  /// encodeQueue only.
  private func rateTick() {
    rateCheckScheduled = false
    let kbps = effectiveKbps()
    guard kbps > 0 else { return }
    lock.lock(); let vt = session; appliedKbps = kbps; lock.unlock()
    if let vt { applyRate(vt, kbps: kbps) }
    let want = scaleFor(kbps)
    considerScale(want)
  }

  /// encodeQueue only. Downscale at once (a stuck queue cannot wait), upscale
  /// only after the nicer rate has held for H264_SCALE_UP_HOLD, never more often
  /// than H264_SCALE_MIN_INTERVAL.
  private func considerScale(_ want: Double) {
    let now = Date()
    if want < scale - 0.001 {
      upscaleSince = nil
      guard now.timeIntervalSince(lastScaleAt) >= H264_SCALE_MIN_INTERVAL else { scheduleRateCheck(); return }
      applyScale(want)
    } else if want > scale + 0.001 {
      guard now.timeIntervalSince(lastScaleAt) >= H264_SCALE_MIN_INTERVAL else { scheduleRateCheck(); return }
      let since = upscaleSince ?? now
      upscaleSince = since
      guard now.timeIntervalSince(since) >= H264_SCALE_UP_HOLD else { scheduleRateCheck(); return }
      applyScale(want)
    } else {
      upscaleSince = nil
    }
  }

  /// encodeQueue only. Re-evaluate later while a change is still pending.
  private func scheduleRateCheck() {
    guard !rateCheckScheduled else { return }
    rateCheckScheduled = true
    encodeQueue.asyncAfter(deadline: .now() + 0.5) { [self] in rateTick() }
  }

  /// encodeQueue only. Rescale SCK (it resizes the pixel buffers for us), then
  /// rebuild the encoder at the new size: a VTCompressionSession is bound to the
  /// dimensions it was created with.
  private func applyScale(_ next: Double) {
    // Read geometry/state under the lock: releaseCapture can run from a client
    // thread (it sets stream/session to nil before draining this queue).
    lock.lock()
    let stream = self.stream
    let old = session
    let lw = inputW, lh = inputH
    lock.unlock()
    guard let stream else { return }
    let w = max(2, Int(Double(lw) * next)) & ~1
    let h = max(2, Int(Double(lh) * next)) & ~1
    scale = next
    lastScaleAt = Date()
    upscaleSince = nil
    stream.updateConfiguration(streamConfiguration(w, h)) { _ in }
    // Drop the old-size image: it cannot be fed to the new session, and letting
    // clients keep the previous resolution until the next frame beats tearing.
    last = nil
    forceKey = true
    generation += 1
    let kbps = effectiveKbps()
    if let old {
      VTCompressionSessionCompleteFrames(old, untilPresentationTimeStamp: .invalid)
      VTCompressionSessionInvalidate(old)
    }
    guard let vt = makeSession(w, h, kbps: kbps) else { log("h264: cannot rebuild encoder at \(w)x\(h)"); return }
    // Capture may have been released while the session was being rebuilt: keep
    // the old (nil) state and throw the new session away instead of leaking it.
    lock.lock()
    let running = stream == self.stream
    if running { session = vt; encodedW = w; encodedH = h; appliedKbps = kbps }
    lock.unlock()
    guard running else { VTCompressionSessionInvalidate(vt); return }
    requestKey()
  }

  /// Next frame is a key frame; on a still screen, re-encode the last image now.
  func requestKey() {
    encodeQueue.async { [self] in
      forceKey = true
      if let pb = last { encode(pb) }
    }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen else { return }
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[AnyHashable: Any]]
    let status = (attachments?.first?[SCStreamFrameInfo.status] as? NSNumber)?.intValue ?? SCFrameStatus.complete.rawValue
    guard status == SCFrameStatus.complete.rawValue, let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    last = pb
    encode(pb)
    // Refine passes: the same image again once the screen settles, so the
    // rate controller can spend bits on detail instead of motion.
    generation += 1
    let gen = generation
    for delay in H264_REFINE_DELAYS {
      encodeQueue.asyncAfter(deadline: .now() + delay) { [self] in
        if generation == gen, let pb = last { encode(pb) }
      }
    }
  }

  /// encodeQueue only.
  private func encode(_ pb: CVPixelBuffer) {
    lock.lock(); let vt = session; lock.unlock()
    guard let vt else { return }
    let props = forceKey ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary : nil
    forceKey = false
    let pts = CMClockGetTime(CMClockGetHostTimeClock())
    VTCompressionSessionEncodeFrame(vt, imageBuffer: pb, presentationTimeStamp: pts, duration: .invalid,
                                    frameProperties: props, infoFlagsOut: nil) { [weak self] status, _, sb in
      guard status == noErr, let sb, let self else { return }
      self.emit(sb)
    }
  }

  private func emit(_ sb: CMSampleBuffer) {
    let att = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]]
    let isKey = !((att?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
    var annexB = Data()
    let startCode: [UInt8] = [0, 0, 0, 1]
    if isKey, let fmt = CMSampleBufferGetFormatDescription(sb) {
      var count = 0
      CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                         parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
      var sps: Data?
      for i in 0..<count {
        var ptr: UnsafePointer<UInt8>?
        var size = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &ptr,
                                                                 parameterSetSizeOut: &size, parameterSetCountOut: nil,
                                                                 nalUnitHeaderLengthOut: nil) == noErr, let ptr else { continue }
        let ps = Data(bytes: ptr, count: size)
        if i == 0 { sps = ps }
        annexB.append(contentsOf: startCode); annexB.append(ps)
      }
      let dims = CMVideoFormatDescriptionGetDimensions(fmt)
      if let sps, sps.count >= 4 {
        let codec = String(format: "avc1.%02X%02X%02X", sps[sps.startIndex + 1], sps[sps.startIndex + 2], sps[sps.startIndex + 3])
        lock.lock(); let iw = inputW, ih = inputH; lock.unlock()
        let json = try? JSONSerialization.data(withJSONObject: [
          "codec": codec, "width": Int(dims.width), "height": Int(dims.height),
          "inputWidth": iw, "inputHeight": ih,
        ])
        if let json {
          let msg = h264Message(H264_CONFIG, json)
          lock.lock(); let changed = config != msg; config = msg; let cs = clients; lock.unlock()
          if changed { for c in cs { _ = c.send(msg, kind: H264_CONFIG) } }
        }
      }
    }
    guard let block = CMSampleBufferGetDataBuffer(sb) else { return }
    var total = 0
    var base: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &total,
                                      dataPointerOut: &base) == noErr, let base else { return }
    // AVCC (4-byte big-endian lengths) → Annex B start codes.
    base.withMemoryRebound(to: UInt8.self, capacity: total) { p in
      var off = 0
      while off + 4 <= total {
        let n = Int(p[off]) << 24 | Int(p[off + 1]) << 16 | Int(p[off + 2]) << 8 | Int(p[off + 3])
        off += 4
        guard n > 0, off + n <= total else { break }
        annexB.append(contentsOf: startCode)
        annexB.append(p + off, count: n)
        off += n
      }
    }
    let us = UInt64(max(0, CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb)) * 1_000_000))
    var payload = Data()
    payload.appendBE(UInt32(us >> 32)); payload.appendBE(UInt32(us & 0xFFFF_FFFF))
    payload.append(annexB)
    let kind = isKey ? H264_KEY : H264_DELTA
    let msg = h264Message(kind, payload)
    lock.lock(); let cs = clients; lock.unlock()
    var wantKey = false
    for c in cs where !c.send(msg, kind: kind) { wantKey = true }
    if wantKey { requestKey() }
  }
}

@available(macOS 14.0, *)
func h264Session(_ fd: Int32) {
  var sendTimeout = timeval(tv_sec: 8, tv_usec: 0)
  _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &sendTimeout, socklen_t(MemoryLayout<timeval>.size))
  var noSigPipe: Int32 = 1
  _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
  let client = H264Client(fd)
  guard H264Screen.shared.attach(client) else { return }
  defer { rfbDragAbort(client.input); client.shutdown(); H264Screen.shared.detach(client) }
  reader: while !client.isClosed {
    guard let head = readFully(fd, 1) else { break }
    switch head[0] {
    case H264_REQ_KEY:
      H264Screen.shared.requestKey()
    case H264_CAP:
      // [kbps u32 BE] — this client's link budget; 0 revokes it.
      guard let b = readFully(fd, 4) else { break reader }
      H264Screen.shared.setCapability(client, kbps: Int(UInt32(b[0]) << 24 | UInt32(b[1]) << 16 | UInt32(b[2]) << 8 | UInt32(b[3])))
    case H264_PING:
      // [token u32 BE] — echoed at once in a type 4 pong with the applied rate.
      guard let b = readFully(fd, 4) else { break reader }
      H264Screen.shared.ping(client, token: UInt32(b[0]) << 24 | UInt32(b[1]) << 16 | UInt32(b[2]) << 8 | UInt32(b[3]))
    case 4:
      guard let b = readFully(fd, 7) else { break reader }
      rfbKey(client.input, down: b[0] == 1,
             keysym: UInt32(b[3]) << 24 | UInt32(b[4]) << 16 | UInt32(b[5]) << 8 | UInt32(b[6]))
    case 5:
      guard let b = readFully(fd, 5) else { break reader }
      rfbPointer(client.input, mask: Int(b[0]), x: Int(b[1]) << 8 | Int(b[2]), y: Int(b[3]) << 8 | Int(b[4]))
    default: break reader
    }
  }
}

@available(macOS 14.0, *)
func serveH264() {
  let sockPath = "\(agentDir)/h264.sock"
  unlink(sockPath)   // stale file from the previous process would make bind fail (see serveRfb)
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { return }
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(sockPath.utf8CString)
  withUnsafeMutableBytes(of: &addr.sun_path) { raw in
    for (i, b) in bytes.prefix(raw.count - 1).enumerated() { raw[i] = UInt8(bitPattern: b) }
  }
  let bound = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0
    }
  }
  guard bound, listen(fd, 8) == 0 else { close(fd); log("h264: cannot listen on \(sockPath): \(String(cString: strerror(errno)))"); return }
  chmod(sockPath, 0o600)
  log("h264: serving \(sockPath)")
  while true {
    let c = accept(fd, nil, nil)
    if c < 0 { continue }
    DispatchQueue.global().async {
      defer { close(c) }
      var uid: uid_t = 0, gid: gid_t = 0
      guard getpeereid(c, &uid, &gid) == 0, uid == getuid() else { return }
      h264Session(c)
    }
  }
}

#endif
