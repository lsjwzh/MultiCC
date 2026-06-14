import 'package:flutter/material.dart';

Future<void> showConflictDiffDialog(
  BuildContext context, {
  required String sessionId,
  required Map<String, dynamic> result,
}) {
  final conflicts = (result['conflicts'] as List? ?? const [])
      .map((item) => item.toString())
      .toList();
  final diff = result['conflictDiff']?.toString() ?? '';
  final truncated = result['conflictDiffTruncated'] == true;

  return showDialog<void>(
    context: context,
    builder: (_) => Dialog(
      backgroundColor: const Color(0xFF070809),
      insetPadding: const EdgeInsets.all(12),
      child: SizedBox(
        width: 1000,
        height: 720,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 8, 10),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '合并冲突 · $sessionId',
                          style: const TextStyle(
                            color: Color(0xFFf2f4f7),
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 3),
                        Text(
                          '${conflicts.length} 个冲突文件 · 合并已 abort，基分支未改动'
                          '${truncated ? ' · Diff 已截断' : ''}',
                          style: const TextStyle(
                            color: Color(0xFF8a909b),
                            fontSize: 11,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close, color: Color(0xFF8a909b)),
                  ),
                ],
              ),
            ),
            Container(
              constraints: const BoxConstraints(maxHeight: 110),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              decoration: const BoxDecoration(
                color: Color(0xFF0f1115),
                border: Border.symmetric(
                  horizontal: BorderSide(color: Color(0xFF20242b)),
                ),
              ),
              child: SingleChildScrollView(
                child: SelectableText(
                  conflicts.isEmpty ? '(未获取到冲突文件)' : conflicts.join('\n'),
                  style: const TextStyle(
                    color: Color(0xFF8a909b),
                    fontFamily: 'monospace',
                    fontSize: 11,
                    height: 1.45,
                  ),
                ),
              ),
            ),
            Expanded(
              child: diff.trim().isEmpty
                  ? const Center(
                      child: Text(
                        '未获取到冲突 Diff',
                        style: TextStyle(color: Color(0xFF5b616c)),
                      ),
                    )
                  : SingleChildScrollView(
                      child: SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        child: SelectableText.rich(
                          TextSpan(children: _diffSpans(diff)),
                          style: const TextStyle(
                            color: Color(0xFFe7eaee),
                            fontFamily: 'monospace',
                            fontSize: 11,
                            height: 1.5,
                          ),
                        ),
                      ),
                    ),
            ),
          ],
        ),
      ),
    ),
  );
}

List<TextSpan> _diffSpans(String diff) {
  final conflictMarker = RegExp(r'^[+\- ]*(<<<<<<<|=======|>>>>>>>)');
  return diff.split('\n').map((line) {
    Color color = const Color(0xFFe7eaee);
    Color? background;
    FontWeight? weight;
    if (conflictMarker.hasMatch(line)) {
      color = const Color(0xFFe3b341);
      background = const Color(0x33d29922);
      weight = FontWeight.w600;
    } else if (line.startsWith('diff --') || line.startsWith('index ')) {
      color = const Color(0xFFd2a8ff);
    } else if (line.startsWith('@@')) {
      color = const Color(0xFF6aa3ff);
    } else if (line.startsWith('+')) {
      color = const Color(0xFF7ee787);
      background = const Color(0x332ea043);
    } else if (line.startsWith('-')) {
      color = const Color(0xFFffb3ae);
      background = const Color(0x33f85149);
    }
    return TextSpan(
      text: '$line\n',
      style: TextStyle(
        color: color,
        backgroundColor: background,
        fontWeight: weight,
      ),
    );
  }).toList();
}
