import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';

import 'dashboard_workspace_store.dart';

typedef DashboardDirectoryIdsReader = Iterable<String> Function();
typedef DashboardWorkspaceNotificationSink =
    void Function(String sessionId, String state, String message);
typedef DashboardWorkspaceReplayScheduler =
    void Function(VoidCallback callback);

/// Owns the lifecycle boundary between dashboard state and workspace sockets.
///
/// The coordinator listens to the SessionManager-compatible [Listenable],
/// reconciles only when its directory-id set changes, and installs the store's
/// callbacks once per binding. UI build methods remain pure consumers.
class DashboardWorkspaceCoordinator {
  final DashboardWorkspaceStore store;
  final DashboardWorkspaceReplayScheduler _scheduleReplay;

  Listenable? _source;
  DashboardDirectoryIdsReader? _readDirectoryIds;
  Set<String>? _lastDirectoryIds;
  int _attachmentGeneration = 0;
  bool _disposed = false;

  DashboardWorkspaceCoordinator({
    required this.store,
    DashboardWorkspaceReplayScheduler? scheduleReplay,
  }) : _scheduleReplay = scheduleReplay ?? _scheduleAfterFrame;

  static void _scheduleAfterFrame(VoidCallback callback) {
    SchedulerBinding.instance.addPostFrameCallback((_) => callback());
  }

  void attach({
    required Listenable source,
    required DashboardDirectoryIdsReader readDirectoryIds,
    required DirectoryWorkspaceSnapshotListener onDirectorySnapshot,
    required DashboardWorkspaceNotificationSink onNotify,
  }) {
    if (_disposed) return;

    final attachmentGeneration = ++_attachmentGeneration;
    final sourceChanged = !identical(_source, source);
    final replacingBinding = _source != null;
    if (sourceChanged) {
      _source?.removeListener(_handleSourceChanged);
      _source = source;
      _source!.addListener(_handleSourceChanged);
    }
    _readDirectoryIds = readDirectoryIds;
    store.configureCallbacks(
      onDirectorySnapshot: onDirectorySnapshot,
      onNotify: onNotify,
    );
    _reconcileDirectories();
    if (replacingBinding) {
      _scheduleCurrentSnapshotsReplay(
        attachmentGeneration: attachmentGeneration,
        source: source,
        onDirectorySnapshot: onDirectorySnapshot,
      );
    }
  }

  void _handleSourceChanged() => _reconcileDirectories();

  void _reconcileDirectories() {
    if (_disposed) return;
    final read = _readDirectoryIds;
    if (read == null) return;
    final next = read().where((id) => id.isNotEmpty).toSet();
    final previous = _lastDirectoryIds;
    if (previous != null && _sameIds(previous, next)) return;
    _lastDirectoryIds = Set.unmodifiable(next);
    store.syncDirectories(next);
  }

  bool _sameIds(Set<String> left, Set<String> right) =>
      left.length == right.length && left.containsAll(right);

  void _scheduleCurrentSnapshotsReplay({
    required int attachmentGeneration,
    required Listenable source,
    required DirectoryWorkspaceSnapshotListener onDirectorySnapshot,
  }) {
    _scheduleReplay(() {
      if (_disposed ||
          attachmentGeneration != _attachmentGeneration ||
          !identical(_source, source)) {
        return;
      }
      for (final dirId in store.directoryIds) {
        onDirectorySnapshot(dirId, store.snapshotFor(dirId));
      }
    });
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _attachmentGeneration++;
    _source?.removeListener(_handleSourceChanged);
    _source = null;
    _readDirectoryIds = null;
    _lastDirectoryIds = null;
    store.clearCallbacks();
  }
}
