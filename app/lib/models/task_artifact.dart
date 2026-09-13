/// 一条任务产物 —— `GET /api/task-shells/:shellId/artifacts` 的 `items[]`
/// （服务端 shape 见 src/task-shell/artifacts.js:21）。
class TaskArtifact {
  const TaskArtifact({
    required this.url,
    required this.title,
    required this.artifactId,
    required this.kind,
    required this.createdAt,
    required this.expired,
  });

  final String url;
  final String title;
  final String artifactId;

  /// `page`（网页）或 `file`（文件）—— 只影响列表里那个前缀字。
  final String kind;

  /// ISO 时间戳；服务端有时给不出来（没登记过的产物），那就是 null。
  final String? createdAt;

  /// 磁盘上的文件已经没了（7 天清理、或者目录被删）。仍然列出来，只是标一句
  /// 「已失效」—— 从列表里消失会让人以为从来没生成过。
  final bool expired;

  bool get isPage => kind == 'page';

  /// 列表里那行日期，对齐 web 的 `new Date(iso).toLocaleDateString()`：
  /// 服务端给的是带 `Z` 的 ISO，转本地时区才是用户看到的那一天。
  String get dateLabel {
    final raw = createdAt;
    if (raw == null || raw.isEmpty) return '';
    final parsed = DateTime.tryParse(raw);
    if (parsed == null) return '';
    final local = parsed.toLocal();
    return '${local.year}/${local.month}/${local.day}';
  }

  static TaskArtifact? fromJson(Map<String, dynamic> json) {
    final url = json['url'];
    if (url is! String || !isArtifactUrl(url)) return null;
    return TaskArtifact(
      url: url,
      title: json['title']?.toString() ?? url,
      artifactId: json['artifactId']?.toString() ?? '',
      kind: json['kind']?.toString() ?? 'file',
      createdAt: json['createdAt']?.toString(),
      expired: json['expired'] == true,
    );
  }
}

/// 一次产物查询的结果。`taskId` 为 null 表示这个 shell 当下没有归属任务
/// （服务端 src/task-shell/routes.js:37 的 `{taskId:'', title:'', items:[]}`）。
class TaskArtifactList {
  const TaskArtifactList({
    required this.taskId,
    required this.title,
    required this.items,
  });

  final String? taskId;
  final String title;
  final List<TaskArtifact> items;

  static const empty = TaskArtifactList(taskId: null, title: '', items: []);

  factory TaskArtifactList.fromJson(Map<String, dynamic> json) {
    final rawTaskId = json['taskId']?.toString();
    final items = <TaskArtifact>[];
    for (final item in json['items'] as List? ?? const []) {
      if (item is! Map) continue;
      final parsed = TaskArtifact.fromJson(Map<String, dynamic>.from(item));
      // 不合白名单的整条丢掉，跟 web 的 `.filter(...)` 一样。
      if (parsed != null) items.add(parsed);
    }
    return TaskArtifactList(
      taskId: rawTaskId == null || rawTaskId.isEmpty ? null : rawTaskId,
      title: json['title']?.toString() ?? '',
      items: items,
    );
  }
}

/// 只有 `/artifacts/<id>/...` 才是产物 —— 逐字对齐 web `task-artifacts.js` 的
/// 那个正则（外加「路径段里不许出现 . 和 ..」这条）。
///
/// 这张白名单不是洁癖：`items` 里的 url 来自模型自己写下的文本，直接渲染成
/// 可点链接就等于让模型往面板里塞任意地址。
final RegExp _artifactUrlRe = RegExp(
  r'^/artifacts/[\w-]+(?:/[\w./@+-]*)?(?:[?#][^\s\\]*)?$',
);

bool isArtifactUrl(String url) {
  if (!_artifactUrlRe.hasMatch(url)) return false;
  final path = url.split(RegExp(r'[?#]')).first;
  return !path.split('/').any((segment) => segment == '.' || segment == '..');
}
