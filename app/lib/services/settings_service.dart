import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../utils/dispatch_hint.dart';
import 'ws_ticket_service.dart';

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

  /// How many past server connections to remember.
  static const _serverHistoryMax = 10;

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

  /// Whether the Android foreground keep-alive service runs while backgrounded,
  /// holding the chat sockets open (Android only; off by default — it costs an
  /// ongoing notification + battery).
  bool get keepAliveEnabled => _prefs.getBool(_keyKeepAlive) ?? false;

  bool get isConfigured => host.isNotEmpty;

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
