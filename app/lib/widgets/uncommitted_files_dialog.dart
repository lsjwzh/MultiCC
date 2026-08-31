import 'package:flutter/material.dart';

/// Lists a directory's uncommitted files with a "commit all" action.
///
/// Mirrors the web "⚠ 未提交文件" modal so dirty main-working-tree files can
/// be committed before they tangle a session worktree merge.
class UncommittedFilesDialog extends StatefulWidget {
  final String dirName;
  final String dirPath;
  final List<Map<String, dynamic>> files;
  final String? loadError;
  final Future<bool> Function() onCommit;

  const UncommittedFilesDialog({
    super.key,
    required this.dirName,
    required this.dirPath,
    required this.files,
    required this.onCommit,
    this.loadError,
  });

  @override
  State<UncommittedFilesDialog> createState() => _UncommittedFilesDialogState();
}

class _UncommittedFilesDialogState extends State<UncommittedFilesDialog> {
  bool _committing = false;

  @override
  Widget build(BuildContext context) {
    final hasError = widget.loadError != null && widget.files.isEmpty;
    return AlertDialog(
      backgroundColor: const Color(0xFF0f1115),
      title: Text(
        '⚠ ${widget.dirName} · 未提交文件',
        style: const TextStyle(color: Color(0xFFf2f4f7)),
      ),
      content: SizedBox(
        width: double.maxFinite,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.dirPath,
              style: const TextStyle(
                color: Color(0xFF8a909b),
                fontSize: 12,
                fontFamily: 'monospace',
              ),
            ),
            const SizedBox(height: 12),
            if (hasError)
              Text(
                '加载失败：${widget.loadError}',
                style: const TextStyle(color: Color(0xFFff6b63), fontSize: 13),
              )
            else if (widget.files.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(
                  child: Text(
                    '没有未提交文件 ✓',
                    style: TextStyle(color: Color(0xFF8a909b)),
                  ),
                ),
              )
            else
              Flexible(
                child: ListView.builder(
                  shrinkWrap: true,
                  itemCount: widget.files.length,
                  itemBuilder: (_, i) {
                    final file = widget.files[i];
                    final status = (file['status'] ?? '??').toString().trim();
                    final filePath = (file['path'] ?? '').toString();
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 2),
                      child: Row(
                        children: [
                          SizedBox(
                            width: 28,
                            child: Text(
                              status.isEmpty ? '??' : status,
                              style: const TextStyle(
                                color: Color(0xFF8a909b),
                                fontSize: 12,
                                fontFamily: 'monospace',
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              filePath,
                              style: const TextStyle(
                                color: Color(0xFFe7eaee),
                                fontSize: 13,
                                fontFamily: 'monospace',
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ],
                      ),
                    );
                  },
                ),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('关闭', style: TextStyle(color: Color(0xFF8a909b))),
        ),
        if (widget.files.isNotEmpty)
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFFE3B341),
              foregroundColor: const Color(0xFF0f1115),
            ),
            onPressed: _committing
                ? null
                : () async {
                    setState(() => _committing = true);
                    final close = await widget.onCommit();
                    if (!mounted) return;
                    setState(() => _committing = false);
                    if (close && context.mounted) Navigator.pop(context);
                  },
            child: Text(_committing ? '提交中…' : '全部提交'),
          ),
      ],
    );
  }
}
