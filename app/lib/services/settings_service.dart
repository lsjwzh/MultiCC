import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

class SettingsService {
  static const _keyHost = 'multicc_host';
  static const _keyToken = 'multicc_token';
  static const _keySession = 'multicc_session';
  static const _keyCwd = 'multicc_cwd';
  static const _keyDefaultModel = 'multicc_default_model';
  static const _keyNotify = 'multicc_notifications_enabled';
  static const _keyKeepAlive = 'multicc_keepalive_enabled';
  static const _keyFontScale = 'multicc_font_scale';

  static SettingsService? _instance;

  /// Already-initialised singleton, or null before startup completes.
  static SettingsService? get current => _instance;

  late SharedPreferences _prefs;

  /// Live font scale — MaterialApp listens so changes apply immediately.
  final ValueNotifier<double> fontScale = ValueNotifier<double>(1.0);

  SettingsService._();

  static Future<SettingsService> getInstance() async {
    if (_instance == null) {
      _instance = SettingsService._();
      _instance!._prefs = await SharedPreferences.getInstance();
      _instance!.fontScale.value = _instance!._prefs.getDouble(_keyFontScale) ?? 1.0;
    }
    return _instance!;
  }

  String get host => _prefs.getString(_keyHost) ?? '';
  String get token => _prefs.getString(_keyToken) ?? '';
  String get session => _prefs.getString(_keySession) ?? '';
  String get cwd => _prefs.getString(_keyCwd) ?? '';

  /// Default Claude model for newly created chats ('' = follow Claude default).
  String get defaultModel => _prefs.getString(_keyDefaultModel) ?? '';

  /// Whether local push notifications are shown on task completion.
  bool get notificationsEnabled => _prefs.getBool(_keyNotify) ?? true;

  /// Whether the Android foreground keep-alive service runs while backgrounded,
  /// holding the chat sockets open (Android only; off by default — it costs an
  /// ongoing notification + battery).
  bool get keepAliveEnabled => _prefs.getBool(_keyKeepAlive) ?? false;

  bool get isConfigured => host.isNotEmpty;

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
    if (defaultModel != null) await _prefs.setString(_keyDefaultModel, defaultModel);
    if (notificationsEnabled != null) await _prefs.setBool(_keyNotify, notificationsEnabled);
    if (keepAliveEnabled != null) await _prefs.setBool(_keyKeepAlive, keepAliveEnabled);
    if (fontScale != null) {
      await _prefs.setDouble(_keyFontScale, fontScale);
      this.fontScale.value = fontScale;
    }
  }

  /// Build ws[s]:// URL for /ws/chat
  String buildWsUrl({String? resumeId}) {
    var h = host;
    // Normalise: strip trailing slash and scheme
    h = h.replaceAll(RegExp(r'/$'), '');
    final isHttps = h.startsWith('https://');
    final wsScheme = isHttps ? 'wss' : 'ws';
    final bare = h.replaceFirst(RegExp(r'^https?://'), '');

    final params = <String, String>{};
    if (token.isNotEmpty) params['token'] = token;
    if (cwd.isNotEmpty) params['cwd'] = cwd;
    if (session.isNotEmpty) params['session'] = session;
    if (resumeId != null && resumeId.isNotEmpty) params['resume'] = resumeId;

    final query = params.entries.map((e) =>
        '${Uri.encodeQueryComponent(e.key)}=${Uri.encodeQueryComponent(e.value)}').join('&');

    return '$wsScheme://$bare/ws/chat${query.isNotEmpty ? '?$query' : ''}';
  }

  /// Build http[s]:// URL for REST endpoints
  String buildHttpUrl(String path) {
    var h = host.replaceAll(RegExp(r'/$'), '');
    if (!h.startsWith('http')) h = 'http://$h';
    return '$h$path';
  }
}
