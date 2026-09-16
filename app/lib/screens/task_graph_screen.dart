import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../services/settings_service.dart';
import '../services/task_graph_service.dart';
import '../theme.dart';
import '../widgets/graph/graph_canvas.dart';

/// 任务图谱的配色与文案 —— 逐字对齐 Web `public/task-graph.js:20-36` 的
/// `CLASSIFY` / `EDGE` 常量，以及详情弹窗里的 `CLASSIFY_NAMES`
/// （`task-graph.js:427`）。改色/改词要两边一起改，App 与 Web 是同一张图。
class TaskGraphPalette {
  const TaskGraphPalette._();

  /// classify 状态色：P 进行中 / D 执行成功 / W 等待用户 / B 后台等待 / E 异常。
  static const Map<String, Color> classifyColors = <String, Color>{
    'P': Color(0xFF6CB6FF),
    'D': Color(0xFF3FB950),
    'W': Color(0xFFD29922),
    'B': Color(0xFFBC8CFF),
    'E': Color(0xFFF85149),
  };

  /// 图例里的六项（含「无 classify」），顺序照 Web `CLASSIFY` 的键顺序。
  /// `'null'` 是「节点没有 classifyState」那一档（Web 用 `CLASSIFY.null` 表示）。
  static const List<String> classifyLegendKeys = <String>[
    'P',
    'D',
    'W',
    'B',
    'E',
    'null',
  ];

  static const Map<String, String> classifyLegendLabels = <String, String>{
    'P': 'P 进行中',
    'D': 'D 执行成功',
    'W': 'W 等待用户',
    'B': 'B 后台等待',
    'E': 'E 异常',
    'null': '无 classify',
  };

  /// 详情标签里的中文名（Web `CLASSIFY_NAMES`）。
  static const Map<String, String> classifyNames = <String, String>{
    'P': '进行中',
    'D': '执行成功',
    'W': '等待用户',
    'B': '后台等待',
    'E': 'API 异常',
  };

  /// 边类型色：parent 橙 / group 青 / merged 红 / shell-link 灰。
  static const Map<String, Color> edgeColors = <String, Color>{
    'parent': Color(0xFFF0883E),
    'group': Color(0xFF3AD6C5),
    'merged': Color(0xFFF85149),
    'shell-link': Color(0xFF6E7681),
  };

  static const Map<String, String> edgeLabels = <String, String>{
    'parent': '父任务',
    'group': '同组',
    'merged': '合并',
    'shell-link': '任务壳',
  };

  /// 没有 classify 的节点色（Web `CLASSIFY.null.c`）。
  static const Color classifyNullColor = Color(0xFF8B949E);

  /// 任务壳：深色小菱形 + 灰描边（Web `task-graph.js:262-265`）。
  static const Color shellFill = Color(0xFF30363D);
  static const Color shellStroke = Color(0xFF8B949E);

  /// done / archived 任务的描边色，比平时那圈更亮一点（`task-graph.js:271`）。
  static const Color doneRing = Color(0xFF6E7681);

  static Color classifyColor(String? state) =>
      classifyColors[state] ?? classifyNullColor;

  static String classifyLabel(String? state) =>
      classifyLegendLabels[state] ?? classifyLegendLabels['null']!;

  static String classifyName(String? state) => classifyNames[state] ?? '';

  /// 认不出来的边类型按 `shell-link` 画（Web `edgeOf`，`task-graph.js:36`）。
  static Color edgeColor(String type) =>
      edgeColors[type] ?? edgeColors['shell-link']!;

  static String edgeLabel(String type) =>
      edgeLabels[type] ?? edgeLabels['shell-link']!;
}

/// 原生任务图谱页 —— Web `?view=taskgraph`（渲染器 `public/task-graph.js`）。
///
/// 取数走 [TaskGraphService]（`GET /api/task-graph` 的全量快照），切项目是
/// **客户端过滤**；画布是 `CustomPaint` + 一套和 Web 同构的力导向
/// （黄金角螺旋初始化 + Fruchterman-Reingold 一步）。
///
/// [onOpenTaskInAir] 由宿主注入（节点详情里那颗「在 Air 打开」）；不给就
/// 不显示那颗按钮 —— 页面本身不认识 Air 路由。
class TaskGraphScreen extends StatefulWidget {
  const TaskGraphScreen({
    super.key,
    required this.settings,
    this.httpClient,
    this.onOpenTaskInAir,
  });

  final SettingsService settings;

  /// 测试用的假 client；不给就自己 new 一个（由本页 close）。
  final http.Client? httpClient;

  /// 节点详情里「在 Air 打开」：参数是 (dirId, taskId)。为 null 时不显示这颗按钮。
  final void Function(String dirId, String taskId)? onOpenTaskInAir;

  @override
  TaskGraphScreenState createState() => TaskGraphScreenState();
}

class TaskGraphScreenState extends State<TaskGraphScreen>
    with TickerProviderStateMixin {
  late final TaskGraphService _service = TaskGraphService(
    settings: widget.settings,
    httpClient: widget.httpClient,
  );

  /// 力导向 + 视图变换 + 手势都在共用画布里（`widgets/graph/graph_canvas.dart`）：
  /// 记忆图谱用的是同一套，物理参数只此一份。这里只留「这个 payload 长什么样」
  /// 和页面自己的控件。
  late final GraphCanvasController _canvas = GraphCanvasController(
    vsync: this,
    onNodeTap: (node) => unawaited(openNodeDetails(node.id)),
  );

  /// 全量 payload —— 只在刷新时重取，切项目不动它（Web 的 `_taskRaw`）。
  TaskGraphPayload? _raw;

  /// 当前子图（过滤后的）。计数行 / 图例 / 画布都看它。
  TaskGraphPayload? _sub;

  bool _loading = true;
  String? _error;
  String _project = 'all';

  /// 请求序号：晚发的请求才有资格写状态（Web 的 `_reqSeq`，
  /// `task-graph.js:67`）。
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
    try {
      final payload = await _service.fetch();
      if (_disposed || seq != _fetchSeq) return;
      setState(() {
        _raw = payload;
        _loading = false;
        _error = null;
        _applyFilter();
      });
    } catch (err) {
      if (_disposed || seq != _fetchSeq) return;
      setState(() {
        _loading = false;
        // 原始错误原样带出来（「HTTP 500」和「连不上 127.0.0.1:9」是两种
        // 完全不同的事）；Web 那句前缀也照抄（`task-graph.js:80`）。
        _error = '$err';
        _raw = null;
        _sub = null;
        _canvas.setLayout(null);
      });
      _canvas.stopSim();
    }
  }

  /// 客户端过滤（Web `filterPayload()`）：只留 `dirId` 命中的节点，边两端
  /// 都在子图里才留。
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

  /// payload → 布局。半径与标签文本都是任务图谱自己的规则（记忆图谱另有一套），
  /// 物理与视图在共用画布里。
  GraphLayout _buildLayout(TaskGraphPayload payload) {
    final nodes = <GraphNode>[];
    final byId = <String, GraphNode>{};
    for (final node in payload.nodes) {
      final entry = GraphNode(
        id: node.id,
        title: node.title,
        // 任务壳是配角，固定 3.5；任务按关联度长大（`task-graph.js:146`）。
        radius: node.isShell ? 3.5 : 6 + math.min(node.degree, 12) * 1.4,
        degree: node.degree,
        // 标签：壳用 title、任务用 title 兜底 id（`task-graph.js:280`）；
        // 关联度为 0 的孤立节点不建标签 —— 缩放级抽稀那边也要求 degree ≥ 1
        // 才会画（见 GraphLayout.labelMinDegreeFor）。
        labelText: node.isShell
            ? node.title
            : (node.title.isNotEmpty ? node.title : node.id),
        payload: node,
      );
      nodes.add(entry);
      byId[node.id] = entry;
    }
    final links = <GraphLink>[];
    for (final edge in payload.edges) {
      // 两端都得在这张子图里（Web `buildGraph()` 里那句 continue，
      // `task-graph.js:151-155`）；`filterByProject` 已经保证过一遍，这里是
      // 防脏数据（比如边指向一个被截断掉的节点）。
      final source = byId[edge.source];
      final target = byId[edge.target];
      if (source == null || target == null) continue;
      // 父子 / 合并比同组 / 壳链接更强，家族靠得更近（`task-graph.js:196-198`
      // 把边类型折算成弹簧强度）。
      final spring = edge.type == 'parent' || edge.type == 'merged'
          ? 2.4
          : edge.type == 'group'
          ? 1.4
          : 1.0;
      links.add(
        GraphLink(
          source: source,
          target: target,
          spring: spring,
          payload: edge,
        ),
      );
    }
    return GraphLayout(nodes: nodes, links: links);
  }

  // ── 视图（转发给共用画布；测试也直接用这几个方法拿坐标）─────────────────

  /// 双击 / 首次加载用的适配（Web `fitView()`，`task-graph.js:304-317`）。
  void fitView() => _canvas.fitView();

  /// 把某个节点挪到视口正中（Web `focusNode()`）—— 点邻居之后用的。
  void focusNode(String id) => _canvas.focusNode(id);

  /// 画布命中测试：返回半径 + [slack] 内最近的节点 id。
  ///
  /// 公开是为了让测试用同一个判定拿坐标去 `tapAt` —— 力导向的结果没法在测试里
  /// 重算，硬编码坐标只会变成一颗定时炸弹。
  String? hitTestNodeId(Offset local, {double slack = 6}) =>
      _canvas.hitTestNodeId(local, slack: slack);

  /// 节点中心在画布坐标系里的位置（测试算点击坐标用；画布外返回 null）。
  Offset? nodeCenterInCanvas(String id) => _canvas.nodeCenterInCanvas(id);

  /// 当前图的布局（**测试用**）：拖动固定、缩放级标签这些没有 widget 可断言。
  GraphLayout? get layout => _canvas.layout;

  /// 点节点 → 底部详情面板（Web 的 `tgNodeModalOpen`，`task-graph.js:428`）。
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
      builder: (_) => _NodeDetailSheet(
        layout: layout,
        initialId: id,
        onFocus: (next) {
          if (_disposed) return;
          focusNode(next);
        },
        onOpenTaskInAir: widget.onOpenTaskInAir,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        title: const Text('任务图谱'),
        actions: [
          IconButton(
            key: const ValueKey('task-graph-reset'),
            // 拖动固定过的节点不会自己松开，得给一条退路（Web 的
            // `tgGraphReset()` 是窗口 API，没有按钮；这里是它的语义）。
            icon: const Icon(Icons.center_focus_strong_rounded,
                color: AppColors.muted),
            tooltip: '重置视图',
            onPressed: _canvas.layout == null
                ? null
                : () => setState(_canvas.resetView),
          ),
          IconButton(
            key: const ValueKey('task-graph-refresh'),
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
    final projects = payload?.meta.projects ?? const <TaskGraphProject>[];
    final total = payload?.totalCount ?? 0;
    // dirId 去重：DropdownButton 要求「value 在 items 里恰好出现一次」，服务端
    // 万一给了两条同 dirId 的项目（同名目录被登记两次），整页会直接断言崩掉。
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
    // 服务端可能没列全项目（截断），当前选中项不在列表里时退回「全部项目」，
    // 否则 DropdownButton 会直接断言失败。
    final known = items.map((i) => i.value).toSet();
    final selected = known.contains(_project) ? _project : 'all';

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(
        color: AppColors.panel,
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(AppColors.radiusChip),
      ),
      child: DropdownButton<String>(
        key: const ValueKey('task-graph-project-filter'),
        value: selected,
        isExpanded: true,
        isDense: true,
        underline: const SizedBox.shrink(),
        icon: const Icon(Icons.expand_more_rounded, size: 18),
        style: const TextStyle(color: AppColors.text, fontSize: 13),
        onChanged: _loading ? null : _selectProject,
        items: items,
      ),
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
      // 计数行与 Web 逐字一致（`task-graph.js:110-112`）。
      text =
          '${sub?.nodes.length ?? 0} 节点 · ${sub?.edges.length ?? 0} 边 · 服务端 ${ms}ms'
          '${meta != null && meta.truncated ? ' · 已截断至 ${meta.maxNodes}' : ''}';
    }
    return Text(
      text,
      key: const ValueKey('task-graph-count'),
      style: const TextStyle(
        fontFamily: 'monospace',
        fontSize: 11,
        color: AppColors.faint,
      ),
    );
  }

  Widget _buildLegend() {
    final sub = _sub;
    final hasShell = sub != null && sub.nodes.any((n) => n.isShell);
    final hasProvisional =
        sub != null && sub.nodes.any((n) => n.isTask && n.provisional);
    return Wrap(
      key: const ValueKey('task-graph-legend'),
      spacing: 12,
      runSpacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        // Web 的 renderLegend()（`task-graph.js:399`）只画当前子图里出现过的
        // 状态，图例会随筛选变长变短。手机上这里固定画全套色卡：切项目时布局
        // 不跳动，而且「图上没有 W」这件事本身就是信息（图例齐、节点不全 =
        // 这一类现在没有）。任务壳 / provisional 两条仍按需出现 —— 它们是
        // 「当前图里有这种节点」的提示，不是色卡的一行。
        for (final key in TaskGraphPalette.classifyLegendKeys)
          _LegendSwatch(
            key: ValueKey('task-graph-legend-classify-$key'),
            color: TaskGraphPalette.classifyColor(key == 'null' ? null : key),
            label: TaskGraphPalette.classifyLabel(key == 'null' ? null : key),
          ),
        if (hasShell) const _LegendShell(),
        if (hasProvisional) const _LegendProvisional(),
        for (final type in TaskGraphPalette.edgeColors.keys)
          _LegendEdge(type: type),
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
    // 文案照抄 Web（`task-graph.js:116`）。
    return const Center(
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: 24),
        child: Text(
          '暂无任务节点。任务看板或任务壳里出现任务后，这里会画出父子 / 分组 / 合并 / 壳链接。',
          key: ValueKey('task-graph-empty'),
          textAlign: TextAlign.center,
          style: TextStyle(color: AppColors.muted, fontSize: 12.5, height: 1.6),
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
              // 前缀与 Web 一致（`task-graph.js:80`）；后面是原始错误。
              '加载失败：$_error',
              key: const ValueKey('task-graph-error'),
              textAlign: TextAlign.center,
              style: const TextStyle(
                color: AppColors.danger,
                fontSize: 12.5,
                height: 1.6,
              ),
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              key: const ValueKey('task-graph-retry'),
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
            canvasKey: const ValueKey('task-graph-canvas'),
            painterBuilder: (layout, repaint) =>
                _TaskGraphPainter(layout: layout, repaint: repaint),
          ),
        ),
        Positioned(
          left: 10,
          bottom: 8,
          child: IgnorePointer(
            child: Text(
              // Web 的提示是「拖拽平移 · 滚轮缩放 · 点击节点看详情 · 拖动节点可
              // 固定」（manage.html:1120）；手机上把滚轮换成捏合，其余照抄。
              '拖拽平移 · 双指缩放 · 双击适配 · 点击节点看详情 · 拖动节点可固定',
              style: TextStyle(fontSize: 10, color: AppColors.faint),
            ),
          ),
        ),
      ],
    );
  }
}

/// 画布本体。Web 是 SVG（每个节点一个 `<g>`），这里是手画：手机上没有 hover、
/// 也不需要 DOM 命中。视图变换、标签（含缩放级抽稀）、虚线/箭头工具都在
/// [GraphPainter] 里，这里只画任务图谱自己的形状 —— 记忆图谱另有一份 painter。
class _TaskGraphPainter extends GraphPainter {
  _TaskGraphPainter({required super.layout, required super.repaint});

  @override
  void paintLinks(Canvas canvas) {
    for (final link in layout.links) {
      final edge = link.payload as TaskGraphEdge;
      final a = link.source;
      final b = link.target;
      final dx = b.x - a.x;
      final dy = b.y - a.y;
      final distance = math.sqrt(dx * dx + dy * dy);
      if (distance < 0.01) continue;
      final ux = dx / distance;
      final uy = dy / distance;
      // 两端各留一点空隙：起点退半个源半径、终点退到目标半径外 5
      // （Web `paint()`，`task-graph.js:296-297`）。
      final start = Offset(
        a.x + ux * (a.radius * 0.6),
        a.y + uy * (a.radius * 0.6),
      );
      final end = Offset(b.x - ux * (b.radius + 5), b.y - uy * (b.radius + 5));

      final paint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.1
        ..color = TaskGraphPalette.edgeColor(edge.type);
      if (edge.dashed) {
        GraphPainter.dashedLine(
          canvas,
          start,
          end,
          paint,
          edge.type == 'merged'
              ? const <double>[4, 3]
              : const <double>[2, 2],
        );
      } else {
        canvas.drawLine(start, end, paint);
      }
      // 箭头统一灰色（Web 只有一支写死颜色的 marker，`task-graph.js:241`）。
      GraphPainter.arrowHead(canvas, end, Offset(ux, uy));
    }
  }

  @override
  void paintNode(Canvas canvas, GraphNode entry) {
    final node = entry.payload as TaskGraphNode;
    final center = Offset(entry.x, entry.y);
    if (node.isShell) {
      // 任务壳：rotate(45°) 的方块 = 小菱形，归档的再降透明度
      // （`task-graph.js:262-265`）。
      final side = entry.radius * 1.8;
      final rect = Rect.fromCenter(
        center: Offset.zero,
        width: side,
        height: side,
      );
      final fill = Paint()
        ..style = PaintingStyle.fill
        ..color = TaskGraphPalette.shellFill.withValues(
          alpha: node.archived ? 0.35 : 0.85,
        );
      final stroke = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..color = TaskGraphPalette.shellStroke;
      canvas.save();
      canvas.translate(center.dx, center.dy);
      canvas.rotate(math.pi / 4);
      canvas.drawRect(rect, fill);
      canvas.drawRect(rect, stroke);
      canvas.restore();
      return;
    }
    final classify = TaskGraphPalette.classifyColor(node.classifyState);
    // provisional 半透明（身份未锁）/ 其余实色 0.92（`task-graph.js:274`）。
    final fill = Paint()
      ..style = PaintingStyle.fill
      ..color = classify.withValues(alpha: node.provisional ? 0.4 : 0.92);
    final done = node.status == 'done' || node.status == 'archived';
    final stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = done ? 1.4 : 1
      ..color = done
          ? TaskGraphPalette.doneRing
          : const Color(0x59000000); // rgba(0,0,0,.35)
    canvas.drawCircle(center, entry.radius, fill);
    canvas.drawCircle(center, entry.radius, stroke);
  }
}
/// 节点详情底部面板 —— 对应 Web 的 `#tg-node-modal` / `tgNodeModalOpen()`
/// （`task-graph.js:428-501`）：标签区 + 详情行 + 出/入邻居，点邻居换人。
class _NodeDetailSheet extends StatefulWidget {
  const _NodeDetailSheet({
    required this.layout,
    required this.initialId,
    required this.onFocus,
    this.onOpenTaskInAir,
  });

  /// 当前子图的布局（节点位置每帧都在动）—— 详情面板只读它的拓扑与 payload。
  final GraphLayout layout;
  final String initialId;

  /// 点邻居时把画布视口挪过去（`focusNode()`）。
  final ValueChanged<String> onFocus;
  final void Function(String dirId, String taskId)? onOpenTaskInAir;

  @override
  State<_NodeDetailSheet> createState() => _NodeDetailSheetState();
}

class _NodeDetailSheetState extends State<_NodeDetailSheet> {
  late String _id = widget.initialId;

  void _jumpTo(String id) {
    setState(() => _id = id);
    widget.onFocus(id);
  }

  @override
  Widget build(BuildContext context) {
    final node = widget.layout.byId[_id]?.payload as TaskGraphNode?;
    if (node == null) return const SizedBox.shrink();

    final out = <_Neighbor>[];
    final incoming = <_Neighbor>[];
    for (final link in widget.layout.links) {
      final edge = link.payload as TaskGraphEdge;
      if (edge.source == node.id) {
        out.add(_Neighbor(link.target.payload as TaskGraphNode, edge.type));
      } else if (edge.target == node.id) {
        incoming.add(_Neighbor(link.source.payload as TaskGraphNode, edge.type));
      }
    }

    final openAir = widget.onOpenTaskInAir;
    final dirId = node.dirId;
    final canOpenAir =
        openAir != null && node.isTask && dirId != null && dirId.isNotEmpty;

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
                      // 壳标题前面那个 ◈ 也是 Web 的（`task-graph.js:435`）。
                      node.isShell
                          ? '◈ ${node.title}'
                          : (node.title.isNotEmpty ? node.title : node.id),
                      key: const ValueKey('task-graph-node-title'),
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
                dirId == null || dirId.isEmpty
                    ? node.id
                    : '${node.id}   ·   $dirId',
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: AppColors.faint,
                ),
              ),
              const SizedBox(height: 10),
              Wrap(children: _tags(node)),
              if (canOpenAir)
                Padding(
                  padding: const EdgeInsets.only(top: 6, bottom: 4),
                  child: FilledButton.icon(
                    key: const ValueKey('task-graph-open-air'),
                    onPressed: () => openAir(dirId, node.id),
                    icon: const Icon(Icons.open_in_new_rounded, size: 16),
                    label: const Text('在 Air 打开'),
                    style: FilledButton.styleFrom(
                      backgroundColor: AppColors.accentDark,
                      foregroundColor: AppColors.onAccent,
                      minimumSize: const Size(0, 38),
                    ),
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
                  _detailText(node),
                  key: const ValueKey('task-graph-node-detail'),
                  style: const TextStyle(
                    color: AppColors.text,
                    fontSize: 12.5,
                    height: 1.6,
                  ),
                ),
              ),
              const SizedBox(height: 12),
              ..._links('指向', out, '→'),
              ..._links('被指向', incoming, '←'),
              if (out.isEmpty && incoming.isEmpty)
                const Text(
                  // 原文照抄 Web（`task-graph.js:498`）。
                  '（暂无关联，孤立节点）',
                  style: TextStyle(color: AppColors.faint, fontSize: 12),
                ),
            ],
          ),
        ),
      ),
    );
  }

  /// 标签区（Web `tgNodeModalOpen` 的 addTag 段，`task-graph.js:439-452`）。
  List<Widget> _tags(TaskGraphNode node) {
    final tags = <String>[];
    if (node.isShell) {
      tags.add('任务壳');
      if (node.archived) tags.add('已归档');
      final current = node.currentTaskId;
      if (current != null && current.isNotEmpty) {
        tags.add('当前任务 ${graphTruncate(current, 20)}');
      }
    } else {
      tags.add(node.provisional ? 'provisional（身份未锁）' : 'canonical');
      final classify = node.classifyState;
      if (classify != null && classify.isNotEmpty) {
        tags.add(
          'classify $classify · ${TaskGraphPalette.classifyName(classify)}',
        );
      }
      if (node.status != null) tags.add('状态: ${node.status}');
      if (node.runState != null) tags.add('运行: ${node.runState}');
      if (node.workflowStage != null) tags.add('阶段: ${node.workflowStage}');
      if (node.origin != null) tags.add('来源: ${node.origin}');
      if (node.deleted) tags.add('已删除');
      tags.add('关联度: ${node.degree}');
    }
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

  /// 详情行（Web `task-graph.js:455-465`）：没有一行可写时给「（无更多详情）」。
  String _detailText(TaskGraphNode node) {
    final lines = <String>[];
    if (node.goal != null) lines.add('目标：${node.goal}');
    if (node.phase != null) lines.add('阶段：${node.phase}');
    if (node.parentTaskId != null) lines.add('父任务：${node.parentTaskId}');
    if (node.groupId != null) lines.add('任务组：${node.groupId}');
    if (node.mergedInto != null) lines.add('已合并进：${node.mergedInto}');
    final session = node.chatSessionId ?? node.sessionId;
    if (session != null) lines.add('绑定会话：$session');
    if (!node.isShell && node.sources.isNotEmpty) {
      lines.add('记录来源：${node.sources.join(' + ')}');
    }
    return lines.isEmpty ? '（无更多详情）' : lines.join('\n');
  }

  List<Widget> _links(String title, List<_Neighbor> items, String arrow) {
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
              key: ValueKey('task-graph-neighbor-${item.node.id}'),
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
                '$arrow [${TaskGraphPalette.edgeLabel(item.type)}] '
                '${item.node.title.isNotEmpty ? item.node.title : item.node.id}',
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12, color: AppColors.text),
              ),
            ),
          ),
        ),
    ];
  }
}

/// 邻居行：一条边连到的那个节点 + 这条边的类型（中文标签用它）。
class _Neighbor {
  const _Neighbor(this.node, this.type);

  final TaskGraphNode node;
  final String type;
}

/// 图例里的一个圆点 + 文案。
class _LegendSwatch extends StatelessWidget {
  const _LegendSwatch({super.key, required this.color, required this.label});

  final Color color;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 11,
          height: 11,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
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

/// 图例里的任务壳（小菱形，照 Web `renderLegend()` 的 rotate(45deg) 方块）。
class _LegendShell extends StatelessWidget {
  const _LegendShell();

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Transform.rotate(
          angle: math.pi / 4,
          child: Container(
            width: 9,
            height: 9,
            decoration: BoxDecoration(
              color: TaskGraphPalette.shellFill.withValues(alpha: 0.85),
              border: Border.all(color: TaskGraphPalette.shellStroke),
            ),
          ),
        ),
        const SizedBox(width: 5),
        const Text(
          '任务壳',
          style: TextStyle(fontSize: 11, color: AppColors.muted),
        ),
      ],
    );
  }
}

/// 图例里的 provisional 提示（Web 用半透明灰点 + 括号里那句中文）。
class _LegendProvisional extends StatelessWidget {
  const _LegendProvisional();

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: 0.6,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 11,
            height: 11,
            decoration: BoxDecoration(
              color: TaskGraphPalette.classifyNullColor.withValues(alpha: 0.4),
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 5),
          const Text(
            'provisional(身份未锁)',
            style: TextStyle(fontSize: 11, color: AppColors.muted),
          ),
        ],
      ),
    );
  }
}

/// 图例里的边类型：一个短横 + 着色标签（Web 是「—<span>父任务</span>」）。
class _LegendEdge extends StatelessWidget {
  const _LegendEdge({required this.type});

  final String type;

  @override
  Widget build(BuildContext context) {
    final color = TaskGraphPalette.edgeColor(type);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text('—', style: TextStyle(fontSize: 11, color: AppColors.faint)),
        const SizedBox(width: 3),
        Text(
          TaskGraphPalette.edgeLabel(type),
          style: TextStyle(fontSize: 11, color: color),
        ),
      ],
    );
  }
}
