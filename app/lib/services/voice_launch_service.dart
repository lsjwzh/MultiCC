import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../i18n.dart';
import 'settings_service.dart';

/// Result of asking the Host for a realtime-voice launch.
class VoiceLaunchResult {
  final bool ok;
  final String? url;
  final String scope;
  final String display;
  final bool loopbackOnly;
  final String? errorCode;
  final String? message;

  const VoiceLaunchResult({
    required this.ok,
    this.url,
    this.scope = 'global',
    this.display = '',
    this.loopbackOnly = true,
    this.errorCode,
    this.message,
  });
}

/// Client for the one global realtime-voice gateway.
///
/// The app states scope and nothing else: passing [sourceSessionId] means "this
/// chat", omitting it means "global". Directory, cwd, Commander and prompt are
/// host-owned — the app must never submit or infer them. Ordinary microphone
/// dictation does not go through here.
class VoiceLaunchService {
  final SettingsService settings;
  final http.Client _client;

  VoiceLaunchService({required this.settings, http.Client? client})
      : _client = client ?? http.Client();

  static const Map<String, String> _errorText = {
    'voice_gateway_not_found': '实时语音网关尚未启用，请先在管理页开启。',
    'voice_gateway_not_running': '实时语音服务未启动，请在管理页启动或重启。',
    'voice_launch_source_not_found': '当前会话已不存在，无法启动语音。',
    'voice_launch_source_not_addressable': '该会话不支持语音投递。',
    'voice_launch_source_not_chat': '只有 chat 会话可以启动语音。',
    'voice_launch_directory_not_found': '会话所属项目已不存在，无法启动语音。',
    'voice_router_not_provisioned': '全局语音路由尚未初始化，请先在管理页保存一次配置。',
    'voice_launch_expired': '语音入口已过期，请重新点击。',
    'voice_launch_unknown': '语音入口无效，请重新点击。',
  };

  static String describe(String? code) {
    if (code == null || code.isEmpty) return '启动语音失败。';
    return _errorText[code] ?? '启动语音失败：$code';
  }

  Future<VoiceLaunchResult> requestLaunch({String? sourceSessionId}) async {
    final uri = Uri.parse(settings.buildHttpUrl('/api/v1/voice-gateway/launch'));
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
    final source = (sourceSessionId ?? '').trim();
    try {
      final res = await _client
          .post(
            uri,
            headers: headers,
            body: jsonEncode(source.isEmpty ? <String, dynamic>{} : {'sourceSessionId': source}),
          )
          .timeout(const Duration(seconds: 15));
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final launch = body['launch'];
      if (res.statusCode != 200 || launch is! Map<String, dynamic> || launch['url'] is! String) {
        final code = (body['code'] ?? body['error'] ?? 'HTTP ${res.statusCode}').toString();
        return VoiceLaunchResult(ok: false, errorCode: code, message: describe(code));
      }
      final transport = launch['transport'];
      return VoiceLaunchResult(
        ok: true,
        url: launch['url'] as String,
        scope: (launch['scope'] ?? 'global').toString(),
        display: (launch['display'] ?? '').toString(),
        loopbackOnly: transport is Map && transport['loopbackOnly'] == true,
      );
    } catch (e) {
      return VoiceLaunchResult(ok: false, errorCode: 'network_error', message: '启动语音失败：$e');
    }
  }

  /// Requests a launch and hands the URL to the platform browser.
  Future<VoiceLaunchResult> launch({String? sourceSessionId}) async {
    final result = await requestLaunch(sourceSessionId: sourceSessionId);
    if (!result.ok) return result;
    // The Host returns a root-relative path (the voice page is reverse-proxied
    // through the main server). Resolve it against the configured server base
    // URL — the same origin chat uses — so a phone opens the page through its
    // own server address (LAN or Tailscale Funnel), never a raw loopback URL.
    final raw = result.url!;
    final resolved = raw.startsWith('/') ? settings.buildHttpUrl(raw) : raw;
    final uri = Uri.tryParse(resolved);
    if (uri == null || !uri.hasScheme) {
      return const VoiceLaunchResult(
        ok: false,
        errorCode: 'voice_launch_url_invalid',
        message: '语音入口地址无效。',
      );
    }
    // The browser only grants microphone access in a secure context: HTTPS or
    // a loopback host. A phone whose server address is http://<lan-ip> would
    // load the page but the mic is blocked, so guide the user to an HTTPS
    // address instead of opening a page that cannot work.
    const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'];
    if (uri.scheme == 'http' && !loopback.contains(uri.host.toLowerCase())) {
      return VoiceLaunchResult(
        ok: false,
        errorCode: 'voice_launch_insecure_context',
        message: I18n.of('voiceLaunchInsecureContext', {'host': uri.host}),
      );
    }
    final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (opened) return result;
    return VoiceLaunchResult(
      ok: false,
      errorCode: 'voice_launch_open_failed',
      message: result.loopbackOnly
          ? '无法打开语音页面：实时语音目前只在运行 MultiCC 的这台机器上可用。'
          : '无法打开语音页面。',
    );
  }
}
