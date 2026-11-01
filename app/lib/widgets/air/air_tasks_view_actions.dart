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
