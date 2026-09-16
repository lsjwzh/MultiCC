import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'settings_service.dart';

/// 任务图谱的取数：`GET /api/task-graph`。
///
/// 对应 Web `public/task-graph.js:58` 的 `loadTaskGraph()` —— 服务端一次把
/// **全量**节点/边吐回来（真实响应里 1000+ 节点、meta.projects 列出每个项目
/// 的数量），切项目是客户端过滤（[TaskGraphPayload.filterByProject]，Web 的
/// `filterPayload()` 在 `task-graph.js:133`），所以这里只有一个无参 [fetch]，
/// 不按 dirId 分接口。
class TaskGraphService {
  TaskGraphService({required this.settings, http.Client? httpClient})
    : _httpClient = httpClient ?? http.Client(),
      _ownsClient = httpClient == null;

  final SettingsService settings;
  final http.Client _httpClient;

  /// 自己 new 出来的 client 才由自己关；调用方注入的（含测试里的假 client）
  /// 由调用方负责，关掉别人的连接池会连带影响它后面的请求。
  final bool _ownsClient;

  Future<TaskGraphPayload> fetch() async {
    final uri = Uri.parse(settings.buildHttpUrl('/api/task-graph'));
    final headers = <String, String>{'Accept': 'application/json'};
    // 与 air_service.dart:495 同款：没配 token 就不带这个头 —— 本机免鉴权的
    // 服务对「空值的 X-Access-Token」和「没带」不是一回事。
    if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;

    final http.Response response;
    try {
      // 30s 与 air_service 的 `_request` 一致。全量图谱要等服务端扫完所有
      // 项目的任务壳/看板，比单条查询慢得多，但也不是「慢到该重试」的量级。
      response = await _httpClient
          .get(uri, headers: headers)
          .timeout(const Duration(seconds: 30));
    } catch (err) {
      // 网络层错误原样带上（SocketException / TimeoutException 的原文比
      // 「加载失败」有用得多，见页面上的错误态）。
      throw TaskGraphException('$err');
    }

    final raw = utf8.decode(response.bodyBytes, allowMalformed: true);
    if (response.statusCode >= 400) {
      throw TaskGraphException(_httpError(response.statusCode, raw));
    }
    final dynamic body;
    try {
      body = jsonDecode(raw);
    } catch (_) {
      // 拿回一整页 HTML 说明这个请求根本没落到 API 上（旧版服务没有这条
      // 路由），跟 air_service.dart:507 的 `_decode` 同一个判断。
      throw TaskGraphException(
        RegExp(r'<!doctype|<html', caseSensitive: false).hasMatch(raw)
            ? '任务图谱接口尚未加载，请重启 MultiCC 服务后重试。'
            : '服务端返回了无法识别的数据（HTTP ${response.statusCode}）。',
      );
    }
    if (body is! Map) {
      throw TaskGraphException('服务端返回了无法识别的数据（HTTP ${response.statusCode}）。');
    }
    return TaskGraphPayload.fromJson(Map<String, dynamic>.from(body));
  }

  /// 失败响应里那句真正有用的话。服务端各路由的失败形状不统一（`message` /
  /// `error` / `code`），照 air_service.dart:481 的优先级挑一个；都没有才退回
  /// 「HTTP 500」——Web 那边只有这一句（`task-graph.js:73`）。
  static String _httpError(int status, String raw) {
    try {
      final body = jsonDecode(raw);
      if (body is Map) {
        final msg = body['message'] ?? body['error'] ?? body['code'];
        if (msg != null && msg.toString().trim().isNotEmpty) {
          return msg.toString();
        }
      }
    } catch (_) {
      // 非 JSON 的错误体（代理返回的 HTML 之类）没有可提取的信息。
    }
    return 'HTTP $status';
  }

  void dispose() {
    if (_ownsClient) _httpClient.close();
  }
}

/// 取数失败。[toString] 只给一句话：页面把它拼成「加载失败：…」
/// （Web `task-graph.js:80` 同款），不要漏出 `Exception:` 前缀。
class TaskGraphException implements Exception {
  TaskGraphException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// `GET /api/task-graph` 的整份响应：`{ nodes, edges, meta }`。
class TaskGraphPayload {
  const TaskGraphPayload({
    this.nodes = const <TaskGraphNode>[],
    this.edges = const <TaskGraphEdge>[],
    this.meta = const TaskGraphMeta(),
  });

  final List<TaskGraphNode> nodes;
  final List<TaskGraphEdge> edges;
  final TaskGraphMeta meta;

  static const empty = TaskGraphPayload();

  factory TaskGraphPayload.fromJson(Map<String, dynamic> json) {
    return TaskGraphPayload(
      nodes: _nodeList(json['nodes']),
      edges: _edgeList(json['edges']),
      meta: TaskGraphMeta.fromJson(json['meta']),
    );
  }

  /// 客户端项目过滤 —— 逐字对齐 Web 的 `filterPayload()`（`task-graph.js:133`）：
  /// 节点按 `dirId` 命中，边要求**两端都在**子图里（跨项目的父子/同组边在这种
  /// 视图里没有意义，留下的那条线会把两个不相干的家族连起来）。
  TaskGraphPayload filterByProject(String? target) {
    if (target == null || target.isEmpty || target == 'all') return this;
    final kept = nodes.where((n) => n.dirId == target).toList(growable: false);
    final ids = kept.map((n) => n.id).toSet();
    final keptEdges = edges
        .where((e) => ids.contains(e.source) && ids.contains(e.target))
        .toList(growable: false);
    return TaskGraphPayload(nodes: kept, edges: keptEdges, meta: meta);
  }

  /// 「全部项目 (N)」里的 N —— Web 是把 `meta.projects[].count` 加起来的
  /// （`task-graph.js:94`），不是 `nodes.length`（截断时两者会不一样）。
  int get totalCount => meta.projects.fold<int>(0, (sum, p) => sum + p.count);

  static List<TaskGraphNode> _nodeList(dynamic raw) {
    if (raw is! List) return const <TaskGraphNode>[];
    final out = <TaskGraphNode>[];
    for (final item in raw) {
      if (item is! Map) continue; // 形状不对的整条丢掉，别让一条脏数据毁掉整图
      out.add(TaskGraphNode.fromJson(Map<String, dynamic>.from(item)));
    }
    return out;
  }

  static List<TaskGraphEdge> _edgeList(dynamic raw) {
    if (raw is! List) return const <TaskGraphEdge>[];
    final out = <TaskGraphEdge>[];
    for (final item in raw) {
      if (item is! Map) continue;
      final edge = TaskGraphEdge.fromJson(Map<String, dynamic>.from(item));
      // 没有端点的边在图上无处可画（Web 的 `buildGraph()` 也是直接 continue，
      // `task-graph.js:151-155`）。
      if (edge.source.isEmpty || edge.target.isEmpty) continue;
      out.add(edge);
    }
    return out;
  }
}

/// 一个图谱节点。字段全部按接口的实际字段名（`GET /api/task-graph` 的
/// `nodes[]`），缺字段一律给默认值 —— 图谱是「有多少画多少」的展示，不允许
/// 因为某个可选字段缺失就整页失败。
///
/// 两类节点：`kind == 'task'`（看板任务）与 `kind == 'shell'`（任务壳）。
/// 壳只有 id/title/dirId/archived/degree/currentTaskId 这几个字段有值。
class TaskGraphNode {
  const TaskGraphNode({
    this.id = '',
    this.kind = 'task',
    this.title = '',
    this.status,
    this.classifyState,
    this.runState,
    this.workflowStage,
    this.origin,
    this.dirId,
    this.goal,
    this.phase,
    this.parentTaskId,
    this.groupId,
    this.mergedInto,
    this.chatSessionId,
    this.sessionId,
    this.currentTaskId,
    this.degree = 0,
    this.refCount = 0,
    this.provisional = false,
    this.canonical = false,
    this.archived = false,
    this.deleted = false,
    this.sources = const <String>[],
  });

  final String id;

  /// `task` 或 `shell`。
  final String kind;
  final String title;

  /// `active` / `done` / `archived` 之类；壳没有这个字段。
  final String? status;

  /// `P` / `D` / `W` / `B` / `E`，或 null（没算过分类）。
  final String? classifyState;
  final String? runState;
  final String? workflowStage;
  final String? origin;
  final String? dirId;
  final String? goal;
  final String? phase;
  final String? parentTaskId;
  final String? groupId;
  final String? mergedInto;
  final String? chatSessionId;
  final String? sessionId;

  /// 任务壳「当前挂着哪个任务」——只有壳节点有（Web 详情弹窗用它做标签，
  /// `task-graph.js:442`）。接口字段名就是 `currentTaskId`。
  final String? currentTaskId;

  /// 关联度：命中的边数（出+入）。半径与「要不要画标签」都看它。
  final int degree;

  /// 被几张记录引用（看板记录 / 壳记录 / 会话记录…）。
  final int refCount;

  /// 身份还没锁（去重还没认出来），半透明画。
  final bool provisional;

  /// 身份已锁（与 provisional 互斥），实色画。
  final bool canonical;
  final bool archived;
  final bool deleted;

  /// 这条记录是从哪儿看的：`board` / `shell` / `session` 等。
  final List<String> sources;

  bool get isShell => kind == 'shell';
  bool get isTask => !isShell;

  factory TaskGraphNode.fromJson(Map<String, dynamic> json) {
    return TaskGraphNode(
      id: _str(json['id']),
      kind: _str(json['kind'], fallback: 'task'),
      title: _str(json['title']),
      status: _optional(json['status']),
      classifyState: _optional(json['classifyState']),
      runState: _optional(json['runState']),
      workflowStage: _optional(json['workflowStage']),
      origin: _optional(json['origin']),
      dirId: _optional(json['dirId']),
      goal: _optional(json['goal']),
      phase: _optional(json['phase']),
      parentTaskId: _optional(json['parentTaskId']),
      groupId: _optional(json['groupId']),
      mergedInto: _optional(json['mergedInto']),
      chatSessionId: _optional(json['chatSessionId']),
      sessionId: _optional(json['sessionId']),
      currentTaskId: _optional(json['currentTaskId']),
      degree: _int(json['degree']),
      refCount: _int(json['refCount']),
      provisional: json['provisional'] == true,
      canonical: json['canonical'] == true,
      archived: json['archived'] == true,
      deleted: json['deleted'] == true,
      sources: _strList(json['sources']),
    );
  }
}

/// 一条边。`type` 只有四种：`parent` / `group` / `merged` / `shell-link`
/// （Web `EDGE` 常量，`task-graph.js:30`）；认不出来的类型按 `shell-link` 画。
class TaskGraphEdge {
  const TaskGraphEdge({this.source = '', this.target = '', this.type = ''});

  final String source;
  final String target;
  final String type;

  /// 虚线：`merged`（4 3）与 `shell-link`（2 2），见 `task-graph.js:30-35`。
  bool get dashed => type == 'merged' || type == 'shell-link';

  factory TaskGraphEdge.fromJson(Map<String, dynamic> json) {
    return TaskGraphEdge(
      source: _str(json['source']),
      target: _str(json['target']),
      type: _str(json['type']),
    );
  }
}

/// `meta`：项目清单 + 截断信息。`durationMs` 是服务端自己统计的耗时（页面
/// 计数行里那句「服务端 Xms」）。
class TaskGraphMeta {
  const TaskGraphMeta({
    this.projects = const <TaskGraphProject>[],
    this.truncated = false,
    this.maxNodes,
    this.durationMs,
  });

  final List<TaskGraphProject> projects;

  /// 服务端因为节点太多截断过 —— 页面要补一句「已截断至 N」。
  final bool truncated;
  final int? maxNodes;
  final int? durationMs;

  factory TaskGraphMeta.fromJson(dynamic raw) {
    if (raw is! Map) return const TaskGraphMeta();
    final json = Map<String, dynamic>.from(raw);
    final projects = <TaskGraphProject>[];
    final rawProjects = json['projects'];
    if (rawProjects is List) {
      for (final item in rawProjects) {
        if (item is! Map) continue;
        projects.add(
          TaskGraphProject.fromJson(Map<String, dynamic>.from(item)),
        );
      }
    }
    return TaskGraphMeta(
      projects: projects,
      truncated: json['truncated'] == true,
      maxNodes: _optionalInt(json['maxNodes']),
      durationMs: _optionalInt(json['durationMs']),
    );
  }
}

/// 下拉里的一行：一个项目（目录）与它的节点数。
class TaskGraphProject {
  const TaskGraphProject({this.dirId = '', this.name = '', this.count = 0});

  final String dirId;
  final String name;
  final int count;

  factory TaskGraphProject.fromJson(Map<String, dynamic> json) {
    return TaskGraphProject(
      dirId: _str(json['dirId']),
      name: _str(json['name']),
      count: _int(json['count']),
    );
  }
}

String _str(dynamic value, {String fallback = ''}) {
  if (value == null) return fallback;
  final s = value.toString();
  return s.isEmpty ? fallback : s;
}

/// 空串当「没有」——接口时不时给 `""` 而不是 null，两者在界面上是同一种
/// 情况（那一行/那个标签就不出现）。
String? _optional(dynamic value) {
  if (value == null) return null;
  final s = value.toString();
  return s.isEmpty ? null : s;
}

int _int(dynamic value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value) ?? 0;
  return 0;
}

int? _optionalInt(dynamic value) {
  if (value == null) return null;
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value);
  return null;
}

List<String> _strList(dynamic value) {
  if (value is! List) return const <String>[];
  final out = <String>[];
  for (final item in value) {
    if (item == null) continue;
    final s = item.toString();
    if (s.isNotEmpty) out.add(s);
  }
  return out;
}
