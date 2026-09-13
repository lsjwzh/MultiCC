import 'dart:async';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../providers/session_manager.dart';
import '../screens/docs_registry_screen.dart';
import '../screens/settings_screen.dart';
import '../services/air_service.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';
import 'air/air_console.dart';
import 'air/air_destinations.dart';
import 'air/air_panels.dart';
import 'air/air_schedules.dart';
import 'air/air_sidebar.dart';
import 'air/air_task_config.dart';
import 'air/air_task_details.dart';
import 'air/air_task_status.dart';
import 'task_board_view.dart';
import 'workspace_navigation_drawer.dart';

/// Air 的移动端首页：目录优先，任务是行，对话开在自己的聊天页里。
///
/// 这一层是 Web `public/air.html` 的壳：左侧边栏（[AirSidebar]）、任务头部
/// （☰ / 面包屑 / 标题 / 状态 / ⋯）和两块主区 —— 目录库（[AirDirectoryLibrary]）
/// 与当前目录（统计 + 最近任务 + 快捷创建 `AirQuickComposer`）。数据仍走同一个
/// `/api/air`，不引入第二套目录/任务模型。
class AirTasksView extends StatefulWidget {
  final SettingsService settings;
  final http.Client? httpClient;

  /// 「更多与系统」里那些已经有原生页面的入口（定时任务、服务与文档…）交给宿主
  /// 决定怎么开——Air 只负责列出来。
  final ValueChanged<WorkspaceDestination>? onOpenDestination;

  /// 机器级语音通话。原生独占：麦克风要 HTTPS，Web 侧没有这一页，所以由宿主
  /// 提供；宿主不提供时侧栏就不显示这一行。
  final VoidCallback? onOpenVoiceCall;

  const AirTasksView({
    super.key,
    required this.settings,
    this.httpClient,
    this.onOpenDestination,
    this.onOpenVoiceCall,
  });

  @override
  State<AirTasksView> createState() => _AirTasksViewState();
}

enum _AirMode { tasks, library }

class _AirTasksViewState extends State<AirTasksView>
    with WidgetsBindingObserver {
  late final AirService _service = AirService(
    settings: widget.settings,
    httpClient: widget.httpClient,
  );
  final _scaffoldKey = GlobalKey<ScaffoldState>();
  AirLocalStore? _store;
  AirSnapshot? _data;
  AirCreateAttempt? _attempt;
  String? _directoryId;
  String _error = '';
  bool _loading = false, _opening = false, _submitting = false, _foreground = true;
  bool _showAll = false;
  _AirMode _mode = _AirMode.tasks;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_loadStore());
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 4), (_) {
      if (_foreground) _refresh();
    });
    widget.settings.advancedMode.addListener(_onAdvancedModeChanged);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (_foreground) _refresh();
  }

  void _onAdvancedModeChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _timer?.cancel();
    widget.settings.advancedMode.removeListener(_onAdvancedModeChanged);
    _service.close();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _loadStore() async {
    final store = await AirLocalStore.load();
    if (!mounted) return;
    setState(() => _store = store);
  }

  Future<void> _refresh() async {
    if (_loading) return;
    _loading = true;
    try {
      final result = await _service.load();
      if (!mounted) return;
      setState(() {
        _data = result;
        _error = '';
        if (result.directoryOf(_directoryId) == null) {
          _directoryId = result.directories.isEmpty
              ? null
              : result.directories.first.id;
        }
      });
      // 收藏和最近记录指向的目录/任务可能已经被删掉，顺手清一遍，免得侧栏留着
      // 一个点不开的名字。
      await _store?.prune(
        directoryIds: result.directories.map((d) => d.id).toSet(),
        taskIds: result.tasks.map((t) => t.id).toSet(),
      );
      if (mounted) setState(() {});
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      _loading = false;
    }
  }

  /// 侧栏里的每一次点击都要先把抽屉收回去。这里不能用 `Navigator.pop`：抽屉不是
  /// 一条路由，首页又是栈底那一条，`canPop()` 会直接说「没得弹」。
  void _closeDrawer() => _scaffoldKey.currentState?.closeDrawer();

  void _selectDirectory(String dirId) {
    _closeDrawer();
    setState(() {
      _directoryId = dirId;
      _mode = _AirMode.tasks;
    });
  }

  Future<void> _toggleFavorite([String? dirId]) async {
    final target = dirId ?? _directoryId;
    final store = _store;
    if (target == null || store == null) return;
    await store.toggleFavorite(target);
    if (mounted) setState(() {});
  }

  /// 打开一个任务：先换出可续接的会话，再交给现有的聊天页。只读记录不能在这里
  /// 接管，只能回到它原来的会话。
  Future<void> _open(AirTask task) async {
    if (_opening) return;
    _opening = true;
    try {
      final entry = await _service.openTask(task.id);
      if (!mounted) return;
      final id =
          (entry['readOnly'] == true ? entry['sourceSessionId'] : entry['sessionId'])
              as String?;
      if (id == null) throw Exception('此任务没有可续接的会话，请从全部记录查看。');
      final mgr = context.read<SessionManager>();
      final loaded = mgr.sessions.where((s) => s.id == id).firstOrNull;
      final session =
          loaded ??
          await SessionService(settings: widget.settings)
              .fetchTaskBoundSession(id);
      if (!mounted) return;
      if (session == null) throw Exception('无法打开任务会话，请刷新后重试。');
      await _store?.rememberTask(task.id);
      mgr.openSession(session, historyArchive: true);
      mgr.switchToSession(session.id);
      if (mounted) setState(() {});
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      _opening = false;
    }
  }

  /// 任务详情：Web Air 是右侧那一栏，手机上没有地方并排放，所以做成从下方升起
  /// 的一层。它自己拉 `/api/air/tasks/:id`，「进入对话」把这一层换成聊天页。
  Future<void> _openDetails(AirTask task) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.bg,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(AppColors.radiusPanel),
        ),
      ),
      builder: (sheetContext) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.82,
        maxChildSize: 0.94,
        minChildSize: 0.4,
        builder: (context, controller) => Column(
          children: [
            const SizedBox(height: 8),
            Container(
              width: 38,
              height: 4,
              decoration: BoxDecoration(
                color: AppColors.line,
                borderRadius: BorderRadius.circular(AppColors.radiusPill),
              ),
            ),
            Expanded(
              child: AirTaskDetailsPanel(
                taskId: task.id,
                service: _service,
                onOpenConversation: () {
                  Navigator.pop(sheetContext);
                  unawaited(_open(task));
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 描述一段话就建一个任务，并把这段话作为第一条消息发出去。三步的顺序不能
  /// 换：角色绑定只对下一条消息生效，而下一条消息正是这一条（同 Web Air）。
  /// 返回是否**整条链路都成了**：任务建出来不算，第一条消息也得确认送达 ——
  /// 只有全成才算这一份草稿已经交出去，输入区那边才可以清空重来。
  Future<bool> _createFromComposer({
    required String text,
    required String cli,
    required AirTaskRuntime runtime,
    required List<AirRoleBinding> roles,
    required bool goal,
  }) async {
    final dirId = _directoryId;
    if (dirId == null || _submitting) return false;
    final title = text
        .split(RegExp(r'\n'))
        .firstWhere((line) => line.trim().isNotEmpty, orElse: () => text)
        .trim();
    // 指纹要把线路也包进来：同一次重试（内容一模一样）沿用旧的幂等键，换了
    // 线路或角色再点就是另一次创建（同 Web Air 的 fingerprint）。
    _attempt = AirCreateAttempt.forFingerprint(
      '$dirId|$text|$cli|${runtime.summary}|'
      '${roles.map((r) => '${r.name}:${r.prompt}').join(',')}|$goal',
      _attempt,
    );
    final attempt = _attempt!;
    setState(() {
      _submitting = true;
      _error = '';
    });
    String? created;
    try {
      created = await _service.createTask(
        dirId: dirId,
        title: title.length > 120 ? title.substring(0, 120) : title,
        clientMsgId: attempt.createId,
        cli: cli,
        // 线路跟着创建一起写下去：任务建好之后再补，第一条消息已经按默认
        // 线路发出去了。
        runtime: runtime.toCreateBody(),
      );
      // 角色要在第一条消息之前写下去：绑定说的是「下一条消息」，而下一条正是
      // 紧接着要发的那条（同 Web Air 的顺序）。
      if (roles.isNotEmpty) {
        await _service.updateRoles(
          created,
          expectedVersion: 0,
          bindings: roles,
          clientMsgId: '${attempt.createId}-roles',
        );
      }
      await _service.sendFirstMessage(
        taskId: created,
        text: text,
        clientMsgId: attempt.sendId,
        goal: goal,
      );
      _attempt = null;
      await _refresh();
      if (!mounted) return false;
      setState(() => _submitting = false);
      final task = _data?.taskOf(created);
      if (task != null) await _open(task);
      return true;
    } catch (error) {
      // 任务可能已经建出来了，只是第一条消息没送到：那就还是进去，别让人以为
      // 白点了。这次尝试作废，内容没变时下一次点击会换一组新的幂等键。
      final taskId = created;
      if (taskId != null) {
        _attempt = null;
        await _refresh();
        if (!mounted) return false;
        setState(() {
          _submitting = false;
          _error = '任务已创建，但第一条消息未确认送达：$error';
        });
        final task = _data?.taskOf(taskId);
        if (task != null) await _open(task);
      } else {
        if (mounted) {
          setState(() {
            _submitting = false;
            _error = error.toString();
          });
        }
      }
      // 这一份草稿没有整条交出去，输入区留着它，重试就是原样再点一次。
      return false;
    }
  }

  Future<void> _addDirectory() async {
    final name = TextEditingController();
    final path = TextEditingController();
    String error = '';
    var saving = false;
    final created = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, update) => AlertDialog(
          title: const Text('添加工作目录'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: name,
                  autofocus: true,
                  maxLength: 100,
                  style: const TextStyle(color: AppColors.text),
                  decoration: const InputDecoration(labelText: '名称'),
                ),
                TextField(
                  controller: path,
                  maxLength: 2000,
                  style: const TextStyle(color: AppColors.text),
                  decoration: const InputDecoration(
                    labelText: '本机绝对路径',
                    hintText: '/Users/you/projects/example',
                  ),
                ),
                const Text(
                  '添加目录后，可在其中创建任务并按需附加角色。',
                  style: TextStyle(color: AppColors.faint, fontSize: 12),
                ),
                if (error.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      error,
                      style: const TextStyle(color: AppColors.danger),
                    ),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: saving ? null : () => Navigator.pop(ctx, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: saving
                  ? null
                  : () async {
                      if (name.text.trim().isEmpty ||
                          path.text.trim().isEmpty) {
                        update(() => error = '名称和路径都要填。');
                        return;
                      }
                      update(() {
                        saving = true;
                        error = '';
                      });
                      try {
                        await _service.addDirectory(
                          name: name.text.trim(),
                          path: path.text.trim(),
                        );
                        if (ctx.mounted) Navigator.pop(ctx, true);
                      } catch (e) {
                        if (ctx.mounted) {
                          update(() {
                            error = e.toString();
                            saving = false;
                          });
                        }
                      }
                    },
              child: Text(saving ? '正在添加…' : '添加'),
            ),
          ],
        ),
      ),
    );
    name.dispose();
    path.dispose();
    if (created == true) await _refresh();
  }

  /// 控制台。Web 那边它是盖在当前页面上的一层浮层，手机上并排放不下，所以做成
  /// 一条独立页面；分区的顺序和每张卡上的数字照搬（见 [AirConsoleScreen]）。
  ///
  /// 从控制台里点走一条任务、切一个目录、进一个设置页时，先把这一页收掉 ——
  /// 否则它盖住的正是刚落到下面的那一处。
  void _openConsole() {
    _closeDrawer();
    final navigator = Navigator.of(context);
    unawaited(
      navigator.push(
        MaterialPageRoute<void>(
          builder: (routeContext) => AirConsoleScreen(
            settings: widget.settings,
            httpClient: widget.httpClient,
            onOpenTask: (task) {
              Navigator.of(routeContext).pop();
              unawaited(_open(task));
            },
            onOpenTasks: () {
              Navigator.of(routeContext).pop();
              setState(() {
                _mode = _AirMode.tasks;
                _showAll = false;
              });
            },
            onOpenLibrary: () {
              Navigator.of(routeContext).pop();
              setState(() => _mode = _AirMode.library);
            },
            onSelectDirectory: (dirId) {
              Navigator.of(routeContext).pop();
              _selectDirectory(dirId);
            },
            onOpenSchedules: () {
              Navigator.of(routeContext).pop();
              _openSchedules();
            },
            onOpenDestination: (destination) {
              Navigator.of(routeContext).pop();
              _openDestination(destination);
            },
            onOpenMemory: () {
              Navigator.of(routeContext).pop();
              _openWebMemory();
            },
            onOpenWebConsole: _openWebConsole,
          ),
        ),
      ),
    );
  }

  /// 定时任务中心。规则和它背后那个固定 Air 任务是绑在一起的，所以从卡片上点
  /// 「固定 Air 任务」要能直接进到那条任务 —— 哪怕它在另一个目录里。
  void _openSchedules() {
    _closeDrawer();
    final navigator = Navigator.of(context);
    unawaited(
      navigator.push(
        MaterialPageRoute<void>(
          builder: (routeContext) => AirSchedulesScreen(
            settings: widget.settings,
            httpClient: widget.httpClient,
            directories: _data?.directories ?? const <AirDirectory>[],
            onOpenTask: (dirId, taskId) {
              Navigator.of(routeContext).pop();
              _openTaskById(dirId, taskId);
            },
          ),
        ),
      ),
    );
  }

  /// 按 id 打开一条任务：跨目录也认，先切目录再进对话。
  void _openTaskById(String dirId, String taskId) {
    final task = _data?.taskOf(taskId);
    if (task == null) {
      _selectDirectory(dirId);
      return;
    }
    if (task.dirId != _directoryId) _selectDirectory(task.dirId);
    unawaited(_open(task));
  }

  /// 网页版控制台。原生页已经能干活了，这里留一个明确出口，不是默认入口。
  void _openWebConsole() {
    final uri = Uri.parse(widget.settings.buildHttpUrl('/manage')).replace(
      queryParameters: {
        if (widget.settings.token.isNotEmpty) 'token': widget.settings.token,
      },
    );
    unawaited(launchUrl(uri, mode: LaunchMode.externalApplication));
  }

  void _openWebMemory() {
    final uri = Uri.parse(
      widget.settings.buildHttpUrl('/manage'),
    ).replace(
      queryParameters: {
        'view': 'memory',
        if (widget.settings.token.isNotEmpty) 'token': widget.settings.token,
      },
    );
    unawaited(launchUrl(uri, mode: LaunchMode.externalApplication));
  }

  Future<void> _push(WidgetBuilder builder) async {
    _closeDrawer();
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: builder));
  }

  void _openTaskBoard() {
    final dirId = _directoryId;
    if (dirId == null) return;
    final mgr = context.read<SessionManager>();
    unawaited(
      _push(
        (_) => TaskBoardView(
          settings: widget.settings,
          dirId: dirId,
          mgr: mgr,
          onOpenSession: (sessionId, {String? focusMessageId}) {
            final session = mgr.sessions
                .where((s) => s.id == sessionId)
                .firstOrNull;
            if (session != null) {
              mgr.openSessionWithFocus(
                session,
                focusMessageId: focusMessageId,
                historyArchive: true,
              );
            }
          },
        ),
      ),
    );
  }

  /// 全部功能：老首页抽屉里那张完整的表。侧栏只摆常用的几个，剩下的从这里进
  /// —— 侧栏变窄不该让任何一个页面变成打不开。
  Future<void> _openAllDestinations() async {
    final picked = await Navigator.of(context).push<WorkspaceDestination>(
      MaterialPageRoute<WorkspaceDestination>(
        builder: (routeContext) => AirAllDestinations(
          onSelected: (destination) =>
              Navigator.of(routeContext).pop(destination),
          onOpenVoiceCall: () {
            Navigator.of(routeContext).pop();
            widget.onOpenVoiceCall?.call();
          },
        ),
      ),
    );
    if (picked != null && mounted) _openDestination(picked);
  }

  void _openDestination(WorkspaceDestination destination) {
    // 定时任务在 Air 里已经有原生中心了，别再散到老抽屉那个只认 CLI 的页面上。
    if (destination == WorkspaceDestination.cron) {
      _openSchedules();
      return;
    }
    final handler = widget.onOpenDestination;
    _closeDrawer();
    if (handler != null) {
      handler(destination);
      return;
    }
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => switch (destination) {
            WorkspaceDestination.docs => DocsRegistryScreen(
              settings: widget.settings,
            ),
            _ => SettingsScreen(settings: widget.settings),
          },
        ),
      ),
    );
  }

  /// 侧栏的「最近任务」：先放这次会话里打开过的（跨目录），不够再用当前目录里
  /// 最近更新过的补上——和 Web Air 的 `#tasks` 一样的取舍。
  List<AirTask> _sidebarTasks() {
    final data = _data;
    if (data == null) return const [];
    final rows = <AirTask>[];
    final seen = <String>{};
    for (final id in _store?.recentTasks ?? const <String>[]) {
      final task = data.taskOf(id);
      if (task != null && seen.add(task.id)) rows.add(task);
      if (rows.length >= 8) return rows;
    }
    for (final task in data.tasksOf(_directoryId)) {
      if (seen.add(task.id)) rows.add(task);
      if (rows.length >= 8) break;
    }
    return rows;
  }

  List<AirTask> _visibleTasks() {
    final rows = _data?.tasksOf(_directoryId) ?? const <AirTask>[];
    if (_showAll) return rows;
    return rows.where((task) => !task.closed).toList();
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;
    final directory = data?.directoryOf(_directoryId);
    final tasks = _visibleTasks();
    // 「在不在跑」只有一份判定（注册表的 spinner），目录环、页头那颗徽标和任务
    // 行上的转圈说的都是同一件事。
    final runningDirectories = airRunningDirectories(
      data?.tasks ?? const <AirTask>[],
    );
    final runningHere =
        data?.tasksOf(_directoryId).where(airTaskRunning).length ?? 0;
    return Scaffold(
      key: _scaffoldKey,
      backgroundColor: AppColors.bg,
      drawer: AirSidebar(
        data: data,
        directoryId: _directoryId,
        favorites: _store?.favorites ?? const [],
        recentTasks: _sidebarTasks(),
        advancedMode: widget.settings.advancedMode.value,
        serverLabel: widget.settings.host,
        onSelectDirectory: _selectDirectory,
        onToggleFavorite: _toggleFavorite,
        onOpenLibrary: () {
          _closeDrawer();
          setState(() => _mode = _AirMode.library);
        },
        onOpenConsole: _openConsole,
        onOpenSchedules: _openSchedules,
        onOpenTaskBoard: () {
          _closeDrawer();
          _openTaskBoard();
        },
        onCreateTask: () {
          _closeDrawer();
          setState(() {
            _mode = _AirMode.tasks;
            _showAll = false;
          });
        },
        onOpenTask: (task) {
          _closeDrawer();
          unawaited(_open(task));
        },
        onOpenDocs: () => _openDestination(WorkspaceDestination.docs),
        onOpenMemory: () {
          _closeDrawer();
          _openWebMemory();
        },
        onOpenSettings: () => _openDestination(WorkspaceDestination.global),
        onOpenAllDestinations: () {
          _closeDrawer();
          unawaited(_openAllDestinations());
        },
        onOpenVoiceCall: widget.onOpenVoiceCall,
        onAdvancedModeChanged: widget.settings.setAdvancedMode,
      ),
      appBar: AppBar(
        backgroundColor: AppColors.panel,
        foregroundColor: AppColors.text,
        elevation: 0,
        scrolledUnderElevation: 0,
        titleSpacing: 0,
        leading: Builder(
          builder: (drawerContext) => IconButton(
            key: const ValueKey('air-menu-button'),
            icon: const Icon(Icons.menu_rounded),
            tooltip: '打开导航',
            onPressed: () => Scaffold.of(drawerContext).openDrawer(),
          ),
        ),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'MultiCC Air',
              style: TextStyle(
                color: AppColors.faint,
                fontSize: 10.5,
                letterSpacing: 0.6,
              ),
            ),
            Text(
              _mode == _AirMode.library
                  ? '工作目录'
                  : (directory?.name ?? '工作目录'),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: AppColors.text,
                fontSize: 16,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
        actions: [
          if (_mode == _AirMode.tasks && directory != null)
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: Center(
                child: AirStatusBadge(
                  text: runningHere > 0 ? '执行中 $runningHere' : '空闲',
                ),
              ),
            ),
          PopupMenuButton<String>(
            key: const ValueKey('air-header-menu'),
            icon: const Icon(Icons.more_horiz_rounded),
            tooltip: '更多操作',
            color: AppColors.panel,
            onSelected: (value) {
              switch (value) {
                case 'library':
                  setState(() => _mode = _AirMode.library);
                case 'add-directory':
                  unawaited(_addDirectory());
                case 'board':
                  _openTaskBoard();
                case 'schedules':
                  _openDestination(WorkspaceDestination.cron);
                case 'refresh':
                  unawaited(_refresh());
              }
            },
            itemBuilder: (context) => const [
              PopupMenuItem(value: 'library', child: Text('工作目录库')),
              PopupMenuItem(value: 'add-directory', child: Text('添加工作目录')),
              PopupMenuItem(value: 'board', child: Text('打开完整任务看板')),
              PopupMenuItem(value: 'schedules', child: Text('定时任务')),
              PopupMenuItem(value: 'refresh', child: Text('刷新')),
            ],
          ),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_error.isNotEmpty)
            Container(
              width: double.infinity,
              color: AppColors.dangerSoft,
              padding: const EdgeInsets.fromLTRB(18, 10, 18, 10),
              child: Text(
                _error,
                style: const TextStyle(color: AppColors.danger, fontSize: 12.5),
              ),
            ),
          Expanded(
            child: _mode == _AirMode.library
                ? AirDirectoryLibrary(
                    directories: data?.directories ?? const [],
                    currentDirectoryId: _directoryId,
                    tasksOf: (dirId) => data?.tasksOf(dirId) ?? const [],
                    runningDirectories: runningDirectories,
                    favorites: _store?.favorites ?? const [],
                    onOpen: _selectDirectory,
                    onAddDirectory: () => unawaited(_addDirectory()),
                    onToggleFavorite: (dirId) => unawaited(
                      _toggleFavorite(dirId),
                    ),
                  )
                : _buildTasks(data, directory, tasks),
          ),
        ],
      ),
    );
  }

  Widget _buildTasks(
    AirSnapshot? data,
    AirDirectory? directory,
    List<AirTask> tasks,
  ) {
    if (data == null && _error.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 28),
        children: [
          AirDirectoryStats(tasks: data?.tasksOf(_directoryId) ?? const []),
          const SizedBox(height: 22),
          if (directory != null) ...[
            Row(
              children: [
                Expanded(
                  child: Text(
                    directory.path,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: AppColors.faint,
                      fontSize: 11.5,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
          ],
          AirQuickComposer(
            settings: widget.settings,
            service: _service,
            httpClient: widget.httpClient,
            clis: data?.clis ?? const [],
            busy: _submitting,
            onSubmit: ({
              required String text,
              required String cli,
              required AirTaskRuntime runtime,
              required List<AirRoleBinding> roles,
              required bool goal,
            }) => _createFromComposer(
              text: text,
              cli: cli,
              runtime: runtime,
              roles: roles,
              goal: goal,
            ),
          ),
          const SizedBox(height: 24),
          Row(
            children: [
              const Expanded(
                child: Text(
                  '当前目录',
                  style: TextStyle(
                    color: AppColors.text,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              ChoiceChip(
                label: const Text('未完成'),
                selected: !_showAll,
                onSelected: (_) => setState(() => _showAll = false),
                showCheckmark: false,
              ),
              const SizedBox(width: 6),
              ChoiceChip(
                label: const Text('全部'),
                selected: _showAll,
                onSelected: (_) => setState(() => _showAll = true),
                showCheckmark: false,
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (data != null && tasks.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 28),
              child: Text(
                '还没有任务。\n在上面的输入框里描述目标，就会创建第一个任务。',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: AppColors.faint,
                  fontSize: 13,
                  height: 1.8,
                ),
              ),
            ),
          for (final task in tasks)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: AirTaskTile(
                task: task,
                onTap: () => unawaited(_open(task)),
                trailing: IconButton(
                  key: ValueKey('air-task-details-${task.id}'),
                  onPressed: () => unawaited(_openDetails(task)),
                  iconSize: 18,
                  visualDensity: VisualDensity.compact,
                  tooltip: '任务详情',
                  icon: const Icon(
                    Icons.info_outline_rounded,
                    color: AppColors.faint,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
