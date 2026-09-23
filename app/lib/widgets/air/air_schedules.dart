import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../../models/message.dart';
import '../../services/air_service.dart';
import '../../services/manage_service.dart';
import '../../services/session_service.dart';
import '../../services/settings_service.dart';
import '../../theme.dart';
import '../cron_run_history.dart';
import 'air_task_status.dart';

/// 定时任务中心 —— Web `public/air.js` 的 `renderSchedules`（`#schedule-center`）。
///
/// 一条规则不是个孤零零的计时器：它背后固定挂着一个 Air 任务，到点是把指令送进
/// 那个任务里继续跑。所以这张卡上三样缺一不可 —— 什么时候跑、跑进哪个任务、
/// 上一次结果如何。删规则不删任务，也是因为这个分工。
class AirSchedulesScreen extends StatefulWidget {
  const AirSchedulesScreen({
    super.key,
    required this.settings,
    this.httpClient,
    this.directories = const <AirDirectory>[],
    this.initialDirectoryId,
    this.onOpenTask,
  });

  final SettingsService settings;

  /// 测试注入；生产留空走包级 http。
  final http.Client? httpClient;

  /// 新建 / 编辑规则时选目标目录。宿主手里已经有 `/api/air` 那份快照，直接带过
  /// 来就省一次 `/api/directories`；空的话编辑器自己拉一次。
  final List<AirDirectory> directories;

  /// 从某个工作目录进入定时任务中心时，新建规则默认选中它。用户仍可在编辑器里
  /// 改选其他目录；全局入口没有当前目录时留空，回退到第一项。
  final String? initialDirectoryId;

  /// 点「固定 Air 任务」→ 打开那条任务。固定任务的工作目录可以和当前目录不是
  /// 同一个，所以 dirId 和 taskId 一起带出去。
  final void Function(String dirId, String taskId)? onOpenTask;

  @override
  State<AirSchedulesScreen> createState() => _AirSchedulesScreenState();
}

// ── 卡片上的每一个字 ─────────────────────────────────────────────────────────

/// Web `scheduleTime`：`9/13 08:05`。没有时间就说不知道，不编一个 1970。
String airScheduleTime(int? ms) =>
    ms == null || ms <= 0 ? '—' : airTaskTime(ms);

/// Web `scheduleRuntime`：执行这条规则的是固定任务那套配置，规则自己只留 CLI。
String airScheduleRuntime(CronTask task) {
  final parts = [task.cli, task.provider, task.model, task.effort]
      .where((v) => v != null && v.isNotEmpty)
      .toList();
  return parts.isEmpty ? '跟随任务配置' : parts.join(' · ');
}

/// 上一次运行落在哪一步。`error` 之外的取值不编故事，就是「等待首次运行」。
String airScheduleStateLabel(CronTask task) => switch (task.lastStatus) {
  'queued' => '已进入固定任务队列',
  'ok' => '最近一次已接收',
  'error' => task.lastError.isEmpty ? '最近一次运行失败' : task.lastError,
  _ => '等待首次运行',
};

/// 需要我去处理的条数：跑挂了的，和绑定坏掉的（两条会重叠，只数一次）。
int airScheduleIssues(Iterable<CronTask> tasks) => tasks
    .where((t) => t.lastStatus == 'error' || t.taskBindingError.isNotEmpty)
    .length;

/// 摘要行第二句：没有问题就明说「固定任务均正常」，不写一个 0。
String airScheduleHealth(int issues) =>
    issues > 0 ? '$issues 条需处理' : '固定任务均正常';

String airScheduleFixedDetail(CronTask task) {
  if (task.taskBindingError.isNotEmpty) return task.taskBindingError;
  if (task.taskId == null || task.taskId!.isEmpty) return '正在建立任务绑定';
  return '${task.taskId} · ${airScheduleRuntime(task)}';
}

class _AirSchedulesScreenState extends State<AirSchedulesScreen> {
  late final ManageService _manage = ManageService(
    settings: widget.settings,
    httpClient: widget.httpClient,
  );

  List<CronTask> _tasks = const [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final tasks = await _manage.fetchCronTasks();
      if (!mounted) return;
      setState(() {
        _tasks = tasks;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '定时任务读取失败：$e';
        _loading = false;
      });
    }
  }

  void _notice(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _run(CronTask task) async {
    try {
      final result = await _manage.runCronTask(task.id);
      _notice(
        result['decision'] == 'queued'
            ? '固定任务正在忙碌，本次执行已经排队。'
            : '执行指令已经送入固定 Air 任务。',
      );
      await _load();
    } catch (e) {
      _notice('运行失败：$e');
    }
  }

  Future<void> _toggle(CronTask task) async {
    try {
      await _manage.updateCronTask(task.id, enabled: !task.enabled);
      await _load();
    } catch (e) {
      _notice('更新失败：$e');
    }
  }

  Future<void> _delete(CronTask task) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: AppColors.panel,
        title: const Text('删除定时规则'),
        content: const Text('删除这条定时规则？固定 Air 任务及其历史会继续保留。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消', style: TextStyle(color: AppColors.muted)),
          ),
          TextButton(
            key: const ValueKey('air-schedule-delete-confirm'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('删除', style: TextStyle(color: AppColors.danger)),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await _manage.deleteCronTask(task.id);
      await _load();
      _notice('定时规则已删除；固定 Air 任务和历史没有删除。');
    } catch (e) {
      _notice('删除失败：$e');
    }
  }

  Future<List<AirDirectory>> _directoryChoices() async {
    if (widget.directories.isNotEmpty) return widget.directories;
    try {
      final dirs = await SessionService(
        settings: widget.settings,
        httpClient: widget.httpClient,
      ).fetchDirectories();
      return [
        for (final dir in dirs)
          AirDirectory(id: dir.id, name: dir.name, path: dir.path),
      ];
    } catch (_) {
      return const [];
    }
  }

  Future<void> _openEditor({CronTask? task}) async {
    final choices = await _directoryChoices();
    if (!mounted) return;
    if (choices.isEmpty) {
      _notice('读不到工作目录，先在首页添加一个工作目录。');
      return;
    }
    final saved = await showDialog<bool>(
      context: context,
      builder: (_) => _ScheduleEditorDialog(
        manage: _manage,
        directories: choices,
        initialDirectoryId: widget.initialDirectoryId,
        task: task,
      ),
    );
    if (saved == true) {
      await _load();
      _notice(task == null ? '定时任务已创建，并绑定到唯一的 Air 任务。' : '定时规则已更新；固定任务和历史保持不变。');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const ValueKey('air-schedules'),
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        backgroundColor: AppColors.panel,
        foregroundColor: AppColors.text,
        elevation: 0,
        scrolledUnderElevation: 0,
        title: const Text('定时任务'),
        actions: [
          IconButton(
            key: const ValueKey('air-schedules-refresh'),
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh_rounded),
            color: AppColors.muted,
            tooltip: '刷新',
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        key: const ValueKey('air-schedules-new'),
        onPressed: _loading ? null : () => _openEditor(),
        backgroundColor: AppColors.accentDark,
        foregroundColor: AppColors.onAccent,
        icon: const Icon(Icons.add_rounded),
        // Web 上这句话挂在顶部工具栏（`#schedule-create`）上，手机上放到
        // 右手拇指够得着的地方 —— 字不变。
        label: const Text('新建定时任务'),
      ),
      body: _loading
          ? const Center(
              child: CircularProgressIndicator(color: AppColors.accent),
            )
          : RefreshIndicator(
              color: AppColors.accent,
              backgroundColor: AppColors.panel,
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(12, 12, 12, 96),
                children: [
                  if (_error != null)
                    _Notice(text: _error!, tone: AppColors.danger)
                  else
                    _Summary(tasks: _tasks),
                  const SizedBox(height: 10),
                  if (_error == null && _tasks.isEmpty)
                    const _EmptySchedule()
                  else
                    for (final task in _tasks) ...[
                      _ScheduleCard(
                        task: task,
                        onRun: () => _run(task),
                        onToggle: () => _toggle(task),
                        onEdit: () => _openEditor(task: task),
                        onDelete: () => _delete(task),
                        // 绑定还没建立时这一行是死的：没有可去的地方。绑定坏了
                        // 但任务还在，仍然点得进去（同 Web 的 disabled = !taskId）。
                        onOpenTask:
                            widget.onOpenTask == null ||
                                (task.taskId ?? '').isEmpty
                            ? null
                            : () => widget.onOpenTask!(
                                task.dirId,
                                task.taskId!,
                              ),
                      ),
                      const SizedBox(height: 10),
                    ],
                ],
              ),
            ),
    );
  }
}

/// 摘要行：几条规则、几条启用、几条要我去看。
class _Summary extends StatelessWidget {
  const _Summary({required this.tasks});

  final List<CronTask> tasks;

  @override
  Widget build(BuildContext context) {
    final enabled = tasks.where((t) => t.enabled).length;
    final issues = airScheduleIssues(tasks);
    return Container(
      key: const ValueKey('air-schedules-summary'),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(AppColors.radiusPanel),
        border: Border.all(color: AppColors.line),
      ),
      child: Wrap(
        spacing: 14,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          _SummaryItem('${tasks.length} 条规则'),
          _SummaryItem('$enabled 条启用'),
          _SummaryItem(
            airScheduleHealth(issues),
            tone: issues > 0 ? AppColors.warning : AppColors.success,
          ),
        ],
      ),
    );
  }
}

class _SummaryItem extends StatelessWidget {
  const _SummaryItem(this.text, {this.tone});

  final String text;
  final Color? tone;

  @override
  Widget build(BuildContext context) => Text(
    text,
    style: TextStyle(
      color: tone ?? AppColors.muted,
      fontSize: 12.5,
      fontWeight: tone == null ? FontWeight.w500 : FontWeight.w600,
    ),
  );
}

class _EmptySchedule extends StatelessWidget {
  const _EmptySchedule();

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 44),
    decoration: BoxDecoration(
      color: AppColors.panel,
      borderRadius: BorderRadius.circular(AppColors.radiusPanel),
      border: Border.all(color: AppColors.line),
    ),
    child: const Column(
      children: [
        Icon(Icons.alarm_off_rounded, size: 40, color: AppColors.faint),
        SizedBox(height: 14),
        Text(
          '还没有定时任务',
          style: TextStyle(
            color: AppColors.text,
            fontSize: 15,
            fontWeight: FontWeight.w600,
          ),
        ),
        SizedBox(height: 8),
        Text(
          '新建规则时会同时创建一个固定 Air 任务，后续运行都在该任务中继续。',
          textAlign: TextAlign.center,
          style: TextStyle(color: AppColors.faint, fontSize: 12.5, height: 1.6),
        ),
      ],
    ),
  );
}

class _Notice extends StatelessWidget {
  const _Notice({required this.text, required this.tone});

  final String text;
  final Color tone;

  @override
  Widget build(BuildContext context) => Container(
    key: const ValueKey('air-schedules-error'),
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color: AppColors.dangerSoft,
      borderRadius: BorderRadius.circular(AppColors.radiusPanel),
      border: Border.all(color: AppColors.line),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Icon(Icons.cloud_off_rounded, size: 18, color: AppColors.danger),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            style: TextStyle(color: tone, fontSize: 12.5, height: 1.6),
          ),
        ),
      ],
    ),
  );
}

// ── 一条规则 ─────────────────────────────────────────────────────────────────

class _ScheduleCard extends StatelessWidget {
  const _ScheduleCard({
    required this.task,
    required this.onRun,
    required this.onToggle,
    required this.onEdit,
    required this.onDelete,
    this.onOpenTask,
  });

  final CronTask task;
  final VoidCallback onRun;
  final VoidCallback onToggle;
  final VoidCallback onEdit;
  final VoidCallback onDelete;

  /// 没有固定任务（绑定还没建立）时这一行是死的 —— 没有可去的地方。
  final VoidCallback? onOpenTask;

  bool get _broken =>
      task.taskBindingError.isNotEmpty || (task.taskId ?? '').isEmpty;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: ValueKey('air-schedule-${task.id}'),
      padding: const EdgeInsets.fromLTRB(15, 14, 15, 12),
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(AppColors.radiusPanel),
        border: Border.all(color: AppColors.line),
        boxShadow: const [
          BoxShadow(
            color: Color(0x0a35577d),
            blurRadius: 18,
            offset: Offset(0, 6),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _head(),
          const SizedBox(height: 12),
          _timing(),
          const SizedBox(height: 12),
          _fixedTask(),
          const SizedBox(height: 10),
          _state(),
          if (task.runs.isNotEmpty) ...[
            const SizedBox(height: 8),
            CronRunHistory(task: task),
          ],
          const SizedBox(height: 10),
          Text(
            task.prompt,
            key: ValueKey('air-schedule-prompt-${task.id}'),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: AppColors.muted,
              fontSize: 11.5,
              height: 1.65,
            ),
          ),
          const SizedBox(height: 11),
          const Divider(height: 1, color: AppColors.line),
          const SizedBox(height: 6),
          _actions(),
        ],
      ),
    );
  }

  Widget _head() => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'SCHEDULE',
              style: TextStyle(
                color: AppColors.faint,
                fontSize: 9.5,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.1,
              ),
            ),
            const SizedBox(height: 3),
            Text(
              task.name,
              style: const TextStyle(
                color: AppColors.text,
                fontSize: 15,
                fontWeight: FontWeight.w700,
                height: 1.4,
              ),
            ),
          ],
        ),
      ),
      const SizedBox(width: 10),
      _Badge(enabled: task.enabled),
    ],
  );

  /// cron 表达式 + 下次运行 + 最近触发。Web 那边是三列网格，窄屏塌成两列、
  /// 表达式独占一行；手机上一行三段都放得下，就不拆了。
  Widget _timing() => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Expanded(
        flex: 11,
        child: Text(
          task.cron,
          key: ValueKey('air-schedule-cron-${task.id}'),
          style: const TextStyle(
            color: AppColors.blue,
            fontSize: 11,
            fontFamily: 'monospace',
            height: 1.4,
          ),
        ),
      ),
      const SizedBox(width: 8),
      Expanded(
        flex: 10,
        child: _TimingCell(
          label: '下次运行',
          value: task.enabled ? airScheduleTime(task.nextRunAt) : '已暂停',
        ),
      ),
      const SizedBox(width: 8),
      Expanded(
        flex: 10,
        child: _TimingCell(
          label: '最近触发',
          value: task.lastRunAt == null
              ? '尚未运行'
              : airScheduleTime(task.lastRunAt),
        ),
      ),
    ],
  );

  /// 固定任务：规则和任务的绑定，点进去就是那条任务。绑定坏了要看得出来 ——
  /// 坏在这里，规则再准也不会有人接。
  Widget _fixedTask() {
    final broken = _broken;
    final mark = Container(
      width: 30,
      height: 30,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: broken ? AppColors.danger : AppColors.accentDark,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Icon(
        broken ? Icons.priority_high_rounded : Icons.north_east_rounded,
        size: 16,
        color: AppColors.onAccent,
      ),
    );
    final copy = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text(
          '固定 Air 任务',
          style: TextStyle(color: AppColors.faint, fontSize: 9.5),
        ),
        const SizedBox(height: 2),
        Text(
          task.taskTitle.isEmpty ? task.name : task.taskTitle,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(
            color: AppColors.text,
            fontSize: 12.5,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          airScheduleFixedDetail(task),
          key: ValueKey('air-schedule-binding-${task.id}'),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: broken ? AppColors.danger : AppColors.muted,
            fontSize: 10.5,
          ),
        ),
      ],
    );
    final row = Row(
      children: [
        mark,
        const SizedBox(width: 11),
        Expanded(child: copy),
      ],
    );
    return Opacity(
      opacity: onOpenTask == null ? 0.65 : 1,
      child: Material(
        color: broken ? AppColors.dangerSoft : AppColors.blueSoft,
        borderRadius: BorderRadius.circular(AppColors.radiusChip + 2),
        child: InkWell(
          key: ValueKey('air-schedule-task-${task.id}'),
          onTap: onOpenTask,
          borderRadius: BorderRadius.circular(AppColors.radiusChip + 2),
          child: Container(
            padding: const EdgeInsets.fromLTRB(12, 11, 12, 11),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(AppColors.radiusChip + 2),
              border: Border.all(
                color: broken ? AppColors.danger : AppColors.line,
              ),
            ),
            child: row,
          ),
        ),
      ),
    );
  }

  Widget _state() {
    final failed = task.lastStatus == 'error';
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Text(
            airScheduleStateLabel(task),
            key: ValueKey('air-schedule-state-${task.id}'),
            style: TextStyle(
              color: failed ? AppColors.danger : AppColors.success,
              fontSize: 10.5,
              height: 1.5,
            ),
          ),
        ),
        const SizedBox(width: 10),
        Text(
          '${task.dirName} · 已触发 ${task.runCount} 次',
          style: const TextStyle(color: AppColors.faint, fontSize: 10.5),
        ),
      ],
    );
  }

  /// 四个动作。窄屏放不下一排就换行 —— Web 那边同样是 flex-wrap 到每行两个。
  Widget _actions() => Wrap(
    spacing: 6,
    runSpacing: 2,
    alignment: WrapAlignment.spaceBetween,
    children: [
      _ScheduleAction(
        actionKey: ValueKey('air-schedule-run-${task.id}'),
        label: '▶ 立即运行',
        tone: AppColors.accent,
        background: AppColors.blueSoft,
        onTap: onRun,
      ),
      _ScheduleAction(
        actionKey: ValueKey('air-schedule-toggle-${task.id}'),
        label: task.enabled ? '暂停' : '启用',
        onTap: onToggle,
      ),
      _ScheduleAction(
        actionKey: ValueKey('air-schedule-edit-${task.id}'),
        label: '编辑规则',
        onTap: onEdit,
      ),
      _ScheduleAction(
        actionKey: ValueKey('air-schedule-delete-${task.id}'),
        label: '删除规则',
        tone: AppColors.danger,
        onTap: onDelete,
      ),
    ],
  );
}

class _Badge extends StatelessWidget {
  const _Badge({required this.enabled});

  final bool enabled;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
    decoration: BoxDecoration(
      color: enabled ? const Color(0xFFe7f6ef) : const Color(0xFFedf1f5),
      borderRadius: BorderRadius.circular(7),
    ),
    child: Text(
      enabled ? '已启用' : '已停用',
      style: TextStyle(
        color: enabled ? const Color(0xFF247b5b) : AppColors.faint,
        fontSize: 9.5,
        fontWeight: FontWeight.w600,
      ),
    ),
  );
}

class _TimingCell extends StatelessWidget {
  const _TimingCell({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    mainAxisSize: MainAxisSize.min,
    children: [
      Text(
        label,
        style: const TextStyle(
          color: AppColors.faint,
          fontSize: 8.5,
          letterSpacing: 0.55,
        ),
      ),
      const SizedBox(height: 3),
      Text(
        value,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(
          color: AppColors.muted,
          fontSize: 11,
          fontWeight: FontWeight.w600,
        ),
      ),
    ],
  );
}

class _ScheduleAction extends StatelessWidget {
  const _ScheduleAction({
    required this.actionKey,
    required this.label,
    required this.onTap,
    this.tone,
    this.background,
  });

  final Key actionKey;
  final String label;
  final VoidCallback onTap;
  final Color? tone;
  final Color? background;

  @override
  Widget build(BuildContext context) => TextButton(
    key: actionKey,
    onPressed: onTap,
    style: TextButton.styleFrom(
      foregroundColor: tone ?? AppColors.muted,
      backgroundColor: background,
      minimumSize: const Size(0, 31),
      padding: const EdgeInsets.symmetric(horizontal: 8),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppColors.radiusChip),
      ),
      textStyle: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
    ),
    child: Text(label),
  );
}

// ── 编辑器 ───────────────────────────────────────────────────────────────────

/// 新建 / 编辑一条规则（Web `#schedule-dialog`）。
///
/// 已经绑上固定任务的规则不许改工作目录和 CLI —— 那两样已经归任务所有了，硬改
/// 只会让规则和历史分家。服务端也是这么拦的（PATCH 返回 409）。
class _ScheduleEditorDialog extends StatefulWidget {
  const _ScheduleEditorDialog({
    required this.manage,
    required this.directories,
    this.initialDirectoryId,
    this.task,
  });

  final ManageService manage;
  final List<AirDirectory> directories;
  final String? initialDirectoryId;
  final CronTask? task;

  @override
  State<_ScheduleEditorDialog> createState() => _ScheduleEditorDialogState();
}

class _ScheduleEditorDialogState extends State<_ScheduleEditorDialog> {
  static const List<String> _clis = [
    'claude',
    'codex',
    'opencode',
    'zcode',
    'qoder',
  ];

  static const List<(String, String)> _presets = [
    ('0 9 * * *', '每天 09:00'),
    ('0 * * * *', '每小时'),
    ('*/30 * * * *', '每 30 分钟'),
    ('0 9 * * 1', '每周一 09:00'),
  ];

  late final TextEditingController _name = TextEditingController(
    text: widget.task?.name ?? '',
  );
  late final TextEditingController _cron = TextEditingController(
    text: widget.task?.cron ?? '0 9 * * *',
  );
  late final TextEditingController _prompt = TextEditingController(
    text: widget.task?.prompt ?? '',
  );
  late String _dirId;
  late String _cli;
  late bool _enabled;
  bool _saving = false;
  String _error = '';

  bool get _bound => (widget.task?.taskId ?? '').isNotEmpty;

  @override
  void initState() {
    super.initState();
    _cli = widget.task?.cli ?? 'claude';
    _enabled = widget.task?.enabled ?? true;
    final ids = widget.directories.map((d) => d.id).toSet();
    final wanted = widget.task?.dirId ?? widget.initialDirectoryId;
    _dirId = wanted != null && ids.contains(wanted)
        ? wanted
        : widget.directories.first.id;
  }

  @override
  void dispose() {
    _name.dispose();
    _cron.dispose();
    _prompt.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final cron = _cron.text.trim();
    final prompt = _prompt.text.trim();
    if (name.isEmpty) return setState(() => _error = '任务名不能为空');
    if (prompt.isEmpty) return setState(() => _error = '执行指令不能为空');
    if (cron.split(RegExp(r'\s+')).where((s) => s.isNotEmpty).length != 5) {
      return setState(() => _error = 'cron 表达式无效（需 5 段：分 时 日 月 周）');
    }
    setState(() {
      _saving = true;
      _error = '';
    });
    try {
      final current = widget.task;
      if (current == null) {
        await widget.manage.createCronTask(
          name: name,
          dirId: _dirId,
          prompt: prompt,
          cron: cron,
          cli: _cli,
          enabled: _enabled,
        );
      } else {
        // 绑定过的规则只改它还拥有的那几样。
        await widget.manage.updateCronTask(
          current.id,
          name: name,
          prompt: prompt,
          cron: cron,
          enabled: _enabled,
          dirId: _bound ? null : _dirId,
          cli: _bound ? null : _cli,
        );
      }
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _saving = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final editing = widget.task != null;
    return Dialog(
      key: const ValueKey('air-schedule-editor'),
      backgroundColor: AppColors.bg,
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 28),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppColors.radiusPanel),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 16, 8, 0),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'SCHEDULED AIR TASK',
                          style: TextStyle(
                            color: AppColors.faint,
                            fontSize: 9.5,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 1.1,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          editing ? '编辑定时规则' : '新建定时任务',
                          key: const ValueKey('air-schedule-editor-title'),
                          style: const TextStyle(
                            color: AppColors.text,
                            fontSize: 17,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    key: const ValueKey('air-schedule-editor-close'),
                    onPressed: _saving
                        ? null
                        : () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close_rounded, size: 20),
                    color: AppColors.muted,
                    tooltip: '关闭',
                  ),
                ],
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.fromLTRB(18, 12, 18, 4),
                children: [
                  const Text(
                    '创建后会生成一个固定 Air 任务。Provider、模型、推理强度和角色都在该任务中继续配置。',
                    style: TextStyle(
                      color: AppColors.muted,
                      fontSize: 12.5,
                      height: 1.6,
                    ),
                  ),
                  const SizedBox(height: 14),
                  _Field(
                    label: '任务名称',
                    child: _input(
                      _name,
                      fieldKey: 'air-schedule-name',
                      hint: '例如：每日投放数据',
                    ),
                  ),
                  _Field(
                    label: '工作目录',
                    child: _dropdown<String>(
                      fieldKey: 'air-schedule-dir',
                      value: _dirId,
                      // 目录归属固定任务：绑定之后要改得去任务里改。
                      enabled: !_bound,
                      items: [
                        for (final dir in widget.directories)
                          (dir.id, dir.name),
                      ],
                      onChanged: (v) => setState(() => _dirId = v),
                    ),
                  ),
                  _Field(
                    label: '初始 CLI',
                    child: _dropdown<String>(
                      fieldKey: 'air-schedule-cli',
                      value: _cli,
                      enabled: !_bound,
                      items: [for (final cli in _clis) (cli, cli)],
                      onChanged: (v) => setState(() => _cli = v),
                    ),
                  ),
                  if (_bound)
                    Container(
                      key: const ValueKey('air-schedule-fixed-note'),
                      margin: const EdgeInsets.only(bottom: 12),
                      padding: const EdgeInsets.all(11),
                      decoration: BoxDecoration(
                        color: AppColors.blueSoft,
                        borderRadius: BorderRadius.circular(
                          AppColors.radiusChip,
                        ),
                      ),
                      child: const Text(
                        '工作目录和执行配置已经归属于固定任务。如需调整 CLI / Provider，请打开固定任务后修改 AI 配置。',
                        style: TextStyle(
                          color: AppColors.blue,
                          fontSize: 11.5,
                          height: 1.6,
                        ),
                      ),
                    ),
                  _Field(
                    label: 'Cron 表达式',
                    child: _input(
                      _cron,
                      fieldKey: 'air-schedule-cron',
                      hint: '分 时 日 月 周',
                      mono: true,
                    ),
                  ),
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [
                      for (final (expression, label) in _presets)
                        ActionChip(
                          key: ValueKey('air-schedule-preset-$expression'),
                          label: Text(
                            label,
                            style: const TextStyle(fontSize: 11),
                          ),
                          backgroundColor: AppColors.panel,
                          side: const BorderSide(color: AppColors.line),
                          labelStyle: const TextStyle(color: AppColors.muted),
                          onPressed: () =>
                              setState(() => _cron.text = expression),
                        ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  _Field(
                    label: '执行指令',
                    child: _input(
                      _prompt,
                      fieldKey: 'air-schedule-prompt',
                      hint: '每次触发时发送到固定任务的完整指令',
                      maxLines: 5,
                    ),
                  ),
                  InkWell(
                    key: const ValueKey('air-schedule-enabled'),
                    onTap: () => setState(() => _enabled = !_enabled),
                    borderRadius: BorderRadius.circular(AppColors.radiusChip),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Row(
                        children: [
                          Checkbox(
                            value: _enabled,
                            onChanged: (v) =>
                                setState(() => _enabled = v ?? _enabled),
                            activeColor: AppColors.accentDark,
                          ),
                          Text(
                            editing ? '保持启用' : '创建后立即启用',
                            style: const TextStyle(
                              color: AppColors.text,
                              fontSize: 13,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  if (_error.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        _error,
                        key: const ValueKey('air-schedule-editor-error'),
                        style: const TextStyle(
                          color: AppColors.danger,
                          fontSize: 12,
                        ),
                      ),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 6, 18, 16),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    key: const ValueKey('air-schedule-cancel'),
                    onPressed: _saving
                        ? null
                        : () => Navigator.of(context).pop(),
                    child: const Text('取消'),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    key: const ValueKey('air-schedule-save'),
                    onPressed: _saving ? null : _save,
                    style: FilledButton.styleFrom(
                      backgroundColor: AppColors.accentDark,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(
                          AppColors.radiusButton,
                        ),
                      ),
                    ),
                    child: Text(
                      _saving
                          ? '正在保存…'
                          : (editing ? '保存规则' : '创建并绑定任务'),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _input(
    TextEditingController controller, {
    required String fieldKey,
    String? hint,
    int maxLines = 1,
    bool mono = false,
  }) => TextField(
    key: ValueKey(fieldKey),
    controller: controller,
    maxLines: maxLines,
    style: TextStyle(
      color: AppColors.text,
      fontSize: 14,
      fontFamily: mono ? 'monospace' : null,
    ),
    decoration: InputDecoration(
      hintText: hint,
      hintStyle: const TextStyle(color: AppColors.faint, fontSize: 13),
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
    ),
  );

  Widget _dropdown<T>({
    required String fieldKey,
    required T value,
    required List<(T, String)> items,
    required ValueChanged<T> onChanged,
    bool enabled = true,
  }) => DropdownButtonFormField<T>(
    key: ValueKey(fieldKey),
    value: value,
    isExpanded: true,
    decoration: const InputDecoration(isDense: true),
    items: [
      for (final (itemValue, label) in items)
        DropdownMenuItem<T>(value: itemValue, child: Text(label)),
    ],
    onChanged: enabled
        ? (next) {
            if (next != null) onChanged(next);
          }
        : null,
  );
}

class _Field extends StatelessWidget {
  const _Field({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            color: AppColors.muted,
            fontSize: 12,
            fontWeight: FontWeight.w500,
          ),
        ),
        const SizedBox(height: 6),
        child,
      ],
    ),
  );
}
