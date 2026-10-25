// 码率自适应控制器的单测：过载下调、恢复上调、应用受限不升、发送节流、
// 10 秒重发、上下限夹紧。控制器是纯逻辑 + 注入时钟，全部用整数毫秒驱动。
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/remote_rate_controller.dart';

/// 一帧在 [atMs] 到达、排队了 [queueMs]：pts = 到达时刻 − 排队。
void _frame(RemoteRateController c, int atMs, int queueMs, int bytes) {
  c.onFrame(atMs, (atMs - queueMs) * 1000, bytes);
}

void main() {
  test('排队超过 200ms 就下调：0.85×target 且不超过实收的 0.9', () {
    var now = 0;
    final c = RemoteRateController(clock: () => now);
    // 5 秒前的基线：准时到达，作为「时钟偏移 + 空链路」的零点。
    for (var i = 0; i < 5; i++) {
      _frame(c, i * 100 - 5000, 0, 1000);
    }
    // 最近 1 秒：每 100ms 一帧 50KB（≈4.4 Mbps），每帧都排队 400ms。
    for (var i = 0; i <= 10; i++) {
      _frame(c, i * 100, 400, 50000);
    }
    now = 1000;
    expect(c.tick(1000), 1700);
    expect(c.targetKbps, 1700);

    // 两次下调至少隔 1 秒：过载还在，但这一秒只算过一刀。
    now = 1500;
    expect(c.tick(1500), isNull);
    expect(c.targetKbps, 1700);

    c.dispose();
  });

  test('RTT 比窗口最小值高 400ms 也算过载', () {
    var now = 1;
    final c = RemoteRateController(clock: () => now);
    c.onPong(80, 2000);
    now = 999;
    c.onPong(600, 2000);
    // 帧本身没有排队，过载信号只来自 RTT。
    for (var i = 0; i <= 10; i++) {
      _frame(c, i * 100, 0, 50000);
    }
    now = 1000;
    expect(c.tick(1000), 1700);
    c.dispose();
  });

  test('排队 <80ms 连续 3 秒、实收接近 target 才升 10%', () {
    var now = 0;
    final c = RemoteRateController(clock: () => now);
    // 1600 kbps 实收（target 2000 的 80%），全程不排队。
    for (var i = 0; i <= 30; i++) {
      _frame(c, i * 100, 0, 20000);
    }
    expect(c.tick(0), 2000);
    now = 2000;
    expect(c.tick(2000), isNull, reason: '清爽状态还不满 3 秒');
    now = 3000;
    expect(c.tick(3000), 2200);
    c.dispose();
  });

  test('画面静止（实收远低于 target）算应用受限，不升', () {
    var now = 0;
    final c = RemoteRateController(clock: () => now);
    // 只有 88 kbps：远低于 target 的一半，链路有富余也说明不了什么。
    for (var i = 0; i <= 90; i++) {
      _frame(c, i * 100, 0, 1000);
    }
    expect(c.tick(0), 2000);
    now = 3000;
    expect(c.tick(3000), isNull);
    now = 9000;
    expect(c.tick(9000), isNull);
    expect(c.targetKbps, 2000);
    c.dispose();
  });

  test('发送节流：变化 ≥5% 且距上次 ≥500ms，否则不发', () {
    var now = 0;
    final c = RemoteRateController(clock: () => now);
    expect(c.tick(0), 2000);
    _frame(c, 0, 0, 50000); // 基线
    for (var i = 1; i <= 10; i++) {
      _frame(c, i * 100, 400, 50000);
    }
    now = 100;
    expect(c.tick(100), isNull, reason: '目标已变，但距上次只过了 100ms');
    expect(c.targetKbps, 1700);
    now = 500;
    expect(c.tick(500), 1700);
    c.dispose();
  });

  test('每 10 秒重发当前码率：Agent 重启也能自己恢复', () {
    var now = 0;
    final c = RemoteRateController(clock: () => now);
    expect(c.tick(0), 2000);
    now = 9999;
    expect(c.tick(9999), isNull);
    now = 10000;
    expect(c.tick(10000), 2000);
    c.dispose();
  });

  test('目标码率夹在 300..12000 kbps', () {
    var now = 1000;
    final low = RemoteRateController(clock: () => now, initialTargetKbps: 350);
    _frame(low, 0, 0, 1000);
    for (var i = 1; i <= 10; i++) {
      _frame(low, i * 100, 4000, 1000);
    }
    now = 1000;
    expect(low.tick(1000), 300);
    expect(low.targetKbps, 300);
    low.dispose();

    now = 0;
    final high = RemoteRateController(clock: () => now, maxKbps: 2200);
    for (var i = 0; i <= 30; i++) {
      _frame(high, i * 100, 0, 100000); // 8 Mbps 实收
    }
    expect(high.tick(0), 2000);
    now = 3000;
    expect(high.tick(3000), 2200, reason: '2000×1.1 会被上限切成 2200');
    expect(high.targetKbps, 2200);
    high.dispose();

    final d = RemoteRateController();
    expect(d.minKbps, 300);
    expect(d.maxKbps, 12000);
    d.dispose();
  });

  test('stats 给状态栏：target / recv / rtt / 实际生效码率 / 编码尺寸', () {
    var now = 0;
    final c = RemoteRateController(clock: () => now);
    final seen = <RemoteRateStats>[];
    c.stats.addListener(() => seen.add(c.stats.value));
    c.onConfig(1102, 716);
    now = 120;
    c.onPong(120, 1500);
    final s = c.stats.value;
    expect(s.targetKbps, 2000);
    expect(s.encodedWidth, 1102);
    expect(s.encodedHeight, 716);
    expect(s.rttMs, 120);
    expect(s.appliedKbps, 1500);
    expect(seen, isNotEmpty);
    c.dispose();
  });
}
