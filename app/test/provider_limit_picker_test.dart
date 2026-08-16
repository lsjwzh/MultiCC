import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/widgets/ai_config_sheet.dart';

/// Widget regression for the App provider picker: each provider option carries a
/// compact cached-limit suffix (summary + freshness / failure / stale), and a
/// provider with no cache entry reads exactly as before. Mirrors the web picker
/// (public/chat-ai-config.js showProviderPicker / showAIConfigPicker).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));

  final now = DateTime.now().millisecondsSinceEpoch;

  Widget host(AIConfigSheet sheet) => MaterialApp(
        home: Scaffold(
          body: SizedBox(width: 360, height: 740, child: sheet),
        ),
      );

  AIConfigSheet sheetWith(List<Map<String, dynamic>> providers) => AIConfigSheet(
        cli: SessionCli.claude,
        providers: providers,
        provider: 'p1',
        model: '',
        effort: 'medium',
      );

  Map<String, dynamic> provider(
    String id,
    String name, {
    Map<String, dynamic>? limit,
    String? model,
  }) =>
      {
        'id': id,
        'name': name,
        'appType': 'claude',
        if (model != null) 'model': model,
        if (limit != null) 'limit': limit,
      };

  Future<void> openProviderDropdown(WidgetTester tester) async {
    await tester.tap(find.byType(DropdownButtonFormField<String>).first);
    await tester.pumpAndSettle();
  }

  testWidgets('options show summary, freshness and stale/failure markers', (
    tester,
  ) async {
    final providers = [
      provider('p1', 'GLM', limit: {
        'summaryText': '5h 80%',
        'fetchedAt': now - 20_000,
        'stale': false,
      }),
      provider('p2', 'Kimi', limit: {
        'summaryText': '¥12.50',
        'fetchedAt': now - 5 * 60_000,
        'lastError': 'boom',
      }),
      provider('p3', 'ARK', limit: {
        'summaryText': '1wk 40%',
        'fetchedAt': now - 3 * 3_600_000,
        'stale': true,
      }),
      // no cache entry → clean absence, no suffix
      provider('p4', 'Relay', model: 'glm-5.2'),
    ];
    await tester.pumpWidget(host(sheetWith(providers)));
    await openProviderDropdown(tester);

    // The selected-value button and the open menu render the same option text,
    // so each summary appears at least twice (findsWidgets).
    // fresh summary + updated time
    expect(find.textContaining('5h 80%'), findsWidgets);
    expect(find.textContaining('更新于'), findsWidgets);
    // failed fetch keeps the cached summary and says so
    expect(find.textContaining('¥12.50'), findsWidgets);
    expect(find.textContaining('查询失败'), findsWidgets);
    // stale marker rides on the summary
    expect(find.textContaining('1wk 40%'), findsWidgets);
    expect(find.textContaining('过期'), findsWidgets);
    // no cache → plain "name · model", no suffix
    expect(find.text('Relay · glm-5.2'), findsWidgets);
  });

  testWidgets('no-data provider option has no limit suffix', (tester) async {
    await tester.pumpWidget(
      host(
        sheetWith([
          provider('p1', 'GLM'),
          provider('p2', 'Relay', model: 'glm-5.2'),
        ]),
      ),
    );
    await openProviderDropdown(tester);

    // exact-match "GLM" / "Relay · glm-5.2" proves no limit suffix was appended
    expect(find.text('GLM'), findsWidgets);
    expect(find.text('Relay · glm-5.2'), findsWidgets);
    expect(find.textContaining('更新于'), findsNothing);
  });
}
