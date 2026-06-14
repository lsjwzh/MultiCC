import 'dart:convert';
import 'package:flutter/material.dart';

import '../models/message.dart';

class ToolCardWidget extends StatefulWidget {
  final ToolCall toolCall;
  const ToolCardWidget({super.key, required this.toolCall});

  @override
  State<ToolCardWidget> createState() => _ToolCardWidgetState();
}

class _ToolCardWidgetState extends State<ToolCardWidget> {
  bool _expanded = false;

  static const _icons = {
    'Bash': '>_',
    'Read': '📄',
    'Edit': '✏️',
    'Write': '💾',
    'Glob': '🔍',
    'Grep': '🔎',
    'Agent': '🤖',
    'WebFetch': '🌐',
    'WebSearch': '🌐',
  };

  String get _icon => _icons[widget.toolCall.name] ?? '⚙️';

  String get _description {
    final d = widget.toolCall.description;
    if (d.isNotEmpty) return d.length > 60 ? '${d.substring(0, 60)}…' : d;
    return widget.toolCall.isDone
        ? (widget.toolCall.isError ? 'failed' : 'done')
        : 'running…';
  }

  String _prettyInput() {
    try {
      final parsed = jsonDecode(widget.toolCall.inputJson);
      return const JsonEncoder.withIndent('  ').convert(parsed);
    } catch (_) {
      return widget.toolCall.inputJson;
    }
  }

  @override
  Widget build(BuildContext context) {
    final isError = widget.toolCall.isError;
    final isDone = widget.toolCall.isDone;

    return Container(
      margin: const EdgeInsets.only(top: 8),
      decoration: BoxDecoration(
        border: Border.all(color: const Color(0xFF20242b)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header (tap to expand)
          GestureDetector(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: const Color(0xFF14171c),
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(7),
                  topRight: const Radius.circular(7),
                  bottomLeft: _expanded ? Radius.zero : const Radius.circular(7),
                  bottomRight: _expanded ? Radius.zero : const Radius.circular(7),
                ),
              ),
              child: Row(
                children: [
                  Text(_icon, style: const TextStyle(fontSize: 14)),
                  const SizedBox(width: 8),
                  Text(
                    widget.toolCall.name,
                    style: const TextStyle(
                      color: Color(0xFF6aa3ff),
                      fontWeight: FontWeight.w600,
                      fontSize: 13,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _description,
                      style: TextStyle(
                        color: isDone
                            ? (isError ? const Color(0xFFff6b63) : const Color(0xFF7fd49a))
                            : const Color(0xFF8a909b),
                        fontSize: 12,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(width: 4),
                  if (!isDone)
                    const SizedBox(
                      width: 12,
                      height: 12,
                      child: CircularProgressIndicator(
                        strokeWidth: 1.5,
                        color: Color(0xFF6aa3ff),
                      ),
                    ),
                  Icon(
                    _expanded ? Icons.chevron_right_rounded : Icons.chevron_right_rounded,
                    color: const Color(0xFF5b616c),
                    size: 16,
                  ),
                ],
              ),
            ),
          ),

          // Body (expanded)
          if (_expanded)
            Container(
              padding: const EdgeInsets.all(12),
              decoration: const BoxDecoration(
                color: Color(0xFF070809),
                border: Border(top: BorderSide(color: Color(0xFF14171c))),
                borderRadius: BorderRadius.only(
                  bottomLeft: Radius.circular(7),
                  bottomRight: Radius.circular(7),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (widget.toolCall.inputJson.isNotEmpty) ...[
                    const Text(
                      'Input:',
                      style: TextStyle(fontSize: 11, color: Color(0xFF5b616c), fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 4),
                    SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: Text(
                        _prettyInput(),
                        style: const TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 12,
                          color: Color(0xFF8a909b),
                          height: 1.5,
                        ),
                      ),
                    ),
                  ],
                  if (widget.toolCall.result != null) ...[
                    const SizedBox(height: 8),
                    Text(
                      isError ? 'Error:' : 'Result:',
                      style: TextStyle(
                        fontSize: 11,
                        color: isError ? const Color(0xFFff6b63) : const Color(0xFF7fd49a),
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Container(
                      constraints: const BoxConstraints(maxHeight: 200),
                      child: SingleChildScrollView(
                        child: Text(
                          _truncate(widget.toolCall.result!, 2000),
                          style: const TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 12,
                            color: Color(0xFF8a909b),
                            height: 1.5,
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }

  String _truncate(String s, int max) => s.length > max ? '${s.substring(0, max)}…' : s;
}
