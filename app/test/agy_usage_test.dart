import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/models/usage_readout.dart';
import 'package:multicc_app/models/vendor_quota.dart';
import 'package:multicc_app/widgets/chat_runtime_panels.dart';

void main() {
  setUpAll(() => I18n.init('zh'));

  test('反重力上下文实测值优先于旧请求的用量', () {
    final usage = MessageUsage.fromJson({
      'input_tokens': 400, 'output_tokens': 10,
      'context_tokens': 220, 'context_window': 1000,
    });
    final result = ContextReadout.of(
      request: MessageUsage(inputTokens: 800), turn: usage, window: 2000,
    );
    expect(result.tokens, 220);
    expect(result.window, 1000);
    expect(result.exact, isTrue);
  });

  test('反重力额度栏按统一格式展开重置倒计时与同步时间', () {
    const now = 1700000000000;
    const reset5h = now + 2 * 3600000;
    const resetWk = now + 6 * 86400000;
    final view = vendorViewFromBar({
      'text': '反重力 · Gemini: 5h 91% {cd:$reset5h|5h} · 1wk 97% {cd:$resetWk|1wk} · {ago:$now} ⟳',
      'title': '反重力账号额度（agy /usage）\nGemini\n  5小时: 余量 91% · 已用 9% · {cd:$reset5h|5h} 后重置\n同步于 {ago:$now}\n点击 bar 刷新',
      'color': '#58a6ff',
      'action': null,
    }, now: now);
    expect(view, isNotNull);
    expect(view!.text, '反重力 · Gemini: 5h 91% 2h · 1wk 97% 6d · 刚刚 ⟳');
    expect(view.tooltip, contains('2h 后重置'));
    expect(view.tooltip, contains('同步于 刚刚'));
  });

  testWidgets('反重力额度栏显示数据并支持点击刷新', (tester) async {
    var taps = 0;
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: ChatRuntimeNoticePanel(
      agyUsage: const VendorQuotaView('反重力 · Gemini: 5h 42% 2h · 1wk 98% 6d · 刚刚 ⟳', VendorQuotaColor.blue),
      onAgyQuotaTap: () => taps++,
    ))));
    expect(find.text('反重力 · Gemini: 5h 42% 2h · 1wk 98% 6d · 刚刚 ⟳'), findsOneWidget);
    await tester.tap(find.byKey(const Key('agy-quota-bar')));
    expect(taps, 1);
  });
}
