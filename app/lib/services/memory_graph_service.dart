import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'settings_service.dart';

/// 记忆图谱的取数：`GET /api/memory/graph`。
///
/// 对应 Web `public/memory-model.js:234` 的 `loadGraph()` —— 和任务图谱一样，
/// 服务端一次把**全量**节点/边吐回来（本机实测 516 节点 / 93 边），切项目是
/// 客户端过滤（[MemoryGraphPayload.filterByProject]，Web 的 `filterPayload()`，
/// `memory-graph.js:136`），所以这里只有一个无参 [fetch]。
class MemoryGraphService {
  MemoryGraphService({required this.settings, http.Client? httpClient})
    : _httpClient = httpClient ?? http.Client(),
      _ownsClient = httpClient == null;

  final SettingsService settings;
  final http.Client _httpClient;

  /// 自己 new 出来的 client 才由自己关；调用方注入的（含测试里的假 client）
  /// 由调用方负责。
  final bool _ownsClient;

  Future<MemoryGraphPayload> fetch() async {
    final uri = Uri.parse(settings.buildHttpUrl('/api/memory/graph'));
    final headers = <String, String>{'Accept': 'application/json'};
    // 与 task_graph_service.dart 同款：没配 token 就不带这个头 —— 本机免鉴权的
    // 服务对「空值的 X-Access-Token」和「没带」不是一回事。
    if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;

    final http.Response response;
    try {
      // 30s 与 air_service 的 `_request` 一致：全量图谱要等服务端扫完整个
      // memories/ 目录（本机 500+ 文件），比单条查询慢得多。
      response = await _httpClient
          .get(uri, headers: headers)
          .timeout(const Duration(seconds: 30));
    } catch (err) {
      // 网络层错误原样带上（SocketException / TimeoutException 的原文比「加载
      // 失败」有用得多，见页面上的错误态）。
      throw MemoryGraphException('$err');
    }

    final raw = utf8.decode(response.bodyBytes, allowMalformed: true);
    if (response.statusCode >= 400) {
      throw MemoryGraphException(_httpError(response.statusCode, raw));
    }
    final dynamic body;
    try {
      body = jsonDecode(raw);
    } catch (_) {
      // 拿回一整页 HTML 说明这个请求根本没落到 API 上（旧版服务没有这条路由）。
      throw MemoryGraphException(
        RegExp(r'<!doctype|<html', caseSensitive: false).hasMatch(raw)
            ? '记忆图谱接口尚未加载，请重启 MultiCC 服务后重试。'
            : '服务端返回了无法识别的数据（HTTP ${response.statusCode}）。',
      );
    }
    if (body is! Map) {
      throw MemoryGraphException('服务端返回了无法识别的数据（HTTP ${response.statusCode}）。');
    }
    return MemoryGraphPayload.fromJson(Map<String, dynamic>.from(body));
  }

  /// 失败响应里那句真正有用的话：服务端各路由的失败形状不统一（`message` /
  /// `error` / `code`），按同一个优先级挑一个；都没有才退回「HTTP 500」。
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

/// 取数失败。[toString] 只给一句话：页面把它拼成「加载失败：…」。
class MemoryGraphException implements Exception {
  MemoryGraphException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// `GET /api/memory/graph` 的整份响应：`{ nodes, edges, meta }`。
class MemoryGraphPayload {
  const MemoryGraphPayload({
    this.nodes = const <MemoryGraphNode>[],
    this.edges = const <MemoryGraphEdge>[],
    this.meta = const MemoryGraphMeta(),
  });

  final List<MemoryGraphNode> nodes;
  final List<MemoryGraphEdge> edges;
  final MemoryGraphMeta meta;

  static const empty = MemoryGraphPayload();

  factory MemoryGraphPayload.fromJson(Map<String, dynamic> json) {
    return MemoryGraphPayload(
      nodes: _nodeList(json['nodes']),
      edges: _edgeList(json['edges']),
      meta: MemoryGraphMeta.fromJson(json['meta']),
    );
  }

  /// 客户端项目过滤 —— 逐字对齐 Web 的 `filterPayload()`（`memory-graph.js:136`）：
  /// 命中 `dirId` 的留下，**外加全局层的节点**（`scope` 是 `machine` / `cli`，
  /// 它们不属于任何项目）—— 跨层 wikilink 的另一端不能因为切项目就消失。边要求
  /// 两端都在子图里。
  MemoryGraphPayload filterByProject(String? dirId) {
    if (dirId == null || dirId.isEmpty || dirId == 'all') return this;
    final kept = <MemoryGraphNode>[];
    for (final node in nodes) {
      if (node.dirId == dirId || node.isGlobalTier) kept.add(node);
    }
    final ids = <String>{for (final node in kept) node.id};
    return MemoryGraphPayload(
      nodes: kept,
      edges: [
        for (final edge in edges)
          if (ids.contains(edge.source) && ids.contains(edge.target)) edge,
      ],
      meta: meta,
    );
  }

  /// 下拉里「全部项目」后面那个总数 —— 各项目节点数之和（Web 用
  /// `projects.reduce((a,p) => a + p.count)`）。
  int get totalCount {
    var total = 0;
    for (final project in meta.projects) {
      total += project.count;
    }
    return total == 0 ? nodes.length : total;
  }
}

/// 图谱里的一颗记忆节点。字段与 `src/routes/memory-browser.js` 的
/// `buildMemoryGraph()` 输出一一对应；缺字段一律给默认值，不抛。
class MemoryGraphNode {
  const MemoryGraphNode({
    this.id = '',
    this.slug = '',
    this.file = '',
    this.title = '',
    this.summary = '',
    this.type = '',
    this.scope = '',
    this.sessionId,
    this.sub,
    this.dirId,
    this.size = 0,
    this.path,
    this.rel,
    this.tokens = 0,
    this.missing = false,
    this.degree = 0,
  });

  final String id;
  final String slug;
  final String file;
  final String title;
  final String summary;

  /// 节点类型（配色依据）：`project` / `feedback` / `user` / `reference` /
  /// `index` / `auto` / `note` / `missing`。
  final String type;

  /// 作用域（描边依据）：`machine` / `cli` / `task` / `skill` / `shared` /
  /// `session`；`missing` 是「文件不存在」那一档（实测 25 个）。
  final String scope;
  final String? sessionId;

  /// 层内子标识：会话名 / 任务 id / 技能名（详情里跟作用域名拼在一起显示）。
  final String? sub;
  final String? dirId;
  final int size;
  final String? path;
  final String? rel;
  final int tokens;

  /// 被引用但文件不存在（悬空引用）—— 虚线描边 + 半透明 + 不能编辑。
  final bool missing;
  final int degree;

  /// 全局层：不属于任何项目，切项目时对所有项目都保留。
  bool get isGlobalTier => scope == 'machine' || scope == 'cli';

  /// 标签用的标题：`title` 兜底 `slug`（Web `nd.title || nd.slug`）。
  String get label => title.isNotEmpty ? title : slug;

  factory MemoryGraphNode.fromJson(Map<String, dynamic> json) {
    return MemoryGraphNode(
      id: _str(json['id']),
      slug: _str(json['slug']),
      file: _str(json['file']),
      title: _str(json['title']),
      summary: _str(json['summary']),
      type: _str(json['type']),
      scope: _str(json['scope']),
      sessionId: _optional(json['sessionId']),
      sub: _optional(json['sub']),
      dirId: _optional(json['dirId']),
      size: _int(json['size']),
      path: _optional(json['path']),
      rel: _optional(json['rel']),
      tokens: _int(json['tokens']),
      missing: json['missing'] == true,
      degree: _int(json['degree']),
    );
  }
}

/// 一条 `reference` 边（wikilink）。`strength` 是同名引用的次数：线更粗、弹簧更
/// 紧，详情里显示成 `×N`。
class MemoryGraphEdge {
  const MemoryGraphEdge({
    this.source = '',
    this.target = '',
    this.type = 'reference',
    this.strength = 1,
  });

  final String source;
  final String target;
  final String type;
  final int strength;

  factory MemoryGraphEdge.fromJson(Map<String, dynamic> json) {
    return MemoryGraphEdge(
      source: _str(json['source']),
      target: _str(json['target']),
      type: _str(json['type'], fallback: 'reference'),
      strength: json['strength'] == null ? 1 : _int(json['strength']),
    );
  }
}

/// `meta`：项目清单 + 截断信息 + 服务端耗时。
class MemoryGraphMeta {
  const MemoryGraphMeta({
    this.dirId = 'all',
    this.projects = const <MemoryGraphProject>[],
    this.truncated = false,
    this.maxNodes,
    this.durationMs,
  });

  final String dirId;
  final List<MemoryGraphProject> projects;
  final bool truncated;
  final int? maxNodes;
  final int? durationMs;

  factory MemoryGraphMeta.fromJson(dynamic raw) {
    if (raw is! Map) return const MemoryGraphMeta();
    final json = Map<String, dynamic>.from(raw);
    final projects = <MemoryGraphProject>[];
    final rawProjects = json['projects'];
    if (rawProjects is List) {
      for (final item in rawProjects) {
        if (item is! Map) continue;
        final project = MemoryGraphProject.fromJson(
          Map<String, dynamic>.from(item),
        );
        if (project.dirId.isEmpty) continue;
        projects.add(project);
      }
    }
    return MemoryGraphMeta(
      dirId: _str(json['dirId'], fallback: 'all'),
      projects: projects,
      truncated: json['truncated'] == true,
      maxNodes: _optionalInt(json['maxNodes']),
      durationMs: _optionalInt(json['durationMs']),
    );
  }
}

/// 下拉里的一行：一个项目（目录）与它的记忆节点数。
class MemoryGraphProject {
  const MemoryGraphProject({this.dirId = '', this.name = '', this.count = 0});

  final String dirId;
  final String name;
  final int count;

  factory MemoryGraphProject.fromJson(Map<String, dynamic> json) {
    return MemoryGraphProject(
      dirId: _str(json['dirId']),
      name: _str(json['name']),
      count: _int(json['count']),
    );
  }
}

List<MemoryGraphNode> _nodeList(dynamic value) {
  if (value is! List) return const <MemoryGraphNode>[];
  final out = <MemoryGraphNode>[];
  for (final item in value) {
    if (item is! Map) continue;
    final node = MemoryGraphNode.fromJson(Map<String, dynamic>.from(item));
    if (node.id.isEmpty) continue;
    out.add(node);
  }
  return out;
}

List<MemoryGraphEdge> _edgeList(dynamic value) {
  if (value is! List) return const <MemoryGraphEdge>[];
  final out = <MemoryGraphEdge>[];
  for (final item in value) {
    if (item is! Map) continue;
    final edge = MemoryGraphEdge.fromJson(Map<String, dynamic>.from(item));
    // 缺端点的边画不出来，整条丢掉。
    if (edge.source.isEmpty || edge.target.isEmpty) continue;
    out.add(edge);
  }
  return out;
}

String _str(dynamic value, {String fallback = ''}) {
  if (value == null) return fallback;
  final s = value.toString();
  return s.isEmpty ? fallback : s;
}

/// 空串当「没有」——接口时不时给 `""` 而不是 null，两者在界面上是同一种情况。
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
