import 'dart:convert';
import 'package:http/http.dart' as http;
import 'settings_service.dart';

class ManagedComputer {
  const ManagedComputer({
    required this.id,
    required this.name,
    this.origin = '',
    this.local = false,
  });
  final String id, name, origin;
  final bool local;
  factory ManagedComputer.fromJson(Map<String, dynamic> data) =>
      ManagedComputer(
        id: data['id'] as String,
        name: data['name'] as String,
        origin: data['origin'] as String? ?? '',
        local: data['local'] == true,
      );
}

/// The entry server owns connections. No remote password/grant is persisted on
/// the phone, and requests never fall back to the entry computer.
class MachineService {
  MachineService(this.settings, {http.Client? client})
    : _client = client ?? http.Client(),
      _ownsClient = client == null;
  final SettingsService settings;
  final http.Client _client;
  final bool _ownsClient;
  Future<Map<String, dynamic>> request(
    String path, {
    String method = 'GET',
    Map<String, dynamic>? body,
  }) async {
    final request = http.Request(
      method,
      Uri.parse(settings.buildHttpUrl(path)),
    );
    request.headers.addAll({
      'Content-Type': 'application/json',
      if (settings.token.isNotEmpty) 'X-Access-Token': settings.token,
    });
    if (body != null) request.body = jsonEncode(body);
    final response = await http.Response.fromStream(
      await _client.send(request).timeout(const Duration(seconds: 100)),
    );
    dynamic data;
    try {
      data = jsonDecode(utf8.decode(response.bodyBytes));
    } catch (_) {
      data = null;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final error = data is Map ? data['error'] ?? data['message'] : null;
      throw Exception(
        error is String ? error : '电脑连接不可用（${response.statusCode}）',
      );
    }
    if (data is! Map) throw const FormatException('电脑响应无效');
    return Map<String, dynamic>.from(data);
  }

  Future<List<ManagedComputer>> list() async {
    final data = await request('/api/machines');
    return [
      ManagedComputer.fromJson(data['self']),
      for (final item in data['machines']) ManagedComputer.fromJson(item),
    ];
  }

  void dispose() {
    if (_ownsClient) _client.close();
  }
}
