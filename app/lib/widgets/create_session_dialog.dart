// 新建会话对话框（角色预设 + provider->model 联动）。自 main_shell.dart 抽出。
//
// 形态：两个 kind 按钮（+ Chat / + Terminal）在 main_shell 里触发本对话框，
// 对话框内部用 CLI 下拉让用户挑选底层 CLI（claude/codex/opencode/zcode/qoder），
// 并按新 CLI 的 appType 重新拉取 provider 池、重建模型/effort/agent 区段。

import 'package:flutter/material.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../models/agent_preset.dart';
import '../models/provider_limit_label.dart';
import '../services/settings_service.dart';
import '../services/manage_service.dart';
import '../services/claude_models_service.dart';
import '../services/codex_models_service.dart';
import '../services/qoder_models_service.dart';
import '../theme.dart';
import '../services/agent_preset_service.dart';
import '../widgets/agent_preset_picker_sheet.dart';
import '../widgets/provider_option.dart';

// ── New-session dialog with role presets + provider->model linkage ───────────

class CreateSessionResult {
  final SessionCli cli;
  final String? label;
  final String? rolePrompt;
  final String? provider;
  final String? model;
  final String? effort;
  final String? agent;
  CreateSessionResult({
    required this.cli,
    this.label,
    this.rolePrompt,
    this.provider,
    this.model,
    this.effort,
    this.agent,
  });
}

class CreateSessionDialog extends StatefulWidget {
  final SessionKind kind;
  final SessionCli? defaultCli;
  final List<Map<String, dynamic>> providers;
  final String? defaultProviderId;
  final Map<SessionCli, bool> cliAvailability;
  final SettingsService settings;
  final bool basicMode;

  const CreateSessionDialog({
    super.key,
    required this.kind,
    this.defaultCli,
    required this.providers,
    this.defaultProviderId,
    this.cliAvailability = const {},
    required this.settings,
    this.basicMode = false,
  });

  @override
  State<CreateSessionDialog> createState() => CreateSessionDialogState();
}

class CreateSessionDialogState extends State<CreateSessionDialog> {
  late final TextEditingController _nameCtrl;
  late final TextEditingController _roleCtrl;
  late final TextEditingController _agentCtrl;
  late final AgentPresetService _presetSvc;
  AgentPresetIndex? _presetIndex;
  bool _loadingPresets = false;

  /// Picked CLI drives every other section (provider pool, model list, effort
  /// options, agent field). Initialised from [widget.defaultCli] (or Claude as
  /// the safest default) and rebuilt on every CLI change.
  late SessionCli _pickedCli;

  /// Mutable provider pool for the current [_pickedCli]. Re-fetched from the
  /// server when the CLI changes (codex -> 'codex' appType, others -> 'claude');
  /// qoder skips the pool entirely (BYOK).
  List<Map<String, dynamic>> _providers = const [];
  String? _defaultProviderId;

  String? _pickedProvider; // null or '' = default; id = that provider
  String? _pickedModel;
  late String _pickedEffort;
  bool _customModel = false;
  final _customModelCtrl = TextEditingController();

  bool get _isClaude => _pickedCli == SessionCli.claude;
  bool get _isCodex => _pickedCli == SessionCli.codex;
  bool get _isQoder => _pickedCli == SessionCli.qoder;
  String get _defaultEffort => _pickedCli.defaultEffort;
  bool get _hasConcreteDefaultProvider =>
      _defaultProviderId != null &&
      _defaultProviderId!.isNotEmpty &&
      _providers.any((p) => p['id'] == _defaultProviderId);
  String get _effectiveProviderId {
    final picked = _pickedProvider;
    if (picked != null && picked.isNotEmpty) return picked;
    return _defaultProviderId ?? '';
  }

  /// A CLI is selectable when the host reports it available. Unknown entries
  /// (empty availability map, e.g. cold start with no sessions to probe) fall
  /// back to available so the user is never blocked from creating a session.
  bool _cliAvailable(SessionCli cli) =>
      widget.cliAvailability[cli] ?? true;

  @override
  void initState() {
    super.initState();
    _nameCtrl = TextEditingController();
    _roleCtrl = TextEditingController();
    _agentCtrl = TextEditingController();
    _presetSvc = AgentPresetService(settings: widget.settings);
    _pickedCli = widget.defaultCli ?? SessionCli.claude;
    // If the requested default CLI isn't installed on this host, fall back to
    // the first available one (or keep Claude when nothing is known).
    if (!_cliAvailable(_pickedCli)) {
      for (final cli in SessionCli.values) {
        if (_cliAvailable(cli)) {
          _pickedCli = cli;
          break;
        }
      }
    }
    _providers = widget.providers;
    _defaultProviderId = widget.defaultProviderId;
    if (_hasConcreteDefaultProvider) _pickedProvider = _defaultProviderId;
    _pickedEffort = _defaultEffort;
    _loadPresets();
    if (_isQoder) _loadQoderModels();
    if (_isClaude) _loadClaudeModels();
    if (_isCodex) _loadCodexModels();
    final opts = _currentModelOptions;
    _pickedModel = opts.isNotEmpty ? opts.first.key : null;
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _roleCtrl.dispose();
    _agentCtrl.dispose();
    _customModelCtrl.dispose();
    super.dispose();
  }

  /// Fetch the signed-in Qoder account's catalog and re-seed the model field
  /// once it lands. No-op when the list is already warm or unavailable — the
  /// dropdown just keeps the built-in routing tiers.
  Future<void> _loadQoderModels() async {
    final before = QoderModelsService.cached.length;
    try {
      await QoderModelsService(settings: widget.settings).load();
    } catch (_) {}
    if (!mounted || !_isQoder || QoderModelsService.cached.length == before) {
      return;
    }
    setState(() {
      final opts = _currentModelOptions;
      final current = _customModel ? null : _pickedModel;
      if (current != null && opts.any((e) => e.key == current)) return;
      _pickedModel = opts.isNotEmpty ? opts.first.key : null;
    });
  }

  /// Pull the CLI-bundle model list and re-seed the model field once it lands.
  /// No-op when the list is already warm or unavailable — the dropdown just
  /// keeps the built-in table.
  Future<void> _loadClaudeModels() async {
    final before = ClaudeModelsService.cached.length;
    try {
      await ClaudeModelsService(settings: widget.settings).load();
    } catch (_) {}
    if (!mounted || !_isClaude || ClaudeModelsService.cached.length == before) {
      return;
    }
    setState(() {
      final opts = _currentModelOptions;
      final current = _customModel ? null : _pickedModel;
      if (current != null && opts.any((e) => e.key == current)) return;
      _pickedModel = opts.isNotEmpty ? opts.first.key : null;
    });
  }

  Future<void> _loadCodexModels({bool forceRefresh = true}) async {
    try {
      await CodexModelsService(
        settings: widget.settings,
      ).load(forceRefresh: forceRefresh);
    } catch (_) {}
    if (!mounted || !_isCodex) return;
    setState(() {
      final opts = _currentModelOptions;
      final current = _customModel ? null : _pickedModel;
      if (current != null && opts.any((entry) => entry.key == current)) return;
      _pickedModel = opts.isNotEmpty ? opts.first.key : null;
    });
  }

  Future<void> _loadPresets() async {
    setState(() => _loadingPresets = true);
    try {
      _presetIndex = await _presetSvc.fetchIndex();
    } catch (_) {}
    if (!mounted) return;
    setState(() => _loadingPresets = false);
  }

  /// Build the model options for the current provider selection.
  /// Official Codex uses the account catalog; relays keep provider options;
  /// Claude falls back to its CLI-derived catalog.
  List<MapEntry<String, String>> get _currentModelOptions {
    // Live Qoder catalog once _loadQoderModels() lands; routing tiers until then.
    if (_isQoder) return QoderModelsService.options();
    // Vendor-auth CLIs with a static catalog (no provider pool, no fetch API).
    if (_pickedCli == SessionCli.codebuddy) return kCodebuddyModelOptions;
    if (_pickedCli == SessionCli.dsh) return kDshModelOptions;
    Map<String, dynamic>? prov;
    final providerId = _effectiveProviderId;
    for (final p in _providers) {
      if (p['id'] == providerId) {
        prov = p;
        break;
      }
    }
    if (_isCodex && (prov == null || prov['isOfficial'] == true)) {
      return CodexModelsService.options();
    }
    // Alias-mapped relays (e.g. iFlytek): expose the tiers directly, each option
    // reading "opus -> claude-opus-4-8 (GLM5.2)". The tier key is the value - the
    // server honors session.model === opus/sonnet/haiku/fable as a wire model.
    final map = prov?['aliasMap'];
    if (map is Map) {
      const order = ['opus', 'sonnet', 'haiku', 'fable'];
      final tiers = <MapEntry<String, String>>[];
      for (final t in order) {
        final v = map[t];
        if (v is Map && v['model'] != null) {
          final m = v['model'].toString();
          final name = v['name']?.toString();
          tiers.add(
            MapEntry(
              t,
              '$t -> $m${(name != null && name.isNotEmpty) ? ' ($name)' : ''}',
            ),
          );
        }
      }
      if (tiers.isNotEmpty) return tiers;
    }
    final opts = prov?['modelOptions'];
    if (opts is List && opts.isNotEmpty) {
      return opts
          .map((m) => m.toString())
          .map((s) => MapEntry<String, String>(s, s))
          .toList();
    }
    // Empty provider follows the configured default provider for this CLI:
    // Codex should still show GPT / XF model choices instead of a Claude list.
    // No provider (or provider without modelOptions): Claude falls back to its
    // CLI-derived list. Official Codex already returned above.
    // Live CLI-bundle list once _loadClaudeModels() lands; static table until then.
    return _isClaude ? ClaudeModelsService.options() : const [];
  }

  String _providerIdForPresetDefault(AgentPreset preset) {
    final declared = preset.defaultProviderId ?? '';
    if (declared.isNotEmpty && _providers.any((p) => p['id'] == declared)) {
      return declared;
    }
    final key = preset.defaultProviderKey.toLowerCase();
    final model = preset.defaultModel;
    if (key == 'xf-maas-coding') {
      for (final p in _providers) {
        final opts = (p['modelOptions'] as List? ?? [])
            .map((e) => e.toString())
            .toList();
        if (model.isNotEmpty && opts.contains(model)) return p['id'] as String;
      }
      for (final p in _providers) {
        final name = (p['name'] ?? '').toString().toLowerCase();
        if (name.contains('讯飞') ||
            name.contains('xf') ||
            name.contains('maas')) {
          return p['id'] as String;
        }
      }
    }
    if (key == 'openai-codex') {
      for (final p in _providers) {
        final name = (p['name'] ?? '').toString().toLowerCase();
        if (name.contains('openai') ||
            name.contains('codex 官方') ||
            name.contains('官方')) {
          return p['id'] as String;
        }
      }
      for (final p in _providers) {
        final opts = (p['modelOptions'] as List? ?? [])
            .map((e) => e.toString())
            .toList();
        if (opts.any((m) => m.startsWith('gpt-'))) return p['id'] as String;
      }
    }
    return '';
  }

  void _applyPresetDefaults(AgentPreset preset) {
    // Preset only applies when it targets the CLI the user has currently
    // picked (not the original widget.cli the dialog opened with).
    final presetCli = parseCli(preset.defaultCli.trim().toLowerCase());
    if (presetCli != _pickedCli) return;

    final providerId = _providerIdForPresetDefault(preset);
    if (providerId.isNotEmpty) _pickedProvider = providerId;

    final opts = _currentModelOptions;
    final model = preset.defaultModel;
    if (model.isNotEmpty) {
      if (opts.any((e) => e.key == model)) {
        _pickedModel = model;
        _customModel = false;
        _customModelCtrl.clear();
      } else {
        _pickedModel = null;
        _customModel = true;
        _customModelCtrl.text = model;
      }
    }

    final effort = preset.defaultEffort;
    final validEfforts = _pickedCli.effortOptions;
    if (validEfforts.contains(effort)) _pickedEffort = effort;
  }

  Future<void> _pickPreset() async {
    final id = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) =>
          AgentPresetPickerSheet(service: _presetSvc, index: _presetIndex),
    );
    if (id == null || !mounted) return;
    try {
      final preset = await _presetSvc.fetchPreset(id);
      final prompt = preset.prompt ?? '';
      if (!mounted) return;
      if (_roleCtrl.text.trim().isNotEmpty) {
        final ok = await showDialog<bool>(
          context: context,
          builder: (c) => AlertDialog(
            backgroundColor: const Color(0xFF14171c),
            title: Text(
              t('roleReplaceTitle'),
              style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 15),
            ),
            content: Text(
              t('roleReplaceBody'),
              style: const TextStyle(color: Color(0xFF8a909b), fontSize: 13),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(c, false),
                child: Text(
                  t('cancel'),
                  style: const TextStyle(color: Color(0xFF8a909b)),
                ),
              ),
              TextButton(
                onPressed: () => Navigator.pop(c, true),
                child: Text(
                  t('roleReplaceBtn'),
                  style: const TextStyle(color: Color(0xFFff6b63)),
                ),
              ),
            ],
          ),
        );
        if (ok != true) return;
      }
      setState(() {
        _roleCtrl.text = prompt;
        _applyPresetDefaults(preset);
      });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(t('roleLoadFailed', {'error': '$e'}))),
      );
    }
  }

  void _onProviderChanged(String? v) {
    setState(() {
      _pickedProvider = v;
      // Try to preserve the current model selection across provider switches
      // (matching web rebuildModelOptions behavior). If the current model
      // isn't in the new list, fall back to the first option or custom.
      final opts = _currentModelOptions;
      final prevModel = _customModel ? null : _pickedModel;
      if (prevModel != null && opts.any((e) => e.key == prevModel)) {
        // Current model exists in new provider's list - keep it
        _customModel = false;
      } else if (opts.isNotEmpty && opts.first.key.isNotEmpty) {
        _pickedModel = opts.first.key;
        _customModel = false;
      } else {
        _pickedModel = null;
        _customModel = false;
      }
    });
  }

  /// Re-fetch the provider pool for the newly picked CLI and reset the
  /// dependent fields (provider / model / effort) to sensible defaults for
  /// that CLI. Qoder skips the pool entirely (BYOK) but still seeds the model
  /// from its static option list.
  Future<void> _onCliChanged(SessionCli cli) async {
    if (cli == _pickedCli) return;
    // Optimistic reset: clear all dependent state so the UI reflects the new
    // CLI immediately. The old provider pool is dropped (it belongs to the
    // previous CLI's appType) and refilled below.
    setState(() {
      _pickedCli = cli;
      _pickedEffort = _defaultEffort;
      _pickedProvider = null;
      _pickedModel = null;
      _customModel = false;
      _customModelCtrl.clear();
      _providers = const [];
      _defaultProviderId = null;
    });
    if (!cli.supportsProvider) {
      // Qoder owns its account/BYOK; no provider pool to fetch. Seed the model
      // from whatever the option list currently offers, then pull the account's
      // real catalog in the background (_loadQoderModels re-seeds on arrival).
      if (!mounted) return;
      setState(() {
        final opts = _currentModelOptions;
        _pickedModel = opts.isNotEmpty ? opts.first.key : null;
      });
      if (cli == SessionCli.qoder) _loadQoderModels();
      return;
    }
    // Claude has a provider pool, but Claude Official exposes no modelOptions —
    // warm the CLI-bundle list so the dropdown upgrades once it lands.
    if (cli == SessionCli.claude) _loadClaudeModels();
    if (cli == SessionCli.codex) {
      try {
        await CodexModelsService(
          settings: widget.settings,
        ).load(forceRefresh: true);
      } catch (_) {}
    }
    try {
      final d = await ManageService(
        settings: widget.settings,
      ).fetchProviders(cli.appType);
      if (!mounted) return;
      final providers = (d['providers'] as List? ?? [])
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();
      String? defaultProviderId;
      final defaults = d['defaults'];
      if (defaults is Map && defaults[cli.name] != null) {
        defaultProviderId = defaults[cli.name].toString();
      }
      setState(() {
        _providers = providers;
        _defaultProviderId = defaultProviderId;
        if (defaultProviderId != null &&
            defaultProviderId.isNotEmpty &&
            providers.any((p) => p['id'] == defaultProviderId)) {
          _pickedProvider = defaultProviderId;
        }
        final opts = _currentModelOptions;
        _pickedModel = opts.isNotEmpty ? opts.first.key : null;
      });
    } catch (_) {
      // Leave the optimistic empty state in place on failure.
    }
  }

  void _submit() {
    String? model;
    if (_customModel) {
      model = _customModelCtrl.text.trim().isNotEmpty
          ? _customModelCtrl.text.trim()
          : null;
    } else {
      model = (_pickedModel != null && _pickedModel!.isNotEmpty)
          ? _pickedModel
          : null;
    }
    final result = CreateSessionResult(
      cli: _pickedCli,
      label: _nameCtrl.text.trim().isNotEmpty ? _nameCtrl.text.trim() : null,
      rolePrompt: _roleCtrl.text.trim().isNotEmpty
          ? _roleCtrl.text.trim()
          : null,
      provider: (_pickedProvider != null && _pickedProvider!.isNotEmpty)
          ? _pickedProvider
          : null,
      model: model,
      effort: _pickedEffort,
      agent: _pickedCli.supportsAgent && _agentCtrl.text.trim().isNotEmpty
          ? _agentCtrl.text.trim()
          : null,
    );
    Navigator.of(context).pop(result);
  }

  @override
  Widget build(BuildContext context) {
    final modelOptions = _currentModelOptions;
    return AlertDialog(
      backgroundColor: const Color(0xFF0f1115),
      title: Text(
        widget.basicMode
            ? t('startConversation')
            : t('createSessionTitle', {
                'cli': _pickedCli.displayName,
                'kind': widget.kind == SessionKind.chat ? 'Chat' : 'Terminal',
              }),
        style: const TextStyle(color: Color(0xFFf2f4f7), fontSize: 16),
      ),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // ── Name ──
            Text(
              t('sessionName'),
              style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
            ),
            const SizedBox(height: 4),
            TextField(
              controller: _nameCtrl,
              style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
              decoration: sheetInputDecoration(hint: t('optionalAutoName')),
            ),
            if (widget.basicMode) ...[
              const SizedBox(height: 14),
              Container(
                key: const ValueKey('recommended-ai-summary'),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.accent.withValues(alpha: 0.08),
                  border: Border.all(
                    color: AppColors.accent.withValues(alpha: 0.28),
                  ),
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(
                      Icons.auto_awesome_rounded,
                      color: AppColors.accent,
                      size: 18,
                    ),
                    const SizedBox(width: 9),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '${t('recommended')} · ${_pickedCli.displayName}',
                            style: const TextStyle(
                              color: Color(0xFFe7eaee),
                              fontSize: 12.5,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(height: 3),
                          Text(
                            t('startConversationHint'),
                            style: const TextStyle(
                              color: Color(0xFF8a909b),
                              fontSize: 11,
                              height: 1.35,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
            if (!widget.basicMode) ...[
            const SizedBox(height: 12),
            // ── CLI picker (drives provider pool + model/effort/agent) ──
            Text(
              t('cliLabel'),
              style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
            ),
            const SizedBox(height: 4),
            DropdownButtonFormField<SessionCli>(
              value: _pickedCli,
              isExpanded: true,
              dropdownColor: const Color(0xFF0f1115),
              style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
              decoration: sheetInputDecoration(),
              items: SessionCli.values
                  .map(
                    (cli) => DropdownMenuItem<SessionCli>(
                      value: cli,
                      enabled: _cliAvailable(cli),
                      child: Text(
                        _cliAvailable(cli)
                            ? cli.displayName
                            : '${cli.displayName}${t('cliNotInstalledSuffix')}',
                        style: TextStyle(
                          color: _cliAvailable(cli)
                              ? const Color(0xFFe7eaee)
                              : const Color(0xFF5b616c),
                        ),
                      ),
                    ),
                  )
                  .toList(),
              onChanged: (v) {
                if (v != null) _onCliChanged(v);
              },
            ),
            const SizedBox(height: 12),
            // ── Role prompt with preset picker ──
            Row(
              children: [
                Text(
                  t('rolePrompt'),
                  style: const TextStyle(
                    color: Color(0xFF8a909b),
                    fontSize: 11,
                  ),
                ),
                const Spacer(),
                TextButton.icon(
                  icon: const Icon(Icons.auto_awesome, size: 14),
                  label: Text(
                    _loadingPresets ? t('loading') : t('selectRolePreset'),
                    style: const TextStyle(fontSize: 12),
                  ),
                  style: TextButton.styleFrom(
                    foregroundColor: const Color(0xFF6aa3ff),
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    minimumSize: const Size(0, 28),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  onPressed: _loadingPresets ? null : _pickPreset,
                ),
              ],
            ),
            const SizedBox(height: 4),
            TextField(
              controller: _roleCtrl,
              maxLines: 3,
              style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
              decoration: sheetInputDecoration(
                hint: t('optionalInheritFleetRole'),
              ),
            ),
            const SizedBox(height: 12),
            if (_pickedCli.supportsProvider) ...[
              // ── Provider ──
              const Text(
                'Provider',
                style: TextStyle(color: Color(0xFF8a909b), fontSize: 11),
              ),
              const SizedBox(height: 4),
              DropdownButtonFormField<String>(
                value: _pickedProvider ?? '',
                isExpanded: true,
                dropdownColor: const Color(0xFF0f1115),
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                decoration: sheetInputDecoration(),
                items: [
                  if (!_hasConcreteDefaultProvider)
                    DropdownMenuItem(
                      value: '',
                      child: Text(
                        t('defaultLogin'),
                        style: const TextStyle(color: Color(0xFFe7eaee)),
                      ),
                    ),
                  ..._providers.map(
                    (p) => DropdownMenuItem(
                      value: p['id'] as String,
                      child: ProviderOption(
                        main:
                            '${p['id'] == _defaultProviderId ? t('defaultProviderPrefix') : ''}${p['name']}'
                            '${p['isOfficial'] == true ? t('subscriptionSuffix') : ''}'
                            '${(p['model'] as String? ?? '').isNotEmpty ? ' · ${p['model']}' : ''}',
                        detail: providerLimitDetail(p),
                        mainStyle: const TextStyle(
                          color: Color(0xFFe7eaee),
                          fontSize: 13,
                        ),
                      ),
                    ),
                  ),
                ],
                onChanged: _onProviderChanged,
              ),
            ] else ...[
              const Text(
                'Qoder CN 使用自身账号 / BYOK 配置',
                style: TextStyle(color: Color(0xFF8a909b), fontSize: 11),
              ),
            ],
            // ── Model (linked to provider) ──
            const SizedBox(height: 12),
            Text(
              t('model'),
              style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
            ),
            const SizedBox(height: 4),
            DropdownButtonFormField<String>(
              value: _customModel ? '__custom__' : _pickedModel,
              isExpanded: true,
              dropdownColor: const Color(0xFF0f1115),
              style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
              decoration: sheetInputDecoration(),
              items: [
                ...modelOptions.map(
                  (e) => DropdownMenuItem(
                    value: e.key,
                    child: Text(
                      e.value,
                      style: const TextStyle(color: Color(0xFFe7eaee)),
                    ),
                  ),
                ),
                DropdownMenuItem(
                  value: '__custom__',
                  child: Text(
                    t('customOption'),
                    style: const TextStyle(color: Color(0xFF8a909b)),
                  ),
                ),
              ],
              onChanged: (v) {
                setState(() {
                  if (v == '__custom__') {
                    _customModel = true;
                    _pickedModel = null;
                  } else {
                    _customModel = false;
                    _pickedModel = v;
                  }
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
                  color: Color(0xFF8a909b),
                  fontSize: 11,
                  height: 1.35,
                ),
              ),
            ],
            if (_customModel) ...[
              const SizedBox(height: 6),
              TextField(
                controller: _customModelCtrl,
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                decoration: sheetInputDecoration(
                  hint: _isClaude
                      ? t('claudeModelIdHint')
                      : _isQoder
                      ? 'Qoder 模型或分级 ID'
                      : _pickedCli == SessionCli.codebuddy
                      ? 'WorkBuddy 模型或档位 ID'
                      : _pickedCli == SessionCli.dsh
                      ? 'DeepSeek 模型 ID'
                      : t('codexModelIdHint'),
                ),
                autofocus: true,
              ),
            ],
            if (_pickedCli.supportsEffort) ...[
              const SizedBox(height: 12),
              Text(
                _pickedCli.effortFieldLabel,
                style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
              ),
              const SizedBox(height: 4),
              DropdownButtonFormField<String>(
                value: _pickedEffort,
                isExpanded: true,
                dropdownColor: const Color(0xFF0f1115),
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                decoration: sheetInputDecoration(),
                items: _pickedCli.effortOptions
                    .map(
                      (e) => DropdownMenuItem(
                        value: e,
                        child: Text(
                          _isClaude
                              ? e
                              : effortShortNameForCli(_pickedCli, e),
                          style:
                              const TextStyle(color: Color(0xFFe7eaee)),
                        ),
                      ),
                    )
                    .toList(),
                onChanged: (v) =>
                    setState(() => _pickedEffort = v ?? _defaultEffort),
              ),
            ],
            if (_pickedCli.supportsAgent) ...[
              const SizedBox(height: 12),
              Text(
                '${_pickedCli.displayName} Agent',
                style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
              ),
              const SizedBox(height: 4),
              TextField(
                controller: _agentCtrl,
                maxLength: 80,
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                decoration: sheetInputDecoration(
                  hint: _pickedCli == SessionCli.opencode
                      ? t('agentBuildHint')
                      : t('agentNameHint'),
                ).copyWith(counterText: ''),
              ),
            ],
          ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(null),
          child: Text(
            t('cancel'),
            style: const TextStyle(color: Color(0xFF8a909b)),
          ),
        ),
        ElevatedButton(
          style: ElevatedButton.styleFrom(
            backgroundColor: const Color(0xFF22ab9c),
            foregroundColor: Colors.white,
          ),
          onPressed: _submit,
          child: Text(t('create')),
        ),
      ],
    );
  }
}
