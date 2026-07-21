import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/widgets/ai_config_sheet.dart';
import 'package:multicc_app/widgets/cli_switch_sheet.dart';

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(body: SizedBox(width: 360, height: 740, child: child)),
);

AIConfigSheet _configSheet(SessionCli cli) => AIConfigSheet(
  cli: cli,
  providers: const [],
  provider: '',
  model: '',
  effort: cli.defaultEffort,
  agent: cli.supportsAgent ? 'build' : null,
);

void main() {
  group('CLI capability matrix', () {
    test('matches server-side agent, subagent and effort support', () {
      expect(SessionCli.claude.supportsAgent, isTrue);
      expect(SessionCli.claude.supportsSubagent, isTrue);
      expect(SessionCli.claude.effortFieldLabel, 'Effort');

      expect(SessionCli.codex.supportsAgent, isFalse);
      expect(SessionCli.codex.supportsSubagent, isTrue);
      expect(SessionCli.codex.effortFieldLabel, 'Reasoning Level');

      expect(SessionCli.opencode.supportsAgent, isTrue);
      expect(SessionCli.opencode.supportsSubagent, isFalse);
      expect(SessionCli.opencode.effortFieldLabel, 'Variant');
      expect(SessionCli.opencode.effortOptions, contains('minimal'));

      expect(SessionCli.zcode.supportsAgent, isFalse);
      expect(SessionCli.zcode.supportsSubagent, isFalse);
      expect(SessionCli.zcode.supportsEffort, isFalse);
      expect(SessionCli.zcode.effortOptions, isEmpty);

      expect(SessionCli.qoder.supportsProvider, isFalse);
      expect(SessionCli.qoder.supportsAgent, isTrue);
      expect(SessionCli.qoder.supportsSubagent, isFalse);
      expect(SessionCli.qoder.effortFieldLabel, 'Reasoning Effort');
      expect(SessionCli.qoder.effortOptions, contains('xhigh'));
    });

    test('parses CLI state, availability and native agent fields', () {
      final session = Session.fromJson({
        'id': 'chat-1',
        'kind': 'chat',
        'cli': 'opencode',
        'createdAt': '2026-07-16T00:00:00.000Z',
        'agent': 'build',
        'cliStates': {
          'claude': {'hasNativeSession': true, 'model': 'claude-opus-4-8'},
        },
        'pendingCliHandoff': {
          'id': 'handoff-1',
          'fromCli': 'claude',
          'toCli': 'opencode',
          'status': 'pending',
          'reusedTarget': false,
        },
      });
      expect(session.agent, 'build');
      expect(session.cliStates[SessionCli.claude]?.hasNativeSession, isTrue);
      expect(session.pendingCliHandoff?.toCli, SessionCli.opencode);

      final config = SessionCliConfig.fromJson({
        'cli': 'codex',
        'cliStates': {
          'codex': {'hasNativeSession': true},
        },
        'cliAvailability': {
          'claude': {'available': true},
          'codex': {'available': false},
          'qoder': {'available': true},
        },
        'subagent': {'providerId': 'p1', 'model': 'worker-model'},
      });
      expect(config.cliStates[SessionCli.codex]?.hasNativeSession, isTrue);
      expect(config.cliAvailability[SessionCli.claude], isTrue);
      expect(config.cliAvailability[SessionCli.codex], isFalse);
      expect(config.cliAvailability[SessionCli.qoder], isTrue);
      expect(config.subagent?.model, 'worker-model');
    });
  });

  group('AI config capability UI', () {
    testWidgets('Claude shows native agent and subagent routing', (
      tester,
    ) async {
      await tester.pumpWidget(_host(_configSheet(SessionCli.claude)));
      expect(find.text('Claude Agent'), findsOneWidget);
      expect(find.text('子任务 (subagent)'), findsOneWidget);
      expect(find.text('Effort'), findsOneWidget);
    });

    testWidgets('Codex shows subagent routing without native agent', (
      tester,
    ) async {
      await tester.pumpWidget(_host(_configSheet(SessionCli.codex)));
      expect(find.text('Codex Agent'), findsNothing);
      expect(find.text('子任务 (subagent)'), findsOneWidget);
      expect(find.text('Reasoning Level'), findsOneWidget);
    });

    testWidgets('OpenCode shows native agent and Variant only', (tester) async {
      await tester.pumpWidget(_host(_configSheet(SessionCli.opencode)));
      expect(find.text('OpenCode Agent'), findsOneWidget);
      expect(find.text('子任务 (subagent)'), findsNothing);
      expect(find.text('Variant'), findsOneWidget);
    });

    testWidgets('ZCode hides unsupported controls', (tester) async {
      await tester.pumpWidget(_host(_configSheet(SessionCli.zcode)));
      expect(find.textContaining('Agent'), findsNothing);
      expect(find.text('子任务 (subagent)'), findsNothing);
      expect(find.text('Effort'), findsNothing);
      expect(find.text('Reasoning Level'), findsNothing);
      expect(find.text('Variant'), findsNothing);
    });

    testWidgets(
      'Qoder uses its own account and exposes model, effort, and agent',
      (tester) async {
        await tester.pumpWidget(_host(_configSheet(SessionCli.qoder)));
        expect(find.text('Provider'), findsNothing);
        expect(find.text('Qoder CN 使用自身账号 / BYOK 配置'), findsOneWidget);
        expect(find.text('Qoder CN Agent'), findsOneWidget);
        expect(find.text('Reasoning Effort'), findsOneWidget);
        expect(find.text('子任务 (subagent)'), findsNothing);
      },
    );
  });

  testWidgets(
    'CLI switch sheet reports resume state and disables missing CLI',
    (tester) async {
      const config = SessionCliConfig(
        cli: SessionCli.claude,
        cliStates: {SessionCli.codex: SessionCliState(hasNativeSession: true)},
        cliAvailability: {
          SessionCli.claude: true,
          SessionCli.codex: true,
          SessionCli.opencode: true,
          SessionCli.zcode: false,
          SessionCli.qoder: true,
        },
      );
      await tester.pumpWidget(_host(const CliSwitchSheet(config: config)));

      expect(find.textContaining('可恢复上次原生会话'), findsOneWidget);
      expect(find.text('未安装或不可执行'), findsOneWidget);

      final zcode = tester.widget<InkWell>(
        find.byKey(const Key('cli-switch-option-zcode')),
      );
      expect(zcode.onTap, isNull);

      final submit = tester.widget<FilledButton>(
        find.byKey(const Key('cli-switch-submit')),
      );
      expect(submit.onPressed, isNull);
    },
  );
}
