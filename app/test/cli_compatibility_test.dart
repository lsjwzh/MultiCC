import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/utils/cli_display.dart';
import 'package:multicc_app/widgets/run_config/run_config_sheet.dart';
import 'package:multicc_app/widgets/run_config/run_config_wire.dart';

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(body: SizedBox(width: 360, height: 740, child: child)),
);

RunConfigSheet _configSheet(SessionCli cli) => RunConfigSheet(
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

/// 开面板 → 展开「▸ 高级」（子任务那一行在里面）→ 点保存 → 把结果交回来。
Future<RunConfigOutcome?> _saveSheet(
  WidgetTester tester, {
  List<Map<String, dynamic>> providers = _subProviders,
  String provider = 'p1',
  String? subProviderId,
  String? subModel,
}) async {
  RunConfigOutcome? result;
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => ElevatedButton(
            key: const Key('open-ai-config'),
            onPressed: () async {
              result = await showModalBottomSheet<RunConfigOutcome>(
                context: context,
                isScrollControlled: true,
                builder: (_) => RunConfigSheet(
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
  final toggle = find.byKey(const Key('run-advanced-toggle'));
  await tester.ensureVisible(toggle);
  await tester.pumpAndSettle();
  await tester.tap(toggle);
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
      // 显示名跟产品走：扶正后的常驻 SDK 车道是 "Claude"，终端那条 `claude -p`
      // 用的也是同一个产品名（区别在小字：Claude Agent SDK / claude -p），三端一致
      // 性见 tests/test-cli-display-parity.js）。
      expect(SessionCli.claudeExp.displayName, 'Claude');
      expect(SessionCli.claude.displayName, 'Claude');
      // 小字写它底下的引擎，不写内部 id。
      expect(cliEngine(SessionCli.claudeExp.name), 'Claude Agent SDK');
      expect(cliEngine(SessionCli.codexExp.name), 'Codex App Server');

      // 显示名同样跟产品走：扶正后的常驻车道 codex-exp 叫 Codex，兜底的 codex exec
      // （内部 id codex）也叫 Codex，并被标成计划淘汰 —— 选择器靠 [isDeprecatedLane]
      // 说出那句「兜底线路，计划淘汰 · Codex」。
      expect(SessionCli.codexExp.displayName, 'Codex');
      expect(SessionCli.codex.displayName, 'Codex');
      expect(SessionCli.codex.isDeprecatedLane, isTrue);
      expect(SessionCli.codex.replacedByLane, SessionCli.codexExp);
      for (final cli in SessionCli.values.where((c) => c != SessionCli.codex)) {
        expect(cli.isDeprecatedLane, isFalse, reason: '${cli.name} is not on the way out');
        expect(cli.replacedByLane, isNull);
      }

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
    /// 面板上那条「强度」选择器 —— 键写的是**存下去的**值（low/medium/…）。
    /// 字段名在这张面板里统一是中文「推理强度」（Web 也是这么写的）；
    /// 车道自己的英文叫法（Effort / Reasoning Level / Variant）留给别的界面。
    Future<void> openAdvanced(WidgetTester tester) async {
      final toggle = find.byKey(const Key('run-advanced-toggle'));
      await tester.ensureVisible(toggle);
      await tester.pumpAndSettle();
      await tester.tap(toggle);
      await tester.pumpAndSettle();
    }

    testWidgets('Claude shows native agent and subagent routing', (
      tester,
    ) async {
      await tester.pumpWidget(_host(_configSheet(SessionCli.claude)));
      expect(find.text('运行配置'), findsOneWidget);
      expect(find.text('推理强度'), findsOneWidget);
      expect(find.byKey(const Key('run-effort-medium')), findsOneWidget);
      // 子任务与原生 Agent 都在「▸ 高级」底下。
      expect(find.text('子任务'), findsNothing);
      await openAdvanced(tester);
      expect(find.text('子任务'), findsOneWidget);
      expect(find.text('Claude Agent'), findsOneWidget);
      expect(find.byKey(const Key('run-subagent-provider')), findsOneWidget);
    });

    testWidgets('Codex shows subagent routing without native agent', (
      tester,
    ) async {
      await tester.pumpWidget(_host(_configSheet(SessionCli.codexExp)));
      expect(find.text('推理强度'), findsOneWidget);
      await openAdvanced(tester);
      expect(find.text('子任务'), findsOneWidget);
      expect(find.text('Codex Agent'), findsNothing);
    });

    testWidgets('OpenCode shows native agent and Variant only', (tester) async {
      await tester.pumpWidget(_host(_configSheet(SessionCli.opencode)));
      expect(find.text('推理强度'), findsOneWidget);
      await openAdvanced(tester);
      expect(find.text('子任务'), findsNothing);
      expect(find.text('OpenCode Agent'), findsOneWidget);
    });

    testWidgets('ZCode hides unsupported controls', (tester) async {
      await tester.pumpWidget(_host(_configSheet(SessionCli.zcode)));
      expect(find.text('推理强度'), findsNothing);
      await openAdvanced(tester);
      expect(find.text('子任务'), findsNothing);
      // 面板上别的车道的卡片会写「Claude Agent SDK」，所以这里钉的是自己那几行。
      expect(find.text('ZCode Agent'), findsNothing);
      expect(find.text('OpenCode Agent'), findsNothing);
    });

    testWidgets(
      'Qoder uses its own account and exposes effort and agent',
      (tester) async {
        await tester.pumpWidget(_host(_configSheet(SessionCli.qoder)));
        // 没有 MultiCC 线路池：面板只说「用你自己的账号」，不画线路下拉。
        expect(find.byKey(const Key('run-providerless-note')), findsOneWidget);
        expect(find.text('使用 Qoder CN 自己的账号'), findsNWidgets(2));
        expect(find.text('推理强度'), findsOneWidget);
        await openAdvanced(tester);
        expect(find.text('Qoder CN Agent'), findsOneWidget);
        expect(find.text('子任务'), findsNothing);
      },
    );
  });

  group('子任务尾巴（线路 + 模型一行）', () {
    /// 面板比测试窗口高，「▸ 高级」在下面，得先滚到它。
    Future<void> advance(WidgetTester tester) async {
      final toggle = find.byKey(const Key('run-advanced-toggle'));
      await tester.ensureVisible(toggle);
      await tester.pumpAndSettle();
      await tester.tap(toggle);
      await tester.pumpAndSettle();
    }

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

    testWidgets('尾巴就在模型后面，一行放下子任务的线路和模型', (tester) async {
      await tester.pumpWidget(
        _host(
          const RunConfigSheet(
            cli: SessionCli.claude,
            providers: _subProviders,
            provider: 'p1',
            model: 'model-a',
            effort: 'medium',
            subProviderId: '',
            subModel: 'model-b',
          ),
        ),
      );
      await advance(tester);
      // 存下来的子任务（线路留空 + 主线路上的模型）得原样回填，不能被当成
      // 「自定义 ID」—— 别名折算和候选判定都按生效线路走才对得上。
      expect(_dropdownValue(tester, const Key('run-subagent-model')), 'model-b');
      expect(_dropdownValue(tester, const Key('run-subagent-provider')), '');
      // 顺序：模型 → 强度 → ▸ 高级（尾巴在这里面）。
      final tailY = tester
          .getTopLeft(find.byKey(const Key('run-subagent-model')))
          .dy;
      final modelY = tester
          .getTopLeft(find.byType(DropdownButtonFormField<String>).at(1))
          .dy;
      final effortY = tester.getTopLeft(find.text('推理强度')).dy;
      expect(effortY, greaterThan(modelY));
      expect(tailY, greaterThan(effortY));
    });

    testWidgets('换线路会换掉不再合法的模型选择', (tester) async {
      await tester.pumpWidget(
        _host(
          const RunConfigSheet(
            cli: SessionCli.claude,
            providers: _subProviders,
            provider: 'p1',
            model: 'model-a',
            effort: 'medium',
            subProviderId: '',
            subModel: 'model-b',
          ),
        ),
      );
      await advance(tester);
      expect(_dropdownValue(tester, const Key('run-subagent-model')), 'model-b');

      await tester.tap(find.byKey(const Key('run-subagent-provider')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Backup').last);
      await tester.pumpAndSettle();

      // Backup 只有 backup-model，model-b 不在候选里 —— 回到「不设置」而不是
      // 显示一个提交时会换掉的陈旧值。
      expect(_dropdownValue(tester, const Key('run-subagent-model')), '');
      expect(find.text('不设置'), findsOneWidget);
    });
  });

  testWidgets(
    '固定一条：chat 能跑的车道才在表里，缺的车道灰着不能点',
    (tester) async {
      // 表里画的是能跑 chat 的衍生车道（服务端 `kinds` 那一列）加上会话自己现在
      // 这条；cliAvailability 里没有的车道一律当不可用，除非它就是当前车道。
      // 从枚举推这张表，「正好一行灰着」在新增 CLI 之后也还成立；手写子集会把
      // 漏掉的 CLI 全标成不可用。
      final availability = <SessionCli, bool>{
        for (final cli in SessionCli.values) cli: true,
      };
      availability[SessionCli.zcode] = false;
      await tester.pumpWidget(
        _host(
          RunConfigSheet(
            cli: SessionCli.claude,
            providers: const [],
            provider: '',
            model: '',
            effort: SessionCli.claude.defaultEffort,
            cliAvailability: availability,
          ),
        ),
      );

      // 一次性车道（`claude -p` / `codex exec`）退出 chat：codex 不是当前车道，
      // 就不该出现在这张表里；claude 是当前车道，所以留着 —— 跑在旧线路上的
      // 会话要能找到自己在哪。
      expect(find.byKey(const Key('run-cli-option-codex')), findsNothing);
      expect(find.byKey(const Key('run-cli-option-claude')), findsOneWidget);
      expect(find.byKey(const Key('run-cli-option-codex-exp')), findsOneWidget);

      // 用不了的车道默认折在「未安装的 N 个」底下，先点开。
      expect(find.byKey(const Key('run-cli-option-zcode')), findsNothing);
      await tester.tap(find.byKey(const Key('run-cli-unavailable-toggle')));
      await tester.pumpAndSettle();

      // 缺的车道灰着：整行点不动（Radio 也一起禁用）。
      final zcode = tester.widget<InkWell>(
        find.byKey(const Key('run-cli-option-zcode')),
      );
      expect(zcode.onTap, isNull);
      expect(find.text('未安装'), findsWidgets);
    },
  );
}
