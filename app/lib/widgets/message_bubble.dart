import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';

import '../models/message.dart';
import 'tool_card.dart';

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
              if (hasTools)
                ...message.toolCalls.map((tc) => ToolCardWidget(toolCall: tc)),
              if (!hasText && !hasTools && message.isStreaming)
                const _StreamingDot(),
            ],
          ),
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
