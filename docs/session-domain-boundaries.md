# Session domain boundaries

Reviewed: 2026-07-18.

The session bounded context under `src/session/` is host-independent. Its
query services are composed into the host; state transitions have a Rust owner. The
bounded workspace projection is exposed through a versioned endpoint while
the legacy workspace payload remains available during client migration.

## Modules and ports

- `query-service.js` reads persisted records and runtime projections through
  injected `records` and `runtime` ports. Its only output is the canonical
  `session-dto` contract. Auxiliary/gateway records and raw runtime objects are
  never returned.
- `workspace-service.js` combines safe session DTOs with an injected directory
  record port and workspace-facts port. Directory paths, branches, current-file
  paths, invalid-session errors and process state are intentionally absent.
- `chat-history-service.js` owns normalization, message ids, interim replacement,
  consecutive-assistant deduplication, trimming, pagination and deletion. Its
  repository is a port; `adapters/chat-history-file-repository.js` is the first
  data-root-backed adapter.
- `native/core/src/workspace_state.rs` owns the session state machine and
  run-segment timestamps. Pending dispatched work converts resting states into
  `background`. The addon's `sessionStateApi()` supplies the compatibility
  namespace, real `Set` values, defaults and callback-backed service factory;
  the former `src/session/state-transition.js` binding has been retired.
- `ports.js` is the dependency boundary. Core session modules do not require
  Express, `server.js`, directory/provider/git/orchestration contexts or the
  filesystem.

Architecture tests enforce those dependency rules. DTO tests inject records
containing `token`, native ids, `cwd`, worktree paths and stacks and verify that
none crosses the public boundary.

## Host composition and compatibility

The following paths now use the bounded context:

- `/api/v1/sessions` and `/api/v1/sessions/:id` use
  `createSessionQueryService()` through narrow records/runtime ports;
- the workspace runtime delegates state and summary ownership to
  `RustWorkspaceState`; the domain/status tests use the native
  `sessionStateApi().createSessionStateService()` compatibility port, without
  adding a JavaScript service facade;
- `/api/v1/directories/:id/workspace` uses `createWorkspaceService()` and a
  versioned, path-free workspace contract;
- `MULTICC_SESSION_DOMAIN_SHADOW=1` compares the legacy workspace snapshot
  against the bounded projection. Diagnostics are capped and contain field
  names only, never mismatched values.

The unversioned session and workspace REST/WS payloads remain unchanged because
the current Web and Flutter clients still consume native ids, worktree/current
file details, epoch timestamps and extended merge diagnostics. They must move
to the v1 contracts before those compatibility fields can be retired.

## Chat-history migration gate

The production chat-history mutation path is intentionally not partially
switched. It still owns incremental saves, memory distillation, delivery-id
proof for the durable outbox, broadcasts and periodic memory review. Running a
second cache beside that path would create stale reads and false acknowledgments.

The bounded service now has the prerequisites for a later atomic cutover:
single interim upsert, exact unknown-cursor behavior, per-session retention,
delete, strict on-disk delivery proof and cache-safe write failure semantics.
The remaining step is to express host side effects as explicit post-persist
ports and cut all history reads/writes together.

The remaining follow-up is:

1. migrate Web/Flutter workspace clients to the path-free v1 DTO/WS surface;
2. switch chat-history mutation only after incremental-save, memory-distillation
   and broadcast side effects are expressed as explicit host ports;
3. remove the old functions after a compatibility window.

## Sensitive-data rule

Public session/workspace projections are allowlists. They exclude credentials,
tokens, native session ids, `cwd`, worktree/filesystem paths, error/stack
objects, prompts, memory blobs and process handles. New fields must first enter
the versioned DTO/schema contract and pass architecture/contract tests.
