import 'package:flutter/material.dart';

import '../models/message.dart';
import '../theme.dart';

/// 定时任务的执行记录（默认收起的一小块）。
///
/// 为什么要有它：卡片上原本只有一句「上次 … · 已运行 N 次」，回答不了用户真正要问的
/// 问题 —— 今天到底跑没跑、跑了几次、哪一次失败、失败原因是什么。服务端现在每次触发
/// 都记一条（`task.runs`，有界），这里就是那一份的展示面。
///
/// 默认收起而不是平铺：卡片的主体要留给「这条规则要干什么」，历史只在用户想查的时候
/// 才展开；但入口必须一眼可见 —— 「执行记录（最近 N 次）」本身就是那句「跑没跑」的
/// 最短答案。Air 的定时任务页和 App 的定时任务页共用这一块，避免两边各写一份再漂移。
class CronRunHistory extends StatefulWidget {
  const CronRunHistory({super.key, required this.task, this.visible = 8});

  final CronTask task;

  /// 展开后列多少条（服务端回放上限 10；多的部分用「共 N 次」交代，不再往下翻）。
  final int visible;

  @override
  State<CronRunHistory> createState() => _CronRunHistoryState();
}

class _CronRunHistoryState extends State<CronRunHistory> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final task = widget.task;
    final runs = task.runs;
    // 一条记录都没有（旧服务端，或这条规则刚建好还没跑过）就整块不渲染：这里存在的
    // 意义就是「到底跑没跑」，摆一个空壳只是占地方。
    if (runs.isEmpty) return const SizedBox.shrink();
    final shown = runs.length > widget.visible ? widget.visible : runs.length;
    return Container(
      decoration: BoxDecoration(
        color: AppColors.panel2,
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(AppColors.radiusChip),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            key: ValueKey('cron-runs-head-${task.id}'),
            onTap: () => setState(() => _open = !_open),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 7, 10, 7),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      _headline(task, runs.length),
                      style: const TextStyle(
                        color: AppColors.muted,
                        fontSize: 10.5,
                        height: 1.4,
                      ),
                    ),
                  ),
                  Icon(
                    _open
                        ? Icons.expand_less_rounded
                        : Icons.expand_more_rounded,
                    size: 16,
                    color: AppColors.faint,
                  ),
                ],
              ),
            ),
          ),
          if (_open)
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (var i = 0; i < shown; i++) _row(task, runs[i], i),
                  if (shown < runs.length)
                    Padding(
                      padding: const EdgeInsets.only(top: 3),
                      child: Text(
                        '只列最近 $shown 次',
                        style: const TextStyle(
                          color: AppColors.faint,
                          fontSize: 10,
                        ),
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  /// 「最近 N 次」是服务端回放的那几条，「共 M 次」是这条规则真正的触发总数 ——
  /// 两者不等时都得说，否则用户会把回放条数当成总次数。
  String _headline(CronTask task, int count) {
    final total = task.runCount > count ? ' / 共 ${task.runCount} 次' : '';
    return '执行记录（最近 $count 次$total）';
  }

  Widget _row(CronTask task, CronRun run, int index) => Padding(
    key: ValueKey('cron-run-${task.id}-$index'),
    padding: const EdgeInsets.symmetric(vertical: 1.5),
    child: Row(
      children: [
        SizedBox(
          width: 84,
          child: Text(
            cronRunTime(run.at),
            style: const TextStyle(color: AppColors.faint, fontSize: 10),
          ),
        ),
        SizedBox(
          width: 30,
          child: Text(
            run.source,
            style: const TextStyle(color: AppColors.faint, fontSize: 10),
          ),
        ),
        Expanded(
          child: Text(
            run.outcome,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: run.failed ? AppColors.danger : AppColors.muted,
              fontSize: 10,
            ),
          ),
        ),
      ],
    ),
  );
}

/// 一次触发发生在什么时候（本地时区，分钟精度够用）。0 / 缺失一律说「—」，
/// 不编一个 1970 出来 —— 与 airScheduleTime 同一条规矩。
String cronRunTime(int ms) {
  if (ms <= 0) return '—';
  final at = DateTime.fromMillisecondsSinceEpoch(ms);
  String two(int value) => value.toString().padLeft(2, '0');
  return '${at.month}/${at.day} ${two(at.hour)}:${two(at.minute)}';
}
