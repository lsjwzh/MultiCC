// 「运行配置」底部面板 —— CLI / 线路 / 模型 / 推理强度 只有这一个入口。
//
// 以前是三处：页头的 CLI 角标开换道面板、AI 配置药丸开 provider/model 面板、
// 面板里再选一次 Auto 池。现在合成一张：顶上 [固定一条][自动挑选] 两段，固定
// 一条里挑 CLI→线路→模型→强度，自动挑选里编排线路池。页头只剩一枚 chip 指向它。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';

import '../../i18n.dart';
import '../../models/message.dart';
import '../../models/provider_limit_label.dart';
import '../../providers/session_manager.dart';
import '../../services/auto_provider_routing.dart';
import '../../services/codex_models_service.dart';
import '../../services/opencode_models_service.dart';
import '../../services/run_pool_service.dart';
import '../../services/settings_service.dart';
import '../../theme.dart';
import '../../utils/cli_display.dart';
import '../../utils/session_status_helpers.dart';
import '../ai_config_sheet.dart' show prepareAIConfigInputs;
import '../provider_option.dart';
import 'run_config_lanes.dart';
import 'run_config_models.dart';
import 'run_config_presets.dart';
import 'run_config_style.dart';
import 'run_config_wire.dart';
import 'run_labels.dart';

part 'run_config_sheet_auto.dart';

/// 面板打开前要备好的东西：会话现在这条车道的 Provider 池 + 车道可用性。
class RunConfigInputs {
  const RunConfigInputs({
    required this.cli,
    required this.providers,
    required this.cliAvailability,
  });

  final SessionCli cli;
  final List<Map<String, dynamic>> providers;
  final Map<SessionCli, bool> cliAvailability;
}

class RunConfigSheet extends StatefulWidget {
  const RunConfigSheet({
    super.key,
    required this.cli,
    required this.providers,
    required this.provider,
    required this.model,
    required this.effort,
    this.providerSelection,
    this.subProviderId,
    this.subModel,
    this.agent,
    this.settings,
    this.httpClient,
    this.cliAvailability = const {},
    this.specs,
    this.sessionId,
  });

  final SessionCli cli;
  final List<Map<String, dynamic>> providers;
  final String provider;
  final String model;
  final String effort;
  final SessionProviderSelection? providerSelection;
  final String? subProviderId;
  final String? subModel;
  final String? agent;
  final SettingsService? settings;
  final http.Client? httpClient;
  final Map<SessionCli, bool> cliAvailability;
  final Map<String, dynamic>? specs;
  final String? sessionId;

  @override
  State<RunConfigSheet> createState() => RunConfigSheetState();
}

/// 面板的全部状态与「固定一条」那半张界面。抽象是为了让 part 里的
/// `RunConfigAutoSection` mixin 能 `on` 它（mixin 不能约束在被混入的类自身上）。
abstract class RunConfigSheetBase extends State<RunConfigSheet> {
  /// 「自动挑选」那半张面板由 part 里的 `RunConfigAutoSection` mixin 提供。
  List<Widget> buildAutoSection();

  RunConfigMode _mode = RunConfigMode.fixed;

  // ── 固定一条 ──────────────────────────────────────────────────────────
  late SessionCli _cli;
  late List<Map<String, dynamic>> _providers;
  late String _provider;
  late String _model;
  late String _effort;
  bool _customModel = false;
  late final TextEditingController _customCtrl;
  String _subProvider = '';
  String _subModel = '';
  bool _customSubModel = false;
  late final TextEditingController _subCustomCtrl;
  late final TextEditingController _agentCtrl;
  bool _advanced = false;

  /// 未安装/用不了的车道默认折在「▸ 未安装的 N 个」底下，点开才铺出来 —— 六条
  /// 装不了的 CLI 不该把一整屏占满。
  bool _showUnavailable = false;

  // ── 自动挑选 ──────────────────────────────────────────────────────────
  final List<RunPoolRow> _rows = [];
  RunPickOrder _order = RunPickOrder.order;
  RunTiering _tiering = RunTiering.jev;
  int _maxAttempts = 2;
  bool _sticky = true;
  bool _autoMore = false;
  String _autoError = '';
  SessionProviderRouting? _seededRouting;
  final RunConfigPresetStore _presetStore = RunConfigPresetStore();
  List<RunConfigPreset> _presets = const [];
  String _presetNotice = '';
  bool _presetNoticeError = false;
  bool _presetBusy = false;

  /// 每条车道各自的 Provider 池：换 CLI、加线路都要现取，取过的留着。
  late final RunPoolService _pool;
  final Map<String, int> _laneCounts = {};
  final Set<String> _countingLanes = {};
  bool _bootstrapped = false;

  @override
  void initState() {
    super.initState();
    _pool = RunPoolService(
      settings: widget.settings,
      httpClient: widget.httpClient,
    );
    _cli = widget.cli;
    _providers = widget.providers;
    _laneCounts[_cli.name] = _providers.length;
    for (final cli in _offeredClis) {
      if (cliFamilyOf(cli.name) == cliFamilyOf(_cli.name)) {
        _laneCounts[cli.name] = _providers.length;
      }
    }
    _seedFixed();
    _agentCtrl = TextEditingController(text: widget.agent ?? '');
    _seedAuto();
    if (widget.providerSelection != null) _mode = RunConfigMode.auto;
    _presetStore.load().then((presets) {
      if (mounted) setState(() => _presets = presets);
    });
  }

  @override
  void dispose() {
    _customCtrl.dispose();
    _subCustomCtrl.dispose();
    _agentCtrl.dispose();
    super.dispose();
  }

  // ── 播种 ──────────────────────────────────────────────────────────────

  void _seedFixed() {
    _provider = widget.cli.supportsProvider ? widget.provider : '';
    if (widget.cli == SessionCli.opencode && _provider.isEmpty) {
      _provider = openCodeNativeProviderForModel(widget.model, _providers);
    }
    // 会话里存的裸 <pool>-official 是服务端指向默认账号的别名；账号登录后
    // 列表里只有按账号拆开的几条，把别名落到默认那条上。
    final aliasMissing =
        _provider == '${widget.cli.poolKey}-official' &&
        !_providers.any((p) => p['id'] == _provider);
    if ((_provider.isEmpty || aliasMissing) && widget.cli.supportsProvider) {
      _provider =
          defaultOfficialProviderId(widget.cli.poolKey, _providers) ??
          _provider;
    }
    _model = _seedModel(_provider, widget.model);
    if (_model.isEmpty) _model = _defaultModelFor(_provider);
    final rungs = effortRungsFor(widget.cli);
    final values = rungs.map((rung) => rung.$1).toList();
    _effort = values.contains(widget.effort) || widget.effort.isEmpty
        ? widget.effort
        : widget.cli.defaultEffort;
    _customModel =
        _model.isNotEmpty && !_choicesFor(_provider).contains(_model);
    _customCtrl = TextEditingController(text: _customModel ? _model : '');
    _subProvider = widget.subProviderId ?? '';
    _subModel = _seedModel(
      _subProvider.isEmpty ? _provider : _subProvider,
      widget.subModel ?? '',
    );
    _customSubModel =
        _subModel.isNotEmpty &&
        !_choicesFor(
          _subProvider.isEmpty ? _provider : _subProvider,
        ).contains(_subModel);
    _subCustomCtrl = TextEditingController(
      text: _customSubModel ? _subModel : '',
    );
  }

  /// 别名中继的模型存的是 tier 名或真模型 id，两种写法都折算到 tier 名上。
  String _seedModel(String provider, String model) {
    if (model.isEmpty) return model;
    for (final p in _providers) {
      if (p['id'] != provider) continue;
      final aliasMap = p['aliasMap'];
      if (aliasMap is! Map) break;
      for (final entry in aliasMap.entries) {
        final value = entry.value;
        if (value is Map && value['model']?.toString() == model) {
          return entry.key.toString();
        }
      }
    }
    return model;
  }

  void _seedAuto() {
    final selection = widget.providerSelection;
    if (selection == null) return;
    _seededRouting = selection.routing;
    _maxAttempts = selection.maxAttempts;
    _sticky = selection.sticky;
    _order = selection.routing != null
        ? RunPickOrder.difficulty
        : RunPickOrder.order;
    // 按价格（或还没配过 Jev 的新池子、以及只有 routing 没有档位的遗留池）
    // 一律落「交给 Jev」——那是这一档的默认；服务端认得的手标池（tiers 非空
    // 且没有 tiering）才落「我自己标」。
    final seeded = selection.routing;
    final legacyManual =
        seeded != null && seeded.tiering != 'price' && seeded.tiers.isNotEmpty;
    _tiering = legacyManual ? RunTiering.manual : RunTiering.jev;
    for (final candidate in selection.candidates) {
      final lane = (candidate.cli ?? '').trim().isEmpty
          ? widget.cli.name
          : candidate.cli!.trim();
      final native = isOpenCodeNativeProvider(candidate.providerId);
      final rung = autoRungFor(candidate, selection.routing?.tiers ?? const []);
      _rows.add(
        RunPoolRow(
          lane: lane,
          providerId: candidate.providerId,
          model: candidate.model ?? '',
          autoModel: candidate.autoModel,
          markedTier: rung > 0 ? rung : null,
          problem: native && lane != 'opencode'
              ? 'OpenCode 原生线路只能跑在 OpenCode 车道上'
              : null,
          sendable: !(native && lane != 'opencode'),
        ),
      );
    }
  }

  // ── 车道目录 ──────────────────────────────────────────────────────────

  /// 只展示当前聊天车道。旧会话保留原 id，但选项按产品家族高亮。
  List<SessionCli> get _offeredClis =>
      SessionCli.values.where((cli) => cliOffersIn(cli.name, 'chat')).toList();

  bool _available(SessionCli cli) =>
      widget.cliAvailability[cli] ??
      (cliFamilyOf(cli.name) == cliFamilyOf(widget.cli.name));

  /// 首帧之后给每张车道卡补「N 条线路」。取不到就空着，不阻塞面板。
  void _bootstrapCounts() {
    if (_bootstrapped) return;
    _bootstrapped = true;
    for (final cli in _offeredClis) {
      if (!_available(cli) || !cli.supportsProvider) continue;
      if (_laneCounts.containsKey(cli.name)) continue;
      _countingLanes.add(cli.name);
      _pool.forCli(cli.name).then((providers) {
        if (!mounted) return;
        setState(() {
          _countingLanes.remove(cli.name);
          if (providers != null) _laneCounts[cli.name] = providers.length;
        });
      });
    }
  }

  List<Map<String, dynamic>> _poolFor(String lane) =>
      _pool.cached(lane) ??
      (cliFamilyOf(lane) == cliFamilyOf(widget.cli.name)
          ? widget.providers
          : const []);

  /// 一条线路在池子里的记录（找不到返回 null = 目录里没有这条）。
  Map<String, dynamic>? _providerMap(String lane, String providerId) {
    for (final p in _poolFor(lane)) {
      if (p['id'] == providerId) return p;
    }
    return null;
  }

  List<String> _choicesFor(String provider) =>
      runModelChoices(_cli, provider, _providers);

  /// 池子里同时有官方线路和用户自管线路吗 —— 相当于 web 的 selectionCrossesTrust
  /// （trust 域有两个就跨域）。混用本来就是这个面板的常态：跨域时不该拦，只是
  /// 服务端要知道「这是用户知情的混合池」，所以这里算出来直接上 wire。
  bool _poolCrossesTrust() {
    var official = false;
    var managed = false;
    for (final row in _rows) {
      if (!row.sendable) continue;
      // 池子里查不到的（OpenCode 原生前缀、目录里已删掉的线路）不计信任域 ——
      // web 的 selectionCrossesTrust 也是这么过滤的。
      final provider = _providerMap(row.lane, row.providerId);
      if (provider == null) continue;
      if (provider['isOfficial'] == true) {
        official = true;
      } else {
        managed = true;
      }
      if (official && managed) return true;
    }
    return false;
  }

  // ── 自动挑选的子任务（和固定一条共用同一份 state 与控件） ────────────────
  //
  // 子任务挂在「主线路」上：自动挑选时主线路就是池子里排第一的那行 —— 和 web
  // 的 subCli()/primaryProviderId() 认的是同一条。主车道不支持子任务（服务端的
  // SUBAGENT_CLIS 一张表）就整块不画、也不上 wire，和固定一条一致。

  String get _autoPrimaryLane => _rows.isEmpty ? '' : _rows.first.lane;

  String get _autoPrimaryProviderId =>
      _rows.isEmpty ? '' : _rows.first.providerId;

  SessionCli? _autoSubCli() {
    if (_rows.isEmpty) return null;
    final cli = tryParseCli(_rows.first.lane);
    return (cli != null && cli.supportsSubagent) ? cli : null;
  }

  /// 子任务线路候选所在的车道池 —— 就是主线路那条车道。
  List<Map<String, dynamic>> _autoSubPool() => _poolFor(_autoPrimaryLane);

  /// 下拉里认得的那条子任务线路。目录里没有的按「随主」处理 —— 和 web 一致
  /// （给 <select> 塞一个不存在的 value，浏览器也会回落成空）。
  String _autoSubProviderId(List<Map<String, dynamic>> pool) =>
      pool.any((p) => p['id']?.toString() == _subProvider) ? _subProvider : '';

  /// 模型候选挂在「子任务线路」上；没选线路（随主）时跟主线路的线路走。
  List<String> _autoSubChoices(
    SessionCli cli,
    List<Map<String, dynamic>> pool,
    String providerId,
  ) => runModelChoices(
    cli,
    providerId.isEmpty ? _autoPrimaryProviderId : providerId,
    pool,
  ).where((m) => m.isNotEmpty).toList();

  /// 界面上那个值折成要保存的模型：自定义手填优先，候选里没有的按「没设置」
  /// 处理（列表里摆不出来的值不该偷偷上 wire）。
  String _autoSubModel(List<String> choices) => _customSubModel
      ? _subCustomCtrl.text.trim()
      : (choices.contains(_subModel) ? _subModel : '');

  /// 自动挑选的子任务设置：主车道支持才返回，模型空 = 不上 wire（跟随主线路）。
  SessionSubagent? _collectAutoSubagent(String mainProvider) {
    final cli = _autoSubCli();
    if (cli == null) return null;
    final pool = _autoSubPool();
    final providerId = _autoSubProviderId(pool);
    return buildSubagent(
      subProviderId: providerId,
      subModel: _autoSubModel(_autoSubChoices(cli, pool, providerId)),
      mainProvider: mainProvider,
    );
  }

  // ── 固定一条：换 CLI / 线路 ────────────────────────────────────────────

  Future<void> _selectCli(SessionCli cli) async {
    if (cli == _cli) return;
    setState(() {
      _cli = cli;
      _provider = '';
      _model = '';
      _effort = cli.defaultEffort;
      _customModel = false;
      _customCtrl.text = '';
      _subProvider = '';
      _subModel = '';
      _customSubModel = false;
      _subCustomCtrl.text = '';
    });
    if (!cli.supportsProvider) return;
    var providers = _pool.cached(cli.name);
    if (providers == null) {
      setState(() => _countingLanes.add(cli.name));
      providers = await _pool.forCli(cli.name) ?? const [];
      if (!mounted) return;
      setState(() => _countingLanes.remove(cli.name));
    }
    if (!mounted || _cli != cli) return;
    setState(() {
      _providers = providers!;
      _laneCounts[cli.name] = providers.length;
      _provider = _seedProviderFor(cli, providers);
      _model = _defaultModelFor(_provider);
    });
  }

  /// 换到一条新车道时的默认线路：官方那条，找不到就用第一条。
  String _seedProviderFor(
    SessionCli cli,
    List<Map<String, dynamic>> providers,
  ) {
    final official = defaultOfficialProviderId(cli.poolKey, providers);
    if (official != null) return official;
    return providers.isEmpty ? '' : (providers.first['id']?.toString() ?? '');
  }

  void _onProviderChanged(String? id) {
    setState(() {
      _provider = id ?? '';
      _customModel = false;
      _customCtrl.text = '';
      _model = _defaultModelFor(_provider);
    });
  }

  /// 换线路之后模型该落在哪儿。这条线路的候选里有空串（「线路默认」）就回它；
  /// 没有空串的（OpenCode 原生线路：模型必须具体到 `<id>/<model>`）落到第一条
  /// —— 下拉里那个值必须是候选里真有的，否则 DropdownButton 直接断言失败。
  String _defaultModelFor(String provider) {
    final choices = _choicesFor(provider);
    if (choices.contains('')) return '';
    return choices.isEmpty ? '' : choices.first;
  }

  // ── 保存 ──────────────────────────────────────────────────────────────

  void _submit() {
    if (_mode == RunConfigMode.fixed) {
      _submitFixed();
    } else {
      _submitAuto();
    }
  }

  void _submitFixed() {
    final native = isOpenCodeNativeProvider(_provider);
    var model = _customModel ? _customCtrl.text.trim() : _model;
    if (native && model.isEmpty) {
      final options = _choicesFor(_provider);
      model = options.isEmpty ? '' : options.first;
    }
    final providerLabel = native
        ? _lineName(_provider)
        : (_provider.isEmpty && _cli == SessionCli.opencode
              ? 'OpenCode 原生配置（全部模型）'
              : providerDisplayLabel(
                  _provider,
                  providers: _providers,
                  model: model,
                ));
    final subModel = _customSubModel ? _subCustomCtrl.text.trim() : _subModel;
    final result = buildFixedOutcome(
      cli: _cli,
      currentCli: widget.cli.name,
      providerId: _provider,
      model: model,
      effort: _effort,
      providerLabel: providerLabel,
      modelLabel: model.isEmpty
          ? '默认'
          : runModelOptionLabel(_cli, _provider, model, _providers),
      subProviderId: _subProvider,
      subModel: subModel,
      includeAgent: _cli.supportsAgent,
      agent: _agentCtrl.text,
    );
    if (!result.ok) {
      setState(() => _autoError = result.error ?? '');
      return;
    }
    Navigator.pop(context, result.outcome);
  }

  void _submitAuto() {
    final result = _autoSelectionResult();
    if (!result.ok) {
      setState(() => _autoError = result.error ?? '');
      return;
    }
    final native = isOpenCodeNativeProvider(result.firstProviderId);
    final provider = native ? '' : result.firstProviderId;
    final firstName = _lineName(result.firstProviderId);
    Navigator.pop(
      context,
      RunConfigOutcome(
        provider: provider,
        model: result.firstModel,
        effort: widget.effort,
        providerLabel:
            'Auto · ${protocolLabelOf(result.protocol)} → $firstName',
        modelLabel: result.firstModel.isEmpty ? '默认' : result.firstModel,
        effortLabel: effortShortNameForCli(widget.cli, widget.effort),
        providerSelection: result.selection,
        subagent: _collectAutoSubagent(provider),
        switchToCli: result.switchToCli,
      ),
    );
  }

  AutoWireResult _autoSelectionResult() {
    // 「我自己标」：没点过档位的行按模型名先猜一次（flash/mini 这类归简单），
    // 和 web 的 syncRungs 同一条规则 —— 不然刚切过来的池子会因为「只有一档」
    // 存不出去。猜不出来的（名字分不出高下）按顺序第一条接简单任务。
    if (_order == RunPickOrder.difficulty && _tiering == RunTiering.manual) {
      final plan = resolveAutoRungs(
        rowTexts: [
          for (final row in _rows)
            '${runLineName(row.providerId, _poolFor(row.lane))}（${row.model}）',
        ],
        chosenRungs: [for (final row in _rows) row.markedTier],
      );
      for (var i = 0; i < _rows.length; i += 1) {
        _rows[i].markedTier ??= plan.rungs[i];
      }
    }
    return buildAutoSelection(
      AutoWireInput(
        sessionLane: widget.cli.name,
        rows: _rows,
        pickOrder: _order,
        tiering: _tiering,
        maxAttempts: _maxAttempts,
        sticky: _sticky,
        allowCrossTrust: _poolCrossesTrust(),
        previousRouting: _seededRouting,
      ),
    );
  }

  // ── 小工具 ────────────────────────────────────────────────────────────

  String _lineName(String providerId) {
    if (isOpenCodeNativeProvider(providerId)) {
      final native = openCodeNativeProviderOf(providerId);
      for (final p in _providers) {
        if (p['id'] == providerId) return p['name']?.toString() ?? native;
      }
      return openCodeNativeProviderDisplayName(native);
    }
    return runLineName(providerId, _providers);
  }

  Widget buildSheet(BuildContext context) {
    _bootstrapCounts();
    final media = MediaQuery.of(context);
    final availableHeight = media.size.height - media.viewInsets.bottom;
    final compactHeader = availableHeight < 440;
    return Material(
      color: AppColors.panel,
      borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
      clipBehavior: Clip.antiAlias,
      child: SafeArea(
        child: Padding(
          padding: EdgeInsets.only(
            bottom: MediaQuery.viewInsetsOf(context).bottom,
          ),
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: availableHeight * 0.9),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (!compactHeader)
                        Center(
                          child: Container(
                            width: 36,
                            height: 4,
                            decoration: BoxDecoration(
                              color: const Color(0xFFdce6f1),
                              borderRadius: BorderRadius.circular(2),
                            ),
                          ),
                        ),
                      if (!compactHeader) const SizedBox(height: 16),
                      const Text(
                        '运行配置',
                        style: TextStyle(
                          color: AppColors.text,
                          fontSize: 20,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      if (!compactHeader) const SizedBox(height: 5),
                      if (!compactHeader)
                        const Text(
                          '选择工具、线路与模型',
                          style: TextStyle(
                            color: AppColors.muted,
                            fontSize: 12,
                          ),
                        ),
                      const SizedBox(height: 18),
                      _modeToggle(),
                    ],
                  ),
                ),
                Flexible(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (_mode == RunConfigMode.fixed)
                          ..._buildFixedSection(),
                        if (_mode == RunConfigMode.auto) ...buildAutoSection(),
                        if (_autoError.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          Text(
                            _autoError,
                            key: const ValueKey('run-config-error'),
                            style: const TextStyle(
                              color: AppColors.danger,
                              fontSize: 12,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
                Container(
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
                  decoration: const BoxDecoration(
                    border: Border(top: BorderSide(color: Color(0xFFe6eef7))),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: TextButton(
                          onPressed: () => Navigator.pop(context),
                          style: TextButton.styleFrom(
                            minimumSize: const Size(0, 46),
                          ),
                          child: const Text('取消'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        flex: 2,
                        child: ElevatedButton(
                          onPressed: _canSubmit ? _submit : null,
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppColors.accent,
                            foregroundColor: Colors.white,
                            minimumSize: const Size(0, 46),
                            elevation: 0,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12),
                            ),
                          ),
                          child: const Text('保存'),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  bool get _canSubmit =>
      _mode == RunConfigMode.fixed ||
      _rows.where((row) => row.sendable).length >= 2;

  Widget _modeToggle() {
    return Row(
      children: [
        Expanded(
          child: _segmentedButton(
            key: const ValueKey('run-mode-fixed'),
            label: '固定一条',
            selected: _mode == RunConfigMode.fixed,
            onTap: () => setState(() {
              _mode = RunConfigMode.fixed;
              _autoError = '';
            }),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: _segmentedButton(
            key: const ValueKey('run-mode-auto'),
            label: '自动挑选',
            selected: _mode == RunConfigMode.auto,
            onTap: () => setState(() {
              _mode = RunConfigMode.auto;
              _autoError = '';
            }),
          ),
        ),
      ],
    );
  }

  // ── 固定一条 ──────────────────────────────────────────────────────────

  List<Widget> _buildFixedSection() {
    // 能用的车道照旧铺开；用不了（没装 / 这个用途不提供）的折进「未安装的 N 个」
    // 底下。会话当前那条哪怕用不了也留在明面上 —— 不然用户找不到自己在用的那条。
    final shown = <SessionCli>[];
    final hidden = <SessionCli>[];
    for (final cli in _offeredClis) {
      if (_available(cli) || cli == _cli) {
        shown.add(cli);
      } else {
        hidden.add(cli);
      }
    }
    return [
      const Text('CLI', style: TextStyle(color: AppColors.faint, fontSize: 12)),
      const SizedBox(height: 6),
      _cliGrid(shown),
      if (hidden.isNotEmpty) _unavailableToggle(hidden.length),
      if (_showUnavailable) _cliGrid(hidden),
      // 自持账号的车道没有 MultiCC 线路池：不画线路下拉，模型/强度照旧（模型候选
      // 来自它自己的目录）。
      if (!_cli.supportsProvider) ...[
        const SizedBox(height: 12),
        Text(
          '使用 ${_cli.displayName} 自己的账号',
          key: const ValueKey('run-providerless-note'),
          style: const TextStyle(color: AppColors.muted, fontSize: 12),
        ),
      ] else ...[
        const SizedBox(height: 14),
        _linePicker(),
      ],
      const SizedBox(height: 12),
      _modelPicker(),
      if (effortRungsFor(_cli).isNotEmpty) ...[
        const SizedBox(height: 12),
        _effortPicker(),
      ],
      _advancedToggle(),
      if (_advanced) ..._advancedSection(),
      const SizedBox(height: 12),
    ];
  }

  Widget _unavailableToggle(int count) {
    return Align(
      alignment: Alignment.centerLeft,
      child: TextButton(
        key: const ValueKey('run-cli-unavailable-toggle'),
        onPressed: () => setState(() => _showUnavailable = !_showUnavailable),
        style: TextButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          minimumSize: const Size(0, 32),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
        child: Text(
          '${_showUnavailable ? '▾' : '▸'} 未安装的 $count 个',
          style: const TextStyle(color: AppColors.muted, fontSize: 12),
        ),
      ),
    );
  }

  /// 车道卡第二行的那句话：能用的说「N 条线路」或「使用 X 自己的账号」，用不了
  /// 的说为什么。
  String _cliCardSubLabel(SessionCli cli, bool available) {
    if (!available) return _unavailableReason(cli);
    if (!cli.supportsProvider) return '使用 ${cli.displayName} 自己的账号';
    final lines = _laneCounts[cli.name];
    if (lines != null) return '$lines 条线路';
    return _countingLanes.contains(cli.name) ? '正在数…' : '没有可用线路';
  }

  Widget _cliGrid(List<SessionCli> clis) => LayoutBuilder(
    builder: (context, constraints) {
      final columns = constraints.maxWidth >= 340 ? 2 : 1;
      final width = (constraints.maxWidth - (columns - 1) * 10) / columns;
      return Wrap(
        spacing: 10,
        runSpacing: 10,
        children: [
          for (final cli in clis) SizedBox(width: width, child: _cliCard(cli)),
        ],
      );
    },
  );

  Widget _cliCard(SessionCli cli) {
    final available = _available(cli);
    final selected = cliFamilyOf(cli.name) == cliFamilyOf(_cli.name);
    final color = cliBrandColor(cli);
    final sub = _cliCardSubLabel(cli, available);
    return Padding(
      padding: EdgeInsets.zero,
      child: InkWell(
        key: Key('run-cli-option-${cli.name}'),
        onTap: available ? () => _selectCli(cli) : null,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
          decoration: BoxDecoration(
            color: selected
                ? color.withValues(alpha: 0.10)
                : const Color(0xFFf4f8fd),
            border: Border.all(
              color: selected
                  ? color.withValues(alpha: 0.65)
                  : const Color(0xFFdce6f1),
            ),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(
            children: [
              SizedBox(
                width: 30,
                height: 30,
                child: Radio<SessionCli>(
                  value: cli,
                  groupValue: selected ? cli : null,
                  onChanged: available
                      ? (value) => _selectCli(value ?? _cli)
                      : null,
                  activeColor: color,
                  materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
              ),
              const SizedBox(width: 4),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      cli.displayName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: available ? AppColors.text : AppColors.faint,
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                        height: 1.25,
                      ),
                    ),
                    if (sub.isNotEmpty)
                      Text(
                        sub,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: available ? AppColors.muted : AppColors.faint,
                          fontSize: 11,
                          height: 1.25,
                        ),
                      ),
                    ..._installDetails(cli),
                  ],
                ),
              ),
              ..._trailing(cli),
            ],
          ),
        ),
      ),
    );
  }

  String _unavailableReason(SessionCli cli) {
    if (cliIsBundled(cli.name)) {
      return '随 MultiCC 一起发布，请升级 MultiCC';
    }
    final spec = _specFor(cli);
    if (spec != null && spec['auto'] != true) {
      final manual = spec['manual'];
      if (manual is String && manual.isNotEmpty) return manual;
    }
    return '未安装';
  }

  Map<String, dynamic>? _specFor(SessionCli cli) {
    final specs = widget.specs;
    if (specs == null || cliIsBundled(cli.name)) return null;
    final spec = specs[cliFamilyOf(cli.name) ?? cli.name];
    return spec is Map<String, dynamic> ? spec : null;
  }

  Widget _linePicker() {
    final ids = _providers.map((p) => p['id']?.toString() ?? '').toSet();
    final includeCurrent = _provider.isNotEmpty && !ids.contains(_provider);
    // 没有官方那条线路时，空串也要有自己的一行：OpenCode 是「原生配置」，
    // 其余车道就是「官方 Provider」。少了这行，_provider 为空时下拉的
    // value 找不到任何 item，DropdownButton 直接断言失败。
    final hasOfficial =
        defaultOfficialProviderId(_cli.poolKey, _providers) != null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          '线路',
          style: TextStyle(color: AppColors.faint, fontSize: 12),
        ),
        const SizedBox(height: 5),
        DropdownButtonFormField<String>(
          value: _provider,
          isExpanded: true,
          dropdownColor: AppColors.panel,
          decoration: runConfigInputDecoration(),
          style: Theme.of(
            context,
          ).textTheme.bodyMedium?.copyWith(color: AppColors.text, fontSize: 13),
          items: [
            if (!hasOfficial)
              DropdownMenuItem(
                value: '',
                child: Text(
                  _cli == SessionCli.opencode
                      ? 'OpenCode 原生配置（全部模型）'
                      : '官方 Provider',
                ),
              ),
            if (includeCurrent)
              DropdownMenuItem(
                value: _provider,
                child: Text(
                  _provider,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ..._providers.map(
              (p) => DropdownMenuItem(
                value: p['id']?.toString() ?? '',
                child: ProviderOption(
                  main:
                      '${p['name'] ?? p['id']}'
                      '${p['model'] != null && p['model'].toString().isNotEmpty ? ' · ${p['model']}' : ''}',
                  detail: providerLimitDetail(p),
                ),
              ),
            ),
          ],
          onChanged: _onProviderChanged,
        ),
      ],
    );
  }

  Widget _modelPicker() {
    final choices = _choicesFor(_provider);
    // 选中的那个值必须是候选里真有的，否则 DropdownButton 直接断言失败。
    final fallback = choices.contains('')
        ? ''
        : (choices.isEmpty ? null : choices.first);
    final value = _customModel
        ? '__custom__'
        : (choices.contains(_model) ? _model : fallback);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          '模型',
          style: TextStyle(color: AppColors.faint, fontSize: 12),
        ),
        const SizedBox(height: 5),
        DropdownButtonFormField<String>(
          value: value,
          isExpanded: true,
          dropdownColor: AppColors.panel,
          decoration: runConfigInputDecoration(),
          style: Theme.of(
            context,
          ).textTheme.bodyMedium?.copyWith(color: AppColors.text, fontSize: 13),
          items: [
            ...choices.map(
              (m) => DropdownMenuItem(
                value: m,
                child: Text(
                  runModelOptionLabel(_cli, _provider, m, _providers),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
            const DropdownMenuItem(value: '__custom__', child: Text('自定义…')),
          ],
          onChanged: (v) => setState(() {
            _customModel = v == '__custom__';
            if (!_customModel) _model = v ?? '';
          }),
        ),
        if (_cli.isCodexFamily &&
            CodexModelsService.cached.diagnosticMessage.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text(
            '${CodexModelsService.cached.diagnosticMessage}'
            '${CodexModelsService.cached.cliVersion.isNotEmpty ? ' · CLI ${CodexModelsService.cached.cliVersion}' : ''}',
            key: const ValueKey('codex-model-diagnostic'),
            style: const TextStyle(
              color: AppColors.faint,
              fontSize: 11,
              height: 1.35,
            ),
          ),
        ],
        if (_customModel) ...[
          const SizedBox(height: 8),
          TextField(
            controller: _customCtrl,
            autofocus: true,
            style: const TextStyle(
              color: AppColors.text,
              fontSize: 13,
              fontFamily: 'monospace',
            ),
            decoration: runConfigInputDecoration(
              hint: _cli.isClaudeFamily ? 'claude-opus-4-8' : '模型 ID',
            ),
          ),
        ],
      ],
    );
  }

  Widget _effortPicker() {
    final rungs = effortRungsFor(_cli);
    final index = effortRungIndexFor(_cli, _effort, rungs);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          '推理强度',
          style: TextStyle(color: AppColors.faint, fontSize: 12),
        ),
        const SizedBox(height: 5),
        Row(
          children: [
            for (var i = 0; i < rungs.length; i += 1) ...[
              if (i > 0) const SizedBox(width: 6),
              Expanded(
                child: _segmentedButton(
                  key: Key('run-effort-${rungs[i].$1}'),
                  label: rungs[i].$2,
                  selected: i == index,
                  onTap: () => setState(() => _effort = rungs[i].$1),
                ),
              ),
            ],
          ],
        ),
      ],
    );
  }

  Widget _advancedToggle() {
    return Align(
      alignment: Alignment.centerLeft,
      child: TextButton(
        key: const ValueKey('run-advanced-toggle'),
        onPressed: () => setState(() => _advanced = !_advanced),
        style: TextButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          minimumSize: const Size(0, 32),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
        child: Text(
          '${_advanced ? '▾' : '▸'} 高级',
          style: const TextStyle(color: AppColors.muted, fontSize: 12),
        ),
      ),
    );
  }

  /// 子任务的「线路 + 模型」两个下拉。固定一条与自动挑选共用同一份 state 和
  /// 同一对控件键，差别只在主线路是谁（固定一条 = 选中的车道；自动挑选 = 池子
  /// 第一条），所以这里都当参数收。
  ///
  /// [providerId] 是折算后认得的子任务线路（空 = 跟随主线路），[choices] 是它
  /// 名下的模型候选，[model] 是折算后可显示也可保存的模型值（候选里没有的按
  /// 「不设置」处理 —— 摆不进下拉的值不该偷偷上 wire）。
  List<Widget> _subagentFields({
    required SessionCli cli,
    required List<Map<String, dynamic>> pool,
    required String providerId,
    required String mainProviderId,
    required List<String> choices,
    required String model,
  }) {
    final labelProvider = providerId.isEmpty ? mainProviderId : providerId;
    final out = <Widget>[
      Row(
        children: [
          const Text(
            '子任务',
            style: TextStyle(
              color: AppColors.text,
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: DropdownButtonFormField<String>(
              key: const Key('run-subagent-provider'),
              value: providerId,
              isExpanded: true,
              dropdownColor: AppColors.panel,
              decoration: runConfigInputDecoration(),
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: AppColors.text,
                fontSize: 13,
              ),
              items: [
                const DropdownMenuItem(value: '', child: Text('随主')),
                ...pool
                    .where(
                      (p) => !(cli.isCodexFamily && p['isOfficial'] == true),
                    )
                    .map(
                      (p) => DropdownMenuItem(
                        value: p['id']?.toString() ?? '',
                        child: ProviderOption(
                          main:
                              '${p['name'] ?? p['id']}'
                              '${p['model'] != null && p['model'].toString().isNotEmpty ? ' · ${p['model']}' : ''}',
                          detail: providerLimitDetail(p),
                        ),
                      ),
                    ),
              ],
              onChanged: (v) => setState(() {
                _subProvider = v ?? '';
                _customSubModel = false;
                _subCustomCtrl.text = '';
                _subModel = '';
              }),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: DropdownButtonFormField<String>(
              key: const Key('run-subagent-model'),
              value: _customSubModel
                  ? '__custom__'
                  : (choices.contains(model) ? model : ''),
              isExpanded: true,
              dropdownColor: AppColors.panel,
              decoration: runConfigInputDecoration(),
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: AppColors.text,
                fontSize: 13,
              ),
              items: [
                const DropdownMenuItem(value: '', child: Text('不设置')),
                ...choices.map(
                  (m) => DropdownMenuItem(
                    value: m,
                    child: Text(
                      runModelOptionLabel(cli, labelProvider, m, pool),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ),
                const DropdownMenuItem(
                  value: '__custom__',
                  child: Text('自定义…'),
                ),
              ],
              onChanged: (v) => setState(() {
                _customSubModel = v == '__custom__';
                if (!_customSubModel) _subModel = v ?? '';
              }),
            ),
          ),
        ],
      ),
    ];
    if (_customSubModel) {
      out.add(const SizedBox(height: 6));
      out.add(
        TextField(
          controller: _subCustomCtrl,
          style: const TextStyle(
            color: AppColors.text,
            fontSize: 13,
            fontFamily: 'monospace',
          ),
          decoration: runConfigInputDecoration(hint: '模型 ID'),
        ),
      );
    }
    return out;
  }

  List<Widget> _advancedSection() {
    final out = <Widget>[];
    if (_cli.supportsSubagent) {
      final subProviderId =
          _providers.any((p) => p['id']?.toString() == _subProvider)
          ? _subProvider
          : '';
      out.addAll(
        _subagentFields(
          cli: _cli,
          pool: _providers,
          providerId: subProviderId,
          mainProviderId: _provider,
          choices: _choicesFor(
            subProviderId.isEmpty ? _provider : subProviderId,
          ).where((m) => m.isNotEmpty).toList(),
          model: _subModel,
        ),
      );
    }
    if (_cli.supportsAgent) {
      out.add(const SizedBox(height: 12));
      out.add(
        Text(
          '${_cli.displayName} Agent',
          style: const TextStyle(
            color: AppColors.text,
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
        ),
      );
      out.add(const SizedBox(height: 5));
      out.add(
        TextField(
          controller: _agentCtrl,
          maxLength: 80,
          style: Theme.of(
            context,
          ).textTheme.bodyMedium?.copyWith(color: AppColors.text, fontSize: 13),
          decoration: runConfigInputDecoration(
            hint: _cli == SessionCli.opencode
                ? '例如 build；留空使用默认 agent'
                : '已定义的 agent 名称；留空使用默认 agent',
          ).copyWith(counterText: ''),
        ),
      );
    }
    return out;
  }

  // ── 安装（未安装的车道角上的按钮）────────────────────────────────────

  final Map<SessionCli, _CliInstallState> _installs = {};

  List<Widget> _trailing(SessionCli cli) {
    final install = _installs[cli];
    if (install != null) {
      if (install.phase == 'installing') {
        return const [
          SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ];
      }
      if (install.phase == 'error') {
        return [_installButton('重试', () => _startInstall(cli))];
      }
      return const [];
    }
    if (!_available(cli)) {
      final spec = _specFor(cli);
      if (spec != null && spec['auto'] == true) {
        return [_installButton('安装', () => _startInstall(cli))];
      }
    }
    return const [];
  }

  List<Widget> _installDetails(SessionCli cli) {
    final install = _installs[cli];
    if (install == null) return const [];
    final out = <Widget>[];
    if (install.phase == 'installing') {
      out.add(_detailText('正在安装…(通常1-2分钟)'));
    } else if (install.phase == 'done') {
      out.add(_detailText('安装完成, 可切换'));
    } else if (install.phase == 'error') {
      out.add(_detailText(install.error ?? '安装失败'));
      if (install.hint != null && install.hint!.isNotEmpty) {
        out.add(_detailText(install.hint!, warn: true));
      }
    }
    return out;
  }

  Widget _detailText(String text, {bool warn = false}) => Padding(
    padding: const EdgeInsets.only(top: 2),
    child: Text(
      text,
      style: TextStyle(
        color: warn ? const Color(0xFFa85a25) : AppColors.muted,
        fontSize: 11,
      ),
    ),
  );

  Widget _installButton(String label, VoidCallback onPressed) => TextButton(
    onPressed: onPressed,
    style: TextButton.styleFrom(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      minimumSize: const Size(40, 28),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    ),
    child: Text(label, style: const TextStyle(fontSize: 12)),
  );

  Future<void> _startInstall(SessionCli cli) async {
    if (_installs[cli]?.phase == 'installing') return;
    _installs[cli]?.timer?.cancel();
    final manager = context.read<SessionManager>();
    setState(() {
      _installs[cli] = _CliInstallState(jobId: '', phase: 'installing');
    });
    try {
      final res = await manager.installCli(cli.name);
      if (!mounted) return;
      final jobId = res['jobId']?.toString();
      if (jobId != null && jobId.isNotEmpty) {
        setState(() {
          _installs[cli] = _CliInstallState(jobId: jobId, phase: 'installing');
        });
        _pollInstall(cli, manager, jobId);
        return;
      }
      final statusCode = res['statusCode'];
      if (statusCode == 200 || res['alreadyInstalled'] == true) {
        await _finishInstall(cli);
      } else {
        final error = res['error']?.toString();
        setState(() {
          _installs[cli] = _CliInstallState(
            jobId: '',
            phase: 'error',
            error: error?.isNotEmpty == true ? error : '安装失败',
            hint: res['hint']?.toString(),
          );
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _installs[cli] = _CliInstallState(
          jobId: '',
          phase: 'error',
          error: '安装失败：$e',
        );
      });
    }
  }

  void _pollInstall(SessionCli cli, SessionManager manager, String jobId) {
    final install = _installs[cli];
    if (install == null) return;
    install.timer = Timer.periodic(const Duration(seconds: 2), (t) async {
      if (!mounted || _installs[cli]?.jobId != jobId) {
        t.cancel();
        return;
      }
      try {
        final res = await manager.fetchCliInstallStatus(jobId);
        if (!mounted || _installs[cli]?.jobId != jobId) {
          t.cancel();
          return;
        }
        final job = res['job'];
        final status = job is Map ? job['status']?.toString() : null;
        if (status == 'done') {
          t.cancel();
          await _finishInstall(cli);
        } else if (status == 'error') {
          t.cancel();
          final error = job is Map ? job['error']?.toString() : null;
          setState(() {
            _installs[cli] = _CliInstallState(
              jobId: jobId,
              phase: 'error',
              error: error?.isNotEmpty == true ? error : '安装失败',
              hint: job is Map ? job['hint']?.toString() : null,
            );
          });
        }
      } catch (_) {
        // 网络抖动不终止安装：下一拍接着问。
      }
    });
  }

  Future<void> _finishInstall(SessionCli cli) async {
    final sessionId = widget.sessionId;
    var available = true;
    if (sessionId != null && sessionId.isNotEmpty) {
      try {
        final fresh = await context
            .read<SessionManager>()
            .fetchSessionCliConfig(sessionId);
        available = fresh.cliAvailability[cli] ?? true;
      } catch (_) {
        available = true;
      }
    }
    if (!mounted) return;
    setState(() {
      _installs[cli] = _CliInstallState(
        jobId: _installs[cli]?.jobId ?? '',
        phase: 'done',
      );
      if (available) {
        final pool = _pool.cached(cli.name);
        if (pool != null) _laneCounts[cli.name] = pool.length;
      }
    });
  }
}

/// 真正的 State：把「固定一条」的状态基类与「自动挑选」的 mixin 拼在一起。
class RunConfigSheetState extends RunConfigSheetBase with RunConfigAutoSection {
  @override
  Widget build(BuildContext context) => buildSheet(context);
}

/// 每张车道卡上的安装进度。`phase` 是 installing / done / error。
class _CliInstallState {
  _CliInstallState({
    required this.jobId,
    required this.phase,
    this.error,
    this.hint,
  });

  final String jobId;
  final String phase;
  final String? error;
  final String? hint;
  Timer? timer;
}

/// 一段式按钮：两个/四个选项里选一个。
Widget _segmentedButton({
  required Key key,
  required String label,
  required bool selected,
  required VoidCallback onTap,
}) {
  return InkWell(
    key: key,
    onTap: onTap,
    borderRadius: BorderRadius.circular(12),
    child: Container(
      alignment: Alignment.center,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: selected
            ? AppColors.accent.withValues(alpha: 0.12)
            : const Color(0xFFf4f8fd),
        border: Border.all(
          color: selected ? AppColors.accent : const Color(0xFFdce6f1),
        ),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: selected ? AppColors.accent : AppColors.muted,
          fontSize: 12.5,
          fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
        ),
      ),
    ),
  );
}

// ── 打开面板 ───────────────────────────────────────────────────────────────

class _RunConfigInputBundle {
  const _RunConfigInputBundle(this.runtime, this.inputs);
  final SessionCliConfig runtime;
  final RunConfigInputs inputs;
}

Future<_RunConfigInputBundle> _loadRunConfigInputs(
  SessionManager manager,
  SettingsService settings,
  String sessionId, {
  http.Client? httpClient,
  SessionCli? cliHint,
}) async {
  // 车道已知时（页头的运行配置胶囊就知道）两个请求并行：会话运行时与该车道的
  // Provider 池互不依赖，经隧道各走一趟往返的话打开就要多等一倍。猜错了（会话
  // 刚在别处换了车道）再按真实车道补取一次。prepareAIConfigInputs 自己吞错，
  // 运行时那一路失败时它不会变成无人接的异常。
  final runtimeFuture = manager.fetchSessionCliConfig(sessionId);
  final hinted = cliHint == null
      ? null
      : prepareAIConfigInputs(settings, cliHint, httpClient: httpClient);
  final runtime = await runtimeFuture;
  final providers = hinted != null && cliHint == runtime.cli
      ? await hinted
      : await prepareAIConfigInputs(
          settings,
          runtime.cli,
          httpClient: httpClient,
        );
  return _RunConfigInputBundle(
    runtime,
    RunConfigInputs(
      cli: runtime.cli,
      providers: providers,
      cliAvailability: runtime.cliAvailability,
    ),
  );
}

/// 路由已挂、数据还在路上的那一帧。
class _RunConfigLoadingShell extends StatelessWidget {
  const _RunConfigLoadingShell();

  @override
  Widget build(BuildContext context) => const SafeArea(
    child: SizedBox(
      key: ValueKey('ai-config-loading'),
      height: 180,
      child: Center(child: CircularProgressIndicator()),
    ),
  );
}

class _RunConfigLoadErrorShell extends StatelessWidget {
  const _RunConfigLoadErrorShell();

  @override
  Widget build(BuildContext context) => SafeArea(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        key: const ValueKey('ai-config-load-error'),
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(t('sessionNotLoaded')),
          const SizedBox(height: 12),
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('关闭'),
          ),
        ],
      ),
    ),
  );
}

class _RunConfigSheetLoader extends StatelessWidget {
  const _RunConfigSheetLoader({
    required this.future,
    this.settings,
    this.httpClient,
  });

  final Future<_RunConfigInputBundle> future;
  final SettingsService? settings;
  final http.Client? httpClient;

  @override
  Widget build(BuildContext context) => FutureBuilder<_RunConfigInputBundle>(
    future: future,
    builder: (context, snapshot) {
      final bundle = snapshot.data;
      if (bundle != null) {
        final runtime = bundle.runtime;
        return RunConfigSheet(
          cli: runtime.cli,
          providers: bundle.inputs.providers,
          cliAvailability: bundle.inputs.cliAvailability,
          provider: runtime.provider ?? '',
          providerSelection: runtime.providerSelection,
          model: runtime.model ?? '',
          effort:
              runtime.effectiveEffort ??
              runtime.effort ??
              runtime.cli.defaultEffort,
          subProviderId: runtime.subagent?.providerId,
          subModel: runtime.subagent?.model,
          agent: runtime.agent,
          settings: settings,
          httpClient: httpClient,
        );
      }
      if (snapshot.hasError) return const _RunConfigLoadErrorShell();
      return const _RunConfigLoadingShell();
    },
  );
}

/// 「先弹窗、里面填数据」的外壳：Provider 池还在路上时先画一枚转圈。Air 那边
/// 给新任务选线路时也用这个。
class RunConfigSheetDeferred extends StatelessWidget {
  const RunConfigSheetDeferred({
    super.key,
    required this.providers,
    required this.builder,
  });

  final Future<List<Map<String, dynamic>>> providers;
  final Widget Function(
    BuildContext context,
    List<Map<String, dynamic>> providers,
  )
  builder;

  @override
  Widget build(BuildContext context) =>
      FutureBuilder<List<Map<String, dynamic>>>(
        future: providers,
        builder: (context, snapshot) {
          final providers = snapshot.data;
          if (providers != null) return builder(context, providers);
          if (snapshot.hasError) return const _RunConfigLoadErrorShell();
          return const _RunConfigLoadingShell();
        },
      );
}

/// 打开某个会话的「运行配置」面板。保存时先按需换车道（固定一条换了 CLI，或自动
/// 挑选的池子里没有会话现在这条车道），再 PATCH provider/model/effort/...
///
/// [cli] 是调用方已知的会话车道（可选），给了就能让打开时的两个请求并行。
Future<void> openRunConfigSheet(
  BuildContext context, {
  required SettingsService settings,
  required String sessionId,
  SessionCli? cli,
  http.Client? httpClient,
}) async {
  final mgr = context.read<SessionManager>();
  final messenger = ScaffoldMessenger.of(context);
  final inputFuture = _loadRunConfigInputs(
    mgr,
    settings,
    sessionId,
    httpClient: httpClient,
    cliHint: cli,
  );
  final picked = await showModalBottomSheet<RunConfigOutcome>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.panel,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (_) => _RunConfigSheetLoader(
      future: inputFuture,
      settings: settings,
      httpClient: httpClient,
    ),
  );
  if (picked == null) return;
  final summary = [picked.providerLabel, picked.modelLabel];
  if (picked.effortLabel.isNotEmpty) summary.add(picked.effortLabel);
  try {
    try {
      await _applyRunConfig(mgr, sessionId, picked);
    } catch (e) {
      // 隧道/移动网络在响应回来之前断开时，服务端多半已经改好了，只是回执丢了。
      // 换车道（同车道是 noop）与 PATCH（整份期望值）都是幂等的，原样再发一次
      // 就能拿到确定结果，不必去猜。
      if (!isTransientNetworkError(e)) rethrow;
      await _applyRunConfig(mgr, sessionId, picked);
    }
    messenger.showSnackBar(
      SnackBar(content: Text('✓ 运行配置已保存：${summary.join(' | ')}，下一轮对话生效')),
    );
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text(runConfigSaveFailureText(e))));
  }
}

Future<void> _applyRunConfig(
  SessionManager mgr,
  String sessionId,
  RunConfigOutcome picked,
) async {
  final lane = picked.switchToCli;
  if (lane != null) {
    final target = tryParseCli(lane);
    if (target != null) {
      await mgr.switchSessionCli(sessionId, target);
    }
  }
  await mgr.updateSessionAIConfig(
    sessionId,
    provider: picked.provider,
    providerSelection: picked.providerSelection,
    model: picked.model,
    effort: picked.effort,
    subagent: picked.subagent,
    agent: picked.agent,
    clearSubagent: picked.subagent == null,
  );
}

/// 连接被中途掐断或等不到响应：请求本身可能已经生效，值得原样重发一次。
/// package:http 把 SocketException/HttpException 都包成 [http.ClientException]。
@visibleForTesting
bool isTransientNetworkError(Object error) =>
    error is TimeoutException || error is http.ClientException;

/// 保存失败时给人看的那一句：不把 `ClientException: Connection closed before
/// full header was received` 这种传输层原文甩给用户。
@visibleForTesting
String runConfigSaveFailureText(Object error) {
  if (isTransientNetworkError(error)) {
    return '运行配置保存失败：网络连接中断，未能确认是否已保存。请稍后重新打开运行配置查看';
  }
  final text = error.toString().replaceFirst(RegExp(r'^Exception:\s*'), '');
  return '运行配置保存失败：$text';
}
