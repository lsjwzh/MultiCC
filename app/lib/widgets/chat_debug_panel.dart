import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../providers/chat_provider.dart';
import '../services/chat_debug_log.dart';
import '../services/chat_service.dart';

/// 调试面板 —— Web `public/chat.html` 的 `#debug-panel`（CSS 见 2131 行）。
///
/// 它存在的唯一理由是「卡在 Thinking…」那个 bug：面板把每一条 WS 事件和每一次
/// thinking/streaming 转变都记下来，并把那个故障签名高亮成红的 —— thinking
/// 气泡还挂在屏幕上，但已经不 streaming 了。所以下面这些东西的措辞、徽章名、
/// 上下限都照抄 Web：两边对同一个 bug 的说法必须一致，否则用户报上来的是谁的
/// 说法都对不上。
///
/// 关了的时候不销毁，只是滑出屏幕（Web 的 `transform: translateX(105%)`），
/// 这样打开的动作有过渡、日志本身也不受开关影响。
class ChatDebugPanel extends StatelessWidget {
  const ChatDebugPanel({super.key, required this.open, required this.onClose});

  final bool open;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    // Web：width 380px, max-width 90vw。
    final width = math.min(380.0, MediaQuery.sizeOf(context).width * 0.9);
    return AnimatedSlide(
      offset: open ? Offset.zero : const Offset(1.05, 0),
      duration: const Duration(milliseconds: 200),
      curve: Curves.easeOut,
      child: Align(
        alignment: Alignment.centerRight,
        child: IgnorePointer(
          ignoring: !open,
          child: SizedBox(
            width: width,
            height: double.infinity,
            child: Material(
              color: const Color(0xFFffffff),
              elevation: 12,
              // Web 是 `border-left` 加一圈左侧投影；贴右边缘，所以左、上、下
              // 三条边要画线，右边不画。
              child: DecoratedBox(
                decoration: const BoxDecoration(
                  border: Border(
                    left: BorderSide(color: Color(0xFFdce6f1)),
                    top: BorderSide(color: Color(0xFFdce6f1)),
                    bottom: BorderSide(color: Color(0xFFdce6f1)),
                  ),
                ),
                child: Column(
                  children: [
                    _DebugHead(onClear: ChatDebugLog.instance.clear, onClose: onClose),
                    const _DebugStateRow(),
                    const Expanded(child: _DebugLogList()),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 头部：🪳 Debug + Copy / Clear / ×（Web 的 `.dbg-head`）。
class _DebugHead extends StatefulWidget {
  const _DebugHead({required this.onClear, required this.onClose});

  final VoidCallback onClear;
  final VoidCallback onClose;

  @override
  State<_DebugHead> createState() => _DebugHeadState();
}

class _DebugHeadState extends State<_DebugHead> {
  String? _copyResult;

  Future<void> _copy() async {
    try {
      await Clipboard.setData(ClipboardData(text: ChatDebugLog.instance.dump()));
      if (mounted) setState(() => _copyResult = 'Copied');
    } catch (_) {
      if (mounted) setState(() => _copyResult = 'Failed');
    }
    // Web：1.5s 后把按钮文案还原。
    await Future<void>.delayed(const Duration(milliseconds: 1500));
    if (mounted) setState(() => _copyResult = null);
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: const BoxDecoration(
        color: Color(0xFFf8fbff),
        border: Border(bottom: BorderSide(color: Color(0xFFdce6f1))),
      ),
      child: Row(
        children: [
          const Expanded(
            child: Text(
              '🐛 Debug',
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                color: Color(0xFF233249),
              ),
            ),
          ),
          _HeadBtn(label: _copyResult ?? t('copy'), onTap: _copy),
          const SizedBox(width: 6),
          _HeadBtn(label: t('clearBtn'), onTap: widget.onClear),
          const SizedBox(width: 6),
          Tooltip(
            message: t('close'),
            child: _HeadBtn(label: '×', onTap: widget.onClose),
          ),
        ],
      ),
    );
  }
}

class _HeadBtn extends StatelessWidget {
  const _HeadBtn({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(5),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: const Color(0xFFf0f4f9),
          border: Border.all(color: const Color(0xFFdce6f1)),
          borderRadius: BorderRadius.circular(5),
        ),
        child: Text(
          label,
          style: const TextStyle(fontSize: 11, color: Color(0xFF3b4a5e)),
        ),
      ),
    );
  }
}

/// 状态徽章行（Web 的 `dbgState()`）—— 纯渲染，值全部由调用方给。
///
/// 值给进来而不是自己读 provider，是为了让那个被标红的故障签名
/// （thinking 还在但已经不 streaming）能被单独测到：在真实 provider 上制造
/// 「思考条挂着 + 已不 streaming」需要伪造服务层内部状态，而这一行本来就是
/// 一张纯展示的表。
class ChatDebugStateRow extends StatelessWidget {
  const ChatDebugStateRow({
    super.key,
    required this.ws,
    required this.streaming,
    required this.thinking,
    required this.liveBubble,
    required this.session,
  });

  final String ws;
  final bool streaming;
  final bool thinking;
  final bool liveBubble;
  final String session;

  @override
  Widget build(BuildContext context) {
    // Web 里被标红的那一条：thinking 还在屏幕上，但已经不在 streaming。
    final stuck = thinking && !streaming;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: const BoxDecoration(
        color: Color(0xFFf8fbff),
        border: Border(bottom: BorderSide(color: Color(0xFFe6edf5))),
      ),
      child: Wrap(
        spacing: 4,
        runSpacing: 4,
        children: [
          _Badge(
            name: 'ws',
            value: ws,
            tone: ws == 'OPEN' ? _Tone.ok : _Tone.bad,
          ),
          _Badge(
            name: 'streaming',
            value: '$streaming',
            tone: streaming ? _Tone.warn : _Tone.plain,
          ),
          _Badge(
            name: 'thinking',
            value: '$thinking',
            tone: stuck ? _Tone.bad : (thinking ? _Tone.warn : _Tone.plain),
          ),
          _Badge(
            name: 'msgEl',
            value: '$liveBubble',
            tone: _Tone.plain,
          ),
          _Badge(
            name: 'session',
            value: session.isEmpty
                ? '-'
                : session.substring(0, session.length < 8 ? session.length : 8),
            tone: _Tone.plain,
          ),
          if (stuck)
            const _Badge(
              name: '⚠ STUCK',
              value: 'thinking 显示中但已不在 streaming',
              tone: _Tone.bad,
            ),
        ],
      ),
    );
  }
}

/// 从 [ChatProvider] 取值的薄包装。
///
/// 单独一层：它跟 provider 走（流式时每帧都在通知），而下面的日志列表只跟
/// [ChatDebugLog] 走。两者分开，开着面板长跑时就不会因为一帧增量把 600 行
/// 日志全部重建一遍。
class _DebugStateRow extends StatelessWidget {
  const _DebugStateRow();

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    return ChatDebugStateRow(
      ws: switch (provider.connectionState) {
        ChatConnectionState.connected => 'OPEN',
        ChatConnectionState.connecting => 'CONNECTING',
        ChatConnectionState.disconnected => 'CLOSED',
      },
      streaming: provider.isStreaming,
      thinking: provider.thinkingIndicatorVisible,
      liveBubble: provider.hasLiveAssistantBubble,
      session: provider.sessionId,
    );
  }
}

enum _Tone { plain, ok, warn, bad }

const Map<_Tone, (Color bg, Color border, Color fg)> _toneColors = {
  _Tone.plain: (Color(0xFFf0f4f9), Color(0xFFdce6f1), Color(0xFF6f8096)),
  _Tone.ok: (Color(0xFFe6f4ea), Color(0xFF1a7f37), Color(0xFF1a7f37)),
  _Tone.warn: (Color(0xFFfdf3d7), Color(0xFF9a6700), Color(0xFF9a6700)),
  _Tone.bad: (Color(0xFFfdeced), Color(0xFFcf222e), Color(0xFFcf222e)),
};

class _Badge extends StatelessWidget {
  const _Badge({required this.name, required this.value, required this.tone});

  final String name;
  final String value;
  final _Tone tone;

  @override
  Widget build(BuildContext context) {
    final (bg, border, fg) = _toneColors[tone]!;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        border: Border.all(color: border),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: '$name ',
              style: const TextStyle(
                fontWeight: FontWeight.w600,
                color: Color(0xFF3b4a5e),
              ),
            ),
            TextSpan(text: value),
          ],
        ),
        style: TextStyle(fontFamily: 'monospace', fontSize: 10, color: fg),
      ),
    );
  }
}

/// 日志列表。新行到达时，只有当用户本来就贴着底部才自动滚 —— 正在往上翻旧
/// 日志的人不该被拽回去（Web 的 `nearBottom` 判断）。
class _DebugLogList extends StatefulWidget {
  const _DebugLogList();

  @override
  State<_DebugLogList> createState() => _DebugLogListState();
}

class _DebugLogListState extends State<_DebugLogList> {
  final _ctrl = ScrollController();

  @override
  void initState() {
    super.initState();
    ChatDebugLog.instance.addListener(_onEntry);
    WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToBottom());
  }

  @override
  void dispose() {
    ChatDebugLog.instance.removeListener(_onEntry);
    _ctrl.dispose();
    super.dispose();
  }

  void _onEntry() {
    final nearBottom = _nearBottom();
    if (mounted) setState(() {});
    if (nearBottom) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToBottom());
    }
  }

  bool _nearBottom() {
    if (!_ctrl.hasClients) return true;
    final p = _ctrl.position;
    return p.maxScrollExtent - p.pixels < 60;
  }

  void _jumpToBottom() {
    if (!mounted || !_ctrl.hasClients) return;
    _ctrl.jumpTo(_ctrl.position.maxScrollExtent);
  }

  @override
  Widget build(BuildContext context) {
    final entries = ChatDebugLog.instance.entries;
    return Scrollbar(
      controller: _ctrl,
      child: ListView.builder(
        controller: _ctrl,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        itemCount: entries.length,
        itemBuilder: (_, i) => _DebugLine(entry: entries[i]),
      ),
    );
  }
}

class _DebugLine extends StatelessWidget {
  const _DebugLine({required this.entry});

  final ChatDebugEntry entry;

  /// Web 的 `.dbg-cat-*`。没有配色规则的分类（chat / history / model）继承正常
  /// 文字色 —— 那边也一样。
  static const Map<String, Color> _catColors = {
    'event': Color(0xFF0969da),
    'state': Color(0xFF8250df),
    'think': Color(0xFF9a6700),
    'ws': Color(0xFF1a7f37),
    'warn': Color(0xFFcf222e),
  };

  @override
  Widget build(BuildContext context) {
    final color = _catColors[entry.cat] ?? const Color(0xFF3b4a5e);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 1),
      child: Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: '${entry.time} ',
              style: const TextStyle(color: Color(0xFF8a99ad)),
            ),
            TextSpan(
              text: '[${entry.cat}]',
              style: TextStyle(color: color),
            ),
            TextSpan(text: ' ${entry.text}'),
          ],
        ),
        style: const TextStyle(
          fontFamily: 'monospace',
          fontSize: 11,
          height: 1.55,
          color: Color(0xFF3b4a5e),
        ),
      ),
    );
  }
}
