import 'dart:convert';

import 'package:http/http.dart' as http;

import 'settings_service.dart';

/// 主机运维的读写口（Web `public/air-ops.js` 那一块）。
///
/// 五件事分两类：读的是「这台主机现在什么样」（版本、开机多久、有哪些安装包），
/// 写的是「让它做点什么」（更新、重启）。更新那两条刻意不共用 [http] 的默认
/// 超时——重启会把这个连接掐掉，请求失败本身就是流程的一部分，所以状态轮询走
/// [_getQuiet]，把「问不到」当成一个状态而不是一次错误。
class AirServerInfo {
  const AirServerInfo({this.url = '', this.uptimeMs = 0});

  /// 服务端自己报的可达地址（`http://<lan>:<port>`）。二维码和下载链接都用它。
  final String url;

  /// 进程已经跑了多久。用它而不是服务端的钟点推开始时间：主机的表走得不准，
  /// 屏幕上就会显示一个未来的启动时间。
  final int uptimeMs;

  bool get known => url.isNotEmpty || uptimeMs > 0;
}

/// 关盖运行（macOS 电源）。Web 侧栏「常用设置」那一行用的同一条接口
/// （`GET/POST /api/settings/power`，见 `public/air.js` 的 loadLidSleepRow）。
///
/// [available] 是「这台主机有没有这个能力」：非 macOS 的服务端照样答 200，只是
/// available=false。界面据此决定这一行出不出现 —— 不是一次失败，所以不能拿异常
/// 当信号（那会把「这台主机没有」和「网断了」说成同一件事）。
class AirMacLidSleep {
  const AirMacLidSleep({required this.available, required this.enabled});

  final bool available;
  final bool enabled;

  factory AirMacLidSleep.fromJson(Map<String, dynamic> data) => AirMacLidSleep(
    available: data['available'] == true,
    enabled: data['enabled'] == true,
  );
}

class AirVersionInfo {
  const AirVersionInfo({
    required this.current,
    required this.channel,
    this.latest,
    this.latestVersion,
    this.updateAvailable = false,
    this.apiError = false,
  });

  final String current;
  final String channel;
  final String? latest;
  final String? latestVersion;

  /// 远端版本比本机新。远端问不到时是 false（不是「已是最新」）。
  final bool updateAvailable;

  /// 问远端这条路失败了。和 [updateAvailable] 分开：离线不等于最新。
  final bool apiError;
}

/// 一次更新的运行状态（`src/update-runner.js` 的 `readUpdateStatus`）。
///
/// state 取值：`idle` / `scheduled` / `running` / `succeeded` / `failed` /
/// `stale` / `unknown`。[unreachable] 单独一档——更新过程中服务会先下线，问到
/// 不答复是预期内的，不能报成失败。
class AirUpdateRun {
  const AirUpdateRun({
    this.state = 'unknown',
    this.running = false,
    this.force = false,
    this.exitCode,
    this.tail = '',
    this.unreachable = false,
  });

  final String state;
  final bool running;
  final bool force;
  final int? exitCode;
  final String tail;
  final bool unreachable;

  bool get finished => state == 'succeeded';
  bool get broken => state == 'failed' || state == 'stale';
}

class AirUpdateStart {
  const AirUpdateStart({
    required this.ok,
    required this.status,
    this.force = false,
    this.activeStreaming = 0,
    this.error = '',
    this.code = '',
  });

  final bool ok;
  final int status;
  final bool force;

  /// 已经开跑、这次请求只是接管：不是失败，是一次 409。
  bool get alreadyRunning => status == 409;

  /// 结束时的重启会打断几个正在输出的会话。
  final int activeStreaming;
  final String error;
  final String code;
}

class AirPackage {
  const AirPackage({
    required this.platform,
    required this.versionName,
    this.versionCode,
    this.size = 0,
    this.mtime = 0,
    this.url = '',
  });

  /// `android` / `ios`。
  final String platform;
  final String versionName;
  final int? versionCode;
  final int size;
  final int mtime;
  final String url;

  String get title {
    final code = versionCode == null ? '' : '+$versionCode';
    final name = platform == 'ios' ? 'iOS 安装包' : 'Android APK';
    return '$name · $versionName$code';
  }
}

class AirRestartResult {
  const AirRestartResult({required this.ok, this.activeStreaming = 0, this.error = ''});

  final bool ok;
  final int activeStreaming;
  final String error;
}

class AirOpsService {
  AirOpsService({
    required this.settings,
    this.httpClient,
    this.timeout = const Duration(seconds: 10),
  });

  final SettingsService settings;

  /// 测试注入（MockClient）；生产留空，走包级 http 函数。
  final http.Client? httpClient;
  final Duration timeout;

  Map<String, String> get _headers {
    final h = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) h['X-Access-Token'] = settings.token;
    return h;
  }

  String _url(String path) => settings.buildHttpUrl(path);

  Future<http.Response> _send(String method, String path, {Object? body}) {
    final uri = Uri.parse(_url(path));
    final headers = _headers;
    final client = httpClient;
    final encoded = body == null ? null : jsonEncode(body);
    final call = switch (method) {
      'GET' => client == null ? http.get(uri, headers: headers) : client.get(uri, headers: headers),
      'POST' => client == null
          ? http.post(uri, headers: headers, body: encoded)
          : client.post(uri, headers: headers, body: encoded),
      _ => throw ArgumentError.value(method, 'method', '不支持的方法'),
    };
    return call.timeout(timeout);
  }

  Map<String, dynamic> _decode(http.Response response) {
    if (response.body.isEmpty) return const {};
    final decoded = jsonDecode(utf8.decode(response.bodyBytes));
    return decoded is Map ? decoded.cast<String, dynamic>() : const {};
  }

  Future<AirServerInfo> fetchServerInfo() async {
    final data = _decode(await _send('GET', '/api/server-info'));
    return AirServerInfo(
      url: (data['url'] ?? '').toString(),
      uptimeMs: (data['uptimeMs'] as num?)?.toInt() ?? 0,
    );
  }

  Future<AirVersionInfo> checkVersion() async {
    final data = _decode(await _send('GET', '/api/version-check'));
    return AirVersionInfo(
      current: (data['current'] ?? '').toString(),
      channel: (data['channel'] ?? 'dev').toString(),
      latest: data['latest']?.toString(),
      latestVersion: data['latestVersion']?.toString(),
      updateAvailable: data['updateAvailable'] == true,
      apiError: data['apiError'] == true,
    );
  }

  /// 问不到就返回 [AirUpdateRun.unreachable]，不抛：更新途中服务本来就会先下线。
  Future<AirUpdateRun> updateStatus() async {
    http.Response response;
    try {
      response = await _send('GET', '/api/update/status');
    } catch (_) {
      return const AirUpdateRun(unreachable: true, state: 'unreachable');
    }
    if (response.statusCode != 200) {
      return const AirUpdateRun(unreachable: true, state: 'unreachable');
    }
    final data = _decode(response);
    return AirUpdateRun(
      state: (data['state'] ?? 'unknown').toString(),
      running: data['running'] == true,
      force: data['force'] == true,
      exitCode: (data['exitCode'] as num?)?.toInt(),
      tail: (data['tail'] ?? '').toString(),
    );
  }

  Future<AirUpdateStart> startUpdate({bool force = false}) async {
    final response = await _send('POST', '/api/update', body: {'force': force});
    final data = _decode(response);
    return AirUpdateStart(
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      force: data['force'] == true ? true : force,
      activeStreaming: (data['activeStreaming'] as num?)?.toInt() ?? 0,
      error: (data['error'] ?? '').toString(),
      code: (data['code'] ?? '').toString(),
    );
  }

  /// 两个安装包各自独立：主机上有一个没有另一个是常态，所以谁没有就跳过谁，
  /// 不是整体失败。
  Future<List<AirPackage>> fetchPackages() async {
    final packages = <AirPackage>[];
    try {
      final data = _decode(await _send('GET', '/api/apk-info'));
      if (data['exists'] == true) packages.add(_package('android', data, '/multicc.apk'));
    } catch (_) {
      // 没发布过 Android 包 / 这个主机不提供，都落到 iOS 那一行。
    }
    try {
      final data = _decode(await _send('GET', '/api/ios-ota-info'));
      if (data['exists'] == true) packages.add(_package('ios', data, '/ios-ota'));
    } catch (_) {
      // 同上：主机没发布过 iOS 包。
    }
    return packages;
  }

  AirPackage _package(String platform, Map<String, dynamic> data, String fallbackUrl) {
    final download = platform == 'android' ? data['downloadUrl'] : data['installPage'];
    final url = (download ?? '').toString();
    return AirPackage(
      platform: platform,
      versionName: (data['versionName'] ?? '—').toString(),
      versionCode: (data['versionCode'] as num?)?.toInt(),
      size: (data['size'] as num?)?.toInt() ?? 0,
      mtime: (data['mtime'] as num?)?.toInt() ?? 0,
      url: _absolute(url.isEmpty ? fallbackUrl : url),
    );
  }

  String _absolute(String path) =>
      path.startsWith('http') ? path : _url(path.startsWith('/') ? path : '/$path');

  /// 读当前状态。读不到就抛，由 [AirOpsStore] 接住当成「不知道」——那和「这台主机
  /// 没这个能力」（available=false）是两件事，只有后者能让这一行永远消失。
  Future<AirMacLidSleep> fetchMacLidSleep() async =>
      AirMacLidSleep.fromJson(_decode(await _send('GET', '/api/settings/power')));

  /// 切这个开关要在 Mac 上完成一次管理员授权（服务端跑 osascript），所以这条请求
  /// 可能停很久：超时按服务端那 120s 给，否则 App 会在用户还没按下授权框时自己
  /// 放弃，而 Mac 那边其实已经改了。
  Future<AirMacLidSleep> setMacLidSleep(bool enabled) async {
    final uri = Uri.parse(_url('/api/settings/power'));
    final headers = _headers;
    final body = jsonEncode({'enabled': enabled});
    // 走注入的 client（生产留空时才是包级 http.post），和 [_send] 同一条路：
    // 否则测试里这条请求绕过替身，真正发出去。
    final client = httpClient;
    final call = client == null
        ? http.post(uri, headers: headers, body: body)
        : client.post(uri, headers: headers, body: body);
    final response = await call.timeout(const Duration(seconds: 120));
    final status = AirMacLidSleep.fromJson(_decode(response));
    // 失败是「设置没生效」，不是「开关现在是关的」。这里必须抛：返回一个看起来
    // 正常的状态，界面就会把一次失败画成一次成功的切换。
    if (response.statusCode >= 400) {
      throw Exception('HTTP ${response.statusCode}');
    }
    return status;
  }

  Future<AirRestartResult> restart() async {
    final response = await _send('POST', '/api/restart', body: const {});
    final data = _decode(response);
    return AirRestartResult(
      ok: response.statusCode >= 200 && response.statusCode < 300,
      activeStreaming: (data['activeStreaming'] as num?)?.toInt() ?? 0,
      error: (data['error'] ?? '').toString(),
    );
  }
}
