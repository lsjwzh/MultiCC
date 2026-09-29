import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../../services/air_service.dart';
import '../../services/settings_service.dart';
import '../../theme.dart';
import 'air_panels.dart';
import 'air_task_config.dart';

/// 侧栏那颗「＋ 新任务」开的东西 —— Web 侧是 `public/air.html` 的
/// `#quick-task-dialog`。
///
/// 它自己**不带表单**。里面装的就是目录首页那一个统一输入框模块
/// （[AirQuickComposer]）：AI 配置（CLI / 线路 / 模型 / 推理强度）和角色都在那
/// 一套胶囊里，写完一段话就创建并执行。Web 那边更直白 —— 打开时把同一个 DOM
/// 节点 `#quick-task-form` 搬进弹窗，关掉再搬回 `#empty`；这里同理，是同一个
/// 组件的另一个实例，不是第二份实现。
///
/// [onSubmit] 交回宿主（`_createFromComposer`：建任务 → 绑角色 → 发第一条消息）。
/// 它返回真值这一层就收起来，返回假值就留着 —— 让用户改完接着点。
typedef AirNewTaskSubmit =
    Future<bool> Function({
      required String directoryId,
      required String text,
      required String cli,
      required AirTaskRuntime runtime,
      required List<AirRoleBinding> roles,
      required bool goal,
      int? goalRounds,
      int? goalBudget,
    });

/// Same preview/confirm/delete flow as Web Air. The server rechecks every task
/// at execution time; this dialog never sends `force`.
Future<void> showAirTaskRetentionDialog(
  BuildContext context, {
  required AirService service,
  required String directoryId,
  Future<void> Function()? onChanged,
}) async {
  Map<String, dynamic> preview;
  try {
    preview = await service.previewTaskRetention(directoryId);
  } catch (error) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$error')));
    }
    return;
  }
  if (!context.mounted) return;
  final tasks = ((preview['tasks'] as List?) ?? const [])
      .whereType<Map>()
      .map((task) => Map<String, dynamic>.from(task))
      .toList(growable: false);
  var busy = false;
  String? errorText;
  final result = await showDialog<Map<String, dynamic>>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (dialogContext, setDialogState) => AlertDialog(
        title: const Text('管理任务容量'),
        content: SizedBox(
          width: 460,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('此目录已有 ${preview['count']}/${preview['limit']} 个任务。'
                  '${tasks.isEmpty ? '当前没有可安全批量清理的任务，请在任务列表中手动检查并删除。' : '以下是最久未交互、已结束、未置顶且工作区干净并已合并的 ${tasks.length} 条任务；删除后不可恢复。'}'),
              if (tasks.isNotEmpty)
                Flexible(
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: tasks.length,
                    itemBuilder: (_, index) => ListTile(
                      dense: true,
                      title: Text('${tasks[index]['title'] ?? tasks[index]['id']}'),
                      subtitle: tasks[index]['lastInteractionAt'] is num
                          ? Text(DateTime.fromMillisecondsSinceEpoch(
                              (tasks[index]['lastInteractionAt'] as num).toInt()).toLocal().toString().split('.').first)
                          : null,
                    ),
                  ),
                ),
              if (errorText != null) Text(errorText!, style: const TextStyle(color: AppColors.danger)),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: busy ? null : () => Navigator.pop(dialogContext), child: const Text('关闭')),
          if (tasks.isNotEmpty)
            FilledButton(
              onPressed: busy ? null : () async {
                setDialogState(() => busy = true);
                try {
                  final outcome = await service.deleteTaskRetention(directoryId,
                      tasks.map((task) => '${task['id']}').toList());
                  if (dialogContext.mounted) Navigator.pop(dialogContext, outcome);
                } catch (error) {
                  setDialogState(() { busy = false; errorText = '$error'; });
                }
              },
              child: Text(busy ? '正在核验并删除…' : '确认删除列出的安全任务'),
            ),
        ],
      ),
    ),
  );
  if (result == null) return;
  await onChanged?.call();
  if (context.mounted) {
    final deleted = (result['deleted'] as List?)?.length ?? 0;
    final skipped = (result['skipped'] as List?)?.length ?? 0;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text('已删除 $deleted 条，跳过 $skipped 条。草稿已保留，可以重试新建。'),
    ));
  }
}

Future<void> showAirNewTaskSheet(
  BuildContext context, {
  required List<AirDirectory> directories,
  required String initialDirectoryId,
  required SettingsService settings,
  required List<String> clis,
  required AirNewTaskSubmit onSubmit,
  String? Function()? errorText,
  bool Function()? capacityExceeded,
  AirService? service,
  http.Client? httpClient,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.panel,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(
        top: Radius.circular(AppColors.radiusPanel),
      ),
    ),
    builder: (_) => _AirNewTaskSheet(
      directories: directories,
      initialDirectoryId: initialDirectoryId,
      settings: settings,
      clis: clis,
      onSubmit: onSubmit,
      errorText: errorText,
      capacityExceeded: capacityExceeded,
      service: service,
      httpClient: httpClient,
    ),
  );
}

class _AirNewTaskSheet extends StatefulWidget {
  const _AirNewTaskSheet({
    required this.directories,
    required this.initialDirectoryId,
    required this.settings,
    required this.clis,
    required this.onSubmit,
    required this.errorText,
    required this.capacityExceeded,
    required this.service,
    required this.httpClient,
  });

  final List<AirDirectory> directories;
  final String initialDirectoryId;
  final SettingsService settings;
  final List<String> clis;
  final AirNewTaskSubmit onSubmit;
  final String? Function()? errorText;
  final bool Function()? capacityExceeded;
  final AirService? service;
  final http.Client? httpClient;

  @override
  State<_AirNewTaskSheet> createState() => _AirNewTaskSheetState();
}

class _AirNewTaskSheetState extends State<_AirNewTaskSheet> {
  /// 这一层自己管「正在创建」。宿主的 `_submitting` 传不进来 —— 弹层是另一条
  /// 路由，那个 State `setState` 重建不到这里 —— 而输入框那颗按钮的文案
  /// （「正在创建…」）和禁用态看的就是这个值。
  bool _submitting = false;
  String _error = '';
  bool _capacityExceeded = false;
  late String _directoryId;

  @override
  void initState() {
    super.initState();
    _directoryId =
        widget.directories.any(
          (directory) => directory.id == widget.initialDirectoryId,
        )
        ? widget.initialDirectoryId
        : widget.directories.first.id;
  }

  Future<bool> _submit({
    required String text,
    required String cli,
    required AirTaskRuntime runtime,
    required List<AirRoleBinding> roles,
    required bool goal,
    int? goalRounds,
    int? goalBudget,
  }) async {
    setState(() => _submitting = true);
    final landed = await widget.onSubmit(
      directoryId: _directoryId,
      text: text,
      cli: cli,
      runtime: runtime,
      roles: roles,
      goal: goal,
      goalRounds: goalRounds,
      goalBudget: goalBudget,
    );
    if (!mounted) return landed;
    setState(() => _submitting = false);
    if (!landed) {
      setState(() {
        _error = widget.errorText?.call() ?? '创建失败，请重试。';
        _capacityExceeded = widget.capacityExceeded?.call() ?? false;
      });
    }
    // 人已经被带进那个任务了 —— 就地收掉，别压在聊天页上面。没成的话留着：
    // 草稿还在输入框里，重试就是原样再点一次。
    if (landed) Navigator.of(context).pop();
    return landed;
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      // 键盘弹起来时整层跟着抬上去 —— 不然写到后面几行就被盖住了（Web 那边
      // 弹窗居中，键盘顶上来同样会把下半张挡住）。
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Center(
                child: Container(
                  width: 38,
                  height: 4,
                  decoration: BoxDecoration(
                    color: AppColors.line,
                    borderRadius: BorderRadius.circular(AppColors.radiusPill),
                  ),
                ),
              ),
              const SizedBox(height: 10),
              _head(),
              _directoryPicker(),
              if (_error.isNotEmpty) Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_error, style: const TextStyle(color: AppColors.danger, fontSize: 12)),
              ),
              if (_capacityExceeded && widget.service != null)
                TextButton(
                  onPressed: () => showAirTaskRetentionDialog(context,
                    service: widget.service!, directoryId: _directoryId),
                  child: const Text('查看安全清理清单 / 自行管理任务'),
                ),
              const SizedBox(height: 12),
              AirQuickComposer(
                key: const ValueKey('air-new-task-composer'),
                settings: widget.settings,
                service: widget.service,
                httpClient: widget.httpClient,
                clis: widget.clis,
                busy: _submitting,
                autofocus: true,
                onSubmit: _submit,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _directoryPicker() {
    final selected = widget.directories.firstWhere(
      (directory) => directory.id == _directoryId,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DropdownButtonFormField<String>(
          key: const ValueKey('air-new-task-directory'),
          value: _directoryId,
          isExpanded: true,
          decoration: const InputDecoration(
            labelText: '工作目录',
            isDense: true,
            border: OutlineInputBorder(),
          ),
          dropdownColor: AppColors.panel,
          items: [
            for (final directory in widget.directories)
              DropdownMenuItem(
                value: directory.id,
                child: Text(
                  directory.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
          ],
          onChanged: _submitting
              ? null
              : (value) {
                  if (value != null) setState(() => _directoryId = value);
                },
        ),
        const SizedBox(height: 4),
        Text(
          selected.path,
          key: const ValueKey('air-new-task-directory-path'),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(color: AppColors.blue, fontSize: 11.5),
        ),
      ],
    );
  }

  Widget _head() => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'NEW TASK',
              style: TextStyle(
                color: AppColors.faint,
                fontSize: 10,
                letterSpacing: 0.8,
              ),
            ),
            SizedBox(height: 2),
            Text(
              '新任务',
              style: TextStyle(
                color: AppColors.text,
                fontSize: 16,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
      IconButton(
        key: const ValueKey('air-new-task-close'),
        onPressed: _submitting ? null : () => Navigator.of(context).pop(),
        iconSize: 20,
        tooltip: '关闭',
        icon: const Icon(Icons.close_rounded, color: AppColors.muted),
      ),
    ],
  );
}
