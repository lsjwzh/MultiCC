// 为什么这么测：
//
// 共用画布（任务图谱 + 记忆图谱）里真正容易错的是三件事，都不是「好不好看」：
//   1. **缩放级标签**：缩到多小还剩哪些标签、放大到哪一档孤立节点也标出来
//      —— 阈值写错就是「一团字糊在一起」或者「放大了一颗字都没有」；
//   2. **拖动固定**：拖动必须真的把节点钉住（力导向不再挪它），而「没拖动的
//      那一下」必须仍然是点击开详情（Web 用 3px 位移区分这两件事）；
//   3. **视图数字**：fitView / focusNode / zoomAt 的夹取范围与坐标换算
//      —— 测试要拿它们算点击坐标，错了就是一片 flaky。
// 这些都是纯计算 + 手势回调，不需要真服务、不需要真布局。
import 'dart:math' as math;

import 'package:flutter/gestures.dart' show PointerDeviceKind;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/widgets/graph/graph_canvas.dart';

GraphNode makeNode(String id, {int degree = 0}) => GraphNode(
  id: id,
  title: id,
  radius: 6 + math.min(degree, 12) * 1.4,
  degree: degree,
  labelText: id,
);

/// 一条 0→1 的边 + 三个孤立节点，够覆盖「有关联 / 孤立」两档标签策略。
GraphLayout makeLayout({int labelMaxNodes = 1200}) => GraphLayout(
  nodes: [
    makeNode('hub', degree: 8),
    makeNode('linked', degree: 1),
    makeNode('few', degree: 3),
    makeNode('more', degree: 5),
    makeNode('lonely', degree: 0),
  ],
  links: [],
  labelMaxNodes: labelMaxNodes,
);

GraphCanvasController makeController({ValueChanged<GraphNode>? onNodeTap}) =>
    GraphCanvasController(vsync: const TestVSync(), onNodeTap: onNodeTap);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('缩放级标签', () {
    test('阈值分档：放大到位才连孤立节点也标', () {
      expect(GraphLayout.labelMinDegreeFor(1.5), 0);
      expect(GraphLayout.labelMinDegreeFor(1.2), 0);
      expect(GraphLayout.labelMinDegreeFor(1.0), 1);
      expect(GraphLayout.labelMinDegreeFor(0.8), 1);
      expect(GraphLayout.labelMinDegreeFor(0.6), 3);
      expect(GraphLayout.labelMinDegreeFor(0.5), 3);
      expect(GraphLayout.labelMinDegreeFor(0.35), 5);
      expect(GraphLayout.labelMinDegreeFor(0.2), 8);
    });

    test('visibleLabel 跟着 scale 抽稀', () {
      final layout = makeLayout();
      TextPainter? labelOf(String id) => layout.visibleLabel(layout.byId[id]!);

      // 默认档（fitView 的常见结果）：有关联的都标，孤立节点不标。
      layout.scale = 1;
      expect(labelOf('linked'), isNotNull);
      expect(labelOf('hub'), isNotNull);
      expect(labelOf('lonely'), isNull);

      // 缩到最小：只留枢纽。
      layout.scale = 0.2;
      expect(labelOf('hub'), isNotNull);
      expect(labelOf('more'), isNull); // degree 5 < 8
      expect(labelOf('few'), isNull);

      // 放大到位：孤立节点也标出来。
      layout.scale = 1.4;
      expect(labelOf('lonely'), isNotNull);
    });

    test('节点过多时一个标签都不建（性能封顶）', () {
      final layout = makeLayout(labelMaxNodes: 2);
      expect(layout.nodes.every((node) => node.label == null), isTrue);
      layout.scale = 2;
      expect(layout.visibleLabel(layout.byId['hub']!), isNull);
    });

    test('标签文本截断在 18 字（Web truncate 同一口径）', () {
      expect(graphTruncate('123456789012345678', 18), '123456789012345678');
      expect(graphTruncate('1234567890123456789', 18), '12345678901234567…');
    });
  });

  group('拖动固定', () {
    test('拖动节点 → pinned，位置跟手；再 tick 也不动', () {
      final layout = makeLayout();
      final controller = makeController();
      addTearDown(controller.dispose);
      controller.setSize(const Size(400, 300));
      controller.setLayout(layout);
      controller.fitView();

      final target = controller.nodeCenterInCanvas('hub')!;
      controller.onScaleStart(
        ScaleStartDetails(localFocalPoint: target, pointerCount: 1),
      );
      controller.onScaleUpdate(
        ScaleUpdateDetails(
          localFocalPoint: target + const Offset(40, -20),
          focalPointDelta: const Offset(40, -20),
          pointerCount: 1,
        ),
      );
      controller.onScaleEnd(ScaleEndDetails());

      final hub = layout.byId['hub']!;
      expect(hub.pinned, isTrue);
      final expected = layout.toLayout(target + const Offset(40, -20));
      expect(hub.x, closeTo(expected.dx, 0.001));
      expect(hub.y, closeTo(expected.dy, 0.001));

      // 钉住 = 力导向不再挪它（其余节点照常被推）。
      final before = Offset(hub.x, hub.y);
      final otherBefore = Offset(layout.byId['lonely']!.x, layout.byId['lonely']!.y);
      for (var i = 0; i < 5; i++) {
        layout.tick(const Size(400, 300), 0.9);
      }
      expect(hub.x, closeTo(before.dx, 0.0001));
      expect(hub.y, closeTo(before.dy, 0.0001));
      expect(
        Offset(layout.byId['lonely']!.x, layout.byId['lonely']!.y),
        isNot(equals(otherBefore)),
      );
    });

    test('拖过的这一下不再当成点击；没拖动的点击照旧开详情', () {
      final tapped = <String>[];
      final layout = makeLayout();
      final controller = makeController(onNodeTap: (node) => tapped.add(node.id));
      addTearDown(controller.dispose);
      controller.setSize(const Size(400, 300));
      controller.setLayout(layout);
      controller.fitView();

      final target = controller.nodeCenterInCanvas('hub')!;
      // 拖动（位移超过 3px）：结束时吞掉紧随其后的 tap。
      controller.onScaleStart(
        ScaleStartDetails(localFocalPoint: target, pointerCount: 1),
      );
      controller.onScaleUpdate(
        ScaleUpdateDetails(
          localFocalPoint: target + const Offset(30, 30),
          focalPointDelta: const Offset(30, 30),
          pointerCount: 1,
        ),
      );
      controller.onScaleEnd(ScaleEndDetails());
      // 拖动结束时 Flutter 可能还会补一次 onTapUp（tap 的触摸阈值 18px 比拖动
      // 阈值 3px 松）—— 那一下必须被吞掉，否则「拖完就弹详情」。
      final hubAfterDrag = controller.nodeCenterInCanvas('hub')!;
      controller.onTapUp(
        TapUpDetails(
          kind: PointerDeviceKind.touch,
          localPosition: hubAfterDrag,
        ),
      );
      expect(tapped, isEmpty);

      // 平移（按在空白处）：不固定任何节点，也不吞点击。
      final before = layout.tx;
      // 空白点要真的空白 —— 力导向之后随便挑一个坐标很可能正压在别的节点上
      // （那走的就是「拖那个节点」而不是平移了）。用画布自己的命中判定扫一个。
      Offset? empty;
      for (var x = 2.0; x < 400 && empty == null; x += 7) {
        for (var y = 2.0; y < 300 && empty == null; y += 7) {
          final point = Offset(x, y);
          if (controller.hitTestNodeId(point) == null) empty = point;
        }
      }
      expect(empty, isNotNull);
      controller.onScaleStart(
        ScaleStartDetails(localFocalPoint: empty!, pointerCount: 1),
      );
      controller.onScaleUpdate(
        ScaleUpdateDetails(
          localFocalPoint: empty + const Offset(10, 0),
          focalPointDelta: const Offset(10, 0),
          pointerCount: 1,
        ),
      );
      controller.onScaleEnd(ScaleEndDetails());
      expect(layout.tx, closeTo(before + 10, 0.001));

      // 纯点击：开详情。
      final hubCenter = controller.nodeCenterInCanvas('hub')!;
      controller.onScaleStart(
        ScaleStartDetails(localFocalPoint: hubCenter, pointerCount: 1),
      );
      controller.onScaleEnd(ScaleEndDetails());
      controller.onTapUp(
        TapUpDetails(kind: PointerDeviceKind.touch, localPosition: hubCenter),
      );
      expect(tapped, ['hub']);
    });

    test('resetView 松开所有固定（Web memGraphResetView 的语义）', () {
      final layout = makeLayout();
      final controller = makeController();
      addTearDown(controller.dispose);
      controller.setSize(const Size(400, 300));
      controller.setLayout(layout);
      layout.byId['hub']!.pinned = true;

      controller.resetView();
      expect(layout.nodes.any((node) => node.pinned), isFalse);
    });
  });

  group('视图与命中', () {
    test('zoomAt 夹在 0.2..4（Web 两张图同一口径）', () {
      final layout = makeLayout();
      layout.scale = 1;
      layout.zoomAt(Offset.zero, 100);
      expect(layout.scale, kGraphMaxScale);
      layout.zoomAt(Offset.zero, 0.0001);
      expect(layout.scale, kGraphMinScale);
    });

    test('focusNode 把节点挪到视口正中；hitTest 认最近的节点', () {
      final layout = makeLayout();
      const size = Size(400, 300);
      layout.scale = 1;
      final hub = layout.byId['hub']!;
      hub.x = 500;
      hub.y = -300;
      layout.focusNode(hub, size);
      final center = layout.toCanvas(Offset(hub.x, hub.y));
      expect(center.dx, closeTo(size.width / 2, 0.001));
      expect(center.dy, closeTo(size.height / 2, 0.001));
      expect(layout.hitTest(center)?.id, 'hub');
      expect(layout.hitTest(const Offset(1, 1)), isNull);
    });

    test('fitView 把整张图装进画布（含半径 + 40 padding）', () {
      final layout = makeLayout();
      const size = Size(400, 300);
      layout.initPositions(size);
      layout.fitView(size);
      for (final node in layout.nodes) {
        final center = layout.toCanvas(Offset(node.x, node.y));
        expect(center.dx - node.radius * layout.scale, greaterThanOrEqualTo(0));
        expect(center.dy - node.radius * layout.scale, greaterThanOrEqualTo(0));
        expect(center.dx + node.radius * layout.scale, lessThanOrEqualTo(size.width));
        expect(center.dy + node.radius * layout.scale, lessThanOrEqualTo(size.height));
      }
    });

    test('弹簧系数：0.6 + min(strength,4)*0.1，两头都夹住', () {
      final a = makeNode('a');
      final b = makeNode('b');
      double factor(double spring) =>
          GraphLink(source: a, target: b, spring: spring).springFactor;
      expect(factor(1), closeTo(0.7, 0.0001));
      expect(factor(2.4), closeTo(0.84, 0.0001));
      expect(factor(10), closeTo(1.0, 0.0001)); // min(10,4) = 4
    });
  });
}
