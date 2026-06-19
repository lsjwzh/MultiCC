import 'package:flutter/material.dart';

import '../services/session_service.dart';
import '../services/settings_service.dart';

/// Show the worktree diff for a session against its base branch. Works for any
/// session with changes (no conflict required) — mirrors the web "查看 Diff".
Future<void> showSessionDiffDialog(
  BuildContext context, {
  required SettingsService settings,
  required String sessionId,
}) {
  return showDialog<void>(
    context: context,
    builder: (_) => _SessionDiffDialog(settings: settings, sessionId: sessionId),
  );
}

class _SessionDiffDialog extends StatefulWidget {
  final SettingsService settings;
  final String sessionId;
  const _SessionDiffDialog({required this.settings, required this.sessionId});

  @override
  State<_SessionDiffDialog> createState() => _SessionDiffDialogState();
}

class _SessionDiffDialogState extends State<_SessionDiffDialog> {
  Map<String, dynamic>? _data;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final res = await SessionService(
        settings: widget.settings,
      ).fetchDiff(widget.sessionId);
      if (!mounted) return;
      if (res['ok'] == false) {
        setState(() {
          _error = res['error']?.toString() ?? '加载失败';
          _loading = false;
        });
      } else {
        setState(() {
          _data = res;
          _loading = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  String _subtitle() {
    final d = _data;
    if (d == null) return '加载中…';
    final parts = <String>[];
    final branch = d['branch']?.toString();
    final base = d['baseBranch']?.toString();
    if (branch != null && branch.isNotEmpty) {
      parts.add('$branch → ${base ?? ''}');
    }
    final ms = d['mergeState'];
    final ahead = ms is Map ? (ms['ahead'] as num?)?.toInt() ?? 0 : 0;
    parts.add('$ahead 个提交领先');
    if (ms is Map && ms['dirty'] == true) parts.add('含未提交改动');
    if (d['truncated'] == true) parts.add('已截断到 1MB');
    return parts.join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    final diff = _data?['diff']?.toString() ?? '';
    final stat = (_data?['stat']?.toString() ?? '').trim();
    return Dialog(
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
                          'Diff · ${widget.sessionId}',
                          style: const TextStyle(
                            color: Color(0xFFf2f4f7),
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 3),
                        Text(
                          _error != null ? '错误：$_error' : _subtitle(),
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
            if (stat.isNotEmpty)
              Container(
                constraints: const BoxConstraints(maxHeight: 110),
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                decoration: const BoxDecoration(
                  color: Color(0xFF0f1115),
                  border: Border.symmetric(
                    horizontal: BorderSide(color: Color(0xFF20242b)),
                  ),
                ),
                child: SingleChildScrollView(
                  child: SelectableText(
                    stat,
                    style: const TextStyle(
                      color: Color(0xFF8a909b),
                      fontFamily: 'monospace',
                      fontSize: 11,
                      height: 1.45,
                    ),
                  ),
                ),
              ),
            Expanded(child: _body(diff)),
          ],
        ),
      ),
    );
  }

  Widget _body(String diff) {
    if (_loading) {
      return const Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            '加载 Diff 失败：$_error',
            style: const TextStyle(color: Color(0xFFffb3ae)),
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    if (diff.trim().isEmpty) {
      return const Center(
        child: Text(
          '（无变更）',
          style: TextStyle(color: Color(0xFF5b616c)),
        ),
      );
    }
    return SingleChildScrollView(
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: SelectableText.rich(
          TextSpan(children: diffSpans(diff)),
          style: const TextStyle(
            color: Color(0xFFe7eaee),
            fontFamily: 'monospace',
            fontSize: 11,
            height: 1.5,
          ),
        ),
      ),
    );
  }
}

/// Color a unified-diff string line by line (shared with the conflict viewer's
/// scheme). Conflict markers, hunk headers, file headers, + / - lines.
List<TextSpan> diffSpans(String diff) {
  final conflictMarker = RegExp(r'^[+\- ]*(<<<<<<<|=======|>>>>>>>)');
  return diff.split('\n').map((line) {
    Color color = const Color(0xFFe7eaee);
    Color? background;
    FontWeight? weight;
    if (conflictMarker.hasMatch(line)) {
      color = const Color(0xFFe3b341);
      background = const Color(0x33d29922);
      weight = FontWeight.w600;
    } else if (line.startsWith('diff --') ||
        line.startsWith('index ') ||
        line.startsWith('new file') ||
        line.startsWith('deleted file') ||
        line.startsWith('rename ') ||
        line.startsWith('similarity ')) {
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
