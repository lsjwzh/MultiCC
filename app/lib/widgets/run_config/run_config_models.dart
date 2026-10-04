// 模型候选与推理强度阶梯 —— 固定一条与自动挑选两半面板共用的一份。
// 候选来源与原 AIConfigSheet._modelChoices 完全一致（Qoder 活目录、WorkBuddy /
// DSH / Gemini / Grok 静态表、OpenCode 原生线路的 modelOptions、Codex 账号目录、
// 别名中继的 tier、线路自带 modelOptions、最后是本机 Claude 目录）。
library;

import '../../models/message.dart';
import '../../services/claude_models_service.dart';
import '../../services/codex_models_service.dart';
import '../../services/opencode_models_service.dart';
import '../../services/qoder_models_service.dart';

String? _providerById(List<Map<String, dynamic>> providers, String id) {
  for (final p in providers) {
    if (p['id'] == id) return (p['name'] ?? p['id'])?.toString();
  }
  return null;
}

/// 一条线路的候选模型（不含「线路默认」那个空串；那由下拉自己给）。首项是
/// 空串的调用方自己过滤。
List<String> runModelChoices(
  SessionCli cli,
  String provider,
  List<Map<String, dynamic>> providers,
) {
  if (cli == SessionCli.qoder) {
    return QoderModelsService.options().map((option) => option.key).toList();
  }
  if (cli == SessionCli.codebuddy) {
    return kCodebuddyModelOptions.map((option) => option.key).toList();
  }
  if (cli == SessionCli.dsh) {
    return kDshModelOptions.map((option) => option.key).toList();
  }
  if (cli == SessionCli.gemini) {
    return kGeminiModelOptions.map((option) => option.key).toList();
  }
  if (cli == SessionCli.commandcode) {
    return kCommandCodeModelOptions.map((option) => option.key).toList();
  }
  if (cli == SessionCli.grok) {
    return kGrokModelOptions.map((option) => option.key).toList();
  }
  if (cli == SessionCli.opencode && provider.isEmpty) {
    return ['', ...openCodeNativeModelOptions(providers)];
  }
  if (cli == SessionCli.opencode && isOpenCodeNativeProvider(provider)) {
    for (final p in providers) {
      if (p['id'] == provider) {
        final options = p['modelOptions'];
        return options is List
            ? options.map((value) => value.toString()).toList()
            : const [];
      }
    }
    return const [];
  }
  Map<String, dynamic>? resolved;
  for (final p in providers) {
    if (p['id'] == provider) {
      resolved = p;
      break;
    }
  }
  if (cli.isCodexFamily &&
      (resolved == null || resolved['isOfficial'] == true)) {
    return CodexModelsService.options().map((entry) => entry.key).toList();
  }
  final aliasMap = resolved?['aliasMap'];
  if (aliasMap is Map) {
    const order = ['opus', 'sonnet', 'haiku', 'fable'];
    final tiers = <String>[
      for (final tier in order)
        if (aliasMap[tier] is Map && aliasMap[tier]['model'] != null) tier,
    ];
    if (tiers.isNotEmpty) return ['', ...tiers];
  }
  final opts = resolved?['modelOptions'];
  if (opts is List && opts.isNotEmpty) {
    return [
      '',
      ...opts.map((e) => e.toString()).where((e) => e.trim().isNotEmpty),
    ];
  }
  return cli.isClaudeFamily
      ? ClaudeModelsService.options().map((e) => e.key).toList()
      : [''];
}

/// 候选模型在下拉里的写法：别名中继显示「别名 → 真模型名」。
String runModelOptionLabel(
  SessionCli cli,
  String providerId,
  String model,
  List<Map<String, dynamic>> providers,
) {
  if (model.isEmpty) return '线路默认';
  if (cli.isCodexFamily) return CodexModelsService.labelFor(model);
  Map? aliasMap;
  for (final p in providers) {
    if (p['id'] == providerId) {
      final map = p['aliasMap'];
      if (map is Map) aliasMap = map;
      break;
    }
  }
  final name = modelDisplayName(cli, model, aliasMap: aliasMap);
  return name == model ? model : '$model（$name）';
}

/// 线路的展示名：catalog 的名字，找不到就用 id。
String runLineName(String id, List<Map<String, dynamic>> providers) =>
    _providerById(providers, id) ?? (id.isEmpty ? '官方 Provider' : id);

/// 推理强度阶梯：低 / 中 / 高 / 最高，逐档挑这条车道真有的值。不足两档就没有
/// 分段控件可画（一档等于没得选）。空列表 = 这条车道不暴露推理强度。
List<(String value, String label)> effortRungsFor(SessionCli cli) {
  if (!cli.supportsEffort) return const [];
  final opts = cli.effortOptions.where((e) => e.isNotEmpty).toList();
  if (opts.isEmpty) return const [];
  String pick(List<String> prefer) {
    for (final p in prefer) {
      if (opts.contains(p)) return p;
    }
    return '';
  }

  final rungs = <(String, String)>[];
  void add(String value, String label) {
    if (value.isEmpty) return;
    if (rungs.any((rung) => rung.$1 == value)) return;
    rungs.add((value, label));
  }

  add(pick(['low', 'minimal']), '低');
  add(pick(['medium']), '中');
  add(pick(['high']), '高');
  add(pick(['xhigh', 'max', 'ultra']), '最高');
  return rungs.length >= 2 ? rungs : const [];
}

/// 当前强度落在阶梯的第几档（找不到就用车道默认那一档，再找不到就第一档）。
int effortRungIndexFor(SessionCli cli, String? effort, List<(String, String)> rungs) {
  if (rungs.isEmpty) return 0;
  final value = (effort == null || effort.isEmpty) ? cli.defaultEffort : effort;
  final index = rungs.indexWhere((rung) => rung.$1 == value);
  if (index >= 0) return index;
  final fallback = rungs.indexWhere((rung) => rung.$1 == cli.defaultEffort);
  return fallback >= 0 ? fallback : 0;
}

/// 强度档在 chip 上的短名，和面板分段控件同一套说法：
/// 默认 / 最低 / 低 / 中 / 高 / 最高。wire 值（medium、xhigh…）不直接上屏。
String effortChipLabel(SessionCli cli, String? effort) {
  if (!cli.supportsEffort) return '';
  final value = (effort == null || effort.isEmpty) ? cli.defaultEffort : effort;
  return switch (value) {
    '' || 'default' => '默认',
    'minimal' => '最低',
    'low' => '低',
    'medium' => '中',
    'high' => '高',
    'xhigh' || 'max' || 'ultra' || 'ultracode' => '最高',
    _ => value,
  };
}
