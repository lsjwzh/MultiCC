// Per-role token accounting mirrored from the server's `role_token_stats`
// WS event (src/role-token-tracker.js · snapshot()):
//
//   { type: 'role_token_stats', role: {
//       main: { inputTokens, outputTokens, cacheWrite, cacheRead },
//       sub:  { … } | null,
//       subByProvider: [ { providerId, name, model, inputTokens,
//                          outputTokens, cacheWrite, cacheRead } ] } }
//
// The web shows the same data on the message's usage line (chat-live-ui.js ·
// buildUsageLine roleBreakdown branch). The app keeps its total badges and
// exposes this breakdown through a tappable detail sheet — main / sub buckets
// plus the per-provider split of the sub work.

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

/// The `role` payload of a role_token_stats event.
class RoleTokenBreakdown {
  final RoleTokenBucket main;
  final RoleTokenBucket? sub;
  final List<SubProviderTokens> subByProvider;

  const RoleTokenBreakdown({
    this.main = const RoleTokenBucket(),
    this.sub,
    this.subByProvider = const [],
  });

  /// Grand total across main + sub (the figure the usage line summarises).
  int get total =>
      main.total + (sub?.total ?? 0);

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
  static RoleTokenBreakdown? fromEvent(Map<String, dynamic> payload) {
    final role = payload['role'];
    if (role is! Map) return null;
    final byProvider = role['subByProvider'];
    return RoleTokenBreakdown(
      main: RoleTokenBucket.fromJson(role['main']),
      sub: role['sub'] == null ? null : RoleTokenBucket.fromJson(role['sub']),
      subByProvider: byProvider is List
          ? byProvider.map(SubProviderTokens.fromJson).toList(growable: false)
          : const [],
    );
  }
}
