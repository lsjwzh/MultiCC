import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/auto_provider_routing.dart';
import 'package:multicc_app/services/session_service.dart';
import 'package:multicc_app/widgets/run_config/run_config_wire.dart';
import 'package:multicc_app/widgets/run_config/run_labels.dart';

// 面板本身的交互（固定一条 / 自动挑选 / 线路池那一堆控件）在
// test/run_config_sheet_test.dart；这里只钉 wire 契约：DTO 的往返、两份折算层
// 写出来的那份 providerSelection，以及 chip 上那句 Auto 文案。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));

  const selection = SessionProviderSelection(
    protocol: 'anthropic',
    candidates: [
      SessionProviderCandidate(providerId: 'p1', model: 'model-a', priority: 1),
      SessionProviderCandidate(providerId: 'p2', model: 'model-b', priority: 2),
    ],
    maxAttempts: 2,
    sticky: false,
  );

  test('session DTOs parse and preserve the additive Auto selection', () {
    final json = selection.toJson();
    final session = Session.fromJson({
      'id': 'chat-1',
      'kind': 'chat',
      'cli': 'claude',
      'createdAt': '2026-08-25T00:00:00.000Z',
      'provider': 'p1',
      'providerSelection': json,
      'cliStates': {
        'claude': {'provider': 'p1', 'providerSelection': json},
      },
    });
    final config = SessionCliConfig.fromJson({
      'cli': 'claude',
      'provider': 'p1',
      'providerSelection': json,
    });

    expect(session.providerSelection?.protocol, 'anthropic');
    expect(session.providerSelection?.candidates[1].model, 'model-b');
    expect(session.providerSelection?.sticky, isFalse);
    expect(
      session.cliStates[SessionCli.claude]?.providerSelection?.maxAttempts,
      2,
    );
    expect(session.copyWith(label: 'renamed').providerSelection, isNotNull);
    expect(config.providerSelection?.candidates, hasLength(2));
    expect(config.providerSelection?.toJson(), json);
  });

  test('session DTOs preserve explicit mixed-trust authorization', () {
    const mixed = SessionProviderSelection(
      protocol: 'anthropic',
      candidates: [
        SessionProviderCandidate(providerId: 'official', priority: 1),
        SessionProviderCandidate(providerId: 'relay', priority: 2),
      ],
      maxAttempts: 2,
      allowCrossTrust: true,
    );

    final json = mixed.toJson();
    expect(json['allowCrossTrust'], isTrue);
    expect(json['candidates'][0]['model'], isNull);
    expect(parseProviderSelection(json)?.allowCrossTrust, isTrue);
    final legacy = Map<String, dynamic>.from(json)..remove('allowCrossTrust');
    expect(parseProviderSelection(legacy)?.allowCrossTrust, isFalse);
  });

  test('PATCH body sends Auto config and manual save explicitly clears it', () {
    final auto = sessionAIConfigPatchBody(
      provider: 'p1',
      providerSelection: selection,
      model: 'model-a',
      effort: 'medium',
    );
    expect(auto['provider'], 'p1');
    expect(auto['providerSelection'], selection.toJson());

    final manual = sessionAIConfigPatchBody(
      provider: 'p2',
      model: 'model-b',
      effort: 'high',
    );
    expect(manual.containsKey('providerSelection'), isTrue);
    expect(manual['providerSelection'], isNull);
  });

  test('Auto title does not claim the configured primary before routing', () {
    expect(autoProviderRouteLabel('anthropic', null), 'Auto · Anthropic → 待路由');
    expect(
      autoProviderRouteLabel('anthropic', 'Working backup'),
      'Auto · Anthropic → Working backup',
    );
  });

  // ── 难度路由（按难度）同步自 web 的 auto-provider-editor ────────────────────
  // 2026-09-24 web 重写了 Auto 编辑器：多了「按顺序 / 按难度」两种选线路方式、
  // 每行的档位（简单/中等/复杂）、Jev 档位来源。App 这一侧原本只会写顺序池 ——
  // 于是 web 上配好的按难度池被手机打开再保存，routing 就会被静默抹掉，退化成
  // 顺序池。下面这几条把这个坑和新的折算规则都钉住。

  const routedSelection = SessionProviderSelection(
    protocol: 'anthropic',
    candidates: [
      SessionProviderCandidate(
        providerId: 'cheap',
        model: 'glm-4.5-flash',
        priority: 1,
        tier: 't1',
      ),
      SessionProviderCandidate(
        providerId: 'strong',
        model: 'glm-5.2',
        priority: 2,
        tier: 't2',
      ),
    ],
    maxAttempts: 2,
    routing: SessionProviderRouting(
      apiKeyName: 'my-key',
      onUnknown: 'priority',
      tiers: ['t1', 't2'],
      model: 'typesafe-ai/jev',
      timeoutMs: 4000,
      escalation: {'retry': 0.5},
    ),
  );

  test('a difficulty-routed pool survives the trip through the App', () {
    final json = routedSelection.toJson();
    final parsed = parseProviderSelection(json);
    expect(parsed?.routing?.tiers, ['t1', 't2']);
    expect(parsed?.routing?.onUnknown, 'priority');
    expect(parsed?.candidates.first.tier, 't1');
    // 面板不暴露的旋钮原样带回：从手机重新保存不能把 API/网页配好的东西重置。
    expect(parsed?.routing?.model, 'typesafe-ai/jev');
    expect(parsed?.routing?.timeoutMs, 4000);
    expect(parsed?.routing?.escalation, {'retry': 0.5});
    expect(parsed?.routing?.apiKeyName, 'my-key');
    expect(parsed?.toJson(), json);
  });

  test('an unrouted pool still serializes exactly as it always did', () {
    final json = selection.toJson();
    expect(json.containsKey('routing'), isFalse);
    expect((json['candidates'] as List).first, {
      'providerId': 'p1',
      'model': 'model-a',
      'priority': 1,
      'enabled': true,
    });
  });

  // ── 跨 CLI 与按价格：wire 上新长出来的那几个键 ──────────────────────────

  test('a manual pool never grows a lane, a policy or a tiering key', () {
    // 逐字节一致的老契约：这些键在旧池子里一个都不许出现。
    expect(routedSelection.toJson().containsKey('cliSwitch'), isFalse);
    final routing = routedSelection.toJson()['routing'] as Map;
    expect(routing.containsKey('tiering'), isFalse);
    for (final candidate in routedSelection.toJson()['candidates'] as List) {
      expect((candidate as Map).containsKey('cli'), isFalse);
      expect(candidate.containsKey('autoModel'), isFalse);
    }
    final json = routedSelection.toJson();
    expect(parseProviderSelection(json)?.toJson(), json);
  });

  test('a cross-CLI pool keeps its lanes and its switch policy', () {
    final json = <String, dynamic>{
      'version': 1,
      'mode': 'auto',
      'protocol': 'anthropic',
      'candidates': [
        {
          'providerId': 'relay',
          'model': 'glm-5.2',
          'priority': 1,
          'enabled': true,
          'cli': 'claude',
        },
        {
          // 同一条线路挂两条车道是合法的（Anthropic 格式的 key 两边都能用），
          // App 按 providerId 折叠就会在这里悄悄少一条。
          'providerId': 'relay',
          'model': 'glm-5.2',
          'priority': 2,
          'enabled': true,
          'cli': 'opencode',
        },
      ],
      'maxAttempts': 2,
      'sticky': true,
      'allowCrossTrust': false,
      'cliSwitch': 'routing',
    };
    final parsed = parseProviderSelection(json);
    expect(parsed?.isCrossCli, isTrue);
    expect(parsed?.cliSwitch, 'routing');
    expect(parsed?.candidates.map((candidate) => candidate.cli), [
      'claude',
      'opencode',
    ]);
    expect(parsed?.toJson(), json);
  });

  test('a price-tiered pool keeps tiering and its automatic model lines', () {
    final json = <String, dynamic>{
      'version': 1,
      'mode': 'auto',
      'protocol': 'anthropic',
      'candidates': [
        {
          'providerId': 'relay',
          'model': 'glm-5.2',
          'priority': 1,
          'enabled': true,
          'cli': 'claude',
        },
        // autoModel 的行没有 model：服务端不接受两个答案同时存在。
        {
          'providerId': 'cheap',
          'model': null,
          'priority': 2,
          'enabled': true,
          'cli': 'opencode',
          'autoModel': true,
        },
      ],
      'maxAttempts': 2,
      'sticky': true,
      'allowCrossTrust': false,
      'cliSwitch': 'failover',
      'routing': {
        'version': 1,
        'provider': 'jev',
        'apiKeyName': 'vercel-api-key',
        'onUnknown': 'strong',
        'tiering': 'price',
        'tiers': <String>[],
        'model': 'typesafe-ai/jev',
      },
    };
    final parsed = parseProviderSelection(json);
    expect(parsed?.routing?.priceTiered, isTrue);
    expect(parsed?.routing?.tiers, isEmpty);
    expect(parsed?.candidates.last.autoModel, isTrue);
    expect(parsed?.candidates.first.autoModel, isFalse);
    expect(parsed?.toJson(), json);
  });

  test('a value this build has never seen is carried, not dropped', () {
    final json = <String, dynamic>{
      'version': 1,
      'mode': 'auto',
      'protocol': 'anthropic',
      'candidates': [
        {
          'providerId': 'relay',
          'model': 'glm-5.2',
          'priority': 1,
          'enabled': true,
          'cli': 'kimi',
        },
        {
          'providerId': 'other',
          'model': 'glm-5.2',
          'priority': 2,
          'enabled': true,
          'cli': 'acme-lane',
        },
      ],
      'maxAttempts': 2,
      'sticky': true,
      'allowCrossTrust': false,
      'cliSwitch': 'eager',
      'routing': {
        'version': 1,
        'provider': 'jev',
        'apiKeyName': 'k',
        'tiering': 'latency',
        'tiers': <String>[],
      },
    };
    final parsed = parseProviderSelection(json);
    expect(parsed?.cliSwitch, 'eager');
    expect(parsed?.candidates.last.cli, 'acme-lane');
    expect(parsed?.routing?.tiering, 'latency');
    expect(parsed?.routing?.priceTiered, isFalse);
    expect(parsed?.toJson(), json);
  });

  test('the price ladder is written with no hand-tagged tier', () {
    const routes = [
      AutoRoutedRoute(providerId: 'a', model: 'x', priority: 1, rung: 1),
      AutoRoutedRoute(providerId: 'b', model: 'y', priority: 2, rung: 2),
    ];
    const previous = SessionProviderRouting(
      apiKeyName: 'my-key',
      tiers: ['t1', 't2'],
      model: 'typesafe-ai/jev',
      timeoutMs: 4000,
      escalation: {'minConfidence': 0.5},
    );
    final result = serializeAutoRouting(
      routes: routes,
      onUnknown: 'strong',
      previous: previous,
      tiering: 'price',
    );
    expect(result.ok, isTrue);
    expect(result.routing?.tiering, 'price');
    expect(result.routing?.tiers, isEmpty);
    expect(result.candidates.map((candidate) => candidate.tier), [null, null]);
    // 面板不暴露的旋钮照旧原样带回。
    expect(result.routing?.model, 'typesafe-ai/jev');
    expect(result.routing?.timeoutMs, 4000);
    expect(result.routing?.escalation, {'minConfidence': 0.5});
    expect(result.routing?.apiKeyName, 'my-key');
    // 换回手动标注：`tiering` 这个键不写（缺省就是手动），梯子照旧由 rung 折算。
    final manual = serializeAutoRouting(
      routes: routes,
      onUnknown: 'strong',
      previous: previous,
      tiering: 'manual',
    );
    expect(manual.routing?.toJson().containsKey('tiering'), isFalse);
    expect(manual.routing?.tiers, ['t1', 't2']);
    expect(manual.candidates.map((candidate) => candidate.tier), ['t1', 't2']);
  });

  test('rungs compact into a ladder the server accepts', () {
    const routes = [
      AutoRoutedRoute(providerId: 'a', model: null, priority: 1, rung: 1),
      AutoRoutedRoute(providerId: 'b', model: null, priority: 2, rung: 1),
      AutoRoutedRoute(providerId: 'c', model: null, priority: 3, rung: 3),
    ];
    final result = serializeAutoRouting(routes: routes, onUnknown: 'weak');
    expect(result.ok, isTrue);
    // 只有顺序有意义：1/1/3 折算成 t1/t1/t2，用户不用自己补齐空档。
    expect(result.routing?.tiers, ['t1', 't2']);
    expect(
      result.candidates.map((candidate) => candidate.tier),
      ['t1', 't1', 't2'],
    );
    expect(result.routing?.onUnknown, 'weak');
    // 没有旧块、又选了服务端默认值时，onUnknown 不落 wire。
    final plain = serializeAutoRouting(routes: routes, onUnknown: 'strong');
    expect(plain.routing?.toJson().containsKey('onUnknown'), isFalse);

    final oneTier = serializeAutoRouting(
      routes: const [
        AutoRoutedRoute(providerId: 'a', model: null, priority: 1, rung: 2),
        AutoRoutedRoute(providerId: 'b', model: null, priority: 2, rung: 2),
      ],
      onUnknown: 'strong',
    );
    expect(oneTier.ok, isFalse);
    expect(oneTier.code, 'provider_routing_requires_tiers');
  });

  test('an untouched row is guessed from its model name, a picked one is not', () {
    final plan = resolveAutoRungs(
      rowTexts: const ['便宜线（glm-4.5-flash）', '主力线（glm-5.2）'],
      chosenRungs: const [null, null],
    );
    expect(plan.ceiling, 2);
    expect(plan.rungs, [1, 2], reason: 'flash 归简单，强模型归复杂');
    // 手点过的档位不被重猜覆盖（web 的 dataset.rung vs dataset.value）。
    final picked = resolveAutoRungs(
      rowTexts: const ['便宜线（glm-4.5-flash）', '主力线（glm-5.2）'],
      chosenRungs: const [2, null],
    );
    expect(picked.rungs, [2, 2]);
    // 名字分不出高下时，第一条按顺序接简单任务（绝不是单档池）。
    final blind = resolveAutoRungs(
      rowTexts: const ['甲', '乙'],
      chosenRungs: const [null, null],
    );
    expect(blind.rungs, [1, 2]);
  });

  // ── 面板的折算层（run_config_wire）──────────────────────────────────────

  test('固定一条：换车道时带回 switchToCli，原生线路 provider 留空', () {
    final same = buildFixedOutcome(
      cli: SessionCli.claude,
      currentCli: 'claude',
      providerId: 'p1',
      model: 'claude-opus-5',
      effort: 'high',
      providerLabel: 'Zhipu',
      modelLabel: 'claude-opus-5',
      subProviderId: null,
      subModel: null,
      includeAgent: true,
      agent: 'build',
    );
    expect(same.ok, isTrue);
    expect(same.outcome?.provider, 'p1');
    expect(same.outcome?.model, 'claude-opus-5');
    expect(same.outcome?.switchToCli, isNull);
    expect(same.outcome?.agent, 'build');

    // 面板上换了车道：保存前要先 switch-cli。
    final moved = buildFixedOutcome(
      cli: SessionCli.codex,
      currentCli: 'claude',
      providerId: 'p1',
      model: '',
      effort: 'medium',
      providerLabel: '官方',
      modelLabel: '默认',
      subProviderId: null,
      subModel: null,
      includeAgent: false,
      agent: null,
    );
    expect(moved.outcome?.switchToCli, 'codex');
    expect(moved.outcome?.agent, isNull);

    // OpenCode 原生线路：provider 留空，`<id>/<model>` 整个进 model。
    final native = buildFixedOutcome(
      cli: SessionCli.opencode,
      currentCli: 'opencode',
      providerId: 'opencode-native:opencodego',
      model: 'opencodego/kimi-k2',
      effort: '',
      providerLabel: 'OpenCode Go',
      modelLabel: 'kimi-k2',
      subProviderId: null,
      subModel: null,
      includeAgent: false,
      agent: null,
    );
    expect(native.outcome?.provider, '');
    expect(native.outcome?.model, 'opencodego/kimi-k2');
  });

  test('子任务尾巴：只挑线路不挑模型 = 没设', () {
    expect(
      buildSubagent(subProviderId: 'p2', subModel: 'm2', mainProvider: 'p1'),
      isA<SessionSubagent>()
          .having((s) => s.providerId, 'providerId', 'p2')
          .having((s) => s.model, 'model', 'm2'),
    );
    expect(
      buildSubagent(subProviderId: 'p2', subModel: '  ', mainProvider: 'p1'),
      isNull,
    );
    // 线路留空 = 跟着主线路走。
    expect(
      buildSubagent(subProviderId: '', subModel: 'm2', mainProvider: 'p1')
          ?.providerId,
      'p1',
    );
  });

  RunPoolRow row(String lane, String id, {String model = ''}) =>
      RunPoolRow(lane: lane, providerId: id, model: model);

  test('自动挑选 · 按顺序：cliSwitch failover，每条候选都带 cli', () {
    final result = buildAutoSelection(
      AutoWireInput(
        sessionLane: 'claude',
        rows: [row('claude', 'p1', model: 'model-a'), row('claude', 'p2')],
        pickOrder: RunPickOrder.order,
        tiering: RunTiering.jev,
        maxAttempts: 2,
        sticky: false,
        allowCrossTrust: false,
        previousRouting: null,
      ),
    );
    expect(result.ok, isTrue);
    final json = result.selection!.toJson();
    expect(json['cliSwitch'], 'failover');
    expect(json.containsKey('routing'), isFalse);
    for (final candidate in json['candidates'] as List) {
      expect((candidate as Map)['cli'], 'claude');
      expect(candidate.containsKey('autoModel'), isFalse);
      expect(candidate.containsKey('tier'), isFalse);
    }
    expect(result.protocol, 'anthropic');
    expect(result.firstProviderId, 'p1');
    expect(result.firstModel, 'model-a');
    expect(result.switchToCli, isNull);
  });

  test('自动挑选 · 按难度 · 交给 Jev：写价格档，候选不带 tier', () {
    final result = buildAutoSelection(
      AutoWireInput(
        sessionLane: 'claude',
        rows: [
          row('claude', 'p1', model: 'model-a'),
          row('opencode', 'cheap')..autoModel = true,
        ],
        pickOrder: RunPickOrder.difficulty,
        tiering: RunTiering.jev,
        maxAttempts: 2,
        sticky: true,
        allowCrossTrust: true,
        previousRouting: const SessionProviderRouting(
          model: 'typesafe-ai/jev',
          timeoutMs: 4000,
        ),
      ),
    );
    expect(result.ok, isTrue);
    final json = result.selection!.toJson();
    expect(json['cliSwitch'], 'routing');
    final routing = json['routing'] as Map;
    expect(routing['provider'], 'jev');
    expect(routing['tiering'], 'price');
    expect(routing['tiers'], isEmpty);
    // 面板不暴露的旋钮照旧带回。
    expect(routing['model'], 'typesafe-ai/jev');
    expect(routing['timeoutMs'], 4000);
    final candidates = json['candidates'] as List;
    expect((candidates[0] as Map)['tier'], isNull);
    expect((candidates[1] as Map)['autoModel'], isTrue);
    expect((candidates[1] as Map)['model'], isNull);
    expect((candidates[1] as Map)['cli'], 'opencode');
    // 池子第一条在别的车道上 → 保存前要先换道。
    expect(result.switchToCli, isNull, reason: '第一条还在 claude 上，不用换');

    final other = buildAutoSelection(
      AutoWireInput(
        sessionLane: 'claude',
        rows: [row('opencode', 'cheap'), row('opencode', 'cheap2')],
        pickOrder: RunPickOrder.order,
        tiering: RunTiering.jev,
        maxAttempts: 2,
        sticky: true,
        allowCrossTrust: false,
        previousRouting: null,
      ),
    );
    expect(other.switchToCli, 'opencode');
    expect(other.protocol, 'anthropic', reason: '全是 opencode 车道 → 协议无关的中性默认');
  });

  test('自动挑选 · 按难度 · 我自己标：档位从 rung 折成 t1..tK', () {
    final result = buildAutoSelection(
      AutoWireInput(
        sessionLane: 'claude',
        rows: [
          row('claude', 'cheap', model: 'glm-4.5-flash')..markedTier = 1,
          row('claude', 'strong', model: 'glm-5.2')..markedTier = 3,
        ],
        pickOrder: RunPickOrder.difficulty,
        tiering: RunTiering.manual,
        maxAttempts: 2,
        sticky: true,
        allowCrossTrust: false,
        previousRouting: null,
      ),
    );
    expect(result.ok, isTrue);
    final routing = result.selection!.toJson()['routing'] as Map;
    expect(routing.containsKey('tiering'), isFalse, reason: '缺省就是手动');
    expect(routing['tiers'], ['t1', 't2']);
    expect(
      result.selection!.candidates.map((candidate) => candidate.tier),
      ['t1', 't2'],
    );

    // 同一个档两条线 = 单档池，服务端不收，面板也要拦。
    final oneTier = buildAutoSelection(
      AutoWireInput(
        sessionLane: 'claude',
        rows: [
          row('claude', 'a')..markedTier = 2,
          row('claude', 'b')..markedTier = 2,
        ],
        pickOrder: RunPickOrder.difficulty,
        tiering: RunTiering.manual,
        maxAttempts: 2,
        sticky: true,
        allowCrossTrust: false,
        previousRouting: null,
      ),
    );
    expect(oneTier.ok, isFalse);
    expect(oneTier.code, 'provider_routing_requires_tiers');
  });

  test('自动挑选：有效行不足两条存不出去，maxAttempts 也不能超过池子', () {
    final tooFew = buildAutoSelection(
      AutoWireInput(
        sessionLane: 'claude',
        rows: [row('claude', 'p1'), row('claude', 'p2')..sendable = false],
        pickOrder: RunPickOrder.order,
        tiering: RunTiering.jev,
        maxAttempts: 2,
        sticky: true,
        allowCrossTrust: false,
        previousRouting: null,
      ),
    );
    expect(tooFew.ok, isFalse);
    expect(tooFew.error, '至少要有两条能用的线路');

    final clamped = buildAutoSelection(
      AutoWireInput(
        sessionLane: 'claude',
        rows: [row('claude', 'p1'), row('claude', 'p2')],
        pickOrder: RunPickOrder.order,
        tiering: RunTiering.jev,
        maxAttempts: 4,
        sticky: true,
        allowCrossTrust: false,
        previousRouting: null,
      ),
    );
    expect(clamped.selection?.maxAttempts, 2);
  });
}
