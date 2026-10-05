import '../settings_service.dart';
import 'demo_server.dart';

/// 演示模式的开关：起停进程内的 [DemoServer]，并把 [SettingsService] 的连接
/// 临时指过去。整个 App 同一时间最多一个演示服务器。
class DemoMode {
  static DemoServer? _server;

  static Future<void> enter(SettingsService settings) async {
    await exit(settings);
    final server = await DemoServer.start(lang: () => settings.lang);
    _server = server;
    settings.enterDemo(host: server.host, token: DemoServer.accessToken);
  }

  static Future<void> exit(SettingsService settings) async {
    settings.exitDemo();
    final server = _server;
    _server = null;
    await server?.close();
  }
}
