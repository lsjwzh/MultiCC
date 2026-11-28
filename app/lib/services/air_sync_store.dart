import 'dart:convert';

/// Rebuildable, bounded client read model. Cursors belong to one server epoch.
class AirSyncStore {
  Map<String, dynamic>? metadata;
  String cursor = '';
  final rows = <String, Map<String, dynamic>>{};
  final _versions = <String, int>{};
  final _recent = <String>{};

  static String epoch(String value) => value.split(':').first;
  static int revision(String value) =>
      int.tryParse(value.split(':').last) ?? -1;
  static bool valid(String value) =>
      value.split(':').length == 2 && revision(value) >= 0;

  void replace(Map<String, dynamic> response) {
    final next = '${response['cursor']}';
    if (!valid(next)) throw const FormatException('invalid Air cursor');
    if (epoch(next) == epoch(cursor) && revision(next) < revision(cursor)) {
      return;
    }
    metadata = Map.of(response)..remove('tasks');
    final sameEpoch = epoch(next) == epoch(cursor);
    cursor = next;
    // Bootstrap is partial. Same-epoch reconnects must retain rows referenced by
    // visible pages; trim() removes them once those pages have been refreshed.
    if (!sameEpoch) {
      rows.clear();
      _versions.clear();
    }
    _recent.clear();
    put(response['tasks'] as List? ?? [], next, recent: true);
  }

  bool delta(Map<String, dynamic> event) {
    final next = '${event['cursor']}', previous = '${event['previous']}';
    if (metadata == null ||
        !valid(next) ||
        !valid(previous) ||
        epoch(next) != epoch(cursor) ||
        epoch(previous) != epoch(cursor)) {
      return false;
    }
    if (revision(next) <= revision(cursor)) return true;
    // A merged HTTP catchup may overlap frames already received over WS.
    if (revision(previous) > revision(cursor)) return false;
    cursor = next;
    final meta = event['metadata'];
    if (meta is Map) metadata!.addAll(meta.cast<String, dynamic>());
    if (event['taskStats'] is Map) metadata!['taskStats'] = event['taskStats'];
    put(event['tasks'] as List? ?? [], next, recent: true);
    for (final id in event['deleted'] as List? ?? []) {
      rows.remove('$id');
      _versions.remove('$id');
      _recent.remove('$id');
    }
    return true;
  }

  void put(List tasks, String version, {bool recent = false}) {
    if (epoch(version) != epoch(cursor)) return;
    for (final value in tasks.whereType<Map>()) {
      final id = '${value['id']}';
      if ((_versions[id] ?? -1) > revision(version)) continue;
      rows[id] = Map<String, dynamic>.from(value);
      _versions[id] = revision(version);
      if (recent) _recent.add(id);
    }
  }

  void trim(Iterable<String> keep) {
    int at(String id) {
      final row = rows[id];
      return ((row?['lastMessageAt'] ?? row?['updatedAt'] ?? 0) as num).toInt();
    }

    final recent =
        _recent.where((id) => rows[id]?['status'] != 'archived').toList()
          ..sort((a, b) => at(b).compareTo(at(a)));
    _recent
      ..clear()
      ..addAll(recent.take(30));
    final retained = {
      ...keep,
      ..._recent,
      for (final id in metadata?['taskPins'] as List? ?? [])
        if (rows['$id']?['status'] != 'archived') '$id',
    };
    rows.removeWhere((id, _) => !retained.contains(id));
    _versions.removeWhere((id, _) => !retained.contains(id));
  }

  Map<String, dynamic> snapshot() => {
    ...?metadata,
    'cursor': cursor,
    'tasks': rows.values.toList(),
  };
}

class AirPageResult {
  const AirPageResult({required this.body, required this.signature});
  final Map<String, dynamic> body;
  final String signature;
  int get page => (body['page'] as num).toInt();
  int get pages => (body['pages'] as num).toInt();
  int get total => (body['total'] as num).toInt();
  List<String> get ids => [
    for (final row in body['tasks'] as List) '${row['id']}',
  ];
}

String airPageSignature(Map<String, dynamic> query) => jsonEncode(query);
