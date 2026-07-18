# Session domain boundaries

Reviewed: 2026-07-18.

The third boundary-extraction phase introduces a host-independent session
bounded context under `src/session/`. It is deliberately not wired into
`server.js` yet: the host remains a high-conflict integration surface while
durable orchestration and provider routing are changing in parallel.

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
- `state-transition.js` owns the session status state machine and run-segment
  timestamps. Pending dispatched work converts resting states into `waiting`.
- `ports.js` is the dependency boundary. Core session modules do not require
  Express, `server.js`, directory/provider/git/orchestration contexts or the
  filesystem.

Architecture tests enforce those dependency rules. DTO tests inject records
containing `token`, native ids, `cwd`, worktree paths and stacks and verify that
none crosses the public boundary.

## Deliberately not wired

The existing v1 session routes, workspace WebSocket snapshot and chat-history
functions still execute their established implementations in `server.js`.
Replacing them requires a small host composition change plus compatibility
characterization for legacy unversioned routes and live WebSocket payloads.
That integration should occur only after the durable/provider hotspots settle;
this phase does not duplicate writes or partially switch readers.

The intended follow-up is:

1. compose concrete ports from the existing maps/repositories at startup;
2. dual-run projections in tests and compare legacy/v1 payloads;
3. switch v1 queries and workspace snapshots first;
4. switch chat-history mutation only after incremental-save, memory-distillation
   and broadcast side effects are expressed as explicit host ports;
5. remove the old functions after a compatibility window.

## Sensitive-data rule

Public session/workspace projections are allowlists. They exclude credentials,
tokens, native session ids, `cwd`, worktree/filesystem paths, error/stack
objects, prompts, memory blobs and process handles. New fields must first enter
the versioned DTO/schema contract and pass architecture/contract tests.
