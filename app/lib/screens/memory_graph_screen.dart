import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:http/http.dart' as http;

import '../services/memory_file_service.dart';
import '../services/memory_graph_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';
import '../widgets/graph/graph_canvas.dart';
import 'memory_file_editor_screen.dart';

/// 记忆图谱的配色与文案 —— 逐字对齐 Web `public/memory-graph.js:13-32` 的 `KIND`
/// 与 `SCOPE_STROKE`，以及详情里的 `SCOPE_NAMES`（`memory-graph.js:431`）。改色
/// 改词要两边一起改，App 与 Web 是同一张图。
class MemoryGraphPalette {
  const MemoryGraphPalette._();

  /// 节点按**类型**上色（`KIND`）。
  static const Map<String, Color> kindColors = <String, Color>{
    'project': Color(0xFF3AD6C5),
    'feedback': Color(0xFFE3B341),
    'user': Color(0xFF57AB5A),
    'reference': Color(0xFF6CB6FF),
    'index': Color(0xFF8B949E),
    'auto': Color(0xFFBC8CFF),
    'note': Color(0xFF79C0FF),
    'missing': Color(0xFF484F58),
  };

  static const Map<String, String> kindLabels = <String, String>{
    'project': '项目',
    'feedback': '反馈',
    'user': '用户',
    'reference': '引用',
    'index': '索引/入口',
    'auto': '自动提炼',
    'note': '笔记',
    'missing': '未创建(悬空引用)',
  };

  /// 图例顺序照 Web `renderLegend()` 的 `order`（`memory-graph.js:399`）。
  static const List<String> kindOrder = <String>[
    'project',
    'feedback',
    'user',
    'reference',
    'index',
    'auto',
    'note',
    'missing',
  ];

  /// 认不出来的类型按 `note` 处理（Web `kindOf()`）。
  static Color kindColor(String type) =>
      kindColors[type] ?? kindColors['note']!;

  static String kindLabel(String type) =>
      kindLabels[type] ?? kindLabels['note']!;

  /// 按**作用域**描边（`SCOPE_STROKE`）：层级身份一眼可辨。`session` 没有描边
  /// （会话私有是默认层级，给边框反而吵）。
  static const Map<String, Color> scopeColors = <String, Color>{
    'machine': Color(0xFFE3B341),
    'cli': Color(0xFFBC8CFF),
    'task': Color(0xFFF0883E),
    'skill': Color(0xFF39C5CF),
    'shared': Color(0xFFFFFFFF),
  };

  static const Map<String, double> scopeWidths = <String, double>{
    'machine': 2,
    'cli': 1.8,
    'task': 1.8,
    'skill': 1.6,
    'shared': 1.6,
  };

  /// 图例里的作用域名（Web `SCOPE_LEGEND`）。
  static const Map<String, String> scopeLabels = <String, String>{
    'machine': '机器全局',
    'cli': 'CLI 特有',
    'task': '任务级',
    'skill': '技能级',
    'shared': '公共记忆',
  };

  static const List<String> scopeOrder = <String>[
    'machine',
    'cli',
    'task',
    'skill',
    'shared',
  ];

  /// 详情里的作用域全名（Web `SCOPE_NAMES`：层名 + 该层的子标识）。
  static String scopeName(MemoryGraphNode node) {
    switch (node.scope) {
      case 'session':
        final session = node.sessionId ?? '';
        return session.isEmpty ? '会话私有' : '会话私有 · $session';
      case 'machine':
        return '机器全局';
      case 'shared':
        return '公共记忆';
      case 'cli':
      case 'task':
      case 'skill':
        final label = scopeLabels[node.scope] ?? node.scope;
        final sub = node.sub ?? '';
        return sub.isEmpty ? label : '$label · $sub';
      default:
        return node.scope;
    }
  }

  /// 普通节点的描边（`rgba(0,0,0,.35)`）；悬空引用用类型色（见 painter）。
  static const Color defaultStroke = Color(0x59000000);

  /// 边（`reference`）颜色 —— Web 是 `#mem-graph-svg .mem-edge{stroke:var(--line);
  /// stroke-opacity:.55}`（`manage.html:939`）。深色画布上的 `--line` 在浅色画布
  /// 上会淡到看不见，所以用 `lineStrong` 这一档。
  static const Color edgeColor = AppColors.lineStrong;
}

/// 原生记忆图谱页 —— Web `?view=memory`（渲染器 `public/memory-graph.js`）。
///
/// 取数走 [MemoryGraphService]（`GET /api/memory/graph` 的全量快照），切项目是
/// **客户端过滤**且保留全局层（`machine` / `cli`）；画布与任务图谱共用
/// `widgets/graph/graph_canvas.dart`（力导向 + 平移 / 捏合 / 拖动固定 + 缩放级
/// 标签），这里只画记忆图谱自己的形状与详情。
///
/// [onOpenFile] 由宿主注入（详情里的「编辑」）；不给就自己 push 原生记忆文件
/// 编辑器 [MemoryFileEditorScreen] —— 两者是同一件事，注入只是为了测试能断言。
class MemoryGraphScreen extends StatefulWidget {
  const MemoryGraphScreen({
    super.key,
    required this.settings,
    this.httpClient,
    this.onOpenFile,
  });

  final SettingsService settings;

  /// 测试用的假 client；不给就自己 new 一个（由本页 close）。
  final http.Client? httpClient;

  /// 打开记忆文件编辑器：参数是文件相对于 memories/ 的 `rel`。
  final void Function(String rel)? onOpenFile;

  @override
  MemoryGraphScreenState createState() => MemoryGraphScreenState();
}

class MemoryGraphScreenState extends State<MemoryGraphScreen>
    with TickerProviderStateMixin {
  late final MemoryGraphService _service = MemoryGraphService(
    settings: widget.settings,
    httpClient: widget.httpClient,
  );

  /// 力导向 + 视图变换 + 手势（与任务图谱共用）。
  late final GraphCanvasController _canvas = GraphCanvasController(
    vsync: this,
    onNodeTap: (node) => unawaited(openNodeDetails(node.id)),
  );

  /// 全量 payload —— 只在刷新时重取，切项目不动它（Web 的 `_memRaw`）。
  MemoryGraphPayload? _raw;

  /// 当前子图（过滤后的）。计数行 / 图例 / 画布都看它。
  MemoryGraphPayload? _sub;

  bool _loading = true;
  String? _error;

  /// 当前项目。空串 = 还没定（加载完落到「节点最多的那个项目」上，Web 的
  /// `projects[0]` 就是这个意思 —— 服务端已按数量倒序）。
  String _project = '';

  /// 客户端拉取耗时（Web 计数行里那句「拉取 Xms」）。
  int _fetchMs = 0;

  /// 请求序号：晚发的请求才有资格写状态（Web 的 `_reqSeq`）。
  int _fetchSeq = 0;

  bool _disposed = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _disposed = true;
    _canvas.dispose();
    _service.dispose();
    super.dispose();
  }

  // ── 取数 ───────────────────────────────────────────────────────────────

  Future<void> _load() async {
    final seq = ++_fetchSeq;
    setState(() {
      _loading = true;
      _error = null;
    });
    _canvas.stopSim();
    final startedAt = DateTime.now();
    try {
      final payload = await _service.fetch();
      if (_disposed || seq != _fetchSeq) return;
      setState(() {
        _raw = payload;
        _loading = false;
        _error = null;
        _fetchMs = DateTime.now().difference(startedAt).inMilliseconds;
        // 默认项目：显式选过的保留（刷新不该把视图跳走），否则落到第一个项目
        // （Web：`projects[0]`，即节点最多的那个）。
        if (_project.isEmpty || !_hasProject(payload, _project)) {
          _project = payload.meta.projects.isNotEmpty
              ? payload.meta.projects.first.dirId
              : 'all';
        }
        _applyFilter();
      });
    } catch (err) {
      if (_disposed || seq != _fetchSeq) return;
      setState(() {
        _loading = false;
        // 原始错误原样带出来（「HTTP 500」和「连不上 127.0.0.1:9」是两种完全
        // 不同的事）；Web 那句前缀也照抄（`memory-graph.js:87`）。
        _error = '$err';
        _raw = null;
        _sub = null;
        _canvas.setLayout(null);
      });
      _canvas.stopSim();
    }
  }

  static bool _hasProject(MemoryGraphPayload payload, String dirId) {
    if (dirId == 'all') return true;
    for (final project in payload.meta.projects) {
      if (project.dirId == dirId) return true;
    }
    return false;
  }

  /// 客户端过滤（Web `filterPayload()`）：命中 `dirId` 的留下 + 全局层节点，
  /// 边两端都在子图里才留。
  void _applyFilter() {
    final raw = _raw;
    if (raw == null) return;
    final sub = raw.filterByProject(_project);
    _sub = sub;
    _canvas.setLayout(sub.nodes.isEmpty ? null : _buildLayout(sub));
  }

  void _selectProject(String? dirId) {
    if (dirId == null || dirId == _project) return;
    setState(() {
      _project = dirId;
      _applyFilter();
    });
  }

  /// payload → 布局。半径与标签文本是记忆图谱自己的规则；物理与视图在共用画布。
  GraphLayout _buildLayout(MemoryGraphPayload payload) {
    final nodes = <GraphNode>[];
    final byId = <String, GraphNode>{};
    for (final node in payload.nodes) {
      final entry = GraphNode(
        id: node.id,
        title: node.label,
        // 半径：`6 + min(degree, 12) * 1.4`（`memory-graph.js:148`）——任务图谱
        // 多一个「任务壳固定 3.5」的退化，记忆图谱没有配角。
        radius: 6 + math.min(node.degree, 12) * 1.4,
        degree: node.degree,
        labelText: node.label,
        payload: node,
      );
      nodes.add(entry);
      byId[node.id] = entry;
    }
    final links = <GraphLink>[];
    for (final edge in payload.edges) {
      final source = byId[edge.source];
      final target = byId[edge.target];
      if (source == null || target == null) continue;
      // 弹簧强度 = 同名引用次数（Web 直接拿 `strength` 当那个乘数，
      // `memory-graph.js:200`）。
      links.add(
        GraphLink(
          source: source,
          target: target,
          spring: edge.strength.toDouble(),
          payload: edge,
        ),
      );
    }
    return GraphLayout(nodes: nodes, links: links);
  }

  // ── 视图（转发给共用画布；测试也直接用这几个方法拿坐标）─────────────────

  void fitView() => _canvas.fitView();

  void focusNode(String id) => _canvas.focusNode(id);

  void resetView() => _canvas.resetView();

  String? hitTestNodeId(Offset local, {double slack = 6}) =>
      _canvas.hitTestNodeId(local, slack: slack);

  Offset? nodeCenterInCanvas(String id) => _canvas.nodeCenterInCanvas(id);

  /// 当前图的布局（**测试用**）：拖动固定、缩放级标签这些没有 widget 可断言。
  GraphLayout? get layout => _canvas.layout;

  /// 点节点 → 底部详情面板（Web 的 `memNodeModalOpen`，`memory-graph.js:425`）。
  Future<void> openNodeDetails(String id) async {
    final layout = _canvas.layout;
    if (layout == null || !layout.byId.containsKey(id)) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.panel,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(AppColors.radiusPanel),
        ),
      ),
      builder: (_) => _MemoryNodeDetailSheet(
        layout: layout,
        initialId: id,
        onFocus: (next) {
          if (_disposed) return;
          focusNode(next);
        },
        onOpenFile: _openFile,
      ),
    );
  }

  /// 「编辑」：默认 push 原生记忆文件编辑器；宿主注入了就用宿主的。
  void _openFile(String rel) {
    final handler = widget.onOpenFile;
    if (handler != null) {
      handler(rel);
      return;
    }
    if (!mounted) return;
    unawaited(
      () async {
        // 编辑器保存/删除过就重取一次图谱（Web 的 `afterMemChange()` 会
        // `invalidate()` 图谱缓存）—— 新写的文件从「悬空引用」变成真节点，
        // 删掉的正好相反。
        final changed = await Navigator.of(context).push<bool>(
          MaterialPageRoute<bool>(
            builder: (_) => MemoryFileEditorScreen(
              settings: widget.settings,
              rel: rel,
              httpClient: widget.httpClient,
            ),
          ),
        );
        if (changed == true && mounted) await _load();
      }(),
    );
  }

  // ── 构建 ───────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        title: const Text('记忆图谱'),
        actions: [
          IconButton(
            key: const ValueKey('memory-graph-reset'),
            // 拖动固定过的节点不会自己松开，得给一条退路（Web
            // `memGraphResetView()` 是窗口 API，没有按钮；这里是它的语义）。
            icon: const Icon(
              Icons.center_focus_strong_rounded,
              color: AppColors.muted,
            ),
            tooltip: '重置视图',
            onPressed: _canvas.layout == null
                ? null
                : () => setState(_canvas.resetView),
          ),
          IconButton(
            key: const ValueKey('memory-graph-refresh'),
            icon: const Icon(Icons.refresh_rounded, color: AppColors.muted),
            tooltip: '刷新',
            onPressed: _loading ? null : () => unawaited(_load()),
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _buildToolbar(),
            const SizedBox(height: 8),
            _buildMetaLine(),
            const SizedBox(height: 8),
            _buildLegend(),
            const SizedBox(height: 8),
            Expanded(child: _buildCanvasArea()),
          ],
        ),
      ),
    );
  }

  Widget _buildToolbar() {
    final payload = _raw;
    final projects = payload?.meta.projects ?? const <MemoryGraphProject>[];
    final total = payload?.totalCount ?? 0;
    // dirId 去重：DropdownButton 要求「value 在 items 里恰好出现一次」。
    final seen = <String>{'all'};
    final items = <DropdownMenuItem<String>>[
      DropdownMenuItem<String>(
        value: 'all',
        child: Text('全部项目 ($total)', overflow: TextOverflow.ellipsis),
      ),
      for (final project in projects)
        if (seen.add(project.dirId))
          DropdownMenuItem<String>(
            value: project.dirId,
            child: Text(
              '${project.name} (${project.count})',
              overflow: TextOverflow.ellipsis,
            ),
          ),
    ];
    // 当前选中项不在列表里（服务端截断过项目清单）时退回「全部项目」，否则
    // DropdownButton 会直接断言失败。
    final known = items.map((item) => item.value).toSet();
    final selected = known.contains(_project) ? _project : 'all';
    return Row(
      children: [
        Expanded(
          child: DropdownButtonHideUnderline(
            child: DropdownButton<String>(
              key: const ValueKey('memory-graph-project-filter'),
              value: selected,
              isExpanded: true,
              dropdownColor: AppColors.panel,
              borderRadius: BorderRadius.circular(AppColors.radiusCard),
              icon: const Icon(Icons.expand_more_rounded, size: 18),
              style: const TextStyle(color: AppColors.text, fontSize: 13),
              onChanged: _loading ? null : _selectProject,
              items: items,
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildMetaLine() {
    final sub = _sub;
    final String text;
    if (_loading) {
      text = '加载中…';
    } else if (_error != null) {
      text = '';
    } else {
      final meta = _raw?.meta;
      final ms = meta?.durationMs ?? 0;
      // 计数行与 Web 逐字一致（`memory-graph.js:113-116`，含「拉取 Xms」）。
      final buffer = StringBuffer(
        '${sub?.nodes.length ?? 0} 节点 · ${sub?.edges.length ?? 0} 边'
        ' · 服务端 ${ms}ms',
      );
      if (_fetchMs > 0) buffer.write(' · 拉取 ${_fetchMs}ms');
      if (meta != null && meta.truncated) {
        buffer.write(' · 已截断至 ${meta.maxNodes}');
      }
      text = buffer.toString();
    }
    return Text(
      text,
      key: const ValueKey('memory-graph-count'),
      style: const TextStyle(
        fontFamily: 'monospace',
        fontSize: 11,
        color: AppColors.faint,
      ),
    );
  }

  /// 图例只画**当前子图里出现过**的类型与作用域（Web `renderLegend()`，
  /// `memory-graph.js:395-414`）—— 与任务图谱「固定画全套色卡」的取舍不同：
  /// 记忆图谱的 8 种类型 + 5 种作用域全画出来会占掉半个屏幕。
  Widget _buildLegend() {
    final sub = _sub;
    final kinds = <String>{for (final node in sub?.nodes ?? const <MemoryGraphNode>[]) node.type};
    final scopes = <String>{for (final node in sub?.nodes ?? const <MemoryGraphNode>[]) node.scope};
    return Wrap(
      key: const ValueKey('memory-graph-legend'),
      spacing: 12,
      runSpacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        for (final kind in MemoryGraphPalette.kindOrder)
          if (kinds.contains(kind))
            _MemoryLegendSwatch(
              key: ValueKey('memory-graph-legend-kind-$kind'),
              color: MemoryGraphPalette.kindColor(kind),
              label: MemoryGraphPalette.kindLabel(kind),
            ),
        for (final scope in MemoryGraphPalette.scopeOrder)
          if (scopes.contains(scope))
            _MemoryLegendSwatch(
              key: ValueKey('memory-graph-legend-scope-$scope'),
              color: MemoryGraphPalette.scopeColors[scope],
              label: MemoryGraphPalette.scopeLabels[scope] ?? scope,
              hollow: true,
            ),
      ],
    );
  }

  Widget _buildCanvasArea() {
    final Widget child;
    if (_error != null) {
      child = _buildError();
    } else if (!_loading && (_sub?.nodes.isEmpty ?? true)) {
      child = _buildEmpty();
    } else if (_canvas.layout == null) {
      child = const SizedBox.expand();
    } else {
      child = _buildCanvas();
    }
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: AppColors.panel,
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(AppColors.radiusCard),
      ),
      child: child,
    );
  }

  Widget _buildEmpty() {
    // 文案照抄 Web（`memory-graph.js:120` 与 `:118`）。
    final all = _project == 'all' || _project.isEmpty;
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24),
        child: Text(
          all
              ? '暂无任何记忆节点。'
              : '该项目暂无记忆节点。当会话把知识写进 memories/ 下的 .md 文件后，'
                    '这里会出现节点与关联。',
          key: const ValueKey('memory-graph-empty'),
          textAlign: TextAlign.center,
          style: const TextStyle(
            color: AppColors.muted,
            fontSize: 12.5,
            height: 1.6,
          ),
        ),
      ),
    );
  }

  Widget _buildError() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              // 前缀与 Web 一致（`memory-graph.js:87`）；后面是原始错误。
              '加载失败：$_error',
              key: const ValueKey('memory-graph-error'),
              textAlign: TextAlign.center,
              style: const TextStyle(
                color: AppColors.danger,
                fontSize: 12.5,
                height: 1.6,
              ),
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              key: const ValueKey('memory-graph-retry'),
              onPressed: () => unawaited(_load()),
              child: const Text('重试'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildCanvas() {
    return Stack(
      children: [
        Positioned.fill(
          child: GraphCanvasView(
            controller: _canvas,
            canvasKey: const ValueKey('memory-graph-canvas'),
            painterBuilder: (layout, repaint) =>
                _MemoryGraphPainter(layout: layout, repaint: repaint),
          ),
        ),
        Positioned(
          left: 10,
          bottom: 8,
          child: IgnorePointer(
            child: Text(
              // Web 的提示是「拖拽平移 · 滚轮缩放 · 点击节点看详情 · 拖动节点可
              // 固定」（manage.html:1120 那段同一份文案）。
              '拖拽平移 · 双指缩放 · 双击适配 · 点击节点看详情 · 拖动节点可固定',
              style: TextStyle(fontSize: 10, color: AppColors.faint),
            ),
          ),
        ),
      ],
    );
  }
}

/// 画布本体。Web 是 SVG（每个节点一个 `<g>`），这里是手画：视图变换、标签（含
/// 缩放级抽稀）、虚线/箭头工具都在 [GraphPainter] 里，这里只画记忆图谱的形状。
class _MemoryGraphPainter extends GraphPainter {
  _MemoryGraphPainter({required super.layout, required super.repaint});

  @override
  void paintLinks(Canvas canvas) {
    for (final link in layout.links) {
      final edge = link.payload as MemoryGraphEdge;
      final a = link.source;
      final b = link.target;
      final dx = b.x - a.x;
      final dy = b.y - a.y;
      final distance = math.sqrt(dx * dx + dy * dy);
      if (distance < 0.01) continue;
      final ux = dx / distance;
      final uy = dy / distance;
      // 两端各留一点空隙（Web `paint()`，`memory-graph.js:289-290`）。
      final start = Offset(
        a.x + ux * (a.radius * 0.6),
        a.y + uy * (a.radius * 0.6),
      );
      final end = Offset(b.x - ux * (b.radius + 5), b.y - uy * (b.radius + 5));
      final paint = Paint()
        ..style = PaintingStyle.stroke
        // 线宽随引用次数：0.6 + strength * 0.5，夹在 0.6..3
        // （Web 的 `clamp(0.6 + (e.strength||1)*0.5, 0.6, 3)`）。
        ..strokeWidth = (0.6 + edge.strength * 0.5).clamp(0.6, 3.0)
        ..color = MemoryGraphPalette.edgeColor;
      canvas.drawLine(start, end, paint);
      GraphPainter.arrowHead(canvas, end, Offset(ux, uy));
    }
  }

  @override
  void paintNode(Canvas canvas, GraphNode entry) {
    final node = entry.payload as MemoryGraphNode;
    final center = Offset(entry.x, entry.y);
    final kind = MemoryGraphPalette.kindColor(node.type);
    final scope = MemoryGraphPalette.scopeColors[node.scope];
    final fill = Paint()
      ..style = PaintingStyle.fill
      // 悬空引用 fill-opacity .5，其余 .92（`memory-graph.js:268-269`）。
      ..color = kind.withValues(alpha: node.missing ? 0.5 : 0.92);
    canvas.drawCircle(center, entry.radius, fill);

    final stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = MemoryGraphPalette.scopeWidths[node.scope] ?? 1
      // 描边优先级：作用域色 > 悬空引用的类型色 > rgba(0,0,0,.35)
      // （Web `stroke: ss ? ss.c : (nd.missing ? kc : 'rgba(0,0,0,.35)')`）。
      ..color =
          scope ??
          (node.missing ? kind : MemoryGraphPalette.defaultStroke);
    if (node.missing) {
      // 悬空引用：虚线描边（Web 的 `stroke-dasharray: 2 2`）。
      _dashedCircle(canvas, center, entry.radius, stroke);
    } else {
      canvas.drawCircle(center, entry.radius, stroke);
    }
  }

  /// 2-2 的虚线圆：沿圆周切段（SVG 的 dasharray 在 Canvas 上没有直接对应物）。
  static void _dashedCircle(
    Canvas canvas,
    Offset center,
    double radius,
    Paint paint,
  ) {
    const dash = 2.0;
    final path = Path()
      ..addOval(Rect.fromCircle(center: center, radius: radius));
    for (final metric in path.computeMetrics()) {
      var distance = 0.0;
      while (distance < metric.length) {
        final next = math.min(distance + dash, metric.length);
        canvas.drawPath(metric.extractPath(distance, next), paint);
        distance = next + dash;
      }
    }
  }
}

/// 图例里的一个色块 + 文案。类型是实心圆点，作用域是空心描边圆（Web
/// `renderLegend()` 的两种 `<span class="sw">`）。
class _MemoryLegendSwatch extends StatelessWidget {
  const _MemoryLegendSwatch({
    super.key,
    required this.color,
    required this.label,
    this.hollow = false,
  });

  final Color? color;
  final String label;
  final bool hollow;

  @override
  Widget build(BuildContext context) {
    final tint = color ?? AppColors.muted;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 11,
          height: 11,
          decoration: BoxDecoration(
            color: hollow ? Colors.transparent : tint,
            shape: BoxShape.circle,
            border: hollow ? Border.all(color: tint, width: 1.6) : null,
          ),
        ),
        const SizedBox(width: 5),
        Text(
          label,
          style: const TextStyle(fontSize: 11, color: AppColors.muted),
        ),
      ],
    );
  }
}

/// 邻居行：一条边连到的那个节点 + 这条边的引用次数。
class _MemoryNeighbor {
  const _MemoryNeighbor(this.node, this.strength);

  final MemoryGraphNode node;
  final int strength;
}

/// 节点详情底部面板 —— 对应 Web 的 `#mem-node-modal` / `memNodeModalOpen()`
/// （`memory-graph.js:425-490`）：标签区 + 路径/复制/编辑 + token/尺寸 + 摘要 +
/// 出/入邻居（带 `×strength`），点邻居换人。
class _MemoryNodeDetailSheet extends StatefulWidget {
  const _MemoryNodeDetailSheet({
    required this.layout,
    required this.initialId,
    required this.onFocus,
    this.onOpenFile,
  });

  /// 当前子图的布局（只读它的拓扑与 payload）。
  final GraphLayout layout;
  final String initialId;

  /// 点邻居时把画布视口挪过去（`focusNode()`）。
  final ValueChanged<String> onFocus;
  final void Function(String rel)? onOpenFile;

  @override
  State<_MemoryNodeDetailSheet> createState() =>
      _MemoryNodeDetailSheetState();
}

class _MemoryNodeDetailSheetState extends State<_MemoryNodeDetailSheet> {
  late String _id = widget.initialId;

  void _jumpTo(String id) {
    setState(() => _id = id);
    widget.onFocus(id);
  }

  /// 复制路径（Web 用 `navigator.clipboard.writeText(nd.path)`）。
  Future<void> _copyPath(String path) async {
    await Clipboard.setData(ClipboardData(text: path));
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('已复制路径')));
  }

  @override
  Widget build(BuildContext context) {
    final node = widget.layout.byId[_id]?.payload as MemoryGraphNode?;
    if (node == null) return const SizedBox.shrink();

    final out = <_MemoryNeighbor>[];
    final incoming = <_MemoryNeighbor>[];
    for (final link in widget.layout.links) {
      final edge = link.payload as MemoryGraphEdge;
      if (edge.source == node.id) {
        out.add(
          _MemoryNeighbor(
            link.target.payload as MemoryGraphNode,
            edge.strength,
          ),
        );
      } else if (edge.target == node.id) {
        incoming.add(
          _MemoryNeighbor(
            link.source.payload as MemoryGraphNode,
            edge.strength,
          ),
        );
      }
    }

    final rel = node.rel;
    final path = node.path;
    final canEdit = rel != null && rel.isNotEmpty && !node.missing;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.8,
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(18, 10, 18, 18),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  width: 36,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: 10),
                  decoration: BoxDecoration(
                    color: AppColors.line,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(
                      node.label,
                      key: const ValueKey('memory-graph-node-title'),
                      style: const TextStyle(
                        color: AppColors.textBright,
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close_rounded, size: 20),
                    color: AppColors.faint,
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
              Text(
                // Web：`slugEl.textContent = nd.file + '   ·   ' + scopeTxt`。
                '${node.file}   ·   ${MemoryGraphPalette.scopeName(node)}',
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: AppColors.faint,
                ),
              ),
              const SizedBox(height: 10),
              Wrap(children: _tags(node)),
              const SizedBox(height: 6),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppColors.panel2,
                  border: Border.all(color: AppColors.line),
                  borderRadius: BorderRadius.circular(AppColors.radiusChip),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            // Web：`nd.path || (nd.missing ? '（文件尚未创建）' :
                            // (nd.rel || '—'))`。
                            path ??
                                (node.missing
                                    ? '（文件尚未创建）'
                                    : (rel ?? '—')),
                            key: const ValueKey('memory-graph-node-path'),
                            style: const TextStyle(
                              fontFamily: 'monospace',
                              fontSize: 11,
                              color: AppColors.muted,
                              height: 1.5,
                            ),
                          ),
                        ),
                        if (path != null && path.isNotEmpty)
                          IconButton(
                            key: const ValueKey('memory-graph-node-copy'),
                            icon: const Icon(Icons.copy_rounded, size: 18),
                            color: AppColors.muted,
                            tooltip: '复制路径',
                            onPressed: () => unawaited(_copyPath(path)),
                          ),
                        if (canEdit)
                          IconButton(
                            key: const ValueKey('memory-graph-node-edit'),
                            icon: const Icon(Icons.edit_rounded, size: 18),
                            color: AppColors.muted,
                            tooltip: '编辑',
                            onPressed: () {
                              // 先收掉这一层，再开编辑器 —— Web 也是先
                              // `modal.classList.remove('open')`，避免叠层。
                              Navigator.of(context).pop();
                              widget.onOpenFile?.call(rel);
                            },
                          ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        Text(
                          // Web：悬空引用没有内容和容量，显示成「–」。
                          node.missing ? '–' : '~${node.tokens} tokens',
                          key: const ValueKey('memory-graph-node-tokens'),
                          style: const TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 11,
                            color: AppColors.muted,
                          ),
                        ),
                        const SizedBox(width: 14),
                        Text(
                          node.missing
                              ? '–'
                              : formatMemorySize(node.size),
                          key: const ValueKey('memory-graph-node-size'),
                          style: const TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 11,
                            color: AppColors.muted,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppColors.panel2,
                  border: Border.all(color: AppColors.line),
                  borderRadius: BorderRadius.circular(AppColors.radiusChip),
                ),
                child: Text(
                  node.summary.isEmpty ? '（无摘要）' : node.summary,
                  key: const ValueKey('memory-graph-node-detail'),
                  style: const TextStyle(
                    color: AppColors.text,
                    fontSize: 12.5,
                    height: 1.6,
                  ),
                ),
              ),
              const SizedBox(height: 12),
              ..._links('引用了', out, '→'),
              ..._links('被引用', incoming, '←'),
              if (out.isEmpty && incoming.isEmpty)
                const Text(
                  // 原文照抄 Web（`memory-graph.js:487`）。
                  '（暂无关联，孤立节点）',
                  style: TextStyle(color: AppColors.faint, fontSize: 12),
                ),
            ],
          ),
        ),
      ),
    );
  }

  /// 标签区（Web `memNodeModalOpen` 的 addTag 段，`memory-graph.js:437-442`）。
  List<Widget> _tags(MemoryGraphNode node) {
    final tags = <String>[
      '类型: ${MemoryGraphPalette.kindLabel(node.type)}',
      '作用域: ${node.scope}',
      '关联度: ${node.degree}',
    ];
    if (node.missing) tags.add('⚠ 悬空引用');
    return [for (final tag in tags) _tag(tag)];
  }

  Widget _tag(String text) => Container(
    margin: const EdgeInsets.only(right: 6, bottom: 6),
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
    decoration: BoxDecoration(
      color: AppColors.panel2,
      border: Border.all(color: AppColors.line),
      borderRadius: BorderRadius.circular(AppColors.radiusPill),
    ),
    child: Text(
      text,
      style: const TextStyle(color: AppColors.muted, fontSize: 10.5),
    ),
  );

  /// 邻居分组（Web 的 `section('引用了', out, '→')`）：`×N` 只在重复引用时出现。
  List<Widget> _links(
    String title,
    List<_MemoryNeighbor> items,
    String arrow,
  ) {
    if (items.isEmpty) return const <Widget>[];
    return [
      Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(
          '$title (${items.length})',
          style: const TextStyle(
            color: AppColors.muted,
            fontSize: 11,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
      for (final item in items)
        Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: SizedBox(
            width: double.infinity,
            child: OutlinedButton(
              key: ValueKey('memory-graph-neighbor-${item.node.id}'),
              onPressed: () => _jumpTo(item.node.id),
              style: OutlinedButton.styleFrom(
                alignment: Alignment.centerLeft,
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 8,
                ),
                foregroundColor: AppColors.text,
                side: const BorderSide(color: AppColors.line),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(8),
                ),
              ),
              child: Text(
                '$arrow ${item.node.label}'
                '${item.strength > 1 ? '  ×${item.strength}' : ''}',
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12, color: AppColors.text),
              ),
            ),
          ),
        ),
    ];
  }
}
