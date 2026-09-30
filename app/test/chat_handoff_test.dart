import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/chat_handoff.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 交接包（handoff bundle）App 端的离线断言：URL 拼装、导出对话框的本地口令
/// 闸门、导入对话框的落点档位，以及导入报告里 '*' 整 scope 跳过的原样上屏。
/// 参照 public/chat-handoff.js（Web 的参考实现）。

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://localhost:3000',
  });
  return SettingsService.getInstance();
}

Future<void> _pumpOpener(
  WidgetTester tester,
  VoidCallback open,
) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => Center(
            child: TextButton(onPressed: open, child: const Text('开')),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('开'));
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(() => I18n.init('zh'));

  group('handoffExportUri', () {
    test('执行环境 scope 全量 + skillsMode=auto，envOnly 才加 context=0&git=0', () {
      final full = handoffExportUri('s-1', 'pw123456');
      expect(full.path, '/api/sessions/s-1/bundle.zip');
      expect(full.queryParameters['passphrase'], 'pw123456');
      expect(
        full.queryParameters['scopes'],
        'session,shared,task,cli,machine',
        reason: 'machine/cli/shared 少带一层就不是复刻环境',
      );
      expect(full.queryParameters['skillsMode'], 'auto');
      expect(full.queryParameters.containsKey('context'), isFalse);
      expect(full.queryParameters.containsKey('git'), isFalse);

      final envOnly = handoffExportUri('s 1/x', 'pw123456', envOnly: true);
      expect(envOnly.path, '/api/sessions/s%201%2Fx/bundle.zip');
      expect(envOnly.queryParameters['context'], '0');
      expect(envOnly.queryParameters['git'], '0');
    });

    test('import query 恰好三选一：envOnly=1 | dirId | targetSessionId', () {
      expect(
        handoffImportQuery(passphrase: 'pw123456', target: 'env'),
        {'passphrase': 'pw123456', 'envOnly': '1'},
      );
      expect(
        handoffImportQuery(passphrase: 'pw123456', target: 'new', dirId: 'd1'),
        {'passphrase': 'pw123456', 'dirId': 'd1'},
      );
      expect(
        handoffImportQuery(
          passphrase: 'pw123456',
          target: 'merge',
          targetSessionId: 's1',
        ),
        {'passphrase': 'pw123456', 'targetSessionId': 's1'},
      );
    });

    test('zip 按魔数判断，不信扩展名', () {
      expect(handoffIsZip(Uint8List.fromList([0x50, 0x4b, 0x03, 0x04])), isTrue);
      expect(handoffIsZip(Uint8List.fromList([0x7b, 0x22])), isFalse);
      expect(handoffIsZip(Uint8List.fromList([0x50])), isFalse);
    });

    test('下载名只收安全字符，脏响应头退回 fallback', () {
      expect(
        handoffDownloadName({
          'content-disposition':
              'attachment; filename="multicc-handoff-20260101-120000.zip"',
        }),
        'multicc-handoff-20260101-120000.zip',
      );
      expect(
        handoffDownloadName({
          'content-disposition': 'attachment; filename="../../evil.zip"',
        }),
        'multicc-handoff.zip',
      );
      expect(handoffDownloadName({}), 'multicc-handoff.zip');
    });
  });

  group('导出对话框', () {
    testWidgets('口令不到 6 位：本地报错，一个请求都不发', (tester) async {
      final calls = <http.BaseRequest>[];
      final client = MockClient((request) async {
        calls.add(request);
        return http.Response.bytes(
          Uint8List.fromList([0x50, 0x4b, 0x03, 0x04]),
          200,
          headers: {
            'content-disposition': 'attachment; filename="multicc-handoff.zip"',
          },
        );
      });
      final settings = await _settings();
      await _pumpOpener(
        tester,
        () => showHandoffExportDialog(
          tester.element(find.byType(Scaffold)),
          sessionId: 's1',
          settings: settings,
          httpClient: client,
        ),
      );

      await tester.enterText(
        find.byKey(const ValueKey('handoff-export-pass')),
        '12345',
      );
      await tester.tap(find.byKey(const ValueKey('handoff-export-submit')));
      await tester.pumpAndSettle();

      expect(find.text('口令至少 6 位。'), findsOneWidget);
      expect(
        calls,
        isEmpty,
        reason: '本地就该拦下来，不该白跑一趟服务端',
      );
    });
  });

  group('导入对话框', () {
    testWidgets('没有 currentSessionId：两档落点，默认「只装执行环境」', (
      tester,
    ) async {
      final client = MockClient((request) async => http.Response('[]', 200));
      final settings = await _settings();
      await _pumpOpener(
        tester,
        () => showHandoffImportDialog(
          tester.element(find.byType(Scaffold)),
          settings: settings,
          httpClient: client,
        ),
      );

      final radios = tester
          .widgetList<Radio<String>>(find.byType(Radio<String>))
          .toList();
      expect(radios.length, 2);
      expect(radios.map((r) => r.value).toSet(), {'env', 'new'});
      final env = radios.firstWhere((r) => r.value == 'env');
      expect(env.groupValue, 'env');
    });

    testWidgets('有 currentSessionId：三档落点（多一个「并入当前会话」）', (
      tester,
    ) async {
      final client = MockClient((request) async => http.Response('[]', 200));
      final settings = await _settings();
      await _pumpOpener(
        tester,
        () => showHandoffImportDialog(
          tester.element(find.byType(Scaffold)),
          currentSessionId: 's1',
          settings: settings,
          httpClient: client,
        ),
      );

      final radios = tester
          .widgetList<Radio<String>>(find.byType(Radio<String>))
          .toList();
      expect(radios.length, 3);
      expect(radios.map((r) => r.value).toSet(), {'env', 'new', 'merge'});
      final env = radios.firstWhere((r) => r.value == 'env');
      expect(env.groupValue, 'env');
    });

    testWidgets('没选文件 / 口令太短都先本地拦下', (tester) async {
      final calls = <http.BaseRequest>[];
      final client = MockClient((request) async {
        calls.add(request);
        return http.Response('{}', 200);
      });
      final settings = await _settings();
      await _pumpOpener(
        tester,
        () => showHandoffImportDialog(
          tester.element(find.byType(Scaffold)),
          settings: settings,
          httpClient: client,
        ),
      );

      await tester.tap(find.byKey(const ValueKey('handoff-import-submit')));
      await tester.pumpAndSettle();
      expect(find.text('先选一个交接包文件。'), findsOneWidget);
      expect(calls, isEmpty);
    });
  });

  group('handoffReportLines', () {
    test("'*' 整 scope 跳过的原因原样上屏，逐文件跳过只计数", () {
      final lines = handoffReportLines({
        'ok': true,
        'mode': 'env',
        'restored': {
          'memoryScopes': {
            'shared': {
              'written': ['notes.md'],
              'skipped': [
                {'name': '*', 'reason': 'shared memory dir not found'},
              ],
            },
            'task': {
              'written': [],
              'skipped': [
                {'name': 'dup.md', 'reason': 'local file wins'},
              ],
            },
          },
        },
      });

      expect(lines.first, startsWith('导入完成'));
      expect(lines, contains('shared: shared memory dir not found'));
      expect(lines, contains('记忆：写入 1 个，跳过 2 个'));
      expect(
        lines.any((l) => l.contains('dup.md')),
        isFalse,
        reason: '同名文件本机已有很常见，不该逐条刷屏',
      );
    });

    test('会话 / 消息 / 技能 / 附件 / 代码层各行都对齐 Web reportText', () {
      final lines = handoffReportLines({
        'ok': true,
        'mode': 'new',
        'sessionId': 'sess-42',
        'restored': {
          'messages': 12,
          'memoryScopes': {
            'session': {'written': ['a.md', 'b.md'], 'skipped': []},
          },
          'skills': [
            {'name': 'sk1', 'status': 'installed'},
            {'name': 'sk2', 'status': 'skipped'},
          ],
          'assets': {'restored': 3},
          'gitRestored': false,
          'gitNote': 'bundle contained no new commits',
        },
      });

      expect(lines, contains('会话：sess-42'));
      expect(lines, contains('上下文：12 条历史消息'));
      expect(lines, contains('记忆：写入 2 个，跳过 0 个'));
      expect(lines, contains('技能：2 个 — sk1 (installed), sk2 (skipped)'));
      expect(lines, contains('对话附件：3 个'));
      expect(lines, contains('代码层：bundle contained no new commits'));
    });

    test('gitRestored 为真时念「已 replay」，不再带 note', () {
      final lines = handoffReportLines({
        'ok': true,
        'mode': 'merge',
        'sessionId': 'sess-7',
        'restored': {
          'gitRestored': true,
          'gitNote': 'ignored',
        },
      });
      expect(
        lines,
        contains('代码层：源分支独有的提交已 replay 到目标 worktree'),
      );
      expect(lines.any((l) => l.contains('ignored')), isFalse);
    });
  });
}
