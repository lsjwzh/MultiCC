import 'package:flutter/material.dart';

import '../i18n.dart';
import '../services/settings_service.dart';
import '../services/voice_clip_recorder.dart';
import '../theme.dart';

/// 🎙 一次性的「录一段 → 转写」，对齐 Web Air 那颗 `#quick-task-mic`
/// （`public/air.js` 的 `toggleQuickDictation`）：点一下开始、再点一下结束，
/// 转写结果交给宿主（Web 是直接追加进输入框）。
///
/// 录音中那颗按钮换成 Web 的同款红底（`air.css` 的 `#quick-task-mic.rec`）。
/// 状态文案由宿主摆在它自己的位置上（Web 放在 `#quick-task-status` 那格），
/// 这样 320px 上还能像 Web 那样把整行让给状态文字。
class VoiceInputButton extends StatefulWidget {
  const VoiceInputButton({
    super.key,
    required this.settings,
    required this.onText,
    this.onStatus,
    this.enabled = true,
    this.iconSize = 19,
    this.color,
  });

  /// 当前会话的设置，转写那一刻才用得上 —— 宿主重建时跟着更新就行。
  final SettingsService settings;

  /// 转写好了的文本（可能是空串，交给宿主判断要不要提示）。
  final ValueChanged<String> onText;

  /// 状态文案变了（'' = 清空）。宿主自己决定摆哪儿、要不要显示。
  final ValueChanged<String>? onStatus;

  final bool enabled;
  final double iconSize;

  /// 空闲时的图标颜色，默认 [AppColors.faint]。
  final Color? color;

  @override
  State<VoiceInputButton> createState() => _VoiceInputButtonState();
}

class _VoiceInputButtonState extends State<VoiceInputButton> {
  final _clip = VoiceClipRecorder();

  @override
  void dispose() {
    _clip.dispose();
    super.dispose();
  }

  void _setStatus(String message) => widget.onStatus?.call(message);

  Future<void> _toggle() async {
    if (_clip.isTranscribing) return;
    if (_clip.isRecording) {
      await _stop();
      return;
    }
    if (!await _clip.start()) {
      if (!mounted) return;
      _setStatus(t('voiceMicDenied'));
      setState(() {});
      return;
    }
    if (!mounted) return;
    _setStatus(t('voiceRecordingHint'));
    setState(() {});
  }

  Future<void> _stop() async {
    _setStatus(t('voiceTranscribing'));
    setState(() {});
    try {
      final text = await _clip.stopAndTranscribe(widget.settings);
      if (!mounted) return;
      if (text.isEmpty) {
        _setStatus(t('voiceEmpty'));
      } else {
        _setStatus('');
        widget.onText(text);
      }
    } on VoiceClipException catch (e) {
      if (!mounted) return;
      _setStatus(t('voiceTranscribeFailed', {'message': '$e'}));
    } finally {
      if (mounted) setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    final recording = _clip.isRecording;
    final transcribing = _clip.isTranscribing;
    return IconButton(
      onPressed: widget.enabled && !transcribing ? _toggle : null,
      iconSize: widget.iconSize,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
      visualDensity: VisualDensity.compact,
      style: recording
          ? IconButton.styleFrom(
              backgroundColor: const Color(0xFFd1604a),
              foregroundColor: Colors.white,
            )
          : null,
      tooltip: t('voiceMicTitle'),
      icon: Icon(
        transcribing
            ? Icons.hourglass_top_rounded
            : (recording ? Icons.stop_rounded : Icons.mic_none_rounded),
        color: recording
            ? Colors.white
            : (widget.color ?? AppColors.faint),
      ),
    );
  }
}
