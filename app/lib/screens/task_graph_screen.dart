import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:http/http.dart' as http;

import '../services/settings_service.dart';
import '../services/task_graph_service.dart';
import '../theme.dart';

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

  /// 箭头统一灰色 —— Web 只有一支配色写死的 marker，所有边共用
  /// （`task-graph.js:241-244`）。
  static const Color arrowColor = Color(0xFF6E7681);

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
    with SingleTickerProviderStateMixin {
  static const double _minScale = 0.2;
  static const double _maxScale = 2.0;

  /// fitView 的 padding，和 Web 一样固定 40（`task-graph.js:312`）。
  static const double _fitPadding = 40;

  late final TaskGraphService _service = TaskGraphService(
    settings: widget.settings,
    httpClient: widget.httpClient,
  );

  /// 全量 payload —— 只在刷新时重取，切项目不动它（Web 的 `_taskRaw`）。
  TaskGraphPayload? _raw;

  /// 当前子图（过滤后的）。计数行 / 图例 / 画布都看它。
  TaskGraphPayload? _sub;

  /// 力导向布局 + 视图变换。空图时为 null。
  _GraphLayout? _graph;

  bool _loading = true;
  String? _error;
  String _project = 'all';

  /// 画布尺寸（LayoutBuilder 给的），力导向的 `k` 与 fitView 都要它。
  Size _size = Size.zero;

  /// 数据到了但画布尺寸还没到手 —— 等下一帧 LayoutBuilder 里再热身。
  bool _pendingPrepare = false;

  /// 只有「节点/边集合变了」才需要重建 painter（setState）；位置变化走
  /// [_repaint]，**不** setState —— 一帧一次 setState 会让整棵树重 build。
  final _Repaint _repaint = _Repaint();

  /// 力导向的驱动。用不重复的 AnimationController 每帧回调一次：Web 是
  /// `requestAnimationFrame` + `alpha *= 0.94`，收敛条件一致，而且到点就
  /// `stop()`（ticker 不留着空转）。
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 1),
  )..addListener(_step);

  double _alpha = 0;
  double _decay = 0.94;
  int _ticksPerFrame = 2;
  int _frames = 0;
  int _maxFrames = 200;

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
    _controller.dispose();
    _repaint.dispose();
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
    _stopSim();
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
        _graph = null;
      });
      _stopSim();
    }
  }

  /// 客户端过滤（Web `filterPayload()`）：只留 `dirId` 命中的节点，边两端
  /// 都在子图里才留。
  void _applyFilter() {
    final raw = _raw;
    if (raw == null) return;
    final sub = raw.filterByProject(_project);
    _sub = sub;
    if (sub.nodes.isEmpty) {
      _graph = null;
      _stopSim();
      return;
    }
    _graph = _GraphLayout.build(sub);
    if (_size.width < 1 || _size.height < 1) {
      _pendingPrepare = true;
      return;
    }
    _prepare(_graph!);
  }

  void _selectProject(String? dirId) {
    if (dirId == null || dirId == _project) return;
    setState(() {
      _project = dirId;
      _stopSim();
      _applyFilter();
    });
  }

  // ── 力导向（与 Web `task-graph.js:165-235` 同构）─────────────────────────

  /// 黄金角螺旋初值：不用随机数，所以同一个 payload 每次画出来都一样
  /// （截图对比、测试命中坐标都靠这个）。
  void _initPositions(_GraphLayout graph) {
    final count = graph.nodes.length;
    if (count == 0) return;
    final cx = _size.width / 2;
    final cy = _size.height / 2;
    final spread = math.min(_size.width, _size.height) * 0.4;
    for (var i = 0; i < count; i++) {
      final node = graph.nodes[i];
      final angle = i * 2.399963; // 黄金角
      final radius = spread * math.sqrt((i + 1) / count);
      node.x = cx + radius * math.cos(angle);
      node.y = cy + radius * math.sin(angle);
    }
  }

  /// Web 在 `loadTaskGraph` 后先同步跑一批「热身」迭代再显示
  /// （`task-graph.js:125-126`），这样第一帧就不是一团毛线。
  ///
  /// 退化：小图（≤400）照 Web 的 `clamp(3600/n, 8, 60)`；大图砍到 6 次 ——
  /// 一步 tick 是 O(n²)，1000 节点一次约 50 万次配对，60 次就是 3000 万次，
  /// 手机上那是肉眼可见的卡顿，而多跑几次对「别看起来像毛线」帮助有限。
  void _warmUp(_GraphLayout graph) {
    final count = graph.nodes.length;
    if (count == 0) return;
    final warm = count <= 400
        ? math.max(8, math.min(60, (3600 / count).round()))
        : 6;
    for (var i = 0; i < warm; i++) {
      _tick(graph, 0.9);
    }
  }

  /// Fruchterman-Reingold 的一步（逐条对齐 `task-graph.js:178-221`）。
  void _tick(_GraphLayout graph, double temp) {
    final nodes = graph.nodes;
    final edges = graph.edges;
    final count = nodes.length;
    if (count == 0) return;

    final area = _size.width * _size.height;
    final k = 1.1 * math.sqrt(area / count);
    final k2 = k * k;
    final cx = _size.width / 2;
    final cy = _size.height / 2;

    for (final node in nodes) {
      node.fx = 0;
      node.fy = 0;
    }

    // 斥力 k²/d²：两两配对，O(n²) —— 大图的瓶颈就在这个双层循环。
    for (var i = 0; i < count; i++) {
      final a = nodes[i];
      for (var j = i + 1; j < count; j++) {
        final b = nodes[j];
        var dx = a.x - b.x;
        var dy = a.y - b.y;
        var d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = (i - j) * 0.1 + 0.05;
          dy = 0.05;
          d2 = dx * dx + dy * dy;
        }
        final d = math.sqrt(d2);
        final force = k2 / d2;
        final ux = dx / d;
        final uy = dy / d;
        a.fx += ux * force;
        a.fy += uy * force;
        b.fx -= ux * force;
        b.fy -= uy * force;
      }
    }

    // 弹簧 d²/k：父子 / 合并比同组 / 壳链接更强，家族靠得更近。
    for (final edge in edges) {
      final a = edge.source;
      final b = edge.target;
      final dx = b.x - a.x;
      final dy = b.y - a.y;
      final d = math.sqrt(dx * dx + dy * dy);
      if (d < 0.01) continue;
      final weight = edge.edge.type == 'parent' || edge.edge.type == 'merged'
          ? 2.4
          : edge.edge.type == 'group'
          ? 1.4
          : 1.0;
      final force = (d * d) / k * (0.6 + weight * 0.1);
      final ux = dx / d;
      final uy = dy / d;
      a.fx += ux * force;
      a.fy += uy * force;
      b.fx -= ux * force;
      b.fy -= uy * force;
    }

    final maxStep = 26 * temp;
    for (final node in nodes) {
      node.fx += (cx - node.x) * 0.009;
      node.fy += (cy - node.y) * 0.009;
      final length = math.sqrt(node.fx * node.fx + node.fy * node.fy);
      if (length < 0.0001) continue;
      final step = math.min(length, maxStep);
      node.x += (node.fx / length) * step;
      node.y += (node.fy / length) * step;
    }
  }

  /// 热身 + fitView + 起动画。
  void _prepare(_GraphLayout graph) {
    _pendingPrepare = false;
    _initPositions(graph);
    _warmUp(graph);
    fitView();
    _startSim(graph);
  }

  void _startSim(_GraphLayout graph) {
    final count = graph.nodes.length;
    if (count == 0) return;
    // 退化：>400 节点时每帧只推 1 步、alpha 衰减加快到 0.85（约 18 帧收敛）、
    // 帧数封顶 24。总配对量因此从「上万帧 × 50 万」降到百万量级，画面依旧
    // 会自己长出来，但不会 ANR。
    if (count <= 400) {
      _ticksPerFrame = 2;
      _decay = 0.94;
      _maxFrames = 200;
    } else {
      _ticksPerFrame = 1;
      _decay = 0.85;
      _maxFrames = 24;
    }
    _frames = 0;
    _alpha = 0.6;
    // 可能是在 build 里被调到的（LayoutBuilder 补尺寸那一次），起动画推迟到
    // 本帧结束，别在 build 期间动调度器。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _disposed) return;
      if (_graph == null || _controller.isAnimating) return;
      _controller.repeat();
    });
  }

  void _step() {
    final graph = _graph;
    if (graph == null) {
      _controller.stop();
      return;
    }
    for (var i = 0; i < _ticksPerFrame; i++) {
      _tick(graph, _alpha);
    }
    _alpha *= _decay;
    _frames++;
    _repaint.ping();
    // Web 的收敛条件：alpha < 0.03 收工（`task-graph.js:229-230`）。
    // 大图另有帧数封顶，见 _startSim。
    if (_alpha < 0.03 || _frames >= _maxFrames) {
      _controller.stop();
      _alpha = 0;
    }
  }

  void _stopSim() {
    if (_controller.isAnimating) _controller.stop();
    _alpha = 0;
    _frames = 0;
  }

  // ── 视图：fit / 缩放 / 平移 / 命中 ──────────────────────────────────────

  /// 双击 / 首次加载用的适配：包围盒（含半径）加 40 padding 居中。
  /// 逐条对齐 Web `fitView()`（`task-graph.js:304-317`）。
  void fitView() {
    final graph = _graph;
    if (graph == null || graph.nodes.isEmpty) return;
    if (_size.width < 1 || _size.height < 1) return;
    var minX = double.infinity;
    var minY = double.infinity;
    var maxX = -double.infinity;
    var maxY = -double.infinity;
    for (final node in graph.nodes) {
      minX = math.min(minX, node.x - node.radius);
      minY = math.min(minY, node.y - node.radius);
      maxX = math.max(maxX, node.x + node.radius);
      maxY = math.max(maxY, node.y + node.radius);
    }
    final bw = math.max(maxX - minX, 1.0);
    final bh = math.max(maxY - minY, 1.0);
    final scale = math
        .min(
          (_size.width - _fitPadding) / bw,
          (_size.height - _fitPadding) / bh,
        )
        .clamp(_minScale, _maxScale);
    graph.scale = scale;
    graph.tx = (_size.width - (minX + maxX) * scale) / 2;
    graph.ty = (_size.height - (minY + maxY) * scale) / 2;
    _repaint.ping();
  }

  /// 把某个节点挪到视口正中（Web `focusNode()`，`task-graph.js:504`）——
  /// 点邻居之后用的。
  void focusNode(String id) {
    final graph = _graph;
    if (graph == null) return;
    final node = graph.byId[id];
    if (node == null) return;
    graph.tx = _size.width / 2 - node.x * graph.scale;
    graph.ty = _size.height / 2 - node.y * graph.scale;
    _repaint.ping();
  }

  /// 画布命中测试：返回半径 + [slack] 内最近的节点 id。
  ///
  /// 公开是为了让测试用同一个判定拿坐标去 `tapAt` —— 力导向的结果没法在测试
  /// 里重算，硬编码坐标只会变成一颗定时炸弹。
  String? hitTestNodeId(Offset local, {double slack = 6}) {
    final graph = _graph;
    if (graph == null) return null;
    final lx = (local.dx - graph.tx) / graph.scale;
    final ly = (local.dy - graph.ty) / graph.scale;
    String? best;
    var bestDistance = double.infinity;
    for (final node in graph.nodes) {
      final dx = node.x - lx;
      final dy = node.y - ly;
      final distance = math.sqrt(dx * dx + dy * dy);
      if (distance > node.radius + slack / graph.scale) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = node.node.id;
      }
    }
    return best;
  }

  /// 节点中心在画布坐标系里的位置（测试算点击坐标用；画布外返回 null）。
  Offset? nodeCenterInCanvas(String id) {
    final graph = _graph;
    if (graph == null) return null;
    final node = graph.byId[id];
    if (node == null) return null;
    return Offset(
      node.x * graph.scale + graph.tx,
      node.y * graph.scale + graph.ty,
    );
  }

  // ── 手势 ───────────────────────────────────────────────────────────────

  double _gestureStartScale = 1;

  void _onScaleStart(ScaleStartDetails details) {
    _gestureStartScale = _graph?.scale ?? 1;
  }

  void _onScaleUpdate(ScaleUpdateDetails details) {
    final graph = _graph;
    if (graph == null) return;
    if (details.pointerCount >= 2) {
      // 双指捏合：以焦点为锚点缩放（Web 滚轮缩放是同一套算法，
      // `zoomAt()` `task-graph.js:379`）。
      final next = (_gestureStartScale * details.scale).clamp(
        _minScale,
        _maxScale,
      );
      final lx = (details.localFocalPoint.dx - graph.tx) / graph.scale;
      final ly = (details.localFocalPoint.dy - graph.ty) / graph.scale;
      graph.scale = next;
      graph.tx = details.localFocalPoint.dx - lx * next;
      graph.ty = details.localFocalPoint.dy - ly * next;
    } else {
      // 单指拖拽 = 平移。
      graph.tx += details.focalPointDelta.dx;
      graph.ty += details.focalPointDelta.dy;
    }
    _repaint.ping();
  }

  void _onTapUp(TapUpDetails details) {
    final id = hitTestNodeId(details.localPosition);
    if (id != null) unawaited(openNodeDetails(id));
  }

  /// 点节点 → 底部详情面板（Web 的 `tgNodeModalOpen`，`task-graph.js:428`）。
  Future<void> openNodeDetails(String id) async {
    final graph = _graph;
    if (graph == null || !graph.byId.containsKey(id)) return;
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
        layout: graph,
        initialId: id,
        onFocus: (next) {
          if (_disposed) return;
          focusNode(next);
        },
        onOpenTaskInAir: widget.onOpenTaskInAir,
      ),
    );
  }

  // ── 构建 ───────────────────────────────────────────────────────────────

  /// 画布尺寸（Web `measure()`，`task-graph.js:159`）。位置是按 W/H 归一化
  /// 出来的，尺寸没到手之前没法热身；尺寸变了（转屏、分屏）就地重热一次。
  void _syncCanvasSize(Size size) {
    // 尺寸不是一个有限的、够大的矩形时不记：力导向的 `k = 1.1*sqrt(W*H/n)` 和
    // fitView 都会被 0/∞ 带着算出 NaN，那之后整张图就再也画不出来了。
    if (!size.isFinite || size.width < 1 || size.height < 1) return;
    final resized =
        (size.width - _size.width).abs() > 0.5 ||
        (size.height - _size.height).abs() > 0.5;
    _size = size;
    final graph = _graph;
    if (graph == null) return;
    if (_pendingPrepare) {
      _prepare(graph);
      return;
    }
    if (resized) {
      _warmUp(graph);
      fitView();
      _repaint.ping();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        title: const Text('任务图谱'),
        actions: [
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
    } else if (_graph == null) {
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
    return LayoutBuilder(
      builder: (context, constraints) {
        _syncCanvasSize(constraints.biggest);
        final graph = _graph;
        if (graph == null) return const SizedBox.expand();
        return GestureDetector(
          key: const ValueKey('task-graph-canvas'),
          behavior: HitTestBehavior.opaque,
          onScaleStart: _onScaleStart,
          onScaleUpdate: _onScaleUpdate,
          onTapUp: _onTapUp,
          onDoubleTap: fitView,
          child: Stack(
            children: [
              Positioned.fill(
                child: CustomPaint(
                  painter: _TaskGraphPainter(layout: graph, repaint: _repaint),
                ),
              ),
              Positioned(
                left: 10,
                bottom: 8,
                child: IgnorePointer(
                  child: Text(
                    // Web 的提示是「拖拽平移 · 滚轮缩放 · 点击节点看详情 ·
                    // 拖动节点可固定」（manage.html:1120）；手机上换成捏合，
                    // 也不做节点拖拽（见 _TaskGraphPainter 的取舍说明）。
                    '拖拽平移 · 双指缩放 · 双击适配 · 点击节点看详情',
                    style: TextStyle(fontSize: 10, color: AppColors.faint),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// 力导向布局的一帧快照：节点位置/半径/标签 + 视图变换（tx/ty/scale）。
///
/// 这些数字每帧都在动，但它们**不是** widget 状态 —— 只有「节点/边集合」变了
/// 才需要重建（setState），位置变化走 [_Repaint] 只重绘不重建。
class _GraphLayout {
  _GraphLayout.build(TaskGraphPayload payload) {
    final withLabels = payload.nodes.length <= labelMaxNodes;
    for (final node in payload.nodes) {
      final entry = _GraphNode(node);
      nodes.add(entry);
      byId[node.id] = entry;
      if (withLabels) entry.label = _buildLabel(node);
    }
    for (final edge in payload.edges) {
      // 两端都得在这张子图里（Web `buildGraph()` 里那句 continue，
      // `task-graph.js:151-155`）；`filterByProject` 已经保证过一遍，这里是
      // 防脏数据（比如边指向一个被截断掉的节点）。
      final source = byId[edge.source];
      final target = byId[edge.target];
      if (source == null || target == null) continue;
      edges.add(_GraphEdge(edge, source, target));
    }
  }

  final List<_GraphNode> nodes = <_GraphNode>[];
  final List<_GraphEdge> edges = <_GraphEdge>[];
  final Map<String, _GraphNode> byId = <String, _GraphNode>{};

  double scale = 1;
  double tx = 0;
  double ty = 0;

  /// 标签总数封顶：每个标签是一个 TextPainter（构建时 layout 一次，之后每帧
  /// 只 paint），但 400 个以上就没必要了 —— 那个尺度上字是糊的，不如把这一帧
  /// 的时间留给力导向。Web 那边是 1000 个 SVG `<text>` 直接扔给浏览器。
  static const int labelMaxNodes = 400;

  /// 标签文本：Web 只给 `degree > 0` 的节点画（`task-graph.js:279`，degree 0
  /// 的节点 opacity 设成 0），壳用 title、任务用 title 兜底 id，截断 18 字
  /// （`truncate()`，`task-graph.js:55`）。
  static TextPainter? _buildLabel(TaskGraphNode node) {
    if (node.degree <= 0) return null;
    final raw = node.isShell
        ? node.title
        : (node.title.isNotEmpty ? node.title : node.id);
    if (raw.isEmpty) return null;
    return TextPainter(
      text: TextSpan(
        text: _truncate(raw, 18),
        // Web 的标签是 10px 等宽、fill #adbac7 —— 那是深色画布上的颜色，
        // 这里的画布是浅色（AppColors.panel），改用 AppColors.muted 才看得
        // 清。这是有意偏离 Web 的唯一一处配色。
        style: const TextStyle(
          fontSize: 10,
          fontFamily: 'monospace',
          color: AppColors.muted,
        ),
      ),
      textDirection: TextDirection.ltr,
      maxLines: 1,
    )..layout();
  }
}

/// 布局里的一个节点：接口数据 + 每帧变化的位置 + 预排好的标签。
class _GraphNode {
  _GraphNode(this.node)
    : radius = node.isShell ? 3.5 : 6 + math.min(node.degree, 12) * 1.4;

  final TaskGraphNode node;

  /// 半径：任务按关联度长大（`6 + min(degree,12) * 1.4`），壳是配角固定
  /// 3.5 —— 见 `task-graph.js:146`。
  final double radius;

  double x = 0;
  double y = 0;
  double fx = 0;
  double fy = 0;

  /// 只在 `degree > 0` 且节点总数不过多时才有（见 `_GraphLayout._buildLabel`）。
  TextPainter? label;
}

/// 布局里的一条边（两端已经解析成节点对象）。
class _GraphEdge {
  const _GraphEdge(this.edge, this.source, this.target);

  final TaskGraphEdge edge;
  final _GraphNode source;
  final _GraphNode target;
}

/// CustomPainter 的 repaint 通道。位置每帧都在动，走这里只重绘、不重建整棵树
/// —— 每帧 setState 会让整页（含下拉、图例）跟着 rebuild。
class _Repaint extends ChangeNotifier {
  bool _closed = false;

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }

  void ping() {
    if (_closed) return;
    if (WidgetsBinding.instance.schedulerPhase ==
        SchedulerPhase.persistentCallbacks) {
      // 布局/绘制阶段（LayoutBuilder 的 builder 就在这里面）直接
      // markNeedsPaint 会撞 Flutter 的断言，推迟到本帧结束再重绘。
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_closed) notifyListeners();
      });
      return;
    }
    notifyListeners();
  }
}

/// 画布本体。Web 是 SVG（每个节点一个 `<g>`），这里是手画：手机上没有 hover、
/// 也不需要 DOM 命中，命中测试交给 `TaskGraphScreenState.hitTestNodeId`。
///
/// 取舍：不做「拖动节点固定」（Web `onNodePointerMove` + pinned，
/// `task-graph.js:336-343`）—— 手指按住节点时不放大到能精确拖，缩放后坐标
/// 还会串味；单指留给平移、点节点看详情已经够用。
class _TaskGraphPainter extends CustomPainter {
  _TaskGraphPainter({required this.layout, required Listenable repaint})
    : super(repaint: repaint);

  final _GraphLayout layout;

  @override
  void paint(Canvas canvas, Size size) {
    if (layout.nodes.isEmpty) return;
    canvas.save();
    canvas.translate(layout.tx, layout.ty);
    canvas.scale(layout.scale);
    _paintEdges(canvas);
    _paintNodes(canvas);
    canvas.restore();
  }

  void _paintEdges(Canvas canvas) {
    for (final edge in layout.edges) {
      final a = edge.source;
      final b = edge.target;
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
        ..color = TaskGraphPalette.edgeColor(edge.edge.type);
      if (edge.edge.dashed) {
        _dashedLine(
          canvas,
          start,
          end,
          paint,
          edge.edge.type == 'merged'
              ? const <double>[4, 3]
              : const <double>[2, 2],
        );
      } else {
        canvas.drawLine(start, end, paint);
      }
      _arrowHead(canvas, end, Offset(ux, uy));
    }
  }

  void _paintNodes(Canvas canvas) {
    for (final entry in layout.nodes) {
      final node = entry.node;
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
      } else {
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
      final label = entry.label;
      if (label != null) {
        // 近似 SVG 的 text-anchor=middle + dy=r+11：横向居中、纵向让文字底部
        // 落在「半径 + 11」那条线上（基线就在那附近）。
        label.paint(
          canvas,
          Offset(
            entry.x - label.width / 2,
            entry.y + entry.radius + 11 - label.height,
          ),
        );
      }
    }
  }

  /// 虚线：dart:ui 还没有公开的 `PathEffect`，照 Web 的 `stroke-dasharray`
  /// （merged `4 3`、shell-link `2 2`）自己切段。段长按布局单位算 —— 画布已经
  /// scale 过，和 SVG transform 下的表现一致。
  static void _dashedLine(
    Canvas canvas,
    Offset from,
    Offset to,
    Paint paint,
    List<double> pattern,
  ) {
    final total = (to - from).distance;
    if (total <= 0.01) return;
    final direction = (to - from) / total;
    var travelled = 0.0;
    var index = 0;
    var on = true;
    while (travelled < total - 0.01) {
      final next = math.min(travelled + pattern[index % pattern.length], total);
      if (on) {
        canvas.drawLine(
          from + direction * travelled,
          from + direction * next,
          paint,
        );
      }
      travelled = next;
      index++;
      on = !on;
    }
  }

  /// 箭头：Web 用同一个 `marker-end`（写死灰色 #6e7681，`task-graph.js:241`），
  /// 这里也一样 —— 四种边色各自的箭头反而更花。
  static void _arrowHead(Canvas canvas, Offset tip, Offset direction) {
    const length = 6.0;
    const half = 2.6;
    final back = tip - direction * length;
    final normal = Offset(-direction.dy, direction.dx) * half;
    final path = Path()
      ..moveTo(tip.dx, tip.dy)
      ..lineTo(back.dx + normal.dx, back.dy + normal.dy)
      ..lineTo(back.dx - normal.dx, back.dy - normal.dy)
      ..close();
    canvas.drawPath(
      path,
      Paint()
        ..style = PaintingStyle.fill
        ..color = TaskGraphPalette.arrowColor,
    );
  }

  @override
  bool shouldRepaint(covariant _TaskGraphPainter oldDelegate) =>
      oldDelegate.layout != layout;
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

  final _GraphLayout layout;
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
    final node = widget.layout.byId[_id]?.node;
    if (node == null) return const SizedBox.shrink();

    final out = <_Neighbor>[];
    final incoming = <_Neighbor>[];
    for (final edge in widget.layout.edges) {
      if (edge.edge.source == node.id) {
        out.add(_Neighbor(edge.target.node, edge.edge.type));
      } else if (edge.edge.target == node.id) {
        incoming.add(_Neighbor(edge.source.node, edge.edge.type));
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
        tags.add('当前任务 ${_truncate(current, 20)}');
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

/// Web 的 `truncate(s, n)`：超长时留 n-1 个字符 + 一个省略号
/// （`task-graph.js:55`）。
String _truncate(String value, int max) {
  if (value.length <= max) return value;
  return '${value.substring(0, max - 1)}…';
}
