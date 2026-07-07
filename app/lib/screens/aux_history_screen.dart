import 'package:flutter/material.dart';

import '../services/manage_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

/// AI 助手 (aux) 任务历史。镜像网页管理台的 aux-history 弹窗：拉取
/// /api/aux/history，把相邻的 user/assistant 配对成一条任务（输入/输出），
/// 倒序展示，点开看完整输入输出。下拉刷新重新拉取。
///
/// aux 跑在侧信道：每个会话的 goal/phase 判定、goal 预检、重跑所有会话等
/// 都经它执行；这里展示的就是这些任务的输入与结果（成功/失败/取消）。
class AuxHistoryScreen extends StatefulWidget {
  final SettingsService settings;
  const AuxHistoryScreen({super.key, required this.settings});

  @override
  State<AuxHistoryScreen> createState() => _AuxHistoryScreenState();
}

class _AuxHistoryScreenState extends State<AuxHistoryScreen> {
  late final ManageService _manage = ManageService(settings: widget.settings);
  List<Map<String, dynamic>> _raw = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final h = await _manage.fetchAuxHistory(limit: 50);
      if (!mounted) return;
      setState(() {
        _raw = h;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  // Pair adjacent user→assistant messages into tasks (mirrors web renderAuxModal).
  // A lone user with no following assistant is a still-pending task.
  List<_AuxTask> _pairTasks() {
    final tasks = <_AuxTask>[];
    for (var i = 0; i < _raw.length; i++) {
      final m = _raw[i];
      final role = m['role']?.toString() ?? '';
      if (role == 'user') {
        final next = (i + 1 < _raw.length) ? _raw[i + 1] : null;
        if (next != null && (next['role']?.toString() == 'assistant')) {
          tasks.add(_AuxTask(input: m, output: next));
          i++;
        } else {
          tasks.add(_AuxTask(input: m, output: null));
        }
      }
    }
    // newest first
    return tasks.reversed.toList();
  }

  @override
  Widget build(BuildContext context) {
    final tasks = _pairTasks();
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        title: const Text('AI 助手 · 任务历史'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded, color: AppColors.muted),
            onPressed: _loading ? null : _refresh,
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppColors.accent))
          : _error != null
              ? _ErrorView(message: _error!, onRetry: _refresh)
              : tasks.isEmpty
                  ? const Center(
                      child: Padding(
                        padding: EdgeInsets.all(32),
                        child: Text('暂无任务记录',
                            style: TextStyle(color: AppColors.faint, fontSize: 14)),
                      ),
                    )
                  : RefreshIndicator(
                      color: AppColors.accent,
                      backgroundColor: AppColors.panel,
                      onRefresh: _refresh,
                      child: ListView.separated(
                        padding: const EdgeInsets.fromLTRB(12, 12, 12, 32),
                        itemCount: tasks.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 10),
                        itemBuilder: (_, i) => _AuxTaskCard(task: tasks[i]),
                      ),
                    ),
    );
  }
}

class _AuxTask {
  final Map<String, dynamic> input;
  final Map<String, dynamic>? output;
  _AuxTask({required this.input, this.output});
}

class _AuxTaskCard extends StatefulWidget {
  final _AuxTask task;
  const _AuxTaskCard({required this.task});

  @override
  State<_AuxTaskCard> createState() => _AuxTaskCardState();
}

class _AuxTaskCardState extends State<_AuxTaskCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final t = widget.task;
    final inContent = (t.input['content']?.toString() ?? '').trim();
    final taskType = t.input['taskType']?.toString() ?? 'unknown';
    final ts = (t.input['ts'] as num?)?.toInt();
    final meta = (t.input['meta'] as Map?)?.cast<String, dynamic>();
    final metaStr = meta?['sessionName']?.toString() ?? '';

    // output result line — green/cyan success, amber cancelled, red error.
    final out = t.output;
    final Color resultColor;
    final String resultLabel;
    if (out == null) {
      resultColor = AppColors.amber;
      resultLabel = 'pending…';
    } else if (out['error'] != null) {
      resultColor = AppColors.danger;
      resultLabel = 'ERR';
    } else if (out['cancelled'] == true) {
      resultColor = AppColors.amber;
      resultLabel = 'CANCELLED';
    } else {
      resultColor = const Color(0xFF56d364);
      resultLabel = (out['content']?.toString() ?? '').trim();
    }
    final durationMs = (out?['durationMs'] as num?)?.toInt();

    final timeStr = ts == null
        ? ''
        : DateTime.fromMillisecondsSinceEpoch(ts).toLocal().toString().substring(5, 19);

    return Container(
      decoration: BoxDecoration(
        color: AppColors.panel,
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            borderRadius: const BorderRadius.vertical(top: Radius.circular(12)),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
              child: Row(
                children: [
                  Icon(_expanded ? Icons.expand_less : Icons.expand_more,
                      size: 20, color: AppColors.muted),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                              decoration: BoxDecoration(
                                color: AppColors.panel2,
                                borderRadius: BorderRadius.circular(4),
                                border: Border.all(color: AppColors.line),
                              ),
                              child: Text(taskType,
                                  style: const TextStyle(
                                      color: AppColors.muted, fontSize: 10, fontFamily: 'monospace')),
                            ),
                            if (metaStr.isNotEmpty) ...[
                              const SizedBox(width: 6),
                              Text(metaStr,
                                  style: const TextStyle(color: AppColors.faint, fontSize: 10),
                                  overflow: TextOverflow.ellipsis),
                            ],
                            if (timeStr.isNotEmpty) ...[
                              const SizedBox(width: 6),
                              Text(timeStr,
                                  style: const TextStyle(color: AppColors.faint, fontSize: 10)),
                            ],
                          ],
                        ),
                        const SizedBox(height: 4),
                        // prompt preview — last line of input, capped
                        Text(
                          inContent.isEmpty ? '(空)' : inContent.split('\n').last,
                          style: const TextStyle(color: AppColors.text, fontSize: 12.5),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          const Divider(height: 1, color: AppColors.line),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.subdirectory_arrow_right, size: 14, color: AppColors.faint),
                const SizedBox(width: 4),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(resultLabel,
                          style: TextStyle(color: resultColor, fontSize: 12.5, fontWeight: FontWeight.w600),
                          maxLines: _expanded ? null : 2,
                          overflow: _expanded ? TextOverflow.visible : TextOverflow.ellipsis),
                      if (durationMs != null && durationMs > 0)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text('${(durationMs / 1000).toStringAsFixed(1)}s',
                              style: const TextStyle(color: AppColors.faint, fontSize: 10)),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          if (_expanded && inContent.isNotEmpty)
            Container(
              width: double.infinity,
              margin: const EdgeInsets.fromLTRB(12, 0, 12, 10),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.panel2,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AppColors.line),
              ),
              child: SelectableText(inContent,
                  style: const TextStyle(
                      color: AppColors.muted, fontSize: 11.5, fontFamily: 'monospace', height: 1.4)),
            ),
        ],
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const _ErrorView({required this.message, required this.onRetry});
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.cloud_off_rounded, size: 42, color: AppColors.faint),
              const SizedBox(height: 14),
              Text('加载失败\n$message',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: AppColors.muted, fontSize: 13, height: 1.5)),
              const SizedBox(height: 16),
              OutlinedButton(
                onPressed: onRetry,
                style: OutlinedButton.styleFrom(side: const BorderSide(color: AppColors.lineStrong)),
                child: const Text('重试', style: TextStyle(color: AppColors.accent)),
              ),
            ],
          ),
        ),
      );
}
