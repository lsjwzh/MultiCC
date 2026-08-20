import 'message.dart';

// Task board data models - mirror the server's `buildBoardDto` shape verbatim
// (see src/task-board.js buildBoardDto + src/routes/task-board.js handleBoard /
// handleMessages). Every field here exists because the server emits it; parsing
// is defensive (missing keys fall back to empty/idle) so a stale server never
// crashes the board view.
//
// Board DTO: { ok, modules:[...], tasks:[...], sessionLabels:{}, backfill:{} }
// Messages DTO: { ok, task, items:[{sessionId, sessionLabel, role, messageId,
//   ts, text, lost?, taskRunId?, partial?}] }

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
/// session that has a ref on this task (running | waiting | error | succeeded | idle).
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

  /// P1/P3: the 1:1 bound hidden chat session this task owns (server DTO).
  /// When non-null the detail sheet hands the chat off to the full session
  /// chat view instead of the legacy ledger projection.
  final String? chatSessionId;

  /// M3 per-task worktree ledger (server DTO `worktreePath` / `branch`):
  /// where the task's work lives between runs. Non-null [worktreePath] gates
  /// the one-click "merge back + cleanup worktree" action, mirroring the web
  /// row's 🧹 button. Absent until the first run creates the worktree; old
  /// servers omit both fields entirely.
  final String? worktreePath;
  final String? branch;

  /// Routing attempts so far (server DTO `attemptCount`). The web row shows
  /// "N 次投递" once a task was delivered more than once.
  final int attemptCount;

  /// Server-computed identity classification: canonical | legacy |
  /// orphaned_admission | legacy_unresolved. The two latter values group a
  /// card under "历史身份待确认" on the web board (they are never auto-merged);
  /// old servers omit the field and parse as canonical.
  final String identityState;

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
    this.chatSessionId,
    this.worktreePath,
    this.branch,
    this.attemptCount = 0,
    this.identityState = 'canonical',
  });

  /// Cards whose historical identity was never resolved. Mirrors
  /// partitionTaskIdentity() in public/task-board-ui.js.
  bool get isIdentityUnresolved =>
      identityState == 'orphaned_admission' ||
      identityState == 'legacy_unresolved';

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
    chatSessionId: (json['chatSessionId'] as String?)?.isNotEmpty == true
        ? json['chatSessionId'] as String
        : null,
    worktreePath: (json['worktreePath'] as String?)?.isNotEmpty == true
        ? json['worktreePath'] as String
        : null,
    branch: (json['branch'] as String?)?.isNotEmpty == true
        ? json['branch'] as String
        : null,
    attemptCount: (json['attemptCount'] as num?)?.toInt() ?? 0,
    identityState: (json['identityState'] ?? 'canonical').toString(),
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
/// trimmed from history - only the excerpt survives. `taskRunId` attributes
/// the message to the headless TaskRun that produced it (chat-view
/// unification M0/M4-T3); `partial` marks a streaming-tail snapshot row.
/// Both are additive — old servers omit them.
class TaskMessage {
  final String sessionId;
  final String? sessionLabel;
  final String role;
  final String? messageId;
  final int ts;
  final String text;
  final bool lost;
  final String? taskRunId;
  final bool partial;

  const TaskMessage({
    required this.sessionId,
    this.sessionLabel,
    required this.role,
    this.messageId,
    this.ts = 0,
    this.text = '',
    this.lost = false,
    this.taskRunId,
    this.partial = false,
  });

  /// Headless TaskRun messages deliberately carry no public session id. They
  /// remain readable in task history but must never become ordinary chat links.
  bool get hasSessionTarget => sessionId.trim().isNotEmpty;

  /// Accepts both wire shapes: the unified `messages` page DTO (`id`/
  /// `content`, shared with the session history contract) and the legacy
  /// `items` projection (`messageId`/`text` + session fields). The unified
  /// DTO deliberately carries no session identity — hasSessionTarget stays
  /// false and the row renders without a jump affordance.
  factory TaskMessage.fromJson(Map<String, dynamic> json) => TaskMessage(
    sessionId: (json['sessionId'] ?? '').toString(),
    sessionLabel: json['sessionLabel']?.toString(),
    role: (json['role'] ?? 'user').toString(),
    messageId: (json['messageId'] ?? json['id'])?.toString(),
    ts: (json['ts'] as num?)?.toInt() ?? 0,
    text: (json['content'] ?? json['text'] ?? '').toString(),
    lost: json['lost'] == true,
    taskRunId: json['taskRunId']?.toString(),
    partial: json['partial'] == true,
  );
}

/// Project one task transcript row onto the shared chat renderer model.
/// I-A1: sessions and tasks render through one bubble tree; tools/usage are
/// absent from the task ledger as-built (M0), so the bubble degrades to
/// markdown text — data absence, not a renderer gap.
ChatMessage chatMessageFromTask(TaskMessage m) => ChatMessage(
  role: m.role == 'user' ? MessageRole.user : MessageRole.assistant,
  content: m.text,
  id: (m.messageId?.isNotEmpty ?? false) ? m.messageId : null,
  timestamp: m.ts > 0 ? DateTime.fromMillisecondsSinceEpoch(m.ts) : null,
  isPartial: m.partial,
);

/// A2-c: how many trailing rows of [history] the live folded tail supersedes.
/// Trailing `partial` rows are the running turn's older persisted snapshot —
/// the live fold (task_run_stream envelopes through TranscriptLiveFolder)
/// replaces them while it streams; they render again (authoritative) on the
/// next reconcile once the live tail is cleared. A `lost` row breaks the
/// walk: the partial before it is the authoritative interrupted marker, not
/// a snapshot the live tail should hide.
int liveSupersededCount(List<TaskMessage> history) {
  var n = 0;
  for (var i = history.length - 1; i >= 0; i--) {
    final row = history[i];
    if (row.partial && !row.lost) {
      n++;
    } else {
      break;
    }
  }
  return n;
}

int _taskRunInt(dynamic value) {
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '') ?? 0;
}

/// One provider/model attribution bucket inside a durable TaskRun usage seal.
class TaskRunUsageDimension {
  final String providerId;
  final String providerName;
  final String model;
  final String roleKind;
  final String routeName;
  final int observedEvents;
  final int unobservableEvents;
  final int freshInput;
  final int cacheRead;
  final int cacheWrite;
  final int output;
  final int reasoning;

  const TaskRunUsageDimension({
    required this.providerId,
    required this.providerName,
    this.model = '',
    this.roleKind = 'main',
    this.routeName = 'main',
    this.observedEvents = 0,
    this.unobservableEvents = 0,
    this.freshInput = 0,
    this.cacheRead = 0,
    this.cacheWrite = 0,
    this.output = 0,
    this.reasoning = 0,
  });

  factory TaskRunUsageDimension.fromJson(Map<String, dynamic> json) =>
      TaskRunUsageDimension(
        providerId: (json['providerId'] ?? 'unknown').toString(),
        providerName:
            (json['providerName'] ?? json['providerId'] ?? 'Unknown Provider')
                .toString(),
        model: (json['model'] ?? '').toString(),
        roleKind: (json['roleKind'] ?? 'main').toString(),
        routeName: (json['routeName'] ?? 'main').toString(),
        observedEvents: _taskRunInt(json['observedEvents']),
        unobservableEvents: _taskRunInt(json['unobservableEvents']),
        freshInput: _taskRunInt(json['freshInput']),
        cacheRead: _taskRunInt(json['cacheRead']),
        cacheWrite: _taskRunInt(json['cacheWrite']),
        output: _taskRunInt(json['output']),
        reasoning: _taskRunInt(json['reasoning']),
      );
}

/// Usage snapshot sealed before a TaskRun's native transcript can be removed.
/// [totalTokens] stays null for unobservable providers: unknown must never be
/// displayed or aggregated as a known zero.
class TaskRunUsage {
  final String coverage;
  final bool hasKnownUsage;
  final bool isLowerBound;
  final int? freshInput;
  final int? cacheRead;
  final int? cacheWrite;
  final int? output;
  final int? reasoning;
  final int? totalTokens;
  final List<TaskRunUsageDimension> dimensions;

  const TaskRunUsage({
    this.coverage = 'unobservable',
    this.hasKnownUsage = false,
    this.isLowerBound = false,
    this.freshInput,
    this.cacheRead,
    this.cacheWrite,
    this.output,
    this.reasoning,
    this.totalTokens,
    this.dimensions = const [],
  });

  static const unobservable = TaskRunUsage();

  factory TaskRunUsage.fromJson(Map<String, dynamic> json) {
    final coverage = (json['coverage'] ?? 'unknown').toString();
    final tokens = json['tokens'] is Map
        ? (json['tokens'] as Map).cast<String, dynamic>()
        : null;
    final hasKnown =
        json['hasKnownUsage'] == true ||
        (json['hasKnownUsage'] == null &&
            coverage != 'unobservable' &&
            tokens != null);
    final dimensions = <TaskRunUsageDimension>[];
    final rawDimensions = json['dimensions'];
    if (rawDimensions is List) {
      for (final item in rawDimensions) {
        if (item is Map) {
          dimensions.add(
            TaskRunUsageDimension.fromJson(item.cast<String, dynamic>()),
          );
        }
      }
    }
    if (!hasKnown || tokens == null) {
      return TaskRunUsage(
        coverage: coverage,
        hasKnownUsage: false,
        isLowerBound: json['isLowerBound'] == true,
        dimensions: List.unmodifiable(dimensions),
      );
    }
    final fresh = _taskRunInt(tokens['freshInput']);
    final read = _taskRunInt(tokens['cacheRead']);
    final write = _taskRunInt(tokens['cacheWrite']);
    final output = _taskRunInt(tokens['output']);
    final consumed = tokens.containsKey('consumedInput')
        ? _taskRunInt(tokens['consumedInput'])
        : fresh + read + write;
    final total = tokens.containsKey('total')
        ? _taskRunInt(tokens['total'])
        : consumed + output;
    return TaskRunUsage(
      coverage: coverage,
      hasKnownUsage: true,
      isLowerBound: json['isLowerBound'] == true,
      freshInput: fresh,
      cacheRead: read,
      cacheWrite: write,
      output: output,
      reasoning: _taskRunInt(tokens['reasoning']),
      totalTokens: total,
      dimensions: List.unmodifiable(dimensions),
    );
  }
}

/// Safe, task-owned projection of a waiting TaskRun question. Execution-slot
/// identity and lease fields intentionally have no representation in the App.
class TaskRunPendingQuestion {
  final String requestId;
  final String question;
  final String reason;
  final List<String> options;
  final bool allowMultiple;
  final int createdAt;

  const TaskRunPendingQuestion({
    required this.requestId,
    required this.question,
    this.reason = '',
    this.options = const [],
    this.allowMultiple = false,
    this.createdAt = 0,
  });

  static String _boundedText(Object? value, int maxLength) {
    final text = (value ?? '').toString().trim();
    return text.length <= maxLength ? text : text.substring(0, maxLength);
  }

  factory TaskRunPendingQuestion.fromJson(Map<String, dynamic> json) {
    final options = <String>[];
    final seen = <String>{};
    final createdAt = _taskRunInt(json['createdAt']);
    final rawOptions = json['options'];
    if (rawOptions is List) {
      for (final raw in rawOptions) {
        final option = _boundedText(raw, 512);
        if (option.isEmpty || !seen.add(option)) continue;
        options.add(option);
        if (options.length >= 12) break;
      }
    }
    return TaskRunPendingQuestion(
      requestId: _boundedText(json['requestId'], 160),
      question: _boundedText(json['question'], 16 * 1024),
      reason: _boundedText(json['reason'], 4 * 1024),
      options: List.unmodifiable(options),
      allowMultiple: json['allowMultiple'] == true && options.length >= 2,
      createdAt: createdAt < 0 ? 0 : createdAt,
    );
  }

  bool get isValid => requestId.isNotEmpty && question.isNotEmpty;
}

/// A user-visible durable run. Internal execution slot/native-session fields
/// are intentionally absent so the App cannot accidentally create a chat jump
/// for a headless TaskRun.
class TaskRunSummary {
  final String runId;
  final String executionStatus;
  final String usageStatus;
  final String cleanupState;
  final int startedAt;
  final TaskRunUsage usage;
  final TaskRunPendingQuestion? pendingQuestion;

  const TaskRunSummary({
    required this.runId,
    this.executionStatus = 'unknown',
    this.usageStatus = 'collecting',
    this.cleanupState = 'pending',
    this.startedAt = 0,
    this.usage = TaskRunUsage.unobservable,
    this.pendingQuestion,
  });

  factory TaskRunSummary.fromJson(Map<String, dynamic> json) {
    final usageJson = json['usage'] is Map
        ? (json['usage'] as Map).cast<String, dynamic>()
        : json;
    final pendingJson = json['pendingQuestion'] is Map
        ? (json['pendingQuestion'] as Map).cast<String, dynamic>()
        : null;
    final parsedPending = pendingJson == null
        ? null
        : TaskRunPendingQuestion.fromJson(pendingJson);
    return TaskRunSummary(
      runId: (json['runId'] ?? json['id'] ?? '').toString(),
      executionStatus: (json['executionStatus'] ?? json['state'] ?? 'unknown')
          .toString(),
      usageStatus:
          (json['usageStatus'] ?? usageJson['usageStatus'] ?? 'collecting')
              .toString(),
      cleanupState: (json['cleanupState'] ?? 'pending').toString(),
      startedAt: _taskRunInt(
        json['startedAt'] ?? json['createdAt'] ?? json['terminalAt'],
      ),
      usage: TaskRunUsage.fromJson(usageJson),
      pendingQuestion: parsedPending?.isValid == true ? parsedPending : null,
    );
  }
}

/// Detail endpoint payload. Run aliases are accepted during rolling upgrades;
/// clients always sort and cap to the newest five before rendering.
class TaskBoardDetail {
  final List<TaskMessage> messages;
  final List<TaskRunSummary> recentRuns;

  /// Pagination contract of the unified `messages` page: [hasMore] says an
  /// older page exists and [before] is the cursor to request it with. Both
  /// default to a single complete page for legacy servers.
  final bool hasMore;
  final String? before;

  const TaskBoardDetail({
    this.messages = const [],
    this.recentRuns = const [],
    this.hasMore = false,
    this.before,
  });

  factory TaskBoardDetail.fromJson(Map<String, dynamic> json) {
    final messages = <TaskMessage>[];
    // Prefer the unified paginated DTO; fall back to the legacy `items`
    // projection for pre-unification servers (version skew).
    final rawMessages = json['messages'];
    final rawItems = rawMessages is List ? rawMessages : json['items'];
    if (rawItems is List) {
      for (final item in rawItems) {
        if (item is Map) {
          messages.add(TaskMessage.fromJson(item.cast<String, dynamic>()));
        }
      }
    }
    final task = json['task'] is Map
        ? (json['task'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    final candidates = [
      json['recentRuns'],
      json['taskRuns'],
      json['runs'],
      task['recentRuns'],
      task['taskRuns'],
      task['runs'],
    ];
    final rawRuns = candidates.whereType<List>().firstOrNull ?? const [];
    final runs = <TaskRunSummary>[];
    for (final item in rawRuns) {
      if (item is Map) {
        runs.add(TaskRunSummary.fromJson(item.cast<String, dynamic>()));
      }
    }
    runs.sort((a, b) {
      final byStarted = b.startedAt.compareTo(a.startedAt);
      return byStarted != 0 ? byStarted : b.runId.compareTo(a.runId);
    });
    return TaskBoardDetail(
      messages: List.unmodifiable(messages),
      recentRuns: List.unmodifiable(runs.take(5)),
      hasMore: json['hasMore'] == true,
      before: json['before']?.toString(),
    );
  }
}

/// Backfill (历史归档) progress reported by GET /api/task-board. Any
/// authenticated client may trigger a run (POST /api/task-board/backfill,
/// since 57bfe99); the progress fields below are readable from any client,
/// so the phone shows the "归拢中" float while one is in flight regardless of
/// where it started.
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
