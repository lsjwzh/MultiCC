import 'package:flutter/material.dart';

import '../providers/chat_provider.dart';
import '../services/voice_call_service.dart';

/// 全双工语音通话界面（豆包式）。
///
/// 进入即 [VoiceCallService.start] 开麦 + 连接 TTS；全程由状态机驱动：
/// 聆听 → 确认 → 执行 → 汇报。用户开口即可打断 AI（barge-in）。
///
/// [chatProvider] 必须由调用方传入：本页 push 到根 Navigator，不在 ChatView 的
/// Provider 子树内，无法用 context.read<ChatProvider>() 获取（否则灰屏崩溃）。
class VoiceCallScreen extends StatefulWidget {
  final ChatProvider chatProvider;
  const VoiceCallScreen({super.key, required this.chatProvider});

  @override
  State<VoiceCallScreen> createState() => _VoiceCallScreenState();
}

class _VoiceCallScreenState extends State<VoiceCallScreen> with WidgetsBindingObserver {
  late final VoiceCallService _svc;
  final _scrollCtl = ScrollController();
  bool _starting = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final provider = widget.chatProvider;
    _svc = VoiceCallService(chatProvider: provider, settings: provider.settings);
    _svc.addListener(_onSvcChanged);
    // 进入即开始通话。
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await _svc.start();
      if (mounted) setState(() => _starting = false);
    });
  }

  void _onSvcChanged() {
    if (!mounted) return;
    setState(() {});
    // 新气泡进来 → 滚到底部。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtl.hasClients) {
        _scrollCtl.animateTo(
          _scrollCtl.position.maxScrollExtent,
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    // 退到后台即结束通话（释放麦克风 / 音频会话）。
    if (s == AppLifecycleState.paused || s == AppLifecycleState.inactive) {
      _svc.hangUp();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _svc.removeListener(_onSvcChanged);
    _svc.dispose();
    _scrollCtl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _hangUp();
      },
      child: Scaffold(
        backgroundColor: const Color(0xFFf4f8fd),
        body: SafeArea(
          child: Column(
            children: [
              _buildHeader(),
              Expanded(child: _buildTranscript()),
              if (_svc.breakdownSummary != null || (_svc.breakdownItems?.isNotEmpty ?? false))
                _buildBreakdownCard(),
              _buildOrb(),
              _buildStatus(),
              _buildHangUp(),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ),
    );
  }

  // ── Header ──────────────────────────────────────────────────────────────────

  Widget _buildHeader() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            decoration: BoxDecoration(
              color: _stateColor.withOpacity(0.16),
              borderRadius: BorderRadius.circular(20),
              border: Border.all(color: _stateColor.withOpacity(0.5)),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(_stateIcon, color: _stateColor, size: 14),
                const SizedBox(width: 6),
                Text(_stateLabel, style: TextStyle(color: _stateColor, fontSize: 12, fontWeight: FontWeight.w600)),
              ],
            ),
          ),
          const Spacer(),
          Text(_svc.chatProvider.titleLabel,
              style: const TextStyle(color: Color(0xFF6f8096), fontSize: 12),
              overflow: TextOverflow.ellipsis),
        ],
      ),
    );
  }

  // ── Transcript ───────────────────────────────────────────────────────────────

  Widget _buildTranscript() {
    final bubbles = _svc.bubbles;
    if (bubbles.isEmpty && _starting) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('正在连接通话…', style: TextStyle(color: Color(0xFF6f8096), fontSize: 14)),
        ),
      );
    }
    return ListView.builder(
      controller: _scrollCtl,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      itemCount: bubbles.length,
      itemBuilder: (_, i) => _bubble(bubbles[i]),
    );
  }

  Widget _bubble(VoiceCallBubble b) {
    final isUser = b.fromUser;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        decoration: BoxDecoration(
          color: isUser ? const Color(0xFFf8fbff) : const Color(0xFFf8fbff),
          border: Border.all(color: isUser ? const Color(0xFFeaf4ff) : const Color(0xFFdce6f1)),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              isUser ? '你' : 'AI',
              style: TextStyle(
                color: isUser ? const Color(0xFF1267b5) : const Color(0xFF0965cf),
                fontSize: 10,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 3),
            Text(b.text, style: const TextStyle(color: Color(0xFF233249), fontSize: 14, height: 1.4)),
          ],
        ),
      ),
    );
  }

  // ── Breakdown card (CONFIRMING) ──────────────────────────────────────────────

  Widget _buildBreakdownCard() {
    final items = _svc.breakdownItems ?? const <String>[];
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFFf4f8fd),
        border: Border.all(color: const Color(0xFF0965cf).withOpacity(0.5)),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_svc.breakdownSummary != null && _svc.breakdownSummary!.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text(_svc.breakdownSummary!,
                  style: const TextStyle(color: Color(0xFF233249), fontSize: 13, height: 1.4)),
            ),
          for (var i = 0; i < items.length; i++)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text('${i + 1}. ${items[i]}',
                  style: const TextStyle(color: Color(0xFF31465b), fontSize: 12.5, height: 1.4)),
            ),
          const SizedBox(height: 6),
          const Text('说“对/确认”执行，或说出要改的地方',
              style: TextStyle(color: Color(0xFF6f8096), fontSize: 11)),
        ],
      ),
    );
  }

  // ── Mic orb ──────────────────────────────────────────────────────────────────

  Widget _buildOrb() {
    final level = _svc.level.clamp(0.0, 1.0);
    final speaking = _svc.userSpeaking;
    final aiSpeaking = _svc.state == VoiceCallState.confirming ||
        _svc.state == VoiceCallState.reporting;
    final base = 96.0;
    final size = base + (speaking ? 18 : 0) + level * 46;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 90),
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(
            colors: [
              (aiSpeaking ? const Color(0xFF0965cf) : const Color(0xFF1267b5))
                  .withOpacity(0.95),
              (aiSpeaking ? const Color(0xFF137780) : const Color(0xFFeaf4ff))
                  .withOpacity(0.75),
            ],
          ),
          boxShadow: [
            BoxShadow(
              color: (aiSpeaking ? const Color(0xFF0965cf) : const Color(0xFF1267b5))
                  .withOpacity(0.35 + level * 0.4),
              blurRadius: 28 + level * 30,
              spreadRadius: 2,
            ),
          ],
        ),
        child: Icon(
          aiSpeaking ? Icons.graphic_eq_rounded : (speaking ? Icons.mic_rounded : Icons.hearing_rounded),
          color: Colors.white,
          size: 38,
        ),
      ),
    );
  }

  Widget _buildStatus() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 6),
      child: Column(
        children: [
          Text(_stateLabel, style: const TextStyle(color: Color(0xFF20364d), fontSize: 16, fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          Text(
            _svc.statusText.isEmpty ? '随时开口说话，AI 说话时你可以打断' : _svc.statusText,
            style: const TextStyle(color: Color(0xFF6f8096), fontSize: 12),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }

  // ── Hang up ──────────────────────────────────────────────────────────────────

  Widget _buildHangUp() {
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: GestureDetector(
        onTap: _hangUp,
        child: Container(
          width: 66,
          height: 66,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: const Color(0xFFb64e43),
            boxShadow: [
              BoxShadow(color: const Color(0xFFb64e43).withOpacity(0.35), blurRadius: 22, spreadRadius: 1),
            ],
          ),
          child: const Icon(Icons.call_end_rounded, color: Colors.white, size: 30),
        ),
      ),
    );
  }

  void _hangUp() {
    _svc.hangUp().then((_) {
      if (mounted) Navigator.of(context).maybePop();
    });
  }

  // ── State visual mapping ─────────────────────────────────────────────────────

  String get _stateLabel {
    switch (_svc.state) {
      case VoiceCallState.idle:
        return _starting ? '连接中' : '待机';
      case VoiceCallState.listening:
        return _svc.userSpeaking ? '聆听中' : '聆听中';
      case VoiceCallState.confirming:
        return '确认需求';
      case VoiceCallState.executing:
        return '执行任务中';
      case VoiceCallState.reporting:
        return '汇报中';
    }
  }

  IconData get _stateIcon {
    switch (_svc.state) {
      case VoiceCallState.listening:
        return Icons.hearing_rounded;
      case VoiceCallState.confirming:
        return Icons.task_alt_rounded;
      case VoiceCallState.executing:
        return Icons.autorenew_rounded;
      case VoiceCallState.reporting:
        return Icons.campaign_rounded;
      default:
        return Icons.phone_in_talk_rounded;
    }
  }

  Color get _stateColor {
    switch (_svc.state) {
      case VoiceCallState.listening:
        return const Color(0xFF1267b5);
      case VoiceCallState.confirming:
        return const Color(0xFF0965cf);
      case VoiceCallState.executing:
        return const Color(0xFFa85a25);
      case VoiceCallState.reporting:
        return const Color(0xFF0965cf);
      default:
        return const Color(0xFF6f8096);
    }
  }
}
