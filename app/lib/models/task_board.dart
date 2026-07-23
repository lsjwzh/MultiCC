// Task board data models - mirror the server's `buildBoardDto` shape verbatim
// (see src/task-board.js buildBoardDto + src/routes/task-board.js handleBoard /
// handleMessages). Every field here exists because the server emits it; parsing
// is defensive (missing keys fall back to empty/idle) so a stale server never
// crashes the board view.
//
// Board DTO: { ok, modules:[...], tasks:[...], sessionLabels:{}, backfill:{} }
// Messages DTO: { ok, task, items:[{sessionId, sessionLabel, role, messageId,
//   ts, text, lost?}] }

/// Operational metadata for manually assigning a pending task to a module.
/// This is deliberately separate from the task's live `runState`, which comes
/// exclusively from the session classify state machine.
class TaskModuleAssignment {
  final bool running;
  final int attempts;
  final int? lastAttemptAt;
  final String? lastError;

  const TaskModuleAssignment({
    this.running = false,
    this.attempts = 0,
    this.lastAttemptAt,
    this.lastError,
  });

  factory TaskModuleAssignment.fromJson(Map<String, dynamic> json) =>
      TaskModuleAssignment(
        // `state` is accepted only for a rolling upgrade from the old DTO.
        running: json['running'] == true || json['state'] == 'running',
        attempts: (json['attempts'] as num?)?.toInt() ?? 0,
        lastAttemptAt: (json['lastAttemptAt'] as num?)?.toInt(),
        lastError: json['lastError']?.toString(),
      );
}

/// One task on the board. `runState` aggregates the live run state of every
/// session that has a ref on this task (running | waiting | error | done | idle).
/// `status` is the user-facing lifecycle (active | done | archived).
class TaskBoardTask {
  final String id;
  final String moduleId;
  final String title;
  final String status;
  final List<String> areas;
  final int refCount;
  final List<String> sessionIds;
  final List<String> dirIds;
  final int lastTs;
  final int createdAt;
  final String runState;
  final TaskModuleAssignment? moduleAssignment;
  final String? body;

  const TaskBoardTask({
    required this.id,
    required this.moduleId,
    required this.title,
    required this.status,
    this.areas = const [],
    this.refCount = 0,
    this.sessionIds = const [],
    this.dirIds = const [],
    this.lastTs = 0,
    this.createdAt = 0,
    this.runState = 'idle',
    this.moduleAssignment,
    this.body,
  });

  factory TaskBoardTask.fromJson(Map<String, dynamic> json) => TaskBoardTask(
    id: (json['id'] ?? '').toString(),
    moduleId: (json['moduleId'] ?? '').toString(),
    title: (json['title'] ?? '').toString(),
    status: (json['status'] ?? 'active').toString(),
    areas:
        (json['areas'] as List?)
            ?.map((e) => e.toString())
            .toList(growable: false) ??
        const [],
    refCount: (json['refCount'] as num?)?.toInt() ?? 0,
    sessionIds:
        (json['sessionIds'] as List?)
            ?.map((e) => e.toString())
            .toList(growable: false) ??
        const [],
    dirIds:
        (json['dirIds'] as List?)
            ?.map((e) => e.toString())
            .toList(growable: false) ??
        const [],
    lastTs: (json['lastTs'] as num?)?.toInt() ?? 0,
    createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
    runState: (json['runState'] ?? 'idle').toString(),
    moduleAssignment:
        (json['moduleAssignment'] ?? json['classification']) is Map
        ? TaskModuleAssignment.fromJson(
            ((json['moduleAssignment'] ?? json['classification']) as Map)
                .cast<String, dynamic>(),
          )
        : null,
    body: json['body']?.toString(),
  );
}

/// A module (AI / directory / classify bucket) that groups tasks. `source` is
/// 'ai' | 'directory' | 'classify'; the 'classify' module is the "待归类"
/// pending bucket and sorts first.
class TaskBoardModule {
  final String id;
  final String name;
  final String source;
  final String? dirId;
  final int taskCount;
  final int lastTs;

  const TaskBoardModule({
    required this.id,
    required this.name,
    required this.source,
    this.dirId,
    this.taskCount = 0,
    this.lastTs = 0,
  });

  bool get isPending => source == 'classify' || name == '待归类';

  factory TaskBoardModule.fromJson(Map<String, dynamic> json) =>
      TaskBoardModule(
        id: (json['id'] ?? '').toString(),
        name: (json['name'] ?? '').toString(),
        source: (json['source'] ?? 'ai').toString(),
        dirId: json['dirId']?.toString(),
        taskCount: (json['taskCount'] as num?)?.toInt() ?? 0,
        lastTs: (json['lastTs'] as num?)?.toInt() ?? 0,
      );
}

/// One message in a task's cross-session conversation trail (user / assistant
/// pairs, oldest first). `lost` marks a user turn whose source message was
/// trimmed from history - only the excerpt survives.
class TaskMessage {
  final String sessionId;
  final String? sessionLabel;
  final String role;
  final String? messageId;
  final int ts;
  final String text;
  final bool lost;

  const TaskMessage({
    required this.sessionId,
    this.sessionLabel,
    required this.role,
    this.messageId,
    this.ts = 0,
    this.text = '',
    this.lost = false,
  });

  factory TaskMessage.fromJson(Map<String, dynamic> json) => TaskMessage(
    sessionId: (json['sessionId'] ?? '').toString(),
    sessionLabel: json['sessionLabel']?.toString(),
    role: (json['role'] ?? 'user').toString(),
    messageId: json['messageId']?.toString(),
    ts: (json['ts'] as num?)?.toInt() ?? 0,
    text: (json['text'] ?? '').toString(),
    lost: json['lost'] == true,
  );
}

/// Backfill (历史归档) progress reported by GET /api/task-board. A run is
/// localhost-triggered but its progress is readable from any client, so the
/// phone can show the "归拢中" float while one is in flight.
class TaskBoardBackfill {
  final bool running;
  final int queued;
  final int done;
  final int? startedAt;

  const TaskBoardBackfill({
    this.running = false,
    this.queued = 0,
    this.done = 0,
    this.startedAt,
  });

  factory TaskBoardBackfill.fromJson(Map<String, dynamic> json) =>
      TaskBoardBackfill(
        running: json['running'] == true,
        queued: (json['queued'] as num?)?.toInt() ?? 0,
        done: (json['done'] as num?)?.toInt() ?? 0,
        startedAt: (json['startedAt'] as num?)?.toInt(),
      );
}

/// Aggregate board: modules + tasks + sessionLabels (sessionId -> label) +
/// the optional backfill progress flag.
class TaskBoard {
  final List<TaskBoardModule> modules;
  final List<TaskBoardTask> tasks;
  final Map<String, String> sessionLabels;
  final TaskBoardBackfill? backfill;

  const TaskBoard({
    this.modules = const [],
    this.tasks = const [],
    this.sessionLabels = const {},
    this.backfill,
  });

  static const empty = TaskBoard();

  factory TaskBoard.fromJson(Map<String, dynamic> json) {
    final labels = <String, String>{};
    final sl = json['sessionLabels'];
    if (sl is Map) {
      sl.forEach((k, v) => labels[k.toString()] = v.toString());
    }
    return TaskBoard(
      modules:
          (json['modules'] as List?)
              ?.map(
                (e) => TaskBoardModule.fromJson(
                  (e as Map).cast<String, dynamic>(),
                ),
              )
              .toList(growable: false) ??
          const [],
      tasks:
          (json['tasks'] as List?)
              ?.map(
                (e) =>
                    TaskBoardTask.fromJson((e as Map).cast<String, dynamic>()),
              )
              .toList(growable: false) ??
          const [],
      sessionLabels: Map.unmodifiable(labels),
      backfill: json['backfill'] is Map
          ? TaskBoardBackfill.fromJson(
              (json['backfill'] as Map).cast<String, dynamic>(),
            )
          : null,
    );
  }
}
