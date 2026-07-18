# Data root and repository governance follow-up

Reviewed: 2026-07-18. This document records items deliberately not deleted or
moved in the Data root + CI P0/P1 batch.

## Runtime paths not migrated in this batch

`server.js` was explicitly out of scope. The following paths therefore remain
outside `MULTICC_DATA_DIR` or tied to the checkout and need owner-specific
migration plans:

- `server.js`: `.env` in the package root. Moving it needs startup/install and
  settings-write compatibility, plus an explicit secret migration.
- `server.js`: default `memories/` root. Existing session/shared memory layout
  needs an atomic directory migration; `MULTICC_MEMORY_ROOT` remains the safe
  override meanwhile.
- `server.js`: `~/.claude/projects`, `~/.codex/sessions`, CLI settings and skill
  roots. These are upstream CLI-owned stores and must not be relocated as
  MultiCC state.
- `server.js`: `public/multicc.apk`, public assets and agent presets. These are
  packaged assets rather than writable runtime state.
- `src/providers.js`: `~/.multicc/codex-homes` and the external read-only
  `~/.cc-switch/cc-switch.db` source. The former needs a backward-compatible
  directory migration; the latter is owned by cc-switch.
- `src/artifacts.js`, `src/detached.js`, bridge gateway working directories and
  local ASR models under `~/.multicc`. These may contain large or live process
  state, so moving them requires resumability and rollback tests.

Safe leaf-module paths migrated here are provider/token accounting, push,
shares, tunnel config, voice examples/vocabulary, cron tasks, bridge configs,
and gateway chat-history reset paths. Cron copies a legacy store forward and
leaves the old file in place for rollback.

## Tracked binary and backup inventory

No files were deleted in this batch.

- `public/multicc.apk` — 58,922,239 bytes. Decide whether releases or Git LFS
  should own it; verify download/update behavior before removing it from Git.
- `server.js.bak.task1`, `task2`, `task4`, `task5`, `task7`, `task9`, `task10` —
  seven tracked source backups, roughly 376–421 KB each. Compare against Git
  history, check whether tooling still consumes them, then remove in a dedicated
  cleanup change if owners approve.

## Sensitive-data review queue

A filename-only credential-pattern scan flagged the following tracked files.
The hits include examples and test placeholders and are not evidence that a
live credential is present. Run an approved history-aware secret scanner and
have owners classify each finding without copying values into tickets or logs:

- `.arch-review-findings.json`
- `_vm.txt`
- `install.sh`
- `public/agent-presets.json`
- `public/manage.js`
- `tests/test-codex-subagent-routing.js`
- example material under `skills/creative-comfyui`, `skills/mcp-native-mcp`,
  `skills/mlops-inference-outlines`, and `skills/mlops-research-dspy`

If any value is confirmed live, revoke/rotate it first, then remove it from the
current tree and rewrite history only under an explicit repository-owner plan.
