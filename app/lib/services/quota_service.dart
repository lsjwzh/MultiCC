import 'dart:convert';
import 'package:http/http.dart' as http;

import 'settings_service.dart';

/// Fetches vendor quota bars (ark / zhipu / kimi) from the multicc backend.
///
/// The backend does the actual vendor work (arkcli shell-out, CDP, direct API
/// calls with stored credentials) — the app only reads the same JSON routes the
/// web uses. Non-2xx responses still carry a meaningful `status` body
/// (needs_auth / not_configured / unavailable), so the body is parsed
/// regardless of HTTP status; only transport/parse failures yield null.
class QuotaService {
  final SettingsService settings;

  QuotaService({required this.settings});

  Map<String, String> get _headers {
    final h = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) {
      h['X-Access-Token'] = settings.token;
    }
    return h;
  }

  String _url(String path) => settings.buildHttpUrl(path);

  Future<Map<String, dynamic>?> fetchArkQuota() => _get('/api/ark/quota');

  Future<Map<String, dynamic>?> fetchZhipuQuota(String? host) =>
      _get('/api/zhipu/quota${_hostQuery(host)}');

  Future<Map<String, dynamic>?> fetchKimiQuota(String? host) =>
      _get('/api/kimi/quota${_hostQuery(host)}');

  /// Qoder CN credit usage, scraped from qoder.com.cn via the backend's CDP /
  /// cached-cookie path (`/api/qoder/quota`). `status` may be needs_login /
  /// chrome_unavailable / unavailable / ok; the body carries `quota`
  /// (total/plan/resource_package summaries + `nextResetAt`) and `plan`
  /// (tier, end_date) — the same shape the web qoder bar renders.
  Future<Map<String, dynamic>?> fetchQoderQuota() => _get('/api/qoder/quota');

  /// Open a visible login window for qoder.com.cn on the server's managed
  /// Chrome profile. Used when the credits scrape reports no session
  /// (needs_login / chrome_unavailable). Returns false on any transport/HTTP
  /// failure.
  Future<bool> openQoderLogin() async {
    try {
      final res = await http
          .post(
            Uri.parse(_url('/api/qoder/quota/login')),
            headers: _headers,
          )
          .timeout(const Duration(seconds: 20));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Claude subscription usage windows (5h / weekly / monthly) scraped from
  /// claude.ai/settings/usage via CDP — the same route the web claude bar
  /// reads. `status` in the body may be needs_login / chrome_unavailable /
  /// unavailable / ok; the body is parsed regardless of HTTP status, so the
  /// actionable states surface to the caller just like the vendor ones.
  Future<Map<String, dynamic>?> fetchClaudeUsage() => _get('/api/claude/quota');

  /// Open a visible login window for claude.ai on the server's managed Chrome
  /// profile. Used when the usage scrape reports no session (needs_login /
  /// chrome_unavailable). Returns false on any transport/HTTP failure.
  Future<bool> openClaudeLogin() async {
    try {
      final res = await http
          .post(
            Uri.parse(_url('/api/claude/quota/login')),
            headers: _headers,
          )
          .timeout(const Duration(seconds: 20));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// The active session provider's baseUrl, read from the session detail
  /// endpoint (GET /api/sessions/:id → providerBaseUrl). Used on connect to
  /// learn which vendor bar to show before any CLI switch happens.
  Future<String?> fetchProviderBaseUrl(String sessionId) async {
    final body = await _get('/api/sessions/$sessionId');
    return body?['providerBaseUrl']?.toString();
  }

  String _hostQuery(String? host) {
    if (host == null || host.isEmpty) return '';
    return '?host=${Uri.encodeComponent(host)}';
  }

  Future<Map<String, dynamic>?> _get(String path) async {
    try {
      final res = await http
          .get(Uri.parse(_url(path)), headers: _headers)
          .timeout(const Duration(seconds: 20));
      final body = jsonDecode(res.body);
      return body is Map<String, dynamic> ? body : null;
    } catch (_) {
      return null;
    }
  }
}
