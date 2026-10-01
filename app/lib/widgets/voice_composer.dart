import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../i18n.dart';
import '../services/settings_service.dart';
import '../services/voice_clip_recorder.dart';
import '../services/voice_dictation_service.dart';

/// 语音输入：会话页输入条与目录「快速新建」共用的同一份交互。
///
/// 原先是两套：会话页（`InputBar`）用流式听写 `/ws/voice` 加实时浮层，起不来才
/// 回退到「整段录音 → `/api/voice/stt` → 原文/润色面板」；目录快速新建用的是另
/// 一颗 `VoiceInputButton`，只有那条回退路径。同一个产品里同一种输入不该有两种
/// 脾气 —— 这里把会话页那一套整块搬出来，谁用谁摆一颗 [VoiceMicButton] 加一块
/// [VoiceDictationHud]，会话页行为逐字节照旧（目录页因此跟着一样）。
///
/// 宿主负责布局与生命周期：
///   * 构造时把「要往里插字的输入框控制器」与目标设置交进来；
///   * 每次 build 调一次 [syncSettings] 跟上当前会话的设置；
///   * 在动作行摆 [VoiceMicButton]、在输入框上方摆 [VoiceDictationHud]（后者只有
///     [showHud] 为真时才挂）。
class VoiceComposerController extends ChangeNotifier {
  VoiceComposerController({
    required SettingsService settings,
    required TextEditingController target,
    VoiceDictationBuilder? buildDictation,
    VoiceClipBuilder? buildClip,
  }) : _settings = settings,
       _target = target,
       _buildDictation =
           buildDictation ?? debugDictationBuilder ?? _defaultDictation,
       _clip = (buildClip ?? debugClipBuilder ?? _defaultClip)() {
    // 输入框被清空（用户全删）就不再算作听写来源。
    _target.addListener(_onTargetChanged);
  }

  static VoiceDictationService _defaultDictation(SettingsService settings) =>
      VoiceDictationService(settings: settings);

  static VoiceClipRecording _defaultClip() => VoiceClipRecorder();

  /// 测试钩子：widget 测试里没有平台通道也没有真 socket，靠这两个把默认的
  /// 真录音 / 真听写换掉（会话页与目录页都用默认构造，所以一处设置两处生效）。
  @visibleForTesting
  static VoiceDictationBuilder? debugDictationBuilder;

  @visibleForTesting
  static VoiceClipBuilder? debugClipBuilder;

  SettingsService _settings;
  final TextEditingController _target;
  final VoiceDictationBuilder _buildDictation;
  final VoiceClipRecording _clip;

  // 流式听写（/ws/voice）：边说边出字 + 实时润色，对齐 web 的语音 HUD。服务端
  // ASR 或麦克风不可用时回退到下面的 m4a → /api/voice/stt 整段上传。
  VoiceDictationService? _dictation;
  bool _legacyFallbackArmed = false;

  /// 最近一次流式听写提交的产物。提交只把原文填进输入框，这里记住它的来源：
  /// 发送时据此给帧打 voice 标记、并在用户改过字时回传反馈。输入框被清空、
  /// 换成别的内容、或发送出去之后丢掉。
  VoiceDictationResult? _pendingVoice;
  VoiceDictationService? _pendingVoiceService;

  /// 本条消息里所有听写段的原文（多段追加时按行拼接）。
  String? _pendingVoiceRaw;

  /// 输入框是不是「只有这一段听写」：追加到已有内容后面时，用户最终文本里混着
  /// 别的来源，拿它和这一段原文对比会把别处的英文词误学成纠错词，所以不回传反馈。
  bool _pendingVoiceSolo = false;

  /// 宿主最近一次 build 的 context —— 回退路径靠它弹 SnackBar / 底部面板。
  BuildContext? _host;

  /// 宿主还在树上 —— 异步回调里要 notifyListeners 之前先问一句它。
  bool get _live => _host != null && _host!.mounted;

  /// 宿主每次 build 都调：跟上当前会话的设置（切会话后设置会换）。
  void syncSettings(SettingsService settings) => _settings = settings;

  bool get isRecording => _clip.isRecording;
  bool get isTranscribing => _clip.isTranscribing;

  VoiceDictationService? get dictation => _dictation;
  bool get dictationBusy => _dictation?.isBusy ?? false;
  bool get dictationFinalizing =>
      _dictation?.state == VoiceDictationState.finalizing;

  /// 实时浮层该不该出现（会话页原来那条：非 idle、非 done）。
  bool get showHud {
    final d = _dictation;
    return d != null &&
        d.state != VoiceDictationState.idle &&
        d.state != VoiceDictationState.done;
  }

  @override
  void dispose() {
    _target.removeListener(_onTargetChanged);
    _dictation?.removeListener(_onDictationChanged);
    _dictation?.dispose();
    _clip.dispose();
    super.dispose();
  }

  // ── 麦克风按钮：正在听写就提交，否则开始一轮流式听写 ──

  Future<void> toggleMic(BuildContext context) async {
    _host = context;
    final d = _dictation;
    if (d != null && d.isBusy) {
      await commit(context);
      return;
    }
    await _startDictation(context);
  }

  Future<void> _startDictation(BuildContext context) async {
    if (_dictation == null) {
      _dictation = _buildDictation(_settings);
      _dictation!.addListener(_onDictationChanged);
    }
    _legacyFallbackArmed = false;
    final ok = await _dictation!.start();
    if (!context.mounted) return;
    if (!ok) {
      // /ws/voice 或麦克风不可用：回退旧的整段上传流程。
      _dictation?.removeListener(_onDictationChanged);
      _dictation = null;
      notifyListeners();
      await _toggleRecording(context);
    } else {
      notifyListeners();
    }
  }

  void _onDictationChanged() {
    final host = _host;
    if (host == null || !host.mounted) return;
    final d = _dictation;
    // 启动失败且一个字都没识别到：回退旧的整段上传，别让用户对着空 HUD 干等。
    if (d != null &&
        d.state == VoiceDictationState.failed &&
        !d.hasText &&
        !_legacyFallbackArmed) {
      _legacyFallbackArmed = true;
      _dictation?.removeListener(_onDictationChanged);
      _dictation = null;
      notifyListeners();
      _fallbackLegacyRecording(host);
      return;
    }
    notifyListeners();
  }

  /// 提交听写结果：把原始转写填进输入框（保留可编辑，误触代价大，不直接发送）。
  ///
  /// 不再等服务端润色（那条要 2–13s 还会改写用户原话），原文直接进框；发送时
  /// 再带上 voice 标记让主模型结合上下文纠错。反馈也挪到发送时用「用户最后真正
  /// 发出的文本」回传（见 [reportVoiceFeedback]）。
  Future<void> commit(BuildContext context) async {
    _host = context;
    final d = _dictation;
    if (d == null) return;
    final result = await d.commit();
    if (!context.mounted) return;
    if (result.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(t('voiceEmpty')),
          backgroundColor: const Color(0xFF8b9cae),
        ),
      );
      return;
    }
    final current = _target.text.trim();
    final previousRaw = current.isEmpty ? null : _pendingVoiceRaw;
    _target.text = current.isEmpty ? result.text : '$current\n${result.text}';
    _target.selection = TextSelection.collapsed(offset: _target.text.length);
    // 记住这一段的来源：发送时打 voice 标记、并回传反馈。
    _pendingVoice = result;
    _pendingVoiceService = d;
    _pendingVoiceRaw = previousRaw == null
        ? result.raw
        : '$previousRaw\n${result.raw}';
    _pendingVoiceSolo = current.isEmpty;
  }

  void cancel() => _dictation?.cancel();

  /// 当前输入是不是听写来的；是的话返回未经润色的原始转写，否则 null。
  String? get pendingVoiceRaw =>
      _pendingVoice == null ? null : _pendingVoiceRaw;

  /// 发送之后调用：丢掉听写来源标记，别把它带到下一条消息上。
  void clearPendingVoice() {
    _pendingVoice = null;
    _pendingVoiceService = null;
    _pendingVoiceRaw = null;
    _pendingVoiceSolo = false;
  }

  /// 发送一条听写来的消息之后调用：把「原文 / 润色稿 / 用户最后真正发出的文本」
  /// 回传服务端做质量评估与词表学习。纯旁路，失败不影响已发出的消息。用户原样
  /// 发出（没改字）时没有可学的，[VoiceDictationService.reportFeedback] 会跳过。
  void reportVoiceFeedback(String sentText) {
    final result = _pendingVoice;
    final service = _pendingVoiceService;
    if (result == null || service == null || !_pendingVoiceSolo) return;
    service.reportFeedback(result, userFinal: sentText);
  }

  /// 输入框清空（用户全删）就不再算作听写来源。
  void _onTargetChanged() {
    if (_target.text.trim().isEmpty) clearPendingVoice();
  }

  // ── 整段录音（流式听写起不来时的退路）──

  Future<void> _fallbackLegacyRecording(BuildContext context) async {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(t('voiceStreamUnavailable')),
        backgroundColor: const Color(0xFF8b9cae),
      ),
    );
    await _toggleRecording(context);
  }

  Future<void> _toggleRecording(BuildContext context) async {
    if (_clip.isRecording) {
      await _stopAndTranscribe(context);
    } else {
      await _startRecording();
    }
  }

  Future<void> _startRecording() async {
    if (!await _clip.start()) return;
    if (_live) notifyListeners();
  }

  Future<void> _stopAndTranscribe(BuildContext context) async {
    notifyListeners();
    try {
      final text = await _clip.stopAndTranscribe(_settings);
      if (text.isNotEmpty && context.mounted) {
        _showVoicePanel(context, text);
      }
    } on VoiceClipException catch (e) {
      // 非 200 与路上出错本来就是两种说法（`STT failed: 500` / `STT error: …`），
      // 由异常自己拼好。
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('$e'),
            backgroundColor: const Color(0xFFb64e43),
          ),
        );
      }
    } finally {
      if (_live) notifyListeners();
    }
  }

  // ── 原文 → 可选 AI 润色面板 ──

  void _showVoicePanel(BuildContext context, String rawText) {
    final rawCtrl = TextEditingController(text: rawText);
    bool isRefining = false;
    String? refinedText;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: const Color(0xFFffffff),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setSheetState) {
            return Padding(
              padding: EdgeInsets.fromLTRB(
                16,
                16,
                16,
                MediaQuery.of(ctx).viewInsets.bottom + 16,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    '🎤 ${t('voiceRecognition')}',
                    style: const TextStyle(
                      color: Color(0xFF20364d),
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    t('voiceRawTranscript'),
                    style: const TextStyle(
                      color: Color(0xFF6f8096),
                      fontSize: 12,
                    ),
                  ),
                  const SizedBox(height: 4),
                  TextField(
                    controller: rawCtrl,
                    maxLines: 4,
                    style: const TextStyle(
                      color: Color(0xFF233249),
                      fontSize: 14,
                    ),
                    decoration: InputDecoration(
                      filled: true,
                      fillColor: const Color(0xFFf4f8fd),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8),
                        borderSide: const BorderSide(color: Color(0xFFdce6f1)),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8),
                        borderSide: const BorderSide(color: Color(0xFFdce6f1)),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8),
                        borderSide: const BorderSide(color: Color(0xFF1267b5)),
                      ),
                    ),
                  ),
                  if (refinedText != null) ...[
                    const SizedBox(height: 12),
                    Text(
                      t('aiRefine'),
                      style: const TextStyle(
                        color: Color(0xFF6f8096),
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: const Color(0xFFf4f8fd),
                        border: Border.all(color: const Color(0xFF0965cf)),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        refinedText!,
                        style: const TextStyle(
                          color: Color(0xFF233249),
                          fontSize: 14,
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          onPressed: () => Navigator.pop(ctx),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: const Color(0xFF6f8096),
                            side: const BorderSide(color: Color(0xFFdce6f1)),
                          ),
                          child: Text(t('cancel')),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: OutlinedButton(
                          onPressed: isRefining
                              ? null
                              : () async {
                                  setSheetState(() => isRefining = true);
                                  final result = await _fetchRefined(
                                    rawCtrl.text,
                                  );
                                  if (result != null) {
                                    setSheetState(() {
                                      refinedText = result;
                                      isRefining = false;
                                    });
                                  } else {
                                    setSheetState(() => isRefining = false);
                                  }
                                },
                          style: OutlinedButton.styleFrom(
                            foregroundColor: const Color(0xFF6f8096),
                            side: const BorderSide(color: Color(0xFFdce6f1)),
                          ),
                          child: isRefining
                              ? const SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Color(0xFF6f8096),
                                  ),
                                )
                              : Text(t('aiRefine')),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: ElevatedButton(
                          onPressed: () {
                            final text =
                                (refinedText != null &&
                                    refinedText!.trim().isNotEmpty)
                                ? refinedText!
                                : rawCtrl.text;
                            Navigator.pop(ctx);
                            final current = _target.text;
                            _target.text = current.isEmpty
                                ? text
                                : '$current $text';
                            _target.selection = TextSelection.collapsed(
                              offset: _target.text.length,
                            );
                            // 这是整段录音那条退路，不是流式听写：别把它的文本
                            // 当成听写来源（原文对不上，也不该带 voice 标记）。
                            clearPendingVoice();
                          },
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFF0965cf),
                            foregroundColor: Colors.white,
                          ),
                          child: Text(
                            refinedText != null
                                ? t('useAiText')
                                : t('useOriginalText'),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  Future<String?> _fetchRefined(String raw) async {
    try {
      final uri = Uri.parse(_settings.buildHttpUrl('/api/voice/refine'));
      final headers = <String, String>{'Content-Type': 'application/json'};
      if (_settings.token.isNotEmpty) {
        headers['X-Access-Token'] = _settings.token;
      }
      final res = await http
          .post(uri, headers: headers, body: jsonEncode({'raw': raw}))
          .timeout(const Duration(seconds: 30));
      if (res.statusCode != 200) return null;
      final data = jsonDecode(utf8.decode(res.bodyBytes));
      if (data is! Map<String, dynamic> || data['ok'] != true) return null;
      final result = (data['text'] ?? '').toString().trim();
      return result.isNotEmpty ? result : null;
    } catch (_) {
      return null;
    }
  }
}

/// 建一条流式听写服务。测试注入假实现（假 socket / 假麦）用。
typedef VoiceDictationBuilder =
    VoiceDictationService Function(SettingsService settings);

/// 建一条整段录音器。测试注入假实现用。
typedef VoiceClipBuilder = VoiceClipRecording Function();

/// 麦克风按钮 —— 会话页那颗 mic 的同款：尺寸 34×40、图标 20、颜色随状态换。
/// 正在听写时点它 = 提交，否则点它 = 开始/停止。会话页与目录页用的是同一个它。
class VoiceMicButton extends StatelessWidget {
  const VoiceMicButton({
    super.key,
    required this.controller,
    this.enabled = true,
    this.color = const Color(0xFF6f8096),
    this.iconSize = 20,
  });

  final VoiceComposerController controller;

  /// 宿主的门禁（会话页是「连着服务器」、目录页是「没在创建」）。
  final bool enabled;

  /// 空闲时的图标颜色。
  final Color color;

  final double iconSize;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final busy = controller.dictationBusy;
        final VoidCallback? onTap = busy
            ? () => controller.commit(context)
            : (!controller.isTranscribing && enabled)
            ? () => controller.toggleMic(context)
            : null;
        return GestureDetector(
          onTap: onTap,
          child: Container(
            width: 34,
            height: 40,
            alignment: Alignment.center,
            child: Icon(
              controller.dictationFinalizing
                  ? Icons.hourglass_top_rounded
                  : busy
                  ? Icons.check_circle_rounded
                  : controller.isTranscribing
                  ? Icons.hourglass_top_rounded
                  : controller.isRecording
                  ? Icons.stop_circle_rounded
                  : Icons.mic_rounded,
              color: (busy || controller.isRecording)
                  ? const Color(0xFF0965cf)
                  : (onTap != null ? color : const Color(0xFF8b9cae)),
              size: iconSize,
            ),
          ),
        );
      },
    );
  }
}

/// 流式听写的实时浮层：原文（已定稿 + 待定灰字）、润色稿、状态、取消/提交。
/// 挂到 `VoiceComposerController` 上，状态变了就重建。
class VoiceDictationHud extends StatelessWidget {
  const VoiceDictationHud({super.key, required this.controller});

  final VoiceComposerController controller;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (ctx, _) {
        final dictation = controller.dictation;
        if (dictation == null) return const SizedBox.shrink();
        return _HudBody(
          dictation: dictation,
          onCancel: controller.cancel,
          onCommit: () => controller.commit(ctx),
        );
      },
    );
  }
}

class _HudBody extends StatelessWidget {
  final VoiceDictationService dictation;
  final VoidCallback onCancel;
  final VoidCallback onCommit;

  const _HudBody({
    required this.dictation,
    required this.onCancel,
    required this.onCommit,
  });

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: dictation,
      builder: (ctx, _) {
        final raw = dictation.rawFinal;
        final partial = dictation.rawPartial;
        final refined = dictation.refined;
        final failed = dictation.state == VoiceDictationState.failed;
        final hasRaw = raw.trim().isNotEmpty || partial.trim().isNotEmpty;
        final accent = failed
            ? const Color(0xFFb64e43)
            : const Color(0xFF0965cf);
        return Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: const Color(0xFFf4f8fd),
            border: Border.all(color: accent),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Icon(
                    failed
                        ? Icons.error_outline_rounded
                        : Icons.graphic_eq_rounded,
                    size: 14,
                    color: accent,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      _stateLabel(),
                      style: const TextStyle(
                        color: Color(0xFF6f8096),
                        fontSize: 11,
                      ),
                    ),
                  ),
                ],
              ),
              if (hasRaw || refined.isNotEmpty) ...[
                const SizedBox(height: 8),
                if (hasRaw)
                  Text.rich(
                    TextSpan(
                      children: [
                        TextSpan(
                          text: raw,
                          style: const TextStyle(
                            color: Color(0xFF233249),
                            fontSize: 14,
                          ),
                        ),
                        if (partial.isNotEmpty)
                          TextSpan(
                            text: partial,
                            style: const TextStyle(
                              color: Color(0xFF6f8096),
                              fontSize: 14,
                            ),
                          ),
                      ],
                    ),
                  ),
                if (refined.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: const Color(0xFFffffff),
                      border: Border.all(
                        color: const Color(0xFF0965cf).withValues(alpha: 0.5),
                      ),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      refined,
                      style: const TextStyle(
                        color: Color(0xFF233249),
                        fontSize: 14,
                      ),
                    ),
                  ),
                ],
              ],
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(onPressed: onCancel, child: Text(t('cancel'))),
                  const SizedBox(width: 4),
                  FilledButton.icon(
                    onPressed: dictation.state == VoiceDictationState.finalizing
                        ? null
                        : onCommit,
                    icon: const Icon(Icons.send_rounded, size: 16),
                    label: Text(t('voiceSubmit')),
                    style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF0965cf),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 4,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        );
      },
    );
  }

  String _stateLabel() {
    switch (dictation.state) {
      case VoiceDictationState.starting:
        return t('voiceStarting');
      case VoiceDictationState.listening:
        return t('voiceListening');
      case VoiceDictationState.finalizing:
        return t('voiceFinalizing');
      case VoiceDictationState.failed:
        return dictation.errorDetail.isNotEmpty
            ? '⚠ ${dictation.errorDetail}'
            : t('voiceFailed');
      default:
        return '';
    }
  }
}
