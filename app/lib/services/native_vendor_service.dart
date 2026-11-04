// 厂商原生线路：CLI 自己管账号与模型目录，MultiCC provider 表里没有条目。
// 自动池给每条车道合成一条 `<cli>-native:<cli>`，spawn 时映射回 provider 空。
// 镜像服务端 src/providers/native-vendor.js 与 Web 的 vendorNativeProvidersFor。
library;

import '../models/message.dart';
import '../utils/cli_display.dart';
import 'codebuddy_models_service.dart';
import 'commandcode_grok_models_service.dart';
import 'qoder_models_service.dart';

const List<String> vendorNativeClis = <String>[
  'qoder',
  'codebuddy',
  'gemini',
  'pi',
  'commandcode',
  'dsh',
  'grok',
];

const Set<String> _vendorNativeSet = {
  'qoder',
  'codebuddy',
  'gemini',
  'pi',
  'commandcode',
  'dsh',
  'grok',
};

/// 没有 MultiCC provider 池的车道：它们的唯一线路就是自己的目录。
/// dsh/grok 有托管池，因此不在这里。
const Set<String> vendorOnlyClis = {
  'qoder',
  'codebuddy',
  'gemini',
  'pi',
  'commandcode',
};

String vendorNativeProviderId(String cli) => '$cli-native:$cli';

/// 原生线路值里的车道；不是厂商原生线路返回空串（OpenCode 有自己的前缀）。
String vendorNativeProviderOf(String value) {
  final at = value.indexOf('-native:');
  if (at <= 0) return '';
  final cli = value.substring(0, at);
  return _vendorNativeSet.contains(cli) ? cli : '';
}

bool isVendorNativeProvider(String value) =>
    vendorNativeProviderOf(value).isNotEmpty;

String vendorNativeProviderDisplayName(String cli) => cliDisplayName(cli);

/// 该车道自己的模型目录（不含空串「默认」项）。
List<String> vendorNativeModelOptions(String cli) {
  final options = switch (cli) {
    'qoder' => QoderModelsService.options(),
    'codebuddy' => CodebuddyModelsService.options(),
    'gemini' => kGeminiModelOptions,
    'dsh' => kDshModelOptions,
    'grok' => GrokModelsService.options(),
    'commandcode' => CommandCodeModelsService.options(),
    _ => const <MapEntry<String, String>>[],
  };
  return [
    for (final option in options)
      if (option.key.isNotEmpty) option.key,
  ];
}

/// 把合成线路追加到该车道的 provider 池里；dsh/grok 的托管线路原样保留。
List<Map<String, dynamic>> mergeVendorNativeProviders(
  String cli,
  List<Map<String, dynamic>> managed,
) {
  if (!_vendorNativeSet.contains(cli)) return managed;
  return [
    ...managed,
    {
      'id': vendorNativeProviderId(cli),
      'name': vendorNativeProviderDisplayName(cli),
      'appType': cli,
      'nativeVendor': true,
      'modelOptions': vendorNativeModelOptions(cli),
    },
  ];
}
