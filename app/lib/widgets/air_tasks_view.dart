import 'dart:async';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../providers/session_manager.dart';
import '../screens/docs_registry_screen.dart';
import '../screens/aux_screen.dart';
import '../screens/memory_graph_screen.dart';
import '../screens/push_settings_screen.dart';
import '../screens/settings_screen.dart';
import '../screens/setup_screen.dart';
import '../screens/task_graph_screen.dart';
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
import 'air/air_task_actions.dart';
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

  /// ☰ 按下之后、抽屉拉开之前的这一步。
  ///
  /// 抽屉是这一层 Scaffold 的，而打开着的对话 / 目录详情浮层挂在它上面（宿主把
  /// 它们叠在外层 Stack 里）—— 不先把浮层让开，抽屉就拉在浮层底下，屏幕上什么
  /// 也看不到。宿主知道当前开着的是哪一层、也知道它什么时候滑完，所以这件事交给
  /// 宿主；这里只负责等它回来再开抽屉。不提供 = 直接开。
  final Future<void> Function()? beforeOpenNavigation;

  const AirTasksView({
    super.key,
    required this.settings,
    this.httpClient,
    this.onOpenDestination,
    this.onOpenVoiceCall,
    this.beforeOpenNavigation,
  });

  @override
  State<AirTasksView> createState() => _AirTasksViewState();
}

enum _AirMode { tasks, library }

/// 目录首页顶部那道切换（Web `public/air.html` 的 `#directory-mode`）。
///
/// [chat] = 任务与对话（默认），[terminal] = **本目录**的终端会话。两类东西一次
/// 只显示一种 —— 终端不混进任务清单，任务行也不混进终端列表。
enum _DirectoryMode { chat, terminal }

enum _DirectoryTaskStatus { open, all, archived }

enum _DirectoryTaskSort { message, visit }

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
  bool _loading = false, _submitting = false, _foreground = true;
  bool _openingTerminal = false;
  bool _creatingTerminal = false;
  bool _reclaiming = false;
  bool _showAll = false;
  final _taskSearch = TextEditingController();
  String _taskQuery = '';
  _DirectoryTaskStatus _taskStatus = _DirectoryTaskStatus.open;
  _DirectoryTaskSort _taskSort = _DirectoryTaskSort.message;
  _AirMode _mode = _AirMode.tasks;

  /// 当前目录首页显示哪一类东西。默认 Chat（任务/对话），和 Web 一致；换一个
  /// 目录也回到 Chat —— 「默认还是 chat 模式」不该被上一次切到 Terminal 记住。
  _DirectoryMode _dirMode = _DirectoryMode.chat;
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
    _taskSearch.dispose();
    widget.settings.advancedMode.removeListener(_onAdvancedModeChanged);
    _service.close();
    _ops.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _loadStore() async {
    final store = await AirLocalStore.load();
    if (!mounted) return;
    setState(() {
      _store = store;
      _taskSort = store.taskSort == 'visit'
          ? _DirectoryTaskSort.visit
          : _DirectoryTaskSort.message;
    });
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

  /// ☰：先请宿主把浮层让开（对话 / 目录详情），让开了再拉抽屉 —— 抽屉属于这一层
  /// Scaffold，浮层不滑落的话它会被压在上面盖住（见 [AirTasksView.beforeOpenNavigation]）。
  /// ScaffoldState 在 await 之前就取好：跨过 await 再碰 BuildContext 是不合法的。
  Future<void> _openNavigation(BuildContext drawerContext) async {
    final scaffold = Scaffold.of(drawerContext);
    final before = widget.beforeOpenNavigation;
    if (before != null) await before();
    if (!mounted) return;
    scaffold.openDrawer();
  }

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
      // 每个目录都从 Chat 起步：切过去先看这个目录的活，终端是下一跳的事。
      _dirMode = _DirectoryMode.chat;
      _showAll = false;
      _taskQuery = '';
      _taskStatus = _DirectoryTaskStatus.open;
      _taskSearch.clear();
    });
  }

  /// 点击后立即显示加载页，再解析可续接的会话；只读记录回到原来的会话。
  Future<void> _open(AirTask task) => _openTask(task.id);

  /// 按 id 打开任务对话。
  ///
  /// 列表之外还有一个入口会走到这里：任务图谱节点详情里的「在 Air 打开」
  /// （[_openTaskFromGraph]）—— 图谱是跨目录的，那一行不一定在当前目录的快照
  /// 里，所以打开这件事按 id 收口，不要求先能拿到 [AirTask]。
  Future<void> _openTask(String taskId) async {
    _tourKey.currentState?.handOffToChat();
    final mgr = context.read<SessionManager>();
    final task = _data?.tasks.where((task) => task.id == taskId).firstOrNull;
    final opened = await mgr.openChatAfterLoad(
      title: task?.title ?? t('chatOpeningTask'),
      load: () => _service.openTaskSession(
        taskId,
        cachedSession: (id) =>
            mgr.sessions.where((session) => session.id == id).firstOrNull,
      ),
    );
    if (mounted && opened) {
      unawaited(_store?.rememberTask(taskId));
      setState(() {});
    }
  }

  /// 页头那颗「执行中 N / 空闲」徽标点开的东西：**本目录正在执行的这几条**。
  ///
  /// Web 的 `#task-state` 是按钮，点开的是「当前打开的那个任务」的详情
  /// （`public/air.js:1835` 的 `openTaskDetails(currentTaskId)`）。App 的 Air
  /// 首页没有「当前打开的任务」这一层 —— 这一行说的是「本目录有几条在跑」，
  /// 照搬 Web 就得替用户猜一个任务。所以这里点开的是那个数字本身：正在执行的
  /// 任务清单，每一条还是走同一套 [_open]。
  Future<void> _showRunningTasks() async {
    final data = _data;
    final dirId = _directoryId;
    if (data == null || dirId == null) return;
    final running = data.tasksOf(dirId).where(airTaskRunning).toList();
    final messenger = ScaffoldMessenger.of(context);
    if (running.isEmpty) {
      messenger.showSnackBar(const SnackBar(content: Text('本目录当前没有正在执行的任务。')));
      return;
    }
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppColors.panel,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '正在执行 ${running.length} 个任务',
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 14.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 10),
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    for (final task in running)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: AirTaskTile(
                          task: task,
                          showTime: true,
                          onTap: () {
                            Navigator.of(sheetContext).pop();
                            unawaited(_open(task));
                          },
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Terminal 模式点开一行：先换出会话对象，再开终端页。
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
        final fetched = await SessionService(
          settings: widget.settings,
        ).fetchSessions();
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
                onOpenSeparatedTask: (targetTaskId) {
                  Navigator.pop(sheetContext);
                  unawaited(() async {
                    await _refresh();
                    if (mounted) _openTaskById(task.dirId, targetTaskId);
                  }());
                },
                directories: _data?.directories ?? const <AirDirectory>[],
                dirId: task.dirId,
                // 归档/恢复只改这一条任务的状态：重拉快照，面板自己已经刷新过了。
                onTaskChanged: () => unawaited(_refresh()),
                // 移动之后这条任务属于别的目录了，所以先关掉这一层，再刷新并跟着
                // 挪过去 —— 和 Web 的 `navigate(chosen, taskId)` 一个意思。
                onTaskMoved: (dirId) {
                  Navigator.pop(sheetContext);
                  unawaited(() async {
                    await _refresh();
                    if (mounted) _openTaskById(dirId, task.id);
                  }());
                },
                // 删除之后任务已经不存在，只能关掉面板：留在原处刷新的话，详情
                // 面板会去取一条已删掉的任务（Web 也是先离开再刷新）。
                onTaskRemoved: () {
                  Navigator.pop(sheetContext);
                  unawaited(_refresh());
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
    String? targetDirectoryId,
    required String text,
    required String cli,
    required AirTaskRuntime runtime,
    required List<AirRoleBinding> roles,
    required bool goal,
    int? goalRounds,
    int? goalBudget,
  }) async {
    final dirId = targetDirectoryId ?? _directoryId;
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
    final directories =
        _data?.directories.where((directory) => !directory.external).toList() ??
        const <AirDirectory>[];
    if (directories.isEmpty) {
      setState(() => _error = '请先选一个工作目录。');
      return;
    }
    final directory = directories.any((entry) => entry.id == _directoryId)
        ? directories.firstWhere((entry) => entry.id == _directoryId)
        : directories.first;
    await showAirNewTaskSheet(
      context,
      directories: directories,
      initialDirectoryId: directory.id,
      settings: widget.settings,
      service: _service,
      httpClient: widget.httpClient,
      clis: _data?.clis ?? const [],
      onSubmit:
          ({
            required String directoryId,
            required String text,
            required String cli,
            required AirTaskRuntime runtime,
            required List<AirRoleBinding> roles,
            required bool goal,
            int? goalRounds,
            int? goalBudget,
          }) async {
            await _createFromComposer(
              targetDirectoryId: directoryId,
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

  /// 「现在回收」（Web 目录页那颗按钮，`POST /api/air/worktrees/reclaim`）。
  ///
  /// 只删本地 checkout，分支与提交始终保留（下次打开这条任务时按需重建），所以
  /// 这一步不需要「会丢东西」的警告。默认只收过了闲置阈值的；一个都没收到、本地
  /// 却确实还占着地方，才问一句要不要连最近用过的也一起收 —— 那是用户按下按钮
  /// 之后的显式确认，不是自动行为（自动那条路是服务端的定时扫描，阈值见面板）。
  Future<void> _reclaimWorktrees(AirDirectory directory) async {
    if (_reclaiming) return;
    setState(() => _reclaiming = true);
    try {
      var answer = await _service.reclaimWorktrees(directory.id);
      final considered = (answer['considered'] as num?)?.toInt() ?? 0;
      final reclaimable =
          answer['ok'] != false &&
          ((answer['hibernated'] as num?)?.toInt() ?? 0) == 0 &&
          considered > 0;
      if (reclaimable && mounted) {
        final forced = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            backgroundColor: AppColors.panel,
            content: Text('还有 $considered 个没到闲置阈值。连最近用过的也一起回收吗？'),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: const Text('取消'),
              ),
              TextButton(
                key: const ValueKey('air-worktree-reclaim-force'),
                onPressed: () => Navigator.pop(ctx, true),
                child: const Text('一起回收'),
              ),
            ],
          ),
        );
        if (forced == true) {
          answer = await _service.reclaimWorktrees(directory.id, force: true);
        }
      }
      if (!mounted) return;
      final done = (answer['hibernated'] as num?)?.toInt() ?? 0;
      final skipped = (answer['skipped'] as num?)?.toInt() ?? 0;
      final checked = (answer['considered'] as num?)?.toInt() ?? 0;
      final failed = answer['ok'] == false;
      _snack(
        failed
            ? '回收失败：${answer['code'] ?? ''}'
            : done > 0
            ? '已回收 $done 个（检查 $checked 个，跳过 $skipped 个）'
            : '没有可回收的 worktree：都不闲置，或者正被占用。',
        danger: failed,
      );
      await _refresh();
    } catch (e) {
      if (mounted) _snack('回收失败：$e', danger: true);
    } finally {
      if (mounted) setState(() => _reclaiming = false);
    }
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
    var create = true;
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
                CheckboxListTile(
                  value: create,
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  title: const Text(
                    '路径不存在时，创建这个文件夹',
                    style: TextStyle(fontSize: 13),
                  ),
                  onChanged: saving
                      ? null
                      : (value) => update(() => create = value ?? true),
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
                          create: create,
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
              _openMemoryGraph();
            },
            onOpenAiAssistant: () {
              Navigator.of(routeContext).pop();
              _openAiAssistant();
            },
            onOpenWebConsole: _openWebConsole,
          ),
        ),
      ),
    );
  }

  void _openAiAssistant() {
    _closeDrawer();
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => AuxScreen(settings: widget.settings),
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
            initialDirectoryId: _directoryId,
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
    // 控制台现在就是 Air 自己（`/manage` 会 302 到 `/air?view=overview`，
    // `public/air.js` 里那句「?view=overview 表示打开控制台」）。写旧地址虽然
    // 靠重定向也能到，但那是别人的兼容承诺，不是这一页的入口。
    final uri = Uri.parse(widget.settings.buildHttpUrl('/air')).replace(
      queryParameters: {
        'view': 'overview',
        if (widget.settings.token.isNotEmpty) 'token': widget.settings.token,
      },
    );
    unawaited(launchUrl(uri, mode: LaunchMode.externalApplication));
  }

  /// 「记忆图谱」（Web `?view=memory`）—— 原生页 [MemoryGraphScreen]。
  ///
  /// 以前这里开的是 `/air?view=memory`（老地址 `/manage?view=memory` 会 302 到
  /// 同一个终点）。原生页补齐之后这个入口不再依赖那张映射表，也不再需要为看一
  /// 张图离开 App —— 详情里的「编辑」直接进原生记忆文件编辑器。
  void _openMemoryGraph() {
    unawaited(_push((_) => MemoryGraphScreen(settings: widget.settings)));
  }

  /// 「任务图谱」（Web `?view=taskgraph`）—— 原生页 [TaskGraphScreen]。
  ///
  /// 以前这里开的是 `/manage?view=taskgraph`，而那条老地址现在 302 到
  /// `/air?view=overview`：点「任务图谱」实际只会看到控制台。原生页补齐之后
  /// 这个入口不再依赖那张映射表。
  Future<void> _openTaskGraph() async {
    final navigator = Navigator.of(context);
    await _push(
      (_) => TaskGraphScreen(
        settings: widget.settings,
        // 图谱不认识 Air 路由，回跳由宿主来做：先把图谱这一层收掉，再走和任务
        // 行完全相同的 [_openTask]（`.pop()` 之后这一帧的 context 就不该再用了，
        // 所以 Navigator 先取出来）。
        onOpenTaskInAir: (dirId, taskId) {
          navigator.pop();
          unawaited(_openTaskFromGraph(dirId, taskId));
        },
      ),
    );
  }

  /// 图谱详情里「在 Air 打开」：先切到任务所属目录（列表跟着换），再照常打开。
  ///
  /// 任务可能不在当前目录的快照里（图谱是跨目录的），所以这里按 id 打开，
  /// 不要求先能在这份列表里找到那一行。
  Future<void> _openTaskFromGraph(String dirId, String taskId) async {
    if (dirId.isNotEmpty && dirId != _directoryId) {
      _selectDirectory(dirId);
    }
    await _openTask(taskId);
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
    // 手机上 pin 住的那几条排在最前面（Web 那边是页头顶上那排 tab，手机宽度下
    // 它整个藏掉、改成置顶在这一份列表里，见 public/air.js 的 sidebarTasks）。
    // 「最近」会掉出列表，pin 不会 —— 这两件事必须分开。
    for (final id in data.taskPins) {
      final task = data.taskOf(id);
      if (task != null && seen.add(task.id)) rows.add(task);
    }
    for (final id in _store?.recentTasks ?? const <String>[]) {
      final task = data.taskOf(id);
      if (task != null && seen.add(task.id)) rows.add(task);
      if (rows.length >= 30) return rows;
    }
    for (final task in data.tasksOf(_directoryId)) {
      if (seen.add(task.id)) rows.add(task);
      if (rows.length >= 30) break;
    }
    // 30 是长尾的闸门，不是「一屏」；截的是尾巴，pin 住的那几条在最前面，动不到。
    return rows.length > 30 ? rows.sublist(0, 30) : rows;
  }

  /// 首页这块是 Web 的「最近任务」（`air.js` 的 `renderDirectoryOverview`）：
  /// 抬头下面只摆最近几条，其余交给下面那颗「查看全部 N 个任务 ›」。
  ///
  /// 截断而不是按状态过滤，也是照 Web 抄的：那边这份 `tasks` 只按 dirId 过滤，
  /// `!['done','archived'].includes(status)` 那道判断只用在抬头上面那四张统计卡
  /// 里。默认按最后消息倒序，也可以切到本机最后访问时间。
  List<AirTask> _visibleTasks(BuildContext context) {
    final rows = (_data?.tasksOf(_directoryId) ?? const <AirTask>[]).toList();
    rows.sort((a, b) {
      final primary = _taskSortAt(b).compareTo(_taskSortAt(a));
      if (primary != 0) return primary;
      final messages = b.lastMessageAt.compareTo(a.lastMessageAt);
      return messages != 0 ? messages : a.id.compareTo(b.id);
    });
    if (_showAll) {
      final needle = _taskQuery.trim().toLowerCase();
      return rows.where((task) {
        final statusMatches = switch (_taskStatus) {
          _DirectoryTaskStatus.all => true,
          _DirectoryTaskStatus.archived => task.status == 'archived',
          _DirectoryTaskStatus.open => !task.closed,
        };
        return statusMatches &&
            (needle.isEmpty || task.title.toLowerCase().contains(needle));
      }).toList();
    }
    return rows.take(_recentRowLimit(context)).toList();
  }

  int _taskSortAt(AirTask task) => _taskSort == _DirectoryTaskSort.visit
      ? (_store?.visitedAt(task.id) ?? 0)
      : task.lastMessageAt;

  Widget _taskSortButton(_DirectoryTaskSort value, String label) {
    final selected = _taskSort == value;
    return Semantics(
      button: true,
      selected: selected,
      child: InkWell(
        key: ValueKey('air-task-sort-${value.name}'),
        onTap: () {
          if (selected) return;
          setState(() => _taskSort = value);
          unawaited(_store?.setTaskSort(value.name));
        },
        borderRadius: BorderRadius.circular(7),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          decoration: BoxDecoration(
            color: selected ? AppColors.panel : Colors.transparent,
            borderRadius: BorderRadius.circular(7),
            boxShadow: selected
                ? const [BoxShadow(color: Color(0x14274968), blurRadius: 4)]
                : null,
          ),
          child: Text(
            label,
            style: TextStyle(
              color: selected ? AppColors.accent : AppColors.faint,
              fontSize: 10.5,
              fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
            ),
          ),
        ),
      ),
    );
  }

  /// Web `air.js` 的 `recentRowLimit()`：760px 及以下六行，再宽十行。一行就是一条
  /// 任务，截掉的本来也排不进「最近」。
  static int _recentRowLimit(BuildContext context) =>
      MediaQuery.sizeOf(context).width <= 760 ? 6 : 10;

  @override
  Widget build(BuildContext context) {
    final data = _data;
    final directory = data?.directoryOf(_directoryId);
    final tasks = _visibleTasks(context);
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
        pinnedTaskIds: data?.taskPins.toSet() ?? const <String>{},
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
        onOpenDocs: () => _openDestination(WorkspaceDestination.docs),
        onOpenMemory: () {
          _closeDrawer();
          _openMemoryGraph();
        },
        onOpenTaskGraph: () {
          _closeDrawer();
          unawaited(_openTaskGraph());
        },
        onOpenSettings: () => _openDestination(WorkspaceDestination.global),
        onOpenAllDestinations: () {
          _closeDrawer();
          unawaited(_openAllDestinations());
        },
        onOpenDestination: _openDestination,
        ops: _ops,
        language: widget.settings.lang,
        onLanguage: () => widget.settings.setLanguage(
          widget.settings.lang == 'zh' ? 'en' : 'zh',
        ),
        onOpenPush: () =>
            _push((_) => PushSettingsScreen(settings: widget.settings)),
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
            onPressed: () => unawaited(_openNavigation(drawerContext)),
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
              _mode == _AirMode.library ? '工作目录' : (directory?.name ?? '工作目录'),
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
                  onTap: () => unawaited(_showRunningTasks()),
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
              const PopupMenuItem(
                value: 'add-directory',
                child: Text('添加工作目录'),
              ),
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
                : _buildDirectory(data, directory, tasks),
          ),
        ],
      ),
    );
  }

  /// 目录首页 = 顶部那道 Chat / Terminal 切换 + 下面那一种内容。
  ///
  /// 切换摆在整个页面最前面（「Terminal 放到各个目录里面、在前面」），所以两类
  /// 东西都不必先去侧栏里找一遍；一次只显示一种，互不混排。默认 Chat。
  Widget _buildDirectory(
    AirSnapshot? data,
    AirDirectory? directory,
    List<AirTask> tasks,
  ) {
    if (data == null && _error.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _DirectoryModeSwitch(
          mode: _dirMode,
          onChanged: (mode) => setState(() => _dirMode = mode),
        ),
        Expanded(
          child: _dirMode == _DirectoryMode.terminal
              ? _buildTerminals(data, directory)
              : _buildTasks(data, directory, tasks),
        ),
      ],
    );
  }

  /// Terminal 模式：**本目录**的终端会话（`/api/air` 的 `sessions`，服务端已经按
  /// `dirId` 滤过一遍）。它跟的是目录，不是某一条任务 —— 所以列表跟着 [_selectDirectory]
  /// 走，和任务清单读的是同一份快照。
  Widget _buildTerminals(AirSnapshot? data, AirDirectory? directory) {
    final dirId = _directoryId;
    final sessions = data?.terminalSessionsOf(dirId) ?? const <AirSession>[];
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 28),
        children: [
          if (directory != null)
            Text(
              directory.path,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: AppColors.faint, fontSize: 11.5),
            ),
          const SizedBox(height: 10),
          FilledButton.icon(
            key: const ValueKey('air-new-terminal-button'),
            onPressed: dirId == null || _creatingTerminal
                ? null
                : () => unawaited(_createTerminal(dirId)),
            icon: const Icon(Icons.add_rounded, size: 17),
            label: Text(_creatingTerminal ? '正在新建…' : '新建终端'),
            style: FilledButton.styleFrom(
              backgroundColor: AppColors.accent.withValues(alpha: 0.16),
              foregroundColor: AppColors.accent,
              minimumSize: const Size.fromHeight(44),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(9),
              ),
            ),
          ),
          const SizedBox(height: 18),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      '当前目录',
                      style: TextStyle(color: AppColors.faint, fontSize: 11.5),
                    ),
                    const SizedBox(height: 2),
                    const Text(
                      '终端',
                      key: ValueKey('air-terminals-heading'),
                      style: TextStyle(
                        color: AppColors.text,
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              Text(
                '${sessions.length} 个终端',
                key: const ValueKey('air-terminals-count'),
                style: const TextStyle(color: AppColors.faint, fontSize: 11.5),
              ),
            ],
          ),
          const SizedBox(height: 12),
          // 空态说清楚空的是「这个目录还没开过终端」，不是这一页坏了 —— 同一个
          // 目录下的任务列表跟它无关（任务在另一侧，切回 Chat 就在）。
          if (sessions.isEmpty)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 16),
              decoration: BoxDecoration(
                color: AppColors.bg.withValues(alpha: 0.65),
                border: Border.all(color: AppColors.line),
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Text(
                '本目录暂无终端会话',
                key: ValueKey('air-terminals-empty'),
                textAlign: TextAlign.center,
                style: TextStyle(color: AppColors.faint, fontSize: 12),
              ),
            )
          else
            for (final session in sessions)
              _DirectoryTerminalRow(
                session: session,
                onTap: () => unawaited(_openTerminal(session)),
              ),
        ],
      ),
    );
  }

  /// 终端可选的 CLI：快照里那些，去掉这台客户端**认不出**的和实验适配器。
  ///
  /// 认不出不是小事：`parseCli` 对未知名字会静默落回 Claude，选「kimi」结果建出
  /// 一个 Claude 终端，界面上还写着 kimi。Web 那份清单（`air-directory-mode.js`
  /// 的 `cliOptions`）同样剔掉 exp 车道，两边保持同一套可选集合。
  List<String> _terminalCliOptions() {
    final clis = _data?.clis ?? const <String>[];
    return [
      for (final cli in clis)
        if (tryParseCli(cli) != null && cli != 'claude-exp' && cli != 'codex-exp')
          cli,
    ];
  }

  /// 「新建终端」：一个目录下的终端就走这条路（`POST /api/directories/:id/sessions`
  /// 的 `kind=terminal`）。用哪个 CLI 由 [_terminalCliOptions] 问出来（只有一个就不
  /// 问），建好直接开终端页；下一次 4s 轮询里它就出现在这份列表上。
  Future<void> _createTerminal(String dirId) async {
    final clis = _terminalCliOptions();
    // 一个都没得选时不要假装建得出来：`_pickTerminalCli([])` 只会弹一层空壳。
    if (clis.isEmpty) {
      setState(() => _error = t('noCompatibleAi'));
      return;
    }
    final cli = clis.length == 1 ? clis.first : await _pickTerminalCli(clis);
    if (cli == null || cli.isEmpty || !mounted) return;
    setState(() => _creatingTerminal = true);
    try {
      final mgr = context.read<SessionManager>();
      final session = await mgr.createSessionInDir(
        dirId: dirId,
        cli: parseCli(cli),
        kind: SessionKind.terminal,
        label: '$cli 终端',
      );
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              TerminalScreen(settings: widget.settings, session: session),
        ),
      );
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _creatingTerminal = false);
    }
  }

  /// 多个 CLI 时装哪个：一问一答，不替用户猜。返回 null = 没选。
  Future<String?> _pickTerminalCli(List<String> clis) =>
      showModalBottomSheet<String>(
        context: context,
        backgroundColor: AppColors.panel,
        showDragHandle: true,
        builder: (sheetContext) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 0, 16, 6),
                child: Text(
                  '用哪个 CLI 开这个终端？',
                  style: TextStyle(
                    color: AppColors.text,
                    fontSize: 14.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              for (final cli in clis)
                ListTile(
                  key: ValueKey('air-terminal-cli-$cli'),
                  dense: true,
                  leading: const Icon(
                    Icons.terminal_rounded,
                    size: 18,
                    color: AppColors.muted,
                  ),
                  title: Text(
                    cli,
                    style: const TextStyle(color: AppColors.text, fontSize: 14),
                  ),
                  onTap: () => Navigator.of(sheetContext).pop(cli),
                ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      );

  Widget _buildTasks(
    AirSnapshot? data,
    AirDirectory? directory,
    List<AirTask> tasks,
  ) {
    if (data == null && _error.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    // 抬头上的「N 个任务」和统计卡读的是同一份**未截断**的目录任务表：数字说的是
    // 这个目录一共有多少条，不是这一屏摆得下多少条。
    final all = data?.tasksOf(_directoryId) ?? const <AirTask>[];
    // Worktree 生命周期面板：只有本机目录、服务端确实给了拆解、而且这个目录真的
    // 有 worktree 时才摆 —— 远端工作区没有本机 worktree，空目录那块也只是噪声。
    final worktrees = directory == null || directory.external
        ? null
        : directory.visibleWorktreeLifecycle;
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 28),
        children: [
          AirDirectoryStats(
            tasks: all,
            worktreeCount: directory?.worktreeCount ?? 0,
          ),
          if (worktrees != null)
            AirWorktreePanel(
              lifecycle: worktrees,
              idleMs: data?.worktreePolicy.idleMs ?? 0,
              busy: _reclaiming,
              onReclaim: () => _reclaimWorktrees(directory!),
            ),
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
          // Web `air.html` 的 `.section-heading`：左边两行（小字 `当前目录` + 粗体
          // `最近任务`），右边一个 `#directory-overview-count`。两条筛选 chip 换成了
          // 这一行 —— Web 那份默认就带着归档行，「未完成 / 全部」在这里没有对位。
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      '当前目录',
                      style: TextStyle(color: AppColors.faint, fontSize: 11.5),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      _showAll ? '全部任务' : '最近任务',
                      key: const ValueKey('air-tasks-heading'),
                      style: const TextStyle(
                        color: AppColors.text,
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    padding: const EdgeInsets.all(2),
                    decoration: BoxDecoration(
                      color: AppColors.bgSoft,
                      borderRadius: BorderRadius.circular(9),
                      border: Border.all(color: AppColors.line),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        _taskSortButton(_DirectoryTaskSort.message, '消息'),
                        _taskSortButton(_DirectoryTaskSort.visit, '访问'),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    _showAll
                        ? '${tasks.length} / ${all.length} 个任务'
                        : '${all.length} 个任务',
                    key: const ValueKey('air-tasks-count'),
                    style: const TextStyle(
                      color: AppColors.faint,
                      fontSize: 11.5,
                    ),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (_showAll) ...[
            Row(
              children: [
                Expanded(
                  child: TextField(
                    key: const ValueKey('air-directory-task-search'),
                    controller: _taskSearch,
                    onChanged: (value) => setState(() => _taskQuery = value),
                    style: const TextStyle(color: AppColors.text, fontSize: 13),
                    decoration: sheetInputDecoration(hint: '搜索任务标题'),
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  width: 145,
                  child: DropdownButtonFormField<_DirectoryTaskStatus>(
                    key: const ValueKey('air-directory-task-status'),
                    value: _taskStatus,
                    isExpanded: true,
                    decoration: sheetInputDecoration(hint: ''),
                    dropdownColor: AppColors.panel,
                    items: const [
                      DropdownMenuItem(
                        value: _DirectoryTaskStatus.open,
                        child: Text('进行中与待处理'),
                      ),
                      DropdownMenuItem(
                        value: _DirectoryTaskStatus.all,
                        child: Text('全部记录'),
                      ),
                      DropdownMenuItem(
                        value: _DirectoryTaskStatus.archived,
                        child: Text('已归档'),
                      ),
                    ],
                    onChanged: (value) {
                      if (value != null) setState(() => _taskStatus = value);
                    },
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
          ],
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
          if (_showAll && tasks.isNotEmpty)
            SizedBox(
              key: const ValueKey('air-directory-task-scroll'),
              height: 390,
              child: ListView.separated(
                primary: false,
                itemCount: tasks.length,
                separatorBuilder: (_, _) => const SizedBox(height: 10),
                itemBuilder: (_, index) => _directoryTaskTile(tasks[index]),
              ),
            )
          else if (!_showAll)
            for (final task in tasks) ...[
              _directoryTaskTile(task),
              const SizedBox(height: 10),
            ],
          // Web `#directory-task-more`：列表是截过的，这条是留给剩下那些的出口。
          // 两端都在当前目录页就地展开固定高度的完整清单。
          if (all.length > tasks.length || _showAll)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                key: const ValueKey('air-tasks-more'),
                onPressed: () => setState(() {
                  _showAll = !_showAll;
                  if (!_showAll) {
                    _taskQuery = '';
                    _taskStatus = _DirectoryTaskStatus.open;
                    _taskSearch.clear();
                  }
                }),
                child: Text(
                  _showAll ? '收起，返回最近任务' : '查看全部 ${all.length} 个任务 ›',
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _directoryTaskTile(AirTask task) {
    final pinned = _data?.isPinned(task.id) ?? false;
    return AirTaskTile(
      key: ValueKey('air-directory-task-${task.id}'),
      task: task,
      showTime: MediaQuery.sizeOf(context).width > 380,
      timeAt: _taskSortAt(task),
      onTap: () => unawaited(_open(task)),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Pin 的开关在 App 里落在这一处（Web 是页头那颗 📌）：打开任务在 App 里
          // 是把聊天页整张升起来盖住 Air 首页的，页头那排工具那时点不到 —— 这一行
          // 是任务在「列表里的样子」，钉住/取消钉住正好属于它。
          AirTaskRowAction(
            key: ValueKey('air-task-pin-${task.id}'),
            onPressed: () => unawaited(_togglePin(task)),
            tooltip: pinned ? '取消 Pin' : 'Pin 到任务列表顶部',
            icon: Icon(
              pinned ? Icons.push_pin_rounded : Icons.push_pin_outlined,
              color: pinned ? AppColors.accent : AppColors.faint,
            ),
          ),
          AirTaskRowAction(
            key: ValueKey('air-task-details-${task.id}'),
            onPressed: () => unawaited(_openDetails(task)),
            tooltip: '任务详情',
            icon: const Icon(
              Icons.info_outline_rounded,
              color: AppColors.faint,
            ),
          ),
          AirTaskRowAction(
            key: ValueKey('air-task-delete-${task.id}'),
            onPressed: () => unawaited(_deleteTaskFromList(task)),
            tooltip: '删除任务',
            icon: const Icon(
              Icons.delete_outline_rounded,
              color: AppColors.danger,
            ),
          ),
        ],
      ),
    );
  }

  /// 钉住 / 取消钉住一个任务，清单落在服务端（`air-pins.json`）—— 和 Web 读的
  /// 是同一份，所以手机上钉住的任务在电脑的页头顶上也会出现。
  ///
  /// 页头标签超出可见宽度时由 Web 的单行横向滚动承接；App 侧仍把同一批
  /// Pin 放在任务列表最前面，不再设置「最多 5 个」的交互限制。
  Future<void> _togglePin(AirTask task) async {
    final wasPinned = _data?.isPinned(task.id) ?? false;
    try {
      await _service.toggleTaskPin(task.id);
      if (!mounted) return;
      await _refresh();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            wasPinned ? '已取消 Pin「${task.title}」' : '已 Pin 住「${task.title}」',
          ),
          duration: const Duration(seconds: 2),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(error.toString().replaceFirst('Exception: ', '')),
        ),
      );
    }
  }

  Future<void> _deleteTaskFromList(AirTask task) async {
    final deleted = await deleteAirTaskWithConfirmation(
      context: context,
      service: _service,
      taskId: task.id,
      title: task.title,
      keyPrefix: 'air-directory-${task.id}',
    );
    if (deleted && mounted) await _refresh();
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

/// 目录首页顶部那道 Chat / Terminal 切换（Web `public/air.html` 的 `#directory-mode`）。
///
/// 排在整个目录页的最前面 —— 切哪一类都不用先去侧栏里找一遍。默认 Chat：模式由
/// 宿主持有，换目录 / 重进首页都回到 Chat（见 `_AirTasksViewState._dirMode`）。
class _DirectoryModeSwitch extends StatelessWidget {
  const _DirectoryModeSwitch({required this.mode, required this.onChanged});

  final _DirectoryMode mode;
  final ValueChanged<_DirectoryMode> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const ValueKey('air-directory-mode'),
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 0),
      child: Container(
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(
          color: AppColors.bg,
          border: Border.all(color: AppColors.line),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          children: [
            _DirectoryModeButton(
              keyName: 'air-directory-mode-chat',
              icon: Icons.chat_bubble_outline_rounded,
              label: 'Chat',
              selected: mode == _DirectoryMode.chat,
              onTap: () => onChanged(_DirectoryMode.chat),
            ),
            const SizedBox(width: 3),
            _DirectoryModeButton(
              keyName: 'air-directory-mode-terminal',
              icon: Icons.terminal_rounded,
              label: 'Terminal',
              selected: mode == _DirectoryMode.terminal,
              onTap: () => onChanged(_DirectoryMode.terminal),
            ),
          ],
        ),
      ),
    );
  }
}

class _DirectoryModeButton extends StatelessWidget {
  const _DirectoryModeButton({
    required this.keyName,
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String keyName;
  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = selected ? AppColors.accent : AppColors.muted;
    return Expanded(
      child: InkWell(
        key: ValueKey(keyName),
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(
            color: selected ? AppColors.panel : null,
            borderRadius: BorderRadius.circular(8),
            boxShadow: selected
                ? [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.06),
                      blurRadius: 6,
                      offset: const Offset(0, 2),
                    ),
                  ]
                : null,
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 14, color: color),
              const SizedBox(width: 6),
              Text(
                label,
                style: TextStyle(
                  color: color,
                  fontSize: 12.5,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Terminal 模式下的一行终端会话（Web 侧栏那组 `›_ label` 链接的同款）。
class _DirectoryTerminalRow extends StatelessWidget {
  const _DirectoryTerminalRow({required this.session, required this.onTap});

  final AirSession session;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
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
        leading: const Icon(
          Icons.terminal_rounded,
          size: 18,
          color: AppColors.muted,
        ),
        title: Text(
          session.label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(color: AppColors.text, fontSize: 13.5),
        ),
        subtitle: session.cli.isEmpty
            ? null
            : Text(
                session.cli,
                style: const TextStyle(color: AppColors.faint, fontSize: 11),
              ),
        trailing: const Icon(
          Icons.chevron_right_rounded,
          size: 18,
          color: AppColors.faint,
        ),
      ),
    );
  }
}
