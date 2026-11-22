import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/models/usage_readout.dart';
import 'package:multicc_app/models/vendor_quota.dart';
import 'package:multicc_app/widgets/chat_runtime_panels.dart';

void main() {
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

  testWidgets('反重力额度栏显示数据并支持点击刷新', (tester) async {
    var taps = 0;
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: ChatRuntimeNoticePanel(
      agyUsage: const VendorQuotaView('反重力 · Gemini 5小时剩余42%', VendorQuotaColor.blue),
      onAgyQuotaTap: () => taps++,
    ))));
    expect(find.text('反重力 · Gemini 5小时剩余42%'), findsOneWidget);
    await tester.tap(find.byKey(const Key('agy-quota-bar')));
    expect(taps, 1);
  });
}
