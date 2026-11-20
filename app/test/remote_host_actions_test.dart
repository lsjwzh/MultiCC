import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/remote_host_actions.dart';

void main() {
  test('macOS 宿主给出四个默认动作，键位串是 press 能吃的形状', () {
    final actions = remoteHostActions('cmd');
    expect(actions.map((a) => a.id), [
      'desktop',
      'mission',
      'windows',
      'switcher',
    ]);
    for (final action in actions) {
      expect(action.keys, isNotEmpty);
      expect(action.keys, isNot(contains(' ')));
    }
  });

  test('没有远控 Agent 的平台不给一排死按钮', () {
    expect(remoteHostActions('ctrl'), isEmpty);
    expect(remoteHostActions(''), isEmpty);
  });
}
