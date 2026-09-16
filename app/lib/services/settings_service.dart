import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../utils/dispatch_hint.dart';
import 'ws_ticket_service.dart';

/// 聊天区宽度：铺满可用宽度，还是收在一个最大宽度里。对齐 Web 的
/// `chat-layout.js`（那边是一个 `{limited, maxWidth}` 的 localStorage 对象）。
@immutable
class ChatWidthSetting {
  final bool limited;
  final int max;

  const ChatWidthSetting({required this.limited, required this.max});

  /// App 的历史观感：宽屏收到 980。Web 的默认是「不限制」，这里不跟 ——
  /// 把默认改成铺满会让老用户一升级就发现聊天区变宽，那是另一个决定。
  static const ChatWidthSetting defaults = ChatWidthSetting(
    limited: true,
    max: 980,
  );

  ChatWidthSetting copyWith({bool? limited, int? max}) => ChatWidthSetting(
    limited: limited ?? this.limited,
    max: max ?? this.max,
  );

  @override
  bool operator ==(Object other) =>
      other is ChatWidthSetting && other.limited == limited && other.max == max;

  @override
  int get hashCode => Object.hash(limited, max);

  @override
  String toString() => 'ChatWidthSetting(limited: $limited, max: $max)';
}

/// One remembered server connection (URL + its token).
class ServerHistoryEntry {
  final String host;
  final String token;
  const ServerHistoryEntry({required this.host, required this.token});

  Map<String, String> toJson() => {'host': host, 'token': token};

  static ServerHistoryEntry? fromJson(dynamic raw) {
    if (raw is! Map) return null;
    final host = (raw['host'] ?? '').toString();
    if (host.isEmpty) return null;
    return ServerHistoryEntry(
      host: host,
      token: (raw['token'] ?? '').toString(),
    );
  }
}

class SettingsService {
  static const _keyHost = 'multicc_host';
  static const _keyToken = 'multicc_token';
  static const _keySession = 'multicc_session';
  static const _keyCwd = 'multicc_cwd';
  static const _keyDefaultModel = 'multicc_default_model';
  static const _keyNotify = 'multicc_notifications_enabled';
  static const _keyNotifyForceOnMigration =
      'multicc_notifications_force_on_20260629';
  static const _keyKeepAlive = 'multicc_keepalive_enabled';
  static const _keyFontScale = 'multicc_font_scale';
  static const _keyLang = 'multicc_lang';
  static const _keyExperienceMode = 'multicc_experience_mode';
  static const _keyServerHistory = 'multicc_server_history';
  static const _keyChatRuntimePrefix = 'multicc_chat_runtime_';
  static const _keyDispatchModePrefix = 'multicc_dispatch_mode_';
  /// 多选项模式之前的布尔开关；只在还没写过新键时读一次做迁移。
  static const _keyNoDispatchPrefix = 'multicc_no_dispatch_';

  // 聊天区宽度（Web 的 chat-layout.js，`multicc:chat-layout`）。那边默认铺满、
  // 可选限制；App 原先一直是「宽屏限制在 980」，所以这里的默认保持原样 ——
  // 只把那两个数从常量变成可改的设置，不改默认观感。
  static const _keyChatWidthLimited = 'multicc_chat_width_limited';
  static const _keyChatWidthMax = 'multicc_chat_width_max';

  /// How many past server connections to remember.
  static const _serverHistoryMax = 10;

  /// 聊天区最大宽度的滑杆范围，与 Web 的 `chat-layout.js` 同值（640–2400）。
  static const int chatWidthMin = 640;
  static const int chatWidthMaxLimit = 2400;

  static SettingsService? _instance;

  /// Already-initialised singleton, or null before startup completes.
  static SettingsService? get current => _instance;

  late SharedPreferences _prefs;

  /// Live font scale — MaterialApp listens so changes apply immediately.
  final ValueNotifier<double> fontScale = ValueNotifier<double>(1.0);

  /// Live application language. Values are the catalog ids `zh` and `en`.
  final ValueNotifier<String> language = ValueNotifier<String>('zh');

  /// New installations start in the task-oriented basic experience. Existing
  /// configured installations migrate to advanced so an upgrade never makes
  /// familiar controls disappear without the user's choice.
  final ValueNotifier<bool> advancedMode = ValueNotifier<bool>(false);

  /// 聊天区宽度。跟 fontScale / advancedMode 同一套路：值在内存里，改它的那个
  /// 弹窗负责落盘 —— 「聊天宽度」弹窗要能边拖滑杆边看预览，取消时不落盘，所以
  /// 这个 notifier 必须先能脱离 prefs 单独变化。
  final ValueNotifier<ChatWidthSetting> chatWidth =
      ValueNotifier<ChatWidthSetting>(ChatWidthSetting.defaults);

  SettingsService._();

  static Future<SettingsService> getInstance() async {
    if (_instance == null) {
      _instance = SettingsService._();
      _instance!._prefs = await SharedPreferences.getInstance();
      if (_instance!._prefs.getBool(_keyNotifyForceOnMigration) != true) {
        await _instance!._prefs.setBool(_keyNotify, true);
        await _instance!._prefs.setBool(_keyNotifyForceOnMigration, true);
      }
      _instance!.fontScale.value =
          _instance!._prefs.getDouble(_keyFontScale) ?? 1.0;
      _instance!.language.value = _instance!._prefs.getString(_keyLang) == 'en'
          ? 'en'
          : 'zh';
      final storedMode = _instance!._prefs.getString(_keyExperienceMode);
      _instance!.advancedMode.value =
          storedMode == 'advanced' ||
          (storedMode == null &&
              (_instance!._prefs.getString(_keyHost) ?? '').trim().isNotEmpty);
      _instance!.chatWidth.value = ChatWidthSetting(
        limited: _instance!._prefs.getBool(_keyChatWidthLimited) ?? true,
        max: _instance!._prefs.getInt(_keyChatWidthMax) ?? 980,
      );
    }
    return _instance!;
  }

  String get host => _prefs.getString(_keyHost) ?? '';
  String get token => _prefs.getString(_keyToken) ?? '';
  String get session => _prefs.getString(_keySession) ?? '';
  String get cwd => _prefs.getString(_keyCwd) ?? '';
  String get lang => language.value;

  Future<void> setLanguage(String value) async {
    final normalized = value == 'en' ? 'en' : 'zh';
    if (language.value == normalized) return;
    await _prefs.setString(_keyLang, normalized);
    language.value = normalized;
  }

  Future<void> setAdvancedMode(bool value) async {
    if (advancedMode.value == value &&
        _prefs.getString(_keyExperienceMode) != null) {
      return;
    }
    await _prefs.setString(_keyExperienceMode, value ? 'advanced' : 'basic');
    advancedMode.value = value;
  }

  /// Default Claude model for newly created chats ('' = follow Claude default).
  String get defaultModel => _prefs.getString(_keyDefaultModel) ?? '';

  /// Whether local push notifications are shown for turn outcomes.
  bool get notificationsEnabled => _prefs.getBool(_keyNotify) ?? true;

  /// 会话级「任务提醒」开关 —— 对应 Web 聊天页头那颗 `#notify-btn`。
  ///
  /// Web 的实现（public/pwa.js 的 taskNotifyKey / getTaskNotifyEnabled /
  /// setTaskNotifyEnabled）把每个会话的选择存在
  /// `localStorage['multicc_notify:<sessionId>']`，取值 'on' / 'off'，没有记录
  /// 时默认开；会话 id 为空时回落到全局键 `multicc_notify`。App 沿用同一组键名
  /// 和同一个默认值，语义也就一致：关掉的只是这一个会话的提醒，物理上仍开着的
  /// [notificationsEnabled]（设置页那个全局开关）不受影响。
  bool taskNotifyEnabled(String sessionId) {
    final raw = _prefs.getString(_taskNotifyKey(sessionId));
    if (raw == 'on') return true;
    if (raw == 'off') return false;
    return true;
  }

  /// 落盘会话级「任务提醒」开关。Web 点 `#notify-btn` 时只写 localStorage、
  /// 没有任何后端调用（public/chat-notifications.js 的 persistPreference，
  /// 以及 public/client.js:344 那段同名的内联实现），App 也只落本地偏好。
  Future<void> setTaskNotifyEnabled(String sessionId, bool enabled) async {
    await _prefs.setString(_taskNotifyKey(sessionId), enabled ? 'on' : 'off');
  }

  /// 翻这个会话的提醒开关 —— Web 点 `#notify-btn` 就是取反后落盘。
  Future<void> toggleTaskNotify(String sessionId) =>
      setTaskNotifyEnabled(sessionId, !taskNotifyEnabled(sessionId));

  static String _taskNotifyKey(String sessionId) =>
      sessionId.isEmpty ? 'multicc_notify' : 'multicc_notify:$sessionId';

  /// Whether the Android foreground keep-alive service runs while backgrounded,
  /// holding the chat sockets open (Android only; off by default — it costs an
  /// ongoing notification + battery).
  bool get keepAliveEnabled => _prefs.getBool(_keyKeepAlive) ?? false;

  bool get isConfigured => host.isNotEmpty;

  /// 聊天区是否限制最大宽度（默认限制 —— App 历来如此，不是 Web 那边「默认铺满」）。
  bool get chatWidthLimited => chatWidth.value.limited;

  /// 限制生效时的最大宽度。
  int get chatWidthMax => chatWidth.value.max;

  /// 落盘当前聊天区宽度。弹窗在「保存」时调；预览期间的 notifier 变化不落盘。
  Future<void> saveChatWidth() async {
    await _prefs.setBool(_keyChatWidthLimited, chatWidth.value.limited);
    await _prefs.setInt(_keyChatWidthMax, chatWidth.value.max);
  }

  /// Remembered server connections (most recent first).
  List<ServerHistoryEntry> get serverHistory {
    final raw = _prefs.getString(_keyServerHistory);
    if (raw == null || raw.isEmpty) return [];
    try {
      final list = jsonDecode(raw);
      if (list is! List) return [];
      return list
          .map(ServerHistoryEntry.fromJson)
          .whereType<ServerHistoryEntry>()
          .toList();
    } catch (_) {
      return [];
    }
  }

  /// Record a server connection in history: dedupes by host (case-insensitive,
  /// trailing slash ignored), keeps the latest token, and moves it to the front.
  Future<void> rememberServer(String host, String token) async {
    final h = host.trim();
    if (h.isEmpty) return;
    String norm(String v) =>
        v.trim().replaceAll(RegExp(r'/+$'), '').toLowerCase();
    final key = norm(h);
    final entries = serverHistory.where((e) => norm(e.host) != key).toList()
      ..insert(0, ServerHistoryEntry(host: h, token: token.trim()));
    final trimmed = entries.take(_serverHistoryMax).toList();
    await _prefs.setString(
      _keyServerHistory,
      jsonEncode(trimmed.map((e) => e.toJson()).toList()),
    );
  }

  /// Wipe all remembered server connections (privacy: e.g. shared phone).
  Future<void> clearServerHistory() async {
    await _prefs.remove(_keyServerHistory);
  }

  /// Small per-session cache for server-issued usage limits/balances. Queue,
  /// pending-input and API-error state are deliberately not cached: the server
  /// replays those authoritative states on every chat reconnect.
  Map<String, dynamic>? readChatRuntimeCache(String sessionId) {
    final raw = _prefs.getString('$_keyChatRuntimePrefix$sessionId');
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      return decoded is Map ? Map<String, dynamic>.from(decoded) : null;
    } catch (_) {
      return null;
    }
  }

  Future<void> saveChatRuntimeCache(
    String sessionId,
    Map<String, dynamic> value,
  ) async {
    await _prefs.setString(
      '$_keyChatRuntimePrefix$sessionId',
      jsonEncode(value),
    );
  }

  /// Commander 会话选定的派发方式，按会话记住（web 端存在 localStorage 的
  /// `multicc.dispatchMode.<id>`）。没写过就读一次旧的布尔开关做迁移，
  /// 再没有就是默认的 dispatch_master async。旧 `dispatch_master` 值会在读取时
  /// 兼容为 async；读不回写，免得给没碰过的会话凭空造记录。
  DispatchMode readDispatchMode(String sessionId) {
    if (sessionId.isEmpty) return DispatchMode.defaultMode;
    final stored = _prefs.getString('$_keyDispatchModePrefix$sessionId');
    if (stored != null) return DispatchMode.fromWireName(stored);
    final legacy = _prefs.getBool('$_keyNoDispatchPrefix$sessionId');
    if (legacy == true) return DispatchMode.none;
    return DispatchMode.defaultMode;
  }

  Future<void> saveDispatchMode(String sessionId, DispatchMode mode) async {
    if (sessionId.isEmpty) return;
    await _prefs.setString(
      '$_keyDispatchModePrefix$sessionId',
      mode.wireName,
    );
  }

  Future<void> save({
    String? host,
    String? token,
    String? session,
    String? cwd,
    String? defaultModel,
    bool? notificationsEnabled,
    bool? keepAliveEnabled,
    double? fontScale,
  }) async {
    if (host != null) await _prefs.setString(_keyHost, host.trim());
    if (token != null) await _prefs.setString(_keyToken, token.trim());
    if (session != null) await _prefs.setString(_keySession, session);
    if (cwd != null) await _prefs.setString(_keyCwd, cwd);
    if (defaultModel != null) {
      await _prefs.setString(_keyDefaultModel, defaultModel);
    }
    if (notificationsEnabled != null) {
      await _prefs.setBool(_keyNotify, notificationsEnabled);
    }
    if (keepAliveEnabled != null) {
      await _prefs.setBool(_keyKeepAlive, keepAliveEnabled);
    }
    if (fontScale != null) {
      await _prefs.setDouble(_keyFontScale, fontScale);
      this.fontScale.value = fontScale;
    }
  }

  /// Build a credential-free ws[s]:// URL for /ws/chat.
  ///
  /// Callers must exchange it through [WsTicketClient] immediately before
  /// connecting. Kept for compatibility with older embedding code; production
  /// transports own their ticket lifecycle directly.
  String buildWsUrl({String? resumeId}) {
    final params = <String, String>{};
    if (cwd.isNotEmpty) params['cwd'] = cwd;
    if (session.isNotEmpty) params['session'] = session;
    if (resumeId != null && resumeId.isNotEmpty) params['resume'] = resumeId;
    return buildMulticcWebSocketUri(
      host: host,
      path: MulticcWsPath.chat,
      query: params,
    ).toString();
  }

  /// Build http[s]:// URL for REST endpoints
  String buildHttpUrl(String path) {
    var h = host.replaceAll(RegExp(r'/$'), '');
    if (!h.startsWith('http')) h = 'http://$h';
    return '$h$path';
  }
}
