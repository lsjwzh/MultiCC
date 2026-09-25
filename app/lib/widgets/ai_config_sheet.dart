// AI 配置底部面板（provider/model/effort/agent/subagent + 角色提示词编辑）。自 chat_screen.dart 抽出。
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../models/agent_preset.dart';
import '../models/message.dart';
import '../models/provider_limit_label.dart';
import '../providers/session_manager.dart';
import 'agent_preset_picker_sheet.dart';
import 'provider_option.dart';
import '../services/agent_preset_service.dart';
import '../services/auto_provider_routing.dart';
import '../services/manage_service.dart';
import '../services/claude_models_service.dart';
import '../services/codex_models_service.dart';
import '../services/qoder_models_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

class AIConfigResult {
  final String provider;
  final String model;
  final String effort;
  final String providerLabel;
  final String modelLabel;
  final String effortLabel;
  final SessionProviderSelection? providerSelection;
  final SessionSubagent? subagent;
  final String? agent;
  const AIConfigResult({
    required this.provider,
    required this.model,
    required this.effort,
    required this.providerLabel,
    required this.modelLabel,
    required this.effortLabel,
    this.providerSelection,
    this.subagent,
    this.agent,
  });
}

class _AutoProviderGroup {
  const _AutoProviderGroup({
    required this.key,
    required this.protocol,
    required this.providers,
  });

  final String key;
  final String protocol;
  final List<Map<String, dynamic>> providers;
}

class _AutoCandidateDraft {
  _AutoCandidateDraft({
    required this.providerId,
    required this.model,
    required this.priority,
    required this.enabled,
    this.rung,
  });

  final String providerId;
  String model;
  int priority;
  bool enabled;

  /// 用户手点的档位（1 = 最简单），未点过是 null —— 未点过的行每轮按模型名重猜
  /// （web 的 dataset.rung 与 dataset.value 之分）。空值绝不进 wire。
  int? rung;
}

class AIConfigSheet extends StatefulWidget {
  final SessionCli cli;
  final List<Map<String, dynamic>> providers;
  final String provider;
  final String model;
  final String effort;
  final SessionProviderSelection? providerSelection;
  final String? subProviderId;
  final String? subModel;
  final String? agent;

  /// Host-owned network access for the Jev key step (check the vault entry, save
  /// a pasted key, run one real classification). Same contract as the web
  /// editor's `routingKey` option: without it the panel only names the vault
  /// entry and offers no form — which is also what keeps widget tests hermetic.
  final SettingsService? settings;
  final http.Client? httpClient;

  const AIConfigSheet({
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
  });

  @override
  State<AIConfigSheet> createState() => AIConfigSheetState();
}

class AIConfigSheetState extends State<AIConfigSheet> {
  late String _provider;
  late String _model;
  late String _effort;
  String? _autoGroupKey;
  final List<_AutoCandidateDraft> _autoCandidates = [];
  int _autoMaxAttempts = 2;
  bool _autoSticky = true;
  bool _seededAutoAllowCrossTrust = false;
  bool _customModel = false;
  late final TextEditingController _customCtrl;
  late final TextEditingController _agentCtrl;
  // Sub-task (subagent) cascade — same shape as the main provider/model.
  late String _subProvider;
  late String _subModel;
  bool _customSubModel = false;
  late final TextEditingController _subCustomCtrl;
  // Auto 候选池每行的模型选择状态（与子任务选择器同一套下拉 + 自定义…）。
  // 自定义文本按 providerId 存 controller，切回候选模型时两边保持同步。
  final Map<String, bool> _autoCustomModel = {};
  final Map<String, TextEditingController> _autoModelCtrls = {};

  // 难度路由（按难度选线路）。`_autoRoutingEnabled` 关着时整块 routing 不上 wire，
  // 顺序池的 JSON 与以前逐字节一致；`_seededRouting` 是池子里原本就有的那块，
  // 用来把本面板不暴露的旋钮（model / timeoutMs / escalation / key 条目名）原样带回去。
  bool _autoRoutingEnabled = false;
  String _autoRoutingOnUnknown = 'strong';
  SessionProviderRouting? _seededRouting;
  String _autoError = '';

  // Jev key 步骤（与 web 的 routingKey 流程同一套状态机）。
  String _jevState = 'unknown'; // unknown | checking | present | missing | error
  bool _jevFormOpen = false;
  bool _jevSaving = false;
  String _jevResult = '';
  bool _jevResultGood = false;
  final TextEditingController _jevKeyCtrl = TextEditingController();

  bool get _isClaude => widget.cli.isClaudeFamily;
  bool get _isCodex => widget.cli.isCodexFamily;
  bool get _isQoder => widget.cli == SessionCli.qoder;
  String get _defaultEffort => widget.cli.defaultEffort;

  @override
  void initState() {
    super.initState();
    _provider = widget.cli.supportsProvider ? widget.provider : '';
    if (_provider.isEmpty) {
      for (final p in widget.providers) {
        if (p['builtinOfficial'] == true &&
            p['id'] == '${widget.cli.poolKey}-official') {
          _provider = p['id'].toString();
          break;
        }
      }
    }
    _model = _normalizeModel(_provider, widget.model);
    _effort = _validEfforts.contains(widget.effort)
        ? widget.effort
        : _defaultEffort;
    final known = _modelChoices(_provider).contains(_model);
    _customModel = _model.isNotEmpty && !known;
    _customCtrl = TextEditingController(text: _customModel ? _model : '');
    _seedAutoSelection(widget.providerSelection);
    _agentCtrl = TextEditingController(text: widget.agent ?? '');
    // Sub-task seeding. 线路留空 = 随主，所以别名折算和候选判定都按生效线路来 ——
    // 用空串去查会落回默认模型表，存的是 glm-5.2 也会被当成自定义 ID。
    _subProvider = widget.subProviderId ?? '';
    _subModel = _normalizeModel(_subEffectiveProvider, widget.subModel ?? '');
    final subKnown =
        _subModel.isNotEmpty &&
        _modelChoices(_subEffectiveProvider).contains(_subModel);
    _customSubModel = _subModel.isNotEmpty && !subKnown;
    _subCustomCtrl = TextEditingController(
      text: _customSubModel ? _subModel : '',
    );
  }

  @override
  void dispose() {
    _customCtrl.dispose();
    _agentCtrl.dispose();
    _subCustomCtrl.dispose();
    _jevKeyCtrl.dispose();
    for (final controller in _autoModelCtrls.values) {
      controller.dispose();
    }
    super.dispose();
  }

  List<String> get _validEfforts => widget.cli.effortOptions;
  bool get _isAuto => _autoGroupKey != null;

  String _protocolLabel(String protocol) => switch (protocol) {
    'anthropic' => 'Anthropic',
    'openai_responses' => 'OpenAI Responses',
    'openai_chat' => 'OpenAI Chat',
    _ => protocol,
  };

  String? _protocolOf(Map<String, dynamic> provider) {
    final value = (provider['protocol'] ?? provider['apiFormat'])?.toString();
    return const {
          'anthropic',
          'openai_responses',
          'openai_chat',
        }.contains(value)
        ? value
        : null;
  }

  List<_AutoProviderGroup> get _autoGroups {
    final grouped = <String, List<Map<String, dynamic>>>{};
    for (final provider in widget.providers) {
      final protocol = _protocolOf(provider);
      final id = provider['id']?.toString() ?? '';
      if (protocol == null || id.isEmpty) continue;
      grouped.putIfAbsent(protocol, () => []).add(provider);
    }
    return grouped.entries
        .where((entry) => entry.value.length >= 2)
        .map((entry) {
          return _AutoProviderGroup(
            key: entry.key,
            protocol: entry.key,
            providers: entry.value,
          );
        })
        .toList(growable: false);
  }

  _AutoProviderGroup? _autoGroup(String? key) {
    if (key == null) return null;
    for (final group in _autoGroups) {
      if (group.key == key) return group;
    }
    return null;
  }

  void _seedAutoSelection(SessionProviderSelection? selection) {
    if (selection == null) return;
    _autoGroupKey = selection.protocol;
    final configured = {
      for (final candidate in selection.candidates)
        candidate.providerId: candidate,
    };
    final pool = widget.providers
        .where(
          (provider) =>
              _protocolOf(provider) == selection.protocol &&
              (provider['id']?.toString() ?? '').isNotEmpty,
        )
        .toList(growable: false);
    var nextPriority = selection.candidates.fold<int>(
      0,
      (highest, candidate) =>
          candidate.priority > highest ? candidate.priority : highest,
    );
    final seen = <String>{};
    _autoCandidates
      ..clear()
      ..addAll(
        pool.map((provider) {
          final providerId = provider['id']?.toString() ?? '';
          seen.add(providerId);
          final candidate = configured[providerId];
          return _AutoCandidateDraft(
            providerId: providerId,
            model: candidate?.model ?? '',
            priority: candidate?.priority ?? ++nextPriority,
            enabled: candidate?.enabled ?? false,
            rung: _seededRung(candidate, selection.routing),
          );
        }),
      )
      ..addAll(
        selection.candidates
            .where((candidate) => !seen.contains(candidate.providerId))
            .map(
              (candidate) => _AutoCandidateDraft(
                providerId: candidate.providerId,
                model: candidate.model ?? '',
                priority: candidate.priority,
                enabled: candidate.enabled,
                rung: _seededRung(candidate, selection.routing),
              ),
            ),
      );
    _autoMaxAttempts = selection.maxAttempts;
    _autoSticky = selection.sticky;
    _seededAutoAllowCrossTrust = selection.allowCrossTrust;
    _seededRouting = selection.routing;
    _autoRoutingEnabled = selection.routing != null;
    _autoRoutingOnUnknown = selection.routing?.resolvedOnUnknown ?? 'strong';
    final enabled =
        _autoCandidates.where((candidate) => candidate.enabled).toList()
          ..sort((a, b) => a.priority.compareTo(b.priority));
    if (enabled.isNotEmpty) {
      _provider = enabled.first.providerId;
      _model = _normalizeModel(_provider, enabled.first.model);
    }
  }

  /// 已配置池里这一行原本落在哪一档（wire 上是 `t1..tK`，面板上显示 1..K）。
  /// 没路由过的池子一律留空，交给 [resolveAutoRungs] 按模型名猜。
  int? _seededRung(
    SessionProviderCandidate? configured,
    SessionProviderRouting? routing,
  ) {
    if (configured == null || routing == null) return null;
    final rung = autoRungFor(configured, routing.tiers);
    return rung > 0 ? rung : null;
  }

  /// 在用的候选行，按优先级（= 尝试顺序）排。web 的 `order` 数组。
  List<_AutoCandidateDraft> get _autoEnabledOrdered =>
      _autoCandidates.where((candidate) => candidate.enabled).toList()
        ..sort((a, b) => a.priority.compareTo(b.priority));

  /// 一行在预览里的写法：`线路名（模型）`，没选模型就只有线路名。
  String _autoRowText(_AutoCandidateDraft candidate) {
    final name = _providerName(candidate.providerId);
    final model = candidate.model.trim();
    return model.isEmpty
        ? name
        : t('autoEditorLineWithModel', {'name': name, 'model': model});
  }

  /// 每行的生效档位与要画几个档位按钮。手点过的档位留着，没点过的按模型名猜。
  AutoRungPlan get _autoRungPlan {
    final rows = _autoEnabledOrdered;
    return resolveAutoRungs(
      rowTexts: [for (final row in rows) _autoRowText(row)],
      chosenRungs: [for (final row in rows) row.rung],
    );
  }

  int _autoEffectiveRung(_AutoCandidateDraft candidate) {
    final rows = _autoEnabledOrdered;
    final index = rows.indexOf(candidate);
    if (index < 0) return 0;
    return _autoRungPlan.rungs[index];
  }

  void _setAutoRouting(bool on) {
    setState(() {
      _autoRoutingEnabled = on;
      _autoError = '';
    });
    // key 状态只在第一次打开「按难度」时查一次，开一次普通池不发请求。
    if (on && _jevState == 'unknown' && widget.settings != null) {
      _checkJevKey();
    }
  }

  // ── Jev key（难度路由的判定服务）───────────────────────────────────────

  ManageService? get _manage {
    final settings = widget.settings;
    if (settings == null) return null;
    return ManageService(settings: settings, httpClient: widget.httpClient);
  }

  String get _jevKeyName =>
      _seededRouting?.apiKeyName ?? SessionProviderRouting.defaultApiKeyName;

  Future<void> _checkJevKey() async {
    final manage = _manage;
    if (manage == null) return;
    setState(() => _jevState = 'checking');
    try {
      final entries = await manage.fetchSecrets();
      if (!mounted) return;
      setState(() {
        _jevState = entries.any((entry) => entry['name'] == _jevKeyName)
            ? 'present'
            : 'missing';
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _jevState = 'error');
    }
  }

  Future<void> _saveJevKey() async {
    final manage = _manage;
    if (manage == null) return;
    // 读一次立刻清空：粘贴进来的 key 不在表单里多留一秒。
    final value = _jevKeyCtrl.text.trim();
    _jevKeyCtrl.clear();
    if (value.isEmpty) {
      setState(() {
        _jevResult = t('autoEditorJevKeyEmpty');
        _jevResultGood = false;
      });
      return;
    }
    setState(() {
      _jevSaving = true;
      _jevResult = t('autoEditorJevKeySaving');
      _jevResultGood = false;
    });
    try {
      await manage.saveSecret(
        _jevKeyName,
        value,
        description: 'Vercel AI Gateway（Jev 难度路由）',
      );
      if (!mounted) return;
      setState(() {
        _jevState = 'present';
        _jevFormOpen = false;
        _jevResult = '';
      });
      await _runJevTest();
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _jevResult = t('autoEditorJevKeySaveFailed', {
          'reason': '$error',
        });
        _jevResultGood = false;
      });
    } finally {
      if (mounted) setState(() => _jevSaving = false);
    }
  }

  Future<void> _runJevTest() async {
    final manage = _manage;
    if (manage == null) return;
    final sample = t('autoEditorJevSample');
    setState(() {
      _jevResult = t('autoEditorJevTesting');
      _jevResultGood = false;
    });
    Map<String, dynamic> result;
    try {
      result = await manage.testAutoProviderRouting(
        apiKeyName: _jevKeyName,
        text: sample,
      );
    } catch (error) {
      result = {'ok': false, 'code': 'request_failed', 'detail': '$error'};
    }
    if (!mounted) return;
    setState(() {
      if (result['ok'] == true) {
        final tier = result['tier'] == 't1' ? 1 : 2;
        _jevResult = t('autoEditorJevTestOk', {
          'ms': '${(result['latencyMs'] as num?)?.round() ?? 0}',
          'sample': sample,
          'tier': autoTierLabel(tier, 2),
        });
        _jevResultGood = true;
        return;
      }
      if (result['code'] == 'jev_key_missing') _jevState = 'missing';
      final status = (result['status'] as num?)?.toInt() ?? 0;
      if (status == 401 || status == 403) _jevFormOpen = true;
      _jevResult = _describeJevFailure(result);
      _jevResultGood = false;
    });
  }

  /// 失败原因说人话（与 web 的 describeJevFailure 同一套映射）。
  String _describeJevFailure(Map<String, dynamic> result) {
    final code = '${result['code'] ?? ''}';
    final status = (result['status'] as num?)?.toInt() ?? 0;
    if (code == 'jev_key_missing') return t('autoEditorJevErrKeyMissing');
    if (status == 401 || status == 403 ||
        code == 'jev_http_401' || code == 'jev_http_403') {
      return t('autoEditorJevErrKeyInvalid', {
        'status': '${status != 0 ? status : code.substring(code.length - 3)}',
      });
    }
    if (code == 'jev_timeout') return t('autoEditorJevErrTimeout');
    if (code == 'jev_network') return t('autoEditorJevErrNetwork');
    if (code == 'test_unavailable') return t('autoEditorJevErrUnavailable');
    final rawDetail = '${result['detail'] ?? ''}';
    final detail = rawDetail.isEmpty
        ? ''
        : ' · ${rawDetail.length > 160 ? rawDetail.substring(0, 160) : rawDetail}';
    return t('autoEditorJevErrOther', {
          'code': code.isEmpty ? 'unknown' : code,
        }) +
        detail;
  }

  bool get _autoSelectionCrossesTrust {
    final trust = <bool>{};
    for (final candidate in _autoCandidates.where(
      (candidate) => candidate.enabled,
    )) {
      final provider = _providerMap(candidate.providerId);
      if (provider != null) trust.add(provider['isOfficial'] == true);
    }
    return trust.length > 1;
  }

  bool get _hasUnknownEnabledAutoProvider => _autoCandidates.any(
    (candidate) =>
        candidate.enabled && _providerMap(candidate.providerId) == null,
  );

  bool get _autoAllowsCrossTrust =>
      _autoSelectionCrossesTrust ||
      (_hasUnknownEnabledAutoProvider && _seededAutoAllowCrossTrust);

  Map<String, dynamic>? _providerMap(String id) {
    for (final p in widget.providers) {
      if (p['id'] == id) return p;
    }
    return null;
  }

  String _providerName(String id) {
    // 自持账号的 CLI 没有 MultiCC 线路，这里显示的是 CLI 自己的名字 —— 走唯一那份展示
    // 表（SessionCli.displayName，源自 app/lib/utils/cli_display.dart），不再抄五遍。
    if (!widget.cli.supportsProvider) return widget.cli.displayName;
    if (id.isEmpty) {
      for (final p in widget.providers) {
        final providerId = p['id']?.toString() ?? '';
        if (p['builtinOfficial'] == true ||
            providerId == '${widget.cli.poolKey}-official') {
          return p['name']?.toString() ?? '官方 Provider';
        }
      }
      return '官方 Provider';
    }
    final p = _providerMap(id);
    return p?['name']?.toString() ?? id;
  }

  // Ordered alias tiers (opus/sonnet/haiku/fable) with their {model, name} for an
  // alias-mapped relay, or empty when the provider declares no aliasMap. Each tier
  // is a real, selectable wire model on these relays (the server honors
  // session.model === 'opus' | 'sonnet' | 'haiku' | 'fable' directly).
  List<MapEntry<String, Map>> _aliasTiers(String provider) {
    final map = _providerMap(provider)?['aliasMap'];
    if (map is! Map) return const [];
    const order = ['opus', 'sonnet', 'haiku', 'fable'];
    final tiers = <MapEntry<String, Map>>[];
    for (final t in order) {
      final v = map[t];
      if (v is Map && v['model'] != null) tiers.add(MapEntry(t, v));
    }
    return tiers;
  }

  List<String> _modelChoices(String provider) {
    if (_isQoder) {
      // Live catalog when openAIConfigSheet warmed it, built-in tiers otherwise.
      return QoderModelsService.options().map((option) => option.key).toList();
    }
    // Vendor-auth CLIs with a static catalog (mirrors web CODEBUDDY/DSH_MODEL_OPTIONS).
    if (widget.cli == SessionCli.codebuddy) {
      return kCodebuddyModelOptions.map((option) => option.key).toList();
    }
    if (widget.cli == SessionCli.dsh) {
      return kDshModelOptions.map((option) => option.key).toList();
    }
    if (widget.cli == SessionCli.gemini) {
      return kGeminiModelOptions.map((option) => option.key).toList();
    }
    if (widget.cli == SessionCli.grok) {
      return kGrokModelOptions.map((option) => option.key).toList();
    }
    final resolvedProvider = _providerMap(provider);
    if (_isCodex &&
        (resolvedProvider == null || resolvedProvider['isOfficial'] == true)) {
      return CodexModelsService.options().map((entry) => entry.key).toList();
    }
    // Alias-mapped relays: offer the tiers directly (opus/sonnet/haiku/fable) so
    // each option can read "alias → wire model (display name)".
    final tiers = _aliasTiers(provider);
    if (tiers.isNotEmpty) return ['', ...tiers.map((e) => e.key)];
    final opts = _providerMap(provider)?['modelOptions'];
    if (opts is List && opts.isNotEmpty) {
      return [
        '',
        ...opts.map((e) => e.toString()).where((e) => e.trim().isNotEmpty),
      ];
    }
    // Live CLI-bundle list once openAIConfigSheet warmed it; static table until then.
    return _isClaude
        ? ClaudeModelsService.options().map((e) => e.key).toList()
        : [''];
  }

  // Auto 行的候选：_modelChoices 已含「借道线路落回本机 Claude 目录」的兜底，
  // 这里只去掉空串（首项「Provider 默认」由下拉自己给）和重复项。
  List<String> _autoModelChoices(String providerId) {
    final seen = <String>{};
    return [
      for (final choice in _modelChoices(providerId))
        if (choice.trim().isNotEmpty && seen.add(choice)) choice,
    ];
  }

  TextEditingController _autoModelCtrl(_AutoCandidateDraft candidate) =>
      _autoModelCtrls.putIfAbsent(
        candidate.providerId,
        () => TextEditingController(text: candidate.model),
      );

  // Auto 候选行的模型控件：首项「Provider 默认」（存空串 = 跟随线路默认），
  // 中间是这条线路的候选，末尾「自定义…」现出文本框 —— 与 Web
  // auto-provider-editor 同一套语义。配置里已有的、不在候选内的 id 会以
  // 「自定义…」+ 原值回显，不会被静默丢掉。
  Widget _buildAutoModelField(_AutoCandidateDraft candidate) {
    final choices = _autoModelChoices(candidate.providerId);
    final known = choices.contains(candidate.model);
    final isCustom =
        _autoCustomModel[candidate.providerId] ??
        (candidate.model.isNotEmpty && !known);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DropdownButtonFormField<String>(
          key: Key('auto-candidate-model-${candidate.providerId}'),
          value: isCustom ? '__custom__' : (known ? candidate.model : ''),
          isExpanded: true,
          dropdownColor: AppColors.panel,
          style: const TextStyle(
            color: AppColors.text,
            fontSize: 12,
            fontFamily: 'monospace',
          ),
          decoration: _sheetInputDecoration(
            hint: '留空跟随 Provider 默认模型',
          ).copyWith(labelText: 'Model'),
          items: [
            const DropdownMenuItem(value: '', child: Text('Provider 默认')),
            for (final choice in choices)
              DropdownMenuItem(
                value: choice,
                child: Text(choice, overflow: TextOverflow.ellipsis),
              ),
            const DropdownMenuItem(value: '__custom__', child: Text('自定义…')),
          ],
          onChanged: (next) => setState(() {
            final custom = next == '__custom__';
            _autoCustomModel[candidate.providerId] = custom;
            final controller = _autoModelCtrl(candidate);
            if (custom) {
              // 现出的文本框从当前存值起步，避免看到上一次留下的旧文本。
              if (controller.text != candidate.model) {
                controller.text = candidate.model;
              }
            } else {
              candidate.model = next ?? '';
              controller.text = candidate.model;
            }
          }),
        ),
        if (isCustom) ...[
          const SizedBox(height: 6),
          TextFormField(
            key: Key('auto-candidate-model-custom-${candidate.providerId}'),
            controller: _autoModelCtrl(candidate),
            style: const TextStyle(
              color: AppColors.text,
              fontSize: 12,
              fontFamily: 'monospace',
            ),
            decoration: _sheetInputDecoration(hint: '模型 ID'),
            onChanged: (value) => candidate.model = value.trim(),
          ),
        ],
      ],
    );
  }

  // Map a stored wire model id (e.g. claude-opus-4-8) back to its alias tier so
  // the tier dropdown pre-selects instead of dropping into the custom-id field.
  String _normalizeModel(String provider, String model) {
    if (model.isEmpty) return model;
    for (final e in _aliasTiers(provider)) {
      if (e.key == model) return model;
      if (e.value['model']?.toString() == model) return e.key;
    }
    return model;
  }

  String _modelLabel(String model) {
    if (model.isEmpty) {
      // Vendor-auth CLIs own their account/model settings, so the hint names the
      // product itself. One branch for all of them: the five ids used to be
      // spelled out here (and again in message.dart's per-CLI model lists).
      if (!widget.cli.supportsProvider) {
        return '默认 / 跟随 ${widget.cli.displayName} 设置';
      }
      return '默认 / 跟随 Provider';
    }
    return modelShortNameForCli(widget.cli, model);
  }

  // Rich dropdown option label. For alias tiers: "opus → claude-opus-4-8 (GLM5.2)".
  String _modelOptionLabel(String provider, String value) {
    if (value.isEmpty) return _modelLabel('');
    for (final e in _aliasTiers(provider)) {
      if (e.key != value) continue;
      final m = e.value['model']?.toString() ?? '';
      final name = e.value['name']?.toString();
      return '${e.key} → $m${(name != null && name.isNotEmpty) ? ' ($name)' : ''}';
    }
    if (_isCodex) return CodexModelsService.labelFor(value);
    return _modelLabel(value);
  }

  // Compact label for the saved config (chip / SnackBar): the provider's real
  // model name (e.g. GLM5.2) for an alias tier, otherwise the plain model label.
  String _modelResultLabel(String provider, String model) {
    if (model.isEmpty) return '默认';
    for (final e in _aliasTiers(provider)) {
      if (e.key != model) continue;
      final name = e.value['name']?.toString();
      if (name != null && name.isNotEmpty) return name;
      return e.value['model']?.toString() ?? model;
    }
    return _modelLabel(model);
  }

  String _effortDescription(String value) {
    if (value.isEmpty) {
      if (!widget.cli.supportsProvider) {
        return 'Default — Follow ${widget.cli.displayName} settings';
      }
      return 'Default — Follow the selected model/provider';
    }
    if (!_isClaude) {
      switch (value) {
        case 'minimal':
          return 'Minimal — Minimal reasoning where supported';
        case 'low':
          return 'Low — Fast responses with lighter reasoning';
        case 'medium':
          return 'Medium — Balances speed and reasoning depth for everyday tasks';
        case 'high':
          return 'High — Greater reasoning depth for complex problems';
        case 'xhigh':
          return 'Extra high — Extra high reasoning depth for complex problems';
      }
    }
    return value;
  }

  void _onProviderChanged(String? value) {
    final next = value ?? '';
    if (next.startsWith('__auto__:')) {
      final groupKey = next.substring('__auto__:'.length);
      final group = _autoGroup(groupKey);
      if (group == null) return;
      setState(() {
        _autoGroupKey = groupKey;
        final managed = group.providers
            .where((provider) => provider['isOfficial'] != true)
            .toList(growable: false);
        final defaultProviders = managed.length >= 2
            ? managed
            : group.providers;
        final defaultEnabled = defaultProviders
            .take(2)
            .map((provider) => provider['id']?.toString() ?? '')
            .toSet();
        _autoCandidates
          ..clear()
          ..addAll(
            group.providers.asMap().entries.map(
              (entry) => _AutoCandidateDraft(
                providerId: entry.value['id']?.toString() ?? '',
                model: '',
                priority: entry.key + 1,
                enabled: defaultEnabled.contains(
                  entry.value['id']?.toString() ?? '',
                ),
              ),
            ),
          );
        _autoMaxAttempts = 2;
        _seededAutoAllowCrossTrust = false;
        final primary = _autoCandidates.firstWhere(
          (candidate) => candidate.enabled,
        );
        _provider = primary.providerId;
        _model = '';
        _customModel = false;
        _customCtrl.clear();
        // 随主的子任务线路跟着换了线，模型候选也换了一批。
        _dropStaleSubModel();
      });
      return;
    }
    final choices = _modelChoices(next);
    setState(() {
      _autoGroupKey = null;
      _autoCandidates.clear();
      _provider = next;
      if (_isCodex && next.isEmpty) {
        _subProvider = '';
        _subModel = '';
        _customSubModel = false;
        _subCustomCtrl.clear();
      }
      if (!choices.contains(_model)) {
        _model = '';
        _customModel = false;
        _customCtrl.clear();
      }
      _dropStaleSubModel();
    });
  }

  void _onSubProviderChanged(String? value) {
    setState(() {
      _subProvider = value ?? '';
      _dropStaleSubModel();
    });
  }

  /// 子任务的生效线路：线路留空 = 随主（用主 Provider，Auto 档下就是排第一的候选）。
  String get _subEffectiveProvider =>
      _subProvider.isEmpty ? _provider : _subProvider;

  /// 线路变了就把不再合法的模型选择丢掉。留着的话下拉显示的是「不设置」，
  /// 提交上去却是上一个线路的模型 —— 两边说的不是一回事。
  void _dropStaleSubModel() {
    if (_customSubModel) return;
    if (_modelChoices(_subEffectiveProvider).contains(_subModel)) return;
    _subModel = '';
    _subCustomCtrl.clear();
  }

  void _submit() {
    SessionProviderSelection? providerSelection;
    var provider = _provider;
    var model = _customModel ? _customCtrl.text.trim() : _model;
    if (_isAuto) {
      final group = _autoGroup(_autoGroupKey);
      final protocol = group?.protocol ?? widget.providerSelection?.protocol;
      // 与档位预览同一份「在用行、按尝试顺序」的列表：两处各排一次的话，
      // 同优先级的行在两条路径上可能落到不同下标，档位就会跟错行。
      final enabled = _autoEnabledOrdered;
      if (protocol == null || protocol.isEmpty || enabled.length < 2) return;
      provider = enabled.first.providerId;
      model = enabled.first.model.trim();
      // 按难度：rung 折算成 t1..tK 随候选一起上 wire，并附上 routing 块。折算失败
      // （只有一档、超过上限）时不出面板 —— 静默存成一个「号称按难度」的单档池
      // 比报错更坏。
      SessionProviderRouting? routing;
      final tierByProvider = <String, String>{};
      if (_autoRoutingEnabled) {
        final plan = _autoRungPlan;
        final result = serializeAutoRouting(
          routes: [
            for (var index = 0; index < enabled.length; index += 1)
              AutoRoutedRoute(
                providerId: enabled[index].providerId,
                model: enabled[index].model.trim().isEmpty
                    ? null
                    : enabled[index].model.trim(),
                priority: enabled[index].priority.clamp(1, 100),
                rung: plan.rungs[index],
              ),
          ],
          onUnknown: _autoRoutingOnUnknown,
          previous: _seededRouting,
        );
        if (!result.ok) {
          setState(() => _autoError = result.error ?? '');
          return;
        }
        routing = result.routing;
        for (final candidate in result.candidates) {
          tierByProvider[candidate.providerId] = candidate.tier!;
        }
      }
      providerSelection = SessionProviderSelection(
        protocol: protocol,
        candidates: _autoCandidates
            .map(
              (candidate) => SessionProviderCandidate(
                providerId: candidate.providerId,
                model: candidate.model.trim().isEmpty
                    ? null
                    : candidate.model.trim(),
                priority: candidate.priority.clamp(1, 100),
                enabled: candidate.enabled,
                // 关掉按难度时档位必须清掉：留着 tier 又没有 routing 的池子，
                // 服务端会当成档位不匹配拒掉。
                tier: candidate.enabled
                    ? tierByProvider[candidate.providerId]
                    : null,
              ),
            )
            .toList(growable: false),
        maxAttempts: _autoMaxAttempts.clamp(2, enabled.length.clamp(2, 4)),
        sticky: _autoSticky,
        allowCrossTrust: _autoAllowsCrossTrust,
        routing: routing,
      );
    }
    // 子任务：模型有值才算数（只选线路不选模型 = 没设）。线路留空时用这一轮
    // 实际生效的主 Provider —— Auto 档下就是排第一的那个启用候选。
    final subProvider = _subProvider.isEmpty ? provider : _subProvider;
    final subModel = _customSubModel ? _subCustomCtrl.text.trim() : _subModel;
    final subagent = subModel.isEmpty
        ? null
        : SessionSubagent(providerId: subProvider, model: subModel);
    Navigator.pop(
      context,
      AIConfigResult(
        provider: provider,
        model: model,
        effort: _effort,
        providerLabel: providerSelection == null
            ? _providerName(provider)
            : 'Auto · ${_protocolLabel(providerSelection.protocol)} → ${_providerName(provider)}',
        modelLabel: _modelResultLabel(provider, model),
        effortLabel: effortShortNameForCli(widget.cli, _effort),
        providerSelection: providerSelection,
        subagent: subagent,
        agent: widget.cli.supportsAgent ? _agentCtrl.text.trim() : null,
      ),
    );
  }

  Widget _buildAutoSection() {
    final enabledCount = _autoCandidates
        .where((candidate) => candidate.enabled)
        .length;
    final maxAllowed = enabledCount.clamp(2, 4);
    if (_autoMaxAttempts > maxAllowed) _autoMaxAttempts = maxAllowed;
    final ordered = [..._autoCandidates]
      ..sort((a, b) => a.priority.compareTo(b.priority));
    final crossesTrust = _autoAllowsCrossTrust;
    return Container(
      key: const Key('auto-provider-section'),
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: const Color(0xFFf4f8fd),
        border: Border.all(color: const Color(0xFFdce6f1)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            'Auto Provider 候选池',
            style: TextStyle(
              color: AppColors.text,
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 4),
          const Text(
            '仅在首个 Provider 无额度或安全可重放的连接错误时切换。',
            style: TextStyle(color: AppColors.faint, fontSize: 11),
          ),
          const SizedBox(height: 8),
          _buildAutoModeRow(),
          if (_autoRoutingEnabled) ...[
            const SizedBox(height: 8),
            _buildAutoJevBox(),
          ],
          const SizedBox(height: 10),
          Row(
            children: [
              Text(
                t('autoEditorListTitle'),
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  _autoRoutingEnabled
                      ? t('autoEditorListHintRouting')
                      : t('autoEditorListHintOrder'),
                  style: const TextStyle(color: AppColors.faint, fontSize: 10.5),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          ...ordered.map((candidate) {
            final provider = _providerMap(candidate.providerId);
            return Container(
              key: Key('auto-candidate-${candidate.providerId}'),
              margin: const EdgeInsets.only(bottom: 8),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: const Color(0xFFf4f8fd),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Column(
                children: [
                  Row(
                    children: [
                      Checkbox(
                        key: Key(
                          'auto-candidate-enabled-${candidate.providerId}',
                        ),
                        value: candidate.enabled,
                        onChanged: (value) => setState(() {
                          candidate.enabled = value == true;
                          final count = _autoCandidates
                              .where((item) => item.enabled)
                              .length;
                          _autoMaxAttempts = _autoMaxAttempts.clamp(
                            2,
                            count.clamp(2, 4),
                          );
                        }),
                      ),
                      Expanded(
                        child: ProviderOption(
                          main: _providerName(candidate.providerId),
                          detail: providerLimitDetail(provider),
                        ),
                      ),
                      const SizedBox(width: 8),
                      SizedBox(
                        width: 64,
                        child: TextFormField(
                          key: Key(
                            'auto-candidate-priority-${candidate.providerId}',
                          ),
                          initialValue: '${candidate.priority}',
                          keyboardType: TextInputType.number,
                          style: const TextStyle(
                            color: AppColors.text,
                            fontSize: 12,
                          ),
                          decoration: _sheetInputDecoration(
                            hint: '优先级',
                          ).copyWith(labelText: '优先级'),
                          onChanged: (value) {
                            final parsed = int.tryParse(value);
                            if (parsed != null) {
                              candidate.priority = parsed.clamp(1, 100);
                            }
                          },
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  _buildAutoModelField(candidate),
                  if (_autoRoutingEnabled && candidate.enabled) ...[
                    const SizedBox(height: 6),
                    _buildAutoTierRow(candidate),
                  ],
                ],
              ),
            );
          }),
          const SizedBox(height: 4),
          _buildAutoSummary(),
          if (crossesTrust)
            const Text(
              '已选择 Official 与自管 Provider：同一对话上下文可能在自动切换时发送给多个上游。',
              key: Key('auto-provider-cross-trust-warning'),
              style: TextStyle(color: Color(0xFFa85a25), fontSize: 11),
            ),
          if (enabledCount < 2)
            const Text(
              '至少启用两个候选 Provider',
              key: Key('auto-provider-validation'),
              style: TextStyle(color: AppColors.danger, fontSize: 11),
            ),
          const SizedBox(height: 4),
          Row(
            children: [
              const Expanded(
                child: Text(
                  '最多尝试次数',
                  style: TextStyle(color: AppColors.faint, fontSize: 12),
                ),
              ),
              DropdownButton<int>(
                key: const Key('auto-provider-max-attempts'),
                value: _autoMaxAttempts,
                dropdownColor: AppColors.panel,
                items: [
                  for (var value = 2; value <= maxAllowed; value += 1)
                    DropdownMenuItem(value: value, child: Text('$value')),
                ],
                onChanged: (value) =>
                    setState(() => _autoMaxAttempts = value ?? 2),
              ),
            ],
          ),
          SwitchListTile.adaptive(
            key: const Key('auto-provider-sticky'),
            contentPadding: EdgeInsets.zero,
            dense: true,
            title: const Text(
              '成功后优先复用该 Provider',
              style: TextStyle(color: AppColors.text, fontSize: 12),
            ),
            value: _autoSticky,
            onChanged: (value) => setState(() => _autoSticky = value),
          ),
          if (_autoRoutingEnabled)
            Row(
              children: [
                const Expanded(
                  child: Text(
                    '判断不了难度时（Jev 超时或没连上）',
                    style: TextStyle(color: AppColors.faint, fontSize: 11),
                  ),
                ),
                DropdownButton<String>(
                  key: const Key('auto-provider-jev-unknown'),
                  value: _autoRoutingOnUnknown,
                  dropdownColor: AppColors.panel,
                  style: const TextStyle(color: AppColors.text, fontSize: 12),
                  items: [
                    for (final choice in kAutoUnknownChoices)
                      DropdownMenuItem(
                        value: choice.$1,
                        child: Text(t(choice.$2)),
                      ),
                  ],
                  onChanged: (value) => setState(
                    () => _autoRoutingOnUnknown = value ?? 'strong',
                  ),
                ),
              ],
            ),
          if (_autoError.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                _autoError,
                key: const Key('auto-provider-error'),
                style: const TextStyle(color: AppColors.danger, fontSize: 11),
              ),
            ),
        ],
      ),
    );
  }

  /// 「怎么选线路」——第一个决定，一次点击切过去（与 web 的 mode 段同一套文案）。
  Widget _buildAutoModeRow() {
    final order = !_autoRoutingEnabled;
    Widget option({
      required Key key,
      required String label,
      required bool selected,
      required VoidCallback onTap,
    }) {
      return InkWell(
        key: key,
        onTap: onTap,
        borderRadius: BorderRadius.circular(5),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          decoration: BoxDecoration(
            color: selected
                ? AppColors.accent.withValues(alpha: 0.12)
                : const Color(0xFFeef4fb),
            border: Border.all(
              color: selected ? AppColors.accent : const Color(0xFFdce6f1),
            ),
            borderRadius: BorderRadius.circular(5),
          ),
          child: Text(
            label,
            style: TextStyle(
              color: selected ? AppColors.accent : AppColors.muted,
              fontSize: 12,
              fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
            ),
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Wrap 而不是 Row：窄一点的面板（或者长一点的译文）不该把这一行挤爆，
        // 挤不下就换行。
        Wrap(
          spacing: 6,
          runSpacing: 4,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              t('autoEditorModeLabel'),
              style: const TextStyle(color: AppColors.faint, fontSize: 11),
            ),
            const SizedBox(width: 2),
            option(
              key: const Key('auto-route-mode-order'),
              label: t('autoEditorModeOrder'),
              selected: order,
              onTap: () => _setAutoRouting(false),
            ),
            option(
              key: const Key('auto-route-mode-routing'),
              label: t('autoEditorModeRouting'),
              selected: !order,
              onTap: () => _setAutoRouting(true),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          order
              ? t('autoEditorModeOrderDetail')
              : t('autoEditorModeRoutingDetail'),
          style: const TextStyle(color: AppColors.muted, fontSize: 11, height: 1.35),
        ),
      ],
    );
  }

  /// 一行负责简单还是复杂任务。手点过就定住，没点过的按模型名（flash/mini 之流
  /// 归简单）猜一个，用户随时能改。
  Widget _buildAutoTierRow(_AutoCandidateDraft candidate) {
    final plan = _autoRungPlan;
    final current = _autoEffectiveRung(candidate);
    return Row(
      key: Key('auto-candidate-tier-${candidate.providerId}'),
      children: [
        const SizedBox(width: 2),
        for (var rung = 1; rung <= plan.ceiling; rung += 1) ...[
          Tooltip(
            message: autoTierLabel(rung, plan.ceiling),
            child: InkWell(
              key: Key('auto-candidate-tier-${candidate.providerId}-$rung'),
              // 用户一动档位就把上一次的报错收掉：他正在解决的就是那件事。
              onTap: () => setState(() {
                candidate.rung = rung;
                _autoError = '';
              }),
              borderRadius: BorderRadius.circular(4),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                margin: const EdgeInsets.only(right: 5),
                decoration: BoxDecoration(
                  color: current == rung
                      ? AppColors.accent.withValues(alpha: 0.14)
                      : const Color(0xFFeef4fb),
                  border: Border.all(
                    color: current == rung
                        ? AppColors.accent
                        : const Color(0xFFdce6f1),
                  ),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(
                  autoTierChip(rung, plan.ceiling),
                  style: TextStyle(
                    color: current == rung ? AppColors.accent : AppColors.muted,
                    fontSize: 11,
                    fontWeight: current == rung
                        ? FontWeight.w600
                        : FontWeight.w400,
                  ),
                ),
              ),
            ),
          ),
        ],
      ],
    );
  }

  /// 一句话说清这个池子会怎么走（两种模式各一句，与 web 的 renderSummary 同源）。
  Widget _buildAutoSummary() {
    final rows = _autoEnabledOrdered;
    final style = const TextStyle(color: AppColors.muted, fontSize: 11, height: 1.35);
    if (rows.length < 2) {
      return Text(
        t('autoEditorSummaryNeedTwo'),
        key: const Key('auto-provider-summary'),
        style: style.copyWith(color: AppColors.danger),
      );
    }
    if (!_autoRoutingEnabled) {
      return Text(
        t('autoEditorSummaryOrder', {
          'chain': rows
              .map(_autoRowText)
              .join(t('autoEditorSummaryThen')),
        }),
        key: const Key('auto-provider-summary'),
        style: style,
      );
    }
    final plan = _autoRungPlan;
    final groups = <int, List<String>>{};
    for (var index = 0; index < rows.length; index += 1) {
      groups.putIfAbsent(plan.rungs[index], () => []).add(_autoRowText(rows[index]));
    }
    if (groups.length < 2) {
      return Text(
        t('autoEditorSummaryNeedSplit'),
        key: const Key('auto-provider-summary'),
        style: style.copyWith(color: AppColors.danger),
      );
    }
    final rungs = groups.keys.toList()..sort();
    return Text(
      t('autoEditorSummaryRouting', {
        'routes': [
          for (final rung in rungs)
            '${autoTierLabel(rung, plan.ceiling)} → ${groups[rung]!.join('、')}',
        ].join('；'),
      }),
      key: const Key('auto-provider-summary'),
      style: style,
    );
  }

  /// Jev key 那一条：状态 + 测试/更换 + 粘贴表单。没有 [AIConfigSheet.settings]
  /// 时只说 key 存在哪个保险箱条目里（与 web 的无 routingKey 分支一致）。
  Widget _buildAutoJevBox() {
    final hostOwned = widget.settings != null;
    final present = _jevState == 'present';
    String status;
    var detail = '';
    if (!hostOwned) {
      status = t('autoEditorJevTitle');
      detail = t('autoEditorJevKeyVaultOnly', {'name': _jevKeyName});
    } else if (_jevState == 'checking' || _jevState == 'unknown') {
      status = t('autoEditorJevKeyChecking');
    } else if (present) {
      status = t('autoEditorJevKeyPresent');
      detail = t('autoEditorJevKeyPresentDetail', {'name': _jevKeyName});
    } else if (_jevState == 'missing') {
      status = t('autoEditorJevKeyMissing');
      detail = t('autoEditorJevKeyMissingDetail');
    } else {
      status = t('autoEditorJevKeyCheckFailed');
      detail = t('autoEditorJevKeyCheckFailedDetail');
    }
    final formVisible =
        hostOwned && (_jevFormOpen || _jevState == 'missing' || _jevState == 'error');
    return Container(
      key: const Key('auto-provider-jev'),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: const Color(0xFFeef4fb),
        border: Border.all(color: const Color(0xFFdce6f1)),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                width: 7,
                height: 7,
                margin: const EdgeInsets.only(right: 6),
                decoration: BoxDecoration(
                  color: present ? const Color(0xFF2ea043) : AppColors.faint,
                  shape: BoxShape.circle,
                ),
              ),
              Text(
                status,
                key: const Key('auto-jev-status'),
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  detail,
                  style: const TextStyle(color: AppColors.faint, fontSize: 10.5),
                ),
              ),
              if (hostOwned && present)
                TextButton(
                  key: const Key('auto-jev-test'),
                  onPressed: _runJevTest,
                  style: TextButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    minimumSize: const Size(36, 26),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: Text(t('autoEditorJevTest'), style: const TextStyle(fontSize: 11)),
                ),
              if (hostOwned && present)
                TextButton(
                  key: const Key('auto-jev-key-change'),
                  onPressed: () => setState(() => _jevFormOpen = !_jevFormOpen),
                  style: TextButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    minimumSize: const Size(36, 26),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: Text(
                    _jevFormOpen
                        ? t('autoEditorJevKeyCancel')
                        : t('autoEditorJevKeyChange'),
                    style: const TextStyle(fontSize: 11),
                  ),
                ),
            ],
          ),
          if (hostOwned && _jevState == 'missing') ...[
            const SizedBox(height: 4),
            Text(
              '1. ${t('autoEditorJevStepCreate')}',
              style: const TextStyle(color: AppColors.muted, fontSize: 11, height: 1.4),
            ),
            Text(
              '2. ${t('autoEditorJevStepPaste')}',
              style: const TextStyle(color: AppColors.muted, fontSize: 11, height: 1.4),
            ),
          ],
          if (formVisible) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    key: const Key('auto-jev-key-input'),
                    controller: _jevKeyCtrl,
                    obscureText: true,
                    autocorrect: false,
                    enableSuggestions: false,
                    style: const TextStyle(color: AppColors.text, fontSize: 12),
                    decoration: _sheetInputDecoration(
                      hint: t('autoEditorJevKeyPlaceholder'),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  key: const Key('auto-jev-key-save'),
                  onPressed: _jevSaving ? null : _saveJevKey,
                  child: Text(t('autoEditorJevKeySave')),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              t('autoEditorJevKeyHelp', {'name': _jevKeyName}),
              style: const TextStyle(color: AppColors.faint, fontSize: 10.5, height: 1.35),
            ),
          ],
          if (_jevResult.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                _jevResult,
                key: const Key('auto-jev-result'),
                style: TextStyle(
                  color: _jevResultGood
                      ? const Color(0xFF2ea043)
                      : const Color(0xFFa85a25),
                  fontSize: 11,
                  height: 1.35,
                ),
              ),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final modelChoices = _modelChoices(_provider);
    final autoGroups = _autoGroups;
    final providerIds = widget.providers
        .map((p) => p['id']?.toString() ?? '')
        .toSet();
    final includeCurrentProvider =
        _provider.isNotEmpty && !providerIds.contains(_provider);
    final providerValue = _isAuto ? '__auto__:$_autoGroupKey' : _provider;
    final includeCurrentAuto = _isAuto && _autoGroup(_autoGroupKey) == null;
    final modelValue = _customModel
        ? '__custom__'
        : (modelChoices.contains(_model) ? _model : '');
    // Sub-task (subagent) tail: 线路 + 模型 的候选都跟着生效线路走 —— 线路留空
    // 就是「随主」，此时模型候选与主 Model 完全同源。
    final subModelChoices = _modelChoices(
      _subEffectiveProvider,
    ).where((m) => m.isNotEmpty).toList();
    final subModelValue = _customSubModel
        ? '__custom__'
        : (subModelChoices.contains(_subModel) ? _subModel : '');
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.only(
          left: 18,
          right: 18,
          top: 16,
          bottom: 18 + MediaQuery.of(context).viewInsets.bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'AI 配置（${widget.cli.supportsProvider ? 'Provider / ' : ''}Model${widget.cli.supportsEffort ? ' / ${widget.cli.effortFieldLabel}' : ''}）',
              style: const TextStyle(
                color: AppColors.text,
                fontSize: 15,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 14),
            if (widget.cli.supportsProvider) ...[
              const Text(
                'Provider',
                style: TextStyle(color: AppColors.faint, fontSize: 12),
              ),
              const SizedBox(height: 5),
              DropdownButtonFormField<String>(
                value: providerValue,
                isExpanded: true,
                dropdownColor: AppColors.panel,
                decoration: _sheetInputDecoration(),
                style: const TextStyle(color: AppColors.text, fontSize: 13),
                items: [
                  if (!widget.providers.any(
                    (p) =>
                        p['builtinOfficial'] == true &&
                        p['id'] == '${widget.cli.poolKey}-official',
                  ))
                    const DropdownMenuItem(
                      value: '',
                      child: Text('官方 Provider'),
                    ),
                  ...autoGroups.map(
                    (group) => DropdownMenuItem(
                      value: '__auto__:${group.key}',
                      child: Text('⚡ Auto · ${_protocolLabel(group.protocol)}'),
                    ),
                  ),
                  if (includeCurrentAuto)
                    DropdownMenuItem(
                      value: providerValue,
                      child: Text(
                        '⚡ Auto · ${_protocolLabel(widget.providerSelection?.protocol ?? '')}',
                      ),
                    ),
                  if (includeCurrentProvider)
                    DropdownMenuItem(
                      value: _provider,
                      child: Text(
                        _provider,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ...widget.providers.map(
                    (p) => DropdownMenuItem(
                      value: p['id']?.toString() ?? '',
                      child: ProviderOption(
                        main:
                            '${p['name'] ?? p['id']}${p['model'] != null && p['model'].toString().isNotEmpty ? ' · ${p['model']}' : ''}',
                        detail: providerLimitDetail(p),
                      ),
                    ),
                  ),
                ],
                onChanged: _onProviderChanged,
              ),
              if (_isAuto) _buildAutoSection(),
              const SizedBox(height: 12),
            ] else ...[
              const Text(
                'Qoder CN 使用自身账号 / BYOK 配置',
                style: TextStyle(color: AppColors.faint, fontSize: 12),
              ),
              const SizedBox(height: 12),
            ],
            if (!_isAuto) ...[
              const Text(
                'Model',
                style: TextStyle(color: AppColors.faint, fontSize: 12),
              ),
              const SizedBox(height: 5),
              DropdownButtonFormField<String>(
                value: modelValue,
                dropdownColor: AppColors.panel,
                decoration: _sheetInputDecoration(),
                style: const TextStyle(color: AppColors.text, fontSize: 13),
                items: [
                  ...modelChoices.map(
                    (m) => DropdownMenuItem(
                      value: m,
                      child: Text(_modelOptionLabel(_provider, m)),
                    ),
                  ),
                  const DropdownMenuItem(
                    value: '__custom__',
                    child: Text('自定义…'),
                  ),
                ],
                onChanged: (v) {
                  setState(() {
                    _customModel = v == '__custom__';
                    if (!_customModel) _model = v ?? '';
                  });
                },
              ),
              if (_isCodex &&
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
                  decoration: _sheetInputDecoration(
                    hint: _isClaude ? 'claude-opus-4-8' : '模型 ID',
                  ),
                ),
              ],
            ],
            if (widget.cli.supportsSubagent) ...[
              const SizedBox(height: 10),
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
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
                      key: const Key('subagent-provider'),
                      value: _subProvider,
                      isExpanded: true,
                      dropdownColor: AppColors.panel,
                      decoration: _sheetInputDecoration(),
                      style: const TextStyle(
                        color: AppColors.text,
                        fontSize: 13,
                      ),
                      items: [
                        const DropdownMenuItem(value: '', child: Text('随主')),
                        ...widget.providers
                            .where(
                              (p) => !(_isCodex && p['isOfficial'] == true),
                            )
                            .map(
                              (p) => DropdownMenuItem(
                                value: p['id']?.toString() ?? '',
                                child: ProviderOption(
                                  main:
                                      '${p['name'] ?? p['id']}${p['model'] != null && p['model'].toString().isNotEmpty ? ' · ${p['model']}' : ''}',
                                  detail: providerLimitDetail(p),
                                ),
                              ),
                            ),
                      ],
                      onChanged: _onSubProviderChanged,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: DropdownButtonFormField<String>(
                      key: const Key('subagent-model'),
                      value: subModelValue,
                      isExpanded: true,
                      dropdownColor: AppColors.panel,
                      decoration: _sheetInputDecoration(),
                      style: const TextStyle(
                        color: AppColors.text,
                        fontSize: 13,
                      ),
                      items: [
                        const DropdownMenuItem(value: '', child: Text('不设置')),
                        ...subModelChoices.map(
                          (m) => DropdownMenuItem(
                            value: m,
                            child: Text(
                              _modelOptionLabel(_subEffectiveProvider, m),
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
                      },
                    ),
                  ),
                ],
              ),
              if (_customSubModel) ...[
                const SizedBox(height: 6),
                TextField(
                  controller: _subCustomCtrl,
                  autofocus: true,
                  style: const TextStyle(
                    color: AppColors.text,
                    fontSize: 13,
                    fontFamily: 'monospace',
                  ),
                  decoration: _sheetInputDecoration(hint: '模型 ID'),
                ),
              ],
            ],
            if (widget.cli.supportsEffort) ...[
              const SizedBox(height: 12),
              Text(
                widget.cli.effortFieldLabel,
                style: const TextStyle(color: AppColors.faint, fontSize: 12),
              ),
              const SizedBox(height: 5),
              DropdownButtonFormField<String>(
                value: _effort,
                isExpanded: true,
                dropdownColor: AppColors.panel,
                decoration: _sheetInputDecoration(),
                style: const TextStyle(color: AppColors.text, fontSize: 13),
                items: _validEfforts
                    .map(
                      (e) => DropdownMenuItem(
                        value: e,
                        child: Text(
                          _effortDescription(e),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    )
                    .toList(),
                onChanged: (v) => setState(() => _effort = v ?? _defaultEffort),
              ),
            ],
            if (widget.cli.supportsAgent) ...[
              const Divider(height: 32),
              Text(
                '${widget.cli.displayName} Agent',
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 5),
              TextField(
                controller: _agentCtrl,
                maxLength: 80,
                style: const TextStyle(color: AppColors.text, fontSize: 13),
                decoration: _sheetInputDecoration(
                  hint: widget.cli == SessionCli.opencode
                      ? '例如 build；留空使用默认 agent'
                      : '已定义的 agent 名称；留空使用默认 agent',
                ).copyWith(counterText: ''),
              ),
            ],
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('取消'),
                ),
                const SizedBox(width: 8),
                ElevatedButton(
                  onPressed:
                      !_isAuto ||
                          _autoCandidates
                                  .where((candidate) => candidate.enabled)
                                  .length >=
                              2
                      ? _submit
                      : null,
                  child: const Text('保存'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// 打开 AI 配置面板之前要备好的两样东西：这个 CLI 的 Provider 池，和它的模型
/// 清单。面板里的下拉直接读这些，不自己去拉 —— 所以每个开关面板的地方都得先
/// 过这里一次，Air 那边给新任务选线路时也一样。
Future<List<Map<String, dynamic>>> prepareAIConfigInputs(
  SettingsService settings,
  SessionCli cli, {
  http.Client? httpClient,
}) async {
  // Qoder owns no provider pool; its model list comes from the host CLI's
  // catalog instead. Warm it before the sheet builds so the dropdown opens on
  // the real models rather than the routing-tier fallback. Claude's list comes
  // from the installed CLI bundle — same warm-up, static-table fallback.
  if (cli == SessionCli.qoder) {
    try {
      await QoderModelsService(settings: settings).load();
    } catch (_) {}
  } else if (cli.isClaudeFamily) {
    try {
      await ClaudeModelsService(settings: settings).load();
    } catch (_) {}
  } else if (cli.isCodexFamily) {
    try {
      // Cache-first. A forced network refresh on every tap made opening this
      // sheet wait for the Codex model endpoint (up to 20 seconds).
      await CodexModelsService(settings: settings).load();
    } catch (_) {}
  }
  try {
    if (cli.supportsProvider) {
      final d = await ManageService(
        settings: settings,
        httpClient: httpClient,
      ).fetchProviders(cli.appType);
      return (d['providers'] as List? ?? [])
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();
    }
  } catch (_) {}
  return const [];
}

class _AIConfigInputBundle {
  const _AIConfigInputBundle(this.runtime, this.providers);
  final SessionCliConfig runtime;
  final List<Map<String, dynamic>> providers;
}

Future<_AIConfigInputBundle> _loadAIConfigInputs(
  SessionManager manager,
  SettingsService settings,
  String sessionId, {
  http.Client? httpClient,
}) async {
  final runtime = await manager.fetchSessionCliConfig(sessionId);
  final providers = await prepareAIConfigInputs(
    settings,
    runtime.cli,
    httpClient: httpClient,
  );
  return _AIConfigInputBundle(runtime, providers);
}

class _AIConfigSheetLoader extends StatelessWidget {
  const _AIConfigSheetLoader({
    required this.future,
    this.settings,
    this.httpClient,
  });
  final Future<_AIConfigInputBundle> future;
  final SettingsService? settings;
  final http.Client? httpClient;

  @override
  Widget build(BuildContext context) => FutureBuilder<_AIConfigInputBundle>(
    future: future,
    builder: (context, snapshot) {
      final bundle = snapshot.data;
      if (bundle != null) {
        final runtime = bundle.runtime;
        return AIConfigSheet(
          cli: runtime.cli,
          providers: bundle.providers,
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
      if (snapshot.hasError) {
        return SafeArea(
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
      // The route is already visible while the session/catalog requests run.
      // This makes a tap respond in the next frame even on a slow phone or a
      // cold Codex model cache.
      return const SafeArea(
        child: SizedBox(
          key: ValueKey('ai-config-loading'),
          height: 180,
          child: Center(child: CircularProgressIndicator()),
        ),
      );
    },
  );
}

/// Open the per-session AI-config sheet for [sessionId] (used by both the
/// header ModelChip and the InputBar subagent pill). Fetches the provider list
/// fresh, seeds the sheet from the current session (incl. subagent override),
/// and PATCHes provider+model+effort+subagent on save.
Future<void> openAIConfigSheet(
  BuildContext context, {
  required SettingsService settings,
  required String sessionId,
  http.Client? httpClient,
}) async {
  final mgr = context.read<SessionManager>();
  final messenger = ScaffoldMessenger.of(context);
  // Start I/O and present the route in the same frame. The old path awaited
  // both requests (including a forced Codex refresh) before opening anything.
  final inputFuture = _loadAIConfigInputs(
    mgr,
    settings,
    sessionId,
    httpClient: httpClient,
  );
  final picked = await showModalBottomSheet<AIConfigResult>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.panel,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (_) => _AIConfigSheetLoader(
      future: inputFuture,
      settings: settings,
      httpClient: httpClient,
    ),
  );
  if (picked == null) return;
  try {
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
    final summary = [picked.providerLabel, picked.modelLabel];
    if (picked.effortLabel.isNotEmpty) summary.add(picked.effortLabel);
    messenger.showSnackBar(
      SnackBar(content: Text('✓ AI 配置已保存：${summary.join(' | ')}，下一轮对话生效')),
    );
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text('AI 配置保存失败：$e')));
  }
}

InputDecoration _sheetInputDecoration({String? hint}) {
  return InputDecoration(
    hintText: hint,
    hintStyle: const TextStyle(color: AppColors.faint),
    filled: true,
    fillColor: const Color(0xFFf4f8fd),
    isDense: true,
    contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(6)),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(6),
      borderSide: const BorderSide(color: Color(0xFFdce6f1)),
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(6),
      borderSide: const BorderSide(color: AppColors.accent),
    ),
  );
}

// Multi-line role-prompt editor dialog. Returns the new text, or null on cancel.
// [settings] enables the preset picker (small chip strip + full browser). When
// omitted the editor degrades to a plain text field.
Future<String?> showRolePromptEditor(
  BuildContext context, {
  required String current,
  SettingsService? settings,
}) {
  return showDialog<String>(
    context: context,
    builder: (ctx) =>
        RolePromptEditorDialog(current: current, settings: settings),
  );
}

// Stateful editor dialog: a preset area sits above the free-text field. The
// preset area lazily loads the index, renders the featured presets as a
// horizontally scrollable chip strip, and exposes a "browse all" entry that
// opens [AgentPresetPickerSheet]. Picking a preset fetches its prompt and fills
// the text field (confirming first when the field is non-empty).
class RolePromptEditorDialog extends StatefulWidget {
  final String current;
  final SettingsService? settings;
  const RolePromptEditorDialog({
    super.key,
    required this.current,
    this.settings,
  });

  @override
  State<RolePromptEditorDialog> createState() => RolePromptEditorDialogState();
}

class RolePromptEditorDialogState extends State<RolePromptEditorDialog> {
  late final TextEditingController _controller;
  AgentPresetService? _svc;
  AgentPresetIndex? _index;
  bool _loadingIndex = false;
  String? _indexError;
  bool _applying = false; // fetching a prompt to fill the field

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.current);
    if (widget.settings != null) {
      _svc = AgentPresetService(settings: widget.settings!);
      _loadIndex();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _loadIndex({bool forceRefresh = false}) async {
    if (_svc == null) return;
    setState(() {
      _loadingIndex = true;
      _indexError = null;
    });
    try {
      final idx = await _svc!.fetchIndex(forceRefresh: forceRefresh);
      if (!mounted) return;
      setState(() {
        _index = idx;
        _loadingIndex = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _indexError = '$e';
        _loadingIndex = false;
      });
    }
  }

  // Fetch the prompt for [id] and put it in the field. If the field already has
  // content, confirm a replace first.
  Future<void> _applyPreset(String id) async {
    if (_svc == null || _applying) return;
    if (_controller.text.trim().isNotEmpty) {
      final ok = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          backgroundColor: AppColors.panel2,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: const BorderSide(color: AppColors.line),
          ),
          title: const Text(
            '替换当前内容?',
            style: TextStyle(color: AppColors.text, fontSize: 15),
          ),
          content: const Text(
            '文本框已有内容，使用该模板会覆盖现有文字。',
            style: TextStyle(color: AppColors.muted, fontSize: 13),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(c, false),
              child: const Text('取消', style: TextStyle(color: AppColors.muted)),
            ),
            TextButton(
              onPressed: () => Navigator.pop(c, true),
              child: const Text(
                '替换',
                style: TextStyle(color: AppColors.danger),
              ),
            ),
          ],
        ),
      );
      if (ok != true) return;
    }
    setState(() => _applying = true);
    try {
      final prompt = await _svc!.fetchPrompt(id);
      if (!mounted) return;
      setState(() {
        _controller.text = prompt;
        _applying = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _applying = false);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('模板加载失败：$e')));
    }
  }

  Future<void> _browseAll() async {
    if (_svc == null) return;
    final id = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => AgentPresetPickerSheet(service: _svc!, index: _index),
    );
    if (id != null && id.isNotEmpty) {
      await _applyPreset(id);
    }
  }

  Widget _presetArea() {
    if (_svc == null) return const SizedBox.shrink();
    Widget body;
    if (_loadingIndex && _index == null) {
      body = const Padding(
        padding: EdgeInsets.symmetric(vertical: 10),
        child: SizedBox(
          height: 16,
          width: 16,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            color: AppColors.accent,
          ),
        ),
      );
    } else if (_indexError != null && _index == null) {
      body = Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            const Expanded(
              child: Text(
                '模板加载失败',
                style: TextStyle(color: AppColors.danger, fontSize: 12),
              ),
            ),
            TextButton(
              onPressed: () => _loadIndex(forceRefresh: true),
              style: TextButton.styleFrom(
                minimumSize: const Size(0, 28),
                padding: const EdgeInsets.symmetric(horizontal: 8),
              ),
              child: const Text(
                '重试',
                style: TextStyle(color: AppColors.accent, fontSize: 12),
              ),
            ),
          ],
        ),
      );
    } else {
      final featured = _index?.featuredPresets ?? const <AgentPreset>[];
      body = SizedBox(
        height: 34,
        child: featured.isEmpty
            ? const Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  '暂无推荐模板',
                  style: TextStyle(color: AppColors.faint, fontSize: 12),
                ),
              )
            : ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: featured.length,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (_, i) {
                  final p = featured[i];
                  return PresetChip(
                    preset: p,
                    onTap: _applying ? null : () => _applyPreset(p.id),
                  );
                },
              ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Text(
              '预设角色',
              style: TextStyle(color: AppColors.muted, fontSize: 12),
            ),
            const Spacer(),
            TextButton(
              onPressed: _browseAll,
              style: TextButton.styleFrom(
                minimumSize: const Size(0, 28),
                padding: const EdgeInsets.symmetric(horizontal: 6),
              ),
              child: const Text(
                '浏览全部模板 →',
                style: TextStyle(color: AppColors.accent, fontSize: 12),
              ),
            ),
          ],
        ),
        body,
        const SizedBox(height: 8),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppColors.panel2,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: AppColors.line),
      ),
      title: Row(
        children: [
          const Text(
            '角色提示词',
            style: TextStyle(color: AppColors.text, fontSize: 16),
          ),
          if (_applying) ...[
            const SizedBox(width: 10),
            const SizedBox(
              height: 14,
              width: 14,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: AppColors.accent,
              ),
            ),
          ],
        ],
      ),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _presetArea(),
            TextField(
              controller: _controller,
              maxLines: 9,
              minLines: 5,
              maxLength: 40000,
              autofocus: false,
              style: const TextStyle(color: AppColors.text, fontSize: 13),
              decoration: const InputDecoration(
                hintText:
                    '例如：你是开发保姆，被触发时用 multicc-trigger skill 检查 git 改动并提醒提交和测试，不要擅自改代码。',
                hintStyle: TextStyle(color: Color(0xFF6f8096), fontSize: 12),
                enabledBorder: OutlineInputBorder(
                  borderSide: BorderSide(color: AppColors.line),
                ),
                focusedBorder: OutlineInputBorder(
                  borderSide: BorderSide(color: AppColors.accentDark),
                ),
              ),
            ),
            const Text(
              '留空＝清除（会话将继承工作区默认角色）',
              style: TextStyle(color: AppColors.muted, fontSize: 11),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('取消', style: TextStyle(color: AppColors.muted)),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, _controller.text),
          child: const Text('保存', style: TextStyle(color: Color(0xFF2ba67a))),
        ),
      ],
    );
  }
}

// A compact featured-preset chip: emoji + name, outlined with the category
// color. Used in the small preset strip inside the editor.
class PresetChip extends StatelessWidget {
  final AgentPreset preset;
  final VoidCallback? onTap;
  const PresetChip({super.key, required this.preset, this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = preset.accentColor;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: c.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: c.withValues(alpha: 0.55)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (preset.emoji.isNotEmpty) ...[
                Text(preset.emoji, style: const TextStyle(fontSize: 13)),
                const SizedBox(width: 6),
              ],
              Text(
                preset.name,
                style: TextStyle(
                  color: AppColors.text,
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
