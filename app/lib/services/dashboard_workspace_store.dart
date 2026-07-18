import 'dart:async';

import 'package:flutter/foundation.dart';

import 'settings_service.dart';
import 'workspace_service.dart';

typedef WorkspaceServiceFactory =
    WorkspaceService Function(SettingsService settings, String dirId);

typedef DirectoryWorkspaceSnapshotListener =
    void Function(String dirId, DirectoryWorkspaceSnapshot snapshot);

/// Immutable dashboard-facing projection of one directory workspace socket.
///
/// The socket itself remains private to [DashboardWorkspaceStore]. Widgets only
/// observe this narrow snapshot, so a card cannot reconnect or dispose a shared
/// transport by accident.
class DirectoryWorkspaceSnapshot {
  final Map<String, SessionStatus> statuses;
  final Map<String, int> pendingNotes;
  final List<Map<String, dynamic>> events;

  const DirectoryWorkspaceSnapshot._({
    required this.statuses,
    required this.pendingNotes,
    required this.events,
  });

  static const empty = DirectoryWorkspaceSnapshot._(
    statuses: {},
    pendingNotes: {},
    events: [],
  );

  factory DirectoryWorkspaceSnapshot.fromService(WorkspaceService service) {
    return DirectoryWorkspaceSnapshot._(
      statuses: Map.unmodifiable(service.statuses),
      pendingNotes: Map.unmodifiable(service.pendingNotes),
      events: List.unmodifiable(
        service.events.map((event) => Map<String, dynamic>.unmodifiable(event)),
      ),
    );
  }

  Set<String> get waitingSessionIds => statuses.entries
      .where((entry) => entry.value.status == 'waiting')
      .map((entry) => entry.key)
      .toSet();

  Set<String> get runningSessionIds {
    const busy = {'running', 'thinking', 'editing'};
    return statuses.entries
        .where((entry) => busy.contains(entry.value.status))
        .map((entry) => entry.key)
        .toSet();
  }
}

class _WorkspaceEntry {
  final WorkspaceService service;
  final ValueNotifier<DirectoryWorkspaceSnapshot> snapshot;
  final VoidCallback listener;

  const _WorkspaceEntry({
    required this.service,
    required this.snapshot,
    required this.listener,
  });
}

/// Dashboard-scoped owner for all per-directory workspace connections.
///
/// A directory gets exactly one [WorkspaceService] while it is present on the
/// dashboard. Directory cards and the fleet detail sheet share the same
/// [ValueListenable] projection; neither owns the connection lifecycle.
class DashboardWorkspaceStore {
  final SettingsService settings;
  final WorkspaceServiceFactory _createService;
  final Map<String, _WorkspaceEntry> _entries = {};
  bool _disposed = false;

  DirectoryWorkspaceSnapshotListener? onDirectorySnapshot;
  void Function(String sessionId, String state, String message)? onNotify;

  DashboardWorkspaceStore({
    required this.settings,
    WorkspaceServiceFactory? createService,
  }) : _createService =
           createService ??
           ((settings, dirId) =>
               WorkspaceService(settings: settings, dirId: dirId));

  int get connectionCount => _entries.length;

  Set<String> get directoryIds => Set.unmodifiable(_entries.keys.toSet());

  /// Reconcile live connections with the current dashboard directory list.
  /// Repeated calls are idempotent and never reconnect an existing directory.
  void syncDirectories(Iterable<String> directoryIds) {
    if (_disposed) return;
    final desired = directoryIds.where((id) => id.isNotEmpty).toSet();
    final removed = _entries.keys
        .where((id) => !desired.contains(id))
        .toList(growable: false);
    for (final id in removed) {
      _removeDirectory(id, reportEmpty: true);
    }
    for (final id in desired) {
      ensureDirectory(id);
    }
  }

  /// Ensure a connection exists before a consumer asks for its projection.
  void ensureDirectory(String dirId) {
    if (_disposed || dirId.isEmpty || _entries.containsKey(dirId)) return;

    final service = _createService(settings, dirId);
    final snapshot = ValueNotifier<DirectoryWorkspaceSnapshot>(
      DirectoryWorkspaceSnapshot.fromService(service),
    );
    void listener() {
      if (_disposed) return;
      final next = DirectoryWorkspaceSnapshot.fromService(service);
      snapshot.value = next;
      onDirectorySnapshot?.call(dirId, next);
    }

    service.onNotify = (sessionId, state, message) {
      if (!_disposed) onNotify?.call(sessionId, state, message);
    };
    service.addListener(listener);
    _entries[dirId] = _WorkspaceEntry(
      service: service,
      snapshot: snapshot,
      listener: listener,
    );
    service.connect();
  }

  ValueListenable<DirectoryWorkspaceSnapshot>? listenableFor(String dirId) =>
      _entries[dirId]?.snapshot;

  DirectoryWorkspaceSnapshot snapshotFor(String dirId) =>
      _entries[dirId]?.snapshot.value ?? DirectoryWorkspaceSnapshot.empty;

  void _removeDirectory(String dirId, {required bool reportEmpty}) {
    final entry = _entries.remove(dirId);
    if (entry == null) return;
    entry.service.removeListener(entry.listener);
    entry.service.dispose();
    entry.snapshot.dispose();
    if (reportEmpty) {
      // Reconciliation is normally called while Flutter is building from a
      // SessionManager update. Defer aggregate cleanup to avoid notifying that
      // manager synchronously during its descendant's build.
      scheduleMicrotask(() {
        if (!_disposed) {
          onDirectorySnapshot?.call(dirId, DirectoryWorkspaceSnapshot.empty);
        }
      });
    }
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    final ids = _entries.keys.toList(growable: false);
    for (final id in ids) {
      _removeDirectory(id, reportEmpty: false);
    }
  }
}
