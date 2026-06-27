import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/message.dart';
import '../services/settings_service.dart';
import 'tool_card.dart';

/// Resolve a markdown link href and open it externally.
///
/// Handles three forms:
///  - absolute `http(s)://…` links → opened as-is
///  - root-relative links like `/artifacts/<id>/index.html` (multicc artifacts,
///    file downloads) → resolved against the configured server base URL
///  - `mailto:` / other schemes → handed to the OS as-is
Future<void> _handleLinkTap(BuildContext context, String? href) async {
  if (href == null || href.trim().isEmpty) return;
  var target = href.trim();

  // Root-relative path: resolve against the multicc server we're talking to.
  if (target.startsWith('/')) {
    final base = SettingsService.current?.buildHttpUrl(target);
    if (base != null) target = base;
  } else if (!target.contains('://') && !target.startsWith('mailto:')) {
    // Bare host or path without a scheme — assume http for the current server.
    final base = SettingsService.current?.buildHttpUrl('/$target');
    if (base != null) target = base;
  }

  final uri = Uri.tryParse(target);
  if (uri == null) return;

  final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
  if (!ok && context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('无法打开链接：$target'),
        duration: const Duration(milliseconds: 1600),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }
}

/// Copy a message's text to the clipboard with a brief confirmation.
void _copyMessage(BuildContext context, String text) {
  final t = text.trim();
  if (t.isEmpty) return;
  Clipboard.setData(ClipboardData(text: t));
  ScaffoldMessenger.of(context).showSnackBar(
    const SnackBar(
      content: Text('已复制'),
      duration: Duration(milliseconds: 1200),
      behavior: SnackBarBehavior.floating,
    ),
  );
}

class MessageBubble extends StatelessWidget {
  final ChatMessage message;
  const MessageBubble({super.key, required this.message});

  @override
  Widget build(BuildContext context) {
    switch (message.role) {
      case MessageRole.user:
        return _UserBubble(message: message);
      case MessageRole.assistant:
        return _AssistantBubble(message: message);
      case MessageRole.system:
        return _SystemBubble(message: message);
    }
  }
}

class _UserBubble extends StatelessWidget {
  final ChatMessage message;
  const _UserBubble({required this.message});

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerRight,
      child: GestureDetector(
        onLongPress: () => _copyMessage(context, message.content),
        child: Container(
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.85),
          margin: const EdgeInsets.symmetric(vertical: 4),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: const BoxDecoration(
            color: Color(0xFF22ab9c),
            borderRadius: BorderRadius.only(
              topLeft: Radius.circular(12),
              topRight: Radius.circular(12),
              bottomLeft: Radius.circular(12),
              bottomRight: Radius.circular(4),
            ),
          ),
          child: Text(
            message.content,
            style: const TextStyle(color: Colors.white, fontSize: 14, height: 1.5),
          ),
        ),
      ),
    );
  }
}

class _AssistantBubble extends StatelessWidget {
  final ChatMessage message;
  const _AssistantBubble({required this.message});

  @override
  Widget build(BuildContext context) {
    final hasText = message.content.trim().isNotEmpty;
    final hasTools = message.toolCalls.isNotEmpty;

    return Align(
      alignment: Alignment.centerLeft,
      child: GestureDetector(
        onLongPress: () => _copyMessage(context, message.content),
        child: Container(
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.92),
          margin: const EdgeInsets.symmetric(vertical: 4),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: const Color(0xFF0f1115),
            border: Border.all(color: const Color(0xFF20242b)),
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(12),
              topRight: Radius.circular(12),
              bottomRight: Radius.circular(12),
              bottomLeft: Radius.circular(4),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (hasText)
                _MarkdownContent(
                  text: message.content,
                  isStreaming: message.isStreaming,
                ),
              if (hasTools) ToolCallGroup(toolCalls: message.toolCalls),
              if (!hasText && !hasTools && message.isStreaming)
                const _StreamingDot(),
              // Token usage line
              if (message.usage != null && !message.usage!.isEmpty)
                _TokenUsageLine(usage: message.usage!),
            ],
          ),
        ),
      ),
    );
  }
}

/// Token usage line shown under assistant messages
class _TokenUsageLine extends StatelessWidget {
  final MessageUsage usage;
  const _TokenUsageLine({required this.usage});

  static String _fmt(int n) {
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}k';
    return n.toString();
  }

  @override
  Widget build(BuildContext context) {
    final i = usage.inputTokens;
    final o = usage.outputTokens;
    final cr = usage.cacheReadTokens;
    final cw = usage.cacheCreationTokens;

    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        children: [
          _UsageBadge(label: '↑入', value: _fmt(i), color: const Color(0xFF58a6ff)),
          const SizedBox(width: 6),
          _UsageBadge(label: '↓出', value: _fmt(o), color: const Color(0xFF3fb950)),
          if (cr > 0) ...[
            const SizedBox(width: 6),
            _UsageBadge(label: '⏱读', value: _fmt(cr), color: const Color(0xFFd29922)),
          ],
          if (cw > 0) ...[
            const SizedBox(width: 6),
            _UsageBadge(label: '⏱写', value: _fmt(cw), color: const Color(0xFFa371f7)),
          ],
        ],
      ),
    );
  }
}

class _UsageBadge extends StatelessWidget {
  final String label;
  final String value;
  final Color color;
  const _UsageBadge({required this.label, required this.value, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        '$label $value',
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontFamily: 'monospace',
        ),
      ),
    );
  }
}

class _MarkdownContent extends StatelessWidget {
  final String text;
  final bool isStreaming;
  const _MarkdownContent({required this.text, required this.isStreaming});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        MarkdownBody(
          data: text,
          styleSheet: MarkdownStyleSheet(
            p: const TextStyle(color: Color(0xFFe7eaee), fontSize: 14, height: 1.6),
            code: const TextStyle(
              color: Color(0xFFe7eaee),
              backgroundColor: Color(0xFF14171c),
              fontFamily: 'monospace',
              fontSize: 13,
            ),
            codeblockDecoration: BoxDecoration(
              color: const Color(0xFF070809),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: const Color(0xFF14171c)),
            ),
            codeblockPadding: const EdgeInsets.all(12),
            blockquoteDecoration: const BoxDecoration(
              border: Border(left: BorderSide(color: Color(0xFF20242b), width: 3)),
            ),
            blockquotePadding: const EdgeInsets.only(left: 10),
            h1: const TextStyle(color: Color(0xFFf2f4f7), fontSize: 18, fontWeight: FontWeight.bold),
            h2: const TextStyle(color: Color(0xFFf2f4f7), fontSize: 16, fontWeight: FontWeight.bold),
            h3: const TextStyle(color: Color(0xFFf2f4f7), fontSize: 15, fontWeight: FontWeight.bold),
            strong: const TextStyle(color: Color(0xFFf2f4f7), fontWeight: FontWeight.bold),
            em: const TextStyle(color: Color(0xFFd2a8ff), fontStyle: FontStyle.italic),
            a: const TextStyle(color: Color(0xFF6aa3ff)),
            tableHead: const TextStyle(color: Color(0xFFf2f4f7), fontWeight: FontWeight.bold),
            tableBody: const TextStyle(color: Color(0xFFe7eaee)),
            tableBorder: TableBorder.all(color: const Color(0xFF20242b)),
            tableCellsPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          ),
          selectable: true,
          onTapLink: (text, href, title) => _handleLinkTap(context, href),
        ),
        if (isStreaming) const _StreamingDot(),
      ],
    );
  }
}

class _StreamingDot extends StatefulWidget {
  const _StreamingDot();
  @override
  State<_StreamingDot> createState() => _StreamingDotState();
}

class _StreamingDotState extends State<_StreamingDot>
    with SingleTickerProviderStateMixin {
  late AnimationController _ctrl;
  late Animation<double> _anim;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 800))
      ..repeat(reverse: true);
    _anim = Tween<double>(begin: 0.2, end: 1.0).animate(_ctrl);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _anim,
      builder: (_, __) => Container(
        margin: const EdgeInsets.only(top: 4, left: 2),
        width: 7,
        height: 7,
        decoration: BoxDecoration(
          color: Color.fromRGBO(88, 166, 255, _anim.value),
          shape: BoxShape.circle,
        ),
      ),
    );
  }
}

class _SystemBubble extends StatelessWidget {
  final ChatMessage message;
  const _SystemBubble({required this.message});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: GestureDetector(
        onLongPress: () => _copyMessage(context, message.content),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Text(
            message.content,
            style: const TextStyle(color: Color(0xFF5b616c), fontSize: 12),
            textAlign: TextAlign.center,
          ),
        ),
      ),
    );
  }
}
