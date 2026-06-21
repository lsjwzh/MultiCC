import 'dart:async';
import 'package:flutter/widgets.dart';

import '../models/message.dart';
import '../services/background_service.dart';
import '../services/notification_service.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import 'chat_provider.dart';

class SessionManager extends ChangeNotifier with WidgetsBindingObserver {
  final SettingsService settings;
  late final SessionService _sessionService;
  SessionService get service => _sessionService;

  /// Active ChatProviders keyed by session id (chat sessions only).
  final Map<String, ChatProvider> _providers = {};
  Map<String, ChatProvider> get allProviders => Map.unmodifiable(_providers);

  /// Currently viewed session (null = show session list).
  String? _activeSessionId;
  String? get activeSessionId => _activeSessionId;
  ChatProvider? get activeProvider =>
      _activeSessionId != null ? _providers[_activeSessionId] : null;

  /// Session list from REST API.
  List<Session> _sessions = [];
  List<Session> get sessions => List.unmodifiable(_sessions);

  /// Directory list from REST API.
  List<Directory> _directories = [];
  List<Directory> get directories => List.unmodifiable(_directories);

  bool _loadingSessions = true;
  bool get loadingSessions => _loadingSessions;
  String? _sessionsError;
  String? get sessionsError => _sessionsError;

  Timer? _refreshTimer;
  bool _isInBackground = false;

  /// When the app last went to the background, used to decide on resume whether
  /// the live sockets are worth keeping (short absence) or should be rebuilt
  /// (long absence — the OS has very likely frozen them).
  DateTime? _backgroundedAt;

  /// A background shorter than this is treated as a glance (lock-screen peek,
  /// app switch): keep the live sockets and just probe them, so unlocking
  /// doesn't reconnect/reload every session. Longer absences force a (seamless)
  /// reconnect. Mirrors the web client's hidden-duration gate.
  static const _kKeepSocketBelow = Duration(seconds: 30);

  /// A notification tap arrived for a session not yet in [_sessions] (e.g. cold
  /// start). Consumed once the dashboard finishes loading.
  String? _pendingNotificationSessionId;

  /// A tapped notification resolved to a terminal session — it can't be shown
  /// inline like a chat, so MainShell pushes the TerminalScreen for it.
  Session? _pendingTerminalSession;
  Session? get pendingTerminalSession => _pendingTerminalSession;
  void clearPendingTerminal() => _pendingTerminalSession = null;

  SessionManager({required this.settings}) {
    _sessionService = SessionService(settings: settings);
    WidgetsBinding.instance.addObserver(this);
    loadDashboard();
    _refreshTimer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => loadDashboard(),
    );
    // Route notification taps to the matching session (chat opens inline,
    // terminal gets pushed by MainShell). Flushes any cold-start payload now.
    NotificationService.setSelectHandler(openSessionFromNotification);
  }

  // ── Notification tap routing ───────────────────────────────────────────────

  /// Open the session a tapped notification points at. If it isn't loaded yet
  /// (cold start before the dashboard fetch returns), remember it and let
  /// [loadDashboard] open it once the list arrives.
  void openSessionFromNotification(String sessionId) {
    Session? match;
    for (final s in _sessions) {
      if (s.id == sessionId) {
        match = s;
        break;
      }
    }
    if (match == null) {
      _pendingNotificationSessionId = sessionId;
      loadDashboard();
      return;
    }
    _activateSession(match);
  }

  void _activateSession(Session session) {
    if (session.isChat) {
      openSession(session);
      switchToSession(session.id);
    } else {
      // Terminals live in a pushed route; hand it to MainShell to navigate.
      _pendingTerminalSession = session;
      notifyListeners();
    }
  }

  // ── App lifecycle ──────────────────────────────────────────────────────────

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      // Back in the foreground — the keep-alive foreground service (if it was
      // running) is no longer needed; drop its ongoing notification + wake lock.
      BackgroundKeepAlive.stop();
      final away = _backgroundedAt != null
          ? DateTime.now().difference(_backgroundedAt!)
          : Duration.zero;
      _backgroundedAt = null;
      _isInBackground = false;
      // A short absence (lock-screen glance, quick app switch) almost never
      // kills the socket — tearing it down and reloading history on every
      // unlock is exactly the "re-initialize every time" jank users hit. So
      // only probe it (ensureAlive keeps a healthy socket, revives a dead one).
      // After a long absence the OS has likely frozen the socket half-open, so
      // force a reconnect — which is now seamless (the transcript is swapped in
      // place, no blank flash). Mirrors the web client's hidden-duration gate.
      //
      // When keep-alive is on, the process (and its sockets) stayed alive in the
      // background regardless of how long we were away, so we always just probe
      // — ensureAlive still reconnects if a deep-doze actually killed the socket.
      final forceReconnect =
          !settings.keepAliveEnabled && away > _kKeepSocketBelow;
      for (final p in _providers.values) {
        p.isInBackground = false;
        if (forceReconnect) {
          p.reconnect();
        } else {
          p.ensureAlive();
        }
      }
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      _backgroundedAt ??= DateTime.now();
      _isInBackground = true;
      // Going to the background with an open chat: keep the process (and its
      // live sockets) alive via the Android foreground service, so streaming
      // continues instead of freezing. Opt-in + Android-only (see
      // BackgroundKeepAlive); a no-op otherwise.
      if (settings.keepAliveEnabled && _providers.isNotEmpty) {
        BackgroundKeepAlive.start();
      }
      for (final p in _providers.values) {
        p.isInBackground = true;
      }
    }
  }

  // ── Dashboard load (directories + sessions in parallel) ───────────────────

  Future<void> loadDashboard() async {
    try {
      final results = await Future.wait([
        _sessionService.fetchDirectories(),
        _sessionService.fetchSessions(),
      ]);
      _directories = results[0] as List<Directory>;
      _sessions = results[1] as List<Session>;
      for (final s in _sessions) {
        _providers[s.id]?.setDisplayName(
          s.label?.isNotEmpty == true ? s.label! : s.id,
        );
      }
      _loadingSessions = false;
      _sessionsError = null;
      notifyListeners();
      // A notification tap may have arrived before the list was ready — open
      // its session now that it (hopefully) exists.
      final pendingId = _pendingNotificationSessionId;
      if (pendingId != null) {
        for (final s in _sessions) {
          if (s.id == pendingId) {
            _pendingNotificationSessionId = null;
            _activateSession(s);
            break;
          }
        }
      }
    } catch (e) {
      _loadingSessions = false;
      _sessionsError = e.toString();
      notifyListeners();
    }
  }

  /// Back-compat for any call sites still using the old name.
  Future<void> loadSessions() => loadDashboard();

  // ── Grouping helpers ──────────────────────────────────────────────────────

  /// Returns sessions scoped to a directory, split by (cli, kind).
  Map<String, List<Session>> sessionsByCliKind(String dirId) {
    final groups = <String, List<Session>>{
      'claude_terminal': [],
      'claude_chat': [],
      'codex_terminal': [],
      'codex_chat': [],
    };
    for (final s in _sessions) {
      if (s.dirId != dirId) continue;
      final key = '${s.cli.name}_${s.kind.name}';
      groups[key]?.add(s);
    }
    return groups;
  }

  /// The special `__aux__` session (voice refine / intent classifier), if loaded.
  Session? get auxSession {
    for (final s in _sessions) {
      if (s.isAux) return s;
    }
    return null;
  }

  // ── Notifications ──────────────────────────────────────────────────────────

  /// Raise a local notification for a workspace-level aux-AI verdict. This is
  /// how sessions the user never opened (no chat socket) still ping the
  /// dashboard. Skipped when the user is actively viewing that very session —
  /// no point pinging about what's already on screen. The same verdict can also
  /// arrive over an open session's chat socket; NotificationService de-dups the
  /// two by id, so this and ChatProvider._maybeNotify never double-fire.
  void handleWorkspaceNotify(String sessionId, String state, String message) {
    if (!_isInBackground && sessionId == _activeSessionId) return;
    final label = _labelFor(sessionId);
    NotificationService.show(
      title: 'MultiCC #$label: ${state == 'waiting' ? '等待操作' : '任务完成'}',
      body: message.isNotEmpty ? message : label,
      id: sessionId.hashCode,
      payload: sessionId,
    );
  }

  String _labelFor(String id) {
    for (final s in _sessions) {
      if (s.id == id) {
        return (s.label?.isNotEmpty == true) ? s.label! : s.id;
      }
    }
    return id;
  }

  // ── Multi-session management ───────────────────────────────────────────────

  /// Open (or reuse) a chat connection for a session. Only meaningful for
  /// `kind == chat` sessions; terminals run in a separate TerminalService.
  ChatProvider openSession(Session session) {
    if (_providers.containsKey(session.id)) return _providers[session.id]!;
    final provider =
        ChatProvider(
            settings: settings,
            sessionName: session.id,
            displayName: session.label?.isNotEmpty == true
                ? session.label!
                : session.id,
            sessionCwd: session.cwd,
          )
          ..isActive = false
          ..isInBackground = _isInBackground;
    _providers[session.id] = provider;
    return provider;
  }

  /// Switch the visible chat session.
  void switchToSession(String id) {
    if (_activeSessionId != null && _providers.containsKey(_activeSessionId!)) {
      _providers[_activeSessionId!]!.isActive = false;
    }
    _activeSessionId = id;
    if (_providers.containsKey(id)) {
      _providers[id]!.isActive = true;
    }
    notifyListeners();
  }

  /// Go back to session list (no active session).
  void goToSessionList() {
    if (_activeSessionId != null && _providers.containsKey(_activeSessionId!)) {
      _providers[_activeSessionId!]!.isActive = false;
    }
    _activeSessionId = null;
    notifyListeners();
  }

  /// Close a background chat connection.
  void closeSession(String id) {
    final p = _providers.remove(id);
    p?.dispose();
    if (_activeSessionId == id) {
      _activeSessionId = null;
    }
    notifyListeners();
  }

  // ── Session actions (REST) ─────────────────────────────────────────────────

  Future<void> deleteSession(String id) async {
    await _sessionService.deleteSession(id);
    closeSession(id);
    loadDashboard();
  }

  Future<void> restartSession(String id) async {
    await _sessionService.restartSession(id);
    loadDashboard();
  }

  Future<void> renameSession(String id, String? label) async {
    await _sessionService.updateSessionLabel(id, label);
    await loadDashboard();
  }

  // ── Directory + session creation ──────────────────────────────────────────

  Future<Directory> createDirectory({
    required String name,
    required String path,
  }) async {
    final d = await _sessionService.createDirectory(name: name, path: path);
    await loadDashboard();
    return d;
  }

  Future<void> renameDirectory(String id, String name) async {
    await _sessionService.updateDirectoryName(id, name);
    await loadDashboard();
  }

  Future<void> deleteDirectory(String id) async {
    await _sessionService.deleteDirectory(id, force: true);
    // Drop any chat providers whose session lived in this directory
    final removed = _sessions
        .where((s) => s.dirId == id)
        .map((s) => s.id)
        .toList();
    for (final sid in removed) {
      final p = _providers.remove(sid);
      p?.dispose();
      if (_activeSessionId == sid) _activeSessionId = null;
    }
    await loadDashboard();
  }

  Future<Session> createSessionInDir({
    required String dirId,
    required SessionCli cli,
    required SessionKind kind,
    String? label,
    String? model,
  }) async {
    final s = await _sessionService.createSessionInDir(
      dirId: dirId,
      cli: cli,
      kind: kind,
      label: label,
      model: model,
    );
    await loadDashboard();
    return s;
  }

  Future<void> updateSessionModel(String id, String model) async {
    await _sessionService.updateSessionModel(id, model);
    await loadDashboard();
  }

  Future<void> updateSessionProvider(String id, String provider) async {
    await _sessionService.updateSessionProvider(id, provider);
    await loadDashboard();
  }

  Future<void> updateSessionRolePrompt(String id, String rolePrompt) async {
    await _sessionService.updateSessionRolePrompt(id, rolePrompt);
    await loadDashboard();
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _refreshTimer?.cancel();
    for (final p in _providers.values) {
      p.dispose();
    }
    _providers.clear();
    super.dispose();
  }
}
