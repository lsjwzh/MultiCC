import 'dart:async';
import 'package:flutter/widgets.dart';

import '../models/message.dart';
import '../services/chat_service.dart';
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

  SessionManager({required this.settings}) {
    _sessionService = SessionService(settings: settings);
    WidgetsBinding.instance.addObserver(this);
    loadDashboard();
    _refreshTimer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => loadDashboard(),
    );
  }

  // ── App lifecycle ──────────────────────────────────────────────────────────

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _isInBackground = false;
      for (final p in _providers.values) {
        p.isInBackground = false;
        if (p.connectionState == ChatConnectionState.disconnected) {
          p.reconnect();
        }
      }
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      _isInBackground = true;
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
  }) async {
    final s = await _sessionService.createSessionInDir(
      dirId: dirId,
      cli: cli,
      kind: kind,
      label: label,
    );
    await loadDashboard();
    return s;
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
