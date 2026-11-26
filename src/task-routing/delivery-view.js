'use strict';

const { getNative } = require('../native/binding');

// Server-owned projection for the Air delivery card. A fixed task is already
// attributed at admission; low-relevance work uses the user-confirmed
// task-separation saga. Clients render these independent facts and never infer
// a fourth stage from the CLI type or from a clean Git status.
async function deliveryView({ sessionId, taskId, candidate, separation, admission, cwd }) {
  const evidenceSessionId = separation?.sessionId || sessionId;
  const turnId = separation?.turnId || candidate?.turnId || null;
  const evidence = admission.deliveryEvidence(evidenceSessionId, turnId);
  const { run, integration, barrier, application } = evidence;
  let baseline = null;
  if (integration && cwd) {
    try { baseline = await admission.verifyBaseline(integration, cwd); } catch (_) {}
  }
  return getNative().projectDeliveryView(taskId, candidate, separation, run, integration, barrier, application, baseline);
}
module.exports = { deliveryView };
