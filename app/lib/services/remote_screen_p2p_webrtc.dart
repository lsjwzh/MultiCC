import 'dart:async';
import 'dart:io' show Platform;
import 'dart:typed_data';

import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;

import 'remote_screen_p2p.dart';

/// [RtcPeer] 的真实现：flutter_webrtc（Google libwebrtc）。
///
/// 只做数据通道，不碰摄像头/麦克风：客户端建一条有序 DataChannel（标签
/// `screen`，与服务端 `src/remote-screen-p2p.js` 对齐），offer 里自带 SCTP，
/// ICE 走 trickle（候选随 WS 信令发出去）。帧格式由 [RemoteScreenP2pMux]
/// 负责，这里只搬运字节。
class FlutterRtcPeer implements RtcPeer {
  FlutterRtcPeer._(this._pc, this._dc);

  static const _label = 'screen';

  static Future<RtcPeer> create(List<Map<String, dynamic>> iceServers) async {
    // 平台插件只在 App 进程里注册。纯 Dart 宿主（单测、非移动平台）里
    // flutter_webrtc 的 EventChannel 会在 onListen 里同步抛
    // “Binding has not yet been initialized” —— 那个错误挂在被丢弃的
    // Future 上，外面的 try/catch 接不住，会连累整条远控 WS。这里先挡掉，
    // 让复用器安静地留在中继上。
    if (!Platform.isIOS && !Platform.isAndroid) {
      throw StateError('webrtc-unsupported-platform');
    }
    final pc = await rtc.createPeerConnection({
      'iceServers': iceServers,
      'sdpSemantics': 'unified-plan',
      'bundlePolicy': 'max-bundle',
      'rtcpMuxPolicy': 'require',
    });
    final dc = await pc.createDataChannel(
      _label,
      rtc.RTCDataChannelInit()
        ..ordered = true
        ..binaryType = 'binary',
    );
    return FlutterRtcPeer._(pc, dc);
  }

  final rtc.RTCPeerConnection _pc;
  final rtc.RTCDataChannel _dc;

  final StreamController<void> _opened = StreamController<void>.broadcast();
  final StreamController<void> _closed = StreamController<void>.broadcast();
  final StreamController<Uint8List> _incoming =
      StreamController<Uint8List>.broadcast();
  final StreamController<Map<String, dynamic>> _candidates =
      StreamController<Map<String, dynamic>>.broadcast();

  bool _open = false;
  bool _finished = false;

  /// 惰性接线：只有真的被 mux 用上时才装回调（单测里不会走到这里）。
  bool _wired = false;

  void _wire() {
    if (_wired) return;
    _wired = true;
    _dc.onMessage = (message) {
      if (!message.isBinary) return;
      final bytes = message.binary;
      if (bytes.isEmpty || _incoming.isClosed) return;
      _incoming.add(bytes);
    };
    _dc.onDataChannelState = (state) {
      if (state == rtc.RTCDataChannelState.RTCDataChannelOpen) {
        _open = true;
        if (!_opened.isClosed) _opened.add(null);
      } else if (state == rtc.RTCDataChannelState.RTCDataChannelClosed ||
          state == rtc.RTCDataChannelState.RTCDataChannelClosing) {
        _finish();
      }
    };
    _pc.onConnectionState = (state) {
      if (state == rtc.RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
          state == rtc.RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        _finish();
      }
    };
    _pc.onIceCandidate = (candidate) {
      final value = candidate.candidate;
      if (value == null || value.isEmpty || _candidates.isClosed) return;
      _candidates.add({
        'candidate': value,
        'sdpMid': candidate.sdpMid,
        'sdpMLineIndex': candidate.sdpMLineIndex,
      });
    };
  }

  @override
  Stream<void> get opened {
    _wire();
    return _opened.stream;
  }

  @override
  Stream<void> get closed {
    _wire();
    return _closed.stream;
  }

  @override
  Stream<Uint8List> get incoming {
    _wire();
    return _incoming.stream;
  }

  @override
  Stream<Map<String, dynamic>> get candidates {
    _wire();
    return _candidates.stream;
  }

  @override
  bool get isOpen =>
      _open ||
      (!_finished && _dc.state == rtc.RTCDataChannelState.RTCDataChannelOpen);

  @override
  Future<String> createOffer() async {
    _wire();
    final offer = await _pc.createOffer({});
    await _pc.setLocalDescription(offer);
    final local = await _pc.getLocalDescription();
    return local?.sdp ?? offer.sdp ?? '';
  }

  @override
  Future<void> acceptAnswer(String sdp) async {
    await _pc.setRemoteDescription(rtc.RTCSessionDescription(sdp, 'answer'));
  }

  @override
  Future<void> addCandidate({
    required String candidate,
    String? sdpMid,
    int? sdpMLineIndex,
  }) async {
    await _pc.addCandidate(
      rtc.RTCIceCandidate(candidate, sdpMid, sdpMLineIndex),
    );
  }

  @override
  void send(Uint8List bytes) {
    if (!isOpen) throw StateError('datachannel-closed');
    unawaited(_dc.send(rtc.RTCDataChannelMessage.fromBinary(bytes)));
  }

  @override
  Future<void> close() async {
    _finished = true;
    try {
      await _dc.close();
    } catch (_) {}
    try {
      await _pc.close();
    } catch (_) {}
    try {
      await _pc.dispose();
    } catch (_) {}
    await _closeQuietly(_opened);
    await _closeQuietly(_closed);
    await _closeQuietly(_incoming);
    await _closeQuietly(_candidates);
  }

  void _finish() {
    if (_finished) return;
    _finished = true;
    _open = false;
    if (!_closed.isClosed) _closed.add(null);
  }

  static Future<void> _closeQuietly(StreamController<dynamic> controller) async {
    if (controller.isClosed) return;
    try {
      await controller.close();
    } catch (_) {}
  }
}
