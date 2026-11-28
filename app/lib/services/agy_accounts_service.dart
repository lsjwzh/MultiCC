import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'settings_service.dart';

final RegExp _agyAccountIdPattern = RegExp(r'^[a-f0-9]{16}$');

/// 单条 Antigravity (`agy`) 账号记录（含本机隔离 HOME 账号与远程 SSH / 借道共享账号）。
class AgyAccount {
  const AgyAccount({
    required this.id,
    required this.kind,
    required this.label,
    this.email,
    this.loggedIn = false,
    this.expiresAt,
    this.active = false,
    this.transport,
    this.sshTarget,
  });

  factory AgyAccount.fromJson(Map<String, dynamic> json) {
    final remote = json['remote'];
    final remoteMap = remote is Map ? remote : null;
    final rawExpires = json['expiresAt'];
    return AgyAccount(
      id: (json['id'] ?? '').toString().trim(),
      kind: (json['kind'] ?? 'local').toString(),
      label: (json['label'] ?? '').toString().trim(),
      email: _nonEmpty(json['email']),
      loggedIn: json['loggedIn'] == true,
      expiresAt: rawExpires is num ? rawExpires.toInt() : int.tryParse('${rawExpires ?? ''}'),
      active: json['active'] == true,
      transport: _nonEmpty(remoteMap?['transport']),
      sshTarget: _nonEmpty(remoteMap?['sshTarget']),
    );
  }

  final String id;
  final String kind;
  final String label;
  final String? email;
  final bool loggedIn;
  final int? expiresAt;
  final bool active;
  final String? transport;
  final String? sshTarget;

  bool get isRemote => kind == 'remote';

  String get shortId => id.length >= 6 ? id.substring(0, 6) : id;

  String get displayName {
    if (label.isNotEmpty) return label;
    if (email != null && email!.isNotEmpty) return email!;
    return '反重力账号 $shortId';
  }

  String get optionLabel {
    final base = label.isNotEmpty ? label : '反重力账号 $shortId';
    final status = loggedIn ? (email ?? '已登录') : '未登录';
    if (isRemote &&
        !base.contains('借用') &&
        !base.contains('借道') &&
        !base.contains('共享')) {
      final tag = transport == 'ssh' ? 'SSH 借用' : '远程共享';
      return '$base · $tag · $status';
    }
    return '$base · $status';
  }
}

/// `GET /api/agy/accounts` 返回的完整快照。
class AgyAccountsSnapshot {
  const AgyAccountsSnapshot({
    this.accounts = const [],
    this.activeId,
    this.localLoggedIn = false,
    this.localEmail,
    this.cliInstalled = true,
    this.installCommand = 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  });

  factory AgyAccountsSnapshot.fromJson(Map<String, dynamic> json) {
    final rawList = json['accounts'];
    final accounts = <AgyAccount>[];
    if (rawList is List) {
      for (final item in rawList) {
        if (item is! Map) continue;
        final parsed = AgyAccount.fromJson(item.cast<String, dynamic>());
        if (_agyAccountIdPattern.hasMatch(parsed.id)) {
          accounts.add(parsed);
        }
      }
    }
    final local = json['local'] is Map ? json['local'] as Map : null;
    final cli = json['cli'] is Map ? json['cli'] as Map : null;
    return AgyAccountsSnapshot(
      accounts: accounts,
      activeId: _nonEmpty(json['active']),
      localLoggedIn: local?['loggedIn'] == true,
      localEmail: _nonEmpty(local?['email']),
      cliInstalled: cli?['installed'] != false,
      installCommand: _nonEmpty(cli?['installCommand']) ??
          'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    );
  }

  final List<AgyAccount> accounts;
  final String? activeId;
  final bool localLoggedIn;
  final String? localEmail;
  final bool cliInstalled;
  final String installCommand;

  AgyAccount? findById(String? id) {
    if (id == null || id.isEmpty) return null;
    for (final account in accounts) {
      if (account.id == id) return account;
    }
    return null;
  }

  /// 默认选项文案（对齐 Web `run-config-controls.js` 的 `defaultOptionLabel`）。
  String get defaultOptionLabel {
    if (activeId != null && activeId!.isNotEmpty) {
      final activeAccount = findById(activeId);
      final name = activeAccount?.displayName ??
          (activeId!.length >= 6 ? activeId!.substring(0, 6) : activeId!);
      return '跟随全局默认（$name）';
    }
    if (localLoggedIn && localEmail != null && localEmail!.isNotEmpty) {
      return '本机 agy 登录（$localEmail）';
    }
    return '本机 agy 登录（默认）';
  }

  /// 胶囊 / 摘要短文案。
  String chipLabelFor(String? accountId) {
    final picked = findById(accountId);
    if (picked != null) return picked.displayName;
    if (accountId != null && accountId.isNotEmpty) {
      return '账号 ${accountId.length >= 6 ? accountId.substring(0, 6) : accountId}';
    }
    final active = findById(activeId);
    if (active != null) return active.displayName;
    if (localLoggedIn && localEmail != null && localEmail!.isNotEmpty) {
      return localEmail!;
    }
    return '本机默认';
  }
}

String? _nonEmpty(Object? value) {
  if (value == null) return null;
  final s = value.toString().trim();
  return s.isEmpty ? null : s;
}

/// Antigravity 账号目录与全局默认管理服务（自动适配多电脑代理 URL）。
class AgyAccountsService {
  AgyAccountsService({required this.settings, this.httpClient});

  final SettingsService settings;
  final http.Client? httpClient;

  static final Map<String, AgyAccountsSnapshot> _cache = {};

  String _endpoint([String suffix = '']) =>
      settings.buildHttpUrl('/api/agy/accounts$suffix');

  Map<String, String> get _headers => <String, String>{
    'Content-Type': 'application/json',
    if (settings.token.isNotEmpty) 'X-Access-Token': settings.token,
  };

  static AgyAccountsSnapshot? cachedFor(SettingsService? settings) {
    if (settings == null) return null;
    return _cache[settings.buildHttpUrl('/api/agy/accounts')];
  }

  @visibleForTesting
  static void clearCache() => _cache.clear();

  Future<AgyAccountsSnapshot> load({bool force = false}) async {
    final key = _endpoint();
    if (!force && _cache.containsKey(key)) {
      return _cache[key]!;
    }
    final res = await _send('GET', '/api/agy/accounts');
    if (res.statusCode >= 400) {
      throw Exception(_parseError(res));
    }
    final body = (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
    final snapshot = AgyAccountsSnapshot.fromJson(body);
    _cache[key] = snapshot;
    return snapshot;
  }

  Future<AgyAccountsSnapshot> _snapshotOrReload(http.Response res) async {
    final map = (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
    if (map['accounts'] is! List) {
      return load(force: true);
    }
    final snapshot = AgyAccountsSnapshot.fromJson(map);
    _cache[_endpoint()] = snapshot;
    return snapshot;
  }

  Future<AgyAccountsSnapshot> activate(String accountId) async {
    final res = await _send(
      'POST',
      '/api/agy/accounts/${Uri.encodeComponent(accountId)}/activate',
      body: '{}',
    );
    if (res.statusCode >= 400) throw Exception(_parseError(res));
    return _snapshotOrReload(res);
  }

  Future<AgyAccountsSnapshot> deactivate() async {
    final res = await _send('POST', '/api/agy/accounts/deactivate', body: '{}');
    if (res.statusCode >= 400) throw Exception(_parseError(res));
    return _snapshotOrReload(res);
  }

  Future<AgyAccountsSnapshot> importLocal({String label = ''}) async {
    final res = await _send(
      'POST',
      '/api/agy/accounts/import',
      body: jsonEncode({'label': label}),
    );
    if (res.statusCode >= 400) throw Exception(_parseError(res));
    return _snapshotOrReload(res);
  }

  Future<Map<String, dynamic>> testAccount(String accountId) async {
    final res = await _send(
      'POST',
      '/api/agy/accounts/${Uri.encodeComponent(accountId)}/test',
      body: '{}',
      timeout: const Duration(seconds: 30),
    );
    if (res.statusCode >= 400) throw Exception(_parseError(res));
    return (jsonDecode(utf8.decode(res.bodyBytes)) as Map)
        .cast<String, dynamic>();
  }

  Future<AgyAccountsSnapshot> deleteAccount(String accountId) async {
    final res = await _send(
      'DELETE',
      '/api/agy/accounts/${Uri.encodeComponent(accountId)}',
    );
    if (res.statusCode >= 400) throw Exception(_parseError(res));
    return _snapshotOrReload(res);
  }

  Future<http.Response> _send(
    String method,
    String path, {
    String? body,
    Duration timeout = const Duration(seconds: 15),
  }) async {
    final uri = Uri.parse(settings.buildHttpUrl(path));
    final client = httpClient;
    if (client != null) {
      final req = http.Request(method, uri)..headers.addAll(_headers);
      if (body != null) req.body = body;
      final streamed = await client.send(req).timeout(timeout);
      return http.Response.fromStream(streamed);
    }
    return switch (method) {
      'GET' => http.get(uri, headers: _headers).timeout(timeout),
      'POST' => http.post(uri, headers: _headers, body: body).timeout(timeout),
      'DELETE' => http.delete(uri, headers: _headers).timeout(timeout),
      _ => throw UnsupportedError('unsupported HTTP method $method'),
    };
  }

  String _parseError(http.Response res) {
    try {
      final decoded = jsonDecode(utf8.decode(res.bodyBytes));
      if (decoded is Map && decoded['error'] != null) {
        return decoded['error'].toString();
      }
    } catch (_) {}
    return 'HTTP ${res.statusCode}';
  }
}
