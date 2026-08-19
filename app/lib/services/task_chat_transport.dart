import '../models/message.dart';
import 'transcript_live_folder.dart';
import 'workspace_service.dart';

/// A2-b (chat-view unification I8, App side): folds live `task_run_stream`
/// envelopes into a [TranscriptLiveFolder] — the App mirror of the web
/// chat-task-mode `handleWorkspaceMessage`. One transport per open task
/// detail sheet; the sheet owns the [messages] list and renders history
/// (authoritative REST pages) plus this live tail through the same
/// MessageBubble tree (I-A1).
///
/// Invariants:
/// - I-A3: the live tail enters ONLY through these envelopes. The execution
///   slot's session id has no representation here — the sidecar namespace is
///   `task-<taskId>`, never a real session id.
/// - The envelope's `cli` lands BEFORE its first slot event: delta folding is
///   engine-gated (part_delta is a no-op under claude; codex snapshots
///   append), so learning it late would silently drop codex text.
/// - A run-id change is a run boundary: the previous tail settles
///   (finishStreaming) before the new run folds, so a cancelled/interrupted
///   run never leaves a permanently-spinning bubble.
class TaskChatTransport {
  TaskChatTransport({
    required this.taskId,
    required List<ChatMessage> messages,
    void Function()? onChanged,
    this.onRunBoundary,
  }) {
    folder = TranscriptLiveFolder(
      messages: messages,
      cliOf: () => parseCli(_cliRaw),
      // Sidecar namespace (reasoning card id). Deliberately task-scoped,
      // not the slot session id (I-A3).
      sessionIdOf: () => 'task-$taskId',
      onChanged: onChanged,
    );
  }

  final String taskId;
  late final TranscriptLiveFolder folder;

  /// Fired when the live stream crosses into a new run — the sheet inserts
  /// its separator row here (it owns the list; the transport never renders).
  final void Function(String runId)? onRunBoundary;

  String? _cliRaw;
  String? _lastRunId;

  /// How many distinct runs the stream has crossed since this transport
  /// opened (1-based, mirrors the web runCount for separator numbering).
  int runCount = 0;

  /// Folds one envelope. Returns true when it applied (taskId matched and at
  /// least one slot event was folded); foreign-task and empty envelopes are
  /// ignored.
  bool handleEnvelope(TaskRunStreamEvent event) {
    if (event.taskId != taskId) return false;
    // Engine first (web chat-task-mode parity): the same envelope may carry
    // both the cli stamp and codex-only deltas.
    if (event.cli != null && event.cli!.isNotEmpty) _cliRaw = event.cli;
    if (event.slotEvents.isEmpty) return false;
    _maybeRunBoundary(event.runId);
    for (final evt in event.slotEvents) {
      _handleSlotEvent(evt);
    }
    return true;
  }

  void _maybeRunBoundary(String runId) {
    if (runId.isEmpty || runId == _lastRunId) return;
    _lastRunId = runId;
    runCount += 1;
    // Settle the previous run's tail BEFORE the new run folds: a cancelled
    // run's last bubble stops spinning instead of leaking into the new run.
    folder.finishStreaming();
    onRunBoundary?.call(runId);
  }

  /// Dispatches one slot event — byte-identical to what the session socket
  /// delivers inside `stream_event`, so the same shapes apply. The assistant
  /// unwrap mirrors ChatService (`msg.message` is the snapshot payload).
  void _handleSlotEvent(Map<String, dynamic> evt) {
    switch (evt['type']) {
      case 'message_start':
        // Per-request usage feeds provider-level bars, which tasks don't
        // have — the folder hook only opens the bubble here.
        folder.messageStart();
      case 'content_block_start':
        folder.contentBlockStart(evt);
      case 'content_block_delta':
        folder.contentBlockDelta(evt);
      case 'assistant':
        final message = evt['message'];
        if (message is Map) {
          folder.assistantSnapshot(Map<String, dynamic>.from(message));
        }
      case 'part_delta':
        folder.partDelta(evt);
      case 'user':
        folder.userToolResult(evt);
      case 'result':
        folder.attachResultUsage(evt);
        folder.finishStreaming();
      // content_block_stop / message_delta carry no foldable payload (the
      // session provider ignores them too); unknown types are forward-safe.
    }
  }
}
