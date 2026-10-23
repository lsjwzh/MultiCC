import 'dart:ui' show Offset, Size;

import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/remote_touch_controller.dart';

/// 显示 400×200，源画面 800×400（放大 2 倍）：显示坐标 ×2 = 源坐标。
class _Rig {
  _Rig({RemoteTouchMode mode = RemoteTouchMode.direct}) {
    c =
        RemoteTouchController(
            onPointer: (m, x, y) => events.add('$m@$x,$y'),
            onCursor: (s, p) => cursors.add(
              s == null ? 'hide' : '${s.dx.round()},${s.dy.round()}:$p',
            ),
            onHold: () => holds++,
            onRightUsed: () => rightUsed++,
            onFollow: (s) => follows.add(s),
            holdDelay: const Duration(milliseconds: 40),
            moveInterval: Duration.zero,
          )
          ..mode = mode
          ..display = const Size(400, 200)
          ..source = const Size(800, 400);
  }

  late final RemoteTouchController c;
  final events = <String>[];
  final cursors = <String>[];
  final follows = <Offset>[];
  int holds = 0;
  int rightUsed = 0;
  int _t = 0;

  Duration get now => Duration(milliseconds: _t);
  void advance(int ms) => _t += ms;

  void down(int id, double x, double y) {
    c.down(id, Offset(x, y), Offset(x, y), now);
  }

  void move(int id, double x, double y) {
    advance(16);
    c.move(id, Offset(x, y), Offset(x, y), now);
  }

  void up(int id, double x, double y) {
    advance(16);
    c.up(id, Offset(x, y), Offset(x, y), now);
  }
}

void main() {
  group('直接模式', () {
    test('按下立即有落点反馈，不等任何计时器；轻点 = 单击', () {
      final r = _Rig();
      r.down(1, 100, 50);
      // 还没抬手：光标已经跳过去（hover），本地落点已画出
      expect(r.events, ['0@200,100']);
      expect(r.cursors.first, '200,100:true');
      r.up(1, 100, 50);
      expect(r.events, ['0@200,100', '1@200,100', '0@200,100']);
    });

    test('死区内抖动不按下；推动才按下，并按在最初落点而不是越过死区的位置', () {
      final r = _Rig();
      r.down(1, 100, 50);
      r.events.clear();
      r.move(1, 103, 51); // < 6px
      expect(r.events, isEmpty);
      r.move(1, 130, 50);
      // 先在落点按下，再跟到当前位置
      expect(r.events, ['1@200,100', '1@260,100']);
      r.move(1, 160, 60);
      expect(r.events.last, '1@320,120');
      r.up(1, 160, 60);
      expect(r.events.last, '0@320,120');
    });

    test('长按不动没有右键：抬手就是普通单击；右键只走显式开关', () {
      final r = _Rig();
      r.down(1, 100, 50);
      r.advance(900); // 远超旧版 450ms 长按
      r.up(1, 100, 50);
      expect(r.events.where((e) => e.startsWith('4@')), isEmpty);
      expect(r.events.sublist(r.events.length - 2), ['1@200,100', '0@200,100']);

      r.events.clear();
      r.c.rightOnce = true;
      r.down(1, 100, 50);
      r.up(1, 100, 50);
      expect(r.events.sublist(r.events.length - 2), ['4@200,100', '0@200,100']);
      expect(r.rightUsed, 1);
      expect(r.c.rightOnce, isFalse);
    });

    test('拖动中第二指落下：立刻松开左键，不留幽灵按键', () {
      final r = _Rig();
      r.down(1, 100, 50);
      r.move(1, 140, 50);
      r.events.clear();
      r.down(2, 300, 100);
      expect(r.events, ['0@280,100']);
      r.up(2, 300, 100);
      r.up(1, 140, 50);
      expect(r.events, ['0@280,100']); // 之后什么都不再发
    });

    test('放大态：单指持续操作远端，不切换为本地平移', () {
      final r = _Rig()..c.viewScale = 3;
      r.down(1, 100, 50);
      r.move(1, 140, 50);
      expect(r.events, ['0@200,100', '1@200,100', '1@280,100']);
      r.up(1, 140, 50);
      expect(r.events.last, '0@280,100');
    });

    test('捏合后剩下的一指不恢复拖动或误发点击', () {
      final r = _Rig();
      r.down(1, 100, 50);
      r.down(2, 200, 50);
      r.events.clear();
      r.move(2, 240, 50);
      r.up(2, 240, 50);
      r.move(1, 160, 50);
      r.up(1, 160, 50);
      expect(r.events, isEmpty);
    });

    test('系统打断（cancel）时松开已按下的左键', () {
      final r = _Rig();
      r.down(1, 100, 50);
      r.move(1, 150, 50);
      r.events.clear();
      r.c.cancel(1);
      expect(r.events, ['0@300,100']);
    });
  });

  group('触控板模式', () {
    test('一指滑动带着光标走（相对位移），放大后手指位移按倍数变细', () {
      final r = _Rig(mode: RemoteTouchMode.trackpad);
      r.down(1, 10, 10);
      expect(r.c.cursor, const Offset(400, 200)); // 初始在画面中心
      r.move(1, 20, 10); // 10 显示像素 = 20 源像素（慢速基础增益 2）
      expect(r.c.cursor.dx, greaterThan(400));
      expect(r.events.every((e) => e.startsWith('0@')), isTrue); // 只移动光标，不按键
      final slow = r.c.cursor.dx - 400;

      final z = _Rig(mode: RemoteTouchMode.trackpad)..c.viewScale = 4;
      z.down(1, 10, 10);
      z.move(1, 20, 10);
      expect(z.c.cursor.dx - 400, closeTo(slow / 4, 0.51));
      expect(z.follows, isNotEmpty); // 放大态视角据此跟随
    });

    test('快速划动有加速度', () {
      final slow = _Rig(mode: RemoteTouchMode.trackpad);
      slow.down(1, 0, 0);
      slow.advance(200);
      slow.c.move(1, const Offset(40, 0), const Offset(40, 0), slow.now);
      final fast = _Rig(mode: RemoteTouchMode.trackpad);
      fast.down(1, 0, 0);
      fast.advance(10);
      fast.c.move(1, const Offset(40, 0), const Offset(40, 0), fast.now);
      expect(
        fast.c.cursor.dx - 400,
        greaterThan((slow.c.cursor.dx - 400) * 1.5),
      );
    });

    test('轻点 = 在光标处单击；右键开关同样适用', () {
      final r = _Rig(mode: RemoteTouchMode.trackpad);
      r.down(1, 10, 10);
      r.up(1, 10, 10);
      expect(r.events, ['1@400,200', '0@400,200']);
      r.events.clear();
      r.c.rightOnce = true;
      r.down(1, 10, 10);
      r.up(1, 10, 10);
      expect(r.events, ['4@400,200', '0@400,200']);
      expect(r.rightUsed, 1);
    });

    test('按住不动 → 进入拖拽（按下左键 + 触觉），再滑动是带键移动，抬手松开', () async {
      final r = _Rig(mode: RemoteTouchMode.trackpad);
      r.down(1, 10, 10);
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(r.holds, 1);
      expect(r.events, ['1@400,200']);
      r.move(1, 30, 10);
      expect(r.events.last.startsWith('1@'), isTrue);
      r.up(1, 30, 10);
      expect(r.events.last.startsWith('0@'), isTrue);
      expect(r.events.where((e) => e.startsWith('4@')), isEmpty);
    });

    test('先滑动再停住不会触发拖拽（长按只对「没动过」的触摸生效）', () async {
      final r = _Rig(mode: RemoteTouchMode.trackpad);
      r.down(1, 10, 10);
      r.move(1, 40, 10);
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(r.holds, 0);
      expect(r.events.every((e) => e.startsWith('0@')), isTrue);
    });

    test('双指平行滑动 = 滚轮脉冲（方向：手指向下 = 滚轮上）；不当成点击', () {
      final r = _Rig(mode: RemoteTouchMode.trackpad);
      r.down(1, 100, 50);
      r.down(2, 140, 50);
      r.events.clear();
      for (var y = 60; y <= 140; y += 10) {
        r.move(1, 100, y.toDouble());
        r.move(2, 140, y.toDouble());
      }
      expect(r.c.scrolling, isTrue);
      expect(r.events.where((e) => e.startsWith('8@')), isNotEmpty);
      expect(r.events.where((e) => e.startsWith('16@')), isEmpty);
      // 每个脉冲后面都跟着松开，下一格才算新的沿
      for (var i = 0; i < r.events.length; i += 2) {
        expect(r.events[i + 1].startsWith('0@'), isTrue);
      }
      r.up(1, 100, 140);
      r.up(2, 140, 140);
      expect(r.events.where((e) => e.startsWith('4@')), isEmpty);
      expect(r.c.scrolling, isFalse);
    });

    test('双指向上滑 = 滚轮下', () {
      final r = _Rig(mode: RemoteTouchMode.trackpad);
      r.down(1, 100, 150);
      r.down(2, 140, 150);
      r.events.clear();
      for (var y = 140; y >= 60; y -= 10) {
        r.move(1, 100, y.toDouble());
        r.move(2, 140, y.toDouble());
      }
      expect(r.events.where((e) => e.startsWith('16@')), isNotEmpty);
    });

    test('双指捏合不滚动（交给缩放）', () {
      final r = _Rig(mode: RemoteTouchMode.trackpad);
      r.down(1, 100, 100);
      r.down(2, 140, 100);
      r.events.clear();
      for (var d = 1; d <= 6; d++) {
        r.move(1, 100 - d * 8.0, 100);
        r.move(2, 140 + d * 8.0, 100);
      }
      expect(r.c.scrolling, isFalse);
      expect(r.events, isEmpty);
    });

    test('双指轻点 = 右键', () {
      final r = _Rig(mode: RemoteTouchMode.trackpad);
      r.down(1, 100, 50);
      r.down(2, 140, 50);
      r.up(1, 100, 50);
      r.up(2, 140, 50);
      expect(r.events, ['4@400,200', '0@400,200']);
    });

    test('拖拽中第二指落下：松开左键', () async {
      final r = _Rig(mode: RemoteTouchMode.trackpad);
      r.down(1, 10, 10);
      await Future<void>.delayed(const Duration(milliseconds: 80));
      r.events.clear();
      r.down(2, 60, 10);
      expect(r.events, ['0@400,200']);
    });

    test('reset 会松开按住的键并清掉状态', () async {
      final r = _Rig(mode: RemoteTouchMode.trackpad);
      r.down(1, 10, 10);
      await Future<void>.delayed(const Duration(milliseconds: 80));
      r.events.clear();
      r.c.reset();
      expect(r.events, ['0@400,200']);
      r.up(1, 10, 10); // 迟到的 up 不再产生任何事件
      expect(r.events, ['0@400,200']);
    });
  });
}
