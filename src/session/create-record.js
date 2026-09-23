'use strict';
const path = require('node:path');
const { normalizeSubagentInput } = require('./subagent');
function createSessionRecordFactory(deps) {
  const { sharedWorkspace, SUPPORTED_CHAT_CLIS, validateExperimentalSession, tuiChatMirrorEnabled, normalizeEffort, validEffortForCli, codexDefaultReasoningLevel, normalizeCliAgent, validateProviderSelection, providers, primaryProviderCandidate, providerDefaults, validProviderId, allocateSessionId, persistedSessions, ensureDirGitReady, friendlyDirReason, WORKTREE_SUBDIR, gitWorktreeAdd, gitWorktreeRollbackCreate, sanitizeLoginEnv, ensureCliStates, sessionPersistence, savePersistedSessionsBestEffort, appendEvent, cliForLoginFlow } = deps;
async function createSessionRecord({ dir, cli, kind, label = null, id = null, ephemeral = false, model = null, provider = undefined, providerSelection = null, effort = null, agent = null, subagent = null, rolePrompt = null, rolePresetId = null, type = null, taskExecutionSlot = false, experimentalMode = null, loginFlow = null, loginEnv = null, persistence = 'bestEffort', persistenceSource = 'runtime.create-session', taskBoundTaskId = null, autoCommit = true, workspaceOwnerSessionId = null, workspaceBaseCommit = null, validateOnly = false }) {
  if (!dir) return { ok: false, error: 'directory not found' };
  if (!SUPPORTED_CHAT_CLIS.includes(cli)) return { ok: false, error: `cli must be ${SUPPORTED_CHAT_CLIS.join(', ')}` };
  if (!['terminal', 'chat'].includes(kind)) return { ok: false, error: 'kind must be terminal or chat' };
  if ((cli === 'claude-exp' || cli === 'codex-exp') && kind !== 'chat') return { ok: false, error: `${cli} only supports chat sessions` };
  const loginFlowCli = { 'codex-login': 'codex', 'claude-auth-login': 'claude' }[loginFlow]
    || cliForLoginFlow(loginFlow);
  if (loginFlow && (loginFlowCli !== cli || kind !== 'terminal')) return { ok: false, error: 'loginFlow only supports whitelisted interactive login terminal sessions' };
  const experiment = validateExperimentalSession({ enabled: tuiChatMirrorEnabled(), cli, kind, experimentalMode });
  if (!experiment.ok) return experiment;
  // Model can be set for both Claude and Codex sessions. Claude terminal mode
  // interpolates it into a shell command, so keep the charset tight; Codex uses
  // the same id shape in config.toml.
  if (model && !/^[A-Za-z0-9._:\/\[\]-]{1,100}$/.test(model)) {
    return { ok: false, error: 'invalid model' };
  }
  const effortLevel = normalizeEffort(effort);
  if (effortLevel === undefined) return { ok: false, error: 'invalid effort' };
  if (!validEffortForCli(cli, effortLevel)) return { ok: false, error: 'invalid reasoning level' };
  const sessionEffort = effortLevel || (cli === 'codex' || cli === 'codex-exp' ? codexDefaultReasoningLevel() : null);
  const sessionAgent = normalizeCliAgent(cli, agent);
  if (sessionAgent === undefined) return { ok: false, error: 'invalid agent' };
  const rp = rolePrompt == null ? null : String(rolePrompt).trim();
  if (rp && rp.length > 40000) return { ok: false, error: 'rolePrompt too long (max 40000)' };
  // Provider override (cc-switch). An explicit value is validated; when omitted
  // the session inherits the global default for this CLI. null = use the default
  // login / OAuth subscription.
  const autoSelection = validateProviderSelection(providerSelection, { cli, providers }); if (!autoSelection.ok) return { ok: false, error: autoSelection.error }; let providerId;
  if (provider === undefined) {
    const defaultPool = cli === 'codex-exp' ? 'codex' : cli === 'claude-exp' ? 'claude' : cli;
    providerId = primaryProviderCandidate(autoSelection.value)?.providerId || providerDefaults[defaultPool] || null;
  } else {
    const v = validProviderId(cli, provider);
    if (!v.ok) return { ok: false, error: 'invalid provider' }; if (autoSelection.value && !autoSelection.value.candidates.some(candidate => candidate.enabled && candidate.providerId === v.value)) return { ok: false, error: 'Auto Provider fallback must be an enabled candidate' };
    providerId = v.value;
  }
  if (loginFlow) providerId = null;
  else providerId = providers.normalizeOfficialProviderId(cli === 'codex-exp' ? 'codex' : cli === 'claude-exp' ? 'claude' : cli, providerId);
  const loginEnvChecked = sanitizeLoginEnv(loginEnv, loginFlow);
  if (!loginEnvChecked.ok) return { ok: false, error: loginEnvChecked.error };
  // Sub-task route (Claude/Codex only), pinned at creation. Air tasks choose their
  // line before they exist, so this cannot wait for the profile PATCH — same rules,
  // same module as that path.
  const subagentChecked = normalizeSubagentInput({ cli, provider: providerId, subagent, validProviderId, providers });
  if (!subagentChecked.ok) return { ok: false, error: subagentChecked.error };
  if (validateOnly) return { ok: true };
  const sid = id || allocateSessionId(dir, cli, kind);
  if (persistedSessions.has(sid)) return { ok: true, id: sid, session: persistedSessions.get(sid), reused: true };

  // Every session is isolated — make sure the directory is a git repo, then give the
  // session its own worktree + branch.
  const deferred = kind === 'chat' && !!taskBoundTaskId && !workspaceOwnerSessionId;
  const ready = deferred ? { ok: true } : await ensureDirGitReady(dir);
  if (!ready.ok) return { ok: false, error: friendlyDirReason(ready.reason) };
  let worktreePath = path.join(dir.path, WORKTREE_SUBDIR, sid);
  let branch = `multicc/${sid}`;
  const rollbackOptions = { sessionId: sid, baseBranch: dir.baseBranch };
  try {
    if (!deferred) ({ worktreePath, branch } = workspaceOwnerSessionId
      ? sharedWorkspace(persistedSessions, workspaceOwnerSessionId, dir.id)
      : await gitWorktreeAdd(dir.path, sid, workspaceBaseCommit || dir.baseBranch));
  } catch (e) {
    if (!deferred && !workspaceOwnerSessionId) await gitWorktreeRollbackCreate(dir.path, worktreePath, branch, rollbackOptions);
    return { ok: false, error: 'worktree 创建失败: ' + e.message };
  }

  const createdAt = new Date().toISOString();
  const session = {
    id: sid,
    dirId: dir.id,
    cli, kind,
    cliSessionId: null,   // claude gets one allocated on spawn; codex captures from first event
    label,
    model: model || null, // null = follow default/provider model
    effort: sessionEffort || null, // null = follow Claude Code/provider default
    agent: sessionAgent || null, // Claude/OpenCode/Qoder native --agent; unsupported CLIs keep null
    provider: providerId, providerSelection: autoSelection.value, // concrete manual fallback + optional virtual Auto policy
    // Auto-commit+merge is ON for a new session unless the caller says
    // otherwise: the per-turn checkbox defaults to it, so an explicit `false`
    // (experiment / task-shell branches) must stay the only way to opt out.
    autoCommit: autoCommit !== false,
    // streaming (流式常驻) is now claude's default mode: keep the claude process
    // alive across turns for faster, context-preserving continuation. Non-claude
    // CLIs ignore this field. Only claude chat sessions default on.
    streaming: cli === 'claude' && kind === 'chat',
    // autoContinue is no longer a user-facing toggle (the picker keeps only the
    // streaming option). The field stays true for back-compat only; the old
    // auto-drive mechanisms are retired.
    autoContinue: true,
    createdAt, workspaceState: deferred ? 'planned' : 'awake', workspaceBaseCommit, lastWorkAt: createdAt,
    worktreePath, workspaceOwnerSessionId,
    branch,
  };
  if (rp) session.rolePrompt = rp;
  if (subagentChecked.value) session.subagent = subagentChecked.value;
  if (rolePresetId) session.rolePresetId = String(rolePresetId).trim();
  if (type) session.type = type;   // commander (and future roles) — round-trips via bootstrap/state + session-persistence
  if (loginFlow) session.loginFlow = loginFlow; if (loginEnvChecked.env) session.loginEnv = loginEnvChecked.env; // whitelisted interactive login terminal (codex-login) + allowlisted env pins
  if (type === 'worker' && taskExecutionSlot) session.taskExecutionSlot = true;
  if (ephemeral) session.ephemeral = true; if (experiment.mode) session.experimentalMode = experiment.mode; if (taskBoundTaskId) session.taskBoundTaskId = String(taskBoundTaskId).slice(0, 120);
  if (kind === 'chat') ensureCliStates(session);
  try {
    if (persistence === 'required') {
      sessionPersistence.mutate(persistenceSource, records => records.set(sid, session));
    } else {
      persistedSessions.set(sid, session);
      savePersistedSessionsBestEffort(persistenceSource);
    }
  } catch (error) {
    // The record never committed. Remove the just-created worktree so a failed
    // HTTP create cannot leave either a session ghost or an unowned worktree.
    if (!deferred && !workspaceOwnerSessionId) await gitWorktreeRollbackCreate(dir.path, worktreePath, branch, rollbackOptions);
    throw error;
  }
  appendEvent(dir.id, 'session_created', `${cli} ${kind}${ephemeral ? ' (gw)' : ''}`, sid);
  return { ok: true, id: sid, session };
}

  return createSessionRecord;
}
module.exports = { createSessionRecordFactory };
