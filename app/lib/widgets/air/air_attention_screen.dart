import 'package:flutter/material.dart';

import '../../services/air_service.dart';
import '../../theme.dart';
import 'air_panels.dart';

/// 「谁在等我」的整页。
///
/// 控制台那一格只放最急的几条，完整清单在这里。对应 Web `public/air-admin.js`
/// 的 `renderAttention`（`?view=attention`）：同一份清单、同一个顺序、同一句总数。
///
/// 清单由调用方用 `airUrgentTasks` 取好再传进来 —— 和 Web 两边共用同一份
/// 「谁更急」的判定，所以控制台那一格和这一页不可能排成两个样子。
class AirAttentionScreen extends StatelessWidget {
  const AirAttentionScreen({
    super.key,
    required this.tasks,
    required this.directoryName,
    required this.onOpenTask,
  });

  /// 已经按紧急度排好的完整清单（`airUrgentTasks` 的返回值）。
  final List<AirTask> tasks;

  /// 跨目录的清单要把「它在哪个目录」写在行上。
  final String Function(String dirId) directoryName;

  /// 点开一条任务。这一页只是清单，点走之后由宿主持平后面那层控制台。
  final ValueChanged<AirTask> onOpenTask;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        backgroundColor: AppColors.panel,
        foregroundColor: AppColors.text,
        elevation: 0,
        scrolledUnderElevation: 0,
        title: const Text(
          '谁在等我',
          style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ),
      body: ListView(
        key: const ValueKey('air-attention'),
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
        children: [
          Container(
            decoration: BoxDecoration(
              color: AppColors.panel,
              borderRadius: BorderRadius.circular(AppColors.radiusPanel),
              border: Border.all(color: AppColors.line),
            ),
            padding: const EdgeInsets.fromLTRB(13, 12, 13, 13),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            'ACROSS ALL WORKSPACES',
                            style: TextStyle(
                              color: AppColors.faint,
                              fontSize: 9.5,
                              fontWeight: FontWeight.w700,
                              letterSpacing: 1.1,
                            ),
                          ),
                          SizedBox(height: 2),
                          Text(
                            '谁在等我',
                            style: TextStyle(
                              color: AppColors.text,
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.only(left: 8, top: 12),
                      child: Text(
                        tasks.isEmpty
                            ? '当前没有要处理的事'
                            : '${tasks.length} 条 · 按紧急度排序，点击直达',
                        style: const TextStyle(
                          color: AppColors.faint,
                          fontSize: 10.5,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                for (final task in tasks)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: AirTaskTile(
                      // 同一条任务在控制台那一格和这一页里各出现一次，两处各给
                      // 一份自己的标识，免得同一棵树里撞 key。
                      key: ValueKey('air-attention-task-${task.id}'),
                      task: task,
                      directoryName: directoryName(task.dirId),
                      showTime: true,
                      onTap: () => onOpenTask(task),
                    ),
                  ),
                if (tasks.isEmpty) const _Empty('没有正在等待或正在执行的任务。'),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 22),
    child: Text(
      text,
      textAlign: TextAlign.center,
      style: const TextStyle(color: AppColors.muted, fontSize: 12.5),
    ),
  );
}
