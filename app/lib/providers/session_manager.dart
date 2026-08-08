import 'dart:async';
import 'package:flutter/widgets.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../services/background_service.dart';
import '../services/notification_service.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../services/ui_layout_service.dart';
import '../services/workspace_service.dart';
import '../utils/session_status_helpers.dart';
import 'chat_provider.dart';

class SessionManager extends ChangeNotifier with WidgetsBindingObserver {
  final SettingsService settings;
  late final SessionService _sessionService;
  SessionService get service => _sessionService;

  /// 用户拖出来的排布（首页目录顺序 + 每个 fleet 的会话顺序），存在服务端。
  /// 挂在 SessionManager 上，是因为决定顺序的两处——首页目录列表与
  /// [sessionsByKind]——都已经在 watch 它；再引一个 provider 只会多一个需要保持
  /// 同步的生命周期。
  late final UiLayoutService uiLayout = UiLayoutService(settings: settings);

  /// Active ChatProviders keyed by session id (chat sessions only).
  final Map<String, ChatProvider> _providers = {};
  Map<String, ChatProvider> get allProviders => Map.unmodifiable(_providers);

  /// Currently viewed session (null = show session list).
  String? _activeSessionId;
  String? get activeSessionId => _activeSessionId;
  ChatProvider? get activeProvider =>
      _activeSessionId != null ? _providers[_activeSessionId] : null;

  /// Currently open fleet (directory) detail panel, or null when none is open.
  /// The fleet panel lives in the main_shell Stack UNDER the chat sheet, so
  /// opening a session from it overlays the chat on top; closing the chat
  /// returns to the fleet panel instead of the bare dashboard.
  String? _activeFleetDirId;
  String? get activeFleetDirId => _activeFleetDirId;
  void openFleetDir(String dirId) {
    _activeFleetDirId = dirId;
    notifyListeners();
  }

  void closeFleetDir() {
    _activeFleetDirId = null;
    notifyListeners();
  }

  /// Registered by the mounted fleet panel so the Android back button can play
  /// the same slide-down exit as the drag / X paths. Calling [closeFleetDir]
  /// directly would unmount the panel mid-frame and it would blink out.
  /// Not display state, so setting it deliberately does not notify.
  VoidCallback? fleetCollapseHandler;

  /// Close the fleet panel, animating it out when the panel is mounted.
  void requestCloseFleetDir() {
    final animateOut = fleetCollapseHandler;
    if (animateOut != null) {
      animateOut();
    } else {
      closeFleetDir();
    }
  }

  // ── Deep-link focus (task-board "jump to message") ─────────────────────────
  // A pending focus is stashed when a chat is opened from a task-board message
  // tap and consumed once by the freshly-mounted _ChatSheet, so the focus
  // applies only to that open and never leaks to a later, unrelated one. The
  // session-id guard prevents a stale focus (set for session A) from firing
  // when session B's sheet mounts next.
  String? _pendingFocusSessionId;
  String? _pendingFocusMessageId;

  /// Session list from REST API.
  List<Session> _sessions = [];
  List<Session> get sessions => List.unmodifiable(_sessions);

  /// Directory list from REST API.
  List<Directory> _directories = [];
  List<Directory> get directories => List.unmodifiable(_directories);

  // ── Global "waiting for input" aggregation ────────────────────────────────
  // DashboardWorkspaceStore owns one WorkspaceService per directory and reports
  // its currently-waiting session ids here so the dashboard KPI can show a
  // directory-spanning view without cards owning transport lifecycles.
  final Map<String, Set<String>> _waitingByDir = {};
  Set<String> get waitingSessionIds =>
      _waitingByDir.values.expand((s) => s).toSet();

  // ── Global "running / active" aggregation ─────────────────────────────────
  // Same pattern as _waitingByDir, but for sessions that are actively executing
  // (running / thinking / editing) — drives the 「活跃会话」KPI.
  final Map<String, Set<String>> _runningByDir = {};
  Set<String> get runningSessionIds =>
      _runningByDir.values.expand((s) => s).toSet();

  // ── Central live workspace status ─────────────────────────────────────────
  // DashboardWorkspaceStore reports each directory's full session → status map
  // here so dashboard popups can show live status / summary / run-time.
  final Map<String, Map<String, SessionStatus>> _statusByDir = {};

  /// Applies one immutable workspace projection as a single manager update.
  ///
  /// The dashboard store owns the transport and calls this once per directory
  /// snapshot. Keeping all three aggregates in one commit avoids three
  /// synchronous notifications during a manager attachment or socket event.
  void applyWorkspaceSnapshot(
    String dirId,
    Map<String, SessionStatus> statuses,
  ) {
    final waiting = statuses.entries
        .where((entry) => entry.value.status == 'waiting')
        .map((entry) => entry.key)
        .toSet();
    const busy = {'running', 'thinking', 'editing'};
    final running = statuses.entries
        .where((entry) => busy.contains(entry.value.status))
        .map((entry) => entry.key)
        .toSet();

    if (waiting.isEmpty) {
      _waitingByDir.remove(dirId);
    } else {
      _waitingByDir[dirId] = waiting;
    }
    if (running.isEmpty) {
      _runningByDir.remove(dirId);
    } else {
      _runningByDir[dirId] = running;
    }
    if (statuses.isEmpty) {
      _statusByDir.remove(dirId);
    } else {
      _statusByDir[dirId] = Map.of(statuses);
    }
    notifyListeners();
  }

  /// Live status for a session across all directories (null if none yet).
  SessionStatus? liveStatus(String sessionId) {
    for (final m in _statusByDir.values) {
      final st = m[sessionId];
      if (st != null) return st;
    }
    return null;
  }

  /// Last-interaction time for a session, newest of: live workspace activity,
  /// REST lastActivity, createdAt. Mirrors web's sessionLastInteractionMs.
  DateTime _lastInteractionAt(Session s) {
    var best = s.createdAt;
    final saved = s.lastActivity;
    if (saved != null && saved.isAfter(best)) best = saved;
    final liveMs = liveStatus(s.id)?.lastActivity ?? 0;
    if (liveMs > 0) {
      final liveAt = DateTime.fromMillisecondsSinceEpoch(liveMs);
      if (liveAt.isAfter(best)) best = liveAt;
    }
    return best;
  }

  /// 「活跃会话」口径，对齐 web：最近 12 小时内使用过的会话（按最近交互倒序），
  /// 而非"此刻进程还连着"(s.active)。
  static const _recentUseWindow = Duration(hours: 12);
  List<Session> get activeSessions {
    final now = DateTime.now();
    final list = _sessions
        .where(
          (s) =>
              !s.isAux &&
              now.difference(_lastInteractionAt(s)) <= _recentUseWindow,
        )
        .toList();
    list.sort((a, b) => _lastInteractionAt(b).compareTo(_lastInteractionAt(a)));
    return pinCommanderFirst(list);
  }

  /// Sessions currently waiting on user input (resolved from the aggregate).
  List<Session> get waitingSessions {
    final ids = waitingSessionIds;
    return _sessions.where((s) => ids.contains(s.id) && !s.isAux).toList();
  }

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
      _backgroundedAt = null;
      _isInBackground = false;
      // Return to the foreground: we don't guess whether the OS froze the
      // socket — ensureAlive probes the actual connection instead.
      //  • Healthy socket (short glance, Android keep-alive) → stays up, zero
      //    interruption, no "Connecting…" flash or history reload.
      //  • Half-open (iOS froze it in the background) → ChatService's probe
      //    window detects the missing pong within ~4s and reconnects; if it
      //    already fell past the stale threshold it reconnects immediately.
      //  • Already dropped → reconnect right away, skipping the backoff wait.
      // Previously a background >30s unconditionally tore the socket down and
      // reloaded history (p.reconnect), even when the OS had kept it alive —
      // the "switch away and it re-initializes" jank this removes.
      for (final p in _providers.values) {
        p.isInBackground = false;
        p.ensureAlive();
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
      // 排布与目录/会话一起取：晚一步到就意味着列表先按创建顺序画一遍、再跳到
      // 用户排好的顺序。它自己吞掉失败（拿不到 = 默认顺序），不会拖垮这次加载。
      final results = await Future.wait([
        _sessionService.fetchDirectories(),
        _sessionService.fetchSessions(),
        uiLayout.ensureLoaded(),
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
  /// Superseded by [sessionsByKind] when the fleet moved to kind-only grouping;
  /// kept for callers that still want the cli split, and ordered the same way.
  Map<String, List<Session>> sessionsByCliKind(String dirId) {
    final groups = <String, List<Session>>{
      'claude_terminal': [],
      'claude_chat': [],
      'codex_terminal': [],
      'codex_chat': [],
      'opencode_terminal': [],
      'opencode_chat': [],
      'zcode_terminal': [],
      'zcode_chat': [],
      'qoder_terminal': [],
      'qoder_chat': [],
    };
    for (final s in _sessions) {
      if (s.dirId != dirId) continue;
      final key = '${s.cli.name}_${s.kind.name}';
      groups.putIfAbsent(key, () => []).add(s);
    }
    return groups.map((key, ss) => MapEntry(key, orderFleetSessions(ss)));
  }

  /// Returns sessions scoped to a directory, split by kind only
  /// (`{chat: [...], terminal: [...]}`) - aligned to the web fleet's new
  /// kind-only grouping. `kind` defaults to terminal when absent. Each group is
  /// in creation order via [compareSessionsByCreation], mirroring web's
  /// sortSessionsByCreation: a fleet list that reorders itself whenever a
  /// session streams is unreadable, so activity deliberately does not move
  /// cards.
  /// 用户在这个 fleet 里拖过的顺序会盖在创建顺序之上；没拖过的会话（含拖拽之后
  /// 新建的）仍按创建时间落位。
  Map<String, List<Session>> sessionsByKind(String dirId) =>
      groupFleetSessionsByKind(
        _sessions,
        dirId,
        manualOrder: uiLayout.sessionOrderOf(dirId),
      );

  /// 把某个 fleet 里的会话顺序写回服务端并刷新列表。[orderedIds] 是拖拽后该组
  /// 屏幕上的完整顺序（见 utils/manual_order.dart 的 reorderAround）。
  Future<void> saveFleetSessionOrder(String dirId, List<String> orderedIds) async {
    final write = uiLayout.saveSessionOrder(dirId, orderedIds);
    // 乐观写已经改过内存里的排布，先重绘再等请求落地，卡片才跟手。
    notifyListeners();
    await write;
    notifyListeners();
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
    // Running = in-progress status update. Don't fire a push notification —
    // it's a status update, not an alert. Only completed/waiting warrant
    // interrupting the user.
    if (state == 'running') return;
    if (!_isInBackground && sessionId == _activeSessionId) return;
    final who = _displayTitleFor(sessionId);
    final outcome = state == 'waiting'
        ? t('waitingInteraction')
        : state == 'error'
        ? t('errorOccurred')
        : t('taskCompleted');
    NotificationService.show(
      title: 'MultiCC · $who: $outcome',
      body: message.isNotEmpty ? message : who,
      id: sessionId.hashCode,
      payload: sessionId,
    );
  }

  /// Resolve a directory id to its display name (empty if unknown / not loaded).
  String _dirNameFor(String? dirId) {
    if (dirId == null || dirId.isEmpty) return '';
    for (final d in _directories) {
      if (d.id == dirId) return d.name;
    }
    return '';
  }

  /// Human-facing session identity in the form `directory / alias` (alias falls
  /// back to the id; directory is omitted when unknown).
  String _displayTitleFor(String id) {
    for (final s in _sessions) {
      if (s.id == id) {
        final label = (s.label?.isNotEmpty == true) ? s.label! : s.id;
        final dir = _dirNameFor(s.dirId);
        return dir.isNotEmpty ? '$dir / $label' : label;
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
            dirName: _dirNameFor(session.dirId),
            sessionCwd: session.cwd,
            initialCli: session.cli,
            onSessionConfigChanged: loadDashboard,
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

  /// Open [session]'s chat and request a deep-link focus on [focusMessageId]
  /// (the chat scrolls to + highlights that message once its history loads).
  /// A null / empty [focusMessageId] - or a non-chat session - behaves exactly
  /// like a normal open (no focus stashed). Terminals ignore the focus.
  void openSessionWithFocus(Session session, {String? focusMessageId}) {
    if (focusMessageId != null &&
        focusMessageId.isNotEmpty &&
        session.isChat) {
      _pendingFocusSessionId = session.id;
      _pendingFocusMessageId = focusMessageId;
    } else {
      _pendingFocusSessionId = null;
      _pendingFocusMessageId = null;
    }
    openSession(session);
    switchToSession(session.id);
  }

  /// Consume the pending deep-link focus for [sessionId]. Returns the message
  /// id to focus on, or null if there is no pending focus / it was meant for a
  /// different session (guards against a stale focus leaking to the wrong
  /// chat). Always clears the stash.
  String? consumeFocusMessage(String sessionId) {
    final match = _pendingFocusSessionId == sessionId &&
        _pendingFocusMessageId != null;
    final focus = match ? _pendingFocusMessageId : null;
    _pendingFocusSessionId = null;
    _pendingFocusMessageId = null;
    return focus;
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

  Future<SessionCliConfig> fetchSessionCliConfig(String id) =>
      _sessionService.fetchSessionCliConfig(id);

  Future<SessionCliConfig> switchSessionCli(
    String id,
    SessionCli cli, {
    bool fresh = false,
  }) async {
    final config = await _sessionService.switchSessionCli(
      id,
      cli,
      fresh: fresh,
    );
    _providers[id]?.applyCliConfig(config);
    await loadDashboard();
    return config;
  }

  // ── CLI install (thin forward to SessionService) ──────────────────────────

  Future<Map<String, dynamic>> fetchCliInstallSpecs() =>
      _sessionService.fetchCliInstallSpecs();

  Future<Map<String, dynamic>> installCli(String cli) =>
      _sessionService.installCli(cli);

  Future<Map<String, dynamic>> fetchCliInstallStatus(String jobId) =>
      _sessionService.fetchCliInstallStatus(jobId);

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
    String? provider,
    String? effort,
    String? agent,
    String? rolePrompt,
  }) async {
    final s = await _sessionService.createSessionInDir(
      dirId: dirId,
      cli: cli,
      kind: kind,
      label: label,
      model: model,
      provider: provider,
      effort: effort,
      agent: agent,
      rolePrompt: rolePrompt,
    );
    await loadDashboard();
    return s;
  }

  Future<void> updateSessionModel(String id, String model) async {
    await _sessionService.updateSessionModel(id, model);
    await loadDashboard();
  }

  Future<void> updateSessionEffort(String id, String effort) async {
    await _sessionService.updateSessionEffort(id, effort);
    await loadDashboard();
  }

  Future<void> updateSessionAIConfig(
    String id, {
    required String provider,
    required String model,
    required String effort,
    SessionSubagent? subagent,
    bool clearSubagent = false,
    String? agent,
  }) async {
    await _sessionService.updateSessionAIConfig(
      id,
      provider: provider,
      model: model,
      effort: effort,
      subagent: subagent,
      clearSubagent: clearSubagent,
      agent: agent,
    );
    await loadDashboard();
  }

  Future<void> updateSessionProvider(String id, String provider) async {
    await _sessionService.updateSessionProvider(id, provider);
    // Server auto-fills the session model from the new provider's model list.
    // loadDashboard() refreshes _sessions with the updated model from the server.
    await loadDashboard();
  }

  Future<void> updateSessionRolePrompt(String id, String rolePrompt) async {
    await _sessionService.updateSessionRolePrompt(id, rolePrompt);
    await loadDashboard();
  }

  Future<String> fetchSessionMemory(String id) =>
      _sessionService.fetchSessionMemory(id);

  Future<void> updateSessionMemory(String id, String memory) async {
    await _sessionService.updateSessionMemory(id, memory);
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
