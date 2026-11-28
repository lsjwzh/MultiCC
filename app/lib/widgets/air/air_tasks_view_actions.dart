part of '../air_tasks_view.dart';

/// 机器壳里的「任务预检」（Goal）落点。
///
/// 预检配置存在**目标电脑**的服务端；原生设置页没有这一节，而入口的
/// [SettingsScreen] 带着「连接与服务地址」面板，一保存就会对机器作用域实例
/// 调 `save(host/token)` 抛 StateError。所以直接打开目标电脑的 Air goal 页。
/// 返回 false 表示不是机器作用域，调用方沿用原来的路由。
bool openMachineGoalPage(BuildContext context, SettingsService settings) {
  if (!settings.isMachineScoped) return false;
  unawaited(_openScopedPage(context, settings, '/air?view=goal'));
  return true;
}

/// 机器作用域下入口电脑设置页的替身：只碰目标电脑的配置。
Widget airScopedSettingsPage(SettingsService settings) =>
    settings.isMachineScoped
    ? MachineSettingsScreen(settings: settings)
    : SettingsScreen(settings: settings);

Future<void> _openScopedPage(
  BuildContext context,
  SettingsService settings,
  String path,
) async {
  final url = settings.machinePageUrl(path);
  if (url == null) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(t('airMachinesUnavailable'))),
      );
    }
    return;
  }
  final opened = await launchUrl(
    Uri.parse(url),
    mode: LaunchMode.externalApplication,
  );
  if (!opened && context.mounted) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(t('openBrowserFailed'))));
  }
}

/// 任务行上的手动动作（长按菜单 / 行内按钮）。
///
/// 动作体与搬出来之前逐字一致（乐观更新与失败回滚都在原处）。用 mixin 而不是
/// extension：`setState` 是 protected，只有真正继承 [State] 的子类才能调用；
/// `_data` / `_service` / `_refresh` 这些私有成员由下面的抽象声明接入宿主 State。
mixin _AirTasksViewActions on State<AirTasksView> {
  /// 宿主的 Air 快照（乐观更新在这里读写）。
  AirSnapshot? get _data;
  set _data(AirSnapshot? value);

  AirService get _service;

  Future<void> _refresh();

  bool _archivingInactive = false;

  Future<void> _archiveInactive() async {
    if (_archivingInactive) return;
    _archivingInactive = true;
    try {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(t('airArchiveInactive')),
          content: Text(t('airArchiveInactiveConfirm')),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(t('cancel'))),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(t('confirmArchive'))),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
      final result = await _service.archiveInactive();
      await _refresh();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(t('airArchiveInactiveResult', {'n': '${(result['archived'] as List).length}'}))),
        );
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(airTaskActionErrorMessage(error))),
        );
      }
    } finally {
      _archivingInactive = false;
    }
  }

  /// 长按 / 行内动作：按任务当前状态执行唯一动作（同控制台与目录页）。
  void _runTaskAction(AirTask task) {
    final action = airTaskPrimaryAction(task);
    unawaited(switch (action) {
      AirTaskAction.unignore ||
      AirTaskAction.ignoreError ||
      AirTaskAction.ignoreWaiting => _toggleIgnore(task),
      AirTaskAction.markAchieved => _markAchieved(task),
      AirTaskAction.markTodo || AirTaskAction.unmarkTodo => _toggleTodo(task),
    });
  }

  /// 忽略 / 取消忽略（乐观更新，失败回滚）。
  Future<bool> _toggleIgnore(AirTask task) async {
    final before = _data;
    if (before == null) return false;
    final ignore = !before.isTodoIgnored(task.id);
    final nextIgnored = ignore
        ? {...before.taskTodoIgnored, task.id}.toList()
        : before.taskTodoIgnored.where((id) => id != task.id).toList();
    setState(
      () => _data = before.withTodoLists(
        todos: before.taskTodos,
        ignored: nextIgnored,
      ),
    );
    final messenger = ScaffoldMessenger.of(context);
    try {
      final result = await _service.toggleTaskTodoIgnore(task.id);
      if (!mounted) return false;
      setState(
        () => _data = _data?.withTodoLists(
          todos: result.todos,
          ignored: result.taskIds,
        ),
      );
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(
              t(ignore ? 'airTodoIgnoredDone' : 'airTodoUnignoredDone'),
            ),
            duration: const Duration(seconds: 2),
          ),
        );
      return true;
    } catch (error) {
      if (!mounted) return false;
      setState(() => _data = before);
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(airTaskActionErrorMessage(error))),
        );
      return false;
    }
  }

  /// 标记达成（乐观更新 goalState，失败回滚）。
  Future<bool> _markAchieved(AirTask task) async {
    final before = _data;
    if (before == null) return false;
    setState(
      () => _data = before.withTask(task.copyWith(goalState: 'achieved')),
    );
    final messenger = ScaffoldMessenger.of(context);
    try {
      await _service.markTaskAchieved(task.id);
      if (!mounted) return false;
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(t('airTodoMarkAchievedDone')),
            duration: const Duration(seconds: 2),
          ),
        );
      return true;
    } catch (error) {
      if (!mounted) return false;
      setState(() => _data = before);
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(airTaskActionErrorMessage(error))),
        );
      return false;
    }
  }

  /// 标记 / 取消手动待办（见 [toggleAirTaskTodo]）。
  Future<bool> _toggleTodo(AirTask task) => toggleAirTaskTodo(
    context: context,
    service: _service,
    task: task,
    onChanged: _refresh,
  );
}

/// Terminal 模式里的一行终端会话（Web 的 `directory-terminal-row` 同款）：
/// 状态点 + 一行元信息 + 出问题时的提示，行尾重命名 / 复制 id / 重启 / 删除。
/// 三个事实都只翻译服务端折好的 state / lastActivityAt —— 客户端不自己推。
class _DirectoryTerminalRow extends StatelessWidget {
  const _DirectoryTerminalRow({
    required this.session,
    required this.onTap,
    required this.onRename,
    required this.onCopyId,
    required this.onRestart,
    required this.onDelete,
  });

  final AirSession session;
  final VoidCallback onTap;
  final VoidCallback onRename;
  final VoidCallback onCopyId;
  final VoidCallback onRestart;
  final VoidCallback onDelete;

  static const _stateLabelKey = {
    'running': 'airTerminalStateRunning',
    'stopped': 'airTerminalStateStopped',
    'route_dead': 'airTerminalStateRouteDead',
  };
  // running 不给提示行：一切正常的时候，多一行字只是噪音。
  static const _stateHintKey = {
    'stopped': 'airTerminalStoppedHint',
    'route_dead': 'airTerminalRouteDeadHint',
  };
  static const _stateColor = {
    'running': AppColors.success,
    'stopped': AppColors.muted,
    'route_dead': AppColors.danger,
  };

  String get _meta {
    final parts = <String>[session.cli];
    final stateKey = _stateLabelKey[session.state];
    if (stateKey != null) parts.add(t(stateKey));
    // 停了的终端 lastActivityAt 是 null，「多久没动」整段不出现 ——
    // 拿不到时刻还硬说「刚刚」，就是把一条死进程报成活的。
    final ago = formatRelativeTime(session.lastActivityAt);
    if (ago.isNotEmpty) parts.add(t('airTerminalLastOutput', {'ago': ago}));
    return parts.where((part) => part.isNotEmpty).join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    final hintKey = _stateHintKey[session.state];
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: AppColors.panel,
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(9),
      ),
      child: ListTile(
        key: ValueKey('air-terminal-${session.id}'),
        dense: true,
        onTap: onTap,
        title: Row(
          children: [
            Container(
              width: 8,
              height: 8,
              margin: const EdgeInsets.only(right: 7),
              decoration: BoxDecoration(
                // 老快照没有 state：灰点，也不编一个状态出来。
                color: _stateColor[session.state] ?? AppColors.faint,
                shape: BoxShape.circle,
              ),
            ),
            Expanded(
              child: Text(
                session.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 13.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              _meta,
              style: const TextStyle(color: AppColors.faint, fontSize: 11),
            ),
            if (hintKey != null)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  t(hintKey),
                  style: TextStyle(
                    color: session.state == 'route_dead'
                        ? AppColors.danger
                        : AppColors.warning,
                    fontSize: 11,
                  ),
                ),
              ),
          ],
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IconButton(
              key: ValueKey('air-terminal-rename-${session.id}'),
              onPressed: onRename,
              iconSize: 18,
              visualDensity: VisualDensity.compact,
              tooltip: t('airTerminalRenameAria', {'label': session.label}),
              icon: const Icon(Icons.edit_outlined),
              color: AppColors.muted,
            ),
            IconButton(
              key: ValueKey('air-terminal-copy-${session.id}'),
              onPressed: onCopyId,
              iconSize: 18,
              visualDensity: VisualDensity.compact,
              tooltip: t('airTerminalCopyIdAria', {'label': session.label}),
              icon: const Icon(Icons.copy_rounded),
              color: AppColors.muted,
            ),
            IconButton(
              key: ValueKey('air-terminal-restart-${session.id}'),
              onPressed: onRestart,
              iconSize: 18,
              visualDensity: VisualDensity.compact,
              tooltip: t('airTerminalRestartAria', {'label': session.label}),
              icon: const Icon(Icons.refresh_rounded),
              color: AppColors.muted,
            ),
            IconButton(
              key: ValueKey('air-terminal-delete-${session.id}'),
              onPressed: onDelete,
              iconSize: 18,
              visualDensity: VisualDensity.compact,
              tooltip: t('airDeleteTerminalAria', {'label': session.label}),
              icon: const Icon(Icons.delete_outline_rounded),
              color: AppColors.danger,
            ),
          ],
        ),
      ),
    );
  }
}
