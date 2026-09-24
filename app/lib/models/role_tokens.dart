// Per-role token accounting mirrored from the server's `role_token_stats`
// WS event (src/role-token-tracker.js · snapshot()):
//
//   { type: 'role_token_stats', role: {
//       main: { inputTokens, outputTokens, cacheWrite, cacheRead },
//       sub:  { … } | null,
//       subByProvider: [ { providerId, name, model, inputTokens,
//                          outputTokens, cacheWrite, cacheRead } ] } }
//
// Both the web usage line (chat-live-ui.js · buildUsageLine) and the app's
// _TokenUsageLine render it in one format: a 主 row and, only for a separately
// configured sub model, a 辅 row (fresh in/out + cache read/write each). The
// app's detail sheet adds the per-provider split of the sub work.

/// One role's (or one provider's) accumulated token bucket.
class RoleTokenBucket {
  final int inputTokens;
  final int outputTokens;
  final int cacheWrite;
  final int cacheRead;

  const RoleTokenBucket({
    this.inputTokens = 0,
    this.outputTokens = 0,
    this.cacheWrite = 0,
    this.cacheRead = 0,
  });

  int get total => inputTokens + outputTokens + cacheWrite + cacheRead;

  bool get isEmpty => total == 0;

  factory RoleTokenBucket.fromJson(dynamic json) {
    if (json is! Map) return const RoleTokenBucket();
    int readNum(dynamic v) => (v as num?)?.toInt() ?? 0;
    return RoleTokenBucket(
      inputTokens: readNum(json['inputTokens']),
      outputTokens: readNum(json['outputTokens']),
      cacheWrite: readNum(json['cacheWrite']),
      cacheRead: readNum(json['cacheRead']),
    );
  }
}

/// One provider's share of the sub-agent work (`subByProvider` entry).
class SubProviderTokens {
  final String providerId;
  final String name;
  final String model;
  final RoleTokenBucket bucket;

  const SubProviderTokens({
    required this.providerId,
    this.name = '',
    this.model = '',
    this.bucket = const RoleTokenBucket(),
  });

  /// Display label: the human provider name when present, else the id.
  String get label => name.isNotEmpty ? name : providerId;

  factory SubProviderTokens.fromJson(dynamic json) {
    if (json is! Map) {
      return const SubProviderTokens(providerId: '');
    }
    return SubProviderTokens(
      providerId: json['providerId']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      model: json['model']?.toString() ?? '',
      bucket: RoleTokenBucket.fromJson(json),
    );
  }
}

/// The `role` payload of a role_token_stats event — also persisted on an
/// assistant history message as `roleUsage` when the turn had sub usage.
class RoleTokenBreakdown {
  final RoleTokenBucket main;
  final RoleTokenBucket? sub;
  final List<SubProviderTokens> subByProvider;
  final List<SubProviderTokens> mainByProvider;

  const RoleTokenBreakdown({
    this.main = const RoleTokenBucket(),
    this.sub,
    this.subByProvider = const [],
    this.mainByProvider = const [],
  });

  /// Whether the sub-agents ran on a separately configured provider/model.
  /// Same rule as the web usage line (chat-live-ui.js hasSeparateSubModel):
  /// unknown provider lists count as separate; otherwise any sub
  /// provider/model pair the main role did not use makes it separate.
  bool get hasSeparateSubModel {
    if (subByProvider.isEmpty || mainByProvider.isEmpty) return true;
    String key(SubProviderTokens p) => '${p.providerId}|${p.model}';
    final mainKeys = mainByProvider.map(key).toSet();
    return subByProvider.any((p) => !mainKeys.contains(key(p)));
  }

  /// Grand total across main + sub (the figure the usage line summarises).
  int get total => main.total + (sub?.total ?? 0);

  bool get isEmpty => total == 0;

  /// Main-model tokens saved by offloading to sub-roles — same sum the web
  /// tooltip and the app's `省主≈` badge show (sub in+out+cacheWrite+cacheRead).
  int get savedMainTokens {
    final s = sub;
    if (s == null) return 0;
    return s.inputTokens + s.outputTokens + s.cacheWrite + s.cacheRead;
  }

  /// Parse a role_token_stats event payload. Returns null when the event has
  /// no `role` object (nothing to show — callers keep the previous state).
  static RoleTokenBreakdown? fromEvent(Map<String, dynamic> payload) =>
      fromRole(payload['role']);

  /// Parse a bare role object (event `role` or history `roleUsage`).
  static RoleTokenBreakdown? fromRole(dynamic role) {
    if (role is! Map) return null;
    List<SubProviderTokens> providers(dynamic list) => list is List
        ? list.map(SubProviderTokens.fromJson).toList(growable: false)
        : const [];
    return RoleTokenBreakdown(
      main: RoleTokenBucket.fromJson(role['main']),
      sub: role['sub'] == null ? null : RoleTokenBucket.fromJson(role['sub']),
      subByProvider: providers(role['subByProvider']),
      mainByProvider: providers(role['mainByProvider']),
    );
  }
}
