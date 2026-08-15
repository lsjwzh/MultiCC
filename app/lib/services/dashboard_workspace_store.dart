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
  final int generation;

  const _WorkspaceEntry({
    required this.service,
    required this.snapshot,
    required this.listener,
    required this.generation,
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
  final Map<String, int> _directoryGenerations = {};
  int _nextGeneration = 0;
  bool _disposed = false;

  DirectoryWorkspaceSnapshotListener? _onDirectorySnapshot;
  void Function(String sessionId, String state, String message)? _onNotify;
  VoidCallback? _onSessionCliChanged;
  void Function(String sessionId, String? label)? _onSessionUpdated;

  DashboardWorkspaceStore({
    required this.settings,
    WorkspaceServiceFactory? createService,
  }) : _createService =
           createService ??
           ((settings, dirId) =>
               WorkspaceService(settings: settings, dirId: dirId));

  int get connectionCount => _entries.length;

  Set<String> get directoryIds => Set.unmodifiable(_entries.keys.toSet());

  /// Installs the dashboard host callbacks as one lifecycle-owned binding.
  ///
  /// Widgets must not assign transport callbacks while building. The
  /// dashboard workspace coordinator owns this binding and clears it
  /// before detaching from its SessionManager source.
  void configureCallbacks({
    required DirectoryWorkspaceSnapshotListener onDirectorySnapshot,
    required void Function(String sessionId, String state, String message)
    onNotify,
    VoidCallback? onSessionCliChanged,
    void Function(String sessionId, String? label)? onSessionUpdated,
  }) {
    if (_disposed) return;
    _onDirectorySnapshot = onDirectorySnapshot;
    _onNotify = onNotify;
    _onSessionCliChanged = onSessionCliChanged;
    _onSessionUpdated = onSessionUpdated;
  }

  void clearCallbacks() {
    _onDirectorySnapshot = null;
    _onNotify = null;
    _onSessionCliChanged = null;
    _onSessionUpdated = null;
  }

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
    final generation = ++_nextGeneration;
    _directoryGenerations[dirId] = generation;
    late final _WorkspaceEntry entry;
    void listener() {
      if (_disposed || !identical(_entries[dirId], entry)) return;
      final next = DirectoryWorkspaceSnapshot.fromService(service);
      snapshot.value = next;
      _onDirectorySnapshot?.call(dirId, next);
    }

    service.onNotify = (sessionId, state, message) {
      if (_disposed || !identical(_entries[dirId], entry)) return;
      _onNotify?.call(sessionId, state, message);
    };
    service.onSessionCliChanged = () {
      if (_disposed || !identical(_entries[dirId], entry)) return;
      _onSessionCliChanged?.call();
    };
    service.onSessionUpdated = (sessionId, label) {
      if (_disposed || !identical(_entries[dirId], entry)) return;
      _onSessionUpdated?.call(sessionId, label);
    };
    service.addListener(listener);
    entry = _WorkspaceEntry(
      service: service,
      snapshot: snapshot,
      listener: listener,
      generation: generation,
    );
    _entries[dirId] = entry;
    service.connect();
  }

  ValueListenable<DirectoryWorkspaceSnapshot>? listenableFor(String dirId) =>
      _entries[dirId]?.snapshot;

  DirectoryWorkspaceSnapshot snapshotFor(String dirId) =>
      _entries[dirId]?.snapshot.value ?? DirectoryWorkspaceSnapshot.empty;

  void _removeDirectory(String dirId, {required bool reportEmpty}) {
    final entry = _entries.remove(dirId);
    if (entry == null) return;
    entry.service.onNotify = null;
    entry.service.onSessionCliChanged = null;
    entry.service.onSessionUpdated = null;
    entry.service.removeListener(entry.listener);
    entry.service.dispose();
    entry.snapshot.dispose();
    if (reportEmpty) {
      // Reconciliation runs from a SessionManager listener. Defer aggregate
      // cleanup so the manager finishes its current notification before the
      // workspace projection publishes the removal.
      scheduleMicrotask(() {
        final isLatestRemoval =
            _directoryGenerations[dirId] == entry.generation &&
            !_entries.containsKey(dirId);
        if (!_disposed && isLatestRemoval) {
          _onDirectorySnapshot?.call(dirId, DirectoryWorkspaceSnapshot.empty);
        }
      });
    }
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    clearCallbacks();
    final ids = _entries.keys.toList(growable: false);
    for (final id in ids) {
      _removeDirectory(id, reportEmpty: false);
    }
  }
}
