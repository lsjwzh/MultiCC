import 'package:flutter/material.dart';

import '../models/message.dart';
import '../models/tool_input_view.dart';

const Map<String, String> _kToolIcons = {
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

String toolIconFor(String name) => _kToolIcons[name] ?? '⚙️';

/// Short status/description line for a tool call, shared by the card and the
/// compact rows in [ToolCallGroup]. Mirrors the web tool-desc lifecycle: while
/// running the input summary (command / file_path / …) is shown; once done it
/// is replaced by the outcome plus the measured wall-clock duration — "done ·
/// 1.5s" — and only when both timing stamps exist. History replay has no tool
/// timing, so it degrades to the bare "done"/"failed" (never a fabricated 0ms).
String toolDescriptionFor(ToolCall tc, {int max = 60}) {
  if (!tc.isDone) {
    final d = tc.description;
    if (d.isNotEmpty) return d.length > max ? '${d.substring(0, max)}…' : d;
    return 'running…';
  }
  final base = tc.isError ? 'failed' : 'done';
  final dur = humanizeToolDuration(tc.durationMs);
  return dur.isEmpty ? base : '$base · $dur';
}

class ToolCardWidget extends StatefulWidget {
  final ToolCall toolCall;
  const ToolCardWidget({super.key, required this.toolCall});

  @override
  State<ToolCardWidget> createState() => _ToolCardWidgetState();
}

class _ToolCardWidgetState extends State<ToolCardWidget> {
  bool _expanded = false;

  String get _icon => toolIconFor(widget.toolCall.name);

  String get _description => toolDescriptionFor(widget.toolCall);

  String _prettyInput() {
    // Typed preview (Bash → "$ cmd", Read → file path, Edit → old/new diff,
    // …) mirroring the web's renderToolInput; raw text when the JSON is
    // incomplete (mid-stream) or unparsable.
    final parsed = widget.toolCall.parsedInput;
    if (parsed != null) return renderToolInput(widget.toolCall.name, parsed);
    return widget.toolCall.inputJson;
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

/// Renders the tool calls of one assistant message. Up to [_maxVisible] are
/// shown inline as normal cards (each expandable in place). Beyond that, they
/// collapse into a fixed-height box that only lists the most recent few actions
/// as compact rows; tapping opens a bottom sheet with the full, scrollable list.
class ToolCallGroup extends StatelessWidget {
  final List<ToolCall> toolCalls;
  const ToolCallGroup({super.key, required this.toolCalls});

  static const _maxVisible = 3;

  @override
  Widget build(BuildContext context) {
    if (toolCalls.isEmpty) return const SizedBox.shrink();
    // Few enough to show in full — keep the directly-expandable cards.
    if (toolCalls.length <= _maxVisible) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: toolCalls.map((tc) => ToolCardWidget(toolCall: tc)).toList(),
      );
    }

    // Many calls: a compact, fixed-height box showing only the latest few.
    final recent = toolCalls.sublist(toolCalls.length - _maxVisible);
    final running = toolCalls.any((tc) => !tc.isDone);
    return Container(
      margin: const EdgeInsets.only(top: 8),
      decoration: BoxDecoration(
        border: Border.all(color: const Color(0xFF20242b)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () => _openSheet(context),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: const BoxDecoration(
                color: Color(0xFF14171c),
                borderRadius: BorderRadius.only(
                  topLeft: Radius.circular(7),
                  topRight: Radius.circular(7),
                ),
              ),
              child: Row(
                children: [
                  const Text('🔧', style: TextStyle(fontSize: 13)),
                  const SizedBox(width: 8),
                  Text(
                    '${toolCalls.length} 个工具调用',
                    style: const TextStyle(
                      color: Color(0xFF6aa3ff),
                      fontWeight: FontWeight.w600,
                      fontSize: 13,
                    ),
                  ),
                  const SizedBox(width: 8),
                  if (running)
                    const SizedBox(
                      width: 12,
                      height: 12,
                      child: CircularProgressIndicator(
                        strokeWidth: 1.5,
                        color: Color(0xFF6aa3ff),
                      ),
                    ),
                  const Spacer(),
                  const Text(
                    '查看全部',
                    style: TextStyle(color: Color(0xFF8a909b), fontSize: 11),
                  ),
                  const Icon(
                    Icons.unfold_more_rounded,
                    color: Color(0xFF5b616c),
                    size: 16,
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final tc in recent) _CompactToolRow(toolCall: tc),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _openSheet(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFF0f1115),
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
      ),
      builder: (_) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.6,
        minChildSize: 0.3,
        maxChildSize: 0.95,
        builder: (context, scrollCtrl) => Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 8, 6),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      '工具调用 · ${toolCalls.length}',
                      style: const TextStyle(
                        color: Color(0xFFf2f4f7),
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close, color: Color(0xFF8a909b)),
                  ),
                ],
              ),
            ),
            const Divider(height: 1, color: Color(0xFF20242b)),
            Expanded(
              child: ListView(
                controller: scrollCtrl,
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
                children: [
                  for (final tc in toolCalls) ToolCardWidget(toolCall: tc),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One-line summary of a tool call used inside the collapsed [ToolCallGroup].
class _CompactToolRow extends StatelessWidget {
  final ToolCall toolCall;
  const _CompactToolRow({required this.toolCall});

  @override
  Widget build(BuildContext context) {
    final isDone = toolCall.isDone;
    final isError = toolCall.isError;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Text(toolIconFor(toolCall.name), style: const TextStyle(fontSize: 12)),
          const SizedBox(width: 7),
          Text(
            toolCall.name,
            style: const TextStyle(
              color: Color(0xFF6aa3ff),
              fontWeight: FontWeight.w600,
              fontSize: 12,
            ),
          ),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              toolDescriptionFor(toolCall, max: 48),
              style: TextStyle(
                color: isDone
                    ? (isError
                        ? const Color(0xFFff6b63)
                        : const Color(0xFF7fd49a))
                    : const Color(0xFF8a909b),
                fontSize: 11,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 6),
          if (!isDone)
            const SizedBox(
              width: 10,
              height: 10,
              child: CircularProgressIndicator(
                strokeWidth: 1.5,
                color: Color(0xFF6aa3ff),
              ),
            )
          else
            Icon(
              isError
                  ? Icons.error_outline_rounded
                  : Icons.check_circle_outline_rounded,
              size: 12,
              color: isError ? const Color(0xFFff6b63) : const Color(0xFF7fd49a),
            ),
        ],
      ),
    );
  }
}
