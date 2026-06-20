import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Drives the Android foreground "keep-alive" service that holds the app process
/// — and with it the live WebSocket connections in the UI isolate — awake while
/// MultiCC is in the background.
///
/// No-op on every non-Android platform: iOS forbids long-lived background
/// sockets, so there is nothing to start there (the app relies on server-side
/// push + seamless resume instead).
class BackgroundKeepAlive {
  static const _channel = MethodChannel('com.multicc.multicc_app/keepalive');

  /// Tracks the service state we requested, so repeated start/stop calls (e.g.
  /// rapid background/foreground flips) don't spam the platform channel.
  static bool _running = false;

  static bool get isSupported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  static Future<void> start() async {
    if (!isSupported || _running) return;
    _running = true;
    try {
      await _channel.invokeMethod('start');
    } catch (_) {
      _running = false;
    }
  }

  static Future<void> stop() async {
    if (!isSupported) return;
    // Always attempt the stop even if we don't think it's running: the OS can
    // recreate or outlive our in-memory `_running` flag (e.g. across a process
    // restart), and stopping an already-stopped service is a harmless no-op.
    _running = false;
    try {
      await _channel.invokeMethod('stop');
    } catch (_) {}
  }
}
