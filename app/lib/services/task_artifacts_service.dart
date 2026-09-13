import 'dart:async';
import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../models/task_artifact.dart';
import 'settings_service.dart';

/// 产物列表的取数（Web `task-artifacts.js` 的 `refreshList`）。
class TaskArtifactsService {
  TaskArtifactsService({required this.settings, http.Client? httpClient})
    : _httpClient = httpClient ?? http.Client();

  final SettingsService settings;
  final http.Client _httpClient;

  /// scope 二选一：会话所在的 shell，或直接是任务 id（Air 任务详情用）。
  Future<TaskArtifactList> fetch({String? shellId, String? taskId}) async {
    final path = (shellId != null && shellId.isNotEmpty)
        ? '/api/task-shells/${Uri.encodeComponent(shellId)}/artifacts'
        : '/api/task-shell-tasks/${Uri.encodeComponent(taskId ?? '')}/artifacts';
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
    // 15s 跟 web 的 AbortController 超时一致。
    final res = await _httpClient
        .get(Uri.parse(settings.buildHttpUrl(path)), headers: headers)
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 400) {
      throw http.ClientException('HTTP ${res.statusCode}');
    }
    final body = jsonDecode(res.body);
    if (body is! Map) throw const FormatException('artifacts: 非对象响应');
    return TaskArtifactList.fromJson(Map<String, dynamic>.from(body));
  }
}

/// 面板底部那行状态（Web 的 `.task-artifacts-status`，空串时整行不显示）。
enum TaskArtifactsStatus { none, loading, failed, copied, copyFailed }

/// 产物边栏的状态机（Web `task-artifacts.js` 的模块级状态 + `poll`）。
///
/// 由聊天页持有：页头的「产物 N」要读条数，面板要读列表，两者必须看同一份。
class TaskArtifactsController extends ChangeNotifier {
  TaskArtifactsController({
    required this.settings,
    this.isAlive = _alwaysAlive,
    TaskArtifactsService? service,
  }) : _service = service ?? TaskArtifactsService(settings: settings);

  static bool _alwaysAlive() => true;

  final SettingsService settings;
  final TaskArtifactsService _service;

  /// 页面还在不在树上 —— 不在就该彻底停手，别让定时器拖着请求。
  final bool Function() isAlive;

  String? _shellId;
  String? _taskId;
  String _title = '';
  List<TaskArtifact> _items = const [];
  String _query = '';
  TaskArtifactsStatus _status = TaskArtifactsStatus.none;
  bool _open = false;
  bool _requestInFlight = false;
  bool _loaded = false;
  Timer? _timer;
  int _generation = 0;
  // 自己记住「已销毁」：在途请求回来时页面可能已经没了，即便调用方没给
  // isAlive，也不该再往一个死掉的 notifier 上通知。
  bool _disposed = false;

  List<TaskArtifact> get items => List.unmodifiable(_items);
  String get title => _title;
  String? get taskId => _taskId;
  bool get open => _open;
  TaskArtifactsStatus get status => _status;

  /// 页头那颗入口的文案。还没拿到 shell 时没有入口，跟 web 一样
  /// （`refreshList` 在没有 scope 时直接返回，连按钮都不建）。
  bool get available => _shellId != null;
  bool get hasQuery => _query.isNotEmpty;

  /// 这个 scope 至少成功拉回来过一次 —— 页头那颗入口靠它决定要不要带条数
  /// （web 也是拉到了才把按钮文案改成「产物 N」）。
  bool get loaded => _loaded;

  /// 在途请求回来时页面可能已经没了 —— 从这儿统一出去，销毁后一律闭嘴。
  void _notify() {
    if (_disposed) return;
    notifyListeners();
  }

  /// 搜索过滤后的可见行（web 在 `title + url` 上做小写包含匹配）。
  List<TaskArtifact> get visible {
    if (_query.isEmpty) return items;
    final q = _query.toLowerCase();
    return _items
        .where((a) => '${a.title} ${a.url}'.toLowerCase().contains(q))
        .toList();
  }

  /// 每一帧喊一次：会话所在的 shell 变了就换 scope。跟 Web 的 `setScope` 一样，
  /// 换 scope 会清空列表、收起面板、重新拉一次。
  void syncScope(String? shellId) {
    final next = (shellId == null || shellId.isEmpty) ? null : shellId;
    if (next == _shellId) return;
    _shellId = next;
    // 在途请求作废（web 的 `request?.abort()` + generation 双保险）。
    _generation++;
    _items = const [];
    _taskId = null;
    _query = '';
    _title = '';
    _status = TaskArtifactsStatus.loading;
    _loaded = false;
    _open = false;
    if (next != null) unawaited(refresh());
    _notify();
  }

  void setQuery(String value) {
    if (_query == value) return;
    _query = value;
    _notify();
  }

  Future<void> setOpen(bool value, {bool persist = true}) async {
    _open = value;
    _status = TaskArtifactsStatus.none;
    _notify();
    if (value) unawaited(refresh());
    if (persist) await _persistOpen(value);
  }

  void markCopied(bool ok) {
    _status = ok ? TaskArtifactsStatus.copied : TaskArtifactsStatus.copyFailed;
    _notify();
  }

  Future<void> refresh() async {
    final shellId = _shellId;
    if (shellId == null || _requestInFlight || _disposed) return;
    final generation = _generation;
    _requestInFlight = true;
    try {
      final data = await _service.fetch(shellId: shellId);
      if (_disposed || !isAlive() || generation != _generation) return;
      if (data.taskId != _taskId) {
        // 换了任务：搜索、列表、展开状态全部重来，然后读回这个任务上次的
        // 展开偏好（web 的 `task-artifacts:<taskId>`）。
        _taskId = data.taskId;
        _query = '';
        _items = const [];
        _title = '';
        _open = await _restoreOpen(data.taskId);
      }
      _title = data.title;
      _items = data.items;
      _loaded = true;
      _status = TaskArtifactsStatus.none;
      _notify();
    } catch (_) {
      if (_disposed || !isAlive() || generation != _generation) return;
      _status = TaskArtifactsStatus.failed;
      _notify();
    } finally {
      _requestInFlight = false;
    }
  }

  Future<void> _persistOpen(bool value) async {
    final taskId = _taskId;
    if (taskId == null) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool('task-artifacts:$taskId', value);
    } catch (_) {
      // 存不下就下次默认收起，不值得为此打扰用户。
    }
  }

  Future<bool> _restoreOpen(String? taskId) async {
    if (taskId == null) return false;
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getBool('task-artifacts:$taskId') ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Web 的 `poll`：**打开时 5s、收起时 15s**，页面不可见就跳过这一轮。
  void startPolling() {
    _timer?.cancel();
    void schedule() {
      if (!isAlive()) return;
      _timer = Timer(Duration(seconds: _open ? 5 : 15), () {
        if (!isAlive()) return;
        if (WidgetsBinding.instance.lifecycleState ==
            AppLifecycleState.resumed) {
          unawaited(refresh());
        }
        schedule();
      });
    }

    schedule();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    super.dispose();
  }
}
