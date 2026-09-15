import 'dart:async';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../i18n.dart';
import '../providers/session_manager.dart';
import '../screens/docs_registry_screen.dart';
import '../screens/push_settings_screen.dart';
import '../screens/settings_screen.dart';
import '../screens/setup_screen.dart';
import '../screens/terminal_screen.dart';
import '../services/air_service.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';
import 'air/air_console.dart';
import 'air/air_destinations.dart';
import 'air/air_fleet_sharing.dart';
import 'air/air_new_task_sheet.dart';
import 'air/air_ops.dart';
import 'air/air_ops_store.dart';
import 'air/air_palette.dart';
import 'air/air_panels.dart';
import 'air/air_schedules.dart';
import 'air/air_sidebar.dart';
import 'air/air_task_config.dart';
import 'air/air_task_details.dart';
import 'air/air_task_status.dart';
import 'task_board_view.dart';
import 'tour_overlay.dart';
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
  late final AirOpsStore _ops = AirOpsStore(
    settings: widget.settings,
    httpClient: widget.httpClient,
  );
  final _scaffoldKey = GlobalKey<ScaffoldState>();
  // 新手引导（Web `public/tour.js`）落在首页的那两步：第 1 步圈目录库的
  // 「添加」，第 2 步圈输入区。见 [TourOverlay]。
  final _tourKey = GlobalKey<TourOverlayState>();
  final _tourLibraryKey = GlobalKey();
  final _tourComposerKey = GlobalKey();
  bool _tourStarted = false;
  AirLocalStore? _store;
  AirSnapshot? _data;
  AirCreateAttempt? _attempt;
  /// 上一次 [_createFromComposer] 交出去的那份草稿有没有归属 —— 整条链路成了，
  /// 或者任务建出来了只是第一条消息没确认送达，两种都算「交出去了」。承载它的弹层
  /// （侧栏那颗「＋ 新任务」）靠它决定收不收：这两种情况都不该再把那一层留在屏幕上
  /// （同 Web 的 closeNewTaskComposer，两条路径都关）。真是一个任务都没建起来时它是
  /// false，弹层留着、草稿还在输入框里，重试就是原样再点一次。
  bool _lastCreateHandedOff = false;
  String? _directoryId;
  String _error = '';
  bool _loading = false, _opening = false, _submitting = false, _foreground = true;
  bool _openingTerminal = false;
  bool _showAll = false;
  _AirMode _mode = _AirMode.tasks;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_loadStore());
    _ops.start();
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
    _ops.dispose();
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
      // 引导等数据到位再开始：早一步锚点还不存在，会走成「找不到目标就往下跳」。
      _maybeStartTour();
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      _loading = false;
    }
  }

  /// 侧栏里的每一次点击都要先把抽屉收回去。这里不能用 `Navigator.pop`：抽屉不是
  /// 一条路由，首页又是栈底那一条，`canPop()` 会直接说「没得弹」。
  void _closeDrawer() => _scaffoldKey.currentState?.closeDrawer();

  /// 引导只在首页真正拿到数据之后开一次。没走完就再进 App，autoStart 会接着上次
  /// 那一步（进度存在 SharedPreferences 里，键名跟 Web 一样）。
  void _maybeStartTour() {
    if (_tourStarted || _data == null) return;
    _tourStarted = true;
    _tourKey.currentState?.autoStart();
  }

  /// 引导走到第 1 步就摆出目录库，走到第 2 步摆回当前目录 —— Web 那两步的目标
  /// 分别在「新建目录」和「新建会话」上，App 里对应的是这两块。第 1 步圈的是
  /// 目录库那颗「添加」，不切过去的用户根本看不到它。
  void _onTourStep(int step) {
    if (step == 1 && _mode != _AirMode.library) {
      setState(() => _mode = _AirMode.library);
    } else if (step == 2 && _mode != _AirMode.tasks) {
      setState(() => _mode = _AirMode.tasks);
    }
  }

  void _selectDirectory(String dirId) {
    _closeDrawer();
    setState(() {
      _directoryId = dirId;
      _mode = _AirMode.tasks;
    });
  }

  /// 打开一个任务：先换出可续接的会话，再交给现有的聊天页。只读记录不能在这里
  /// 接管，只能回到它原来的会话。
  Future<void> _open(AirTask task) async {
    if (_opening) return;
    _opening = true;
    // 打开对话就是把引导交给聊天页（Web 第 2 步那颗「打开对话后继续」）。
    _tourKey.currentState?.handOffToChat();
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

  /// 侧栏 TERMINAL 一组点开一行：先换出会话对象，再开终端页。
  ///
  /// 三级兜底，因为终端记录不在 `/api/sessions` 的常规可见列表里：先看已经加载
  /// 的会话表（最完整，带 cwd），再按 id 拉一次，最后用快照里那四个字段自己拼
  /// 一个 —— `TerminalScreen` 要的就是 id 和 label，不该因为查不到元数据就打不开。
  Future<void> _openTerminal(AirSession entry) async {
    _closeDrawer();
    if (_openingTerminal) return;
    _openingTerminal = true;
    try {
      final mgr = context.read<SessionManager>();
      var session = mgr.sessions.where((s) => s.id == entry.id).firstOrNull;
      if (session == null) {
        final fetched = await SessionService(settings: widget.settings)
            .fetchSessions();
        session = fetched.where((s) => s.id == entry.id).firstOrNull;
      }
      final target = session ?? entry.toSession();
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              TerminalScreen(settings: widget.settings, session: target),
        ),
      );
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      _openingTerminal = false;
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
    int? goalRounds,
    int? goalBudget,
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
      '${roles.map((r) => '${r.name}:${r.prompt}').join(',')}|$goal|'
      '$goalRounds|$goalBudget',
      _attempt,
    );
    final attempt = _attempt!;
    _lastCreateHandedOff = false;
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
        goalRounds: goalRounds,
        goalBudget: goalBudget,
      );
      _attempt = null;
      await _refresh();
      if (!mounted) return false;
      setState(() => _submitting = false);
      // 整条链路都成了 —— 草稿交出去了。哪怕快照还没反应出这个新任务（服务端有
      // 延迟），也算交出去了：这一步说的是草稿，不是快照。
      _lastCreateHandedOff = true;
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
        // 任务建出来了，只是第一条消息没送到 —— 这一份同样已经有归属了。
        _lastCreateHandedOff = true;
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

  /// 侧栏那颗「＋ 新任务」：开 Web 的 `#quick-task-dialog` —— 里面装的就是目录
  /// 首页那一个统一输入框模块，AI 配置（CLI / 线路 / 模型）和角色都在同一套
  /// 胶囊里，写完一段话就创建并执行。
  ///
  /// 和输入区那条路是同一条流水线（[_createFromComposer]）：那段话既是任务名也是
  /// 第一条消息，建完直接进去。唯一的区别在写法 —— 手上开着别的任务时，它不必先
  /// 把你送回目录首页。
  Future<void> _newTask() async {
    final directory = _data?.directoryOf(_directoryId);
    if (directory == null) {
      setState(() => _error = '请先选一个工作目录。');
      return;
    }
    await showAirNewTaskSheet(
      context,
      directoryPath: directory.path,
      settings: widget.settings,
      service: _service,
      httpClient: widget.httpClient,
      clis: _data?.clis ?? const [],
      onSubmit: ({
        required String text,
        required String cli,
        required AirTaskRuntime runtime,
        required List<AirRoleBinding> roles,
        required bool goal,
        int? goalRounds,
        int? goalBudget,
      }) async {
        await _createFromComposer(
          text: text,
          cli: cli,
          runtime: runtime,
          roles: roles,
          goal: goal,
          goalRounds: goalRounds,
          goalBudget: goalBudget,
        );
        // 这一层收不收，看的是**草稿有没有归属**，不是「人有没有跳进那个任务」：
        // 整条链路成了、或任务建出来了只是第一条消息没送到，两种都该收掉（同 Web
        // 的 closeNewTaskComposer，两条路径都关）。建都没建起来时留着它 —— 草稿
        // 还在输入框里，重试就是原样再点一次。
        return _lastCreateHandedOff;
      },
    );
  }

  /// 目录卡片 ⋯ 菜单选了一件。四件事各自成一段 —— 它们从同一张菜单来，但
  /// 只有「分享」是本机目录的，「刷新/移除/重新导入」是远端工作区的。
  Future<void> _onDirectoryAction(
    AirDirectory directory,
    AirDirectoryAction action,
  ) async {
    switch (action) {
      case AirDirectoryAction.share:
        await _shareDirectory(directory);
      case AirDirectoryAction.reimport:
        await _reimportExternal(directory);
      case AirDirectoryAction.refresh:
        await _refreshExternal(directory);
      case AirDirectoryAction.remove:
        await _removeExternal(directory);
    }
  }

  /// 「↗ 分享工作区」（Web `manage-dashboard.js:949` → `openFleetShareModal`）。
  /// 对话框自己管签发、复制和撤销，这里只把外面的列表对齐一次。
  Future<void> _shareDirectory(AirDirectory directory) async {
    final issued = await showFleetShareDialog(
      context,
      directory: directory,
      settings: widget.settings,
      service: _service,
    );
    if (issued == true && mounted) await _refresh();
  }

  /// 「导入共享工作区」——把另一台 MultiCC 的工作区拉进来。
  Future<void> _importExternal() async {
    final fleet = await showFleetImportDialog(
      context,
      settings: widget.settings,
      service: _service,
    );
    if (fleet == null || !mounted) return;
    await _refresh();
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text('已导入共享工作区「${fleet.name}」')));
  }

  Future<void> _reimportExternal(AirDirectory directory) async {
    final existing = _data?.externalFleetOf(directory.id);
    if (existing == null) return;
    final fleet = await showFleetImportDialog(
      context,
      settings: widget.settings,
      service: _service,
      existing: existing,
    );
    if (fleet == null || !mounted) return;
    await _refresh();
    if (!mounted) return;
    _snack('已刷新共享工作区「${fleet.name}」');
  }

  Future<void> _refreshExternal(AirDirectory directory) async {
    try {
      await _service.refreshExternalFleet(directory.id);
      if (!mounted) return;
      await _refresh();
      if (!mounted) return;
      _snack('已刷新「${directory.name}」的远端状态');
    } catch (e) {
      if (mounted) _snack('刷新失败：$e', danger: true);
    }
  }

  Future<void> _removeExternal(AirDirectory directory) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.panel,
        content: Text('移除共享工作区「${directory.name}」？远端那份工作区不会被删掉，只是从本机列表里摘出去。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
          TextButton(
            key: const ValueKey('air-external-remove-confirm'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('移除', style: TextStyle(color: AppColors.danger)),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await _service.removeExternalFleet(directory.id);
      if (!mounted) return;
      // 被摘掉的正是当前打开的那个就把选中挪走 —— 留着会指着一条不存在的目录。
      if (_directoryId == directory.id) _directoryId = null;
      await _refresh();
      if (!mounted) return;
      _snack('已移除「${directory.name}」');
    } catch (e) {
      if (mounted) _snack('移除失败：$e', danger: true);
    }
  }

  void _snack(String message, {bool danger = false}) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: danger ? AppColors.danger : null,
      ),
    );
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

  /// 搜索目录与任务。Web 上这是 ⌘K 唤起的一层浮层；手机上没有键盘，就从侧栏
  /// 和头部菜单各留一个入口。选中什么直接落在宿主身上 —— 目录切过去，任务开
  /// 起来，跟从列表里点是一样的两条路。
  void _openSearch() {
    _closeDrawer();
    final data = _data;
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => AirPaletteScreen(
            directories: data?.directories ?? const <AirDirectory>[],
            recentTasks: _sidebarTasks(),
            allTasks: data?.tasks ?? const <AirTask>[],
            onSelectDirectory: _selectDirectory,
            onOpenTask: _openTaskById,
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
  ///
  /// 上限（同 Web 的 `RECENT_LIMIT`）不再按「一屏能放下几条」来定：侧栏的任务带
  /// 现在吃满剩下的高度并在内部滚，列八条会在下面留一大片空白——那片地方本来就
  /// 是给任务准备的。封顶只为挡住真·长尾（一个目录几百条任务时不去建几百个
  /// 按钮），所以给得比任何一屏都宽。完整的那份列表在控制台。
  List<AirTask> _sidebarTasks() {
    final data = _data;
    if (data == null) return const [];
    final rows = <AirTask>[];
    final seen = <String>{};
    for (final id in _store?.recentTasks ?? const <String>[]) {
      final task = data.taskOf(id);
      if (task != null && seen.add(task.id)) rows.add(task);
      if (rows.length >= 30) return rows;
    }
    for (final task in data.tasksOf(_directoryId)) {
      if (seen.add(task.id)) rows.add(task);
      if (rows.length >= 30) break;
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
    // 页头工具条只在够宽时摆出来 —— 阈值跟着 Web `air.css` 收工具条的那个
    // 760px 断点走（那边是「低于它就整条收进 ⋯ 浮层」）。
    final showToolbar = MediaQuery.sizeOf(context).width >= 760;
    // 引导那一层套在 Scaffold 外面：第 1 步的目标在页头之外的目录库里，但光圈
    // 要能盖住整页（含 AppBar），body 里那层盖不住。
    return Stack(
      children: [
        _buildScaffold(
          data: data,
          directory: directory,
          tasks: tasks,
          runningDirectories: runningDirectories,
          runningHere: runningHere,
          showToolbar: showToolbar,
        ),
        TourOverlay(
          key: _tourKey,
          page: TourPage.home,
          anchors: {1: _tourLibraryKey, 2: _tourComposerKey},
          onStepShown: _onTourStep,
        ),
      ],
    );
  }

  Widget _buildScaffold({
    required AirSnapshot? data,
    required AirDirectory? directory,
    required List<AirTask> tasks,
    required Set<String> runningDirectories,
    required int runningHere,
    required bool showToolbar,
  }) {
    return Scaffold(
      key: _scaffoldKey,
      backgroundColor: AppColors.bg,
      drawer: AirSidebar(
        data: data,
        directoryId: _directoryId,
        recentTasks: _sidebarTasks(),
        advancedMode: widget.settings.advancedMode.value,
        serverLabel: widget.settings.host,
        onSelectDirectory: _selectDirectory,
        onOpenLibrary: () {
          _closeDrawer();
          setState(() => _mode = _AirMode.library);
        },
        onOpenSearch: _openSearch,
        onOpenConsole: _openConsole,
        onOpenSchedules: _openSchedules,
        onOpenTaskBoard: () {
          _closeDrawer();
          _openTaskBoard();
        },
        onCreateTask: () {
          _closeDrawer();
          unawaited(_newTask());
        },
        onOpenTask: (task) {
          _closeDrawer();
          unawaited(_open(task));
        },
        terminalSessions:
            data?.terminalSessionsOf(_directoryId) ?? const <AirSession>[],
        onOpenTerminal: (session) => unawaited(_openTerminal(session)),
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
        ops: _ops,
        onOpenPush: () => _push((_) => PushSettingsScreen(settings: widget.settings)),
        onLogout: () => unawaited(
          confirmAirLogout(
            context,
            onLogout: () async {
              _closeDrawer();
              // 宿主先拿到手：等令牌清完再去找 Navigator 就太晚了，那中间隔着一个
              // 异步口。
              final navigator = Navigator.of(context, rootNavigator: true);
              await _ops.logout();
              if (!mounted) return;
              // 整个壳都换掉：连接设置那一页接上之后，这一棵树上所有的会话、
              // socket 和轮询都该跟着结束。
              unawaited(
                navigator.pushAndRemoveUntil(
                  MaterialPageRoute<void>(
                    builder: (_) => SetupScreen(settings: widget.settings),
                  ),
                  (route) => false,
                ),
              );
            },
          ),
        ),
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
          // 任务头部工具条（Web `air.html:112-139` 的 `#task-tools`）。那边按视图
          // 切换 `hidden`：`air.js:935-937` 让 add-directory 只在目录库出现、
          // schedule-create 只在定时任务视图出现、directory-open-planner 只在没有
          // 打开任务时出现；refresh 一直挂着，所以它没有 hidden。这里照同一套规矩
          // 取可见的那几个，名字进 tooltip —— 手机上放不下「图标 + 名字」并排，
          // 桌面那边名字本来也收在 `.air-tool-name` 里。
          //
          // 但整条工具条只在够宽的时候才摆出来：Web 自己的 `air.css` 760px 块就是
          // 把它整条收进 ⋯ 浮层的（那一段的原话是「手机上一行消息值 23px，这一行
          // 是整屏里最贵的几行之一」）。App 跑在手机上，320px 实测多这三颗就溢出
          // 23px，所以窄屏跟 Web 一样只留 ⋯ —— 而那几件工具本来就在 ⋯ 的完整列表
          // 里，一件都没少。
          //
          // 「合并回基分支 / 自动提交 / 分享此任务 / 详情 / 更多」这五个也不在这里：
          // 它们要的是一个**打开着的任务**，而 App 里打开任务是把聊天页升起来盖住
          // 整个 Air 首页的，工具条会被压在下面点不到。那五个动作因此落在聊天页
          // 自己的头部菜单里（`chat_header.dart` 的 `_HeaderOverflowMenu`）。
          if (showToolbar && _mode == _AirMode.tasks)
            _AirToolButton(
              keyName: 'air-tool-board',
              icon: Icons.grid_view_rounded,
              tooltip: '打开完整任务看板',
              onTap: _openTaskBoard,
            ),
          if (showToolbar && _mode == _AirMode.library) ...[
            _AirToolButton(
              keyName: 'air-tool-add-directory',
              icon: Icons.create_new_folder_outlined,
              tooltip: '添加工作目录',
              onTap: () => unawaited(_addDirectory()),
            ),
            _AirToolButton(
              keyName: 'air-tool-schedules',
              icon: Icons.schedule_rounded,
              tooltip: '新建定时任务',
              onTap: () => _openDestination(WorkspaceDestination.cron),
            ),
          ],
          if (showToolbar)
            _AirToolButton(
              keyName: 'air-tool-refresh',
              icon: Icons.refresh_rounded,
              tooltip: '刷新',
              onTap: () => unawaited(_refresh()),
            ),
          PopupMenuButton<String>(
            key: const ValueKey('air-header-menu'),
            icon: const Icon(Icons.more_horiz_rounded),
            tooltip: '更多操作',
            color: AppColors.panel,
            onSelected: (value) {
              switch (value) {
                case 'search':
                  _openSearch();
                case 'library':
                  setState(() => _mode = _AirMode.library);
                case 'add-directory':
                  unawaited(_addDirectory());
                case 'import-fleet':
                  unawaited(_importExternal());
                case 'board':
                  _openTaskBoard();
                case 'schedules':
                  _openDestination(WorkspaceDestination.cron);
                case 'refresh':
                  unawaited(_refresh());
                case 'onboarding':
                  unawaited(_tourKey.currentState?.restart() ?? Future.value());
              }
            },
            itemBuilder: (context) => [
              const PopupMenuItem(value: 'search', child: Text('搜索目录与任务')),
              const PopupMenuItem(value: 'library', child: Text('工作目录库')),
              const PopupMenuItem(value: 'add-directory', child: Text('添加工作目录')),
              const PopupMenuItem(
                value: 'import-fleet',
                child: Text('导入共享工作区'),
              ),
              const PopupMenuItem(value: 'board', child: Text('打开完整任务看板')),
              const PopupMenuItem(value: 'schedules', child: Text('定时任务')),
              const PopupMenuItem(value: 'refresh', child: Text('刷新')),
              // Web 那边是 manage 页右上角那颗 ❓（`onclick="startOnboarding()"`）。
              PopupMenuItem(value: 'onboarding', child: Text(t('onboarding'))),
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
                    onOpen: _selectDirectory,
                    onAddDirectory: () => unawaited(_addDirectory()),
                    onAction: (directory, action) =>
                        unawaited(_onDirectoryAction(directory, action)),
                    // 第 1 步圈的就是这颗「添加」（Web 第 1 步的目标是「新建
                    // 目录」按钮，同一件事）。
                    addButtonKey: _tourLibraryKey,
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
          KeyedSubtree(
            key: _tourComposerKey,
            child: AirQuickComposer(
              settings: widget.settings,
              service: _service,
              httpClient: widget.httpClient,
              clis: data?.clis ?? const [],
              busy: _submitting,
              // 参数表就是 [AirComposerSubmit] 那一份，不必再抄一遍转发。
              onSubmit: _createFromComposer,
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
                // Web Air 的目录任务行尾部就是那个 `<time>`（`air.js` 的
                // `toLocaleString('zh-CN', {month, day, hour, minute})`），列表
                // 又正是按 updatedAt 排序的 —— 时间本身就是排序依据，要看得见。
                showTime: true,
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

/// 任务头部工具条上的一枚图标按钮（Web `.task-tools button` 的图标形态）。
///
/// 名字只在 tooltip 里 —— 手机上页头是横向最紧的一行，塞不下「图标 + 名字」；
/// 桌面那一版平时也把名字收在 `.air-tool-name` 里，只有窄屏浮层才把两列铺开。
/// `keyName` 走 [ValueKey]，测试和无障碍都靠它定位。
class _AirToolButton extends StatelessWidget {
  const _AirToolButton({
    required this.keyName,
    required this.icon,
    required this.tooltip,
    required this.onTap,
  });

  final String keyName;
  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      key: ValueKey(keyName),
      onPressed: onTap,
      iconSize: 19,
      visualDensity: VisualDensity.compact,
      tooltip: tooltip,
      // `aria-label` 在 Web 上就是这颗按钮的可读名字（浮层里图标要站第一列，
      // 名字平时不显示），App 这边由 tooltip 一起承担。
      icon: Icon(icon, color: AppColors.muted),
    );
  }
}
