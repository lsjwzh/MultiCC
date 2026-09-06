/// One row of the server's docs & web-services registry
/// (GET /api/docs-registry — see src/docs-registry.js). Mirrors the /manage
/// 「服务与文档」panel: agent-published artifact pages/files (temporary, 7-day
/// cleanup unless pinned) and user-registered local web services with probe
/// status and start/stop supervision.
class DocsRegistryEntry {
  const DocsRegistryEntry({
    required this.id,
    required this.kind,
    required this.title,
    required this.url,
    this.note = '',
    this.sessionId = '',
    this.source = '',
    this.pinned = false,
    this.expired = false,
    this.createdAt = '',
    this.artifactId,
    this.port,
    this.startCmd,
    this.cwd,
    this.status,
    this.pid,
    this.lastCheckAt,
    this.lastUpAt,
  });

  final String id;

  /// 'page' | 'file' | 'service'.
  final String kind;
  final String title;

  /// Root-relative same-origin path (artifacts, /docs/…) or an absolute
  /// http(s) URL (local dev services, tunnel hostnames).
  final String url;
  final String note;

  /// Originating session label, when an agent published this.
  final String sessionId;

  /// 'agent' | 'user' | …
  final String source;

  /// Pinned entries are exempt from the 7-day artifact cleanup.
  final bool pinned;

  /// Artifact-backed rows whose directory was cleaned up.
  final bool expired;

  /// ISO timestamp; the server list arrives newest-first.
  final String createdAt;

  /// Derived server-side from `/artifacts/<id>/…` URLs (expiry / pin tracking).
  final String? artifactId;

  // ── service lifecycle (kind == 'service') ──
  final int? port;
  final String? startCmd;
  final String? cwd;

  /// 'up' | 'down' | 'starting' | 'unknown' — server TCP-probes every 30s.
  final String? status;
  final int? pid;
  final String? lastCheckAt;
  final String? lastUpAt;

  bool get isService => kind == 'service';

  bool get canStart => isService && (startCmd ?? '').isNotEmpty;

  /// Stop is offered whenever the server knows a pid (status up/starting).
  bool get canStop => isService && (status == 'up' || status == 'starting');

  static int? _asInt(Object? v) =>
      v is num ? v.toInt() : (v is String ? int.tryParse(v) : null);

  static DocsRegistryEntry fromJson(Map<String, dynamic> j) =>
      DocsRegistryEntry(
        id: (j['id'] ?? '').toString(),
        kind: (j['kind'] ?? 'page').toString(),
        title: (j['title'] ?? '').toString(),
        url: (j['url'] ?? '').toString(),
        note: (j['note'] ?? '').toString(),
        sessionId: (j['sessionId'] ?? '').toString(),
        source: (j['source'] ?? '').toString(),
        pinned: j['pinned'] == true,
        expired: j['expired'] == true,
        createdAt: (j['createdAt'] ?? '').toString(),
        artifactId: j['artifactId']?.toString(),
        port: _asInt(j['port']),
        startCmd: j['startCmd']?.toString(),
        cwd: j['cwd']?.toString(),
        status: j['status']?.toString(),
        pid: _asInt(j['pid']),
        lastCheckAt: j['lastCheckAt']?.toString(),
        lastUpAt: j['lastUpAt']?.toString(),
      );

  Map<String, dynamic> toJson() => {
    'id': id,
    'kind': kind,
    'title': title,
    'url': url,
    'note': note,
    'sessionId': sessionId,
    'source': source,
    'pinned': pinned,
    'expired': expired,
    'createdAt': createdAt,
    if (artifactId != null) 'artifactId': artifactId,
    if (port != null) 'port': port,
    if (startCmd != null) 'startCmd': startCmd,
    if (cwd != null) 'cwd': cwd,
    if (status != null) 'status': status,
    if (pid != null) 'pid': pid,
    if (lastCheckAt != null) 'lastCheckAt': lastCheckAt,
    if (lastUpAt != null) 'lastUpAt': lastUpAt,
  };
}
