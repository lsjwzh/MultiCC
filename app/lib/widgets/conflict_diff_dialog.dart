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
      backgroundColor: const Color(0xFFf4f8fd),
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
                            color: Color(0xFF20364d),
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
                            color: Color(0xFF6f8096),
                            fontSize: 11,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close, color: Color(0xFF6f8096)),
                  ),
                ],
              ),
            ),
            Container(
              constraints: const BoxConstraints(maxHeight: 110),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              decoration: const BoxDecoration(
                color: Color(0xFFffffff),
                border: Border.symmetric(
                  horizontal: BorderSide(color: Color(0xFFdce6f1)),
                ),
              ),
              child: SingleChildScrollView(
                child: SelectableText(
                  conflicts.isEmpty ? '(未获取到冲突文件)' : conflicts.join('\n'),
                  style: const TextStyle(
                    color: Color(0xFF6f8096),
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
                        style: TextStyle(color: Color(0xFF8a9aab)),
                      ),
                    )
                  : SingleChildScrollView(
                      child: SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        child: SelectableText.rich(
                          TextSpan(children: _diffSpans(diff)),
                          style: const TextStyle(
                            color: Color(0xFF233249),
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
    Color color = const Color(0xFF233249);
    Color? background;
    FontWeight? weight;
    if (conflictMarker.hasMatch(line)) {
      color = const Color(0xFFa85a25);
      background = const Color(0x33a85a25);
      weight = FontWeight.w600;
    } else if (line.startsWith('diff --') || line.startsWith('index ')) {
      color = const Color(0xFF6f42c1);
    } else if (line.startsWith('@@')) {
      color = const Color(0xFF1267b5);
    } else if (line.startsWith('+')) {
      color = const Color(0xFF22863a);
      background = const Color(0x332ba67a);
    } else if (line.startsWith('-')) {
      color = const Color(0xFFb64e43);
      background = const Color(0x33b64e43);
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
