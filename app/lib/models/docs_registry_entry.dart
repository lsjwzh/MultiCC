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
    this.permanent = false,
    this.expired = false,
    this.createdAt = '',
    this.artifactId,
    this.port,
    this.startCmd,
    this.cwd,
    this.dir = '',
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

  /// 📌 置顶 — ordering only: the row sorts to the top of every list and
  /// nothing else. Independent of [permanent].
  final bool pinned;

  /// 🔒 永久保留 — the only retention promise: the row is never taken by the
  /// 7-day artifact cleanup and never evicted from the registry. Independent
  /// of [pinned] (a row may be either, both, or neither).
  final bool permanent;

  /// Absolute project directory this row belongs to (a task worktree path is
  /// normalized to the project it is of, server-side). '' when unknown — rows
  /// published before `dir` existed, or with no resolvable session directory.
  final String dir;

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

  /// basename of [dir] — the 按目录 group header's title. '' when [dir] is
  /// empty (the caller then shows the 「未归属目录」 label instead).
  String get dirName => basename(dir);

  /// Path splitting without package:path (this file imports nothing): the
  /// server hands over an absolute POSIX-style path, so the last segment after
  /// the final separator is the name. A trailing separator is tolerated
  /// because it is meaningless for display.
  static String basename(String dir) {
    var d = dir;
    while (d.endsWith('/')) {
      d = d.substring(0, d.length - 1);
    }
    if (d.isEmpty) return '';
    final i = d.lastIndexOf('/');
    return i < 0 ? d : d.substring(i + 1);
  }

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
        permanent: j['permanent'] == true,
        expired: j['expired'] == true,
        createdAt: (j['createdAt'] ?? '').toString(),
        artifactId: j['artifactId']?.toString(),
        port: _asInt(j['port']),
        startCmd: j['startCmd']?.toString(),
        cwd: j['cwd']?.toString(),
        dir: (j['dir'] ?? '').toString(),
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
    'permanent': permanent,
    'expired': expired,
    'createdAt': createdAt,
    if (artifactId != null) 'artifactId': artifactId,
    if (port != null) 'port': port,
    if (startCmd != null) 'startCmd': startCmd,
    if (cwd != null) 'cwd': cwd,
    'dir': dir,
    if (status != null) 'status': status,
    if (pid != null) 'pid': pid,
    if (lastCheckAt != null) 'lastCheckAt': lastCheckAt,
    if (lastUpAt != null) 'lastUpAt': lastUpAt,
  };
}
