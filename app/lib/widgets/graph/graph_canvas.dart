import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../../theme.dart';

// 图谱画布 —— 任务图谱（Web `public/task-graph.js`）与记忆图谱
// （Web `public/memory-graph.js`）共用的一套力导向 + 视图变换 + 手势。
//
// Web 那两张图是两份各自独立的渲染器（约 400 / 520 行），但物理参数、视图变换、
// 指针交互是同一套：黄金角螺旋初值、Fruchterman-Reingold 一步、中心引力 0.009、
// `maxStep = 26 * temp`、`alpha *= 0.94`、fitView 的 40 padding、pointerdown
// 拖动固定。App 侧如果各写一份，这两份会立刻开始漂移（改了一边忘了另一边是这类
// 移植最常见的坏账），所以抽成一层：
//
//   - [GraphLayout]           —— 数据 + 物理 + 视图数字（纯计算，可单测）；
//   - [GraphCanvasController] —— 帧驱动、手势、命中测试的胶水；
//   - [GraphPainter]          —— 画布骨架（视图变换 + 标签），形状/连线各图自画；
//   - [GraphCanvasView]       —— LayoutBuilder + GestureDetector + CustomPaint。
//
// 各页只负责：把 payload 变成 [GraphLayout]、提供自己的 painter、在
// [GraphCanvasController.onNodeTap] 里开自己的详情面板。

/// 缩放上下限 —— 滚轮 / 捏合是 `clamp(scale, 0.2, 4)`
/// （`task-graph.js:380` / `memory-graph.js:374`），而首次装载 / 双击的
/// `fitView()` 只放到 2.0（`task-graph.js:313` / `memory-graph.js:307`），
/// 两张图都不例外，所以这里拆成两组常量。App 的任务图谱之前自己夹到 2.0，
/// 抽共用件时统一回 Web 的口径：捏合上限决定了「缩放级标签」最高一档
/// （[GraphLayout.labelMinDegreeFor] 的 1.2）能不能稳定达到。
const double kGraphMinScale = 0.2;
const double kGraphMaxScale = 4;

/// `fitView()` 的放大上限，比捏合更保守（见上）。
const double kGraphFitMaxScale = 2;

/// 大图阈值：节点数超过它就从「Web 参数」退到「手机上跑得动」的参数（预热次数、
/// 每帧步数、alpha 衰减、帧数封顶都看它）。
const int kGraphBigNodeCount = 400;

/// 标签样式 —— Web 的标签是 10px 等宽、fill `#adbac7`，那是深色画布上的颜色；
/// App 的画布是浅色（[AppColors.panel]），所以用 [AppColors.muted]。这是有意偏离
/// Web 的唯一一处标签配色。
const TextStyle kGraphLabelStyle = TextStyle(
  fontSize: 10,
  fontFamily: 'monospace',
  color: AppColors.muted,
);

/// Web `truncate()`（`task-graph.js:55` / `memory-graph.js:58`）：超过 [max] 个字
/// 就留前 `max - 1` 个 + 一个省略号。
String graphTruncate(String value, int max) {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  return '${value.substring(0, max - 1)}…';
}

/// 布局里的一颗节点：接口数据 + 每帧变化的位置 + 预排好的标签。
class GraphNode {
  GraphNode({
    required this.id,
    required this.title,
    required this.radius,
    this.degree = 0,
    this.labelText,
    this.payload,
  });

  final String id;
  final String title;

  /// 半径：两张图都是 `6 + min(degree, 12) * 1.4`（任务壳在任务图谱里另有退化，
  /// 由页面自己算好传进来）。
  final double radius;

  /// 关联度：既是半径的来源，也是「缩放级标签」的开关
  /// （[GraphLayout.visibleLabel]）。
  final int degree;

  /// 画在节点下方的标题（页面按自己的规则给：任务壳用 title、任务用 title 兜底
  /// id、记忆用 title 兜底 slug）。给 null 就是不画标签。
  final String? labelText;

  /// 页面自己的原始节点对象（`TaskGraphNode` / `MemoryGraphNode`）。
  final Object? payload;

  double x = 0;
  double y = 0;
  double fx = 0;
  double fy = 0;

  /// 被手指拖过 —— 力导向不再挪它（Web 的 `pinned`，`task-graph.js:215`）。
  bool pinned = false;

  /// 预排好的标签；节点数过多时为 null（见 [GraphLayout.buildLabels]）。
  TextPainter? label;
}

/// 布局里的一条边（两端已经解析成节点对象）。
class GraphLink {
  const GraphLink({
    required this.source,
    required this.target,
    this.spring = 1,
    this.payload,
  });

  final GraphNode source;
  final GraphNode target;

  /// 弹簧强度项：系数 = `0.6 + min(spring, 4) * 0.1`（Web 两处 tick 同一公式
  /// —— 任务图谱把边类型映射成 2.4 / 1.4 / 1.0，记忆图谱直接用 `strength`）。
  final double spring;

  /// 页面自己的原始边对象。
  final Object? payload;

  double get springFactor => 0.6 + math.min(spring, 4) * 0.1;
}

/// 力导向布局 + 视图变换。所有数字每帧都在动，但**不是** widget 状态：只有
/// 「节点/边集合」变了才 setState，位置变化走 [GraphCanvasController.repaint]
/// 只重绘不重建。
class GraphLayout {
  GraphLayout({
    required this.nodes,
    required this.links,
    TextStyle labelStyle = kGraphLabelStyle,
    int labelMaxNodes = GraphLayout.defaultLabelMaxNodes,
  }) {
    for (final node in nodes) {
      byId[node.id] = node;
    }
    buildLabels(style: labelStyle, maxNodes: labelMaxNodes);
  }

  final List<GraphNode> nodes;
  final List<GraphLink> links;
  final Map<String, GraphNode> byId = <String, GraphNode>{};

  double scale = 1;
  double tx = 0;
  double ty = 0;

  /// 标签总数封顶：每个标签是一个 TextPainter（构建时 layout 一次，之后每帧只
  /// paint）。超过这个数就**一个标签都不建** —— 那个尺度上字是糊的，不如把这一帧
  /// 的时间留给力导向。Web 那边是上千个 SVG `<text>` 直接扔给浏览器。
  static const int defaultLabelMaxNodes = 1200;

  /// Web 的 warm-up 迭代数 `clamp(3600 / n, 8, 60)`（`task-graph.js:125`）。
  static const int warmUpMin = 8;
  static const int warmUpMax = 60;

  /// 大图退化的预热次数（见 [kGraphBigNodeCount]）。
  static const int bigGraphWarmUp = 6;

  // ── 物理（逐条对齐 Web 两处 tick）─────────────────────────────────────────

  /// 黄金角螺旋初值：不用随机数，所以同一个 payload 每次画出来都一样（截图对比、
  /// 测试命中坐标都靠这个）。
  void initPositions(Size size) {
    final count = nodes.length;
    if (count == 0) return;
    final cx = size.width / 2;
    final cy = size.height / 2;
    final spread = math.min(size.width, size.height) * 0.4;
    for (var i = 0; i < count; i++) {
      final node = nodes[i];
      final angle = i * 2.399963; // 黄金角
      final radius = spread * math.sqrt((i + 1) / count);
      node.x = cx + radius * math.cos(angle);
      node.y = cy + radius * math.sin(angle);
      node.fx = 0;
      node.fy = 0;
    }
  }

  /// Web 在拿到数据后先同步跑一批「热身」迭代再显示（`task-graph.js:125-126`），
  /// 这样第一帧就不是一团毛线。
  void warmUp(Size size) {
    final count = nodes.length;
    if (count == 0) return;
    final iterations = count <= kGraphBigNodeCount
        ? math.max(warmUpMin, math.min(warmUpMax, (3600 / count).round()))
        : bigGraphWarmUp;
    for (var i = 0; i < iterations; i++) {
      tick(size, 0.9);
    }
  }

  /// Fruchterman-Reingold 的一步（逐条对齐 Web `tick()`）。
  void tick(Size size, double temp) {
    final count = nodes.length;
    if (count == 0) return;
    final area = size.width * size.height;
    final k = 1.1 * math.sqrt(area / count);
    final k2 = k * k;
    final cx = size.width / 2;
    final cy = size.height / 2;

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
    for (final link in links) {
      final a = link.source;
      final b = link.target;
      final dx = b.x - a.x;
      final dy = b.y - a.y;
      final d = math.sqrt(dx * dx + dy * dy);
      if (d < 0.01) continue;
      final force = (d * d) / k * link.springFactor;
      final ux = dx / d;
      final uy = dy / d;
      a.fx += ux * force;
      a.fy += uy * force;
      b.fx -= ux * force;
      b.fy -= uy * force;
    }

    // 向心引力（防止离散分量飘走）+ 位移冷却。
    final maxStep = 26 * temp;
    for (final node in nodes) {
      node.fx += (cx - node.x) * 0.009;
      node.fy += (cy - node.y) * 0.009;
      // 被手指固定的节点照样算受力（邻居会绕着它让位），只是自己不动
      // （Web `if (a.pinned) continue;`）。
      if (node.pinned) continue;
      final length = math.sqrt(node.fx * node.fx + node.fy * node.fy);
      if (length < 0.0001) continue;
      final step = math.min(length, maxStep);
      node.x += (node.fx / length) * step;
      node.y += (node.fy / length) * step;
    }
  }

  // ── 缩放级标签 ───────────────────────────────────────────────────────────

  /// 缩到多小就只给「够枢纽」的节点画标题。放大到位时（≥1.2）连孤立节点也标，
  /// 默认档（0.8~1.2）只标有关联的，缩得越小留下来的越少 —— 和地图按层级抽稀
  /// 标记是同一个思路。
  static int labelMinDegreeFor(double scale) {
    if (scale >= 1.2) return 0;
    if (scale >= 0.8) return 1;
    if (scale >= 0.5) return 3;
    if (scale >= 0.3) return 5;
    return 8;
  }

  /// 预排标签（构建时一次）。[maxNodes] 之外整体放弃，见
  /// [defaultLabelMaxNodes]。
  void buildLabels({
    TextStyle style = kGraphLabelStyle,
    int maxNodes = defaultLabelMaxNodes,
  }) {
    if (nodes.length > maxNodes) return;
    for (final node in nodes) {
      final raw = node.labelText;
      if (raw == null || raw.isEmpty) continue;
      node.label = TextPainter(
        text: TextSpan(text: graphTruncate(raw, 18), style: style),
        textDirection: TextDirection.ltr,
        maxLines: 1,
      )..layout();
    }
  }

  /// 这一帧该不该画这个标签（缩放级抽稀）。painter 每帧调它。
  TextPainter? visibleLabel(GraphNode node) {
    final label = node.label;
    if (label == null) return null;
    if (node.degree < labelMinDegreeFor(scale)) return null;
    return label;
  }

  // ── 视图：适配 / 聚焦 / 缩放 / 坐标 ──────────────────────────────────────

  /// 双击 / 首次加载用的适配：包围盒（含半径）加 40 padding 居中，缩放夹
  /// `0.2..2`（比捏合窄，见 [kGraphFitMaxScale]）。逐条对齐 Web `fitView()`
  /// （`task-graph.js:304-317`）。
  void fitView(
    Size size, {
    double padding = 40,
    double minScale = kGraphMinScale,
    double maxScale = kGraphFitMaxScale,
  }) {
    if (nodes.isEmpty || size.width < 1 || size.height < 1) return;
    var minX = double.infinity;
    var minY = double.infinity;
    var maxX = -double.infinity;
    var maxY = -double.infinity;
    for (final node in nodes) {
      minX = math.min(minX, node.x - node.radius);
      minY = math.min(minY, node.y - node.radius);
      maxX = math.max(maxX, node.x + node.radius);
      maxY = math.max(maxY, node.y + node.radius);
    }
    final bw = math.max(maxX - minX, 1.0);
    final bh = math.max(maxY - minY, 1.0);
    final next = math
        .min((size.width - padding) / bw, (size.height - padding) / bh)
        .clamp(minScale, maxScale);
    scale = next;
    tx = (size.width - (minX + maxX) * next) / 2;
    ty = (size.height - (minY + maxY) * next) / 2;
  }

  /// 把某个节点挪到视口正中（Web `focusNode()`，`task-graph.js:504`）—— 点邻居
  /// 之后用的。保持当前缩放。
  void focusNode(GraphNode node, Size size) {
    tx = size.width / 2 - node.x * scale;
    ty = size.height / 2 - node.y * scale;
  }

  /// 以某个画布坐标为锚点缩放（Web `zoomAt()`，滚轮 / 捏合同一套算法）。
  void zoomAt(
    Offset anchor,
    double factor, {
    double minScale = kGraphMinScale,
    double maxScale = kGraphMaxScale,
  }) {
    final next = (scale * factor).clamp(minScale, maxScale);
    final lx = (anchor.dx - tx) / scale;
    final ly = (anchor.dy - ty) / scale;
    scale = next;
    tx = anchor.dx - lx * next;
    ty = anchor.dy - ly * next;
  }

  /// 画布坐标 → 布局坐标（Web `toLayout()`）。
  Offset toLayout(Offset local) =>
      Offset((local.dx - tx) / scale, (local.dy - ty) / scale);

  /// 布局坐标 → 画布坐标（测试算点击坐标用）。
  Offset toCanvas(Offset layoutPoint) => Offset(
    layoutPoint.dx * scale + tx,
    layoutPoint.dy * scale + ty,
  );

  /// 命中测试：返回半径 + [slack] 内最近的节点。
  ///
  /// 公开是为了让测试用同一个判定拿坐标去 `tapAt` —— 力导向的结果没法在测试里
  /// 重算，硬编码坐标只会变成一颗定时炸弹。
  GraphNode? hitTest(Offset local, {double slack = 6}) {
    final point = toLayout(local);
    GraphNode? best;
    var bestDistance = double.infinity;
    for (final node in nodes) {
      final dx = node.x - point.dx;
      final dy = node.y - point.dy;
      final distance = math.sqrt(dx * dx + dy * dy);
      if (distance > node.radius + slack / scale) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = node;
      }
    }
    return best;
  }

  /// 清掉所有固定（Web `memGraphResetView()` 的第一句）。
  void unpinAll() {
    for (final node in nodes) {
      node.pinned = false;
    }
  }
}

/// CustomPainter 的 repaint 通道。位置每帧都在动，走这里只重绘、不重建整棵树
/// —— 每帧 setState 会让整页（含下拉、图例）跟着 rebuild。
class _GraphRepaint extends ChangeNotifier {
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

/// 画布的驱动与交互：帧循环、手势（平移 / 捏合 / 拖动固定 / 点击）、命中。
///
/// 界面只把它握在 State 里；测试可以绕过手势直接调 [fitView] / [focusNode] /
/// [hitTestNodeId]。
class GraphCanvasController extends ChangeNotifier {
  GraphCanvasController({required TickerProvider vsync, this.onNodeTap})
    : _vsync = vsync;

  /// 点节点 —— 各页拿去开自己的详情面板（Web 的 `tgNodeModalOpen` /
  /// `memNodeModalOpen`）。
  final ValueChanged<GraphNode>? onNodeTap;

  final TickerProvider _vsync;

  /// 用不重复的 AnimationController 每帧回调一次：Web 是
  /// `requestAnimationFrame` + `alpha *= 0.94`，收敛条件一致，而且到点就
  /// `stop()`（ticker 不留着空转）。
  late final AnimationController _anim = AnimationController(
    vsync: _vsync,
    duration: const Duration(seconds: 1),
  )..addListener(_step);

  final _GraphRepaint _repaint = _GraphRepaint();

  /// 只重绘不重建的通道，交给页面的 CustomPainter。
  Listenable get repaint => _repaint;

  GraphLayout? _layout;
  GraphLayout? get layout => _layout;

  Size _size = Size.zero;
  Size get size => _size;

  /// 数据到了但画布尺寸还没到手 —— 等下一帧 LayoutBuilder 里再热身。
  bool _pendingPrepare = false;
  bool _disposed = false;

  double _alpha = 0;
  double _decay = 0.94;
  int _ticksPerFrame = 2;
  int _frames = 0;
  int _maxFrames = 200;

  bool get isAnimating => _anim.isAnimating;
  double get alpha => _alpha;

  // 手势状态：捏合的起始缩放、正在拖的节点、拖动位移、是否吞掉这次点击。
  double _gestureStartScale = 1;
  GraphNode? _dragNode;
  Offset? _dragStart;
  bool _dragMoved = false;
  bool _suppressTap = false;

  /// 拖动判定阈值：位移超过它就算「拖」而不是「点」（Web 的 3px，
  /// `task-graph.js:339`）。
  static const double dragSlop = 3;

  /// 换图：null = 空图。尺寸未知时推迟到 [setSize]。
  void setLayout(GraphLayout? next) {
    _layout = next;
    stopSim();
    _pendingPrepare = false;
    if (next == null || next.nodes.isEmpty) {
      _repaint.ping();
      return;
    }
    if (_size.width < 1 || _size.height < 1) {
      _pendingPrepare = true;
      _repaint.ping();
      return;
    }
    prepare();
  }

  /// 画布尺寸（LayoutBuilder 给的）。力导向的 `k` 与 fitView 都要它；尺寸变了
  /// （转屏、分屏）就地重热一次。
  void setSize(Size size) {
    // 尺寸不是一个有限的、够大的矩形时不记：力导向的 `k = 1.1*sqrt(W*H/n)` 和
    // fitView 都会被 0/∞ 带着算出 NaN，那之后整张图就再也画不出来了。
    if (!size.isFinite || size.width < 1 || size.height < 1) return;
    final resized =
        (size.width - _size.width).abs() > 0.5 ||
        (size.height - _size.height).abs() > 0.5;
    _size = size;
    final graph = _layout;
    if (graph == null) return;
    if (_pendingPrepare) {
      prepare();
      return;
    }
    if (resized) {
      graph.warmUp(_size);
      graph.fitView(_size);
      _repaint.ping();
    }
  }

  /// 初值 + 热身 + 适配 + 起动画。
  void prepare({double alpha = 0.6}) {
    final graph = _layout;
    if (graph == null || graph.nodes.isEmpty) return;
    _pendingPrepare = false;
    graph.initPositions(_size);
    graph.warmUp(_size);
    graph.fitView(_size);
    startSim(alpha: alpha);
    _repaint.ping();
  }

  /// 重置视图：清掉所有固定 + 重排（Web `memGraphResetView()`）。
  void resetView() {
    final graph = _layout;
    if (graph == null) return;
    graph.unpinAll();
    prepare(alpha: 0.5);
  }

  /// 起动画。已经在跑时只把能量抬起来、不重复调度（Web `startSim()` 的
  /// `if (rafId) return;` 在 `alpha = a0` 之后）。
  void startSim({double alpha = 0.6}) {
    final graph = _layout;
    if (graph == null || graph.nodes.isEmpty) return;
    final count = graph.nodes.length;
    // 退化：>400 节点时每帧只推 1 步、alpha 衰减加快到 0.85（约 18 帧收敛）、
    // 帧数封顶 24。总配对量因此从「上万帧 × 50 万」降到百万量级，画面依旧会自己
    // 长出来，但不会 ANR。
    if (count <= kGraphBigNodeCount) {
      _ticksPerFrame = 2;
      _decay = 0.94;
      _maxFrames = 200;
    } else {
      _ticksPerFrame = 1;
      _decay = 0.85;
      _maxFrames = 24;
    }
    _frames = 0;
    _alpha = alpha;
    if (_anim.isAnimating) {
      _repaint.ping();
      return;
    }
    // 可能是在 build 里被调到的（LayoutBuilder 补尺寸那一次），起动画推迟到本帧
    // 结束，别在 build 期间动调度器。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_disposed || _layout == null || _anim.isAnimating) return;
      _anim.repeat();
    });
  }

  void _step() {
    final graph = _layout;
    if (graph == null) {
      _anim.stop();
      return;
    }
    for (var i = 0; i < _ticksPerFrame; i++) {
      graph.tick(_size, _alpha);
    }
    _alpha *= _decay;
    _frames++;
    _repaint.ping();
    // Web 的收敛条件：alpha < 0.03 收工（`task-graph.js:229-230`）。大图另有帧数
    // 封顶，见 startSim。
    if (_alpha < 0.03 || _frames >= _maxFrames) {
      _anim.stop();
      _alpha = 0;
    }
  }

  void stopSim() {
    if (_anim.isAnimating) _anim.stop();
    _alpha = 0;
    _frames = 0;
  }

  // ── 视图（对外，供页面按钮与测试用）──────────────────────────────────────

  void fitView() {
    final graph = _layout;
    if (graph == null) return;
    graph.fitView(_size);
    _repaint.ping();
  }

  void focusNode(String id) {
    final graph = _layout;
    final node = graph?.byId[id];
    if (graph == null || node == null) return;
    graph.focusNode(node, _size);
    _repaint.ping();
  }

  /// 以画布中心为锚点缩放（Web `memGraphZoom()` / `tgGraphZoom()`）。
  void zoomBy(double factor) {
    final graph = _layout;
    if (graph == null) return;
    graph.zoomAt(Offset(_size.width / 2, _size.height / 2), factor);
    _repaint.ping();
  }

  String? hitTestNodeId(Offset local, {double slack = 6}) =>
      _layout?.hitTest(local, slack: slack)?.id;

  /// 节点中心在画布坐标系里的位置（画布外/不存在返回 null）。
  Offset? nodeCenterInCanvas(String id) {
    final graph = _layout;
    final node = graph?.byId[id];
    if (graph == null || node == null) return null;
    return graph.toCanvas(Offset(node.x, node.y));
  }

  // ── 手势 ─────────────────────────────────────────────────────────────────

  void onScaleStart(ScaleStartDetails details) {
    _suppressTap = false;
    final graph = _layout;
    _gestureStartScale = graph?.scale ?? 1;
    if (graph == null || details.pointerCount > 1) {
      _dragNode = null;
      return;
    }
    // 按在节点上就是拖这个节点（Web 只在节点的 `<g>` 上挂 pointerdown），按在
    // 空白处才是平移画布。
    final node = graph.hitTest(details.localFocalPoint, slack: 8);
    _dragNode = node;
    _dragStart = details.localFocalPoint;
    _dragMoved = false;
  }

  void onScaleUpdate(ScaleUpdateDetails details) {
    final graph = _layout;
    if (graph == null) return;
    final drag = _dragNode;
    if (drag != null && details.pointerCount <= 1) {
      final start = _dragStart;
      if (start != null &&
          (details.localFocalPoint - start).dx.abs() +
                  (details.localFocalPoint - start).dy.abs() >
              dragSlop) {
        _dragMoved = true;
      }
      final point = graph.toLayout(details.localFocalPoint);
      drag.x = point.dx;
      drag.y = point.dy;
      drag.pinned = true;
      // 拖动时轻轻抖一下，邻居跟着让位（Web `startSim(0.25)`）。
      startSim(alpha: 0.25);
      _repaint.ping();
      return;
    }
    if (details.pointerCount >= 2) {
      // 双指捏合：以焦点为锚点缩放。
      final next = (_gestureStartScale * details.scale).clamp(
        kGraphMinScale,
        kGraphMaxScale,
      );
      final lx = (details.localFocalPoint.dx - graph.tx) / graph.scale;
      final ly = (details.localFocalPoint.dy - graph.ty) / graph.scale;
      graph.scale = next;
      graph.tx = details.localFocalPoint.dx - lx * next;
      graph.ty = details.localFocalPoint.dy - ly * next;
    } else {
      // 单指拖拽（不在节点上）= 平移。
      graph.tx += details.focalPointDelta.dx;
      graph.ty += details.focalPointDelta.dy;
    }
    _repaint.ping();
  }

  void onScaleEnd(ScaleEndDetails details) {
    // 拖过就不是点击（Web 用位移 ≤3px 区分点击与拖动）。Flutter 的 tap 判定是
    // 触摸阈值（18px），比 3px 松，所以这里补一道：真拖过就吞掉紧随其后的
    // onTapUp，别在拖动结束后弹出详情面板。
    if (_dragMoved) _suppressTap = true;
    _dragNode = null;
    _dragStart = null;
    _dragMoved = false;
  }

  void onTapUp(TapUpDetails details) {
    if (_suppressTap) {
      _suppressTap = false;
      return;
    }
    final graph = _layout;
    if (graph == null) return;
    final node = graph.hitTest(details.localPosition);
    if (node != null) onNodeTap?.call(node);
  }

  @override
  void dispose() {
    _disposed = true;
    _anim.dispose();
    _repaint.dispose();
    super.dispose();
  }
}

/// 画布骨架：视图变换 + 每颗节点的标签；连线与节点形状由各图自己画。
abstract class GraphPainter extends CustomPainter {
  GraphPainter({required this.layout, required Listenable repaint})
    : super(repaint: repaint);

  final GraphLayout layout;

  @override
  void paint(Canvas canvas, Size size) {
    if (layout.nodes.isEmpty) return;
    canvas.save();
    canvas.translate(layout.tx, layout.ty);
    canvas.scale(layout.scale);
    paintLinks(canvas);
    for (final node in layout.nodes) {
      paintNode(canvas, node);
      paintNodeLabel(canvas, node);
    }
    canvas.restore();
  }

  void paintLinks(Canvas canvas);

  void paintNode(Canvas canvas, GraphNode node);

  /// 标签在节点下方居中（近似 SVG 的 `text-anchor=middle` + `dy=r+11`：纵向让文字
  /// 底部落在「半径 + 11」那条线上，基线就在那附近）。缩放级抽稀在
  /// [GraphLayout.visibleLabel] 里。
  void paintNodeLabel(Canvas canvas, GraphNode node) {
    final label = layout.visibleLabel(node);
    if (label == null) return;
    label.paint(
      canvas,
      Offset(node.x - label.width / 2, node.y + node.radius + 11 - label.height),
    );
  }

  /// 箭头统一灰色 —— Web 只有一支配色写死的 marker，所有边共用。
  static const Color arrowColor = Color(0xFF6E7681);

  /// 箭头：三角，[direction] 是边的单位方向。
  static void arrowHead(Canvas canvas, Offset tip, Offset direction) {
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
        ..color = arrowColor,
    );
  }

  /// 虚线：dart:ui 还没有公开的 `PathEffect`，照 Web 的 `stroke-dasharray` 自己
  /// 切段。段长按布局单位算 —— 画布已经 scale 过，和 SVG transform 下的表现一致。
  static void dashedLine(
    Canvas canvas,
    Offset from,
    Offset to,
    Paint paint,
    List<double> pattern,
  ) {
    final total = (to - from).distance;
    if (total <= 0.01 || pattern.isEmpty) return;
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

  @override
  bool shouldRepaint(covariant GraphPainter oldDelegate) =>
      oldDelegate.layout != layout;
}

/// 画布 widget：LayoutBuilder（把尺寸告诉控制器）+ GestureDetector（把指针交给
/// 控制器）+ CustomPaint（各图的 painter）。
class GraphCanvasView extends StatelessWidget {
  const GraphCanvasView({
    super.key,
    required this.controller,
    required this.painterBuilder,
    this.canvasKey,
  });

  final GraphCanvasController controller;

  /// 由页面提供：拿布局和重绘通道造自己的 painter。
  final CustomPainter Function(GraphLayout layout, Listenable repaint)
  painterBuilder;

  /// 挂在手势层上 —— 测试靠它把画布内坐标换成屏幕坐标。
  final Key? canvasKey;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        controller.setSize(constraints.biggest);
        final layout = controller.layout;
        if (layout == null) return const SizedBox.expand();
        return GestureDetector(
          key: canvasKey,
          behavior: HitTestBehavior.opaque,
          onScaleStart: controller.onScaleStart,
          onScaleUpdate: controller.onScaleUpdate,
          onScaleEnd: controller.onScaleEnd,
          onTapUp: controller.onTapUp,
          onDoubleTap: controller.fitView,
          child: SizedBox.expand(
            child: CustomPaint(
              painter: painterBuilder(layout, controller.repaint),
            ),
          ),
        );
      },
    );
  }
}
