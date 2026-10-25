import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

/// 本机网卡的 IPv4 地址。默认实现走 dart:io；单测注入固定列表。
typedef LocalAddressesProvider = Future<List<String>> Function();

/// 「🖥 屏幕」同一 Wi‑Fi 直连：把配置里的服务器地址换成服务端自报的局域网地址。
///
/// 配置地址通常是一条公网隧道（TCP，往返 0.6～2 秒）。服务端
/// `GET /api/server-info` 会带上 `lanUrls`（本机私网地址）和 `startedAt`
/// （服务进程启动时间）。手机和服务端在同一个 Wi‑Fi 时，直接连局域网地址能
/// 快一个数量级，所以远控建连前先问一次：
///
///   1. 经**配置地址**取 `/api/server-info`（带令牌），拿 lanUrls / startedAt；
///   2. 只保留与手机某块网卡同网段（/24）的私网地址 —— 令牌不能发到别的网络；
///   3. 并行探测这些地址的 `/api/server-info`，单个超时 1 秒、总预算 1.2 秒；
///   4. 只有 `startedAt` 与经配置地址拿到的一致（同一个服务进程）才采用，
///      防止别的 Wi‑Fi 上同一个 IP 的陌生设备。
///
/// 探测结果按「本机地址指纹」缓存：地址没变就直接复用，换网络（指纹变了）
/// 或连接失败后由调用方 [invalidate] 掉再探。
class RemoteLanResolver {
  RemoteLanResolver({
    http.Client? client,
    LocalAddressesProvider? localAddresses,
    this.infoTimeout = const Duration(seconds: 2),
    this.probeTimeout = const Duration(seconds: 1),
    this.totalBudget = const Duration(milliseconds: 1200),
  }) : _client = client ?? http.Client(),
       _ownsClient = client == null,
       _localAddresses = localAddresses ?? _defaultLocalAddresses;

  final http.Client _client;
  final bool _ownsClient;

  /// 经配置地址取 server-info 的上限。隧道慢，比局域网探测宽一点。
  final Duration infoTimeout;

  /// 单个局域网地址探测的上限（验收要求 ≤1 秒）。
  final Duration probeTimeout;

  /// 所有局域网地址并行探测的总预算（验收要求 ≤1.2 秒）。
  final Duration totalBudget;

  final LocalAddressesProvider _localAddresses;

  bool _hasCache = false;
  String? _cachedKey;
  String? _cachedOrigin;

  /// 配置的地址本身就在局域网/回环（例如模拟器连 localhost）时，不需要探测。
  static bool isLocalOrigin(String host) {
    final origin = parseOrigin(host);
    if (origin == null) return false;
    return isPrivateHost(origin.host);
  }

  /// 解析成 `scheme://host[:port]` 形式的 origin；不合法返回 null。
  static Uri? parseOrigin(String value) {
    var input = value.trim();
    if (input.isEmpty) return null;
    if (!input.contains('://')) input = 'http://$input';
    Uri uri;
    try {
      uri = Uri.parse(input);
    } catch (_) {
      return null;
    }
    if ((uri.scheme != 'http' && uri.scheme != 'https') ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.query.isNotEmpty ||
        uri.fragment.isNotEmpty ||
        (uri.path.isNotEmpty && uri.path != '/')) {
      return null;
    }
    return uri.replace(path: '', query: null, fragment: null);
  }

  /// 回环 / 链路本地 / 私网（含 CGNAT 100.64/10 与 IPv6 ULA）。
  static bool isPrivateHost(String host) {
    final normalized = host.toLowerCase();
    if (normalized == 'localhost' || normalized.endsWith('.local')) {
      return true;
    }
    final address = InternetAddress.tryParse(normalized);
    if (address == null) return false;
    if (address.isLoopback || address.isLinkLocal) return true;
    final bytes = address.rawAddress;
    if (address.type == InternetAddressType.IPv4 && bytes.length == 4) {
      return bytes[0] == 10 ||
          (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) ||
          (bytes[0] == 192 && bytes[1] == 168) ||
          (bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127);
    }
    return bytes.length == 16 && (bytes[0] & 0xfe) == 0xfc;
  }

  /// 探测一个可用的局域网 origin（例如 `http://192.168.1.5:3000`）。
  /// 没有可用的就返回 null —— 调用方继续走配置地址。
  Future<String?> resolve({
    required String configuredHost,
    required String token,
  }) async {
    final configured = parseOrigin(configuredHost);
    if (configured == null) return null;

    final locals = await _safeLocalAddresses();
    // 缓存键 = 同一台服务器 + 本机网卡地址集合。换服务器或换网络都会重探。
    final key = '${_originString(configured)}|${_fingerprint(locals)}';
    if (_hasCache && _cachedKey == key) return _cachedOrigin;
    _hasCache = false;
    _cachedKey = null;
    _cachedOrigin = null;

    final info = await _fetchInfo(configured, token, infoTimeout);
    if (info == null) {
      // 连配置地址都问不到：多半是这一下网络抖了，不缓存这个结论。
      return null;
    }
    // 服务端明确说了没有可用的局域网地址：这是稳定事实，缓存下来。
    void cacheMiss() {
      _hasCache = true;
      _cachedKey = key;
      _cachedOrigin = null;
    }

    if (info.startedAt == null || info.lanUrls.isEmpty) {
      cacheMiss();
      return null;
    }

    final candidates = <Uri>[];
    for (final raw in info.lanUrls) {
      final uri = parseOrigin(raw);
      if (uri == null) continue;
      if (!isPrivateHost(uri.host)) continue;
      if (_sameOrigin(uri, configured)) continue;
      if (!_sameSubnet(uri.host, locals)) continue;
      if (candidates.any((existing) => _sameOrigin(existing, uri))) continue;
      candidates.add(uri);
    }
    if (candidates.isEmpty) {
      cacheMiss();
      return null;
    }

    final found = <String>[];
    final probes = <Future<void>>[
      for (final candidate in candidates)
        _probe(candidate, token, info.startedAt!).then((origin) {
          if (origin != null) found.add(origin);
        }),
    ];
    try {
      await Future.wait(probes).timeout(totalBudget);
    } on TimeoutException {
      // 用已经拿到的结果；一个都没回来就继续走配置地址。
    }
    if (found.isEmpty) {
      cacheMiss();
      return null;
    }
    final origin = found.first;
    _hasCache = true;
    _cachedKey = key;
    _cachedOrigin = origin;
    return origin;
  }

  /// 网络变化 / 局域网连不上时丢掉缓存，下次重新探测。
  void invalidate() {
    _hasCache = false;
    _cachedKey = null;
    _cachedOrigin = null;
  }

  void close() {
    if (_ownsClient) _client.close();
  }

  Future<String?> _probe(Uri origin, String token, String expectedStartedAt) async {
    final info = await _fetchInfo(origin, token, probeTimeout);
    if (info == null || info.startedAt == null) return null;
    if (info.startedAt != expectedStartedAt) return null;
    return _originString(origin);
  }

  Future<_ServerInfo?> _fetchInfo(
    Uri origin,
    String token,
    Duration timeout,
  ) async {
    final headers = <String, String>{'Accept': 'application/json'};
    if (token.trim().isNotEmpty) headers['X-Access-Token'] = token;
    try {
      final res = await _client
          .get(origin.resolve('/api/server-info'), headers: headers)
          .timeout(timeout);
      if (res.statusCode != 200) return null;
      final decoded = jsonDecode(utf8.decode(res.bodyBytes));
      if (decoded is! Map) return null;
      final startedAt = decoded['startedAt'];
      final rawUrls = decoded['lanUrls'];
      return _ServerInfo(
        startedAt: startedAt?.toString(),
        lanUrls: rawUrls is List
            ? [
                for (final value in rawUrls)
                  if (value is String && value.isNotEmpty) value,
              ]
            : const [],
      );
    } catch (_) {
      return null;
    }
  }

  Future<List<String>> _safeLocalAddresses() async {
    try {
      return await _localAddresses();
    } catch (_) {
      return const [];
    }
  }

  static Future<List<String>> _defaultLocalAddresses() async {
    final interfaces = await NetworkInterface.list();
    return [
      for (final interface in interfaces)
        for (final address in interface.addresses)
          if (address.type == InternetAddressType.IPv4) address.address,
    ];
  }

  static String _fingerprint(List<String> locals) {
    final unique = locals.toSet().toList()..sort();
    return unique.join(',');
  }

  /// 至少同 /24（dart:io 不暴露网卡掩码；配置页本来就按局域网 IPv4 工作）。
  static bool _sameSubnet(String host, List<String> locals) {
    final candidate = InternetAddress.tryParse(host);
    if (candidate == null) return false;
    if (candidate.type != InternetAddressType.IPv4) return false;
    final target = candidate.rawAddress;
    for (final local in locals) {
      final address = InternetAddress.tryParse(local);
      if (address == null || address.type != InternetAddressType.IPv4) {
        continue;
      }
      final bytes = address.rawAddress;
      if (bytes[0] == target[0] &&
          bytes[1] == target[1] &&
          bytes[2] == target[2]) {
        return true;
      }
    }
    return false;
  }

  static bool _sameOrigin(Uri a, Uri b) {
    int port(Uri uri) {
      if (uri.hasPort) return uri.port;
      return uri.scheme == 'https' ? 443 : 80;
    }

    return a.scheme == b.scheme &&
        a.host.toLowerCase() == b.host.toLowerCase() &&
        port(a) == port(b);
  }

  static String _originString(Uri origin) =>
      origin.toString().replaceFirst(RegExp(r'/$'), '');
}

class _ServerInfo {
  const _ServerInfo({required this.startedAt, required this.lanUrls});

  final String? startedAt;
  final List<String> lanUrls;
}
