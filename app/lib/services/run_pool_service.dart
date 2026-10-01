// 「运行配置」面板要的 Provider 池：按车道取、取过的留着。面板首帧只拿会话现在
// 这条车道的池（调用方已经备好），其余车道要等用户真的点过去或打开「添加线路」
// 才现取 —— 打开面板永远不等网络。
import 'package:http/http.dart' as http;

import '../models/message.dart';
import 'codex_models_service.dart';
import 'manage_service.dart';
import 'opencode_models_service.dart';
import 'settings_service.dart';

class RunPoolService {
  RunPoolService({required this.settings, this.httpClient});

  final SettingsService? settings;
  final http.Client? httpClient;

  final Map<String, List<Map<String, dynamic>>> _cache = {};
  final Map<String, Future<List<Map<String, dynamic>>?>> _inflight = {};

  /// 已经取回来的池；没取过返回 null（空列表 = 取回来了但一条线路都没有）。
  List<Map<String, dynamic>>? cached(String lane) => _cache[lane];

  /// 取一条车道的池。返回 null = 这次没取到（区别于「取到了但是空的」）——
  /// 「添加线路」面板要靠这个把「加载失败 · 重试」和「没有可用线路」分开说。
  Future<List<Map<String, dynamic>>?> forCli(String lane) {
    final hit = _cache[lane];
    if (hit != null) return Future.value(hit);
    final settings = this.settings;
    if (settings == null) return Future.value(null);
    return _inflight.putIfAbsent(lane, () async {
      try {
        final cli = tryParseCli(lane);
        if (cli != null) {
          if (cli.isCodexFamily) {
            await CodexModelsService(settings: settings).load();
          } else if (cli == SessionCli.opencode) {
            await OpenCodeModelsService(
              settings: settings,
              httpClient: httpClient,
            ).load();
          } else if (cli.isClaudeFamily) {
            // Claude 的清单是本机 CLI 包里读的，不在关键路径上。
          }
        }
        final d = await ManageService(
          settings: settings,
          httpClient: httpClient,
        ).fetchProvidersForCli(lane);
        var providers = (d['providers'] as List? ?? [])
            .map((e) => (e as Map).cast<String, dynamic>())
            .toList();
        if (lane == 'opencode') {
          providers = mergeOpenCodeNativeProviders(
            providers,
            OpenCodeModelsService.cached,
          );
        }
        _cache[lane] = providers;
        return providers;
      } catch (_) {
        return null;
      }
    }).whenComplete(() => _inflight.remove(lane));
  }
}
