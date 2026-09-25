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

/// 尾巴那行要的两个线路，模型候选各自不同 —— 换线路能不能换掉候选靠它验。
const List<Map<String, dynamic>> _subProviders = [
  {
    'id': 'p1',
    'name': 'Primary',
    'modelOptions': ['model-a', 'model-b'],
  },
  {
    'id': 'p2',
    'name': 'Backup',
    'modelOptions': ['backup-model'],
  },
];

/// 开面板 → 点保存 → 把面板吐出来的结果交回来。
Future<AIConfigResult?> _saveSheet(
  WidgetTester tester, {
  List<Map<String, dynamic>> providers = _subProviders,
  String provider = 'p1',
  String? subProviderId,
  String? subModel,
}) async {
  AIConfigResult? result;
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => ElevatedButton(
            key: const Key('open-ai-config'),
            onPressed: () async {
              result = await showModalBottomSheet<AIConfigResult>(
                context: context,
                isScrollControlled: true,
                builder: (_) => AIConfigSheet(
                  cli: SessionCli.claude,
                  providers: providers,
                  provider: provider,
                  model: '',
                  effort: SessionCli.claude.defaultEffort,
                  subProviderId: subProviderId,
                  subModel: subModel,
                ),
              );
            },
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.byKey(const Key('open-ai-config')));
  await tester.pumpAndSettle();
  final save = find.widgetWithText(ElevatedButton, '保存');
  await tester.ensureVisible(save);
  await tester.tap(save);
  await tester.pumpAndSettle();
  return result;
}

/// 下拉当前选中的值（DropdownButtonFormField 自己不留公开的 value getter）。
String? _dropdownValue(WidgetTester tester, Key key) =>
    tester.state<FormFieldState<String>>(find.byKey(key)).value;

void main() {
  group('CLI capability matrix', () {
    test('matches server-side agent, subagent and effort support', () {
      expect(SessionCli.claude.supportsAgent, isTrue);
      expect(SessionCli.claude.supportsSubagent, isTrue);
      expect(SessionCli.claude.effortFieldLabel, 'Effort');

      expect(SessionCli.codex.supportsAgent, isFalse);
      expect(SessionCli.codex.supportsSubagent, isTrue);
      expect(SessionCli.codex.effortFieldLabel, 'Reasoning Level');
      expect(SessionCli.codex.effortOptions, [
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultra',
      ]);
      expect(tryParseCli('codex-exp'), SessionCli.codexExp);
      expect(SessionCli.codexExp.isCodexFamily, isTrue);
      expect(SessionCli.codexExp.supportsSubagent, isTrue);
      expect(SessionCli.codexExp.poolKey, 'codex');

      expect(tryParseCli('claude-exp'), SessionCli.claudeExp);
      expect(SessionCli.claudeExp.isClaudeFamily, isTrue);
      expect(SessionCli.claudeExp.supportsAgent, isTrue);
      expect(SessionCli.claudeExp.supportsSubagent, isTrue);
      expect(SessionCli.claudeExp.poolKey, 'claude');
      expect(SessionCli.claudeExp.defaultEffort, 'medium');
      // 显示名跟产品走：这是 Anthropic 的 Claude Agent SDK（内部 id 仍是 claude-exp）。
      expect(SessionCli.claudeExp.displayName, 'Claude Agent SDK');
      expect(SessionCli.claude.displayName, 'Claude');

      expect(SessionCli.opencode.supportsAgent, isTrue);
      expect(SessionCli.opencode.supportsSubagent, isFalse);
      expect(SessionCli.opencode.poolKey, 'opencode');
      expect(SessionCli.opencode.effortFieldLabel, 'Variant');
      expect(SessionCli.opencode.effortOptions, contains('minimal'));

      expect(SessionCli.zcode.supportsAgent, isFalse);
      expect(SessionCli.zcode.supportsSubagent, isFalse);
      expect(SessionCli.zcode.supportsEffort, isFalse);
      expect(SessionCli.zcode.effortOptions, isEmpty);

      expect(SessionCli.qoder.supportsProvider, isFalse);
      expect(SessionCli.qoder.poolKey, 'qoder');
      expect(SessionCli.qoder.supportsAgent, isTrue);
      expect(SessionCli.qoder.supportsSubagent, isFalse);
      expect(SessionCli.qoder.effortFieldLabel, 'Reasoning Effort');
      expect(SessionCli.qoder.effortOptions, contains('xhigh'));

      // Gemini / Grok ride the ACP lane like opencode and sign in with their own
      // vendor account: no MultiCC pool, no effort knob, their own model list.
      for (final cli in [SessionCli.gemini, SessionCli.grok]) {
        expect(cli.supportsProvider, isFalse);
        expect(cli.supportsSubagent, isFalse);
        expect(cli.supportsEffort, isFalse);
        expect(cli.effortOptions, isEmpty);
      }
      expect(tryParseCli('gemini'), SessionCli.gemini);
      expect(SessionCli.gemini.displayName, 'Gemini');
      expect(SessionCli.gemini.name, 'gemini');
      expect(tryParseCli('grok'), SessionCli.grok);
      expect(SessionCli.grok.displayName, 'Grok');
      expect(SessionCli.grok.name, 'grok');
      expect(kGeminiModelOptions.map((e) => e.key), contains('gemini-2.5-pro'));
      expect(kGrokModelOptions.map((e) => e.key), contains('grok-4'));
      expect(modelShortNameForCli(SessionCli.gemini, 'gemini-2.5-flash'),
        'gemini-2.5-flash');
      expect(modelShortNameForCli(SessionCli.grok, ''), '默认（跟随 Grok 配置）');
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
      expect(find.text('子任务'), findsOneWidget);
      expect(find.text('Effort'), findsOneWidget);
    });

    testWidgets('Codex shows subagent routing without native agent', (
      tester,
    ) async {
      await tester.pumpWidget(_host(_configSheet(SessionCli.codex)));
      expect(find.text('Codex Agent'), findsNothing);
      expect(find.text('子任务'), findsOneWidget);
      expect(find.text('Reasoning Level'), findsOneWidget);
    });

    testWidgets('OpenCode shows native agent and Variant only', (tester) async {
      await tester.pumpWidget(_host(_configSheet(SessionCli.opencode)));
      expect(find.text('OpenCode Agent'), findsOneWidget);
      expect(find.text('子任务'), findsNothing);
      expect(find.text('Variant'), findsOneWidget);
    });

    testWidgets('ZCode hides unsupported controls', (tester) async {
      await tester.pumpWidget(_host(_configSheet(SessionCli.zcode)));
      expect(find.textContaining('Agent'), findsNothing);
      expect(find.text('子任务'), findsNothing);
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
        expect(find.text('子任务'), findsNothing);
      },
    );
  });

  group('子任务尾巴（线路 + 模型一行）', () {
    testWidgets('没选模型就等于没设 —— 交空回去', (tester) async {
      final result = await _saveSheet(tester);
      expect(result?.provider, 'p1');
      expect(result?.subagent, isNull);
    });

    testWidgets('只挑线路不挑模型，也算没设', (tester) async {
      final result = await _saveSheet(tester, subProviderId: 'p2');
      expect(result?.subagent, isNull);
    });

    testWidgets('线路留空 = 随主，providerId 落在这一轮的主 Provider 上', (tester) async {
      final result = await _saveSheet(tester, subModel: 'model-a');
      expect(result?.subagent?.providerId, 'p1');
      expect(result?.subagent?.model, 'model-a');
    });

    testWidgets('挑了独立线路，线路和模型都按它走', (tester) async {
      final result = await _saveSheet(
        tester,
        subProviderId: 'p2',
        subModel: 'backup-model',
      );
      expect(result?.subagent?.providerId, 'p2');
      expect(result?.subagent?.model, 'backup-model');
    });

    testWidgets('尾巴就在 provider 配置后面，一行放下线路和模型', (tester) async {
      await tester.pumpWidget(
        _host(
          const AIConfigSheet(
            cli: SessionCli.claude,
            providers: _subProviders,
            provider: 'p1',
            model: 'model-a',
            effort: 'medium',
            subModel: 'model-b',
          ),
        ),
      );
      // 存下来的子任务（线路留空 + 主线路上的模型）得原样回填，不能被当成
      // 「自定义 ID」—— 别名折算和候选判定都按生效线路走才对得上。
      expect(_dropdownValue(tester, const Key('subagent-model')), 'model-b');
      expect(_dropdownValue(tester, const Key('subagent-provider')), '');
      // 尾巴挨着 Model，排在 Effort 前面。
      final tailY = tester
          .getTopLeft(find.byKey(const Key('subagent-model')))
          .dy;
      final modelY = tester.getTopLeft(find.text('Model')).dy;
      final effortY = tester.getTopLeft(find.text('Effort')).dy;
      expect(tailY, greaterThan(modelY));
      expect(tailY, lessThan(effortY));
    });

    testWidgets('换线路会换掉不再合法的模型选择', (tester) async {
      await tester.pumpWidget(
        _host(
          const AIConfigSheet(
            cli: SessionCli.claude,
            providers: _subProviders,
            provider: 'p1',
            model: 'model-a',
            effort: 'medium',
            subModel: 'model-b',
          ),
        ),
      );
      expect(_dropdownValue(tester, const Key('subagent-model')), 'model-b');

      await tester.tap(find.byKey(const Key('subagent-provider')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Backup').last);
      await tester.pumpAndSettle();

      // Backup 只有 backup-model，model-b 不在候选里 —— 回到「不设置」而不是
      // 显示一个提交时会换掉的陈旧值。
      expect(_dropdownValue(tester, const Key('subagent-model')), '');
      expect(find.text('不设置'), findsOneWidget);
    });
  });

  testWidgets(
    'CLI switch sheet reports resume state and disables missing CLI',
    (tester) async {
      // The sheet renders every SessionCli.values entry and treats a CLI that
      // is absent from cliAvailability as unavailable unless it is the
      // session's current CLI. Deriving the map from the enum keeps "exactly
      // one disabled row" true when a new CLI is added; a hand-written subset
      // silently marks every omitted CLI unavailable instead.
      final availability = <SessionCli, bool>{
        for (final cli in SessionCli.values) cli: true,
      };
      availability[SessionCli.zcode] = false;
      final config = SessionCliConfig(
        cli: SessionCli.claude,
        cliStates: const {
          SessionCli.codex: SessionCliState(hasNativeSession: true),
        },
        cliAvailability: availability,
      );
      await tester.pumpWidget(_host(CliSwitchSheet(config: config)));

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
