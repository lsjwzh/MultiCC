import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/widgets/model_chip.dart';

/// 会话里存的是 Provider id，芯片上要的是名字。这条规则有一条硬底线：**知道名字
/// 就绝不显示 id** —— 屏幕上出现 8dc4-4585 这种片段，就是「选完线路看不到名字」
/// 那个 bug 的样子。
void main() {
  const catalog = [
    {'id': 'p-glm', 'name': 'Zhipu GLM'},
    {'id': 'p-kimi', 'name': 'Kimi'},
  ];

  test('没有显式线路时说官方 Provider，不再说默认登录', () {
    expect(providerDisplayLabel(null, providers: const []), '官方 Provider');
    expect(providerDisplayLabel('', providers: const []), '官方 Provider');
    expect(
      providerDisplayLabel(
        '',
        providers: const [
          {'id': 'codex-official', 'name': 'Codex 官方', 'builtinOfficial': true},
        ],
      ),
      'Codex 官方',
    );
  });

  test('catalog 认识这条线路就用它的名字', () {
    expect(providerDisplayLabel('p-glm', providers: catalog), 'Zhipu GLM');
  });

  test('catalog 还没有这条线路时用服务端解析名，而不是显示 id', () {
    const id = 'd7a3b5ec-8dc4-4585-85c0-040affceb538';
    expect(
      providerDisplayLabel(id, providers: const [], resolved: 'Kimi'),
      'Kimi',
    );
    // 服务端的兜底也是 id（provider 已被删掉）时，退回缩写片段。
    expect(
      providerDisplayLabel(id, providers: const [], resolved: id),
      'd7a3b5ec',
    );
    expect(providerDisplayLabel(id, providers: const []), 'd7a3b5ec');
  });

  test('短 id 不缩写，别把有意义的短名切成半个', () {
    expect(providerDisplayLabel('relay-b', providers: const []), 'relay-b');
  });
}
