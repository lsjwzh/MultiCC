import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'settings_service.dart';

/// 用户拖出来的排布：首页目录卡的顺序，以及每个 fleet 里会话卡的顺序。
///
/// 以前目录顺序存在本机的 SharedPreferences(`directory_order`)、web 存在
/// localStorage，于是排布是「这台设备」的属性——换台电脑、换个浏览器、清一次缓存
/// 就得重排一遍。现在它住在服务端的 ui-layout.json（见 src/ui-layout.js），本类
/// 就是 App 这一侧的实现，与 public/ui-layout-store.js 是同一份契约的两个客户端。
///
/// 顺序永远只是**提示**，不是权威：服务端会把已删除的 id 剔掉，客户端把没排过的
/// 项按各自的默认顺序缀在后面（见 utils/manual_order.dart）。任何一次读写失败都
/// 只让用户看到默认顺序，不会让页面出错。
class UiLayout {
  final List<String> dirOrder;
  final Map<String, List<String>> sessionOrder;

  const UiLayout({required this.dirOrder, required this.sessionOrder});
  const UiLayout.empty() : dirOrder = const [], sessionOrder = const {};

  factory UiLayout.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const UiLayout.empty();
    List<String> ids(dynamic v) => v is List
        ? v.whereType<String>().where((s) => s.isNotEmpty).toList()
        : const <String>[];
    final raw = json['sessionOrder'];
    final byDir = <String, List<String>>{};
    if (raw is Map) {
      raw.forEach((k, v) {
        if (k is String && k.isNotEmpty) byDir[k] = ids(v);
      });
    }
    return UiLayout(dirOrder: ids(json['dirOrder']), sessionOrder: byDir);
  }
}

/// 读写服务端排布的薄客户端，外加一份内存缓存。
///
/// 缓存不是性能优化而是正确性要求：目录列表在 build 里被读，若每次 build 都发一次
/// HTTP，滚动一下就是几十个请求，而且请求回来的时序会让顺序在屏幕上闪。
/// [ensureLoaded] 幂等，谁都能 await，只有第一个真的发请求。
class UiLayoutService {
  final SettingsService settings;
  UiLayoutService({required this.settings});

  /// 迁移用的旧键：目录顺序从前存在这里（[_DirectoryListBody]）。
  static const String legacyDirOrderKey = 'directory_order';

  UiLayout _layout = const UiLayout.empty();
  Future<void>? _loading;

  UiLayout get layout => _layout;
  List<String> get dirOrder => _layout.dirOrder;
  List<String> sessionOrderOf(String dirId) =>
      _layout.sessionOrder[dirId] ?? const [];

  Map<String, String> get _headers {
    final h = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) h['X-Access-Token'] = settings.token;
    return h;
  }

  Future<void> ensureLoaded() => _loading ??= _load();

  /// 强制重读（下拉刷新时用）。失败保留上一次拿到的排布，不清空——把用户排好的
  /// 顺序因为一次网络抖动就抹掉，比暂时看不到新顺序糟得多。
  Future<void> reload() {
    _loading = _load();
    return _loading!;
  }

  Future<void> _load() async {
    try {
      final res = await http
          .get(Uri.parse(settings.buildHttpUrl('/api/ui-layout')), headers: _headers)
          .timeout(const Duration(seconds: 10));
      if (res.statusCode >= 400) return;
      final j = jsonDecode(utf8.decode(res.bodyBytes)) as Map;
      _layout = UiLayout.fromJson((j['layout'] as Map?)?.cast<String, dynamic>());
    } catch (_) {
      // 拿不到排布 = 默认顺序，不是错误状态。
      return;
    }
    await _migrateLegacyDirOrder();
  }

  /// 把本机 SharedPreferences 里的旧目录顺序搬上服务端一次，然后忘掉它。
  ///
  /// 只在服务端还什么都没有时才搬：用户可能已经在网页或另一台设备上排过，那时候
  /// 拿这台手机的陈旧本地顺序去覆盖，就等于让「最后一个升级的设备」赢。
  Future<void> _migrateLegacyDirOrder() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final legacy = prefs.getStringList(legacyDirOrderKey);
      if (_layout.dirOrder.isEmpty && legacy != null && legacy.isNotEmpty) {
        await saveDirOrder(legacy);
      }
      await prefs.remove(legacyDirOrderKey);
    } catch (_) {}
  }

  /// 乐观写：先更新内存里的排布让 UI 立刻跟手，请求在后面落地。服务端的应答
  /// （已经剔掉不存在的 id）回来后覆盖内存值。
  Future<void> _put(String path, List<String> order, void Function() apply) async {
    apply();
    try {
      final res = await http
          .put(
            Uri.parse(settings.buildHttpUrl(path)),
            headers: _headers,
            body: jsonEncode({'order': order}),
          )
          .timeout(const Duration(seconds: 10));
      if (res.statusCode >= 400) return;
      final j = jsonDecode(utf8.decode(res.bodyBytes)) as Map;
      _layout = UiLayout.fromJson((j['layout'] as Map?)?.cast<String, dynamic>());
    } catch (_) {}
  }

  Future<void> saveDirOrder(List<String> order) {
    final next = List<String>.from(order);
    return _put('/api/ui-layout/dir-order', next, () {
      _layout = UiLayout(dirOrder: next, sessionOrder: _layout.sessionOrder);
    });
  }

  Future<void> saveSessionOrder(String dirId, List<String> order) {
    final next = List<String>.from(order);
    return _put(
      '/api/ui-layout/session-order/${Uri.encodeComponent(dirId)}',
      next,
      () {
        final byDir = Map<String, List<String>>.from(_layout.sessionOrder);
        if (next.isEmpty) {
          byDir.remove(dirId);
        } else {
          byDir[dirId] = next;
        }
        _layout = UiLayout(dirOrder: _layout.dirOrder, sessionOrder: byDir);
      },
    );
  }
}
