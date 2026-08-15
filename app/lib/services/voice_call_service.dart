// VoiceCallService — 豆包式 Speech-to-Speech 通话模式编排器（Flutter 端口）。
//
// 状态机:  IDLE → LISTENING → CONFIRMING → EXECUTING → REPORTING → LISTENING
//
//   1. LISTENING  — 连续 PCM16 流采集 → 自适应 RMS VAD（静音=说完）→ 整句 WAV → /api/voice/stt
//   2. CONFIRMING — /api/voice/confirm 把口语需求拆成可逐项确认的条目 → TTS 念出 → 用户语音确认（可多轮）
//   3. EXECUTING  — allConfirmed 后经 chat WS 分发任务 → 进入等待，监听 chat 事件
//   4. REPORTING  — 周期性 /api/voice/progress-summary → TTS 播报；本轮结束播报最终结果 → 回到 LISTENING
//
// 全双工: 麦克风始终开（PCM 流），TTS 播放期间 VAD 检测到用户开口 → 立即 stop TTS（barge-in）。
//         依赖 AVAudioSession PlayAndRecord + VoiceChat 做回声消除，避免 AI 自激。
//
// 端口自 public/s2s-session.js；服务端契约见 server.js 的
//   /api/voice/stt · /api/voice/confirm · /api/voice/progress-summary 与 /ws/tts。

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:audio_session/audio_session.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'package:just_audio/just_audio.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../providers/chat_provider.dart';
import '../services/chat_service.dart';
import '../services/settings_service.dart';
import 'ws_ticket_service.dart';

enum VoiceCallState { idle, listening, confirming, executing, reporting }

/// 一轮对话气泡（用户识别文本 / AI 语音文本）。
class VoiceCallBubble {
  final bool fromUser;
  final String text;
  final DateTime ts;
  VoiceCallBubble({
    required this.fromUser,
    required this.text,
    required this.ts,
  });
}

class VoiceCallService extends ChangeNotifier {
  final ChatProvider chatProvider;
  final SettingsService settings;
  final WsTicketConnectionGate _ttsAuth;
  final WebSocketChannel Function(Uri) _connectChannel;

  VoiceCallService({
    required this.chatProvider,
    required this.settings,
    WsTicketClient? wsTicketClient,
    WebSocketChannel Function(Uri)? channelFactory,
  }) : _ttsAuth = WsTicketConnectionGate(wsTicketClient ?? WsTicketClient()),
       _connectChannel = channelFactory ?? WebSocketChannel.connect;

  // ── Observable state ──────────────────────────────────────────────────────

  VoiceCallState _state = VoiceCallState.idle;
  VoiceCallState get state => _state;

  final List<VoiceCallBubble> _bubbles = [];
  List<VoiceCallBubble> get bubbles => List.unmodifiable(_bubbles);

  /// 当前确认态的需求拆解（summary / items），供 UI 展示。
  String? _breakdownSummary;
  String? get breakdownSummary => _breakdownSummary;
  List<String>? _breakdownItems;
  List<String>? get breakdownItems => _breakdownItems;

  /// 0..1 麦克风电平（VAD 可视化）。
  double _level = 0;
  double get level => _level;
  bool _userSpeaking = false;
  bool get userSpeaking => _userSpeaking;

  /// 任务执行中的状态文案。
  String _statusText = '';
  String get statusText => _statusText;

  bool _active = false;
  bool get active => _active;

  // ── Audio capture (record) ────────────────────────────────────────────────

  final AudioRecorder _recorder = AudioRecorder();
  StreamSubscription<Uint8List>? _micSub;
  bool _capturing = false;

  // ── VAD ───────────────────────────────────────────────────────────────────
  // RMS-based, with an adaptive noise floor so normal speech triggers reliably
  // without a hot mic. Mirrors the web VadMonitor + the server's
  // "robust noise-floor calibration".
  static const double _speechThreshold = 0.020; // 持续高于此 → 开始说话
  static const double _silenceThreshold = 0.009; // 持续低于此 → 说完
  static const Duration _speechSustain = Duration(milliseconds: 220);
  static const Duration _silenceTimeout = Duration(milliseconds: 1200);
  // 预滚缓冲：正式判定 speech-start 前保留一点音频，避免吞首字。
  static const int _preRollBytes = 16000 * 2 ~/ 2; // ~0.5s @ 16kHz PCM16

  double _noiseFloor = 0.006;
  bool _speechPrimed = false; // 已越过 speech 阈值，在 sustain 窗口内
  DateTime? _primeStart;
  DateTime? _silenceSince;
  bool _inUtterance = false;
  final List<int> _utterancePcm = <int>[];
  final List<int> _preRoll = <int>[];

  // ── TTS playback (/ws/tts + just_audio) ───────────────────────────────────
  final AudioPlayer _player = AudioPlayer();
  WebSocketChannel? _ttsWs;
  bool _ttsPlaying = false;
  bool _ttsCancelled = false;

  // ── Confirm flow ──────────────────────────────────────────────────────────
  Map<String, dynamic>? _currentBreakdown;
  String _accumulatedText = '';

  // ── Task execution / reporting ────────────────────────────────────────────
  String _taskDescription = '';
  final List<Map<String, String>> _progressEvents = <Map<String, String>>[];
  StreamSubscription<ChatEvent>? _chatSub;
  Timer? _progressTimer;
  Timer? _idleHintTimer;
  bool _taskCompleted = false;
  DateTime? _lastSummaryTime;
  // 已完成任务的快照，供"汇报刚才那个任务的进展"在任务结束后仍可播报。
  String _lastTaskSummary = '';
  final List<Map<String, String>> _lastTaskEvents = <Map<String, String>>[];

  // ══════════════════════════════════════════════════════════════════════════
  //  Public API
  // ══════════════════════════════════════════════════════════════════════════

  Future<void> start() async {
    if (_active) return;
    _active = true;
    _bubbles.clear();
    _breakdownSummary = null;
    _breakdownItems = null;
    _setStatus('正在开启通话…');
    notifyListeners();

    // 1) 全双工音频会话：PlayAndRecord + VoiceChat → 系统级 AEC/AGC/NS。
    try {
      final session = await AudioSession.instance;
      await session.configure(
        AudioSessionConfiguration(
          avAudioSessionCategory: AVAudioSessionCategory.playAndRecord,
          avAudioSessionCategoryOptions:
              AVAudioSessionCategoryOptions.allowBluetooth |
              AVAudioSessionCategoryOptions.defaultToSpeaker,
          avAudioSessionMode: AVAudioSessionMode.voiceChat,
          androidAudioAttributes: const AndroidAudioAttributes(
            contentType: AndroidAudioContentType.speech,
            usage: AndroidAudioUsage.voiceCommunication,
          ),
          androidAudioFocusGainType: AndroidAudioFocusGainType.gainTransient,
        ),
      );
      await session.setActive(true);
    } catch (_) {
      _warn('audio session config failed: $e');
    }

    // 2) 监听 chat 事件（任务进展回流）。
    _chatSub ??= chatProvider.chatEvents.listen(_onChatEvent);

    // 3) 启动 PCM16 流采集 + VAD。
    if (!await _startCapture()) {
      _setStatus('无法访问麦克风，请检查权限');
      _active = false;
      notifyListeners();
      return;
    }

    _setState(VoiceCallState.listening);
    _setStatus('正在聆听…');
    _speak('通话已连接，请说。');
  }

  Future<void> stop() async {
    if (!_active) return;
    _active = false;
    _stopTts();
    await _stopCapture();
    _progressTimer?.cancel();
    _progressTimer = null;
    _idleHintTimer?.cancel();
    _idleHintTimer = null;
    _setState(VoiceCallState.idle);
    _setStatus('通话已结束');
    notifyListeners();
    try {
      await AudioSession.instance.then((s) => s.setActive(false));
    } catch (_) {}
  }

  /// 用户手动结束通话（UI 挂断按钮）。
  Future<void> hangUp() => stop();

  @override
  void dispose() {
    _progressTimer?.cancel();
    _idleHintTimer?.cancel();
    _chatSub?.cancel();
    _stopTts();
    _stopCaptureSync();
    _player.dispose();
    _recorder.dispose();
    super.dispose();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Capture + VAD
  // ══════════════════════════════════════════════════════════════════════════

  Future<bool> _startCapture() async {
    try {
      if (!await _recorder.hasPermission()) {
        return false;
      }
      final stream = await _recorder.startStream(
        const RecordConfig(
          encoder: AudioEncoder.pcm16bits,
          numChannels: 1,
          sampleRate: 16000,
          autoGain: true,
          echoCancel: true,
          noiseSuppress: true,
        ),
      );
      _capturing = true;
      _resetVad();
      _micSub = stream.listen(
        _onAudioChunk,
        onError: (e) => _warn('mic stream: $e'),
      );
      return true;
    } catch (e) {
      _warn('startCapture failed: $e');
      return false;
    }
  }

  Future<void> _stopCapture() async {
    _stopCaptureSync();
    try {
      await _recorder.stop();
    } catch (_) {}
  }

  void _stopCaptureSync() {
    _micSub?.cancel();
    _micSub = null;
    _capturing = false;
  }

  void _resetVad() {
    _speechPrimed = false;
    _primeStart = null;
    _silenceSince = null;
    _inUtterance = false;
    _utterancePcm.clear();
    _preRoll.clear();
    _noiseFloor = 0.006;
  }

  void _onAudioChunk(Uint8List chunk) {
    if (!_capturing || chunk.isEmpty) return;
    final rms = _rms(chunk);
    // 平滑电平（UI 可视化）。
    _level = _level * 0.6 + rms * 0.4;

    // 自适应噪声门：用静音段的 RMS 缓慢下压噪声地板。
    if (!_inUtterance && rms < _silenceThreshold) {
      _noiseFloor = _noiseFloor * 0.95 + rms * 0.05;
    }
    final effectiveSpeech =
        max(_speechThreshold, _noiseFloor * 2.2) * (_ttsPlaying ? 1.5 : 1.0);
    final effectiveSilence = max(_silenceThreshold, _noiseFloor * 1.4);

    final now = DateTime.now();

    // 预滚：始终保留最近 ~0.5s 音频，speech-start 时拼到 utterance 前面避免吞字。
    _preRoll.addAll(chunk);
    if (_preRoll.length > _preRollBytes) {
      _preRoll.removeRange(0, _preRoll.length - _preRollBytes);
    }

    if (rms > effectiveSpeech) {
      if (!_speechPrimed) {
        _speechPrimed = true;
        _primeStart = now;
      }
      _silenceSince = null;
      // 持续满足 sustain 窗口 → 判定真正开始说话。
      if (_primeStart != null &&
          now.difference(_primeStart!) >= _speechSustain &&
          !_inUtterance) {
        _onSpeechStart();
      }
    } else if (rms < effectiveSilence) {
      if (_speechPrimed && _inUtterance && _silenceSince == null) {
        _silenceSince = now;
      }
      _speechPrimed = false; // 抖动：回落到静音，重新累计 sustain
      _primeStart = null;
    }

    // 正在说话 → 累积该轮 PCM。
    if (_inUtterance) {
      _utterancePcm.addAll(chunk);
      // 静音超过 timeout → 判定说完。
      if (_silenceSince != null &&
          now.difference(_silenceSince!) >= _silenceTimeout) {
        _onSilence();
      }
    }

    // 节流刷新 UI（电平/说话态）。
    _maybeNotifyLevel();
  }

  double _rms(Uint8List chunk) {
    int sumSq = 0, n = 0;
    for (int i = 0; i + 1 < chunk.length; i += 2) {
      int s = chunk[i] | (chunk[i + 1] << 8);
      if (s >= 0x8000) s -= 0x10000; // sign-extend Int16 LE
      sumSq += s * s;
      n++;
    }
    if (n == 0) return 0;
    return sqrt(sumSq / n) / 32768.0;
  }

  DateTime? _lastLevelNotify;
  void _maybeNotifyLevel() {
    final now = DateTime.now();
    final speakingChanged = _userSpeaking != _inUtterance;
    if (speakingChanged) _userSpeaking = _inUtterance;
    if (speakingChanged ||
        _lastLevelNotify == null ||
        now.difference(_lastLevelNotify!) >= const Duration(milliseconds: 80)) {
      _lastLevelNotify = now;
      notifyListeners();
    }
  }

  void _onSpeechStart() {
    _inUtterance = true;
    _utterancePcm.clear();
    _utterancePcm.addAll(_preRoll); // 预滚拼前
    _preRoll.clear();

    // Barge-in：TTS 播放中用户开口 → 立即停 TTS。
    if (_ttsPlaying) {
      _warn('barge-in: stopping TTS');
      _ttsCancelled = true;
      _stopTts();
      if (_state == VoiceCallState.confirming ||
          _state == VoiceCallState.reporting) {
        _setState(VoiceCallState.listening);
      }
    }
  }

  void _onSilence() {
    if (!_inUtterance) return;
    _inUtterance = false;
    final pcm = Uint8List.fromList(_utterancePcm);
    _utterancePcm.clear();
    _silenceSince = null;
    _speechPrimed = false;
    // 太短 → 当噪声丢弃。
    if (pcm.length < 16000 * 2 * 0.25) {
      return;
    }
    // 只在聆听态才把这句话送识别；确认/执行态下的静音不触发新识别
    // （那些态由 barge-in 后重新进入 listening 时处理）。
    if (_state == VoiceCallState.listening) {
      _transcribe(pcm);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  STT  (/api/voice/stt)
  // ══════════════════════════════════════════════════════════════════════════

  Future<void> _transcribe(Uint8List pcm16) async {
    _setStatus('识别中…');
    notifyListeners();
    try {
      final wav = _buildWav(pcm16, 16000);
      final uri = Uri.parse(settings.buildHttpUrl('/api/voice/stt'));
      final req = http.MultipartRequest('POST', uri);
      if (settings.token.isNotEmpty) {
        req.headers['X-Access-Token'] = settings.token;
      }
      req.files.add(
        http.MultipartFile.fromBytes(
          'file',
          wav,
          filename: 'utterance.wav',
          contentType: MediaType('audio', 'wav'),
        ),
      );
      final res = await req.send().timeout(const Duration(seconds: 30));
      final body = await res.stream.bytesToString();
      if (res.statusCode != 200) {
        _warn('stt HTTP ${res.statusCode}: $body');
        _setStatus('识别失败，请再说一次');
        notifyListeners();
        return;
      }
      final json = jsonDecode(body) as Map<String, dynamic>;
      final text = (json['text'] as String? ?? '').trim();
      if (text.isEmpty) {
        _setStatus('没听清，请再说一次');
        notifyListeners();
        return;
      }
      _bubbles.add(
        VoiceCallBubble(fromUser: true, text: text, ts: DateTime.now()),
      );
      _setStatus('正在聆听…');
      notifyListeners();
      await _processRecognizedText(text);
    } catch (e) {
      _warn('transcribe failed: $e');
      _setStatus('识别异常：$e');
      notifyListeners();
    }
  }

  Future<void> _processRecognizedText(String text) async {
    // 意图识别（关键词级，足够 demo；复杂拆解交给 /api/voice/confirm 的 LLM）。
    if (_matchIntent(text, const ['跳过', '不用汇报', '先不汇报', '别播报'])) {
      _stopTts();
      _progressEvents.clear();
      _setStatus('已跳过汇报，请说下一步。');
      _setState(VoiceCallState.listening);
      notifyListeners();
      return;
    }
    if (_matchIntent(text, const ['打断', '停一下', '取消', '闭嘴', '停下来'])) {
      _stopTts();
      _setStatus('已打断，请说。');
      _setState(VoiceCallState.listening);
      notifyListeners();
      return;
    }
    // 状态查询：汇报任意任务进展（执行中 → 实时；已结束 → 上次结果快照）。
    if (_matchIntent(text, const [
      '汇报',
      '进展',
      '进度',
      '怎么样',
      '状态',
      '到哪',
      '完成没',
      '做完没',
      '结果',
    ])) {
      if (_state == VoiceCallState.executing ||
          _state == VoiceCallState.reporting) {
        await _reportProgress(force: true);
      } else if (_lastTaskSummary.isNotEmpty) {
        await _speak(_lastTaskSummary);
      } else {
        await _speak('目前没有任务进展可汇报。');
      }
      return;
    }

    // 正常流程：首次 → 进入确认；有未确认 breakdown → 作为确认反馈。
    final p =
        (_currentBreakdown != null &&
            _currentBreakdown!['allConfirmed'] != true)
        ? _handleConfirmationResponse(text)
        : _enterConfirming(text);
    try {
      await p;
    } catch (e) {
      _warn('processRecognizedText: $e');
      _setStatus('处理失败：$e');
      _setState(VoiceCallState.listening);
      notifyListeners();
    }
  }

  bool _matchIntent(String text, List<String> keys) {
    final t = text.replaceAll(RegExp(r'\s'), '');
    return keys.any((k) => t.contains(k));
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CONFIRMING  (/api/voice/confirm)
  // ══════════════════════════════════════════════════════════════════════════

  Future<void> _enterConfirming(String rawText) async {
    _setState(VoiceCallState.confirming);
    _accumulatedText = rawText;
    _setStatus('确认需求中…');
    notifyListeners();
    await _speak('好的，我来确认一下。');
    final breakdown = await _callConfirm(rawText, null, null);
    _applyBreakdown(breakdown);
    if (breakdown['allConfirmed'] == true) {
      await _speak(_confirmTts(breakdown));
      _enterExecuting(_buildTaskText(breakdown));
      return;
    }
    await _speak(_confirmTts(breakdown));
    _setState(VoiceCallState.listening);
    _setStatus('请确认或补充。');
    notifyListeners();
  }

  Future<void> _handleConfirmationResponse(String userText) async {
    _setState(VoiceCallState.confirming);
    _setStatus('更新需求中…');
    notifyListeners();
    // The user's spoken refinement may differ from the raw STT transcript — feed
    // the delta back so Whisper's vocabulary learns from the correction.
    _sendFeedback(_accumulatedText, userText);
    final breakdown = await _callConfirm(
      _accumulatedText,
      _currentBreakdown,
      userText,
    );
    _applyBreakdown(breakdown);
    if (breakdown['allConfirmed'] == true) {
      await _speak('好的，开始执行。');
      _enterExecuting(_buildTaskText(breakdown));
      return;
    }
    await _speak(_confirmTts(breakdown));
    _setState(VoiceCallState.listening);
    _setStatus('请确认或补充。');
    notifyListeners();
  }

  void _applyBreakdown(Map<String, dynamic> b) {
    _currentBreakdown = b;
    _breakdownSummary = (b['summary'] as String?) ?? '';
    final items = b['items'];
    _breakdownItems = (items is List)
        ? items.map((e) => e.toString()).toList()
        : const [];
    notifyListeners();
  }

  String _confirmTts(Map<String, dynamic> b) {
    final buf = StringBuffer();
    final summary = (b['summary'] as String?) ?? '我理解你的需求如下。';
    buf.write(summary);
    final items = b['items'];
    if (items is List && items.isNotEmpty) {
      for (var i = 0; i < items.length; i++) {
        buf.write(' 第${i + 1}，${items[i]}。');
      }
    }
    final qs = b['questions'];
    if (qs is List && qs.isNotEmpty) {
      buf.write(' 有个问题：${qs.join('；')}。');
    }
    buf.write(' 对吗？或者告诉我哪里要改。');
    return buf.toString();
  }

  String _buildTaskText(Map<String, dynamic> b) {
    final parts = <String>[];
    final s = (b['summary'] as String?) ?? '';
    if (s.isNotEmpty) parts.add(s);
    final items = b['items'];
    if (items is List && items.isNotEmpty) {
      parts.add(
        '具体要求：\n${items.asMap().entries.map((e) => '${e.key + 1}. ${e.value}').join('\n')}',
      );
    }
    return parts.join('\n\n');
  }

  Future<Map<String, dynamic>> _callConfirm(
    String text,
    Map<String, dynamic>? prev,
    String? feedback,
  ) async {
    final body = <String, dynamic>{'text': text};
    if (prev != null) body['previousBreakdown'] = prev;
    if (feedback != null) body['userFeedback'] = feedback;
    final res = await http
        .post(
          Uri.parse(settings.buildHttpUrl('/api/voice/confirm')),
          headers: _jsonHeaders(),
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 45));
    final json = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200 || json['error'] != null) {
      throw Exception(json['error'] ?? 'HTTP ${res.statusCode}');
    }
    return json;
  }

  // ── STT correction feedback ─────────────────────────────────────────────────
  // When the user's confirmation/refinement wording differs materially from the
  // raw STT transcript, fire-and-forget POST /api/voice/feedback so the server
  // can extract corrections (raw → userFinal) and merge them into the Whisper
  // vocabulary. Mirrors web's voice-output.js feedback path. Never blocks or
  // fails the voice turn — best-effort learning only.
  void _sendFeedback(String raw, String userFinal) {
    if (raw.trim().isEmpty || userFinal.trim().isEmpty) return;
    if (raw.trim() == userFinal.trim()) return;
    final body = jsonEncode({
      'raw': raw,
      'refined': raw, // server compares raw vs userFinal
      'userFinal': userFinal,
    });
    // Fire-and-forget; never blocks or fails the voice turn.
    _postFeedback(body);
  }

  Future<void> _postFeedback(String body) async {
    try {
      await http
          .post(
            Uri.parse(settings.buildHttpUrl('/api/voice/feedback')),
            headers: _jsonHeaders(),
            body: body,
          )
          .timeout(const Duration(seconds: 10));
    } catch (_) {
      // swallow — feedback failure is invisible to the user
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  EXECUTING + REPORTING  (chat WS dispatch + /api/voice/progress-summary)
  // ══════════════════════════════════════════════════════════════════════════

  void _enterExecuting(String taskText) {
    _setState(VoiceCallState.executing);
    _taskDescription = taskText;
    _progressEvents.clear();
    // 新任务开始 → 清掉上一任务的快照。
    _lastTaskSummary = '';
    _lastTaskEvents.clear();
    _taskCompleted = false;
    _lastSummaryTime = DateTime.now();
    _breakdownSummary = null;
    _breakdownItems = null;
    _currentBreakdown = null;
    _setStatus('已分发任务，等待结果…');
    notifyListeners();

    // 经 chat WS 分发（与正常文本发送同一通道）。
    chatProvider.sendMessage(taskText);

    // 周期汇报：每 20s 若有新事件则播报一次。
    _progressTimer?.cancel();
    _progressTimer = Timer.periodic(const Duration(seconds: 20), (_) {
      if (_state == VoiceCallState.executing ||
          _state == VoiceCallState.reporting) {
        _reportProgress();
      }
    });
    // 久无动静提示。
    _idleHintTimer?.cancel();
    _idleHintTimer = Timer(const Duration(seconds: 45), () {
      if (_state == VoiceCallState.executing) {
        _speak('任务还在进行中，请稍候。');
      }
    });
  }

  void _onChatEvent(ChatEvent evt) {
    if (_state != VoiceCallState.executing &&
        _state != VoiceCallState.reporting) {
      return;
    }
    final now = DateTime.now();
    switch (evt.type) {
      case 'content_block_delta':
        final delta = (evt.payload as Map?)?['delta'] as Map?;
        if (delta?['type'] == 'text_delta') {
          final t = (delta?['text'] as String?) ?? '';
          if (t.trim().isNotEmpty) {
            _pushEvent('assistant_text', t);
          }
        }
        break;
      case 'content_block_start':
        final block = (evt.payload as Map?)?['content_block'] as Map?;
        if (block?['type'] == 'tool_use') {
          _pushEvent('tool_use', '使用工具：${block?['name']}');
        }
        break;
      case 'result':
        _pushEvent('result', '任务回合完成');
        // 不提前猜测结果：server notify 是 succeeded/waiting 的唯一裁决。
        break;
      case 'notify':
        final st = ((evt.payload as Map?)?['state'] ?? 'succeeded').toString();
        if (st == 'succeeded' || st == 'completed' || st == 'waiting') {
          _onTurnSettled(st == 'waiting');
        }
        break;
      default:
        break;
    }
    // 事件到达即刷新 lastSummaryTime 计时不必要；此处保留变量以供 _reportProgress 节流。
    if (now == now) {}
  }

  void _pushEvent(String type, String summary) {
    _progressEvents.add({'type': type, 'summary': summary});
  }

  Future<void> _onTurnSettled(bool waiting) async {
    if (_taskCompleted) return;
    _taskCompleted = true;
    _progressTimer?.cancel();
    _progressTimer = null;
    _idleHintTimer?.cancel();
    _idleHintTimer = null;
    _setState(VoiceCallState.reporting);
    _setStatus(waiting ? '等待操作，整理汇报…' : '执行成功，整理汇报…');
    notifyListeners();

    final fallback = waiting ? '正在等待你的下一步指示。' : '本轮执行成功。';
    String summary = fallback;
    final eventsSnapshot = _progressEvents.toList();
    if (eventsSnapshot.isNotEmpty) {
      try {
        summary = await _fetchProgressSummary(eventsSnapshot, _taskDescription);
      } catch (e) {
        _warn('final summary failed: $e');
      }
    }
    // 保留快照，供任务结束后的"汇报进展"查询。
    _lastTaskSummary = summary;
    _lastTaskEvents
      ..clear()
      ..addAll(eventsSnapshot);
    await _speak(summary);
    _progressEvents.clear();
    _taskDescription = '';
    _setState(VoiceCallState.listening);
    _setStatus('正在聆听…');
    notifyListeners();
  }

  Future<void> _reportProgress({bool force = false}) async {
    if (_progressEvents.isEmpty && !force) return;
    final now = DateTime.now();
    if (!force &&
        _lastSummaryTime != null &&
        now.difference(_lastSummaryTime!) < const Duration(seconds: 15)) {
      return;
    }
    _lastSummaryTime = now;
    final events = _progressEvents.toList();
    if (!force) _progressEvents.clear();

    _setState(VoiceCallState.reporting);
    _setStatus('汇报进展…');
    notifyListeners();
    try {
      final summary = await _fetchProgressSummary(events, _taskDescription);
      if (summary.isNotEmpty) await _speak(summary);
    } catch (e) {
      _warn('progress summary failed: $e');
    }
    if (_state == VoiceCallState.reporting) {
      _setState(VoiceCallState.executing);
      _setStatus('继续执行…');
      notifyListeners();
    }
  }

  Future<String> _fetchProgressSummary(
    List<Map<String, String>> events,
    String taskDesc,
  ) async {
    final res = await http
        .post(
          Uri.parse(settings.buildHttpUrl('/api/voice/progress-summary')),
          headers: _jsonHeaders(),
          body: jsonEncode({'events': events, 'taskDescription': taskDesc}),
        )
        .timeout(const Duration(seconds: 30));
    final json = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200 || json['error'] != null) {
      throw Exception(json['error'] ?? 'HTTP ${res.statusCode}');
    }
    return (json['summary'] as String?) ?? '';
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  TTS playback (/ws/tts → MP3 bytes (Edge) → temp file → just_audio)
  //
  //  NOTE: edge-tts 的 stdout 是 MP3（不是 PCM16）。服务端 tts-service 把它原样
  //  作为二进制帧转发，并带一个 sampleRate（对 Edge 只是占位）。因此客户端按 MP3
  //  整体落盘交给 just_audio 播放，无需 WAV/采样率假设。Volcano provider 才是真
  //  PCM16 流——如切换到 Volcano 需在此按 provider 区分封装。
  // ══════════════════════════════════════════════════════════════════════════

  Future<void> _speak(String text) async {
    if (text.trim().isEmpty) return;
    _stopTts();
    _bubbles.add(
      VoiceCallBubble(fromUser: false, text: text, ts: DateTime.now()),
    );
    notifyListeners();

    final ttsProvider = 'edge'; // Edge TTS → MP3
    final builder = BytesBuilder();
    bool gotAny = false;
    final completer = Completer<void>();

    final attempt = _ttsAuth.begin(
      socketUri: _buildWsUri(MulticcWsPath.tts),
      ticketEndpoint: Uri.parse(settings.buildHttpUrl('/api/auth/ws-ticket')),
      accessToken: settings.token,
    );
    late WebSocketChannel channel;
    try {
      final wsUri = await attempt.authorizedUri;
      if (!attempt.isCurrent || !_active) return;
      channel = _connectChannel(wsUri);
      if (!attempt.isCurrent || !_active) {
        await channel.sink.close();
        return;
      }
      _ttsWs = channel;
    } catch (_) {
      if (attempt.isCurrent) _warn('tts ws connect failed');
      return;
    }
    _ttsCancelled = false;
    _ttsPlaying = false;

    late StreamSubscription sub;
    sub = channel.stream.listen(
      (data) {
        if (_ttsCancelled || !attempt.isCurrent || _ttsWs != channel) return;
        if (data is List<int>) {
          builder.add(Uint8List.fromList(data));
          gotAny = true;
        } else if (data is String) {
          Map<String, dynamic> msg;
          try {
            msg = jsonDecode(data) as Map<String, dynamic>;
          } catch (_) {
            return;
          }
          if (msg['type'] == 'done') {
            _finishTts(builder, completer);
          } else if (msg['type'] == 'error') {
            _warn('tts error: ${msg['message']}');
            if (!completer.isCompleted) completer.complete();
          }
        }
      },
      onError: (_) {
        if (attempt.isCurrent && _ttsWs == channel) {
          _warn('tts ws transport error');
        }
        if (!completer.isCompleted) completer.complete();
      },
      onDone: () {
        if (!completer.isCompleted && attempt.isCurrent && _ttsWs == channel) {
          _finishTts(builder, completer);
        } else if (!completer.isCompleted) {
          completer.complete();
        }
      },
    );

    channel.sink.add(
      jsonEncode({'type': 'start', 'text': text, 'provider': ttsProvider}),
    );
    try {
      await completer.future;
    } finally {
      await sub.cancel();
      try {
        await channel.sink.close();
      } catch (_) {}
      if (_ttsWs == channel) _ttsWs = null;
    }
    // ignore: unused_local_variable
    gotAny = gotAny;
  }

  void _finishTts(BytesBuilder builder, Completer<void> completer) {
    if (completer.isCompleted) return;
    if (_ttsCancelled) {
      completer.complete();
      return;
    }
    final bytes = builder.takeBytes();
    if (bytes.isEmpty) {
      completer.complete();
      return;
    }
    completer.complete(_playAudio(bytes));
  }

  /// 播放 /ws/tts 收到的音频字节。Edge provider 输出 MP3 → 直接落盘 .mp3 由
  /// just_audio 解码播放（just_audio 原生支持 MP3，自带正确的采样率/声道）。
  Future<void> _playAudio(Uint8List bytes) async {
    if (_ttsCancelled || bytes.isEmpty) return;
    String? tmpPath;
    try {
      final dir = await getTemporaryDirectory();
      tmpPath =
          '${dir.path}/multicc_tts_${DateTime.now().microsecondsSinceEpoch}.mp3';
      await File(tmpPath).writeAsBytes(bytes);

      _ttsPlaying = true;
      notifyListeners();
      await _player.setFilePath(tmpPath);
      final done = Completer<void>();
      late StreamSubscription stateSub;
      stateSub = _player.processingStateStream.listen((ps) {
        if (ps == ProcessingState.completed || _ttsCancelled) {
          stateSub.cancel();
          if (!done.isCompleted) done.complete();
        }
      });
      await _player.play();
      await done.future.timeout(const Duration(seconds: 30), onTimeout: () {});
      try {
        await _player.stop();
      } catch (_) {}
    } catch (e) {
      _warn('playAudio failed: $e');
    } finally {
      _ttsPlaying = false;
      notifyListeners();
      if (tmpPath != null) {
        try {
          await File(tmpPath).delete();
        } catch (_) {}
      }
    }
  }

  void _stopTts() {
    _ttsAuth.invalidate();
    _ttsCancelled = true;
    _ttsPlaying = false;
    try {
      if (_ttsWs != null) _ttsWs!.sink.add(jsonEncode({'type': 'stop'}));
    } catch (_) {}
    try {
      _player.stop();
    } catch (_) {}
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Helpers
  // ══════════════════════════════════════════════════════════════════════════

  void _setState(VoiceCallState s) {
    if (_state == s) return;
    _state = s;
    notifyListeners();
  }

  void _setStatus(String s) {
    _statusText = s;
  }

  void _warn(Object? msg) => debugPrint('[voice_call] $msg');

  Map<String, String> _jsonHeaders() {
    final h = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) h['X-Access-Token'] = settings.token;
    return h;
  }

  Uri _buildWsUri(String path) =>
      buildMulticcWebSocketUri(host: settings.host, path: path);

  /// PCM16 mono → WAV（44 字节头）。
  Uint8List _buildWav(Uint8List pcm16, int sampleRate) {
    final dataLen = pcm16.length;
    final byteRate = sampleRate * 2;
    final out = BytesBuilder();
    out.add(utf8.encode('RIFF'));
    out.add(_u32(36 + dataLen));
    out.add(utf8.encode('WAVE'));
    out.add(utf8.encode('fmt '));
    out.add(_u32(16)); // PCM fmt chunk size
    out.add(_u16(1)); // audioFormat = PCM
    out.add(_u16(1)); // mono
    out.add(_u32(sampleRate));
    out.add(_u32(byteRate));
    out.add(_u16(2)); // blockAlign
    out.add(_u16(16)); // bitsPerSample
    out.add(utf8.encode('data'));
    out.add(_u32(dataLen));
    out.add(pcm16);
    return out.takeBytes();
  }

  List<int> _u32(int v) => [
    v & 0xff,
    (v >> 8) & 0xff,
    (v >> 16) & 0xff,
    (v >> 24) & 0xff,
  ];
  List<int> _u16(int v) => [v & 0xff, (v >> 8) & 0xff];
}
