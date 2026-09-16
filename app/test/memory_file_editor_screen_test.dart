// 为什么这么测：
//
// 记忆文件编辑器（Web `openMemFileEditor(rel)` 的原生对应物）里，真正会伤人的
// 不是排版，而是三条**写文件的安全语义**：
//   1. 服务端截断过的超长文件必须只读 —— 预览绝不能覆盖完整文件；
//   2. 读取失败（除 404）必须禁用保存 —— 不能用空内容覆盖一个读不出来的文件；
//   3. 404 是「保存后创建」，不是错误。
// 外加一条交互：有未保存改动时返回要先问一句（Web 的 `confirm`）。
// 这些都够在没有真实服务的前提下验完。
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/screens/memory_file_editor_screen.dart';
import 'package:multicc_app/services/memory_file_service.dart';
import 'package:multicc_app/services/settings_service.dart';

http.Response jsonResponse(Object payload, [int status = 200]) => http.Response(
  jsonEncode(payload),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

const String rel = 'd1/_shared/dragon.md';
const String filePath = '/mem/d1/_shared/dragon.md';

/// 假服务：GET 回 [file]（或按 [loadStatus] 失败），PUT 把请求体记进 [saved]。
http.Client mockServer({
  Map<String, dynamic>? file,
  int loadStatus = 200,
  List<Map<String, dynamic>>? saved,
  List<String>? deleted,
}) {
  return MockClient((request) async {
    if (request.method == 'GET') {
      if (loadStatus == 404) {
        return jsonResponse({'error': 'file not found'}, 404);
      }
      if (loadStatus >= 400) {
        return jsonResponse({'error': 'read failed: EACCES'}, loadStatus);
      }
      return jsonResponse(
        file ??
            {
              'rel': rel,
              'path': filePath,
              'name': 'dragon.md',
              'content': '# 龙头战法\n打板负EV',
              'size': 26,
              'tokens': 12,
              'mtime': '2026-09-16T00:00:00.000Z',
            },
      );
    }
    if (request.method == 'DELETE') {
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      deleted?.add(body['rel'] as String);
      return jsonResponse({'ok': true});
    }
    final body = jsonDecode(request.body) as Map<String, dynamic>;
    saved?.add(body);
    return jsonResponse({
      'ok': true,
      'rel': body['rel'],
      'path': filePath,
      'size': (body['content'] as String).length,
      'tokens': 7,
    });
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late SettingsService settings;

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:9',
      'multicc_token': 'tkn-memory-file',
    });
    settings = await SettingsService.getInstance();
  });

  Future<MemoryFileEditorScreenState> pumpEditor(
    WidgetTester tester,
    http.Client client,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: MemoryFileEditorScreen(
          settings: settings,
          rel: rel,
          httpClient: client,
        ),
      ),
    );
    await tester.pumpAndSettle();
    return tester.state<MemoryFileEditorScreenState>(
      find.byType(MemoryFileEditorScreen),
    );
  }

  testWidgets('正常加载：路径 + 内容 + 可保存', (tester) async {
    final saved = <Map<String, dynamic>>[];
    await pumpEditor(tester, mockServer(saved: saved));

    expect(find.text(filePath), findsOneWidget);
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('memory-file-editor')))
          .controller
          ?.text,
      '# 龙头战法\n打板负EV',
    );
    expect(find.textContaining('估算 ~'), findsOneWidget);
    expect(
      tester
          .widget<TextButton>(find.byKey(const ValueKey('memory-file-save')))
          .onPressed,
      isNotNull,
    );

    await tester.enterText(
      find.byKey(const ValueKey('memory-file-editor')),
      '# 改过的内容',
    );
    await tester.pumpAndSettle();
    expect(find.text('未保存'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('memory-file-save')));
    await tester.pumpAndSettle();
    expect(saved, [
      {'rel': rel, 'content': '# 改过的内容'},
    ]);
    expect(find.textContaining('已保存'), findsOneWidget);
    expect(find.text('未保存'), findsNothing);
  });

  testWidgets('超长文件：只读 + 提示语 + 保存禁用', (tester) async {
    final saved = <Map<String, dynamic>>[];
    await pumpEditor(
      tester,
      mockServer(
        saved: saved,
        file: {
          'rel': rel,
          'path': filePath,
          'content': 'x' * 10,
          'originalLength': 250000,
          'contentTruncated': true,
          'size': 250000,
          'tokens': 60000,
        },
      ),
    );

    expect(find.textContaining('超过可安全编辑上限 200000'), findsOneWidget);
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('memory-file-editor')))
          .readOnly,
      isTrue,
    );
    expect(
      tester
          .widget<TextButton>(find.byKey(const ValueKey('memory-file-save')))
          .onPressed,
      isNull,
      reason: '预览绝不能覆盖完整文件',
    );
    expect(saved, isEmpty);
  });

  testWidgets('404 = 保存后创建，不是错误', (tester) async {
    final saved = <Map<String, dynamic>>[];
    await pumpEditor(
      tester,
      mockServer(loadStatus: 404, saved: saved),
    );

    expect(find.text('（文件不存在，保存后创建）· $rel'), findsOneWidget);
    expect(find.byKey(const ValueKey('memory-file-error')), findsNothing);
    expect(find.text('创建'), findsOneWidget);

    await tester.enterText(
      find.byKey(const ValueKey('memory-file-editor')),
      '# 新文件',
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('memory-file-save')));
    await tester.pumpAndSettle();
    expect(saved, [
      {'rel': rel, 'content': '# 新文件'},
    ]);
  });

  testWidgets('读取失败：报真实错误 + 禁用保存，避免覆盖未知内容', (tester) async {
    await pumpEditor(tester, mockServer(loadStatus: 500));

    expect(find.text('读取失败：read failed: EACCES'), findsOneWidget);
    expect(find.text('文件读取失败，已禁用保存以避免覆盖未知内容。'), findsOneWidget);
    expect(
      tester
          .widget<TextButton>(find.byKey(const ValueKey('memory-file-save')))
          .onPressed,
      isNull,
    );
  });

  testWidgets('有未保存改动时返回要先确认（丢掉才走）', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => MemoryFileEditorScreen(
                    settings: settings,
                    rel: rel,
                    httpClient: mockServer(),
                  ),
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('memory-file-editor')),
      '改了一点',
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(Icons.arrow_back_rounded));
    await tester.pumpAndSettle();
    expect(find.text('有未保存的改动'), findsOneWidget);

    // 取消 = 留在编辑器里。
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(find.byType(MemoryFileEditorScreen), findsOneWidget);

    // 丢弃 = 真的退出。
    await tester.tap(find.byIcon(Icons.arrow_back_rounded));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('memory-file-discard')));
    await tester.pumpAndSettle();
    expect(find.byType(MemoryFileEditorScreen), findsNothing);
    expect(find.text('open'), findsOneWidget);
  });

  test('estimateMemoryTokens / formatMemorySize 与服务端同一口径', () {
    expect(estimateMemoryTokens(''), 0);
    // 中文 1.5 token/字 + 其余 4 字符/token（服务端 estimateMemTokens）。
    expect(estimateMemoryTokens('中文记忆'), 6);
    expect(estimateMemoryTokens('abcd'), 1);
    expect(formatMemorySize(0), '0 B');
    expect(formatMemorySize(5240), '5.1 KB');
    expect(formatMemorySize(2 * 1024 * 1024), '2.0 MB');
    expect(formatMemorySize(-1), '–');
  });

  /// 从宿主页 push 编辑器，并把 pop 的返回值收集起来 —— 图谱就是靠这个 bool
  /// 决定「要不要重取」（Web 的 `afterMemChange()`）。
  Future<List<bool?>> pumpViaHost(
    WidgetTester tester,
    http.Client client,
  ) async {
    final results = <bool?>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                final changed = await Navigator.of(context).push<bool>(
                  MaterialPageRoute<bool>(
                    builder: (_) => MemoryFileEditorScreen(
                      settings: settings,
                      rel: rel,
                      httpClient: client,
                    ),
                  ),
                );
                results.add(changed);
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    return results;
  }

  testWidgets('保存过再返回 → 回 true（图谱据此重取）', (tester) async {
    final results = await pumpViaHost(tester, mockServer());
    await tester.enterText(
      find.byKey(const ValueKey('memory-file-editor')),
      '# 落盘过',
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('memory-file-save')));
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(Icons.arrow_back_rounded));
    await tester.pumpAndSettle();
    expect(results, [true]);
  });

  testWidgets('没改过就返回 → 回 false，图谱不白跑一次请求', (tester) async {
    final results = await pumpViaHost(tester, mockServer());
    await tester.tap(find.byIcon(Icons.arrow_back_rounded));
    await tester.pumpAndSettle();
    expect(results, [false]);
  });

  testWidgets('删除：先确认，成功后退出并回 true', (tester) async {
    final deleted = <String>[];
    final results = await pumpViaHost(
      tester,
      mockServer(deleted: deleted),
    );
    expect(find.byKey(const ValueKey('memory-file-delete')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('memory-file-delete')));
    await tester.pumpAndSettle();
    expect(find.text('删除记忆文件「dragon.md」？不可恢复。'), findsOneWidget);

    // 取消 = 什么都没发生。
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(deleted, isEmpty);
    expect(find.byType(MemoryFileEditorScreen), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('memory-file-delete')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('memory-file-delete-confirm')));
    await tester.pumpAndSettle();
    expect(deleted, [rel]);
    expect(find.byType(MemoryFileEditorScreen), findsNothing);
    expect(results, [true]);
  });
}
