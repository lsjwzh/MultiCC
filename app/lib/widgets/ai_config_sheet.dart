// AI 配置底部面板（provider/model/effort/agent/subagent + 角色提示词编辑）。自 chat_screen.dart 抽出。
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../models/agent_preset.dart';
import '../models/message.dart';
import '../models/provider_limit_label.dart';
import '../providers/session_manager.dart';
import 'agent_preset_picker_sheet.dart';
import 'provider_option.dart';
import '../services/agent_preset_service.dart';
import '../services/manage_service.dart';
import '../services/claude_models_service.dart';
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
    required this.official,
    required this.providers,
  });

  final String key;
  final String protocol;
  final bool official;
  final List<Map<String, dynamic>> providers;
}

class _AutoCandidateDraft {
  _AutoCandidateDraft({
    required this.providerId,
    required this.model,
    required this.priority,
    required this.enabled,
  });

  final String providerId;
  String model;
  int priority;
  bool enabled;
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
  bool _customModel = false;
  late final TextEditingController _customCtrl;
  late final TextEditingController _agentCtrl;
  // Sub-task (subagent) cascade — same shape as the main provider/model.
  late String _subProvider;
  late String _subModel;
  bool _customSubModel = false;
  late final TextEditingController _subCustomCtrl;

  bool get _isClaude => widget.cli == SessionCli.claude;
  bool get _isCodex => widget.cli == SessionCli.codex;
  bool get _isQoder => widget.cli == SessionCli.qoder;
  String get _defaultEffort => widget.cli.defaultEffort;

  @override
  void initState() {
    super.initState();
    _provider = widget.cli.supportsProvider ? widget.provider : '';
    _model = _normalizeModel(_provider, widget.model);
    _effort = _validEfforts.contains(widget.effort)
        ? widget.effort
        : _defaultEffort;
    final known = _modelChoices(_provider).contains(_model);
    _customModel = _model.isNotEmpty && !known;
    _customCtrl = TextEditingController(text: _customModel ? _model : '');
    _seedAutoSelection(widget.providerSelection);
    _agentCtrl = TextEditingController(text: widget.agent ?? '');
    // Sub-task seeding.
    _subProvider = widget.subProviderId ?? '';
    _subModel = _normalizeModel(_subProvider, widget.subModel ?? '');
    final subKnown =
        _subProvider.isNotEmpty &&
        _modelChoices(_subProvider).contains(_subModel);
    _customSubModel =
        _subProvider.isNotEmpty && _subModel.isNotEmpty && !subKnown;
    _subCustomCtrl = TextEditingController(
      text: _customSubModel ? _subModel : '',
    );
  }

  @override
  void dispose() {
    _customCtrl.dispose();
    _agentCtrl.dispose();
    _subCustomCtrl.dispose();
    super.dispose();
  }

  List<String> get _validEfforts => widget.cli.effortOptions;
  bool get _isAuto => _autoGroupKey != null;

  static String _autoKey(String protocol, bool official) =>
      '$protocol:${official ? 'official' : 'user-managed'}';

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
      final key = _autoKey(protocol, provider['isOfficial'] == true);
      grouped.putIfAbsent(key, () => []).add(provider);
    }
    return grouped.entries
        .where((entry) => entry.value.length >= 2)
        .map((entry) {
          final separator = entry.key.lastIndexOf(':');
          final protocol = entry.key.substring(0, separator);
          return _AutoProviderGroup(
            key: entry.key,
            protocol: protocol,
            official: entry.key.endsWith(':official'),
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
    final firstId = selection.candidates.first.providerId;
    final first = _providerMap(firstId);
    final official = first?['isOfficial'] == true;
    _autoGroupKey = _autoKey(selection.protocol, official);
    _autoCandidates
      ..clear()
      ..addAll(
        selection.candidates.map(
          (candidate) => _AutoCandidateDraft(
            providerId: candidate.providerId,
            model: candidate.model ?? '',
            priority: candidate.priority,
            enabled: candidate.enabled,
          ),
        ),
      );
    _autoMaxAttempts = selection.maxAttempts;
    _autoSticky = selection.sticky;
    final enabled =
        _autoCandidates.where((candidate) => candidate.enabled).toList()
          ..sort((a, b) => a.priority.compareTo(b.priority));
    if (enabled.isNotEmpty) {
      _provider = enabled.first.providerId;
      _model = _normalizeModel(_provider, enabled.first.model);
    }
  }

  Map<String, dynamic>? _providerMap(String id) {
    for (final p in widget.providers) {
      if (p['id'] == id) return p;
    }
    return null;
  }

  String _providerName(String id) {
    if (_isQoder) return 'Qoder CN';
    if (id.isEmpty) return '默认登录';
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
    return _isClaude ? ClaudeModelsService.options().map((e) => e.key).toList() : [''];
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
      return _isQoder ? '默认 / 跟随 Qoder CN 设置' : '默认 / 跟随 Provider';
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
      return _isQoder
          ? 'Default — Follow Qoder CN settings'
          : 'Default — Follow the selected model/provider';
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
        _autoCandidates
          ..clear()
          ..addAll(
            group.providers.asMap().entries.map(
              (entry) => _AutoCandidateDraft(
                providerId: entry.value['id']?.toString() ?? '',
                model: '',
                priority: entry.key + 1,
                enabled: entry.key < 2,
              ),
            ),
          );
        _autoMaxAttempts = 2;
        final primary = _autoCandidates.first;
        _provider = primary.providerId;
        _model = '';
        _customModel = false;
        _customCtrl.clear();
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
    });
  }

  void _onSubProviderChanged(String? value) {
    final next = value ?? '';
    final choices = _modelChoices(next);
    setState(() {
      _subProvider = next;
      if (!choices.contains(_subModel)) {
        _subModel = '';
        _customSubModel = false;
        _subCustomCtrl.clear();
      }
    });
  }

  void _submit() {
    SessionProviderSelection? providerSelection;
    var provider = _provider;
    var model = _customModel ? _customCtrl.text.trim() : _model;
    if (_isAuto) {
      final group = _autoGroup(_autoGroupKey);
      final protocol = group?.protocol ?? widget.providerSelection?.protocol;
      final enabled =
          _autoCandidates.where((candidate) => candidate.enabled).toList()
            ..sort((a, b) => a.priority.compareTo(b.priority));
      if (protocol == null || protocol.isEmpty || enabled.length < 2) return;
      provider = enabled.first.providerId;
      model = enabled.first.model.trim();
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
              ),
            )
            .toList(growable: false),
        maxAttempts: _autoMaxAttempts.clamp(2, enabled.length.clamp(2, 4)),
        sticky: _autoSticky,
      );
    }
    final subModel = _subProvider.isEmpty
        ? null
        : (_customSubModel ? _subCustomCtrl.text.trim() : _subModel);
    final subagent = (subModel != null && subModel.isNotEmpty)
        ? SessionSubagent(providerId: _subProvider, model: subModel)
        : null;
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
    return Container(
      key: const Key('auto-provider-section'),
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: const Color(0xFF0b0d10),
        border: Border.all(color: const Color(0xFF20242b)),
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
          ...ordered.map((candidate) {
            final provider = _providerMap(candidate.providerId);
            return Container(
              key: Key('auto-candidate-${candidate.providerId}'),
              margin: const EdgeInsets.only(bottom: 8),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: const Color(0xFF111318),
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
                  TextFormField(
                    key: Key('auto-candidate-model-${candidate.providerId}'),
                    initialValue: candidate.model,
                    style: const TextStyle(
                      color: AppColors.text,
                      fontSize: 12,
                      fontFamily: 'monospace',
                    ),
                    decoration: _sheetInputDecoration(
                      hint: '留空跟随 Provider 默认模型',
                    ).copyWith(labelText: 'Model'),
                    onChanged: (value) => candidate.model = value,
                  ),
                ],
              ),
            );
          }),
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
    // Sub-task (subagent) cascade state for the view.
    final subModelChoices = _modelChoices(_subProvider);
    final subModelValue = _customSubModel
        ? '__custom__'
        : (subModelChoices.contains(_subModel)
              ? _subModel
              : (subModelChoices.isNotEmpty ? subModelChoices.first : ''));
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
                  const DropdownMenuItem(value: '', child: Text('默认登录 / 订阅')),
                  ...autoGroups.map(
                    (group) => DropdownMenuItem(
                      value: '__auto__:${group.key}',
                      child: Text(
                        '⚡ Auto · ${_protocolLabel(group.protocol)} · ${group.official ? '官方' : '自管'}',
                      ),
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
            if (widget.cli.supportsSubagent) ...[
              const Divider(height: 32),
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  const Text(
                    '子任务 (subagent)',
                    style: TextStyle(
                      color: AppColors.text,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '派生子 agent 使用独立的 provider+model，留空 = 随主（经本地协议代理路由）',
                      style: TextStyle(color: AppColors.faint, fontSize: 11),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              const Text(
                '子任务 Provider',
                style: TextStyle(color: AppColors.faint, fontSize: 12),
              ),
              const SizedBox(height: 5),
              DropdownButtonFormField<String>(
                value: _subProvider,
                isExpanded: true,
                dropdownColor: AppColors.panel,
                decoration: _sheetInputDecoration(),
                style: const TextStyle(color: AppColors.text, fontSize: 13),
                items: [
                  const DropdownMenuItem(value: '', child: Text('默认（随主）')),
                  ...widget.providers
                      .where((p) => !(_isCodex && p['isOfficial'] == true))
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
              if (_subProvider.isNotEmpty) ...[
                const SizedBox(height: 12),
                const Text(
                  '子任务 Model',
                  style: TextStyle(color: AppColors.faint, fontSize: 12),
                ),
                const SizedBox(height: 5),
                DropdownButtonFormField<String>(
                  value: subModelValue,
                  dropdownColor: AppColors.panel,
                  decoration: _sheetInputDecoration(),
                  style: const TextStyle(color: AppColors.text, fontSize: 13),
                  items: [
                    ...subModelChoices.map(
                      (m) => DropdownMenuItem(
                        value: m,
                        child: Text(_modelOptionLabel(_subProvider, m)),
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
                if (_customSubModel) ...[
                  const SizedBox(height: 8),
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

/// Open the per-session AI-config sheet for [sessionId] (used by both the
/// header ModelChip and the InputBar subagent pill). Fetches the provider list
/// fresh, seeds the sheet from the current session (incl. subagent override),
/// and PATCHes provider+model+effort+subagent on save.
Future<void> openAIConfigSheet(
  BuildContext context, {
  required SettingsService settings,
  required String sessionId,
}) async {
  final mgr = context.read<SessionManager>();
  Session? found;
  for (final x in mgr.sessions) {
    if (x.id == sessionId) {
      found = x;
      break;
    }
  }
  if (found == null) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(t('sessionNotLoaded'))));
    return;
  }
  final sess = found;
  var runtime = SessionCliConfig(
    cli: sess.cli,
    provider: sess.provider,
    providerSelection: sess.providerSelection,
    model: sess.model,
    effectiveModel: sess.effectiveModel,
    effort: sess.effort,
    effectiveEffort: sess.effectiveEffort,
    agent: sess.agent,
    subagent: sess.subagent,
  );
  try {
    runtime = await mgr.fetchSessionCliConfig(sess.id);
  } catch (_) {}
  // Qoder owns no provider pool; its model list comes from the host CLI's
  // catalog instead. Warm it before the sheet builds so the dropdown opens on
  // the real models rather than the routing-tier fallback. Claude's list comes
  // from the installed CLI bundle — same warm-up, static-table fallback.
  if (runtime.cli == SessionCli.qoder) {
    try {
      await QoderModelsService(settings: settings).load();
    } catch (_) {}
  } else if (runtime.cli == SessionCli.claude) {
    try {
      await ClaudeModelsService(settings: settings).load();
    } catch (_) {}
  }
  List<Map<String, dynamic>> providers = const [];
  try {
    if (runtime.cli.supportsProvider) {
      final appType = runtime.cli.appType;
      final d = await ManageService(settings: settings).fetchProviders(appType);
      providers = (d['providers'] as List? ?? [])
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();
    }
  } catch (_) {}
  if (!context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  final picked = await showModalBottomSheet<AIConfigResult>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.panel,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (_) => AIConfigSheet(
      cli: runtime.cli,
      providers: providers,
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
    ),
  );
  if (picked == null) return;
  try {
    await mgr.updateSessionAIConfig(
      sess.id,
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
    fillColor: const Color(0xFF070809),
    isDense: true,
    contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(6)),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(6),
      borderSide: const BorderSide(color: Color(0xFF20242b)),
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
                hintStyle: TextStyle(color: Color(0xFF6b7280), fontSize: 12),
                enabledBorder: OutlineInputBorder(
                  borderSide: BorderSide(color: AppColors.line),
                ),
                focusedBorder: OutlineInputBorder(
                  borderSide: BorderSide(color: AppColors.accentDark),
                ),
              ),
            ),
            const Text(
              '留空＝清除（会话将继承Fleet默认角色）',
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
          child: const Text('保存', style: TextStyle(color: Color(0xFF3fb950))),
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
