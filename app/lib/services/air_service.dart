import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'settings_service.dart';

/// 状态词表，逐条对齐 Web Air（`public/air.js` 的 `stateNames`）。两套界面
/// 说同一件事就得用同一个词，否则「等待目录容量」和「排队中」会被当成两回事。
const Map<String, String> airStateNames = {
  'active': '进行中',
  'succeeded': '成功',
  'unknown': '结果待核验',
  'failed': '失败',
  'error': '失败',
  'cancelled': '已取消',
  'workspace_execution_capacity': '等待执行名额',
  'workspace_resident_capacity': '等待目录容量',
  'workspace_restore_capacity': '等待目录准备名额',
  'planned': '执行时准备目录',
  'resident': '目录已准备',
  'retained': '目录已保留',
  'hibernated': '目录已休眠',
  'reserved': '准备执行',
  'materializing': '正在准备目录',
  'starting': '正在启动',
  'running': '执行中',
  'uncertain': '等待核实执行状态',
  'idle': '空闲',
  'queued': '排队中',
  'waiting': '等待回答',
  'archived': '已归档',
  'stale': '建议已过期',
  'inbox': '待处理',
  'ready': '待执行',
  'doing': '进行中',
  'review': '待验收',
  'done': '已完成',
};

String airLabel(String? value) =>
    (value == null || value.isEmpty) ? '' : (airStateNames[value] ?? value);

/// `/api/air` 的一个工作目录。
class AirDirectory {
  const AirDirectory({required this.id, required this.name, required this.path});

  final String id;
  final String name;
  final String path;

  static AirDirectory fromJson(Map<String, dynamic> json) => AirDirectory(
    id: '${json['id']}',
    name: '${json['name'] ?? ''}',
    path: '${json['path'] ?? ''}',
  );
}

/// `/api/air` 的一行任务。字段跟着 Air 的任务行走：状态、工作流阶段、资源占用
/// 三样是行上唯一要看的东西（见 `public/air.js` 的 `renderOverview`）。
class AirTask {
  const AirTask({
    required this.id,
    required this.dirId,
    required this.title,
    required this.status,
    required this.recordType,
    required this.updatedAt,
    required this.readOnly,
    this.workflowStage,
    this.sessionId,
    this.sourceSessionId,
    this.resource = const {},
  });

  final String id;
  final String dirId;
  final String title;
  final String status;
  final String recordType;
  final int updatedAt;
  final bool readOnly;
  final String? workflowStage;
  final String? sessionId;
  final String? sourceSessionId;
  final Map<String, dynamic> resource;

  static AirTask fromJson(Map<String, dynamic> json) => AirTask(
    id: '${json['id']}',
    dirId: '${json['dirId']}',
    title: '${json['title'] ?? ''}',
    status: '${json['status'] ?? ''}',
    recordType: '${json['recordType'] ?? ''}',
    updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
    readOnly: json['readOnly'] == true,
    workflowStage: json['workflowStage'] as String?,
    sessionId: json['sessionId'] as String?,
    sourceSessionId: json['sourceSessionId'] as String?,
    resource: (json['resource'] as Map?)?.cast<String, dynamic>() ?? const {},
  );

  /// 「完成」在 Air 里有两个词：工作流阶段走 done，归档走 archived。
  bool get closed => status == 'archived' || workflowStage == 'done';

  /// 这行卡在哪：先说容量/租约这类会自己好转的原因，没有才说目录是计划态还是
  /// 已经备好 —— 同 Web Air 的 `resourceText`。
  String get resourceText {
    final capacity = resource['capacityReason']?.toString();
    if (capacity != null && capacity.isNotEmpty) return airLabel(capacity);
    final lease = resource['lease']?.toString();
    if (lease != null && lease.isNotEmpty && lease != 'idle') {
      return airLabel(lease);
    }
    return airLabel(resource['residency']?.toString());
  }
}

/// `/api/air` 的一次快照。
class AirSnapshot {
  const AirSnapshot({
    required this.directories,
    required this.tasks,
    required this.clis,
    required this.sessions,
  });

  final List<AirDirectory> directories;
  final List<AirTask> tasks;
  final List<String> clis;

  /// 终端会话（Air 侧栏的 TERMINAL 一组）。只有移动端要用的字段。
  final List<Map<String, dynamic>> sessions;

  static AirSnapshot fromJson(Map<String, dynamic> json) => AirSnapshot(
    directories: ((json['directories'] as List?) ?? [])
        .map((e) => AirDirectory.fromJson((e as Map).cast<String, dynamic>()))
        .toList(),
    tasks: ((json['tasks'] as List?) ?? [])
        .map((e) => AirTask.fromJson((e as Map).cast<String, dynamic>()))
        .toList(),
    clis: ((json['clis'] as List?) ?? const []).map((e) => '$e').toList(),
    sessions: ((json['sessions'] as List?) ?? [])
        .map((e) => (e as Map).cast<String, dynamic>())
        .toList(),
  );

  AirDirectory? directoryOf(String? id) {
    for (final directory in directories) {
      if (directory.id == id) return directory;
    }
    return null;
  }

  /// 落在某个目录里的任务，最近更新的在前。
  List<AirTask> tasksOf(String? dirId) {
    final rows = tasks.where((task) => task.dirId == dirId).toList()
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return rows;
  }

  AirTask? taskOf(String? id) {
    if (id == null) return null;
    for (final task in tasks) {
      if (task.id == id) return task;
    }
    return null;
  }
}

/// `/api/air` 的客户端。Air 的任务创建是三步事务（建任务 → 绑角色 → 发第一条
/// 消息），所以三步都收在这里，界面不需要知道中间的 clientMsgId 约定。
class AirService {
  AirService({required this.settings, http.Client? httpClient})
    : _http = httpClient ?? http.Client(),
      _ownsClient = httpClient == null;

  final SettingsService settings;
  final http.Client _http;
  final bool _ownsClient;

  Future<Map<String, dynamic>> _request(
    String path, {
    Map<String, dynamic>? body,
    String method = 'GET',
  }) async {
    final uri = Uri.parse(settings.buildHttpUrl(path));
    final headers = {
      'Content-Type': 'application/json',
      'X-Access-Token': settings.token,
    };
    final response = await (method == 'GET'
            ? _http.get(uri, headers: headers)
            : _http.post(uri, headers: headers, body: jsonEncode(body ?? {})))
        .timeout(const Duration(seconds: 30));
    final raw = utf8.decode(response.bodyBytes);
    Map<String, dynamic> result;
    try {
      result = Map<String, dynamic>.from(jsonDecode(raw) as Map);
    } catch (_) {
      // 拿回一整页 HTML 说明这个请求根本没落到 API 上（旧版服务没有这些路由），
      // 那句话比「无法识别的数据」有用得多。
      throw Exception(
        RegExp(r'<!doctype|<html', caseSensitive: false).hasMatch(raw)
            ? 'Air 服务接口尚未加载，请重启 MultiCC 服务后重试。'
            : 'Air 服务返回了无法识别的数据（HTTP ${response.statusCode}）。',
      );
    }
    if (response.statusCode >= 400 || result['ok'] == false) {
      throw Exception(
        result['message'] ?? result['code'] ?? 'HTTP ${response.statusCode}',
      );
    }
    return result;
  }

  Future<AirSnapshot> load() async =>
      AirSnapshot.fromJson(await _request('/api/air'));

  /// 任务行点开时用它换出可以续接的会话：只读（观察来的）任务只能回到它原来的
  /// 会话，不能在这里接管。
  Future<Map<String, dynamic>> openTask(String taskId) =>
      _request('/api/air/tasks/${Uri.encodeComponent(taskId)}');

  /// 建任务。第一条消息由 [sendFirstMessage] 单独发出，中途失败时任务已经存在
  /// —— Web Air 会退回目录并把草稿留在会话存储里，这里用同样的顺序。
  Future<String> createTask({
    required String dirId,
    required String title,
    required String clientMsgId,
    String? cli,
    String? rolePrompt,
  }) async {
    final result = await _request(
      '/api/air/tasks',
      body: {
        'dirId': dirId,
        'title': title,
        'clientMsgId': clientMsgId,
        if (cli != null && cli.isNotEmpty) 'cli': cli,
        if (rolePrompt != null && rolePrompt.trim().isNotEmpty)
          'rolePrompt': rolePrompt.trim(),
      },
    );
    return '${result['taskId']}';
  }

  Future<void> sendFirstMessage({
    required String taskId,
    required String text,
    required String clientMsgId,
    bool goal = false,
    int? goalRounds,
    int? goalBudget,
  }) => _request(
    '/api/task-shell-tasks/${Uri.encodeComponent(taskId)}/messages',
    body: {
      'text': text,
      'clientMsgId': clientMsgId,
      'intent': 'work',
      if (goal) 'goal': true,
      if (goal)
        'goalLimits': {
          if (goalRounds != null) 'rounds': goalRounds,
          if (goalBudget != null) 'tokenBudget': goalBudget,
        },
    },
  );

  Future<void> addDirectory({
    required String name,
    required String path,
  }) => _request(
    '/api/directories',
    body: {'name': name, 'path': path, 'create': false},
  );

  void close() {
    if (_ownsClient) _http.close();
  }
}

/// Air 的两条「手边记录」：收藏的目录、打开过的任务。和 Web Air 一样存在本机
/// （那边是 localStorage，这边是 SharedPreferences），键名保持一致，方便对照。
class AirLocalStore {
  AirLocalStore._(this._prefs);

  static const _favoritesKey = 'air:favorites';
  static const _recentKey = 'air:recent-tasks';
  static const _recentLimit = 24;

  final SharedPreferences _prefs;

  static Future<AirLocalStore> load() async =>
      AirLocalStore._(await SharedPreferences.getInstance());

  List<String> get favorites => _prefs.getStringList(_favoritesKey) ?? const [];

  List<String> get recentTasks => _prefs.getStringList(_recentKey) ?? const [];

  /// 收藏最多 5 个；再多就不是「手边」而是另一个目录列表了（同 Web Air 的
  /// `favorites.length < 5`）。
  static const favoriteLimit = 5;

  bool isFavorite(String dirId) => favorites.contains(dirId);

  Future<void> toggleFavorite(String dirId) async {
    final next = favorites.toList();
    if (next.remove(dirId)) {
      // 已经收藏 → 取消。
    } else {
      if (next.length >= favoriteLimit) next.removeAt(0);
      next.add(dirId);
    }
    await _prefs.setStringList(_favoritesKey, next);
  }

  Future<void> rememberTask(String taskId) async {
    final next = recentTasks.toList()..remove(taskId);
    next.insert(0, taskId);
    await _prefs.setStringList(
      _recentKey,
      next.take(_recentLimit).toList(),
    );
  }

  /// 收藏/最近里指向已经被删掉的目录或任务时，把它们从两份记录里清出去，免得
  /// 侧栏留着一个点不开的名字。
  Future<void> prune({
    required Set<String> directoryIds,
    required Set<String> taskIds,
  }) async {
    final keptFavorites = favorites.where(directoryIds.contains).toList();
    if (keptFavorites.length != favorites.length) {
      await _prefs.setStringList(_favoritesKey, keptFavorites);
    }
    final keptRecent = recentTasks.where(taskIds.contains).toList();
    if (keptRecent.length != recentTasks.length) {
      await _prefs.setStringList(_recentKey, keptRecent);
    }
  }
}

/// 一次创建动作的两个幂等键。想清楚「同一次重试」和「改了内容再点一次」的区别
/// 是服务端去重的依据：内容指纹没变就复用同一个 id，内容变了就换新的。
class AirCreateAttempt {
  AirCreateAttempt(this.fingerprint, this.createId, this.sendId);

  static int _seq = 0;

  static String _nextId() =>
      'app-air-${DateTime.now().microsecondsSinceEpoch}-${_seq++}';

  final String fingerprint;
  final String createId;
  final String sendId;

  static AirCreateAttempt forFingerprint(
    String fingerprint,
    AirCreateAttempt? previous,
  ) {
    if (previous != null && previous.fingerprint == fingerprint) return previous;
    return AirCreateAttempt(fingerprint, _nextId(), _nextId());
  }
}
