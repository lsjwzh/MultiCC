import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/create_session_dialog.dart';
import 'package:multicc_app/widgets/provider_option.dart';

/// Real provider-switch window regression (dispatch: "App 切换 provider 的窗口里
/// 仍然看不到余量信息").
///
/// Drives the actual "新建会话" dialog [CreateSessionDialog] — the entry the
/// user reported — and asserts the two-line [ProviderOption] layout shows each
/// provider's cached-limit summary AND its own freshness simultaneously in a
/// phone width. The dialog's dropdowns are isExpanded so the closed field (which
/// renders the selected provider's two-line option) never overflows and the
/// detail line isn't ellipsised away.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));

  final now = DateTime.now().millisecondsSinceEpoch;

  Future<SettingsService> settings() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:1', // unreachable → preset fetch fails fast
      'multicc_token': '',
    });
    return SettingsService.getInstance();
  }

  List<Map<String, dynamic>> providers() => [
        // fresh summary + updated time
        {
          'id': 'p1',
          'name': 'GLM',
          'appType': 'claude',
          'modelOptions': ['glm-5.2'],
          'limit': {
            'summaryText': '5h 80%',
            'fetchedAt': now - 20_000,
            'stale': false,
          },
        },
        // failed fetch keeps the cached summary and says so (no "updated" line)
        {
          'id': 'p2',
          'name': 'Kimi',
          'appType': 'claude',
          'modelOptions': ['kimi-k2'],
          'limit': {
            'summaryText': '¥12.50',
            'fetchedAt': now - 5 * 60_000,
            'lastError': 'boom',
          },
        },
        // stale marker rides on the summary
        {
          'id': 'p3',
          'name': 'ARK',
          'appType': 'claude',
          'modelOptions': ['ark-1'],
          'limit': {
            'summaryText': '1wk 40%',
            'fetchedAt': now - 3 * 3_600_000,
            'stale': true,
          },
        },
        // no cache row → clean absence (plain "name · model", no detail line)
        {
          'id': 'p4',
          'name': 'Relay',
          'appType': 'claude',
          'model': 'relay-1',
          'modelOptions': ['relay-1'],
        },
      ];

  Widget host(Widget dialog) => MaterialApp(
        home: Scaffold(body: SizedBox(width: 360, height: 640, child: dialog)),
      );

  Future<void> openProviderDropdown(WidgetTester tester) async {
    // CreateSessionDialog has multiple DropdownButtonFormField<String> (provider
    // then model); the provider one comes first.
    await tester.tap(find.byType(DropdownButtonFormField<String>).first);
    await tester.pumpAndSettle();
  }

  testWidgets('open picker shows every provider limit + freshness, '
      'phone width, no overflow', (tester) async {
    final s = await settings();
    await tester.pumpWidget(
      host(
        CreateSessionDialog(
          kind: SessionKind.chat,
          defaultCli: SessionCli.claude,
          providers: providers(),
          settings: s,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await openProviderDropdown(tester);

    // Two different providers with different limits render SIMULTANEOUSLY in
    // the same open picker — summary + per-provider freshness.
    expect(find.textContaining('5h 80%'), findsWidgets);
    expect(find.textContaining('更新于'), findsWidgets);
    expect(find.textContaining('1wk 40%'), findsWidgets);
    // failed fetch: cached summary kept, failure stated
    expect(find.textContaining('¥12.50'), findsWidgets);
    expect(find.textContaining('查询失败'), findsWidgets);
    // stale marker
    expect(find.textContaining('过期'), findsWidgets);
    // no cache row → plain name · model, no detail line
    expect(find.text('Relay · relay-1'), findsWidgets);

    // The whole dialog on a 360px phone must not overflow (dropdowns are
    // isExpanded, two-line options ellipsise, never a clipped layout).
    expect(tester.takeException(), isNull);
  });

  testWidgets('selected provider renders its option in the closed field '
      'without overflow; limit detail appears in the open menu', (tester) async {
    final s = await settings();
    // Real flow: a default provider is pre-selected, so the closed dropdown
    // shows that provider's ProviderOption. The closed button is a fixed
    // single dense line, so ProviderOption renders its compact main line there
    // (no overflow); the two-line limit detail shows once the picker opens.
    await tester.pumpWidget(
      host(
        CreateSessionDialog(
          kind: SessionKind.chat,
          defaultCli: SessionCli.claude,
          providers: providers(),
          defaultProviderId: 'p3', // stale provider, longest detail
          settings: s,
        ),
      ),
    );
    await tester.pumpAndSettle();

    // Closed field: compact main line for the selected provider (it is the
    // default, so a "默认 · " prefix rides on the name line), no overflow.
    expect(find.textContaining('ARK'), findsWidgets);
    expect(tester.takeException(), isNull);

    // Opening the picker surfaces the two-line detail for every provider.
    await openProviderDropdown(tester);
    expect(find.textContaining('1wk 40%'), findsWidgets);
    expect(find.textContaining('过期'), findsWidgets);
    expect(find.textContaining('5h 80%'), findsWidgets);
    expect(find.textContaining('¥12.50'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('ProviderOption keeps the detail line on a narrow box '
      '(no layout overflow)', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: 140,
              child: ProviderOption(
                main: 'GLM · glm-5.2',
                detail: '5h 80% · 更新于 12 分钟前 · 过期',
              ),
            ),
          ),
        ),
      ),
    );
    expect(find.text('GLM · glm-5.2'), findsOneWidget);
    expect(find.text('5h 80% · 更新于 12 分钟前 · 过期'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('ProviderOption with empty detail is a single plain line',
      (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: ProviderOption(main: 'Relay · relay-1'),
          ),
        ),
      ),
    );
    expect(find.text('Relay · relay-1'), findsOneWidget);
    expect(find.byType(Column), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('basic mode shows one recommended path and no engine controls', (
    tester,
  ) async {
    final s = await settings();
    await tester.pumpWidget(
      host(
        CreateSessionDialog(
          kind: SessionKind.chat,
          defaultCli: SessionCli.codex,
          providers: providers(),
          cliAvailability: const {
            SessionCli.claude: false,
            SessionCli.codex: true,
          },
          settings: s,
          basicMode: true,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('recommended-ai-summary')),
      findsOneWidget,
    );
    expect(find.textContaining('Codex'), findsOneWidget);
    expect(find.byType(DropdownButtonFormField<SessionCli>), findsNothing);
    expect(find.byType(DropdownButtonFormField<String>), findsNothing);
    expect(find.text('Provider'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
