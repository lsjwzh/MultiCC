import Flutter
import UIKit
import UserNotifications
import AVFoundation

@main
@objc class AppDelegate: FlutterAppDelegate {
  /// 「🖥 屏幕」高清流畅模式的 VideoToolbox 解码器（见 H264Decoder.swift）。
  private var h264Platform: H264Platform?
  private var videoCompressionChannel: FlutterMethodChannel?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // FlutterAppDelegate forwards foreground presentation and tap callbacks
    // to flutter_local_notifications.
    UNUserNotificationCenter.current().delegate = self
    GeneratedPluginRegistrant.register(with: self)
    if let registrar = self.registrar(forPlugin: "MulticcH264") {
      h264Platform = H264Platform(messenger: registrar.messenger())
    }
    if let registrar = self.registrar(forPlugin: "MulticcVideoCompression") {
      let channel = FlutterMethodChannel(
        name: "com.multicc.multicc_app/video_compression", binaryMessenger: registrar.messenger())
      channel.setMethodCallHandler { call, result in
        guard call.method == "compress" else { result(FlutterMethodNotImplemented); return }
        guard let args = call.arguments as? [String: Any],
              let path = args["path"] as? String,
              let maxBytes = (args["maxBytes"] as? NSNumber)?.int64Value,
              maxBytes > 0 else {
          result(FlutterError(code: "invalid_arguments", message: "Invalid video compression arguments", details: nil))
          return
        }
        DispatchQueue.global(qos: .userInitiated).async {
          let asset = AVURLAsset(url: URL(fileURLWithPath: path))
          let presets = [AVAssetExportPresetMediumQuality, AVAssetExportPresetLowQuality]
          Self.exportVideo(asset: asset, presets: presets, maxBytes: maxBytes, result: result)
        }
      }
      videoCompressionChannel = channel
    }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  private static func exportVideo(
    asset: AVAsset, presets: [String], maxBytes: Int64, result: @escaping FlutterResult
  ) {
    guard let preset = presets.first else {
      DispatchQueue.main.async {
        result(FlutterError(code: "compression_failed", message: "Video could not be compressed to the upload limit", details: nil))
      }
      return
    }
    let remaining = Array(presets.dropFirst())
    guard let session = AVAssetExportSession(asset: asset, presetName: preset) else {
      exportVideo(asset: asset, presets: remaining, maxBytes: maxBytes, result: result)
      return
    }
    let fileType: AVFileType
    let ext: String
    if session.supportedFileTypes.contains(.mp4) {
      fileType = .mp4
      ext = "mp4"
    } else if session.supportedFileTypes.contains(.mov) {
      fileType = .mov
      ext = "mov"
    } else {
      exportVideo(asset: asset, presets: remaining, maxBytes: maxBytes, result: result)
      return
    }
    let output = FileManager.default.temporaryDirectory
      .appendingPathComponent("multicc-video-\(UUID().uuidString).\(ext)")
    session.outputURL = output
    session.outputFileType = fileType
    session.shouldOptimizeForNetworkUse = true
    session.exportAsynchronously {
      let size = (try? FileManager.default.attributesOfItem(atPath: output.path)[.size] as? NSNumber)?.int64Value
      if session.status == .completed, let size = size, size > 0, size <= maxBytes {
        DispatchQueue.main.async { result(output.path) }
      } else {
        try? FileManager.default.removeItem(at: output)
        exportVideo(asset: asset, presets: remaining, maxBytes: maxBytes, result: result)
      }
    }
  }
}
