// VoiceDictationService — 输入框麦克风的流式听写（Flutter 端口）。
//
// 对齐 web 的 public/voice-stream.js + chat-composer.js 的语音 HUD：
//   麦克风 → PCM16LE 单声道帧 → /ws/voice → 边说边回 partial/final →
//   final 变动后去抖调用 /api/voice/refine 润色 → 用户点发送时取 refined||raw。
//
// 与旧的「录 m4a → /api/voice/stt → 面板」相比，用户在说的过程中就能看见文字，
// 也不用等整段上传。旧流程保留在 input_bar 里当回退：这条链路依赖 /ws/voice
// 与后端 ASR provider，任一不可用时仍要有能用的语音输入。
//
// 服务端契约见 plugins/voice/voice-asr.js 的 handleVoiceWs：
//   → {type:'start', provider, lang}      ← {type:'ready', provider, sampleRate}
//   → 二进制 PCM16LE 帧                    ← {type:'partial'|'final', text}  (text 是累计全文)
//   → {type:'stop'}                        ← {type:'done', text} / {type:'error', message}

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:record/record.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'settings_service.dart';
import 'ws_ticket_service.dart';

enum VoiceDictationState {
  idle,
  starting,
  listening,
  finalizing,
  done,
  failed,
}

/// 失败原因。UI 负责翻译；[VoiceDictationService.errorDetail] 里是服务端原文，
/// 只在 [asr] 时有意义。
enum VoiceDictationError { none, connect, microphone, asr }

/// 一次听写的产物。[text] 是要发出去的那一句（有润色用润色），[raw]/[refined]
/// 一起回传给 /api/voice/feedback，用于评估润色质量。
class VoiceDictationResult {
  final String raw;
  final String refined;
  final String text;

  const VoiceDictationResult({
    required this.raw,
    required this.refined,
    required this.text,
  });

  bool get isEmpty => text.isEmpty;
}

/// 一路已经打开的麦克风。[frames] 是 PCM16LE 单声道帧流。
class VoiceMic {
  final Stream<Uint8List> frames;
  final Future<void> Function() close;

  const VoiceMic({required this.frames, required this.close});
}

/// 按服务端要求的采样率开麦；权限被拒时返回 null。
typedef VoiceMicOpener = Future<VoiceMic?> Function(int sampleRate);

VoiceMicOpener _recorderMicOpener(AudioRecorder recorder) {
  return (sampleRate) async {
    if (!await recorder.hasPermission()) return null;
    final stream = await recorder.startStream(
      RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        numChannels: 1,
        // 直接按服务端 ready 给的采样率开麦，省掉一次重采样。
        sampleRate: sampleRate,
        autoGain: true,
        echoCancel: true,
        noiseSuppress: true,
      ),
    );
    return VoiceMic(
      frames: stream,
      close: () async {
        try {
          await recorder.stop();
        } catch (_) {}
      },
    );
  };
}

class VoiceDictationService extends ChangeNotifier {
  final SettingsService settings;
  final WsTicketConnectionGate _auth;
  final WebSocketChannel Function(Uri) _connect;
  final VoiceMicOpener _openMic;
  final http.Client _http;
  final AudioRecorder? _ownedRecorder;

  /// final 变动到发起润色之间的去抖，和 web 的 250ms 一致。
  final Duration refineDebounce;

  /// 点发送后，最多再等这么久让服务端把最后一段落成 final。
  final Duration finalGrace;

  /// 点发送后，最多再等这么久让在途的润色收敛。
  final Duration refineGrace;

  /// 轮询上面两个宽限期的粒度。
  final Duration pollInterval;

  VoiceDictationService({
    required this.settings,
    WsTicketClient? wsTicketClient,
    WebSocketChannel Function(Uri)? channelFactory,
    VoiceMicOpener? micOpener,
    http.Client? httpClient,
    this.refineDebounce = const Duration(milliseconds: 250),
    this.finalGrace = const Duration(milliseconds: 800),
    this.refineGrace = const Duration(seconds: 3),
    this.pollInterval = const Duration(milliseconds: 80),
  }) : _auth = WsTicketConnectionGate(wsTicketClient ?? WsTicketClient()),
       _connect = channelFactory ?? WebSocketChannel.connect,
       _ownedRecorder = micOpener == null ? AudioRecorder() : null,
       _openMic = micOpener ?? _recorderMicOpener(AudioRecorder()),
       _http = httpClient ?? http.Client();

  VoiceDictationState _state = VoiceDictationState.idle;
  VoiceDictationState get state => _state;

  VoiceDictationError _error = VoiceDictationError.none;
  VoiceDictationError get error => _error;

  String _errorDetail = '';
  String get errorDetail => _errorDetail;

  String _rawFinal = '';
  String get rawFinal => _rawFinal;

  String _rawPartial = '';
  String get rawPartial => _rawPartial;

  String _refined = '';
  String get refined => _refined;

  bool get isBusy =>
      _state == VoiceDictationState.starting ||
      _state == VoiceDictationState.listening ||
      _state == VoiceDictationState.finalizing;

  bool get hasText => _rawFinal.trim().isNotEmpty || _rawPartial.trim().isNotEmpty;

  /// 每次 start/cancel 都换代。所有异步回调都先比对代号，避免上一轮迟到的
  /// ticket、麦克风帧或 WS 消息污染新一轮（和 web HUD 的 generation 守卫同构）。
  int _generation = 0;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _wsSub;
  VoiceMic? _mic;
  StreamSubscription<Uint8List>? _micSub;

  Timer? _refineTimer;
  int _refineSeq = 0;
  Future<void>? _refineInFlight;

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  /// 开麦并开始流式识别。返回是否真的进入了识别状态；false 时调用方应回退到
  /// 旧的整段上传流程。
  Future<bool> start({String provider = 'auto'}) async {
    if (isBusy) return false;
    final generation = ++_generation;
    _resetTranscript();
    _setState(VoiceDictationState.starting);

    final Uri authorized;
    try {
      final attempt = _auth.begin(
        socketUri: buildMulticcWebSocketUri(
          host: settings.host,
          path: MulticcWsPath.voice,
        ),
        ticketEndpoint: Uri.parse(settings.buildHttpUrl('/api/auth/ws-ticket')),
        accessToken: settings.token,
      );
      authorized = await attempt.authorizedUri;
      if (!attempt.isCurrent || generation != _generation) return false;
    } catch (_) {
      if (generation == _generation) _fail(VoiceDictationError.connect);
      return false;
    }

    final WebSocketChannel channel;
    try {
      channel = _connect(authorized);
    } catch (_) {
      if (generation == _generation) _fail(VoiceDictationError.connect);
      return false;
    }
    if (generation != _generation) {
      _closeChannel(channel);
      return false;
    }
    _channel = channel;
    _wsSub = channel.stream.listen(
      (data) => _onMessage(generation, data),
      onError: (_) => _onTransportGone(generation, failed: true),
      onDone: () => _onTransportGone(generation, failed: false),
      cancelOnError: true,
    );
    try {
      channel.sink.add(
        jsonEncode({
          'type': 'start',
          'provider': provider,
          'lang': settings.lang,
        }),
      );
    } catch (_) {
      if (generation == _generation) _fail(VoiceDictationError.connect);
      return false;
    }
    return true;
  }

  /// 停采、催服务端出最后一段 final、等润色收敛，返回该发出去的文本。
  Future<VoiceDictationResult> commit() async {
    final generation = _generation;
    if (_state != VoiceDictationState.listening &&
        _state != VoiceDictationState.starting) {
      return _snapshot();
    }
    _setState(VoiceDictationState.finalizing);
    await _stopMic();
    try {
      _channel?.sink.add(jsonEncode({'type': 'stop'}));
    } catch (_) {}

    // 用户松手时最后半句往往还在上游，等一小会儿它落成 final 再取文本。
    final before = _rawFinal;
    final deadline = DateTime.now().add(finalGrace);
    while (DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(pollInterval);
      if (generation != _generation) return _snapshot();
      if (_rawFinal != before) break;
    }

    // 去抖还没到点就立刻跑一次；已经在跑就等它，超时按现有结果发。
    if (_refineTimer != null) {
      _refineTimer!.cancel();
      _refineTimer = null;
      final raw = _rawFinal.trim();
      if (raw.isNotEmpty) await _runRefine(generation, raw);
    } else if (_refineInFlight != null) {
      try {
        await _refineInFlight!.timeout(refineGrace);
      } catch (_) {}
    }
    if (generation != _generation) return _snapshot();

    final result = _snapshot();
    _teardown();
    _setState(VoiceDictationState.done);
    return result;
  }

  /// 放弃这一轮：停麦、断开、清空文本。
  void cancel() {
    _generation++;
    _teardown();
    _resetTranscript();
    _setState(VoiceDictationState.idle);
  }

  /// 把「识别原文 / 润色稿 / 用户最终发出的文本」回传给服务端做润色质量评估。
  /// 纯旁路，失败不影响已经发出去的消息。
  void reportFeedback(VoiceDictationResult result, {String? userFinal}) {
    final raw = result.raw.trim();
    if (raw.isEmpty) return;
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
    _http
        .post(
          Uri.parse(settings.buildHttpUrl('/api/voice/feedback')),
          headers: headers,
          body: jsonEncode({
            'raw': raw,
            'refined': result.refined,
            'userFinal': (userFinal ?? result.text).trim(),
          }),
        )
        .catchError((_) => http.Response('', 599));
  }

  @override
  void dispose() {
    _generation++;
    _teardown();
    _ownedRecorder?.dispose();
    _http.close();
    super.dispose();
  }

  // ── WS 消息 ───────────────────────────────────────────────────────────────

  void _onMessage(int generation, dynamic data) {
    if (generation != _generation || data is! String) return;
    Map<String, dynamic> msg;
    try {
      final decoded = jsonDecode(data);
      if (decoded is! Map) return;
      msg = Map<String, dynamic>.from(decoded);
    } catch (_) {
      return;
    }
    switch (msg['type']) {
      case 'ready':
        _onReady(generation, msg);
        break;
      case 'partial':
        final full = (msg['text'] ?? '').toString();
        // text 是累计全文；只把「超出已定稿部分」当作待定的灰字。
        _rawPartial = full.startsWith(_rawFinal)
            ? full.substring(_rawFinal.length)
            : full;
        notifyListeners();
        break;
      case 'final':
        _rawFinal = (msg['text'] ?? '').toString();
        _rawPartial = '';
        notifyListeners();
        _scheduleRefine(generation);
        break;
      case 'done':
        final text = (msg['text'] ?? '').toString();
        if (text.isNotEmpty) {
          _rawFinal = text;
          _rawPartial = '';
          notifyListeners();
        }
        break;
      case 'error':
        _fail(
          VoiceDictationError.asr,
          detail: (msg['message'] ?? '').toString(),
        );
        break;
    }
  }

  Future<void> _onReady(int generation, Map<String, dynamic> msg) async {
    final rate = msg['sampleRate'];
    final sampleRate = rate is int ? rate : int.tryParse('$rate') ?? 16000;
    VoiceMic? mic;
    try {
      mic = await _openMic(sampleRate);
    } catch (_) {
      mic = null;
    }
    if (generation != _generation) {
      await mic?.close();
      return;
    }
    if (mic == null) {
      _fail(VoiceDictationError.microphone);
      return;
    }
    _mic = mic;
    _micSub = mic.frames.listen(
      (chunk) {
        if (generation != _generation || chunk.isEmpty) return;
        try {
          _channel?.sink.add(chunk);
        } catch (_) {}
      },
      onError: (_) {},
    );
    if (_state == VoiceDictationState.starting) {
      _setState(VoiceDictationState.listening);
    }
  }

  void _onTransportGone(int generation, {required bool failed}) {
    if (generation != _generation) return;
    // commit() 里 socket 正常关闭是预期路径，别把它报成故障。
    if (_state == VoiceDictationState.starting ||
        (_state == VoiceDictationState.listening && failed)) {
      _fail(VoiceDictationError.connect);
    }
  }

  // ── 润色 ──────────────────────────────────────────────────────────────────

  void _scheduleRefine(int generation) {
    _refineTimer?.cancel();
    final raw = _rawFinal.trim();
    if (raw.isEmpty) return;
    _refineTimer = Timer(refineDebounce, () {
      _refineTimer = null;
      _runRefine(generation, raw);
    });
  }

  Future<void> _runRefine(int generation, String raw) {
    final seq = ++_refineSeq;
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
    final pending = () async {
      try {
        final res = await _http.post(
          Uri.parse(settings.buildHttpUrl('/api/voice/refine')),
          headers: headers,
          body: jsonEncode({'raw': raw}),
        );
        // 迟到的润色不能盖掉更新的一版，也不能污染下一轮听写。
        if (seq != _refineSeq || generation != _generation) return;
        if (res.statusCode != 200) return;
        final data = jsonDecode(utf8.decode(res.bodyBytes));
        if (data is! Map || data['ok'] != true) return;
        final text = (data['text'] ?? '').toString().trim();
        if (text.isEmpty) return;
        _refined = text;
        notifyListeners();
      } catch (_) {
        // 润色是锦上添花，失败就用原文发。
      }
    }();
    _refineInFlight = pending;
    pending.whenComplete(() {
      if (identical(_refineInFlight, pending)) _refineInFlight = null;
    });
    return pending;
  }

  // ── 内部状态 ──────────────────────────────────────────────────────────────

  VoiceDictationResult _snapshot() {
    final raw = (_rawFinal.trim().isEmpty ? _rawPartial : _rawFinal).trim();
    final refined = _refined.trim();
    return VoiceDictationResult(
      raw: raw,
      refined: refined,
      text: refined.isNotEmpty ? refined : raw,
    );
  }

  void _resetTranscript() {
    _rawFinal = '';
    _rawPartial = '';
    _refined = '';
    _error = VoiceDictationError.none;
    _errorDetail = '';
    _refineSeq++;
    _refineTimer?.cancel();
    _refineTimer = null;
    _refineInFlight = null;
  }

  void _setState(VoiceDictationState next) {
    if (_state == next) return;
    _state = next;
    notifyListeners();
  }

  void _fail(VoiceDictationError reason, {String detail = ''}) {
    _error = reason;
    _errorDetail = detail;
    _teardown();
    _state = VoiceDictationState.failed;
    notifyListeners();
  }

  Future<void> _stopMic() async {
    final sub = _micSub;
    final mic = _mic;
    _micSub = null;
    _mic = null;
    await sub?.cancel();
    await mic?.close();
  }

  void _teardown() {
    _refineTimer?.cancel();
    _refineTimer = null;
    _auth.invalidate();
    final sub = _micSub;
    final mic = _mic;
    _micSub = null;
    _mic = null;
    sub?.cancel();
    mic?.close();
    final wsSub = _wsSub;
    final channel = _channel;
    _wsSub = null;
    _channel = null;
    wsSub?.cancel();
    _closeChannel(channel);
  }

  void _closeChannel(WebSocketChannel? channel) {
    if (channel == null) return;
    try {
      channel.sink.close();
    } catch (_) {}
  }
}
