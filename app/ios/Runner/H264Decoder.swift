import Accelerate
import Flutter
import Foundation
import VideoToolbox

// 「🖥 屏幕」高清流畅模式的 iOS 解码器：VideoToolbox 解 H.264，输出 BGRA，
// 统一降到 ≤1280 宽后经 MethodChannel 交给 Flutter 页面。
//
// 通道协议见 app/lib/services/platform_h264_decoder.dart：
//   Dart → 原生  create / decode {bytes, pts, key, width, height} / dispose
//   原生 → Dart  frame {bytes(BGRA), width, height, seq}
//                error {message}   ← 积压或解码失败，前端据此重新要关键帧
//
// 输入是 Annex B（SPS/PPS 在关键帧前面），VideoToolbox 要的是 AVCC：
// 去掉起始码、每个 NAL 换成 4 字节大端长度。SPS/PPS 变化时重建解码会话。

/// 注册到 FlutterEngine 的通道外壳；AppDelegate 持有一个实例。
final class H264Platform: NSObject {
  private let channel: FlutterMethodChannel
  private var decoder: IosH264Decoder?

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(
      name: "com.multicc.multicc_app/h264", binaryMessenger: messenger)
    super.init()
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self = self else {
        result(FlutterError(code: "disposed", message: "h264 channel disposed", details: nil))
        return
      }
      self.handle(call, result: result)
    }
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "create":
      decoder?.close()
      decoder = IosH264Decoder(channel: channel)
      result(true)
    case "decode":
      guard let args = call.arguments as? [String: Any],
        let typed = args["bytes"] as? FlutterStandardTypedData
      else {
        result(nil)
        return
      }
      let pts = (args["pts"] as? NSNumber)?.int64Value ?? 0
      let key = (args["key"] as? Bool) ?? false
      let width = (args["width"] as? NSNumber)?.intValue ?? 0
      let height = (args["height"] as? NSNumber)?.intValue ?? 0
      decoder?.decode(typed.data, ptsUs: pts, key: key, width: width, height: height)
      result(nil)
    case "dispose":
      decoder?.close()
      decoder = nil
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }
}

final class IosH264Decoder {
  /// 输出长边上限；页面按逻辑尺寸缩放，手机端没必要搬 5K 原始帧。
  static let maxWidth = 1280

  private let channel: FlutterMethodChannel
  private let lock = NSLock()
  private let queue = DispatchQueue(label: "multicc.h264.decode", qos: .userInitiated)

  private var session: VTDecompressionSession?
  private var format: CMVideoFormatDescription?
  private var paramKey = ""
  private var pending = 0
  private var seq = 0
  private var closed = false

  init(channel: FlutterMethodChannel) {
    self.channel = channel
  }

  func decode(_ data: Data, ptsUs: Int64, key: Bool, width: Int, height: Int) {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    // 积压超过 2 帧就丢普通帧、让前端重关键帧——和 Web/Android 端同一策略。
    if !key && pending > 2 {
      lock.unlock()
      notifyError("decode-need-key")
      return
    }
    pending += 1
    lock.unlock()

    queue.async { [weak self] in
      guard let self = self else { return }
      defer { self.finishFrame() }
      self.decodeOnQueue(data, ptsUs: ptsUs, key: key)
    }
  }

  func close() {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    closed = true
    lock.unlock()
    queue.async { [weak self] in
      self?.invalidateSession()
    }
  }

  private func finishFrame() {
    lock.lock()
    pending = max(0, pending - 1)
    lock.unlock()
  }

  private func decodeOnQueue(_ data: Data, ptsUs: Int64, key: Bool) {
    lock.lock()
    let isClosed = closed
    lock.unlock()
    if isClosed { return }

    let nals = IosH264Decoder.splitAnnexB([UInt8](data))
    if nals.isEmpty {
      notifyError("decode-bad-frame")
      return
    }

    if key {
      var sps: [UInt8]?
      var pps: [UInt8]?
      for nal in nals {
        if nal.type == 7 && sps == nil { sps = nal.payload }
        if nal.type == 8 && pps == nil { pps = nal.payload }
      }
      if let s = sps, let p = pps {
        let fp = "\(s.count):\(p.count):\(s.first ?? 0):\(p.first ?? 0)"
        if fp != paramKey {
          invalidateSession()
          paramKey = fp
        }
        if format == nil {
          guard let f = IosH264Decoder.makeFormat(sps: s, pps: p) else {
            notifyError("decode-format")
            return
          }
          format = f
        }
      }
    }

    guard let fmt = format else {
      // 关键帧之前或 SPS/PPS 丢失：等下一个关键帧。
      notifyError("decode-need-key")
      return
    }

    var avcc = [UInt8]()
    avcc.reserveCapacity(data.count)
    for nal in nals {
      if nal.type == 7 || nal.type == 8 { continue }
      let n = nal.payload.count
      avcc.append(UInt8((n >> 24) & 0xFF))
      avcc.append(UInt8((n >> 16) & 0xFF))
      avcc.append(UInt8((n >> 8) & 0xFF))
      avcc.append(UInt8(n & 0xFF))
      avcc.append(contentsOf: nal.payload)
    }
    if avcc.isEmpty { return }

    guard let sample = IosH264Decoder.makeSample(avcc, format: fmt, ptsUs: ptsUs) else {
      notifyError("decode-sample")
      return
    }
    guard ensureSession(format: fmt), let vt = session else {
      notifyError("decode-session")
      return
    }
    var infoFlags = VTDecodeInfoFlags()
    let status = VTDecompressionSessionDecodeFrame(
      vt, sampleBuffer: sample, flags: [], frameRefcon: nil, infoFlagsOut: &infoFlags)
    if status != noErr {
      // App 切后台再回来，硬件解码会话会失效（kVTInvalidSessionErr），之后每一帧
      // 都失败、画面停住。丢掉会话，下一个关键帧带着 SPS/PPS 重建 —— 与 Android
      // 端出错即 resetCodec 同一策略。
      invalidateSession()
      notifyError("decode-status-\(status)")
    }
  }

  private func ensureSession(format: CMVideoFormatDescription) -> Bool {
    if session != nil { return true }
    let attrs: [String: Any] = [
      kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
      kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
    ]
    var callback = VTDecompressionOutputCallbackRecord(
      decompressionOutputCallback: IosH264Decoder.outputCallback,
      decompressionOutputRefCon: Unmanaged.passUnretained(self).toOpaque())
    var created: VTDecompressionSession?
    let status = VTDecompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      formatDescription: format,
      decoderSpecification: nil,
      imageBufferAttributes: attrs as CFDictionary,
      outputCallback: &callback,
      decompressionSessionOut: &created)
    guard status == noErr, let vt = created else { return false }
    session = vt
    return true
  }

  private func invalidateSession() {
    if let vt = session {
      VTDecompressionSessionInvalidate(vt)
    }
    session = nil
    format = nil
    paramKey = ""
  }

  private static let outputCallback: VTDecompressionOutputCallback = {
    refcon, _, status, _, imageBuffer, _, _ in
    guard let refcon = refcon else { return }
    let decoder = Unmanaged<IosH264Decoder>.fromOpaque(refcon).takeUnretainedValue()
    decoder.handleOutput(status: status, imageBuffer: imageBuffer)
  }

  fileprivate func handleOutput(status: OSStatus, imageBuffer: CVImageBuffer?) {
    lock.lock()
    let isClosed = closed
    lock.unlock()
    if isClosed { return }
    if status != noErr || imageBuffer == nil {
      if status == kVTInvalidSessionErr {
        queue.async { [weak self] in self?.invalidateSession() }
      }
      notifyError("decode-output")
      return
    }
    guard let buffer = imageBuffer else { return }
    emit(buffer)
  }

  private func emit(_ pixelBuffer: CVPixelBuffer) {
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return }
    let sw = CVPixelBufferGetWidth(pixelBuffer)
    let sh = CVPixelBufferGetHeight(pixelBuffer)
    let rowBytes = CVPixelBufferGetBytesPerRow(pixelBuffer)
    if sw <= 0 || sh <= 0 { return }

    let dw = min(sw, IosH264Decoder.maxWidth)
    let dh = dw == sw ? sh : max(2, sh * dw / sw)
    var data = Data(count: dw * dh * 4)
    let ok = data.withUnsafeMutableBytes { raw -> Bool in
      guard let dest = raw.baseAddress else { return false }
      if dw == sw {
        for y in 0..<sh {
          memcpy(dest.advanced(by: y * dw * 4), base.advanced(by: y * rowBytes), dw * 4)
        }
        return true
      }
      var src = vImage_Buffer(
        data: base, height: vImagePixelCount(sh), width: vImagePixelCount(sw),
        rowBytes: rowBytes)
      var dst = vImage_Buffer(
        data: dest, height: vImagePixelCount(dh), width: vImagePixelCount(dw),
        rowBytes: dw * 4)
      // BGRA 与 ARGB8888 逐通道缩放等价（vImage 只按字节平面处理）。
      let err = vImageScale_ARGB8888(
        &src, &dst, nil, vImage_Flags(kvImageHighQualityResampling))
      return err == kvImageNoError
    }
    if !ok { return }

    seq += 1
    let index = seq
    let args: [String: Any] = [
      "bytes": FlutterStandardTypedData(bytes: data),
      "width": dw,
      "height": dh,
      "seq": index,
    ]
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.lock.lock()
      let isClosed = self.closed
      self.lock.unlock()
      if !isClosed {
        self.channel.invokeMethod("frame", arguments: args)
      }
    }
  }

  private func notifyError(_ message: String) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.lock.lock()
      let isClosed = self.closed
      self.lock.unlock()
      if !isClosed {
        self.channel.invokeMethod("error", arguments: ["message": message])
      }
    }
  }

  // MARK: - Annex B / AVCC

  private struct Nal {
    let type: UInt8
    let payload: [UInt8]
  }

  /// 拆 Annex B；payload 不含起始码。四字节与三字节起始码都认。
  private static func splitAnnexB(_ bytes: [UInt8]) -> [Nal] {
    var marks = [(code: Int, payload: Int)]()
    var i = 0
    while i + 3 <= bytes.count {
      if i + 4 <= bytes.count, bytes[i] == 0, bytes[i + 1] == 0, bytes[i + 2] == 0,
        bytes[i + 3] == 1
      {
        marks.append((i, i + 4))
        i += 4
      } else if bytes[i] == 0, bytes[i + 1] == 0, bytes[i + 2] == 1 {
        marks.append((i, i + 3))
        i += 3
      } else {
        i += 1
      }
    }
    var out = [Nal]()
    for k in 0..<marks.count {
      let start = marks[k].payload
      let end = k + 1 < marks.count ? marks[k + 1].code : bytes.count
      if start >= end { continue }
      out.append(Nal(type: bytes[start] & 0x1F, payload: Array(bytes[start..<end])))
    }
    return out
  }

  private static func makeFormat(sps: [UInt8], pps: [UInt8]) -> CMVideoFormatDescription? {
    let params = [sps, pps]
    let buffers = params.map { p -> UnsafeMutablePointer<UInt8> in
      let b = UnsafeMutablePointer<UInt8>.allocate(capacity: p.count)
      b.initialize(from: p, count: p.count)
      return b
    }
    defer { buffers.forEach { $0.deallocate() } }
    var pointers = [UnsafePointer<UInt8>]()
    for b in buffers { pointers.append(UnsafePointer(b)) }
    var sizes = [Int]()
    for p in params { sizes.append(p.count) }

    var fmt: CMVideoFormatDescription?
    let status = pointers.withUnsafeBufferPointer { pp in
      sizes.withUnsafeBufferPointer { ss in
        CMVideoFormatDescriptionCreateFromH264ParameterSets(
          allocator: kCFAllocatorDefault,
          parameterSetCount: pp.count,
          parameterSetPointers: pp.baseAddress!,
          parameterSetSizes: ss.baseAddress!,
          nalUnitHeaderLength: 4,
          formatDescriptionOut: &fmt)
      }
    }
    return status == noErr ? fmt : nil
  }

  private static func makeSample(
    _ avcc: [UInt8], format: CMVideoFormatDescription, ptsUs: Int64
  ) -> CMSampleBuffer? {
    var block: CMBlockBuffer?
    let status = CMBlockBufferCreateWithMemoryBlock(
      allocator: kCFAllocatorDefault,
      memoryBlock: nil,
      blockLength: avcc.count,
      blockAllocator: kCFAllocatorDefault,
      customBlockSource: nil,
      offsetToData: 0,
      dataLength: avcc.count,
      flags: 0,
      blockBufferOut: &block)
    guard status == kCMBlockBufferNoErr, let bb = block else { return nil }

    let copied = avcc.withUnsafeBytes { raw -> OSStatus in
      guard let base = raw.baseAddress else { return -1 }
      return CMBlockBufferReplaceDataBytes(
        with: base, blockBuffer: bb, offsetIntoDestination: 0, dataLength: avcc.count)
    }
    guard copied == kCMBlockBufferNoErr else { return nil }

    var timing = CMSampleTimingInfo(
      duration: .invalid,
      presentationTimeStamp: CMTime(value: ptsUs, timescale: 1_000_000),
      decodeTimeStamp: .invalid)
    var size = avcc.count
    var sample: CMSampleBuffer?
    let st = CMSampleBufferCreateReady(
      allocator: kCFAllocatorDefault,
      dataBuffer: bb,
      formatDescription: format,
      sampleCount: 1,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleSizeEntryCount: 1,
      sampleSizeArray: &size,
      sampleBufferOut: &sample)
    return st == noErr ? sample : nil
  }
}
