# Fleet Commander startup and upgrade migration

MultiCC enforces this invariant at startup: every valid registered directory
(Fleet) has exactly one routable chat session carrying stable metadata
`type: "commander"`. Task-board automatic routing remains unavailable until
the relevant Fleet has completed this migration.

## Identity and idempotence rules

The migration is idempotent. A Fleet with one non-ephemeral chat session whose
`type` is already `commander` retains that session identity; its role prompt may
be refreshed to the current router-only contract. Re-running an upgrade or
restarting the service does not create another session.

Stable metadata is the only Commander identity: the migration does not inspect
or interpret historical labels or role prompts. If a Fleet has no typed
Commander, MultiCC always creates a fresh one through the normal session-
creation service. Every pre-type session remains untouched, including a session
whose label and prompt happen to match an older bundled Commander preset.

## Creation and CLI selection

Missing Commanders are created through the same `createSessionRecord` service
as the session API. They therefore receive a normal chat record, a dedicated
`multicc/<sessionId>` branch, an isolated worktree, required atomic session
persistence, and the complete current Commander preset prompt.

CLI selection uses this explicit compatibility order, skipping every entry
whose executable is unavailable:

1. an explicit future-compatible Fleet `commanderCli` or `defaultCli` value;
2. the current Commander preset's default CLI;
3. CLIs already used by that Fleet, newest first;
4. `codex`, then `claude`, then the remaining supported CLIs.

For the selected CLI, a configured provider default is used only if it still
exists. Otherwise a valid provider already used by that Fleet is preferred,
then the first currently registered provider, then the CLI's native login.
The migration deliberately persists `model: null`, so an old release's model
name cannot become a stale pin.

## Failure, isolation, and readiness

Directories are migrated independently. A missing path, unsafe home path, or
duplicate physical directory is skipped as an invalid Fleet. A failure in one
valid Fleet does not create or alter a Commander in another Fleet.

`GET /readyz` returns HTTP 503 while a migration is pending or when any valid
Fleet failed, with a sanitized `checks.commanderMigration.failures` array of
`directoryId` and error code. It never includes repository paths, prompts,
providers, tokens, or stacks. Healthy Fleet results are retained independently:
their task-board automatic routes may operate after their own migration is
ready, while a failed Fleet receives HTTP 503 and cannot silently fall through
to a worker. Manual session targeting remains unchanged.

Creation is transactional. If required session persistence fails after Git
resources were created, the creation compensation removes the new worktree and
branch and verifies both are absent. If compensation itself cannot prove a
clean rollback, startup reports `SESSION_CREATE_ROLLBACK_FAILED` and readiness
stays unhealthy.

## Upgrade and rollback

`./multicc update` installs the new revision, restarts the service, and polls
`/readyz` until startup migration completes. A degraded migration makes the
update command return failure with the readiness report instead of printing a
false success. Every ordinary service start also runs the same idempotent
migration before accepting task-board automatic work.

For application rollback, stop MultiCC before changing versions. Older
versions safely ignore the additive `type` field, so the least destructive
rollback is to leave a successfully created Commander session and its worktree
in place. `sessions.json.bak1` and later rolling backups contain the preceding
atomic snapshots if an operator must restore data; restore only while the
service is stopped and preserve the current files first. Do not manually
remove a Commander branch/worktree independently of its session record. After
repair or rollback, restart and confirm `/readyz` before submitting automatic
task-board work.
