import 'dart:convert';

/// 分享码前缀。出借方生成时就把「怎么连」写进前缀，接收方不需要二次猜测：
/// `mcrelay1.` 是借道线路（反代或远程 CLI），`mcssh1.` 是反重力 agy 的
/// SSH 借用账号（一次性私钥随码下发）。
const String relayShareCodePrefix = 'mcrelay1.';
const String sshShareCodePrefix = 'mcssh1.';

/// 解码后的分享码内容。字段按前缀各有取舍，未使用的保持空。
class ShareCodePayload {
  const ShareCodePayload({
    required this.kind,
    required this.appType,
    this.name = '',
    this.baseUrl = '',
    this.authToken = '',
    this.relayShareId,
    this.mode,
    this.model,
    this.models = const [],
    this.sshTarget = '',
    this.sshPort,
    this.identityKey = '',
    this.fileMode = 'mutagen',
  });

  /// `relay` 或 `ssh`。
  final String kind;

  /// `claude` / `codex` / `agy`。
  final String appType;
  final String name;

  // 借道码。
  final String baseUrl;
  final String authToken;
  final String? relayShareId;

  /// `proxy` 或 `cli`；旧版分享码没有这个字段。
  final String? mode;
  final String? model;
  final List<String> models;

  // SSH 借用码。
  final String sshTarget;
  final int? sshPort;
  final String identityKey;

  /// `mutagen` 或 `remote_mcp`。
  final String fileMode;

  bool get isSsh => kind == 'ssh';

  /// 反重力走 `POST /api/agy/accounts/remote`，其余 appType 是普通线路。
  bool get isAgy => appType == 'agy';

  String get modeLabel => isSsh
      ? 'SSH 借用（${fileMode == 'remote_mcp' ? 'remote_mcp' : 'Mutagen 双向同步'}）'
      : mode == 'cli'
          ? '远程 CLI 分享'
          : '反代分享';

  String get modeHint => isSsh
      ? '借用码里带着对方借给你的私钥，会存到本机 0600 文件；连不上对方 SSH 时会导入失败。'
      : mode == 'cli'
          ? '对方免装 Claude / Codex CLI：由出借方运行原装 CLI，文件读写与命令回调到本机真机执行。'
          : '对方本机照常安装 CLI：API 请求经出借方代理转发，只共享这一条 AI 线路。';
}

/// 解析结果，同一时间只有 [payload] 或 [error] 之一。
class ShareCodeResult {
  const ShareCodeResult.ok(ShareCodePayload this.payload) : error = null;
  const ShareCodeResult.fail(String this.error) : payload = null;

  final ShareCodePayload? payload;
  final String? error;
}

/// 按前缀分流。不认识的码交给借道解析器，由它给出「应以 mcrelay1. 开头」。
ShareCodeResult parseShareCode(String raw) {
  final text = raw.trim();
  if (text.startsWith(sshShareCodePrefix)) return _parseSshShareCode(text);
  return _parseRelayShareCode(text);
}

Map<String, dynamic>? _decodePayload(String text, String prefix) {
  final body = text.substring(prefix.length);
  try {
    final bytes = base64Url.decode(base64Url.normalize(body));
    final decoded = jsonDecode(utf8.decode(bytes));
    return decoded is Map<String, dynamic> ? decoded : null;
  } catch (_) {
    return null;
  }
}

ShareCodeResult _parseRelayShareCode(String text) {
  if (!text.startsWith(relayShareCodePrefix)) {
    return const ShareCodeResult.fail('不是有效的跨设备分享码（应以 mcrelay1. 开头）');
  }
  final payload = _decodePayload(text, relayShareCodePrefix);
  if (payload == null) return const ShareCodeResult.fail('分享码无法解码，请检查是否复制完整');
  if (payload['kind'] != 'multicc-relay') {
    return const ShareCodeResult.fail('不是 MultiCC 跨设备分享码');
  }
  final appType = '${payload['appType'] ?? ''}';
  if (appType != 'claude' && appType != 'codex' && appType != 'agy') {
    return const ShareCodeResult.fail('分享码 appType 无效');
  }
  final baseUrl = '${payload['baseUrl'] ?? ''}';
  if (!RegExp(r'^https?://').hasMatch(baseUrl)) {
    return const ShareCodeResult.fail('分享码缺少 baseUrl');
  }
  final authToken = '${payload['authToken'] ?? ''}'.trim();
  if (authToken.isEmpty) return const ShareCodeResult.fail('分享码缺少安全凭据');
  final declared = payload['mode'];
  if (declared != null && declared != 'proxy' && declared != 'cli') {
    return const ShareCodeResult.fail('分享码的分享方式无效');
  }
  // 反重力没有 HTTP 反代，分享方式固定为远程 CLI；其余按码里写明的来，
  // 旧码（没有 mode）按反代导入。
  final mode = appType == 'agy' ? 'cli' : declared as String?;
  final rawModels = payload['models'];
  final models = <String>[];
  final seen = <String>{};
  if (rawModels is List) {
    for (final entry in rawModels) {
      final value = '$entry'.trim();
      if (value.isEmpty || value.length > 256 || !seen.add(value)) continue;
      models.add(value);
    }
  }
  final sharedModel = '${payload['model'] ?? ''}'.trim();
  final model = sharedModel.isNotEmpty && sharedModel.length <= 256
      ? sharedModel
      : (models.isEmpty ? null : models.first);
  if (model != null && !models.contains(model)) models.insert(0, model);
  return ShareCodeResult.ok(ShareCodePayload(
    kind: 'relay',
    appType: appType,
    name: '${payload['name'] ?? ''}',
    baseUrl: baseUrl,
    authToken: authToken,
    relayShareId: payload['relayShareId'] as String?,
    mode: mode,
    model: model,
    models: models.length > 100 ? models.sublist(0, 100) : models,
  ));
}

ShareCodeResult _parseSshShareCode(String text) {
  final payload = _decodePayload(text, sshShareCodePrefix);
  if (payload == null) return const ShareCodeResult.fail('借用码无法解码，请检查是否复制完整');
  if (payload['kind'] != 'multicc-ssh') {
    return const ShareCodeResult.fail('不是 MultiCC SSH 借用码');
  }
  if (payload['appType'] != 'agy') {
    return const ShareCodeResult.fail('SSH 借用码目前只支持反重力 agy');
  }
  final sshTarget = '${payload['sshTarget'] ?? ''}'.trim();
  if (sshTarget.isEmpty) return const ShareCodeResult.fail('借用码缺少 SSH 目标');
  final identityKey = '${payload['identityKey'] ?? ''}';
  if (!identityKey.contains('BEGIN OPENSSH PRIVATE KEY')) {
    return const ShareCodeResult.fail('借用码缺少借用的私钥');
  }
  final declared = payload['fileMode'];
  if (declared != null && declared != 'mutagen' && declared != 'remote_mcp') {
    return const ShareCodeResult.fail('借用码的同步方式无效');
  }
  final port = payload['sshPort'];
  return ShareCodeResult.ok(ShareCodePayload(
    kind: 'ssh',
    appType: 'agy',
    name: '${payload['name'] ?? ''}',
    sshTarget: sshTarget,
    sshPort: port is int && port > 0 && port <= 65535 ? port : null,
    identityKey: identityKey,
    fileMode: (declared as String?) ?? 'mutagen',
  ));
}
