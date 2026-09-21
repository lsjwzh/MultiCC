/* Lightweight task-open request for the Air shell. */
(function installAirTaskEntry(root) {
  async function open({ taskId, api, notice }) {
    if (!taskId) return false;
    try {
      await api(`/api/air/tasks/${encodeURIComponent(taskId)}/open`);
      return true;
    } catch (error) {
      // Old hosts have no lightweight route; their chat-shell bootstrap still
      // resolves the task, so only surface real failures.
      if (error?.status !== 404 && error?.status !== 405) notice?.(error.message);
      return false;
    }
  }
  root.MultiCCAirTaskEntry = { open };
})(window);
