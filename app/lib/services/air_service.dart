import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../models/message.dart';
import 'settings_service.dart';
import 'session_service.dart';

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

/// 页头顶上那排「齐刘海」最多放得下几个。上限由服务端把着（第 6 个回
/// `pin_limit_reached`），这里这个数只用来先把话说在前面。
const int airPinLimit = 5;

/// 任务生命周期动作（归档/恢复、移动、删除）的错误码 → 文案，逐条对着 Web
/// `public/air.js` 的 `TASK_ACTION_ERRORS` 抄。
///
/// 这三个动作是一次性、不可撤销的写，失败原因又几乎全是「现在还不能做」这类
/// 业务判断（任务在跑、工作区有未提交改动、壳被别的任务共用）。服务端只回一个
/// code，把 code 原样丢给用户等于什么都没说；Web 也是先过这张表再退回原文。
const Map<String, String> airTaskActionErrors = {
  'task_busy': '任务正在执行或排队中，等它空闲下来再操作。',
  'task_archived': '任务已归档。',
  'task_deleting': '任务正在删除中，请稍等。',
  'title_required': '任务标题不能为空。',
  'title_too_long': '任务标题最多 40 个字符。',
  'task_workspace_dirty': '工作区还有未提交改动，需要再次确认后才能删除。',
  'task_workspace_unmerged': '工作区还有未合并到基分支的提交，需要再次确认后才能删除。',
  'task_session_shared': '会话还被其他任务共享，无法删除。',
  'shell_workspace_referenced': '工作区被其他会话引用，无法删除。',
  'task_shell_shared': '任务的会话壳还挂着别的任务，不能整体移动。',
  'carry_apply_failed': '未提交改动套用到目标仓库失败（两个目录的代码上下文不兼容），任务仍留在原处。',
  'active': '会话仍活跃，请稍后再试。',
  'unmerged': '还有未合并到基分支的提交：请先在任务详情里合并，再移动。',
};

/// 归档 / 恢复 / 移动 / 删除失败。带上服务端的 `error` code，界面才能按
/// [airTaskActionErrors] 说话（Web 的 `taskActionError(error)` 读的也是它）。
class AirTaskActionException implements Exception {
  const AirTaskActionException(this.code, {this.reasons = const []});

  /// 服务端错误码（`task_busy` 这类），不是 HTTP 状态码。
  final String code;

  /// 同一个工作区可以同时既 dirty、又有未合入提交；删除确认要一次说全。
  final List<String> reasons;

  @override
  String toString() => airTaskActionErrors[code] ?? '操作失败（$code）。';
}

/// 这行卡在哪：先说容量/租约这类会自己好转的原因，没有才说目录是计划态还是已经
/// 备好 —— 同 Web Air 的 `resourceText`。任务行和详情面板都要这一句，所以放在
/// 这里而不是任一处界面代码里。
String airResourceText(Map<String, dynamic>? resource) {
  if (resource == null) return '';
  final capacity = resource['capacityReason']?.toString();
  if (capacity != null && capacity.isNotEmpty) return airLabel(capacity);
  final lease = resource['lease']?.toString();
  if (lease != null && lease.isNotEmpty && lease != 'idle')
    return airLabel(lease);
  return airLabel(resource['residency']?.toString());
}

/// `/api/air` 的一个工作目录。
///
/// 也可以是一台**导入进来的远端工作区**（[external]）：Web 那边
/// `manage-fleet-sharing.js` 的 `dashboardData()` 把外部舰队铺成同一种目录记录，
/// 于是卡片、详情、会话操作全都走同一条路。这里照做 —— 列表里多出来的只是
/// 卡片上那行「共享工作区」和菜单里那几项远端动作。
class AirDirectory {
  const AirDirectory({
    required this.id,
    required this.name,
    required this.path,
    this.external = false,
    this.externalFleetId,
    this.interactive = false,
    this.worktreeCount = 0,
  });

  final String id;
  final String name;
  final String path;

  /// 远端导入进来的工作区（不是本机的目录）。
  final bool external;

  /// 远端那条记录的 id，刷新/移除/重新导入都拿它去 `/api/external-fleets`。
  final String? externalFleetId;

  /// 能不能在远端真的操作。由服务端手里那对授权决定，客户端只读。
  final bool interactive;

  /// Number of unique MultiCC task/session worktrees retained under this
  /// directory. It is inventory for manual linking/cleanup, never an automatic
  /// deletion signal.
  final int worktreeCount;

  static AirDirectory fromJson(Map<String, dynamic> json) => AirDirectory(
    id: '${json['id']}',
    name: '${json['name'] ?? ''}',
    path: '${json['path'] ?? ''}',
    external: json['external'] == true,
    externalFleetId: json['externalFleetId'] as String?,
    interactive: json['interactive'] == true,
    worktreeCount: (json['worktreeCount'] as num?)?.toInt() ?? 0,
  );

  /// 把一台外部舰队铺成目录记录。`path` 位放源站 —— 本机没有它的目录，
  /// 拿真路径填只会让人以为那是本地路径。
  static AirDirectory fromExternalFleet(ExternalFleet fleet) => AirDirectory(
    id: fleet.id,
    name: fleet.name,
    path: fleet.sourceOrigin,
    external: true,
    externalFleetId: fleet.id,
    interactive: fleet.interactive,
    worktreeCount: 0,
  );
}

/// 一条工作区分享（`src/fleet-sharing.js` 的 `publicShare`）。
///
/// 「还能导入几次」服务端已经算好了 —— 客户端不去拿 `maxAccesses` 减
/// `accessCount`：这两个数在列表返回之后还会被远端导入改掉，自己算只会算出
/// 一个比真相好看的数。
class FleetShare {
  const FleetShare({
    required this.token,
    required this.url,
    required this.expiresAt,
    required this.maxAccesses,
    required this.accessCount,
    required this.remainingAccesses,
    required this.expired,
    this.description = '',
  });

  final String token;

  /// 完整的分享链接，服务端按请求的 origin 拼好（`/fleet-share/<token>`）。
  final String url;
  final DateTime? expiresAt;
  final int maxAccesses;
  final int accessCount;

  /// 剩余可导入次数，服务端给的。
  final int remainingAccesses;
  final bool expired;
  final String description;

  static FleetShare fromJson(Map<String, dynamic> json) => FleetShare(
    token: '${json['token'] ?? ''}',
    url: '${json['url'] ?? ''}',
    expiresAt: DateTime.tryParse('${json['expiresAt'] ?? ''}'),
    maxAccesses: (json['maxAccesses'] as num?)?.toInt() ?? 0,
    accessCount: (json['accessCount'] as num?)?.toInt() ?? 0,
    remainingAccesses: (json['remainingAccesses'] as num?)?.toInt() ?? 0,
    expired: json['expired'] == true,
    description: '${json['description'] ?? ''}',
  );
}

/// 一台被导入的远端工作区（`src/fleet-sharing.js` 的 `publicExternal`）。
///
/// [interactive] 是「能不能在远端真的操作」：它由服务端手里那对 grant/token
/// 决定，客户端说了不算，所以原样读出来。
class ExternalFleet {
  const ExternalFleet({
    required this.id,
    required this.name,
    required this.sourceOrigin,
    required this.shareUrl,
    required this.sourceFleetId,
    required this.sessionCount,
    required this.interactive,
    this.alias = '',
    this.remoteName = '',
    this.description = '',
  });

  final String id;

  /// 本地别名优先，没有就用远端自己的名字（同 `publicExternal` 的 `name`）。
  final String name;
  final String alias;
  final String remoteName;

  /// 远端实例的源站，卡片上当路径位显示。
  final String sourceOrigin;
  final String shareUrl;
  final String sourceFleetId;
  final int sessionCount;
  final bool interactive;
  final String description;

  static ExternalFleet fromJson(Map<String, dynamic> json) => ExternalFleet(
    id: '${json['id'] ?? ''}',
    name: '${json['name'] ?? ''}',
    alias: '${json['alias'] ?? ''}',
    remoteName: '${json['remoteName'] ?? ''}',
    sourceOrigin: '${json['sourceOrigin'] ?? ''}',
    shareUrl: '${json['shareUrl'] ?? ''}',
    sourceFleetId: '${json['sourceFleetId'] ?? ''}',
    sessionCount: (json['sessionCount'] as num?)?.toInt() ?? 0,
    interactive: json['interactive'] == true,
    description: '${json['description'] ?? ''}',
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
    this.lastMessageAt = 0,
    this.workflowStage,
    this.sessionId,
    this.sourceSessionId,
    this.runState,
    this.resource = const {},
  });

  final String id;
  final String dirId;
  final String title;

  /// 生命周期，只有 `active` / `done` / `archived` 三个取值 —— 「执行中」不在里
  /// 面（同 `src/workspace/air-routes.js`）。要问「这一轮在不在跑」看 [runState]。
  final String status;
  final String recordType;
  final int updatedAt;

  /// Latest conversation message. Unlike [updatedAt], metadata-only edits do
  /// not move this clock.
  final int lastMessageAt;
  final bool readOnly;
  final String? workflowStage;
  final String? sessionId;
  final String? sourceSessionId;

  /// 这一轮的运行状态，由队列事件折出来（服务端 `task-board/normalize.js` 的
  /// TASK_RUN_STATES）。客户端只读它，不从 [status] 猜。
  final String? runState;
  final Map<String, dynamic> resource;

  static AirTask fromJson(Map<String, dynamic> json) => AirTask(
    id: '${json['id']}',
    dirId: '${json['dirId']}',
    title: '${json['title'] ?? ''}',
    status: '${json['status'] ?? ''}',
    recordType: '${json['recordType'] ?? ''}',
    updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
    lastMessageAt:
        (json['lastMessageAt'] as num?)?.toInt() ??
        (json['updatedAt'] as num?)?.toInt() ??
        0,
    readOnly: json['readOnly'] == true,
    workflowStage: json['workflowStage'] as String?,
    sessionId: json['sessionId'] as String?,
    sourceSessionId: json['sourceSessionId'] as String?,
    runState: json['runState'] as String?,
    resource: (json['resource'] as Map?)?.cast<String, dynamic>() ?? const {},
  );

  /// 「完成」在 Air 里有两个词：工作流阶段走 done，归档走 archived。
  bool get closed => status == 'archived' || workflowStage == 'done';

  String get resourceText => airResourceText(resource);
}

/// `/api/air` 的一次快照。
class AirSnapshot {
  const AirSnapshot({
    required this.directories,
    required this.tasks,
    required this.clis,
    required this.sessions,
    this.taskPins = const [],
    this.externalFleets = const [],
  });

  final List<AirDirectory> directories;
  final List<AirTask> tasks;
  final List<String> clis;

  /// 终端会话（目录首页 Terminal 模式那一份）。只有移动端要用的字段。
  final List<AirSession> sessions;

  /// Pin 住的任务 id，顺序就是用户钉的顺序（Web 页头从左到右 / 侧栏从上到下）。
  /// 清单住在服务端（`air-pins.json`），所以 Web、这台手机、另一台手机看到的是
  /// 同一份 —— 这也是它不放在 SharedPreferences 里的原因。
  final List<String> taskPins;

  /// 导入进来的远端工作区。它们同时也以 [AirDirectory] 的样子出现在
  /// [directories] 里 —— 这里额外留一份原始记录，好知道「别名、分享链接、
  /// 能不能操作」这些目录记录放不下的字段。
  final List<ExternalFleet> externalFleets;

  static AirSnapshot fromJson(
    Map<String, dynamic> json, {
    List<ExternalFleet> externalFleets = const [],
  }) => AirSnapshot(
    directories: [
      ...((json['directories'] as List?) ?? []).map(
        (e) => AirDirectory.fromJson((e as Map).cast<String, dynamic>()),
      ),
      ...externalFleets.map(AirDirectory.fromExternalFleet),
    ],
    tasks: ((json['tasks'] as List?) ?? [])
        .map((e) => AirTask.fromJson((e as Map).cast<String, dynamic>()))
        .toList(),
    clis: ((json['clis'] as List?) ?? const []).map((e) => '$e').toList(),
    sessions: ((json['sessions'] as List?) ?? [])
        .map((e) => AirSession.fromJson((e as Map).cast<String, dynamic>()))
        .toList(),
    taskPins: ((json['taskPins'] as List?) ?? const [])
        .map((e) => '$e')
        .toList(),
    externalFleets: externalFleets,
  );

  /// 这个任务被 pin 住了吗。
  bool isPinned(String? taskId) => taskId != null && taskPins.contains(taskId);

  AirDirectory? directoryOf(String? id) {
    for (final directory in directories) {
      if (directory.id == id) return directory;
    }
    return null;
  }

  /// 这个目录背后的远端记录（本机目录返回 null）。
  ExternalFleet? externalFleetOf(String? id) {
    if (id == null) return null;
    for (final fleet in externalFleets) {
      if (fleet.id == id) return fleet;
    }
    return null;
  }

  /// 落在某个目录里的终端会话（Web `air-directory-mode.js` 里
  /// `session.dirId === directoryId` 那一步筛选，两边同一条判据）。服务端已经把
  /// aux / gateway 摘掉了，这里只按目录分。
  List<AirSession> terminalSessionsOf(String? dirId) =>
      sessions.where((s) => s.dirId == dirId).toList();

  /// 落在某个目录里的任务，最后消息最近的在前。
  List<AirTask> tasksOf(String? dirId) {
    final rows = tasks.where((task) => task.dirId == dirId).toList()
      ..sort((a, b) => b.lastMessageAt.compareTo(a.lastMessageAt));
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

/// 目录首页 Terminal 模式里的一个终端会话。
///
/// `/api/air` 的 `sessions` 只给移动端要用的四个字段（服务端已经滤掉
/// aux / gateway），打开时拿 id 去会话表里换一个完整的 [Session]；换不到
/// （隐藏记录不在 `/api/sessions` 里）就退回这四个字段自己拼一个 ——
/// `TerminalScreen` 要的就是 id 和 label。
class AirSession {
  const AirSession({
    required this.id,
    required this.dirId,
    required this.label,
    required this.cli,
  });

  final String id;
  final String? dirId;
  final String label;
  final String cli;

  static AirSession fromJson(Map<String, dynamic> json) {
    final id = '${json['id'] ?? ''}';
    final label = '${json['label'] ?? ''}'.trim();
    return AirSession(
      id: id,
      dirId: json['dirId']?.toString(),
      // 服务端发的是 `s.label || s.id`，空 label 也兜回 id（同 Web 的行文案）。
      label: label.isEmpty ? id : label,
      cli: '${json['cli'] ?? ''}',
    );
  }

  /// 只够 TerminalScreen 用的最小会话（会话表里查不到时的兜底）。
  ///
  /// 快照里没有 createdAt，用「现在」顶上：这个字段在终端页只当元数据看，
  /// 拿不到真实值也不该让一整行终端打不开。
  Session toSession() => Session(
    id: id,
    dirId: dirId,
    label: label,
    cli: parseCli(cli),
    kind: SessionKind.terminal,
    createdAt: DateTime.now(),
  );
}

/// 任务的一个角色绑定：名字 + 说明。一个任务最多 8 个，上限由服务端把关
/// （src/task-shell/role-bindings.js），这里不重复实现一遍。
class AirRoleBinding {
  const AirRoleBinding({required this.name, required this.prompt});

  final String name;
  final String prompt;

  static AirRoleBinding fromJson(Map<String, dynamic> json) => AirRoleBinding(
    name: '${json['name'] ?? ''}',
    prompt: '${json['prompt'] ?? ''}',
  );

  Map<String, dynamic> toJson() => {'name': name, 'prompt': prompt};
}

/// 任务当前的角色绑定，连同它的版本号。写回时必须带上这个版本 —— 没有它就
/// 成了盲写，两个页面同时改会互相覆盖。
class AirRoleBindings {
  const AirRoleBindings({required this.version, required this.bindings});

  const AirRoleBindings.empty() : version = 0, bindings = const [];

  final int version;
  final List<AirRoleBinding> bindings;

  static AirRoleBindings fromJson(Map<String, dynamic>? json) {
    if (json == null) return const AirRoleBindings.empty();
    return AirRoleBindings(
      version: (json['version'] as num?)?.toInt() ?? 0,
      bindings: ((json['bindings'] as List?) ?? const [])
          .map(
            (e) => AirRoleBinding.fromJson((e as Map).cast<String, dynamic>()),
          )
          .toList(),
    );
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

  /// 读。写要走 [_post] —— 这里刻意不留一个「可选的方法」参数：它默认 GET 的
  /// 时候，建任务、发第一条消息、加目录三个调用点全都静悄悄变成了带 body 的
  /// GET（body 进不了请求，服务端当它不存在），而界面看起来一切正常。
  Future<Map<String, dynamic>> _get(String path) => _send('GET', path);

  /// 写。第二个参数是请求体，空对象也行 —— 有些路由（核验交付）本来就没有参数。
  Future<Map<String, dynamic>> _post(
    String path, [
    Map<String, dynamic>? body,
  ]) => _send('POST', path, body);

  /// 删。撤销分享、移除共享工作区都是 DELETE，用 `_post` 发过去服务端只会当
  /// 路由不存在。
  Future<Map<String, dynamic>> _delete(String path) => _send('DELETE', path);

  Future<Map<String, dynamic>> _send(
    String method,
    String path, [
    Map<String, dynamic>? body,
  ]) async {
    final response = await _request(method, path, body);
    final result = _decode(response);
    if (response.statusCode >= 400 || result['ok'] == false) {
      throw Exception(
        result['message'] ?? result['code'] ?? 'HTTP ${response.statusCode}',
      );
    }
    return result;
  }

  Future<http.Response> _request(
    String method,
    String path, [
    Map<String, dynamic>? body,
  ]) {
    final uri = Uri.parse(settings.buildHttpUrl(path));
    final headers = {
      'Content-Type': 'application/json',
      'X-Access-Token': settings.token,
    };
    final request = switch (method) {
      'GET' => _http.get(uri, headers: headers),
      'DELETE' =>
        body == null
            ? _http.delete(uri, headers: headers)
            : _http.delete(uri, headers: headers, body: jsonEncode(body)),
      _ => _http.post(uri, headers: headers, body: jsonEncode(body ?? {})),
    };
    return request.timeout(const Duration(seconds: 30));
  }

  Map<String, dynamic> _decode(http.Response response) {
    final raw = utf8.decode(response.bodyBytes);
    try {
      return Map<String, dynamic>.from(jsonDecode(raw) as Map);
    } catch (_) {
      // 拿回一整页 HTML 说明这个请求根本没落到 API 上（旧版服务没有这些路由），
      // 那句话比「无法识别的数据」有用得多。
      throw Exception(
        RegExp(r'<!doctype|<html', caseSensitive: false).hasMatch(raw)
            ? 'Air 服务接口尚未加载，请重启 MultiCC 服务后重试。'
            : 'Air 服务返回了无法识别的数据（HTTP ${response.statusCode}）。',
      );
    }
  }

  /// 任务生命周期写（归档/恢复、移动、删除）。
  ///
  /// 与 [_send] 只差错误那一句：这三条路由的失败响应是 `{ok:false,
  /// error:'task_busy'}`（`src/task-board/relocate.js` 的 `fail`、`lifecycle.js`
  /// 同款），没有 `message`。照 [_send] 那套会退化成「HTTP 409」，把「为什么
  /// 不行」整句丢掉 —— 而这几条恰恰只在这种时候才有话要说。
  Future<Map<String, dynamic>> _lifecycle(
    String method,
    String path, [
    Map<String, dynamic>? body,
  ]) async {
    final response = await _request(method, path, body);
    final result = _decode(response);
    if (response.statusCode >= 400 || result['ok'] == false) {
      final reasons = result['reasons'];
      throw AirTaskActionException(
        '${result['error'] ?? result['code'] ?? (reasons is List && reasons.isNotEmpty ? reasons.first : null) ?? 'HTTP ${response.statusCode}'}',
        reasons: reasons is List
            ? reasons.map((reason) => '$reason').toList(growable: false)
            : const [],
      );
    }
    return result;
  }

  Future<AirSnapshot> load() async {
    final data = await _get('/api/air');
    // 远端工作区是第二个请求。它不该拖垮整个快照：这台服务要是还没有这条路由
    // （或者网络正抖），本机的工作区照样得列出来，不该一起变成一片空白。
    List<ExternalFleet> externalFleets = const [];
    try {
      externalFleets = await listExternalFleets();
    } catch (_) {
      externalFleets = const [];
    }
    return AirSnapshot.fromJson(data, externalFleets: externalFleets);
  }

  /// 任务行点开时用它换出可以续接的会话：只读（观察来的）任务只能回到它原来的
  /// 会话，不能在这里接管。
  Future<Map<String, dynamic>> openTask(String taskId) =>
      _get('/api/air/tasks/${Uri.encodeComponent(taskId)}');

  /// 同一个端点，但读的是详情而不是会话：`attribution` / `execution` 只在这一份
  /// 响应里，任务行上那份 `/api/air` 快照没有它们。
  Future<Map<String, dynamic>> taskDetails(String taskId) => openTask(taskId);

  /// Opening a chat must not download taskDetails' unbounded transcript.
  /// The server resolves access and returns the small session projection too.
  Future<Session> openTaskSession(
    String taskId, {
    Session? Function(String)? cachedSession,
  }) async {
    final response = await _request(
      'GET',
      '/api/air/tasks/${Uri.encodeComponent(taskId)}/open',
    );
    if (response.statusCode == 404 || response.statusCode == 405) {
      // Compatibility with a host not yet upgraded; still runs inside the
      // loading page, never before navigation.
      final entry = await openTask(taskId);
      final id =
          entry[entry['readOnly'] == true ? 'sourceSessionId' : 'sessionId'];
      if (id is String && id.isNotEmpty) {
        final session =
            cachedSession?.call(id) ??
            await SessionService(
              settings: settings,
              httpClient: _http,
            ).fetchTaskBoundSession(id);
        if (session != null) return session;
      }
    } else {
      final data = _decode(response);
      if (response.statusCode >= 400 || data['ok'] == false) {
        throw Exception(
          data['message'] ?? data['code'] ?? 'HTTP ${response.statusCode}',
        );
      }
      final session = data['session'];
      if (session is Map &&
          session['id'] is String &&
          (session['id'] as String).isNotEmpty &&
          session['kind'] == 'chat') {
        return Session.fromJson(Map<String, dynamic>.from(session));
      }
    }
    throw StateError('无法打开任务会话，请刷新后重试。');
  }

  /// 重新核验本轮代码的合并记录。它只刷新「交付到哪儿了」这条记录，归属本身仍
  /// 以完整交付条件为准（同 Web `reconcileDelivery`）。
  Future<void> reconcileDelivery(String taskId) =>
      _post('/api/air/tasks/${Uri.encodeComponent(taskId)}/delivery/reconcile');

  /// 归档 / 恢复任务。Web Air 的「归档任务 / 恢复任务」就是往这条路由写
  /// `status`（`public/air.js` 的 `archiveTask`）：归档的任务不再执行，随时可以
  /// 恢复成 `active`。
  Future<void> setTaskLifecycle(String taskId, String status) => _lifecycle(
    'POST',
    '/api/task-board/tasks/${Uri.encodeComponent(taskId)}/status',
    {'status': status},
  );

  /// 手动更改任务身份上的标题。它和会话别名是两件事：任务绑定会话只是执行载体，
  /// Web / App 的任务页都通过这条路由改任务板中的正式标题。
  Future<Map<String, dynamic>> renameTask(String taskId, String title) =>
      _lifecycle(
        'POST',
        '/api/task-board/tasks/${Uri.encodeComponent(taskId)}/title',
        {'title': title},
      );

  /// 把任务移到另一个工作目录。返回体带 `carried`：有未提交改动或未跟踪的新
  /// 文件时，它说明这些东西跟着工作区一起带走了多少（`src/task-board/
  /// relocate.js`）。`carried` 缺失代表这次只搬了干净的工作区。
  Future<Map<String, dynamic>> relocateTask(String taskId, String dirId) =>
      _lifecycle(
        'POST',
        '/api/task-board/tasks/${Uri.encodeComponent(taskId)}/relocate',
        {'dirId': dirId},
      );

  /// 删除任务。默认先做安全检查；界面把 dirty / 未合入风险展示给用户并再次确认
  /// 后，以 [force] 重试。强制删除仍不会越过运行中、共享或被引用的保护。
  Future<void> deleteTask(String taskId, {bool force = false}) => _lifecycle(
    'DELETE',
    '/api/task-board/tasks/${Uri.encodeComponent(taskId)}',
    force ? {'force': true} : null,
  );

  /// 钉住 / 取消钉住一个任务，返回钉住之后的整份清单（顺序就是显示顺序）。
  ///
  /// 单点 toggle 而不是「客户端算好整份再提交」：两台设备同时点的时候，只有
  /// 服务端知道该以谁为准（Web 的 `public/air.js` 走的是同一条路）。
  Future<List<String>> toggleTaskPin(String taskId) async {
    final result = await _post('/api/air/pins/toggle', {'taskId': taskId});
    return ((result['taskIds'] as List?) ?? const []).map((e) => '$e').toList();
  }

  /// 建任务。第一条消息由 [sendFirstMessage] 单独发出，中途失败时任务已经存在
  /// —— Web Air 会退回目录并把草稿留在会话存储里，这里用同样的顺序。
  ///
  /// 角色不在这里传：它们建完任务后用 [updateRoles] 写下去，因为绑定说的是
  /// 「下一条消息」而不是「这个任务的身份」（同 Web Air）。
  ///
  /// [runtime] 是输入区那颗 AI 药丸里攒下的线路（CLI / Provider / 模型 / 推理
  /// 强度）。它必须跟着创建一起写下去 —— 任务建好之后再补，第一条消息已经按
  /// 默认线路发出去了。空字段不发，交给服务端用目录默认值填。
  ///
  /// [model] / [rolePrompt] 是服务端建任务时认的两个可选字段（Web 那句
  /// `if (!values.model) delete values.model`），空的不发 —— 传空串会把目录的
  /// 默认模型顶成「空模型」，而不是「跟随默认」。角色说明走的是任务上的
  /// `rolePrompt`，不是 [AirRoleBinding] 那套具名绑定 —— 那边说的是「下一条消息
  /// 用哪个角色」，这里说的是「这个任务本身的角色」。
  ///
  /// 删除「新任务」那张简易表单之后，界面上已经没有入口直接传这两个了（模型跟
  /// [runtime] 一起走，角色走 [AirRoleBinding]）；留着是因为服务端这一对字段还在，
  /// 少一层只能靠拼 JSON 才够得着的接口。
  Future<String> createTask({
    required String dirId,
    required String title,
    required String clientMsgId,
    String? cli,
    String? model,
    String? rolePrompt,
    Map<String, dynamic> runtime = const {},
  }) async {
    final result = await _post('/api/air/tasks', {
      'dirId': dirId,
      'title': title,
      'clientMsgId': clientMsgId,
      if (cli != null && cli.isNotEmpty) 'cli': cli,
      // 空的不发：传空串会把目录的默认模型顶成「空模型」，而不是「跟随默认」。
      if (model != null && model.isNotEmpty) 'model': model,
      if (rolePrompt != null && rolePrompt.isNotEmpty) 'rolePrompt': rolePrompt,
      // runtime 放最后：输入区那条路把模型装在 runtime 里，两处都有值时以它为准。
      ...runtime,
    });
    return '${result['taskId']}';
  }

  /// 发第一条消息。Goal 的两个上限挂在**这一条消息**上（不是任务上），键名跟
  /// 服务端 `normalizeGoalLimits` 认的一样：`maxRounds` / `maxBudget`
  /// （`src/chat/turn-request.js:51-58`）。写成 `rounds` / `tokenBudget` 不会报错，
  /// 只会被静默丢掉 —— 界面上看着设了，实际一次都没生效过。
  Future<void> sendFirstMessage({
    required String taskId,
    required String text,
    required String clientMsgId,
    bool goal = false,
    int? goalRounds,
    int? goalBudget,
  }) => _post('/api/task-shell-tasks/${Uri.encodeComponent(taskId)}/messages', {
    'text': text,
    'clientMsgId': clientMsgId,
    'intent': 'work',
    if (goal) 'goal': true,
    if (goal)
      'goalLimits': {
        if (goalRounds != null) 'maxRounds': goalRounds,
        if (goalBudget != null) 'maxBudget': goalBudget,
      },
  });

  /// 写入任务的角色绑定。`expectedVersion` 是打开编辑器时读到的版本，
  /// `clientMsgId` 让重试不会变成第二次修改 —— 同一个 id 配同样的内容，服务端
  /// 直接返回上一次的结果；内容不同才会报 `idempotency_conflict`。
  Future<AirRoleBindings> updateRoles(
    String taskId, {
    required int expectedVersion,
    required List<AirRoleBinding> bindings,
    required String clientMsgId,
  }) async {
    final result =
        await _post('/api/air/tasks/${Uri.encodeComponent(taskId)}/roles', {
          'bindings': bindings.map((b) => b.toJson()).toList(),
          'expectedVersion': expectedVersion,
          'clientMsgId': clientMsgId,
        });
    return AirRoleBindings.fromJson(
      (result['roleBindings'] as Map?)?.cast<String, dynamic>(),
    );
  }

  Future<void> addDirectory({
    required String name,
    required String path,
    bool create = true,
  }) =>
      _post('/api/directories', {'name': name, 'path': path, 'create': create});

  // ── 工作区分享 / 外部舰队（`src/routes/fleet-sharing.js`）─────────────────
  //
  // Web 那边是 `public/manage-fleet-sharing.js`：目录菜单里「↗ 分享工作区」开
  // 一个弹窗，为整个工作区签发一份跨实例的操作授权；对面拿着链接和密码导入，
  // 就以一个「外部工作区」的样子出现在自己的工作区列表里。

  /// 为一个工作区签发分享。密码至少 6 位（服务端也是这条），天数与导入次数
  /// 的合法区间在服务端校验，这里只管原样发过去。
  Future<FleetShare> createFleetShare(
    String fleetId, {
    required String password,
    required int expiresInDays,
    required int maxAccesses,
    String description = '',
  }) async {
    final result =
        await _post('/api/fleets/${Uri.encodeComponent(fleetId)}/share', {
          'password': password,
          'expiresInDays': expiresInDays,
          'maxAccesses': maxAccesses,
          'description': description,
        });
    return FleetShare.fromJson(result);
  }

  Future<List<FleetShare>> listFleetShares(String fleetId) async {
    final result = await _get(
      '/api/fleets/${Uri.encodeComponent(fleetId)}/shares',
    );
    final list = (result['shares'] as List?) ?? const [];
    return list
        .whereType<Map>()
        .map((e) => FleetShare.fromJson(e.cast<String, dynamic>()))
        .toList();
  }

  /// 撤销。已发出去的链接立刻失效（`revokeShare`）。
  Future<void> revokeFleetShare(String fleetId, String token) => _delete(
    '/api/fleets/${Uri.encodeComponent(fleetId)}/share/'
    '${Uri.encodeComponent(token)}',
  );

  /// 导入别台机器的工作区。密码只用于这一次导入，服务端不留（留的是它换回来
  /// 的那对范围授权）。返回导入后的那条记录，好把名字念给使用者听。
  Future<ExternalFleet> importExternalFleet({
    required String shareUrl,
    required String password,
    String alias = '',
  }) async {
    final result = await _post('/api/external-fleets/import', {
      'shareUrl': shareUrl,
      'password': password,
      'alias': alias,
    });
    return ExternalFleet.fromJson(
      (result['fleet'] as Map?)?.cast<String, dynamic>() ?? const {},
    );
  }

  Future<List<ExternalFleet>> listExternalFleets() async {
    final result = await _get('/api/external-fleets');
    final list = (result['fleets'] as List?) ?? const [];
    return list
        .whereType<Map>()
        .map((e) => ExternalFleet.fromJson(e.cast<String, dynamic>()))
        .toList();
  }

  /// 「↻ 刷新远端状态」——重新问一次远端，把会话列表和授权状态拉回来。
  Future<void> refreshExternalFleet(String id) =>
      _post('/api/external-fleets/${Uri.encodeComponent(id)}/refresh');

  /// 「移除共享工作区」——只从本机列表里摘掉，远端那份工作区不动。
  Future<void> removeExternalFleet(String id) =>
      _delete('/api/external-fleets/${Uri.encodeComponent(id)}');

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
  static const _visitedKey = 'air:task-visited-at';
  static const _taskSortKey = 'air:task-sort';
  static const _recentLimit = 24;

  final SharedPreferences _prefs;

  static Future<AirLocalStore> load() async =>
      AirLocalStore._(await SharedPreferences.getInstance());

  List<String> get favorites => _prefs.getStringList(_favoritesKey) ?? const [];

  List<String> get recentTasks => _prefs.getStringList(_recentKey) ?? const [];

  String get taskSort =>
      _prefs.getString(_taskSortKey) == 'visit' ? 'visit' : 'message';

  Map<String, int> get taskVisitedAt {
    try {
      final raw = jsonDecode(_prefs.getString(_visitedKey) ?? '{}') as Map;
      return raw.map(
        (key, value) => MapEntry('$key', (value as num?)?.toInt() ?? 0),
      );
    } catch (_) {
      return const {};
    }
  }

  int visitedAt(String taskId) => taskVisitedAt[taskId] ?? 0;

  Future<void> setTaskSort(String value) =>
      _prefs.setString(_taskSortKey, value == 'visit' ? 'visit' : 'message');

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
    final kept = next.take(_recentLimit).toList();
    final visited = taskVisitedAt
      ..[taskId] = DateTime.now().millisecondsSinceEpoch;
    visited.removeWhere((id, _) => !kept.contains(id));
    await Future.wait([
      _prefs.setStringList(_recentKey, kept),
      _prefs.setString(_visitedKey, jsonEncode(visited)),
    ]);
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
    final visited = taskVisitedAt
      ..removeWhere((id, _) => !taskIds.contains(id));
    await _prefs.setString(_visitedKey, jsonEncode(visited));
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
    if (previous != null && previous.fingerprint == fingerprint) {
      return previous;
    }
    return AirCreateAttempt(fingerprint, _nextId(), _nextId());
  }
}
