import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/manage_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/provider_reassign_dialog.dart';

/// 「批量迁移会话…」弹层的 wire 契约（App 侧）—— 与网页管理台
/// （`public/air-provider.js` 的 `openReassign`）和服务端
/// （`src/provider-reassign.js` + `POST /api/providers/:appType/:id/reassign-sessions`）
/// 对齐：三次调用（清单 → 逐会话预演 → 真迁移），只有最后一次不带 `dryRun`。
///
/// 这里钉住的是「App 别把 dryRun 弄丢」——真丢了一次点确认就会在 dry-run 上假装
/// 成功，会话其实没搬。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late SettingsService settings;

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://server.example',
      'multicc_token': 'secret',
    });
    settings = await SettingsService.getInstance();
    await I18n.init('zh');
  });

  const provider = {'appType': 'claude', 'id': 'src', 'name': 'Source'};
  const path = '/api/providers/claude/src/reassign-sessions';

  String count(int n) => t('airProviderReassignCount', {'count': '$n'});

  Map<String, dynamic> boundSession(String id, String label, {String? reason}) => {
    'sessionId': id,
    'label': label,
    'cli': 'claude',
    'model': 'glm-4',
    'reason': reason,
  };

  Map<String, dynamic> listing({int total = 3, List<Map<String, dynamic>>? sessions}) => {
    'ok': true,
    'dryRun': true,
    'source': {'appType': 'claude', 'id': 'src', 'name': 'Source'},
    'total': total,
    'otherReferences': {'auto_candidate': 0, 'subagent': 1, 'default': 0, 'aux': 0},
    'target': null,
    'targets': [
      {
        'id': 'dst',
        'appType': 'claude',
        'name': 'Destination',
        'apiFormat': 'anthropic',
        'compatibleSessions': 2,
        'skippedSessions': 1,
      },
    ],
    'sessions': sessions ??
        [
          boundSession('s1', 'alpha'),
          boundSession('s2', 'beta', reason: 'auto_selection'),
          boundSession('s3', 'gamma'),
        ],
    'switched': 0,
    'skipped': 0,
    'deferred': 0,
    'truncated': false,
    'results': <dynamic>[],
  };

  List<Map<String, dynamic>> previewResults() => [
    {
      'sessionId': 's1',
      'label': 'alpha',
      'cli': 'claude',
      'status': 'switched',
      'deferred': false,
      'modelBefore': 'glm-4',
      'modelAfter': 'claude-sonnet',
      'modelReset': true,
    },
    {
      'sessionId': 's2',
      'label': 'beta',
      'cli': 'claude',
      'status': 'skipped',
      'reason': 'auto_selection',
    },
    {
      'sessionId': 's3',
      'label': 'gamma',
      'cli': 'claude',
      'status': 'switched',
      'deferred': true,
      'modelBefore': 'glm-4',
      'modelAfter': 'glm-4',
      'modelReset': false,
    },
  ];

  /// Records every request so a test can prove the final call dropped `dryRun`.
  ManageService service(Future<http.Response> Function(http.Request, List<http.Request>) handler) {
    final seen = <http.Request>[];
    return ManageService(
      settings: settings,
      httpClient: MockClient((request) async {
        final res = await handler(request, seen);
        seen.add(request);
        return res;
      }),
    );
  }

  http.Response jsonResponse(int status, Object body) => http.Response(
    jsonEncode(body),
    status,
    headers: {'content-type': 'application/json'},
  );

  /// Opens the dialog and hands back whatever it pops (the summary string).
  Future<List<String?>> open(WidgetTester tester, ManageService svc) async {
    final popped = <String?>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => Center(
              child: ElevatedButton(
                onPressed: () async {
                  popped.add(
                    await showDialog<String>(
                      context: context,
                      builder: (_) =>
                          ProviderReassignDialog(manage: svc, provider: provider),
                    ),
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    return popped;
  }

  testWidgets('清单 → 选目标预演 → 确认真迁移（最后一跳不带 dryRun）', (tester) async {
    final bodies = <Map<String, dynamic>>[];
    final svc = service((request, seen) async {
      if (request.url.path != path) return http.Response('not found', 404);
      final body = (jsonDecode(request.body) as Map).cast<String, dynamic>();
      bodies.add(body);
      if (body['dryRun'] == true && body['targetProviderId'] == null) {
        return jsonResponse(200, listing());
      }
      return jsonResponse(200, {
        ...listing(),
        'dryRun': body['dryRun'] == true,
        'target': {'id': 'dst', 'appType': 'claude', 'name': 'Destination'},
        'switched': 2,
        'skipped': 1,
        'deferred': 1,
        'results': previewResults(),
      });
    });

    final popped = await open(tester, svc);

    // 清单：写清有多少会话在用这条线路，并说明别处还有 1 处引用没动。
    expect(find.text(count(3)), findsOneWidget);
    expect(find.text(t('airProviderReassignOtherRefs', {'count': '1'})), findsOneWidget);
    expect(find.text('${t('airProviderReassignBoundTitle')} · 3'), findsOneWidget);
    // Auto 会话在清单里就标出「不会动」，不用等选了目标才知道。
    expect(find.text(t('airProviderReassignReasonAutoSelection')), findsOneWidget);
    // 没选目标之前不能按确认。
    final confirm = tester.widget<FilledButton>(find.byType(FilledButton));
    expect(confirm.onPressed, isNull);

    // 选目标 → 走第二次 dryRun 预演。
    await tester.tap(find.byKey(const ValueKey('provider-reassign-target')));
    await tester.pumpAndSettle();
    await tester.tap(find.text(
      t('airProviderReassignTargetOption', {'name': 'Destination', 'count': '2'}),
    ).last);
    await tester.pumpAndSettle();

    expect(bodies.length, 2);
    expect(bodies[1], {'dryRun': true, 'targetProviderId': 'dst'});
    // 预演：不兼容的旧模型被替换掉，且明确写出来。
    expect(find.text('${t('airProviderReassignWillSwitch')} · 2'), findsOneWidget);
    expect(find.text('${t('airProviderReassignWillSkip')} · 1'), findsOneWidget);
    // 预演行 = CLI · 模型替换说明（与 Web 的 group() 逐字节同形）。出两次是
    // 有意的：上面那份「这条线路上的会话」清单在预演后也换成逐会话结果，
    // 下面「将迁移」再按状态分组列一遍（Web 的 render() 就是这么写的）。
    expect(
      find.text(
        'claude · ${t('airProviderReassignModelReset', {
          'from': 'glm-4',
          'to': 'claude-sonnet',
        })}',
      ),
      findsNWidgets(2),
    );
    // 忙会话下一轮生效，预演里先打招呼。
    expect(find.text(t('airProviderReassignDeferredCount', {'count': '1'})), findsOneWidget);

    // 确认 → 第三次调用必须不带 dryRun，否则什么都没搬。
    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();

    expect(bodies.length, 3);
    expect(bodies[2], {'dryRun': false, 'targetProviderId': 'dst'});
    expect(popped, hasLength(1));
    final summary = popped.single!;
    expect(summary, contains(t('airProviderReassignDone', {'count': '2', 'skipped': '1'})));
    expect(summary, contains(t('airProviderReassignDoneDeferred', {'count': '1'})));
    // 跳过清单点名到会话，括号里是原因。
    expect(
      summary,
      contains(t('airProviderReassignSkippedList', {
        'items': 'beta(${t('airProviderReassignReasonAutoSelection')})',
      })),
    );
  });

  testWidgets('没有会话在用时：说明 + 不可确认', (tester) async {
    final svc = service((request, seen) async =>
        jsonResponse(200, listing(total: 0, sessions: [])));

    await open(tester, svc);

    expect(find.text(t('airProviderReassignEmpty')), findsOneWidget);
    expect(find.text(count(0)), findsNothing);
    expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNull);
  });

  testWidgets('目标线路一条都没有：下拉说明原因并且不可确认', (tester) async {
    final svc = service((request, seen) async {
      final body = (jsonDecode(request.body) as Map).cast<String, dynamic>();
      if (body['dryRun'] == true) {
        return jsonResponse(200, {...listing(), 'targets': <dynamic>[]});
      }
      return jsonResponse(200, listing());
    });

    await open(tester, svc);

    expect(find.text(t('airProviderReassignNoTargets')), findsOneWidget);
    // 没有可选项时下拉本身就是关着的。
    expect(
      tester.widget<DropdownButtonFormField<String>>(
        find.byKey(const ValueKey('provider-reassign-target')),
      ).onChanged,
      isNull,
    );
    expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNull);
  });

  testWidgets('清单拿不到时：报错并退回空态，不会让人误按确认', (tester) async {
    final svc = service((request, seen) async => jsonResponse(500, {'error': 'boom'}));

    await open(tester, svc);

    expect(
      find.text(t('airProviderReassignFailed', {'message': 'Exception: boom'})),
      findsOneWidget,
    );
    expect(find.text(t('airProviderReassignEmpty')), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNull);
  });
}
