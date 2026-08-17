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

  Future<Map<String, dynamic>?> fetchArkQuota(String? baseUrl) =>
      _get('/api/ark/quota${_baseUrlQuery(baseUrl)}');

  Future<Map<String, dynamic>?> fetchZhipuQuota(String? host) =>
      _get('/api/zhipu/quota${_hostQuery(host)}');

  Future<Map<String, dynamic>?> fetchKimiQuota(String? host) =>
      _get('/api/kimi/quota${_hostQuery(host)}');

  /// OpenCode Go subscription usage (5h / weekly / monthly) scraped from the
  /// opencode.ai Zen console via the backend's CDP path (`/api/opencode/quota`),
  /// the same route the web opencode bar reads. The body carries a server-
  /// rendered `bar` (as every quota route now does).
  Future<Map<String, dynamic>?> fetchOpenCodeQuota() =>
      _get('/api/opencode/quota');

  /// Codex (ChatGPT) weekly subscription quota, read from the backend route that
  /// mirrors the web codex bar. The body carries a server-rendered `bar`.
  Future<Map<String, dynamic>?> fetchCodexQuota() => _get('/api/codex/quota');

  /// Open a visible login window for opencode.ai on the server's managed Chrome
  /// profile. Used when the Go subscription scrape reports no session
  /// (needs_login / chrome_unavailable). Returns false on any transport/HTTP
  /// failure.
  Future<bool> openOpenCodeLogin() async {
    try {
      final res = await http
          .post(Uri.parse(_url('/api/opencode/quota/login')), headers: _headers)
          .timeout(const Duration(seconds: 20));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// The idle (no-data-yet) bar for every vendor, rendered once on the server.
  /// The app caches these on connect so an unfetched bar shows the server's idle
  /// placeholder verbatim — the app carries no vendor strings of its own.
  /// Returns `{status:'ok', bars:{ark:{...}, zhipu:{...}, ...}}` or null.
  Future<Map<String, dynamic>?> fetchIdleBars() => _get('/api/quota/bars/idle');

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
          .post(Uri.parse(_url('/api/qoder/quota/login')), headers: _headers)
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
          .post(Uri.parse(_url('/api/claude/quota/login')), headers: _headers)
          .timeout(const Duration(seconds: 20));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Open a visible login window for moonshot/kimi on the server's managed
  /// Chrome profile — the same POST the web kimi bar dispatches when its
  /// server-rendered action is 'login'. Returns false on any transport/HTTP
  /// failure.
  Future<bool> openKimiLogin() async {
    try {
      final res = await http
          .post(Uri.parse(_url('/api/kimi/quota/login')), headers: _headers)
          .timeout(const Duration(seconds: 20));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Kick off the server-side `npm install -g @volcengine/ark-cli` when the ark
  /// scrape reports needs_install. Long-running; the caller keeps an
  /// 'installing' state until this resolves. Returns null on transport
  /// failure, otherwise the parsed body (status/error).
  Future<Map<String, dynamic>?> installArk() async {
    try {
      final res = await http
          .post(Uri.parse(_url('/api/ark/quota/install')), headers: _headers)
          .timeout(const Duration(seconds: 300));
      final body = jsonDecode(res.body);
      return {
        'httpOk': res.statusCode == 200,
        'body': body is Map<String, dynamic> ? body : <String, dynamic>{},
      };
    } catch (_) {
      return null;
    }
  }

  /// Open the ark auth window (needs_auth) — the POST behind the web ark
  /// three-state click. Returns false on any transport/HTTP failure.
  Future<bool> openArkLogin() async {
    try {
      final res = await http
          .post(Uri.parse(_url('/api/ark/quota/login')), headers: _headers)
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

  String _baseUrlQuery(String? baseUrl) {
    if (baseUrl == null || baseUrl.isEmpty) return '';
    return '?baseUrl=${Uri.encodeComponent(baseUrl)}';
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
