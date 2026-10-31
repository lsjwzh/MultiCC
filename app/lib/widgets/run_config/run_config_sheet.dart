// 「运行配置」底部面板 —— CLI / 线路 / 模型 / 推理强度 只有这一个入口。
//
// 以前是三处：页头的 CLI 角标开换道面板、AI 配置药丸开 provider/model 面板、
// 面板里再选一次 Auto 池。现在合成一张：顶上 [固定一条][自动挑选] 两段，固定
// 一条里挑 CLI→线路→模型→强度，自动挑选里编排线路池。页头只剩一枚 chip 指向它。
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../i18n.dart';
import '../../models/message.dart';
import '../../models/provider_limit_label.dart';
import '../../providers/session_manager.dart';
import '../../services/auto_provider_routing.dart';
import '../../services/codebuddy_models_service.dart';
import '../../services/commandcode_grok_models_service.dart';
import '../../services/codex_models_service.dart';
import '../../services/opencode_models_service.dart';
import '../../services/qoder_models_service.dart';
import '../../services/run_pool_service.dart';
import '../../services/settings_service.dart';
import '../../services/subagent_defaults_service.dart';
import '../../theme.dart';
import '../../utils/cli_display.dart';
import '../../utils/session_status_helpers.dart';
import '../ai_config_sheet.dart' show prepareAIConfigInputs;
import '../model_menu.dart';
import '../provider_option.dart';
import 'run_config_lanes.dart';
import 'run_config_models.dart';
import 'run_config_presets.dart';
import 'run_config_style.dart';
import 'run_config_wire.dart';
import 'run_labels.dart';

part 'run_config_sheet_auto.dart';

/// 首次打开面板时那张「子 agent 可以单独选线路」强引导的持久化标记。关掉之后
/// 不再出现；没有这个 key = 还没看过。
const String runConfigSubagentGuideKey = 'run_config_subagent_guide_v1';

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
    this.subInherited = false,
    this.agent,
    this.settings,
    this.httpClient,
    this.cliAvailability = const {},
    this.specs,
    this.sessionId,
    this.draft = false,
  });

  final SessionCli cli;
  final List<Map<String, dynamic>> providers;
  final String provider;
  final String model;
  final String effort;
  final SessionProviderSelection? providerSelection;
  final String? subProviderId;
  final String? subModel;

  /// [subProviderId] / [subModel] 那条线路是「家族全局默认」自动套上的（服务端
  /// session.subagent.inherited），不是任务自己单独设的。
  final bool subInherited;
  final String? agent;
  final SettingsService? settings;
  final http.Client? httpClient;
  final Map<SessionCli, bool> cliAvailability;
  final Map<String, dynamic>? specs;
  final String? sessionId;

  /// 新任务 / 草稿（任务还没创建）。这类面板没有服务端会话可写，所以：
  /// ① 家里有「子 agent 家族默认」时先把它选上；② 用户明确选「随主」要记下来，
  /// 创建请求得发 `subagent: null` 顶掉默认。会话面板不看这个标记。
  final bool draft;

  @override
  State<RunConfigSheet> createState() => RunConfigSheetState();
}

/// 面板的全部状态与「固定一条」那半张界面。抽象是为了让 part 里的
/// `RunConfigAutoSection` mixin 能 `on` 它（mixin 不能约束在被混入的类自身上）。
abstract class RunConfigSheetBase extends State<RunConfigSheet>
    with SingleTickerProviderStateMixin {
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
  String _modelFilter = '';
  late final TextEditingController _customCtrl;
  String _subProvider = '';
  String _subModel = '';
  bool _customSubModel = false;
  late final TextEditingController _subCustomCtrl;
  late final TextEditingController _agentCtrl;
  bool _advanced = false;

  // ── 子 agent：强引导 / 家族默认 / 同步 ─────────────────────────────────
  //
  // 这一块以前折在「▸ 高级」里，等于没有。现在是一张常驻卡片（见 _subagentSection）：
  // 用户点过任何子 agent 控件之后 [_subagentTouched] 置位（草稿据此发显式 null，
  // 首次引导也就此收起）；[_guideReady]/[_guideDismissed] 是 SharedPreferences 里
  // `run_config_subagent_guide_v1` 的缓存；[_subagentDefaults] 是服务端那份
  // 家族默认（同步状态那行与草稿预填都读它）。
  bool _subagentTouched = false;
  bool _guideReady = false;
  bool _guideDismissed = true;
  bool _guideRevealed = false;
  late final AnimationController _guidePulse;
  final GlobalKey _subagentSectionKey = GlobalKey();
  final GlobalKey _subagentLineKey = GlobalKey();
  Map<String, SessionSubagent?> _subagentDefaults = const {};
  bool _defaultsLoaded = false;
  bool _defaultsApplied = false;

  /// 换车道时默认还没取回来：等 [_loadSubagentDefaults] 落地后按当时那条车道
  /// 补种（只对「用户没碰过子 agent」的换道有效，见 [_selectCli]）。
  bool _pendingLaneSeed = false;

  /// 打开面板时那份「来自全局默认」的线路（session.subagent.inherited，或草稿
  /// 自动预填的家族默认）。用户没动过选择器、且值仍是这一条时，徽标显示
  /// 「跟随全局默认」；清除全局默认后置空，把选择器重置回随主。
  SessionSubagent? _inheritedSeed;

  /// 「同步给所有没单独设置子 agent 的同 CLI 任务」开关。每次打开面板都是关的
  /// （它是一次性动作，不该跟着面板状态留下来）。随主（没有路由）时不可勾。
  bool _syncChecked = false;
  bool _syncLoading = false;
  bool _syncUnavailable = false;
  String _syncError = '';
  String _syncSummary = '';

  /// 清除全局默认之后留在状态行上的一句话；下一次同步/出错会让位。
  String _defaultNotice = '';
  bool _clearBusy = false;
  Timer? _syncDebounce;
  int _syncEpoch = 0;

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
    // 会话面板：打开时那条本来就是「跟随全局默认」的线路记下来，作为徽标与
    // 「用户到底动没动过」的对照。草稿的预填在 _maybePrefillSubagent 里补记。
    if (widget.subInherited) {
      _inheritedSeed = buildSubagent(
        subProviderId: widget.subProviderId ?? '',
        subModel: widget.subModel ?? '',
        mainProvider: _provider,
        inherited: true,
      );
    }
    _agentCtrl = TextEditingController(text: widget.agent ?? '');
    _seedAuto();
    if (widget.providerSelection != null) _mode = RunConfigMode.auto;
    _presetStore.load().then((presets) {
      if (mounted) setState(() => _presets = presets);
    });
    _guidePulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    );
    _initSubagentGuide();
    _loadSubagentDefaults();
  }

  @override
  void dispose() {
    _syncDebounce?.cancel();
    _guidePulse.dispose();
    _customCtrl.dispose();
    _subCustomCtrl.dispose();
    _agentCtrl.dispose();
    super.dispose();
  }

  // ── 子 agent：强引导 / 家族默认 / 同步 ─────────────────────────────────

  /// 首次强引导：没关过就显示，并把整块卡片滚进视野（面板一打开可能只看到 CLI
  /// 那一屏，新功能就藏没了）。
  Future<void> _initSubagentGuide() async {
    var dismissed = false;
    try {
      final prefs = await SharedPreferences.getInstance();
      dismissed = prefs.getBool(runConfigSubagentGuideKey) ?? false;
    } catch (_) {
      dismissed = false;
    }
    if (!mounted) return;
    setState(() {
      _guideDismissed = dismissed;
      _guideReady = true;
    });
    if (dismissed) return;
    _guidePulse.forward(from: 0);
    _revealSubagentSection();
  }

  void _revealSubagentSection() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _guideRevealed) return;
      final ctx = _subagentSectionKey.currentContext;
      if (ctx == null) return;
      _guideRevealed = true;
      Scrollable.ensureVisible(
        ctx,
        duration: const Duration(milliseconds: 280),
        alignment: 0.05,
      );
    });
  }

  void _dismissGuide() {
    if (_guideDismissed) return;
    setState(() => _guideDismissed = true);
    unawaited(_persistGuideDismissed());
  }

  Future<void> _persistGuideDismissed() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(runConfigSubagentGuideKey, true);
    } catch (_) {
      // 存不下只是下次还会再弹一次，不值得打断保存。
    }
  }

  void _onGuideGo() {
    final ctx = _subagentLineKey.currentContext;
    if (ctx == null) return;
    Scrollable.ensureVisible(
      ctx,
      duration: const Duration(milliseconds: 260),
      alignment: 0.1,
    );
  }

  /// 家族默认（claude / codex）。取不到（没 settings / 请求失败）就是空表 =
  /// 「随主线路」；403/404 的老服务端也走这条路，不该挡住面板。
  Future<void> _loadSubagentDefaults() async {
    final settings = widget.settings;
    if (settings == null) {
      if (mounted) setState(() => _defaultsLoaded = true);
      return;
    }
    try {
      final defaults = await SubagentDefaultsService(
        settings: settings,
        httpClient: widget.httpClient,
      ).fetchDefaults();
      if (!mounted) return;
      setState(() {
        _subagentDefaults = defaults;
        _defaultsLoaded = true;
      });
      // 换车道时默认还没取回来：现在按当前这条车道补种（和当场种上一样）。
      if (_pendingLaneSeed) {
        _pendingLaneSeed = false;
        if (!_subagentTouched) {
          _seedFamilyDefault(_cli, _provider);
          // 已经按当前车道种过（或确认没有默认），草稿的首帧预填不再改它。
          _defaultsApplied = true;
        }
      }
      _maybePrefillSubagent();
    } on SubagentSyncUnavailable {
      // 原生模块是旧版本：默认值读不到，同步也做不了。面板照常打开，只把开关
      // 收起并原样说明「重启一次 MultiCC 就好」。
      if (mounted) {
        setState(() {
          _defaultsLoaded = true;
          _pendingLaneSeed = false;
          _syncUnavailable = true;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _defaultsLoaded = true;
          _pendingLaneSeed = false;
        });
      }
    }
  }

  SessionSubagent? _defaultForCli(SessionCli cli) {
    final family = subagentFamilyOf(cli.name);
    if (family == null) return null;
    return _subagentDefaults[family];
  }

  /// 家族默认落到子 agent 选择器上。草稿首帧预填和换车道的补种都走这一条：
  /// 模型非空、线路在这条车道的池子里才种得上。种不上返回 false，选择器保持
  /// 调用方给的状态（由调用方决定要不要清回随主 —— 摆一个选不中的值只会让下拉
  /// 回落成「随主」却把值偷偷存下去）。
  bool _seedFamilyDefault(SessionCli cli, String mainProviderId) {
    final def = _defaultForCli(cli);
    final model = def?.model ?? '';
    final providerId = def?.providerId ?? '';
    final pool = _poolFor(cli.name);
    if (model.isEmpty ||
        (providerId.isNotEmpty &&
            !pool.any((p) => p['id']?.toString() == providerId))) {
      return false;
    }
    final choices = runModelChoices(
      cli,
      providerId.isEmpty ? mainProviderId : providerId,
      pool,
    ).where((m) => m.isNotEmpty).toList();
    setState(() {
      _subProvider = providerId;
      _subModel = model;
      _customSubModel = !choices.contains(model);
      _subCustomCtrl.text = _customSubModel ? model : '';
      // 种的是家族默认：用户没动过就还是「跟随全局默认」，建任务时整个不发
      // subagent，让服务端按它当时的默认套用并标 inherited。
      _inheritedSeed = SessionSubagent(
        providerId: providerId.isEmpty ? mainProviderId : providerId,
        model: model,
        inherited: true,
      );
    });
    return true;
  }

  /// 新任务草稿：用户还没碰过子 agent、也没有传进来的子任务，就把家族默认选上
  /// （和 web 草稿预填同一条规则）。
  void _maybePrefillSubagent() {
    if (!widget.draft || _subagentTouched || _defaultsApplied) return;
    _defaultsApplied = true;
    // 带进来的是单独设置的线路就不碰；跟着全局默认的（最近一次那套，可能已经
    // 过时）换成现在的全局默认，全局默认没了就回随主。
    final carried =
        (widget.subProviderId ?? '').isNotEmpty ||
        (widget.subModel ?? '').isNotEmpty;
    if (carried && !widget.subInherited) return;
    final target = _currentSubagentTarget();
    if (target == null) return;
    if (_seedFamilyDefault(target.cli, target.mainProviderId)) return;
    if (!carried) return;
    setState(() {
      _subProvider = '';
      _subModel = '';
      _customSubModel = false;
      _subCustomCtrl.text = '';
      _inheritedSeed = null;
    });
  }

  /// 当前模式下的子 agent 目标（车道 + 保存值），同步与默认展示都读它。
  _SubagentTarget? _currentSubagentTarget() => _mode == RunConfigMode.auto
      ? _autoSubagentTarget()
      : _fixedSubagentTarget();

  /// 自动挑选那半张由 mixin 覆写；固定一条模式不会走到这个空实现。
  _SubagentTarget? _autoSubagentTarget() => null;

  _SubagentTarget? _fixedSubagentTarget() {
    if (!_cli.supportsSubagent) return null;
    final subModel = _customSubModel ? _subCustomCtrl.text.trim() : _subModel;
    return _SubagentTarget(
      cli: _cli,
      mainProviderId: _provider,
      subagent: buildSubagent(
        subProviderId: _subProvider,
        subModel: subModel,
        mainProvider: _provider,
      ),
    );
  }

  void _noteSubagentChanged() {
    _subagentTouched = true;
    _dismissGuide();
    final target = _currentSubagentTarget();
    if (target?.subagent == null) {
      // 随主（默认）没有可同步的路由：勾选自动收起，统计作废。
      _cancelSync();
    } else if (_syncChecked) {
      _scheduleSyncDryRun();
    }
  }

  /// 清掉「同步」这次一次性动作（勾选、统计、错误）。路由变成随主时调用。
  void _cancelSync() {
    _syncDebounce?.cancel();
    _syncEpoch += 1;
    if (!_syncChecked &&
        !_syncLoading &&
        _syncSummary.isEmpty &&
        _syncError.isEmpty) {
      return;
    }
    if (!mounted) {
      _syncChecked = false;
      return;
    }
    setState(() {
      _syncChecked = false;
      _syncLoading = false;
      _syncError = '';
      _syncSummary = '';
    });
  }

  void _onSyncChanged(bool value) {
    // 随主（默认）只能靠「清除」处理，同步开关只负责「设一套路由」。
    if (value && _currentSubagentTarget()?.subagent == null) return;
    _syncDebounce?.cancel();
    _syncEpoch += 1;
    setState(() {
      _syncChecked = value;
      _syncLoading = false;
      _syncError = '';
      _syncSummary = '';
    });
    if (value) _scheduleSyncDryRun();
  }

  /// 当前路由是否就是「打开面板/自动预填时那条来自全局默认的线路」，且用户
  /// 没动过选择器。是的话徽标说「跟随全局默认」。
  bool _followsGlobalRoute(SessionSubagent? route) {
    if (route == null || route.isEmpty || _subagentTouched) return false;
    final seed = _inheritedSeed;
    if (seed == null) return false;
    return route.providerId == seed.providerId && route.model == seed.model;
  }

  _SubagentState _subagentStateOf(SessionSubagent? route) {
    if (route == null || route.isEmpty) return _SubagentState.followMain;
    return _followsGlobalRoute(route)
        ? _SubagentState.followGlobal
        : _SubagentState.own;
  }

  /// 勾上之后先做一次 dry run 统计（防抖，换线路/模型时重算）。真正的写入在
  /// 保存成功之后由调用方发（见 openRunConfigSheet / 建任务那条路）。
  void _scheduleSyncDryRun() {
    if (!_syncChecked) return;
    _syncDebounce?.cancel();
    final epoch = ++_syncEpoch;
    _syncDebounce = Timer(
      const Duration(milliseconds: 350),
      () => _runSyncDryRun(epoch),
    );
  }

  Future<void> _runSyncDryRun(int epoch) async {
    final settings = widget.settings;
    final target = _currentSubagentTarget();
    if (settings == null || target == null) return;
    setState(() {
      _syncLoading = true;
      _syncError = '';
    });
    try {
      final res = await SubagentDefaultsService(
        settings: settings,
        httpClient: widget.httpClient,
      ).sync(cli: target.cli.name, subagent: target.subagent, dryRun: true);
      if (!mounted || epoch != _syncEpoch) return;
      setState(() {
        _syncLoading = false;
        _syncUnavailable = false;
        _subagentDefaults = res.defaults;
        _defaultsLoaded = true;
        _defaultNotice = '';
        _syncSummary = _describeSyncDryRun(res);
      });
    } on SubagentSyncUnavailable {
      if (!mounted || epoch != _syncEpoch) return;
      setState(() {
        _syncLoading = false;
        _syncUnavailable = true;
        _syncChecked = false;
        _syncSummary = '';
        _syncError = '';
      });
    } catch (error) {
      if (!mounted || epoch != _syncEpoch) return;
      setState(() {
        _syncLoading = false;
        _syncError = '统计失败：${_cleanSyncError(error)}';
        _syncSummary = '';
      });
    }
  }

  String _describeSyncDryRun(SubagentSyncResult res) {
    final changes = res.changes;
    // 单独设置过的任务不会被同步改掉 —— 统计里必须说清楚，否则用户会以为
    // 「全部任务」又被覆盖了一遍。
    final kept = res.kept > 0 ? '，${res.kept} 个单独设置过的保持不变' : '';
    final skipped = res.skipped > 0 ? '，${res.skipped} 个跳过' : '';
    if (changes == 0) return '没有需要更新的任务$kept$skipped';
    return '将更新 $changes 个任务$kept$skipped';
  }

  String _cleanSyncError(Object error) =>
      error.toString().replaceFirst(RegExp(r'^Exception:\s*'), '');

  /// 全局默认那一行：当前家族「之后新建任务默认用哪套」。
  String _globalDefaultText(SessionCli cli, List<Map<String, dynamic>> pool) {
    if (!_defaultsLoaded) return '全局默认：读取中…';
    final def = _defaultForCli(cli);
    final providerId = def?.providerId ?? '';
    final model = def?.model ?? '';
    if (providerId.isEmpty || model.isEmpty) {
      return '全局默认：未设置（新任务随主线路）';
    }
    if (!pool.any((p) => p['id']?.toString() == providerId)) {
      final label = providerId.length > 8
          ? providerId.substring(0, 8)
          : providerId;
      return '全局默认：$label（线路已不可用）';
    }
    return '全局默认：${runLineName(providerId, pool)} · $model';
  }

  String _syncStatusText() {
    if (_syncUnavailable) return subagentSyncUnavailableText;
    if (_syncError.isNotEmpty) return _syncError;
    if (_syncChecked) return _syncLoading ? '正在统计…' : _syncSummary;
    return _defaultNotice;
  }

  /// 清除当前家族的全局默认：先 dry run 报数，用户确认后才真清。跟随全局的
  /// 任务恢复随主，单独设置过的任务不动。
  Future<void> _clearGlobalDefault(SessionCli cli) async {
    final settings = widget.settings;
    if (settings == null || _clearBusy) return;
    final family = subagentFamilyLabel(cli.name) ?? cli.displayName;
    final service = SubagentDefaultsService(
      settings: settings,
      httpClient: widget.httpClient,
    );
    setState(() {
      _clearBusy = true;
      _syncError = '';
      _defaultNotice = '';
    });
    SubagentSyncResult dry;
    try {
      dry = await service.clear(cli: cli.name, dryRun: true);
    } on SubagentSyncUnavailable {
      if (!mounted) return;
      setState(() {
        _clearBusy = false;
        _syncUnavailable = true;
      });
      return;
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _clearBusy = false;
        _syncError = '清除失败：${_cleanSyncError(error)}';
      });
      return;
    }
    if (!mounted) return;
    setState(() => _clearBusy = false);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('清除 $family 的全局子 agent？'),
        content: Text(
          '${dry.changes} 个跟随全局的任务会恢复随主，之后新建的任务也不再默认使用；'
          '单独设置过的 ${dry.kept} 个任务不受影响。',
        ),
        actions: [
          TextButton(
            key: const ValueKey('run-subagent-clear-cancel'),
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('取消'),
          ),
          FilledButton(
            key: const ValueKey('run-subagent-clear-confirm'),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('清除'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _clearBusy = true);
    try {
      final res = await service.clear(cli: cli.name);
      if (!mounted) return;
      final inheritedEditing = _inheritedSeed != null && !_subagentTouched;
      setState(() {
        _clearBusy = false;
        _subagentDefaults = res.defaults;
        _defaultsLoaded = true;
        _syncChecked = false;
        _syncLoading = false;
        _syncSummary = '';
        _defaultNotice = '已清除全局子 agent，${res.changes} 个任务恢复随主';
        if (inheritedEditing) {
          // 正在编辑的这个任务原来跟着全局默认：选择器回随主，免得用户再点
          // 「保存」时把同一条路由当自己的设置存回去。
          _inheritedSeed = null;
          _subProvider = '';
          _subModel = '';
          _customSubModel = false;
          _subCustomCtrl.text = '';
        }
      });
    } on SubagentSyncUnavailable {
      if (!mounted) return;
      setState(() {
        _clearBusy = false;
        _syncUnavailable = true;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _clearBusy = false;
        _syncError = '清除失败：${_cleanSyncError(error)}';
      });
    }
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

  /// 换车道时子 agent 那条路由留不留：用户没碰过、是自己单独设的一套、而且
  /// 目标车道还在同一个家族里（claude ↔ claude-exp 这些车道的线路池是共用的）
  /// 才留着。随主 / 跟着全局默认 / 跨家族都算「换道后不再适用」，换成目标车道
  /// 的家族默认，没有就回随主。
  bool _keepsOwnSubagentAcross(SessionCli next) {
    if (_subagentTouched) return false;
    final model = _customSubModel ? _subCustomCtrl.text.trim() : _subModel;
    if (model.isEmpty) return false;
    final current = buildSubagent(
      subProviderId: _subProvider,
      subModel: model,
      mainProvider: _provider,
    );
    if (_followsGlobalRoute(current)) return false;
    return subagentFamilyOf(_cli.name) == subagentFamilyOf(next.name);
  }

  Future<void> _selectCli(SessionCli cli) async {
    if (cli == _cli) return;
    final keepOwnSubagent = _keepsOwnSubagentAcross(cli);
    // 用户没碰过子 agent、又没有「同一家族里还成立」的单独设置：目标车道该套用
    // 它自己家族的默认（没有就是随主），不然会话面板保存时会把服务端刚按
    // switch-cli 套上的默认当成显式 null 抹掉。
    final seedSubagent = !_subagentTouched && !keepOwnSubagent;
    setState(() {
      _cli = cli;
      _provider = '';
      _model = '';
      _effort = cli.defaultEffort;
      _customModel = false;
      _customCtrl.text = '';
      if (!keepOwnSubagent) {
        _subProvider = '';
        _subModel = '';
        _customSubModel = false;
        _subCustomCtrl.text = '';
        // 换了主车道，旧车道那条「继承来的」路由不再适用。
        _inheritedSeed = null;
      }
    });
    _cancelSync();
    if (!cli.supportsProvider) {
      // 自持账号车道没有线路池，但模型目录是活的（Qoder / WorkBuddy 各自的
      // 宿主 CLI 目录）：开面板时只暖了入口那条车道，面板里切过来要在这里补暖，
      // 否则下拉只剩内置档位。
      await _warmOwnCatalog(cli);
      return;
    }
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
    if (!seedSubagent) return;
    if (_defaultsLoaded) {
      _seedFamilyDefault(cli, _provider);
    } else {
      // 默认还没取回来：记下来，等 _loadSubagentDefaults 落地后按当前车道补种。
      _pendingLaneSeed = true;
    }
  }

  Future<void> _warmOwnCatalog(SessionCli cli) async {
    final settings = widget.settings;
    if (settings == null) return;
    try {
      if (cli == SessionCli.qoder) {
        await QoderModelsService(settings: settings).load();
      } else if (cli == SessionCli.codebuddy) {
        await CodebuddyModelsService(settings: settings).load();
      } else if (cli == SessionCli.commandcode) {
        await CommandCodeModelsService(settings: settings).load();
      } else if (cli == SessionCli.grok) {
        await GrokModelsService(settings: settings).load();
      } else {
        return;
      }
    } catch (_) {}
    if (!mounted || _cli != cli) return;
    setState(() {});
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
    final subTarget = _currentSubagentTarget();
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
      subagentCli: _cli.name,
      syncSubagent: _syncChecked && !_syncUnavailable,
      subagentCleared:
          widget.draft && _subagentTouched && subModel.trim().isEmpty,
      subagentInherited: _followsGlobalRoute(subTarget?.subagent),
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
    final subCli = _autoSubCli();
    final collected = _collectAutoSubagent(provider);
    // 没动过的家族默认：带上 inherited 标记 —— 会话保存时服务端按同一路由保留
    // 继承，建任务时调用方整个省略 subagent 字段。
    final subagent = _followsGlobalRoute(collected)
        ? collected?.copyWith(inherited: true)
        : collected;
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
        subagent: subagent,
        switchToCli: result.switchToCli,
        subagentCli: subCli?.name,
        syncSubagent: _syncChecked && !_syncUnavailable,
        subagentCleared: widget.draft && _subagentTouched && subagent == null,
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
      // 子 agent 常驻（不再折在「高级」里）：这是一项会花/省额度的日常设置。
      if (_cli.supportsSubagent) ...[
        const SizedBox(height: 14),
        _subagentSection(
          cli: _cli,
          pool: _providers,
          providerId: _fixedSubProviderId(),
          mainProviderId: _provider,
          choices: _subagentChoicesFor(
            _cli,
            _providers,
            _fixedSubProviderId(),
            _provider,
          ),
          model: _effectiveSubModel(),
        ),
      ],
      // 「高级」只剩 CLI Agent 一项；这条车道没有 agent 就不画这枚开关。
      if (_cli.supportsAgent) ...[
        _advancedToggle(),
        if (_advanced) ..._advancedSection(),
      ],
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
    final showSearch = choices.length > kModelSearchMin;
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
        if (showSearch) ...[
          modelSearchField(
            onChanged: (v) => setState(() => _modelFilter = v),
            decoration: runConfigInputDecoration(),
            style: Theme.of(
              context,
            ).textTheme.bodyMedium!.copyWith(color: AppColors.text, fontSize: 13),
          ),
          const SizedBox(height: 6),
        ],
        DropdownButtonFormField<String>(
          value: value,
          isExpanded: true,
          dropdownColor: AppColors.panel,
          decoration: runConfigInputDecoration(),
          style: Theme.of(
            context,
          ).textTheme.bodyMedium?.copyWith(color: AppColors.text, fontSize: 13),
          items: modelMenuItems(
            keys: [...choices, '__custom__'],
            labelOf: (m) => m == '__custom__'
                ? '自定义…'
                : runModelOptionLabel(_cli, _provider, m, _providers),
            groupOf: (m) => runModelGroup(_cli, m),
            style: Theme.of(context).textTheme.bodyMedium!.copyWith(
              color: AppColors.text,
              fontSize: 13,
            ),
            headerStyle: const TextStyle(
              color: AppColors.faint,
              fontSize: 11,
              fontWeight: FontWeight.w600,
            ),
            filter: showSearch ? _modelFilter : '',
            keep: value,
          ),
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
        if (_cli == SessionCli.pi)
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (var i = 0; i < rungs.length; i += 1)
                _segmentedButton(
                  key: Key('run-effort-${rungs[i].$1}'),
                  label: rungs[i].$2,
                  selected: i == index,
                  onTap: () => setState(() => _effort = rungs[i].$1),
                ),
            ],
          )
        else
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

  String _fixedSubProviderId() =>
      _providers.any((p) => p['id']?.toString() == _subProvider)
      ? _subProvider
      : '';

  String _effectiveSubModel() =>
      _customSubModel ? _subCustomCtrl.text.trim() : _subModel;

  List<String> _subagentChoicesFor(
    SessionCli cli,
    List<Map<String, dynamic>> pool,
    String providerId,
    String mainProviderId,
  ) => runModelChoices(
    cli,
    providerId.isEmpty ? mainProviderId : providerId,
    pool,
  ).where((m) => m.isNotEmpty).toList();

  /// 引导卡片上那圈强调色边框的呼吸量（0 = 静止）。只在引导还在时跑一次有限
  /// 动画 —— 无限循环会让所有 pumpAndSettle 永远等下去。
  double _guidePulseAmount() {
    final value = _guidePulse.value;
    if (value <= 0 || value >= 1) return 1;
    final wave = math.sin(value * math.pi * 6).clamp(0.0, 1.0);
    return 0.4 + 0.6 * wave;
  }

  /// 三态徽标：随主 / 跟随全局默认（打开时那条来自家族默认的线路，用户没动）
  /// / 已单独设置。同步语义就靠它区分：只有「已单独设置」的任务会被同步跳过。
  Widget _subagentStateChip(_SubagentState state) {
    final (label, fg, bg) = switch (state) {
      _SubagentState.followMain => (
        '跟随主线路',
        AppColors.muted,
        const Color(0xFFe8eef5),
      ),
      _SubagentState.followGlobal => (
        '跟随全局默认',
        AppColors.accent,
        AppColors.accent.withValues(alpha: 0.10),
      ),
      _SubagentState.own => (
        '已单独设置',
        AppColors.accentDark,
        AppColors.accent.withValues(alpha: 0.14),
      ),
    };
    return Container(
      key: const ValueKey('run-subagent-badge'),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: fg,
          fontSize: 10.5,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }

  /// 首次强引导。它长在卡片里（不是一次性弹窗）：用户还没看的时候，一打开
  /// 面板就能看到「子 agent 能单独选线路」这件事。
  Widget _subagentGuideCard() => Container(
    key: const ValueKey('run-subagent-guide'),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: AppColors.panel,
      border: Border.all(color: AppColors.accent.withValues(alpha: 0.45)),
      borderRadius: BorderRadius.circular(12),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          '新功能：子 agent 可以单独选线路和模型',
          style: TextStyle(
            color: AppColors.text,
            fontSize: 12.5,
            fontWeight: FontWeight.w700,
            height: 1.35,
          ),
        ),
        const SizedBox(height: 5),
        const Text(
          'CLI 派出去的子任务默认跟主线路走；换一条更便宜或更快的线路，主任务'
          '不受影响，能省额度；勾选下面的「同步」能套用到所有还没单独设置过的'
          '同 CLI 任务，以后新建的也默认这样',
          style: TextStyle(
            color: AppColors.muted,
            fontSize: 11.5,
            height: 1.45,
          ),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 6,
          children: [
            FilledButton(
              key: const ValueKey('run-subagent-guide-go'),
              onPressed: _onGuideGo,
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.accent,
                foregroundColor: Colors.white,
                minimumSize: const Size(0, 34),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                textStyle: const TextStyle(fontSize: 12),
              ),
              child: const Text('现在设置'),
            ),
            TextButton(
              key: const ValueKey('run-subagent-guide-dismiss'),
              onPressed: _dismissGuide,
              style: TextButton.styleFrom(
                minimumSize: const Size(0, 34),
                padding: const EdgeInsets.symmetric(horizontal: 10),
                textStyle: const TextStyle(fontSize: 12),
              ),
              child: const Text('知道了'),
            ),
          ],
        ),
      ],
    ),
  );

  /// 子 agent 整块卡片：标题 + 状态 + 说明 + 首次引导 + 线路/模型 + 同步开关。
  /// 固定一条与自动挑选共用同一份 state 与同一对控件键，差别只在主线路是谁。
  ///
  /// [providerId] 是折算后认得的子任务线路（空 = 跟随主线路），[choices] 是它
  /// 名下的模型候选，[model] 是折算后可显示也可保存的模型值（候选里没有的按
  /// 「不设置」处理 —— 摆不进下拉的值不该偷偷上 wire）。
  Widget _subagentSection({
    required SessionCli cli,
    required List<Map<String, dynamic>> pool,
    required String providerId,
    required String mainProviderId,
    required List<String> choices,
    required String model,
  }) {
    final labelProvider = providerId.isEmpty ? mainProviderId : providerId;
    // 徽标与开关看的是「保存时会交回去的那条路由」——固定一条与自动挑选各自
    // 的折算口径不同，统一从 _currentSubagentTarget 取。
    final state = _subagentStateOf(_currentSubagentTarget()?.subagent);
    final hasRoute = state != _SubagentState.followMain;
    final defaultRoute = _defaultForCli(cli);
    final hasDefault =
        (defaultRoute?.providerId ?? '').isNotEmpty &&
        (defaultRoute?.model ?? '').isNotEmpty;
    final syncEnabled = !_syncUnavailable && hasRoute;
    final showGuide = _guideReady && !_guideDismissed;
    final family = subagentFamilyLabel(cli.name) ?? cli.displayName;
    final statusColor = _syncUnavailable || _syncError.isNotEmpty
        ? AppColors.danger
        : AppColors.muted;
    return KeyedSubtree(
      key: _subagentSectionKey,
      child: AnimatedBuilder(
        animation: _guidePulse,
        builder: (context, _) {
          final pulse = showGuide ? _guidePulseAmount() : 1.0;
          return Container(
            key: const ValueKey('run-subagent-section'),
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            decoration: BoxDecoration(
              color: AppColors.blueSoft,
              border: Border.all(
                color: AppColors.accent.withValues(
                  alpha: showGuide ? 0.3 + 0.5 * pulse : 0.32,
                ),
                width: showGuide ? 1.6 : 1.0,
              ),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    const Icon(
                      Icons.account_tree_outlined,
                      size: 17,
                      color: AppColors.accent,
                    ),
                    const SizedBox(width: 6),
                    const Text(
                      '子 agent',
                      style: TextStyle(
                        color: AppColors.text,
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(width: 8),
                    _subagentStateChip(state),
                  ],
                ),
                const SizedBox(height: 4),
                const Text(
                  'Task / 子 agent 派出去的子任务用哪条线路和模型',
                  style: TextStyle(
                    color: AppColors.muted,
                    fontSize: 11.5,
                    height: 1.4,
                  ),
                ),
                const SizedBox(height: 2),
                const Text(
                  '主任务用强模型，子 agent 换更便宜或更快的线路，能省不少额度',
                  style: TextStyle(
                    color: AppColors.faint,
                    fontSize: 11,
                    height: 1.4,
                  ),
                ),
                if (showGuide) ...[
                  const SizedBox(height: 10),
                  _subagentGuideCard(),
                ],
                const SizedBox(height: 10),
                Row(
                  children: [
                    const Expanded(
                      child: Text(
                        '线路',
                        style: TextStyle(
                          color: AppColors.faint,
                          fontSize: 11.5,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    const Expanded(
                      child: Text(
                        '模型',
                        style: TextStyle(
                          color: AppColors.faint,
                          fontSize: 11.5,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 5),
                KeyedSubtree(
                  key: _subagentLineKey,
                  child: Row(
                    children: [
                      Expanded(
                        child: DropdownButtonFormField<String>(
                          key: const Key('run-subagent-provider'),
                          value: providerId,
                          isExpanded: true,
                          dropdownColor: AppColors.panel,
                          decoration: runConfigInputDecoration(),
                          style: Theme.of(context).textTheme.bodyMedium
                              ?.copyWith(color: AppColors.text, fontSize: 13),
                          items: [
                            const DropdownMenuItem(
                              value: '',
                              child: Text('随主'),
                            ),
                            ...pool
                                .where(
                                  (p) =>
                                      !(cli.isCodexFamily &&
                                          p['isOfficial'] == true),
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
                          onChanged: (v) {
                            setState(() {
                              _subProvider = v ?? '';
                              _customSubModel = false;
                              _subCustomCtrl.text = '';
                              _subModel = '';
                            });
                            _noteSubagentChanged();
                          },
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
                          style: Theme.of(context).textTheme.bodyMedium
                              ?.copyWith(color: AppColors.text, fontSize: 13),
                          items: [
                            const DropdownMenuItem(
                              value: '',
                              child: Text('不设置'),
                            ),
                            ...choices.map(
                              (m) => DropdownMenuItem(
                                value: m,
                                child: Text(
                                  runModelOptionLabel(
                                    cli,
                                    labelProvider,
                                    m,
                                    pool,
                                  ),
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
                          onChanged: (v) {
                            setState(() {
                              _customSubModel = v == '__custom__';
                              if (!_customSubModel) _subModel = v ?? '';
                            });
                            _noteSubagentChanged();
                          },
                        ),
                      ),
                    ],
                  ),
                ),
                if (_customSubModel) ...[
                  const SizedBox(height: 6),
                  TextField(
                    controller: _subCustomCtrl,
                    style: const TextStyle(
                      color: AppColors.text,
                      fontSize: 13,
                      fontFamily: 'monospace',
                    ),
                    onChanged: (_) => _noteSubagentChanged(),
                    decoration: runConfigInputDecoration(hint: '模型 ID'),
                  ),
                ],
                const SizedBox(height: 8),
                // 全局默认那一行：改/清它只影响「之后新建的」和跟随它的任务。
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        _globalDefaultText(cli, pool),
                        key: const ValueKey('run-subagent-default-line'),
                        style: const TextStyle(
                          color: AppColors.muted,
                          fontSize: 11,
                          height: 1.4,
                        ),
                      ),
                    ),
                    if (hasDefault)
                      TextButton(
                        key: const ValueKey('run-subagent-clear-default'),
                        onPressed: _clearBusy || _syncUnavailable
                            ? null
                            : () => _clearGlobalDefault(cli),
                        style: TextButton.styleFrom(
                          minimumSize: const Size(0, 28),
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          textStyle: const TextStyle(fontSize: 11.5),
                        ),
                        child: const Text('清除'),
                      ),
                  ],
                ),
                const SizedBox(height: 4),
                CheckboxListTile(
                  key: const ValueKey('run-subagent-sync'),
                  value: syncEnabled && _syncChecked,
                  onChanged: syncEnabled
                      ? (value) => _onSyncChanged(value == true)
                      : null,
                  dense: true,
                  visualDensity: VisualDensity.compact,
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  title: Text(
                    '同步给所有没单独设置子 agent 的 $family 任务，'
                    '之后新建的也默认用这套',
                    style: const TextStyle(
                      color: AppColors.text,
                      fontSize: 12,
                      height: 1.35,
                    ),
                  ),
                ),
                Text(
                  _syncStatusText(),
                  key: const ValueKey('run-subagent-sync-status'),
                  style: TextStyle(
                    color: statusColor,
                    fontSize: 11,
                    height: 1.4,
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  /// 「高级」现在只剩 CLI Agent 一项 —— 子 agent 已经常驻在面板上。
  List<Widget> _advancedSection() {
    final out = <Widget>[];
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

/// 子 agent 卡片上的三态：随主 / 跟随全局默认 / 自己单独设过。
enum _SubagentState { followMain, followGlobal, own }

/// 当前模式下的子 agent 目标：同步与家族默认展示都读它。
class _SubagentTarget {
  const _SubagentTarget({
    required this.cli,
    required this.mainProviderId,
    required this.subagent,
  });

  final SessionCli cli;

  /// 主线路的 Provider id（子 agent 线路留空时，保存的 providerId 认它）。
  final String mainProviderId;

  /// 要保存 / 同步的那套设置；null = 跟随主线路。
  final SessionSubagent? subagent;
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
          subInherited: runtime.subagent?.inherited ?? false,
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
    return;
  }
  // 同步是保存之后的第二步：任务自己那份配置已经落盘，这一步失败只提示、不回滚
  // （面板上勾的正是「顺便套用到其它任务」，不该因为它把这次保存也吞掉）。
  if (picked.syncSubagent) {
    await runSubagentSyncAfterSave(
      messenger: messenger,
      settings: settings,
      httpClient: httpClient,
      cli: picked.subagentCli ?? picked.switchToCli ?? '',
      subagent: picked.subagent,
    );
  }
}

/// 「同步到全部同 CLI 任务」的第二步：保存成功之后发。失败只弹提示，不能让调用
/// 方以为保存失败（此时配置已经落盘）。
Future<void> runSubagentSyncAfterSave({
  required ScaffoldMessengerState messenger,
  required SettingsService settings,
  required http.Client? httpClient,
  required String cli,
  required SessionSubagent? subagent,
}) async {
  if (cli.isEmpty) return;
  try {
    final res = await SubagentDefaultsService(
      settings: settings,
      httpClient: httpClient,
    ).sync(cli: cli, subagent: subagent);
    messenger.showSnackBar(
      SnackBar(content: Text(subagentSyncSuccessText(res))),
    );
  } catch (error) {
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          '子 agent 设置已保存，但同步到其它任务失败：'
          '${subagentSyncFailureText(error)}',
        ),
      ),
    );
  }
}

@visibleForTesting
String subagentSyncSuccessText(SubagentSyncResult res) {
  final applied = res.applied > 0 ? '更新 ${res.applied} 个任务' : '';
  final deferred = res.deferred > 0 ? '${res.deferred} 个下轮生效' : '';
  final kept = res.kept > 0 ? '${res.kept} 个单独设置过的保持不变' : '';
  final skipped = res.skipped > 0 ? '${res.skipped} 个跳过' : '';
  final parts = [
    if (applied.isNotEmpty) applied,
    if (deferred.isNotEmpty) deferred,
    if (kept.isNotEmpty) kept,
    if (skipped.isNotEmpty) skipped,
  ];
  if (parts.isEmpty) return '✓ 子 agent 同步完成：没有需要更新的任务';
  return '✓ 子 agent 同步完成：${parts.join('，')}';
}

@visibleForTesting
String subagentSyncFailureText(Object error) {
  if (error is SubagentSyncUnavailable) return subagentSyncUnavailableText;
  return error.toString().replaceFirst(RegExp(r'^Exception:\s*'), '');
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
