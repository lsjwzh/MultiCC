import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../../models/message.dart';
import '../../services/settings_service.dart';
import '../../theme.dart';
import '../ai_config_sheet.dart';

/// 一个新任务还没创建时选好的执行线路 —— Web 侧是
/// `MultiCCAirSettings.configuration` 的草稿模式（`quickRuntime`）。
///
/// 它只是一份还没落地的选择：任务创建时随 `POST /api/air/tasks` 一起写下去，
/// 第一条消息就按它执行。所以这里没有版本号、没有幂等键，也没有写请求。
class AirTaskRuntime {
  const AirTaskRuntime({
    this.cli = '',
    this.provider = '',
    this.providerName = '',
    this.model = '',
    this.effort = '',
    this.providerSelection,
    this.subagent,
  });

  final String cli;
  final String provider;

  /// Provider 的显示名。任务记录里存的是 id，药丸上要给人看名字。
  final String providerName;
  final String model;
  final String effort;

  /// Auto 线路（同协议多个 Provider 按优先级轮换）。选了它就由它决定真正的
  /// provider 和 model，和 Web 一样。
  final SessionProviderSelection? providerSelection;

  /// 子任务（子 agent）线路 —— Provider 配置后面那条尾巴。模型为空就是没设，
  /// 和主线路一起写进任务 runtime，第一条消息执行时就带上。
  final SessionSubagent? subagent;

  bool get isAuto => providerSelection != null;

  /// 换 CLI 等于换了一整池 Provider 和模型，旧的选择不能带过去。
  AirTaskRuntime withCli(String next) =>
      next == cli ? this : AirTaskRuntime(cli: next);

  AirTaskRuntime copyWith({
    String? provider,
    String? providerName,
    String? model,
    String? effort,
    SessionProviderSelection? providerSelection,
    bool clearProviderSelection = false,
  }) => AirTaskRuntime(
    cli: cli,
    provider: provider ?? this.provider,
    providerName: providerName ?? this.providerName,
    model: model ?? this.model,
    effort: effort ?? this.effort,
    providerSelection: clearProviderSelection
        ? null
        : (providerSelection ?? this.providerSelection),
    subagent: subagent,
  );

  /// 走哪条线路：Auto 池子报协议名，手选报 Provider 名字，都没选就是目录默认。
  String get routeName => isAuto
      ? 'Auto ${_protocolLabel(providerSelection!.protocol)}'
      : (providerName.isNotEmpty
            ? providerName
            : (provider.isNotEmpty ? provider : '默认线路'));

  String get modelLabel => model.isEmpty ? '默认模型' : model;

  /// 「CLI · 线路 · 模型」那一行 —— 和 Web 的 AI 药丸同一句话，同一个顺序。
  String get summary =>
      [cli.isEmpty ? '默认 CLI' : cli, routeName, modelLabel].join(' · ');

  /// App 里 CLI 由旁边那颗药丸自己挑（Web 是一颗药丸兼管两件事），所以药丸上
  /// 只写后两段，不把 CLI 说两遍。
  String get routeLabel => [routeName, modelLabel].join(' · ');

  /// 创建任务时要带上的字段。空值不发 —— 服务端把「没传」当成「用目录默认」，
  /// 传一个空字符串反而会把默认值顶掉。
  Map<String, dynamic> toCreateBody() {
    final child = subagent;
    return {
      if (cli.isNotEmpty) 'cli': cli,
      if (provider.isNotEmpty) 'provider': provider,
      if (providerSelection != null) 'providerSelection': providerSelection!.toJson(),
      if (model.isNotEmpty) 'model': model,
      if (effort.isNotEmpty) 'effort': effort,
      // 子任务尾巴跟着主线路一起走：模型为空就是没设（只挑线路不挑模型 = 随主），
      // 不发 —— 半截配置服务端会当非法拒掉。
      if (child != null &&
          (child.providerId ?? '').isNotEmpty &&
          (child.model ?? '').isNotEmpty)
        'subagent': {'providerId': child.providerId, 'model': child.model},
    };
  }
}

/// 给新任务挑线路。和 Web 同一条规则：CLI 由输入区那颗药丸决定（换 CLI 就是
/// 换一整池 Provider 和模型，两件事不能拆开做），这里只管线路、模型与推理强度。
///
/// 取消返回 null；确定返回新的一份，由调用方留在输入区，等创建任务时写下去。
Future<AirTaskRuntime?> showAirTaskRuntimeEditor(
  BuildContext context, {
  required SettingsService settings,
  required AirTaskRuntime initial,
  http.Client? httpClient,
}) async {
  final cli = parseCli(initial.cli);
  final providers = await prepareAIConfigInputs(
    settings,
    cli,
    httpClient: httpClient,
  );
  if (!context.mounted) return null;
  final picked = await showModalBottomSheet<AIConfigResult>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.panel,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (_) => AIConfigSheet(
      cli: cli,
      providers: providers,
      provider: initial.provider,
      providerSelection: initial.providerSelection,
      model: initial.model,
      effort: initial.effort.isEmpty ? cli.defaultEffort : initial.effort,
      subProviderId: initial.subagent?.providerId,
      subModel: initial.subagent?.model,
    ),
  );
  if (picked == null) return null;

  // Auto 选中时真正执行的是池子里的第一条线路，面板已经把它当成 provider 交
  // 出来了（见 AIConfigSheetState.submit），任务记录里也存这一条 —— 否则药丸
  // 会显示「Auto」，而任务实际上跑在别的 Provider 上。
  return AirTaskRuntime(
    cli: initial.cli,
    providerSelection: picked.providerSelection,
    provider: picked.provider,
    providerName: _providerNameOf(providers, picked.provider) ?? '',
    model: picked.model,
    effort: picked.effort,
    // 子任务尾巴和主线路一起交回来。面板已经在模型为空时折成 null（只挑线路
    // 不挑模型 = 没设），这里不再二次判断。
    subagent: picked.subagent,
  );
}

/// 协议 id 说成人话。Web 那颗药丸原样吐 `Auto anthropic`（协议 id 抄进界面），
/// 而面板里的 Auto 选项写的是「Auto · Anthropic」—— 同一个界面上两处叫法不一致
/// 更像 bug，所以这里跟面板对齐。
String _protocolLabel(String protocol) => switch (protocol) {
  'anthropic' => 'Anthropic',
  'openai_responses' => 'OpenAI Responses',
  'openai_chat' => 'OpenAI Chat',
  _ => protocol,
};

/// Provider 的显示名。任务记录里存的是 id，药丸上要给人看名字 —— Web 在同一个
/// 位置也是拿 id 回查 `providers` 里的 name。
String? _providerNameOf(List<Map<String, dynamic>> providers, String id) {
  if (id.isEmpty) return null;
  for (final provider in providers) {
    if ('${provider['id']}' == id) return '${provider['name'] ?? id}';
  }
  return null;
}
