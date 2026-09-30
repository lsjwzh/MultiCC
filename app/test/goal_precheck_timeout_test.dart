import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/goal_precheck.dart';

/// 预检预算只有服务端一个来源，客户端只加余量。为什么值得测：这条链路上出过的
/// bug 就是「两边各写一个数字」—— 通用 15s 预算去等一个实测 ~18s 的 Aux 调用，
/// 于是每次预检都变成一个裸的客户端超时。
void main() {
  test('跟着服务端走：服务端说 180s，客户端等 180s + 余量', () {
    expect(goalPrecheckTimeoutMs(180000), 210000);
    expect(goalPrecheckTimeoutMs(60000), 90000);
  });

  test('服务端没给或给了脏值：退回兜底值，绝不把预算缩成 0（那会立刻超时）', () {
    final fallback = goalPrecheckFallbackWaitMs + goalPrecheckClientSlackMs;
    expect(goalPrecheckTimeoutMs(null), fallback);
    expect(goalPrecheckTimeoutMs(0), fallback);
    expect(goalPrecheckTimeoutMs(-5), fallback);
  });

  test('余量是正的：服务端那句「超时请检查辅助模型」必须早于客户端 abort', () {
    expect(goalPrecheckClientSlackMs, greaterThan(0));
    expect(goalPrecheckFallbackWaitMs, greaterThan(60000));
  });
}
