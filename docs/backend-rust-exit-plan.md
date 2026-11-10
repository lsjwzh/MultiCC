# Rust backend exit plan

## Goal and acceptance

Continue the existing plan: steps 1–5 are complete; step 6 is the backend migration and remains open. The Goal created on 2026-11-08 stays active until **all four** criteria below have evidence. Completing one native kernel, addon or route batch does not complete this goal.

| Acceptance criterion | Required evidence | Current state |
|---|---|---|
| HTTP, middleware, authentication, errors, WS and SSE | Inventory reconciled with runtime mounts; equivalent response/event contracts; isolated integration tests; no remaining Express handler in production | Open. Axum owns the public listener and selected routes; the remainder is forwarded to Node |
| Chat orchestration | Rust owns admission, turn/attempt state, provider selection, CLI supervision, streaming, cancellation, background work, completion and recovery; unchanged client contracts | Open. Several Rust kernels and Claude process supervision exist; the turn coordinator and other host lifecycles remain in Node |
| Persistence | Rust owns schemas/migrations, reads/writes/transactions and history; old-format import and recovery fixtures pass; isolated migration checks prove record/order/relationship consistency | Open. Rust owns SQLite operations and several stores; many domain writes and history/delivery effects still use Node |
| Node production exit | Full project/contract/integration checks pass; standalone Rust startup has no backend Node child; packaging, deployment and rollback instructions tested | Open. Gateway still supervises Node; disable that path only after the preceding criteria pass |

Use the existing Axum/Tokio gateway, rusqlite/SQLite databases and established JSON/JSONL formats. Do not change databases or client APIs as a shortcut. Build/test tooling, frontend JavaScript and the Electron client are outside backend replacement; any Node helper needed to serve backend requests remains an open dependency. External user-selected CLI executables retain their existing protocol contracts.

No production restart, configuration switch, live-data migration, commit, merge or push is part of this worktree execution unless separately authorized. Reversible implementation, isolated data copies/fixtures and verification continue autonomously. Keep one owner for mutable authorization and persistence state. Unknown behavior defaults to the established API contract and is recorded, rather than replaced with a stub or a success response.

## Step 6 execution ledger

| Work item | Deliverable and exit condition | State |
|---|---|---|
| 6a. Reconcile backend surfaces and owners | [Static route inventory](backend-route-inventory.md), runtime route/WS/SSE inventory, persistence and lifecycle ownership map; dynamic/conditional mounts explicitly covered | In progress. Static candidates plus the default isolated startup [runtime inventory](backend-runtime-inventory.md) captured (570 routes, 34 middleware/router layers); conditional/plugin profiles and WS/SSE reconciliation remain |
| 6b. Finish entry and dynamic authorization ownership | Login/Token/tickets, peer/locality policy, service/workspace-sharing/provider authorization all execute in Rust; remaining addon state owner can be hosted without Node | In progress. Login HTTP and service HTTP/WS migrated; provider relay shares and workspace-sharing records/passwords/scope policy/persistence migrated to core; remote workspace transport and external-workspace HTTP/state ownership migrated; source password windows and FIFO admission migrated; all source sharing HTTP and landing routes migrated; live directory/member ports, scoped authorization adaptation and WS hosts remain |
| 6c. Replace remaining HTTP and stream hosts | Each inventory entry has a Rust route and fixture; static files, uploads/downloads, WS/SSE, provider relays, administration, tools and integration hosts covered | Open; batch existing coherent domains with their state owners |
| 6d. Replace chat orchestration | Complete turn/attempt state machine and CLI lanes; abort/retry/background/reconnect/finalization invariants tested against recorded events | In progress. The live chat-session table and the per-session turn runtime store now have one native owner beside the session-record owner; CLI supervision, streaming, finalize effects and the remaining turn/attempt transitions stay in Node. Existing Rust kernels are reused, not rewritten |
| 6e. Finish domain persistence | Versioned schema and old-format readers, transaction boundaries, recovery and restart consistency; isolated data validation manifests | Open; migrate stores alongside their consuming domains, then reconcile all remaining writers |
| 6f. Disable Node backend and verify delivery | Rust-only production startup/package, full tests, contract inventory has no Node fallback, verified deployment/rollback documentation | Open; cannot mark complete while gateway supervisor still needs server.js |

6b–6e can advance by coherent domain, but this ledger is one plan. Every batch records deleted Node code, retained bridges, tests, format differences and next dependency. Existing evidence is in [gateway.md](gateway.md) and [request-lifecycle-rust.md](request-lifecycle-rust.md).

## Ownership snapshot at Goal start

| Domain | Current implementation | Remaining work |
|---|---|---|
| Public listener and selected HTTP routes | `native/gateway` Axum/Hyper | Fallback still opens a dedicated connection to Node |
| Login endpoints and service proxy | Gateway-native HTTP; service config/HTTP/WS wholly Rust | Auth state lives in a Rust addon in the Node process; relocate owner after dependent hosts migrate |
| Token/shutdown/WS tickets | `native/core/auth_runtime.rs`; private authenticated control stream | General Node WS host still consumes tickets and creates business snapshots |
| Workspace-sharing authorization (legacy `fleet` API names) | `native/core/workspace_sharing`, asynchronous addon handle; live directory/session callbacks | Core owns records, scrypt, grant policy, counters, revocations and both JSON writers. Remote HTTP/HTTPS transport is now core-owned. Move rate limiting, HTTP/WS routes and the live context owners into Rust |
| Provider relay share authorization | `native/core/relay_shares.rs` and `durable_state.rs`; asynchronous addon handle | Core owns scrypt/AES-GCM, recovery, counters, revocations and backups. Move its HTTP routes and owner placement into the gateway alongside provider lifecycle |
| Other provider/CLI authorization | Mixed Rust kernels and live addon host ports | Remove live host references by transferring attempts/session/provider state owners |
| Chat and session lifecycle | `src/chat`, CLI adapters and session/coordinator modules | Port remaining state transitions and effects, using current wire event fixtures |
| State and history | SQLite kernels plus `src/state/store.js`, session/history repositories and domain-specific JSON files | Preserve existing envelopes, backups, JSONL append/rewrite and recovery behavior; migrate each domain writer |
| Channel/voice/browser/tool integrations | Node SDK/process adapters plus native helpers | Replace backend Node adapters with protocol/native equivalents; keep API and device/platform behavior |

## Validation rules

- Freeze former implementations only under tests as differential oracles; never retain a hidden production fallback to make a migration test pass.
- Test raw HTTP and WS/SSE, not only DTO functions. Cover auth revocation, failed writes, cancellation, disconnect/reconnect, slow consumers, process crashes and restart recovery.
- Use isolated data roots and synthetic/redacted fixtures. A live database copy requires a consistent SQLite backup procedure; never directly modify user databases for testing.
- Reconcile schemas, row counts, foreign-key relationships, history ordering and content hashes before claiming data migration validated. Include damaged tail and partial-write fixtures.
- Native source fingerprint, binary provenance and startup probes must match the final source. Run targeted checks after each domain; run full tests and packaging checks before the Node exit milestone.
- Preserve the previous deployable binary and compatible data schema for rollback. Document any non-reversible schema transition and verified restoration path before enabling it.

## Current batch

At Goal start, `HEAD...main=1/0`; the worktree contains the uncommitted authentication-front-door and service-host batches. Their latest validated build is `a2b2a7635a7c2ceb1ea549dc`. This is a baseline receipt, not evidence that the Goal criteria are complete.

Provider relay share state and persistence now execute in Rust, including scrypt, AES-GCM credential recovery, old arrays/schema envelopes and the three rolling backups. All production callers await native mutation completion; HTTP admission pauses at the native gate and resumes once with the result. The source locality facade now uses the same Rust policy as the gateway. These are progress inside 6b/6e, not a completed HTTP-domain migration: provider routes, the relay transport and workspace-sharing membership still use Node hosts.

Current targeted evidence: legacy/native sealed credentials are mutually readable; parsed state, unknown fields (including isolated UTF-16 surrogates), usage counters and revocations survive round trips; 392 parser cases, backup recovery cases, failed writes, concurrent revoke ordering and event-loop responsiveness pass. Source locality adds 8,330 peer/Host/header combinations, live getter/exception order and private-address boundary checks. The final targeted suite has 71 passing tests, with an additional real isolated gateway → Node WS ticket/snapshot/replay check. Rust core 400, CPR 9 + 27, gateway 27 + 32 pass; all `npm test` stages are covered on the final native build: deterministic passed, then the stale auth source assertion was updated and contracts/native resumed to exit 0; Electron tooling and pwsh are unavailable (one skip each). Final native fingerprint `86e6a32483c2383600893d0a`; binary provenance and probes pass. See gateway.md §14 for the receipt.

Next implementation: workspace-sharing rate limiting and HTTP/WS hosts, then relocate provider route/lifecycle owners. Runtime reconciliation in 6a remains open. The standalone Node exit milestone remains blocked by unfinished implementation, not by a request for user approval.

Terminology and scope verified on 2026-11-08: `Fleet` is a legacy implementation/protocol name, not a product concept to restore. Commit `7d0e2ddf` removed the old Web management UI, including `public/manage-fleet-sharing.js`. The current App still exposes workspace sharing in `app/lib/widgets/air_tasks_view.dart` and calls `/api/fleets` and `/api/external-fleets` through `app/lib/services/air_service.dart`; `server.js` still mounts those handlers. Migrate the active workspace-sharing contract and preserve its wire/data names for existing clients. Do not restore the deleted management UI or infer that an old filename proves a feature should be retained. New Rust implementation modules use workspace-sharing terminology. The former native draft is now registered and wired into the state/authorization callers; the domain is not complete while its HTTP and transport hosts remain in Node.


## Next continuation dependency notes

- Workspace-sharing state now has a single Rust owner. `src/routes/fleet-sharing.js` still mounts the handlers and supplies `getDirectory` and `listSessions` over live directory/session maps. Remote request/response policy and transport now live in core. Remaining dependencies are password failure limiting, HTTP/WS hosting and ownership of those live maps.
- `server.js` still calls workspace-sharing authorization synchronously through the native snapshot/plan interface. Only short read locks are taken; crypto and file writes run on workers. Create/access/revoke/remove callers now await native completion. Route password attempts remain serialized across the asynchronous bridge so concurrent failures cannot bypass the existing limit.
- Keep the current provider relay owner single. HTTP routes and provider deletion/reference effects remain Node dependencies despite the completed Rust credential kernel. Cross-store atomicity and crash-window validation remain part of 6e.
- Latest production changes remain uncommitted on top of `287cbc74`; no merge, push, restart or production data/configuration change has been performed. Continue autonomously within the Goal, without marking any of the four overall acceptance criteria complete.


## Workspace-sharing state batch (2026-11-08)

Core now owns both existing version-1 JSON files, share passwords and grants, access counters, revocation, external reference upsert/refresh/removal, payload sanitization and HTTP/WS scope decisions. A mutex serializes writers while an immutable published snapshot serves synchronous authorization without waiting for password work or I/O. The old Node records/crypto/writer/policy implementation was removed; its frozen copy lives only under `tests/helpers/legacy-workspace-sharing.js` for differential checks.

Password verification returns an internal one-use nonce so the host can read fresh directory context after expensive work. Consumption rechecks the current record, revocation and access budget before writing. The nonce stays outside HTTP, expires after 30 seconds and is bounded to 4,096 pending verifications per owner. Directory/session context is still a trusted migration port, read for each request rather than cached. Source records and imported references are never duplicated as a second Node authority.

Current evidence: 60 focused tests pass, including 1,233 legacy/native HTTP/WS scope combinations, 360 payload cases, old/new state and password interoperability, malformed external-cache projections, preserved unknown/UTF-16 data, failed writes, live membership changes, concurrent budgets/revocation and real LAN-to-loopback sharing. Rust core has 404 passing tests including four independent native ownership/concurrency tests. Final source fingerprint for this batch is `286e8e04b10998f445304d68`; addon provenance and probe pass. Full `npm test` completed with exit 0 on this build (desktop toolchain and pwsh: one skip each). CPR 9 unit + 27 integration and gateway 27 unit + 32 integration passed. The final real isolated gateway/server check covers external shared HTTP scope, shared workspace WS ticket/snapshot/replay and immediate post-revoke denial. Formatting, syntax, source budget, test tiers and diff checks pass. No whole-backend completion is claimed.

The domain HTTP routes, remote network transport and rate limiter remain Node code. Its directory/session ports also remain a Node dependency. These are explicitly open work in 6b/6c/6e; Express and backend Node remain required. Do not disable the supervisor path until all four acceptance criteria at the top are proven.


Next continuation starts from this validated state batch. There are 77 changed/untracked files including earlier batches; `HEAD...main=1/0` at verification. No commit, merge, push, production restart or live configuration/data change occurred. Keep the Goal active and proceed with remote workspace transport/response policy and HTTP/WS hosting, then the remaining domains in the same ledger.


## Workspace-sharing remote transport batch (2026-11-08)

Core now owns DNS pinning, HTTP/HTTPS requests, structured remote errors, response byte limits,
redirect refusal and whole-request deadlines. The production Node fetch/DNS implementation is
removed; only the paused Express upload byte adapter, live context ports and call orchestration
remain. A one-slot native channel limits each pending upload chunk to 64 KiB. A route moving to
Axum can reuse the same policy/transport without a Node stream. This advances 6b/6c but does not
finish the HTTP host migration. No overall acceptance criterion has been marked complete.

Compatibility differences, the bounded upload lifecycle and final verification receipt are in
[gateway.md section 16](gateway.md#16-工作区分享远端传输迁入-rust2026-11-08). Production service
configuration and data are unchanged; no commit, merge, push or restart was performed.

Final receipt: native source fingerprint `dab9493f8e0f81f548af5b03`; addon/gateway provenance
and startup probes pass. 72 focused tests, including 193 real HTTP error/redirect comparisons
and 4 header comparisons, pass. Core 404, CPR 9 + 27, gateway 27 + 32 and real gateway workspace
HTTP/WS authorization/replay/revocation pass. Full `npm test` completed from the beginning with
exit 0 on the final build (Electron builder tooling and pwsh: one unavailable-tool skip each).
An interrupted earlier run left a fixture-only browser daemon; it was identified and stopped,
the two cleanup tests passed independently, then the entire npm suite passed. This receipt is
for macOS ARM64, not a claim of cross-platform package certification or overall Node exit.


## Imported workspace gateway batch (2026-11-08)

The complete external-workspace route family, imported-state owner and remote
operation orchestration now run in Rust. Node no longer opens the external file
or mounts those routes. Uploads enter Axum directly; the Node stream pump and
N-API upload channel are removed. The source-sharing owner opens only its own
file and rejects external operations. Protocol 6 requires the matching gateway,
addon and host. Deployment and rollback still require a single writer.

This supersedes the prior batch's upload-bridge boundary. Source password failure
windows, source HTTP/WS hosts, live directory/session ownership, provider routes,
chat orchestration and other persistence remain open. Overall progress remains
5/6; no backend-exit acceptance criterion is claimed complete. Final fingerprint `129db673b9a3544692de2cf4` passes provenance and startup probes.
45 complete HTTP comparisons, upload/cancellation/backpressure, failed-save and
child-restart ownership checks pass. Core 405, CPR 9 + 27 and gateway 27 + 32 pass;
the full npm suite exits 0, with one unavailable-tool skip each for Electron
packaging and pwsh. See gateway.md section 17 for the complete receipt. No commit, merge, push,
production restart or configuration change is authorized in this turn.


## Source password admission batch (2026-11-08)

Rust now owns source password failure windows, FIFO reservations, expiry and
completion/cancellation rules. The Node failure map and access promise tail are
deleted. A minimal host adapter remains because source operations still obtain
fresh directory/session context between password verification and durable
consumption. It contains no failure-window state or policy.

The next dependency remains source HTTP/WS hosting together with live membership
ownership. Member deletion/revocation and password-verification races must retain
one authority; an independent gateway cache is not a completed migration. The
source routes and WS snapshot host remain Node code. Existing provider, chat and
persistence work also remains open, so overall progress is still 5/6. The final
batch receipt is in gateway.md section 18. No commit/merge/restart is authorized.


Final source-admission receipt: fingerprint `37fae5702ecb77df19927a26`, matching
addon/gateway provenance and startup probes. The 23 focused tests and 31 legacy
comparisons pass. A real gateway/server burst gives 10 wrong-password responses
and 4 rate-limit responses without consuming access or trusting forwarded IPs.
Rust core 408, CPR 9 + 27, gateway 27 + 32 and the full npm suite pass; Electron
packaging and pwsh each have one unavailable-tool skip. Source-admission state
and FIFO are complete for this batch; source HTTP/WS and membership ownership
remain open. No commit, merge, production restart or configuration change.

## Source administration HTTP batch (2026-11-09)

Source list and revoke HTTP handlers are now gateway-owned; their Express
implementations and mounts are deleted. A dedicated Rust control connection uses
the existing source Store, with a separate generation/capability from auth and
no JS request bridge. Native writes publish after persistence, so revocation is
immediately visible to remaining source grant consumers. Bulk framing preserves
large lists; cancelled or ambiguous mutations are never replayed. Protocol 7
requires the matching gateway/addon/host, with unchanged schema-1 share files.

Remaining Node scope: source creation/import/state/ticket routes and live
membership/WS lifecycle; bootstrap only passes connection parameters to native.
Move those lifecycles before relocating the source Store into the gateway.
Provider, other domains, chat orchestration and persistence remain open. Overall
progress stays 5/6. See gateway.md section 19 for behavior differences and the
batch receipt. No commit, merge, push, production restart or configuration change.

Final receipt: `3803e14e0af6f74f69e9e5b5`, verified addon/gateway provenance and
protocol 7. All 62 focused tests and 40 source HTTP comparisons pass, along with
bulk/gzip, failed persistence, immediate revocation, credential rotation,
child/gateway restart and real source HTTP/WS/LAN checks. Rust core 408,
CPR 9 + 27, gateway 30 + 32 and full npm test pass; Electron packaging and pwsh
each skip one unavailable-tool test. The worktree remains 1 commit ahead and
0 behind main, with no commit/merge/restart or production configuration change.

## Source share creation HTTP batch (2026-11-09)

The gateway now owns source administration creation, listing and revocation;
the corresponding Express handlers/mounts are deleted. Creation reads live
directory existence through one minimal asynchronous host port, with Rust owning
all validation, password computation and persistence in the existing Store.
The port uses weak references in a separate closure scope to allow VM collection,
and timed-out lookups never initiate a later mutation. Protocol 8 adds framed
source requests without changing auth framing or schema-1 files.

Retained Node scope is explicitly the current directory/member lifecycle, source
import/state/ticket/landing routes, WS hosting and bootstrap/read adaptation.
Remove the read port when directory ownership moves, then relocate the source
Store. Other domains and chat/persistence remain open; overall progress stays
5/6. See gateway.md section 20 for the batch receipt and compatibility details.
No commit, merge, push, production restart or configuration change.

Final creation receipt: fingerprint `e9524d0928824811ad2a71e6`, verified
addon/gateway provenance and protocol-8 probes. All 64 focused tests, 48 new
creation HTTP comparisons, directory lifecycle/error/timeout cases, large inputs,
concurrent mutations, failed persistence, GC and real sharing HTTP/WS/LAN checks
pass. Rust core 409, CPR 9 + 27 and gateway 30 + 32 pass. Full npm test exits 0,
including the final 256/256 native tests; Electron packaging and pwsh each skip
one unavailable-tool test. Syntax, formatting, test tiers, source budgets and
diff checks pass. The worktree remains 1 commit ahead and 0 behind main. Source
management HTTP is complete for this batch; import/state/ticket/landing, WS and
live membership ownership remain the next dependencies. Overall progress is 5/6.

## Source state HTTP batch (2026-11-09)

State GET/HEAD and OPTIONS now terminate in Rust, and their Express handler/mount
are deleted. Scope checks and post-context authorization share the existing Store;
no duplicate grant table or cached member authority is introduced. A weak host
port supplies one current directory/member snapshot while lifecycle ownership
remains in Node. The port must be deleted when that lifecycle moves to Rust.
Protocol 9 adds the state operation and context port without changing disk schema.

The next dependencies are password import, shared WS tickets, landing/WS hosting
and live membership ownership, then remaining domains and chat/persistence. The
source library read method remains needed by import. Overall progress is still
5/6; no commit, merge, push, production restart or configuration change is made.
See gateway.md section 21 for this batch's final verification receipt.

Final state receipt: `ef1796e0d7ee0483a8656b8f`, verified provenance and protocol 9.
All 54 focused tests and 55 state HTTP comparisons pass, together with live member
changes, revoked/failed/timed-out context reads, GC and real sharing HTTP/WS/LAN
checks. Rust core 410, CPR 9 + 27 and gateway 30 + 32 pass. Full npm test on the
final artifacts exits 0 (last group 256/256); Electron packaging and pwsh each
skip one unavailable-tool test. Syntax, formatting, tiers, source budgets and
diff checks pass. HEAD remains 1 ahead and 0 behind main with 86 worktree entries.
State HTTP is complete for this batch. Remaining Node context ownership and
import/ticket/landing/WS work keep overall progress at 5/6.

## Native source import batch (2026-11-09)

Source password import POST/OPTIONS now terminate in Rust. The Node handler,
mount, access admission wrappers, nonce proof table and readSharedFleet bridge
are deleted. Rust verification produces a non-Clone owner-bound value consumed
directly by the access writer, followed by native state projection. Internal
values avoid JSON round trips; encoding remains at real transport/file/host
boundaries. The library compatibility method makes one native workflow call.

The failure window belongs to the source control owner and survives reconnects.
Failed directory reads or persistence consume no budget; failed member reads
after persistence retain the committed access. The existing source RPC bounds
now apply to imports; disconnected or ambiguous operations are never replayed.
Protocol 10 requires a matching gateway/addon/host; schema stays 1.

Node still owns live directory/member state, so the two weak read ports remain
necessary. Their removal and moving the source Store into the gateway depend on
that lifecycle migration. Shared tickets/landing/WS hosting, provider/other
domains and chat orchestration/persistence remain open. Overall progress is 5/6.
No commit, merge, push, production restart or configuration change. See gateway.md
section 22 for the final receipt.

Fingerprint `8b71c948abd41a3042575b4a` has verified provenance and protocol-10
startup probes. All 53 focused tests, 71 new import HTTP comparisons, real source
HTTP/WS/LAN checks and Rust core 413, CPR 9 + 27, gateway 30 + 32 tests pass.
Full npm test exits 0 (last group 256/256); Electron packaging and pwsh each skip
one unavailable-tool test. Syntax (43 JS), formatting (40 Rust), 837 classified
tests, source budgets, governance and diff checks pass. HEAD remains 1 ahead
and 0 behind main, with 86 uncommitted worktree entries. This import batch is
complete; the overall Node exit remains unfinished at 5/6.


## Native source WS ticket batch (2026-11-09)

Shared ticket POST/OPTIONS now terminate in the Rust gateway. The old Express
handler/mount and JS WebSocket authorization method are deleted. Scope checks,
member authorization, metadata and issuance form one native workflow using the
existing source Store and shared AuthRuntime. Native metadata avoids JS/JSON
round trips. Final authorization and insertion hold one source publication lock,
with a revision/shutdown check in the same authentication owner.

The Node exception is limited to startup wiring and the ID-only live member read
port, plus the existing WS consumer/connection host. Move their state owners to
remove these adapters. Landing delivery, WS hosting, live directories/membership,
provider domains and chat orchestration/persistence remain open dependencies.
Protocol 11 is a matching gateway/addon/host deployment; schema remains 1.

Final receipt: fingerprint `ecf3d68274e8dd96589b9dfa` and protocol 11 have verified
provenance/startup probes. All 72 focused tests and 73 new HTTP comparisons pass;
the final 32 sharing tests also pass after ID-only projection/adapter cleanup.
Native atomicity, context failures, private/cyclic member fields, callback
collection, real sharing HTTP/WS and LAN checks pass. Rust core 417, CPR 9 + 27,
gateway 30 + 32 and full npm test pass (last group 256/256). Electron packaging
and pwsh each skip one unavailable-tool test. Syntax, formatting, 837 classified
tests, source budgets and diff checks pass. HEAD remains 1 ahead and 0 behind
main with 86 uncommitted worktree entries, including previous batches. See
gateway.md section 23 for detailed boundaries. Overall remains 5/6. No commit,
merge, push, production restart or configuration change.


## Native source landing batch (2026-11-09)

The gateway now owns source landing GET/HEAD/OPTIONS as well as all source
sharing API handlers. The final Express source route and its whole module are
deleted. Landing delivery reuses the asynchronous shared file sender and the
canonical package root; it does not add a source-state copy or private-data
lookup. Shared response fixes preserve error DTOs, conditional HEAD 304 and
non-API header behavior. Protocol 12 requires matching binaries/host, with
unchanged disk schema and coordinated rollback.

Remaining Node scope is bootstrap, live directory/member reads, generic scoped
HTTP authorization and WS ownership. Next move the directory/session projection
and subscription lifecycle used by workspace/runtime.js and
session/workspace-service.js, then the WS connection host. Heartbeats, ticket
consumption, workspace clients, snapshots, recent events, queue projections and
observer effects must retain one owner. Moving only a socket listener or adding
a mirror Map does not meet the exit criteria. Remove read/consume adapters and
internal serialization when their native owners can be colocated; provider and
other domains plus chat orchestration/persistence follow in the existing plan.

Fingerprint fe62afc2e9d46e3521648717 has verified provenance and protocol-12
probes. All 122 HTTP and 12 filesystem comparisons, large-file hash/range and
disconnect checks pass, along with real sharing HTTP/WS and LAN verification.
Rust core 417, CPR 9 + 27, gateway 30 + 32 pass. See gateway.md section 24 for
the final full-suite receipt. Overall remains 5/6; no commit, merge, push,
production restart or configuration change.

Final full-suite receipt: npm test exits 0 on the final artifacts, ending with
256/256 native tests. Electron packaging and pwsh each skip one unavailable-tool
test. Syntax (42 JS), formatting (41 Rust, existing module order preserved),
837 test tiers, source budgets, governance and diff checks pass. HEAD remains
1 ahead and 0 behind main, with 86 uncommitted worktree entries including prior
batches. This landing batch is verified; overall Node exit remains open at 5/6.


## Native workspace queue owner batch (2026-11-09)

The workspace queue table, stale-event decisions, normalization and view clock
now have one Rust owner. The corresponding Node Map and logic are removed.
Native views operate directly on typed Queue/Store state; an immutable read
facade serves remaining host consumers. The scheduler is still the upstream
execution owner, and existing startup hydration rebuilds the transient view.
This is a prerequisite within 6b/6c, not a completed WS/state-domain migration.

Node still owns status and summary state/effects, live directory and session
records, source selection, subscriptions and sockets. Continue in dependency
order through those owners; do not add a mirror Map or claim directory/member
ownership has moved. Remove the temporary addon read/transport adapters when
the corresponding native owners can be colocated. Other domains, provider and
chat orchestration/persistence remain open in the same step-6 ledger.

Fingerprint eb571715c533c41ad3c154ec and protocol-12 probes are verified.
106 focused tests include 1000 lifecycle operations, 94 input edge cases and
real WS snapshots/events/cursor clearing/reconnect comparisons. Real source
HTTP/WS and LAN verification passes. See gateway.md section 25 for the final
Rust/full-npm receipt. Overall remains 5/6. No commit, merge, push, production
restart or configuration change.

Final receipt: Rust core 421, CPR 9 + 27 and gateway 30 + 32 pass. Full npm test
exits 0 on the final artifacts, ending with 256/256. Electron packaging and pwsh
each skip one unavailable-tool test; the existing duplicate-bubble S6 case
remains TODO, not a passing case. Syntax (45 JS), formatting (44 Rust), 837 test
tiers, source budgets, governance and diff checks pass. HEAD is 1 ahead and 0
behind main, with 92 uncommitted worktree entries including prior batches.
Validation is on macOS ARM64; other platform packages are not certified here.
The queue batch is verified; overall progress remains 5/6.


## Native workspace run state and summary batch (2026-11-09)

The status/summary owner and session transition kernel are now native. Their Node
Maps, hydration and business logic have been deleted; summary effect ordering
runs in the native adapter against the existing live record and persistence ports.
Native values flow directly, with opaque host references only while those records
remain Node-owned. Snapshot wrappers do not expose a second state writer.

This advances the existing 6b/6c dependency chain. It does not complete the
setTaskState store, saveBestEffort writer or WS host: live records/directories,
member projections, task-state persistence, cursor selection and subscriptions
still need their owners moved. Continue through these dependencies, then remove
temporary addon/host-reference adapters and colocate the native state with WS.
Provider, other route domains and chat orchestration/history persistence remain
open. The four overall acceptance criteria are unchanged; overall remains 5/6.

Before moving task state, include direct history mutation in
`src/classify/state-machine.js` and reset during task deletion in
`src/task-board/lifecycle-host.js`, as well as `src/routes/task-state-store.js`.
The existing `src/session/persistence.js` owns dirty/retry/rollback behavior over
the shared record map. Moving only the setter or adding a second map would leave
these writers outside the owner; close that complete lifecycle in the next batch.

Adversarial verification includes host getter/coercion order, side-effect failure
boundaries, callback reentry, payload identity, replacement/cycle GC, iterable
entry destructuring/cleanup, and raw WS frames. The frozen old transition policy
is isolated from the new implementation. Fingerprint 75e0aa45fc7e721b840389df and
protocol-12 probes are verified; 116 focused tests pass. See gateway.md section 26
for the final regression receipt. No commit, merge, push, production restart or
configuration change has been performed.

Final receipt: real gateway/server and LAN tests pass (2/2). Rust core 424,
CPR 9 + 27 and gateway 30 + 32 pass; the last fix changed only addon iteration,
not those tested crate sources. Full npm test exits 0 from the beginning on the
final artifacts, ending with 256/256. Electron packaging and pwsh each skip one
unavailable-tool case; the existing duplicate-bubble S6 remains TODO, not a pass.
All 49 JS syntax and 49 Rust format checks, 837 test tiers, source budgets,
repository/runtime-write governance and diff checks pass. HEAD remains 1 ahead
and 0 behind main, with 101 uncommitted worktree entries including earlier batches.
Logs and the validation summary are archived under the primary repository's
`data/rust-source/75e0aa45fc7e721b840389df/validation/workspace-state/`.
Validation is on macOS ARM64; other platform packages are not certified here.
No commit, merge, push, production restart or configuration change was performed.
This batch is verified; overall Node exit remains open at 5/6.


## Native session-record owner and persistence batch (2026-11-09)

The live session-record table, its membership order and the whole persistence
lifecycle now have one Rust owner (`native/addon/src/session_records.rs`,
`RustSessionRecords`, with the pure rules in
`native/core/src/session_records.rs`). The Node table is gone: `server.js`
imports the boot-parsed `Map` once through `src/session/records.js` and that
adapter is dropped immediately, leaving a `Map`-shaped facade over the native
owner. There is no second Map and no Node fallback.

Moved into the owner: the dirty/retry/timer state, the transaction snapshot and
rollback, `JSON.stringify` of the record array (host port), the atomic
`sessions.json` write with fsync + parent fsync and `.bak1..3` rotation, the
task-state defaults merge, the `classifyUpdatedAt` stamp rule, the
`task:state-changed` event, chat/workspace broadcast ordering, the
`{save:false}` batching flag and the classify-history window append. The three
direct `taskState` writers are routed through it: task deletion reset
(`src/task-board/lifecycle-host.js`), classify history
(`src/classify/state-machine.js`) and the previously verified read-only DTO copy
(`src/workspace/air-routes.js`).

`src/session/persistence.js` is now a 169-line adapter that only maps native
statuses to `PersistenceError`; `src/routes/task-state-store.js` is a 68-line
port adapter. The deleted Node logic is the 190-line snapshot/save/rollback/
retry implementation and the 50-line store merge/stamp/broadcast body.

Adapters that remain, and why: record objects stay live JS references through
`js_host_value` opaque host slots so every field writer keeps identity and
property order; the facade keeps `instanceof Map` for hosts that check for one;
`stringify`, timers, `bus.emit`, chat/workspace broadcast, `taskStatePayload`
and `now` are host ports because their consumers are still Node. `getTaskState`
and the wire payload therefore read from the native table, never a mirror.

Verification: randomized differential against the frozen Node implementation
under `tests/helpers/legacy-session-records.js` (3 seeds x 1,200 steps =
3,600 operations covering create/update/delete, rollback, nested/async
mutators, manual transactions, best-effort failures, retry timers, `stop()`,
`setTaskState` variants and history appends); disk byte-format comparison with
`StateStore`; legacy bare-array, corrupt-primary, valid-backup and
partial-write fixtures; restart reload; reentrancy; identity and GC. Four
injected faults (no rollback, retry without dirty, unconditional stamp,
two-rung rotation) each fail a test and were reverted. The architecture
boundary allow-list gains `src/session/records.js` for its native core port
(`../native/runtime` only), following the existing `state-transition.js`
precedent; no other module is widened. Both new suites are registered as
core/deterministic, so the reviewed release core moves 392 -> 394 entries,
323 -> 325 deterministic and 364 -> 366 commands, re-audited in
`tests/test-release-version-consistency.js`. The full suite exposed a clock
race in the previous batch's transition differential test (default `now` fell
back to `Date.now()` in two separate milliseconds, ~1 in 19 runs); the test
now pins `Date.now` and passed 15 independent reruns. No product code changed
for it. A second pre-existing flake surfaced only in the full run:
`tests/test-standalone-bundle.js` treated any HTTP answer on `port + 1` as the
launcher walking on, but parallel suites can own that ephemeral port (it saw a
404); it now treats only a 200/503 `/readyz` as a walked-on MultiCC server. The
final full run uses `MULTICC_RUST_PREBUILT_DIR` = the fingerprint directory so
the desktop and standalone staging phases actually execute.

This advances 6b/6c but completes neither. Directory membership projections,
WS/observer delivery, cursor selection, provider and chat orchestration/history
persistence remain open, so no backend-exit acceptance criterion is claimed
complete and the overall ledger stays 5/6.

## Native directory registry and cross-file journal batch (2026-11-09)

The live directory registry, its directories.json persistence and the cross-file
directories+sessions journal now live in the same native owner as the session
records (`native/addon/src/session_records.rs`, `RustSessionRecords`; pure
journal rules in `native/core/src/state_tx.rs`; generalized envelope/rotation
writer in `native/core/src/durable_state.rs`). `src/state/tx.js` is deleted.
A directory delete that cascades sessions is one native transaction: the
`tx-<16hex>.json` journal is written first, both files are replaced atomically
in journal files-array order, and the journal is removed only after both writes
succeed. A crash at any of those steps is recovered by `replayJournals()` with
the same envelope, key order, apply order, rollback-by-replay, quarantine
directory (`broken/<name>.<epoch-ms>`) and log substrings as the deleted Node
implementation.

The Node table is gone. `src/directory/records.js` (102 lines) is a Map-shaped
facade (`instanceof Map`, ordered `get/set/has/delete/clear/keys/values/entries`
and iteration) forwarding to the native registry, and reconstructs the
`CorruptedStateError` the StateStore used to throw at boot. The owner itself is
composed in `src/state/owner.js` (55 lines), created before the state bootstrap
and shared by the session facade, the directory facade, journal replay and the
bootstrap migration. `src/session/records.js` (101 lines) keeps only the
session-record facade; it no longer imports the directory context, preserving
the session bounded-context boundary. `src/directory/repository.js` is a
58-line port adapter, and `src/directory/service.js` passes one
`{kind, reason}` spec to `commitCrossFileWrite` instead of building payload
pairs. Boot order and logs are unchanged: replay journals, load sessions, load
directories, one-time migration import.

Deleted Node logic: `src/state/tx.js` (145 lines: journal encode/apply/replay,
backup rotation call, quarantine), the repository's StateStore wiring and raw
`snapshot()` port, and the service's two-file payload construction/fallback
order. `src/directory/ports.js` drops `snapshot`/`snapshotRecords` and adds
`TX_PORT = ['commitCrossFileWrite']`.

Adapters that remain, and why: git base-branch/push work, filesystem probing,
session destroy cascades, UI-layout enumeration (`listDirIds`/`listSessionIds`
read the native facade), `stringify`/`now`/logger and the test failure seam are
effects on other Node owners, supplied as host ports. Live record objects stay
host references through `js_host_value` so field writers keep identity and
property order. There is no internal JSON round trip: the only serialization is
the host `stringify` at the durable data-file boundary.

Verification: 1,200-step seeded differential against the frozen Node repository
and journal (`tests/helpers/legacy-directory-repository.js`,
`tests/helpers/legacy-state-tx.js`) covering create/update/delete/reorder,
cascade delete through the journalled commit, plain saves, session membership
and restart reload, comparing live tables plus every persisted file and backup
after each step; byte parity with `JSON.stringify(envelope, null, 2)`;
`.bak1..3` rotation; corrupt/missing-envelope/unreadable recovery and
fail-closed `CorruptedStateError`; crash injected before the journal, between
the journal and each file, and during replay (resume after a partial replay);
malformed/unreadable journal quarantine; restart counts/order/content hashes;
reentrancy; facade identity and GC; failed write leaving the previous primary
intact. Five injected faults were each caught by a durable/differential test and
reverted: journal not removed after commit; sessions file entry omitted from the
cross-file commit; rolling-backup rotation disabled; replay order reversed;
malformed journal not quarantined.

The full suite exits 0 on the final artifacts: 27 Node test runs, 6,519 tests,
6,516 passed, 0 failed, 2 skipped (Electron tooling, pwsh) and the pre-existing
S6 TODO. Focused state/architecture/release suites: 46 passed. Cargo workspace:
640 passed, 0 failed. New Rust files pass `rustfmt --check`; clippy exits 0 with
no warnings on the new code (the repository's pre-existing warnings remain in
untouched code). Test tiers: 841 classified, core 396 / deterministic 327 /
isolated 38; release-count audit 368 commands / 365 Node entries. Source line
budget OK (known `public/run-config.js` migration debt unchanged);
`git diff --check` clean.

Known behaviour difference: a damaged state file now raises a reconstructed
`CorruptedStateError`; the class, `file`, `raw` excerpt and stable message
prefixes are preserved, but a JSON parse failure omits V8's `: <parser detail>`
suffix and an unreadable file omits the OS error suffix. No other intentional
difference; save/recovery bytes are tested equal.

Fingerprint `924e3f9a565f72eeafb183e7`;
logs are archived under the primary repository's
`data/rust-source/924e3f9a565f72eeafb183e7/validation/directory-persistence/`.
Validation is on macOS ARM64; other platform packages are not certified here.
No commit, merge, push, production restart or configuration change was performed.
This batch advances 6b/6c but completes neither: WebSocket/observer delivery,
cursor selection, provider and chat orchestration/history persistence remain
open, so no backend-exit acceptance criterion is claimed complete and the
overall ledger stays 5/6.

## Native workspace subscription and WebSocket host batch (2026-11-09)

`/ws/workspace` and non-air `/ws/meta` now terminate in one native subscription
owner instead of the Node router. The owner is split between
`native/core/src/workspace_sockets.rs` (658 lines, pure subscription/queue state)
and `native/addon/src/workspace_sockets.rs` (719 lines, napi host). It owns the
per-directory client registry, the meta fleet, per-socket heartbeat
bookkeeping, the recent-event ring (capacity 200, hydrated lazily from
`events/<dirId>.jsonl`), snapshot assembly, replay, broadcast fan-out,
observers, and the bounded per-socket send queue with coalescing.
`src/workspace/runtime.js` is now a 290-line facade that offers the live tables
and stateless effects as host ports.

Why the gateway does not terminate these two paths: the owner needs the live
record/directory/chat-session projections, and those tables are opaque host
references (`napi_ref`) held by the addon inside the Node process. The gateway
is a separate Rust process and cannot reach them; moving the listener would
require a second owner or a mirror table, both excluded by the exit criteria.
The chosen closest design keeps one owner in the addon and one narrow port:
each broadcast is encoded once by `prepare` and handed to `publish`; the owner
calls back only for stateless effects (`sendFrame`, `schedule`,
`cancelSchedule`, `disconnect`, `metric`, `backpressureLog`, `ping`,
`terminate`, `close`), for projections (`workspaceSnapshot`, `recentEvents`,
`queueSnapshot`, `mergeState`, `setTaskState`, `saveBestEffort`) and for the
host clock. No per-client JS objects, mirror Maps or internal JSON round trips
remain.

The wire contract is unchanged: same URL parameters; auth precedence still runs
in the router before attach (ticket, legacy cookie/token, locality and
share-scoped access); same close codes/reasons; snapshot
`{type,dirId,sessions,events,queues,apiVersion}` and
`{type,fleet,apiVersion}` with identical key order; same replay cursor and
event payload bytes; the shared 30s router clock drives the native heartbeat
(`missed >= 3` → terminate); and the frozen `src/ws-backpressure.js` thresholds
are reproduced (1 MiB high water, 2 MiB queue + 8 MiB frame ceiling, 4096
messages, 15s congestion timeout, 25ms retry, 1013 `slow client; reconnect to
resync`). `air=1` meta keeps the air protocol and therefore the router's own
heartbeat and backpressure.

Deleted Node logic: the runtime's `clients`/`metaClients`/`observers`/`status`/
`summaries`/`queueStatuses` maps and its attach/broadcast/heartbeat/queue
implementations (the frozen 297-line oracle is
`tests/helpers/legacy-workspace-runtime.js`); the notes-store `eventRing`
(last-200 array, JSONL adapter retained); and the router's per-workspace-socket
heartbeat/backpressure installation. `src/ws-backpressure.js` still serves
every other WS path unchanged.

Remaining adapters and why: WS admission, tickets, locality and `heartbeat.fields`
stay in the router because they gate all WS hosts; the 30s loop stays there and
calls `tickHeartbeat()` once per interval; projections are owned by Node domain
tables and supplied as host ports; timer/transport/log/metric effects are host
ports. Serialization occurs only when a WebSocket frame is produced.

Verification: 57 focused Node tests pass (`test-workspace-runtime.js` 27,
`test-workspace-ws-native.js` 10, `test-ws-connection-router.js` 20): raw
frames are byte-identical for connect/snapshot/events/reconnect/unknown
directory/meta; observers, unsubscribe and throwing listeners match; directory
removal mid-connection matches; a 1,200-step seeded randomized connection+event
differential passes after every step; native heartbeat windows match the frozen
router loop; the native queue matches the frozen module for coalescing, byte
ceiling, message tripwire, congestion timeout and send errors; the event ring
hydrates the last 200 lines, appends, caps and fans out. The isolated
`tests/test-workspace-ws-isolated.js` starts the real gateway and `server.js`
on a temporary data root and checks loopback and LAN snapshots, meta fleet,
reconnect, unknown-directory close 1005, a denied external client (4003 with no
frame), and token-bearing LAN clients. Four injected faults were each caught
and reverted: snapshot sent before external auth; replay off-by-one (199 vs
200); missed-pong threshold 2 instead of 3; congestion timeout disabled.

Cargo workspace: 651 passed, 0 failed. New files pass `rustfmt --check`; clippy
for `multicc-core`/`multicc-addon` exits 0 with no warning in the new code (the
repository's pre-existing warnings and the pre-existing `multicc-cpr` clippy
error remain untouched). The full suite exits 0 on the final artifacts: 27 Node
test runs, 6,532 tests, 6,529 passed, 0 failed, 2 skipped (Electron tooling,
pwsh) and the pre-existing S6 TODO. Test tiers: 843 classified (core 398:
deterministic 328 / isolated 39 / flutter 31); the release-count audit is
re-audited to 370 commands / 367 Node entries. Source line budget OK (known
`public/run-config.js` migration debt unchanged); `git diff --check` clean.

Final fingerprint `38aed0355a7b1cfa773b1340`; logs are archived under the
primary repository's
`data/rust-source/38aed0355a7b1cfa773b1340/validation/workspace-ws/`. The
gateway/addon control protocol is unchanged (12), so no coordinated deployment
is required. No intentional behaviour difference was found on the wire; the
owner reads the host clock only at/above high water, exactly where the frozen
queue called `Date.now()`. This batch advances 6b/6c but completes neither:
`/ws/chat`, terminal, voice/tts/aux/remote-screen still terminate in Node, and
chat orchestration/history persistence remain open, so no backend-exit
acceptance criterion is claimed and the overall ledger stays 5/6.

## Native chat-session table and turn runtime owner batch (2026-11-09)

The live `chatSessions` table and the per-session turn runtime store now belong
to the same native owner as the persisted session table (`RustSessionRecords` in
`native/addon/src/session_records.rs`; pure rules in
`native/core/src/chat_runtime.rs`, 491 lines). The Node `Map` is gone: `server.js`
creates the facade once from the process owner, and every membership call
forwards to Rust. There is no second Map and no Node fallback lane.

Owner state moved into Rust: chat-table membership and insertion order, and the
per-session runtime record (`sessionId`, `turnId`, `phase`
idle/preparing/running/finishing, `generation`, `cli`, `transport`,
`messageDurable`, `providerRouteResolved`, `claimedAt`, `startedAt`,
`finishingAt`, `lastOutcome`, `pendingOutcome`) plus the provider-route proof
and its validity rule (`kind === 'provider-route'`, `resolved === true`, frozen
proof and frozen route, matching session/turn, runtime epoch, decision id, route
attempt id, provider id, protocol, model, provider revision, positive
`routeGeneration`, positive `attemptNo`). The transition set is
claim → markMessageDurable → markProviderRouteResolved /
providerRouteFailed / abortPreparation → start → settle / beginCleanup →
cleanup, with `claimProof`, `snapshot` and `list` reads. Failure codes are
unchanged: `invalid_identity`, `turn_in_flight`, `stale_turn`,
`invalid_transition`.

What stays as live host references (never mirrored, never serialized inside the
process): the per-session `cs` objects themselves — child process handles,
timers, client sets, streaming buffers — held as opaque `js_host_value` slots
with weak anchors and retired-slot GC, so `chatSessions.get(name) === cs` identity
checks, property order and later field mutation all keep working; the frozen
provider-route proof object, whose `Object.isFrozen` state is read through the
live value; and the clock callback (`Date.now` or a test clock). Serialization
only happens at WS/HTTP frames outside these two owners.

Deleted Node logic: `const chatSessions = new Map()` in `server.js`;
`src/chat/runtime-store.js` shrank from 205 to 65 lines. Removed there: the
`sessions` Map, `current/match/result`, `clone/freezeRecord`,
`ownsConcreteRouteProof`, all thirteen transition bodies and the
`transportOf` default resolution; the module now forwards `claim`,
`markMessageDurable`, `markProviderRouteResolved`, `providerRouteFailed`,
`abortPreparation`, `settle`, `start`, `beginCleanup`, `cleanup`, `claimProof`,
`snapshot` and `list` to the native owner.

Adapters that remain, and why: `src/chat/sessions.js` (63 lines) is a Map-shaped
facade because hosts call the Map API and one checks `instanceof Map`; it keeps
no table of its own. `src/chat/runtime-store.js` is the store adapter used by the
turn engine. Clock ordering is reproduced exactly from the frozen store:
claim/settle/cleanup read `now()` before publishing, while start/beginCleanup
mutate the record in place before reading it, so a re-entrant clock observes the
same intermediate sequence (`idle`, `running`, `finishing`, `finishing`). Every
native result returns a frozen object with frozen `lastOutcome`/`pendingOutcome`,
and route proofs are validated from lifted facts against the live object's
frozenness.

Frozen oracles: `tests/helpers/legacy-chat-runtime-store.js` (207 lines) and
`tests/helpers/legacy-chat-sessions.js` (37 lines), the latter pinning the exact
`cs` field order used by both construction sites in `src/chat/turn-engine.js`.

Verification: `tests/test-chat-runtime-native.js` runs a seeded 1,200-step
differential over claim/route-proof/durable/start/settle/beginCleanup/cleanup/
claimProof/snapshot/list plus chat-table mutations, comparing every return value
and stored snapshot after every step; the picks stick to one session/turn pair
65% of the time so complete lifecycles are actually walked. It adds a scripted
200-round lifecycle that publishes every transition and checks promotion of
`pendingOutcome` to `lastOutcome`, a route-proof validity matrix, a clock
callback that re-enters reads, 1,500 host-value identity/drain/delete/re-create
operations, and a turn store that survives chat-session deletion. 6 tests pass.
`tests/test-chat-turn-core.js` still passes all 55 tests. The isolated
`tests/test-chat-turn-isolated.js` starts the real gateway and `server.js` on a
temporary data root with a fake Claude CLI over loopback WebSockets: connect →
send → stream → result; disconnect mid-stream and reconnect with replay of the
in-flight delta; cancel mid-stream with the task-shell `clientMsgId`+`turnId`
control (SIGTERM observed) followed by a fresh CLI on the next turn; and a
running task-bound session whose room/task deletion is refused
(`TASK_HISTORY_REFERENCED`, `task_busy`), whose live frames survive both refusals,
and which is then cancelled and deleted. Four injected faults each fail a test
and were reverted: `pendingOutcome` never promoted to `lastOutcome`; a stale
turn id accepted; cleanup leaving the active turn in place; and turning the
published state object mutable.

Cargo workspace: 658 passed, 0 failed. New Rust files pass `rustfmt --check`;
clippy for `multicc-core`/`multicc-addon` exits 0 with no warning in the new code
(the repository's pre-existing warnings and the pre-existing `multicc-cpr`
clippy error remain untouched). Test tiers: 845 classified (core 400:
deterministic 329 / isolated 40 / flutter 31); the release-count audit is
re-audited to 372 commands / 369 Node entries. Source line budget OK (known
`public/run-config.js` debt unchanged); `git diff --check` clean.
The full suite exits 0 on the final artifacts with
`MULTICC_RUST_PREBUILT_DIR` pointing at the fingerprint directory: 27 Node test
runs, 6,538 tests, 6,535 passed, 0 failed, 2 skipped (Electron tooling, pwsh) and
the pre-existing S6 TODO. The first full runs exposed a pre-existing quadratic
fixture scan in `tests/test-server-processes.js`: every process in a table was
checked against a freshly re-read table (about 800 processes x ~40ms), putting
the status fixture at 29.5s against its 30s timeout. Both call sites now share
one snapshot per poll (status fixture 29.5s -> 0.5s); no product code changed.

Final fingerprint `a3602df1ed46dc45bf04277e`; logs are archived under the
primary repository's
`data/rust-source/a3602df1ed46dc45bf04277e/validation/chat-sessions/`. The
gateway/addon control protocol is unchanged (12), so no coordinated deployment
is required. No intentional behaviour difference was found; the only
semantic-looking change is that id trimming for `claim` now lives in the pure
core rule instead of only in the addon wrapper, which is exactly what the frozen
store did (`String(id || '').trim()`). This batch advances 6d but completes
nothing: CLI supervision, streaming, cancellation escalation, finalize/background
effects, provider selection and history persistence remain in Node, so no
backend-exit acceptance criterion is claimed and the overall ledger stays 5/6.

## 6d chat orchestration: Claude per-event reducer (2026-11-09)

The per-event application logic of the Claude chat lane now lives in Rust.
`native/addon/src/chat_events.rs` exports
`chatApplyClaudeEvent(cs, sessionName, evt, forward, turn, runner, providerName,
ports)`; `src/chat/turn-engine.js` keeps a 22-entry `nativeChatEventPorts` object
and a three-line wrapper, and nothing else. `applyAdapterChatEvent`,
`runAdmittedChatTurn`, `runChatTurnStreaming`, `finalizeStreamingTurn` and
`handleChatWs` are untouched: only the Claude event path moved, and
`applyAdapterChatEvent` (adapter-neutral chat contract) is explicitly deferred to
a later 6d step.

Order of operations inside the reducer is byte-faithful to the frozen legacy
implementation. Gate `ports.isCurrent` → `ports.scrub(attempt, evt)` →
`ports.touchActivity` → `ports.observeClaude` → API-error intercept →
assistant content blocks → user tool_result normalization → result handling →
system init/task passthrough → final `forward(evt)`.

API-error intercept reproduces the runner-scoped `apiErrorState`: a key built
from uuid/requestId/body is deduped through a JS `Set` (`Drop`), the pending
record carries `text/httpStatus/cliError/requestId/key/appended/bodyBefore`, and
the mode is `Append` when the accumulated assistant text and tool list are
empty, otherwise `Suppress`; `recoverPendingEvent` consumes the recorded body
before the next real assistant message. Assistant text appends with
`String(v || '')` semantics and hosted redaction (`markHostEnvelope`/scrub are
still host ports); `tool_use` records name/input/id/startedAt into
`currentToolCalls`, updates phase (editing/running/thinking), session status,
background tool-use ids and TaskOutput awaiting. `user` events rewrite
tool_result content: a string is redacted as-is, `null`/`undefined` go through
`JSON.stringify(content == null ? '' : content)` (`'""'`), arrays are split into
one text block plus preserved non-text blocks, and the matching tool call gets
`result`/`is_error`/`endedAt` plus its output preview. `result` applies the
pure `completion`/`compatible` rules, records durable usage only when
`persistFinal` reports durable, constructs the synthetic assistant message
(role/content/tools/cost/usage/ts/contextTrace/turnTimings) with
`resultEvent: true`, forwards the constructed result frame
(total_cost_usd/usage/durationMs/num_turns/contextTrace/modelAttribution/
timelineField), calls `onTurnComplete`, and then falls through to the raw
result forward exactly like the original. Stale turn/runner is a no-op at entry
and re-checked after `persistFinal`/`recordDurableUsage`.

Pure helpers and their unit tests live in `native/core/src/chat_events.rs`
(162 lines, 7 tests): `status_of`, `api_error_key`, `is_error_only`,
`envelope_body`, `pick_http_status`, `has_result_output`, `is_api_failure`.
The addon file is 1,094 lines including the exported entry point.

Deleted Node logic: 150 lines of `applyClaudeChatEvent` (branch order,
redaction, API-error state machine, tool/result framing) with 32 lines added for
the port table and wrapper. The 22 ports are effects still owned by Node: turn
currency (`isCurrent`), structural scrubbing (`scrub`), activity/phase/status
heartbeat, Claude observation, reported-model attribution, incremental-save
scheduling/clearing, background tool-use id and TaskOutput awaiting, context
trace, chat-session mapping check, final persistence + durable usage recording,
proxy failure lookup, usage-limit completion, model-attribution/timeline/timing
fields, host error-envelope marking, and the logger.

Frozen oracle `tests/helpers/legacy-claude-chat-event.js` (284 lines) is the
byte-exact prior implementation. `tests/test-chat-events-differential.js`
(561 lines, 7 tests) compares the complete ordered effect log, `cs` snapshot,
persisted state and turn/runner snapshots after every event, with a custom
serializer that preserves `undefined`, `NaN`, `-0`, lone surrogates and
property order, and try/catch parity (both throw or neither). Volume: 1,200
seeded randomized/perturbed sequences, a 200-sequence second fuzz pass, 8
adversarial single events (structured 429, lone surrogate, >200 KB text, 5,000
char tool_result, result with/without completion, undefined model, null type),
stale turn/runner, throwing host ports, a re-entrant clock/port call, and the 8
real captured traces under `/tmp/claude-lane-capture/real`
(raw nowait/wait, init error, lifecycle, interrupt, background, hook error,
resume).

`tests/test-chat-events-isolated.js` (330 lines) starts the real `multicc-gateway`
and `server.js` on a temporary data root with a copied fake Claude CLI and one
WebSocket client (7 sections): stream→result with history persistence;
tool_use→tool_result normalization (Edit, `toolu_evt_1`, `patched`) and tool-id
persistence; background task_started/task_notification outliving the turn;
API-error append-once dedupe per process uuid; API-error suppression after real
output (zero error assistant frames in the first attempt, sliced by
`messageTurnId`); interrupted result without a `result` key (partial surfaced,
no literal `undefined` persisted, session stays usable); and reconnect replay of
an in-flight delta followed by the settled result. `npm test:core` and
`npm test:integration:isolated` both include their test.

Injected mutation faults, each verified to fail and then reverted: (1) API-error
dedupe disabled — two differential suites fail; (2) completion detection forced
to "has output" — randomized differential fails; (3) completed result returns
early instead of falling through — randomized, fuzz, adversarial and real-trace
differential tests fail; (4) API-error append/suppress polarity flipped to
always-suppress — differential fails and the isolated append section times out;
a fifth flip to always-append also fails the randomized, fuzz and adversarial
differential tests. The restored tree rebuilds to fingerprint
`996ccf0a8e4c8917bc4a4f43` and both suites pass again.

Rust workspace: 665 passed, 0 failed. New Rust files pass `rustfmt --check`; clippy
for `multicc-core`/`multicc-addon` reports no warning in `chat_events.rs`
(the repository's pre-existing warnings remain untouched). Test tiers: 847
classified (core 402: deterministic 330 / isolated 41 / flutter 31); the
release-count audit is re-audited to 374 commands / 371 Node entries. Source
line budget OK (known `public/run-config.js` debt
unchanged); `git diff --check` clean. Full `npm test` on the final artifacts
exits 0: 6,545 tests, 6,542 passed, 0 failed, 2 skipped (the local Electron
desktop toolchain is not installed; `pwsh` is unavailable) and 1 pre-existing S6
`# TODO`, with `MULTICC_RUST_PREBUILT_DIR` pointing at the fingerprint directory.

Fingerprint `996ccf0a8e4c8917bc4a4f43`; logs are archived under the primary
repository's
`data/rust-source/996ccf0a8e4c8917bc4a4f43/validation/chat-events/`. The
gateway/addon control protocol is unchanged (12), so no coordinated deployment
is required. No intentional behaviour difference was found. This batch advances
6d but completes nothing: adapter-neutral event application, CLI supervision,
streaming/finalize/background effects, provider selection, history persistence
and WS handling remain in Node, so no backend-exit acceptance criterion is
claimed and the overall ledger stays 5/6.

## 6d chat orchestration: adapter-neutral event reducer (2026-11-09)

The adapter-neutral reducer `applyAdapterChatEvent` now lives in Rust beside the
Claude reducer. `native/addon/src/chat_events.rs` exports
`chatApplyAdapterEvent(provider, cs, persisted, sessionName, rawEvent, forward,
turn, runner, ports)`; `src/chat/turn-engine.js` keeps a one-line wrapper, and
the 259-line decision/mutation body is gone (12 lines added for the wrapper and
the eight new port entries). Every non-Claude lane reaches this reducer through
its own `provider.decodeEvent`: codex, codex-exp, opencode/opencode-like, kimi,
pi, zcode, commandcode and acp.

Order is byte-faithful to the frozen implementation. Entry: turn/runner currency
(`isCurrent`) -> `ports.touchActivity(session, turnId)` ->
`ports.decodeEvent(provider, rawEvent)` -> null/undefined becomes `[]`, and a
non-array is wrapped -> `runner.completion.observe(rawEvent, list)` exactly once
-> per-event reduction. Per event: falsy skip -> `ports.scrub(providerAttempt,
evt)` -> `ports.observeAdapter(cs, evt)` -> dispatch in the frozen order:
`claude_event`, `session_init`, `native_session_missing`, `session_started`,
`status`, `activity`, `user_input_signal` (records host input, then falls
through as `assistant_text`), `assistant_text`, `tool_start`, `tool_result`,
`tool_update`, `thinking`, `complete`, `error`.

The nested `claude_event` branch hands its raw frame straight to the existing
native Claude reducer `apply_claude_event` in the same process: no JS round
trip and no re-serialization. Session handling uses the new pure core
`capture_session_id`/`CaptureSessionId` (unchanged/changed vs mismatch); a
resume that would move the logical chat onto different native history kills the
process and calls `finishProviderAttempt` with `cli_resume_mismatch` or
`native_resume_mismatch` (the addon gained `chat_turn_effects::assign_kill_reason`
and the `chatAssignKillReason` export). `complete` computes completion with the
existing CLI rules, forwards the result frame and closes the provider attempt;
`error` reuses `api_error_policy::detect_error_envelope`, `is_error_only_text`,
`api_error_text::sanitize` and `redaction::redact_route_capability`, keeps
transport/response disconnect kinds distinct, and logs through the
`consoleWarn`/`consoleLog` ports.

Ports: the shared `nativeChatEventPorts` table now has 29 entries; this batch
adds eight adapter-only ones: `observeAdapter`, `decodeEvent`,
`rememberActiveCliState`, `savePersistedSessions`, `finishProviderAttempt`,
`recordUserInput`, `consoleWarn`, `consoleLog`. They stay host ports because
they own Node-side state or effects: adapter wire parsing (`decodeEvent` is
per-provider by design), CLI-state persistence, provider-attempt bookkeeping,
session-work `recordInput` and the logger. `isCurrent`, `scrub`,
`touchActivity`, phase/status, incremental save, completion and all result
fields stay on the same table shared with the Claude lane.

Deleted Node logic: 259 lines from `applyAdapterChatEvent` (turn gating, decode
shape handling, session capture/mismatch, status/activity/phase mutation,
assistant text accumulation and envelope marking, tool start/result/update
framing, thinking spans, completion and structured error handling). The addon
file is now 2,044 lines (+970/-20); `native/core/src/chat_events.rs` is 244
lines (+82, now 9 unit tests) and `chat_turn_effects.rs` gained the kill-reason
helper (+9/-4).

Frozen oracle `tests/helpers/legacy-adapter-chat-event.js` (319 lines) is the
byte-exact prior implementation. `tests/test-chat-adapter-events-differential.js`
(570 lines, 6 tests) drives both reducers from identical state with identical
wire events and compares, after every event, the complete ordered host-effect
log, `cs`/persisted/turn/runner snapshots and forwarded frames, using a custom
serializer that keeps `undefined`, `NaN`, `-0`, lone surrogates and property
order, and requires both sides to throw or neither. Volume: 18 fixture
sequences (9 adapter kinds x 2 handoff states), 1,080 seeded randomized
sequences (9 x 120), 2,000 perturbed sequences (1,000 codex + 1,000 opencode),
24 decode-shape/stale/re-entrant/throwing-port cases (null/undefined/single/
object/throwing decoders and 13 throwing ports), 4 lone-surrogate/large-event
sequences and 8 session-capture/mismatch cases.

`tests/test-chat-adapter-events-isolated.js` (232 lines) starts the real
`multicc-gateway` and `server.js` on a temporary data root and drives fake codex
and opencode CLIs over `/ws/chat`: assistant text, tool result, tool card and a
return to idle for both lanes; the opencode fake uses the legacy `--format json`
shape shared by the opencode-like decoders. `npm test:core` and
`npm test:integration:isolated` include both tests; `tests/test-chat-turn-core.js`,
`tests/test-turn-timeline.js` and `tests/test-api-error-host-wiring.js` were
updated to assert the native port wiring instead of the deleted JS body, and
`tests/test-release-version-consistency.js` re-audits the two new core entries.

Injected mutation faults, each verified to fail and then reverted: (1)
`runner.completion.observe` skipped; (2) decoded array order reversed; (3) the
`claude_event` branch bypassed; (4) the result frame double-forwarded. All four
fail the differential test; the restored tree is pristine and rebuilds to the
same fingerprint.

Rust workspace: 667 passed, 0 failed. The three changed Rust files pass
`rustfmt --check`; clippy for `multicc-core`/`multicc-addon` reports no warning
in them (repository pre-existing warnings remain untouched). Test tiers: 849
classified (core 404: deterministic 331 / isolated 42 / flutter 31). Source line
budget OK (known `public/run-config.js` 3,289->3,000 debt unchanged); `git diff
--check` clean. The release-count audit is re-audited to 376 commands / 373 Node
entries. Full `npm test` on the final artifacts exits 0: 6,551 tests, 6,548
passed, 0 failed, 2 skipped (the local Electron desktop toolchain is not
installed; `pwsh` is unavailable) and 1 pre-existing S6 `# TODO`, with
`MULTICC_RUST_PREBUILT_DIR` pointing at the fingerprint directory.

Fingerprint `ff074b05f79d46170eb6b680`; logs are archived under the primary
repository's
`data/rust-source/ff074b05f79d46170eb6b680/validation/chat-adapter-events/`. The
gateway/addon control protocol is unchanged (12). No intentional behaviour
difference was found. This batch advances 6d but completes nothing: CLI
supervision, streaming/finalize/background effects, provider selection, history
persistence and WS handling remain in Node, so no backend-exit acceptance
criterion is claimed and the overall ledger stays 5/6.

## 6d chat orchestration: turn finalization planner (2026-11-09)

The pure finalize planner now lives in Rust. `src/chat/finalize-plan.js` is a
58-line host wrapper (+18/-402, down from 442 lines) around six new addon
exports; `native/core/src/chat_finalize.rs` (1,401 lines, 7 unit tests) holds
every decision and `native/addon/src/chat_finalize.rs` (190 lines) moves values
across the lossless bridge and preserves the two host identities consumers rely
on.

Shape: one frozen plan per turn, `{action, code, facts, retry, append, effects}`,
with actions `noop`, `continue-codex`, `retry-api`, `retry-fresh` and
`finalize`. `facts` is the ordered evidence record. `effects` is the ordered
host-effect list; `resolveTurnFinalization` appends the close sequence
(set-streaming false, cancel-classify for streams, clear-stream-replay, optional
failure reports, append-assistant-result plus increment-chat-turn-count,
conditional commit-usage, capture-final-text, reset-turn-output, the
status/classify/turn-end effects, stream-end, run-post-turn and
clear-active-runner). The host applies them in exactly that order and never
re-decides.

Reuse: fresh-start and codex-disconnect retries go through the existing
`retry_policy::decide`; finality reuses the evidence contract of
`decideChatRunnerFinality` inside `chat_turn_lifecycle`; completion uses the
`cli_completion` rules; the API-error decision object is produced by the
existing API-error policy and passed through by identity; object helpers come
from `quota_guard`. No second copy of these rules was added.

Host ports kept in Node: process kill/await and stream close, timers, WS frame
send, history append (the two-stage append boundary that needs the persisted
result), provider-attempt finish, background-task runtime and the logger.
`finalize-host.js` is now a pure executor: its switch only maps native effect
types to those ports. `commitAdapterResult` and `finalizeStreamingTurn` keep
their host orchestration but consume `planTurnFinalization` /
`resolveTurnFinalization`; the retry-availability replan calls
`planRetryBlockedFinalization`.

Deleted Node logic: the whole 402-line decision body of `finalize-plan.js`
(fact assembly, process-exit classification, handoff normalization and guard,
retry scheduling and effects, finality classification, append boundary
selection, the status/turn-end effect table and resolution ordering). No mirror
state and no fallback remain.

Oracle and differential coverage: `tests/helpers/legacy-chat-finalize-plan.js`
(412 lines) is the frozen prior implementation.
`tests/test-chat-finalize-differential.js` (319 lines, 5 tests) compares plans,
facts, effects, append flags and resolved outputs byte-for-byte through a
serializer that preserves `undefined`, `NaN`, `-0`, lone surrogates and property
order: 1,200 seeded randomized plan+resolve cases (plus a blocked-retry replan
for every scheduled action), a 22-case branch table that reaches all five
dispositions with four outcomes each, 400 randomized
classification/handoff/guard triples, freezing and identity checks
(`plan.retry === apiErrorDecision`, resolved `facts`/`append` reuse), and host
clock sampling (0 calls on finalize, exactly 1 on a scheduled retry, a throwing
clock surfaces only when sampled).

End-to-end: `tests/test-chat-finalize-isolated.js` (336 lines) starts the real
`multicc-gateway` and `server.js` on a temporary data root with a fake Claude
CLI and drives `/ws/chat`: clean completion with `stream_end`, non-zero exit
without a result, zero exit without a result, a queued follow-up turn while a
turn is running (the follow-up is claimed after the running turn and the
running CLI is not killed), and a mid-stream cancel (SIGTERM reaches the CLI,
the task freezes as `user_cancelled`, and a fresh turn claims the session
afterwards). A new user message on this path queues rather than supersedes;
stale and superseded runner dispositions are covered by the differential
noop/supersede cases instead.

Existing `test-chat-finalize-plan.js`, `test-chat-finalize-host.js`,
`test-chat-host-coordinator.js` and `test-chat-turn-core.js` keep passing;
`test-chat-turn-core.js` only had two source-pattern assertions retargeted from
the deleted JS file to the Rust source, without weakening assertions.

Injected mutation faults (each failed the differential test and was reverted):
(1) allowing a fresh retry after a user stop (1 failing test); (2) inverted
stream finality when the result event is missing (2); (3) `stream-end` emitted
before the status effects (2); (4) dropping the partial flag on the append
boundary (2).

Rust workspace: 674 passed, 0 failed. The new files pass `rustfmt --check`
(with `skip_children` so unrelated modules stay untouched) and clippy reports
no warning in them; repository pre-existing warnings remain untouched. Test
tiers: 851 classified (core 406: deterministic 332 / isolated 43 / flutter 31).
Source line budget OK (known `public/run-config.js` 3,289->3,000 debt
unchanged); `git diff --check` clean.

Full `npm test` against the final artifacts (the built addon at the fingerprint
below, loaded through `MULTICC_RUST_ADDON` and `MULTICC_RUST_PREBUILT_DIR`)
exits 0: 6,556 tests across 27 node:test summary blocks, 6,553 passed, 0
failed, 2 skipped, 1 todo. Both skips and the todo are pre-existing
environment gates (no desktop/electron-builder toolchain, no `pwsh`, and the
existing S6 duplicate-bubble nudge case) and are unrelated to this batch. An
earlier full run failed exactly once in
`tests/test-release-version-consistency.js` because adding two tests changed
the audited release core set (404 -> 406 reviewed entries, 378 planned
commands); the audit was re-reviewed and updated, and the rerun is green.

Fingerprint `b503d884fb354b58996e049a`; logs are archived under the primary
repository's
`data/rust-source/b503d884fb354b58996e049a/validation/chat-finalize/`. The
gateway/addon control protocol is unchanged (12). Known behaviour difference:
the napi bridge reads the whole planner input eagerly, so getters on keys the
planner never uses run earlier than in the lazy JavaScript planner; production
call sites pass plain object literals. A resolved plan's `result` object is now
also frozen (it is a contained value only). This batch advances 6d but completes
nothing: CLI supervision, the remaining streaming/background effects, provider
selection, history persistence and WS handling stay in Node, so no backend-exit
acceptance criterion is claimed and the overall ledger stays 5/6.

## Auto Provider attempt budget and failover stop list (2026-11-09)

Auto Provider used to stop after a fixed number of physical attempts: the Rust
contract capped `maxAttempts` at 4, defaulted it to 3, and the JS runtime
compared that value in `select()`, `planTurn()` and the handoff hop guard. Two
lines therefore meant one switch, and a third failure ended the turn. The
budget is now derived, not configured.

### Budget

- `auto_provider_config.rs` normalizes `maxAttempts` to the number of enabled
  candidates in the pool (all lanes). A legacy stored or wire value of 2..4 is
  still accepted and validated (the accepted range is 2..=max(4, enabled
  count), so a stored 3 or 4 with a two-line pool keeps validating) but the
  normalized value is always the count, so it never caps a turn. The `facts().maxAttempts = 4` field stays as the legacy wire ceiling for
  clients that still render a 2..4 control.
- `run_config_presets.rs` derives `maxAttempts` from the preset's candidate
  list instead of clamping to 4.
- The runtime loop is bounded by the enabled pool and by the `attempted` set:
  a candidate that failed once in the turn is never selected again. Reaching
  the bound after all enabled lines were tried reports
  `auto_candidate_pool_exhausted`; `auto_attempt_budget_exhausted` remains only
  as a defensive guard for pools whose expanded variants share a provider id.
- Web (`public/run-config.js`, `public/auto-provider-editor.js`) and Flutter
  (`run_config_wire.dart`, `run_config_sheet_auto.dart`) no longer offer a
  2/3/4 choice; they display the derived pool size and send it on the wire.

### Stop list

A failure switches to the next candidate unless one of these conditions holds.

| Condition | Reason code | Why it terminates instead |
| --- | --- | --- |
| Category `cancel_shutdown` | `category_not_failoverable` | User stop, restart or shutdown; a replay would be wrong. |
| Category `context_token_limit` | `category_not_failoverable` | The request is too large; every line would refuse it. Compact first. |
| Category `tool_protocol` | `category_not_failoverable` | Our tool call is malformed; replaying it reproduces the error. |
| Unsafe replay phase (partial output, side effects, streaming) | `unsafe_replay_boundary` / `unsafe_failure_phase` | Replay safety. `prepareHandoff` turns it into one fresh continuation turn on another reserved route. |
| Replay fence closed (visible output, tool intent, side effect observed) | `provider_replay_fence_closed` | Same: the handoff reservation carries the task forward instead of replaying. |
| Live background tasks for the session | `auto_background_tasks_active` | The background work belongs to the current lane; switching would orphan it. |
| No eligible candidate left | `auto_candidate_pool_exhausted` | All enabled lines were tried or are known exhausted. |
| Fewer than two enabled candidates | config validation | A pool cannot fail over with one line. |

Everything else switches. Exhausting the same-provider API retry budget
(`retry_budget_exhausted`) or the request budget
(`request_budget_exhausted`, including `retryBudgetExhausted` and
`model_request_deadline`) is explicitly a switch trigger: the fail-fast answer
ends same-provider retries, and the Auto policy then moves to the next line.
A failure that arrives with no classified api-error decision (opaque CLI crash,
non-zero exit, watchdog kill) is treated as `failover_unknown`, still behind
the replay fence. `adapter_configuration` is no longer a non-failover category:
a spawn failure or provider-specific configuration error is exactly what
another line can recover from.

Rust unit tests cover the derived budget (`auto_provider_config`), preset
clamping (`run_config_presets`) and the stop list plus missing-decision and
spent-budget failover (`auto_provider_policy`). JS tests cover a five-candidate
turn whose first four failures are rate limit, billing quota, network and HTTP
4xx before the fifth succeeds, an all-fail turn that only terminates after all
five, a legacy `maxAttempts: 2` no longer capping a three-line pool, and a
cross-lane handoff reservation.

## Session default model is Rust-owned (2026-11-09)

The default model of a session used to come from the terminal's own config:
`claudeDefaultModel()` parsed `~/.claude/settings.json` (`model`, then `env`),
and `codexDefaultModel()` parsed `~/.codex/config.toml`. A ccswitch-style tool
that rewrites those files therefore redirected MultiCC sessions too — on the
official Claude account this surfaced as
`There's an issue with the selected model (deepseek-flash)`.

Selection now lives in `native/core/src/model_default.rs` (addon owner
`RustModelDefaults`, probed by `scripts/rust-source-cache.js`); Node keeps the
host-port assembly in `src/cli/model-default.js`. `src/cli/session-policy.js` only
resolves the lane facts and passes them in: the provider summary, the lane's
picker list, the last model the CLI reported and the explicit-selection history.

Rule (one implementation, no dual path):

1. An explicit `session.model` and a provider-pinned `provider.model` behave
   exactly as before (provider aliases still resolve through `aliasMap`).
2. Otherwise the model the user selected most often on that lane wins. History
   is the explicit `session.model` values in the persisted session records;
   `claude` (the retired `claude-exp` id is only an alias for it), and official
   provider ids
   (`claude-official`, `claude-official-<account>`) share the provider-less
   official line. Ties resolve to the earlier entry of the model list.
3. No usable history → the first entry of the lane's model list. Entries that
   are no longer in the list (stale ids after a catalog change) never win.
4. Only an empty list falls back to the last model the CLI reported for the
   session; managed Codex routes with an empty catalog resolve to no default
   instead of resurrecting a reported model from a previous route.
5. Terminal configuration files are never read for the model. Effort/reasoning
   (`claudeDefaultEffort`, `codexDefaultReasoningLevel`) is a separate local
   preference and stays as it was.

Lane lists: official Claude uses `listClaudeModelsSync()` (the same list the
picker shows, with `CLAUDE_MODELS_FALLBACK` when the CLI has not been scanned);
official Codex uses `readCodexOfficialModels()`; provider lanes use the
provider summary's `modelOptions`.

Adapters always pass an explicit model: `claude` via
`--model`, `codex` via `-c model=...`, `codex-exp` via `--model` and the
per-turn `turnOptions.model`. The official Claude lane additionally writes the
per-session `--settings` override (`src/providers/claude-settings-override.js`)
with the chosen model at the top level and every absent routing key blanked, so
a rewritten `~/.claude/settings.json` cannot redirect the account. Blank env
values read as unset to the CLI, so OAuth/keychain login is unaffected.

Deleted Node logic: `claudeDefaultModel`, `codexDefaultModel` and the default
branches of `effectiveSessionModel`/`providerDefaultModel` in
`src/cli/session-policy.js`. The Web/App pickers no longer show or derive a
"terminal default"; the highlighted default is the value computed above.

Tests: Rust unit tests in `model_default.rs` (frequency, tie to list order,
empty history, stale ids, provider-scoped history, pinned model, alias-only
wire default, official Codex empty catalog); JS tests in
`tests/test-session-policy.js`, `tests/test-claude-settings-override.js` and
`tests/test-session-model-terminal-config.js` run against an isolated temp HOME
containing a ccswitch-rewritten `settings.json`/`config.toml`.

## 2026-11-09 本批集成验收：回合收尾、线路切换与默认模型

本批已同步 main `89c54056`，源码指纹 `49e5cffd731f59f5e73f0d26`。
回合收尾规划由 Rust 执行；自动线路切换覆盖全部启用候选，不再被旧的
2–4 次上限截断；默认模型从当前线路模型列表和明确选择历史产生，不读取终端模型配置。
仍保留 Node 的进程/流/WS 副作用端口以及默认模型事实读取、短期缓存和 JSON 桥，
后两项是下一批清理范围，不能据此声明 Node 后端已退出。

同步后验证：230 项专项、Rust workspace 686 项、Flutter 配置界面 48 项通过；
完整 `npm test` 退出 0（统计输出共 6,563 项：6,560 通过、0 失败、2 项工具缺失跳过、
1 项原有重复气泡 S6 TODO）。隔离真实 gateway + server 覆盖正常结束、异常退出、
零退出无结果、排队后续消息及取消后新轮，最终退出 0。初次隔离检查业务断言通过但
清理目录失败，已修复为自有进程组、等待 close、超时停止子进程后再清理；失败记录保留。
测试分层、产物/运行时写入治理、源码预算、JS 语法与 diff 检查通过；main 新增队列
双语文案遗漏的预算登记已补齐。两处未改动的 Rust 格式差异已核对来自原 main。

收据归档：`data/rust-source/49e5cffd731f59f5e73f0d26/validation/merged-chat-batch/`。
控制协议仍为 12，整体账本仍为 5/6；剩余 CLI 监管、流式/后台副作用、provider
宿主编排、历史持久化及聊天 WS 仍需逐批迁移。本批集成不包含推送或生产重启。

## 2026-11-09 续批：默认模型缓存归 Rust

上一批已合入 main：提交 `6c1c2967`，合并 `799aa9de`，合并接口返回
`deliveryEvidence.state=published`，任务分支已同步，未推送或重启生产。

本续批将 `session-policy.js` 的历史 TTL、结果 Map、失效逻辑及分隔符拼接键删除。
`native/core/src/model_default.rs::Store` 是每个会话策略实例的唯一缓存所有者；
`Request / ProviderInfo / History` 原生传值，addon 直接返回字符串或 null。
旧 `sessionModelDefault(String) -> String` 导出及 JS stringify/parse 桥已删除。
完整结构体参与缓存键，覆盖 aliasOnly、official、wireDefaultModel、globalProviderCli
和明确的历史线路作用域，避免线路属性变化及分隔符碰撞造成错误复用。

保持原有列表顺序破同票、按线路统计显式选择、官方账号归并、指定模型优先及
Codex 空目录不复活旧模型的规则。时钟首次为零仍须读历史；到期、倒退或非有限时钟
触发刷新。宿主回调/字段读取/时钟转换均在锁外，历史发布按代次校验，重入发布的新
快照不被外层旧结果覆盖；读取或时钟异常不发布半成品。结果缓存至多 1,024 项，
达到上限清理可重算结果；历史与 TTL 不受影响。TTL 0 禁用缓存，每次重读。

Node 例外仅为当前记录与线路目录读取、官方 provider 身份查询及启动装配。
这些宿主端口归属尚未整体迁完，所以继续保留最小适配；Rust 不保活读回调。
只读取约定字段，不再枚举无关属性或执行 toJSON；生产输入是宿主组装的数据对象。
字符串保留旧 lenient JSON 边界的孤立 UTF-16 替换规则及 Rust trim 行为，
此批不另改字符语义。源码能力探针要求新类及一次真实选择成功；控制协议仍为 12。

已通过：冻结旧 Rust 规则的 2,500 组差分、实际新旧 addon 的 3,500 组输入对拍、
11 项新增缓存/重入/异常/GC 验证、完整 Rust workspace 690 项、真实隔离
网关与服务检查。完整 `npm test` 退出 0（6,574 项：6,571 通过、0 失败、2 项工具缺失跳过、
1 项原有 S6 TODO）；最终产物专项连同真实网关 27 项通过，另有配置隔离脚本
51 条断言通过。此续批尚未提交或合并。
整体仍为 5/6，不将缓存迁移计为 CLI 监管、聊天持久化或 WS 宿主已完成。


最终源码指纹：`af0a05f49780a5e04eb04080`。构建来源与能力探针通过。
完整 npm 运行使用格式整理前的 `8d543c49f67ea8417e4bb810` 产物；
逐文件 SHA-256 证实 addon、gateway、CDP 网关及远控二进制与最终构建字节完全一致。
最终指纹目录另已复跑模型专项与真实网关检查，故无需重复跑同一份二进制的全量测试。
Rust 格式、JS 语法、852 项测试分层、源码预算、仓库产物及运行时写入治理、
架构门禁与 diff 检查通过。对抗性复核使用已合并版本复现零时钟不读历史、
aliasOnly/线路默认模型更新后错误命中缓存，再对照续批结果确认修复。

日志与二进制一致性收据归档：
`data/rust-source/af0a05f49780a5e04eb04080/validation/model-default-owner/`。
下一依赖继续 CLI 尝试生命周期及收尾副作用，再处理剩余 provider 宿主、
历史持久化与聊天 WS；本节不代表这些依赖已完成。

## Native transcript governor (2026-11-09)

The Claude transcript governor now lives in Rust. `src/chat/transcript-prune.js`
is a 64-line facade (-917/+63) around twelve addon exports;
`native/core/src/transcript_prune.rs` (1,884 lines, plus 288 lines of unit tests
in `transcript_prune/tests.rs`) owns the decisions, and
`native/addon/src/transcript_prune.rs` (158 lines) moves values over the
lossless bridge.

What moved: `claudeProjectDir` (project slug mapping), `findTranscriptFile`
(newest non-pruned `.jsonl` for a session id), `measure`/`measureFile`
(line/turn/live-byte extent, API bytes, estimated tokens, the compaction
boundary), `pruneFile`/`maybePrune` (threshold triggers, force/strict/dry-run
planning, the keep-turn ladder, entry elision with the 160-unit reserve and the
image/tool-result markers, compaction prologue preservation and splice, orphan
`tool_result` neutralisation and chain re-rooting, parentUuid capture, the
`.pruned.jsonl` sidecar, one atomic in-place write preserving mode and inode,
and the report), the `isRealUserTurn` / `isSubstantiveTurn` / `userVisibleText`
predicates, and the `triggersFor` / `compactCutIndex` helpers.

Rust API surface (addon exports): `transcriptPruneDefaults`,
`transcriptProjectDir`, `transcriptFind`, `transcriptPruneFile`,
`transcriptPruneMaybe`, `transcriptMeasureFile`, `transcriptMeasure`,
`transcriptRealUserTurn`, `transcriptSubstantiveTurn`,
`transcriptUserVisibleText`, `transcriptTriggersFor` and
`transcriptCompactCutIndex`. Typed `Options`/`MeasureOptions`/`Report`/`Level`/
`Cut` structs stay internal; only the JS boundary consumes `js::JsValue`, and
disk lines are parsed with the exact `js::json_parse` rather than the lenient
sanitizer, because the kernel re-serializes those lines and must keep lone
surrogates byte-for-byte.

What remains in Node: only the facade. It injects `os.homedir()` (the kernel
takes the home directory as an argument), keeps the legacy argument spellings
(`String(cwd || '')`, falsy session id, `file ? String(file) : null`, default
`{}`) and re-exports the default constants. No parsing, policy or I/O decision
remains there, and there is no fallback path.

Deleted Node logic: the whole 919-line implementation. The frozen oracle is
`tests/helpers/legacy-transcript-prune.js` (924 lines including its header).

Oracle and differential coverage: `tests/test-transcript-prune-differential.js`
(534 lines, 12 tests) drives both implementations over identical seeded temp
files with a temporary HOME: 700 randomized prune cases, 400 randomized measure
cases, 30 binary/CRLF/empty/no-trailing-newline variants, 80 oversized elision
cases, 120 compact-boundary cases, orphan neutralisation and chain re-rooting,
the fractional keep rung (the legacy destructive edge is asserted, not fixed),
missing/symlink/unreadable paths, project-directory and file selection, 1,200
randomized predicate values plus hand-built shapes, and 600
trigger/compactCutIndex cases. Reports, bytes, sidecar contents, file mode and
inode are compared.

Preserved legacy behaviour: `pruneFile` still propagates a failing final write
while sidecar append failures stay swallowed; the out-of-range or fractional
`keepTurnsLadder` index bug (an empty candidate, so the file is rewritten as a
single newline) is reproduced deliberately. One difference is accepted: `null`
options are still rejected, but the native boundary throws
`Error: transcript_prune_invalid_options: null` where JavaScript threw the
engine's `TypeError`. Callers never pass `null` (the default parameter only
fills `undefined`).

Mutation faults (each failed the differential suite and was reverted):
compact-boundary subtype renamed (6 failing tests), sidecar suffix renamed (5),
elision marker text changed (4), orphan drop marker changed (4).

Rust workspace: 701 passed, 0 failed. `rustfmt --check` is clean on the changed
files and clippy reports no warning in the new core/addon modules; pre-existing
warnings elsewhere, including the `unused_io_amount` deny in `native/cpr`, are
untouched.

Test tiers: 853 classified (core 408: deterministic 334 / isolated 43 /
flutter 31); the audited release counts in
`tests/test-release-version-consistency.js` move to 408 entries and 380
commands (377 Node entries). Source line budget OK; `git diff --check` clean.

Full `npm test` against the final artifact (loaded through `MULTICC_RUST_ADDON`
and `MULTICC_RUST_PREBUILT_DIR`) passes: 6,589 tests across 28 node:test
summary blocks, 0 failed, 2 skipped, 1 todo. Both skips and the todo are the
pre-existing environment gates (no desktop/electron-builder toolchain, no
`pwsh`, and the existing S6 duplicate-bubble nudge case); nothing in this batch
is skipped. The `test:core` group runs both transcript suites.

Fingerprint `9e1fd64e85717cc9e5835939`; the artifact is
`data/rust-source/9e1fd64e85717cc9e5835939/darwin-arm64/multicc_core.node` in
the primary repository. It was built from source with
`node scripts/ensure-source-rust.js` and the capability probe, extended in
`scripts/rust-source-cache.js` with the twelve new exports and three smoke
assertions, passed.

## Native session guards (2026-11-09)

The two pre-resume size guards now live in one Rust module.
`src/chat/codex-rollout-guard.js` is a 157-line facade (+123/-239) and
`src/chat/native-session-guard.js` is a 123-line facade (+93/-253) around two
addon classes; `native/core/src/native_session_guard.rs` (1,267 lines, plus 469
lines of unit tests in `native_session_guard/tests.rs`) owns every decision, and
`native/addon/src/native_session_guard.rs` (151 lines) moves values over the
lossless bridge.

What moved: codex rollout discovery (`sessions/**/rollout-*-<thread>.jsonl`
name matching, newest-file selection, and the `not_found` / `blocked` /
`archived` actions), size measurement, archive moves into
`multicc-archived-rollouts`, and TTL sweeping; and the vendor-native stores
(zcode, kimi provider and providerless lanes, codebuddy, qoder, dsh) including
directory sessions, per-lane home resolution, archive naming with UTF-16 unit
slicing, and the `multicc-archived-sessions` sweep with its six-hour throttle.
Node `path.posix` join/normalize/dirname/basename semantics are reimplemented
byte-for-byte, including lone-surrogate archive names.

Rust API surface (addon exports): `codexRolloutGuardDefaults`,
`nativeSessionGuardDefaults`, and the classes `RustCodexRolloutGuard` /
`RustNativeSessionGuard` with `enforce`, `sweep`, `handles`, `storeTruthy` and
the `maxBytes` / `archiveTtlMs` getters. Typed `CodexOptions` / `NativeOptions`
/ `RecordView` / `Outcome` structs stay internal; only the JS boundary consumes
`js::JsValue`. `enforce` returns `{result, logs}` so the facade can replay
`logger[level]?.(name, fields)` in try/catch; results are still `Object.freeze`d
by the facade.

What remains in Node: only the facade. It resolves `os.homedir()`, the injected
`prepareCodexSessionHome` / `codexSessionHomeFor` / `zcodeSessionHomeFor` /
`kimiSessionHomeFor` callbacks and `KIMI_CODE_HOME`, keeps the legacy argument
spellings (including `options.force === true` read timing, so a `null` options
argument still throws only when the guard would run), and re-exports the
defaults. No walk, stat, archive name or policy decision remains there, and
there is no fallback path.

Deleted Node logic: 492 lines (239 from the codex guard and 253 from the native
guard). The frozen oracles are `tests/helpers/legacy-codex-rollout-guard.js`
(281 lines) and `tests/helpers/legacy-native-session-guard.js` (291 lines).

Preserved legacy quirks: `STORES[cli]` is a plain property read, so the twelve
`Object.prototype` names are truthy-but-missing stores (`not_found`), while
`handles()` keeps the `hasOwnProperty` answer; the native sweep adds bytes before
each removal attempt, so a failed unlink still inflates `freedBytes`; the native
archive name is `String(record.id || 'session').slice(0, 32)` and can split a
surrogate pair; the codex sweep deletes files only (directories and symlinks are
left in place), while the native sweep deletes directories and symlinks;
filesystem error text is passed through unchanged.

Oracle and differential coverage: `tests/test-native-session-guards-differential.js`
(672 lines, 111 tests) runs the frozen oracles and the current facades on two
identical mkdtemp trees: 31 hand-built cases (codex budgets, prepare redirects
and error codes, provider homes, sweeps and throttles, native lane layouts,
prototype names, lone-surrogate ids, symlink and permission failures, archive
collisions) plus 80 seeded randomized cases. Results, logger calls, error
strings (text normalized) and post-run filesystem snapshots (mode, size, sha256,
symlink targets) are compared. Paths are normalized and deleted/archived lists
are sorted because APFS readdir order differs between two directory instances.

Mutation faults (each failed the differential suite and was reverted): the
32-unit archive-name slice cut to 31 units (1 failing test), symlinks skipped in
the native sweep (1), and the native archive directory renamed (27).

Rust workspace: 719 passed, 0 failed (18 new guard unit tests).
`rustfmt --check` is clean on the changed files and clippy reports no warning in
the new core/addon modules; pre-existing warnings elsewhere are untouched.

Test tiers: 854 classified (core 409: deterministic 335 / isolated 43 /
flutter 31); the audited release counts in
`tests/test-release-version-consistency.js` move to 409 entries and 381 commands
(378 Node entries). Source line budget OK; `git diff --check` clean.

Fingerprint `27750efe5218625537d89c64`; the artifact is
`data/rust-source/27750efe5218625537d89c64/darwin-arm64/multicc_core.node` in
the primary repository. It was built from source with
`node scripts/ensure-source-rust.js` and the capability probe, extended in
`scripts/rust-source-cache.js` with the four new exports, the class prototype
methods (`enforce` / `sweep` on both, plus `handles` / `storeTruthy` on the
native class), both getters and a temporary-directory smoke check, passed.

## Native background-task and turn-nudge owner (2026-11-10)

The whole background-task runtime is now one Rust owner.
`src/chat/background-task-runtime.js` is a 154-line facade around the
`RustBackgroundTasks` addon class; the three satellite modules
`src/chat/native-background-tasks.js`, `src/chat/background-task-metadata.js`
and `src/bg-completion-coalescer.js` are deleted. `native/core/src/background/`
holds the kernels (`state.rs`, `snippet.rs`, `coalescer.rs`, `metadata.rs`,
`native_tasks.rs`), and `native/addon/src/background_tasks.rs` (2,706 lines)
owns every decision and the JS boundary.

What moved: event dispatch (`monitor_prompt`, `task_started`,
`task_progress`/`task_updated`, `task_notification`, `background_tasks_changed`
and the codex native sub-task events), the stale-run gate, the completion
classifier (awaiting TaskOutput, sync result, sub-agent/sidechain suppression,
Monitor, inject, failed), turn-result detection, the output snippet rules
(agent-report JSONL sidechain extraction, report head truncation, log tail,
redaction text), the nudge coalescer (fixed window from the first completion,
800-unit merged cap, single and `×N` wordings, the `【后台事件】` Monitor
prefix), the per-session metadata ledger (parent fields, snapshots, TTLs), the
codex native store (liveness, heartbeat silence, listing, reap), the output-file
shadow watcher, the ledger broadcasts (`monitor_progress` / `monitor_done`), the
`deliverSystem` injection and the `stopForInsert` / `stopSession` / `stopAll`
teardown paths.

Rust API surface (addon): the `RustBackgroundTasks` class with
`handleEvent(ports, sessionName, event)`, `tick(ports)`, `nextDue()`,
`applyControlOutput(token, text, truncated)`, `backgroundSilenceMs(session)`,
`hasLiveBackgroundTasks`, `hasProcessBackgroundTasks`,
`listActiveBackgroundTasks`, `markTaskOutputAwaiting`,
`recordMainToolUseId`, `reapSessionShadows`, `stopAll`, `stopForInsert`,
`stopSession` and `takeStoppedNote`. Ports are the only way back into Node:
`now`, `broadcast`, `observe`, `noteBgResultInjected`, `deliverSystem`,
`logWarn`, `safeText`, `readFile`, `redactEvent`, `redactText`, `tmpdir`,
`realpath`, `getuid`, `requestEnrich` and `requestStopTask`. Frames are typed
internally and serialized at the boundary in the legacy property order, so the
wire shape is byte-for-byte the old one.

What remains in Node: only the 12-key frozen facade. It resolves the native
module, builds the ports object, owns the single unref'd `setTimeout` armed from
`nextDue()` (callback runs `owner.tick(ports)` in try/catch and re-arms), and
wraps the two async escape hatches `fetchTaskOutput` / `stopTask` as Promise
calls. `server.js` lost the `createCoalescer` / `buildNudge` /
`classifyCompletion` / `spawn` dependencies and the `bg-completion-coalescer`
require; the `chat_events.rs` host still calls the facade for
`record_main_tool_use_id` and `mark_task_output_awaiting` through
`nativeChatEventPorts` (allowed partial, no state duplication). No legacy logic
or fallback path remains in Node.

Deleted Node logic: 966 lines (719 from the 873-line runtime, 63 + 64 + 120
from the three satellites). The frozen oracles are
`tests/helpers/legacy-background-task-runtime.js` (877 lines) with
`legacy-native-background-tasks.js`, `legacy-background-task-metadata.js` and
`legacy-bg-completion-coalescer.js`.

Intentional differences versus the legacy runtime: the output shadow is
whole-file polling every 500 ms instead of a `tail -n +1 -F` child, so there is
no spawn-failure or exit path and no tail log line; bytes produced inside the
5 s progress throttle are acknowledged but not broadcast, just like the old
throttle, and a poll that observes several deltas emits one progress frame;
`now()` call counts differ (only user-visible effects are compared); a
non-finite completion window is clamped to zero; the unreachable `invalid`
classifier branch is gone; session keys and list/reap ids go through `String()`
normalisation. Preserved quirks: `task_ledger finish` is observed before the
classifier runs, `stopShadow` runs even when only a native id is known, the
awaiting/TaskOutput dedup TTL still consumes on match, merged snippets keep
`[refs:a,b]` in completion order, the stopped note text is unchanged, and
`markTaskOutputAwaiting` requires `block === true`.

Fixed bugs versus the legacy runtime (authorised deviations, each pinned by a
test): the metadata ledger compared `run_id` values as raw strings, so a run
`10` looked OLDER than `9` and a newer run's late event could be dropped as
stale. The Rust metadata kernel now compares ids numerically when BOTH are
canonical non-negative decimals (ASCII digits, no leading zero unless the id is
exactly `0`) by digit count then lexicographically, and keeps the old string
comparison for anything else; real CLI ids such as `0mw7l8fr0-58e28fed` and
equal-width fixtures are unchanged, so only genuine decimal ids get the fix. A
`background_tasks_changed` whose `tasks` list is empty (or absent) now retires
every live Monitor watch, matching the oracle; the port previously skipped
retirement whenever the id set was empty. The differential suite carries an
explicit intentional-divergence scenario that asserts the new run-id ordering on
each side (legacy keeps `9`, Rust accepts `10`); its random generator only
emits zero-padded `00X` ids so it can never straddle the digit-count boundary.

Oracle and differential coverage: `tests/test-background-tasks-differential.js`
(686 lines, 25 scenarios) runs the frozen Node oracle and the Rust facade side
by side under a shared fake clock, feeding legacy `tail` deltas at the same
500 ms boundaries at which Rust re-reads the file. It covers 16 hand-built
scenarios (run-in-background lifecycle, foreground/sub-agent suppression,
TaskOutput TTL, Monitor watch/progress/terminal/dedup/retirement, empty-list
watch retirement, a duplicate `event_id` surviving a watch reset, persistent
Monitor, reap consuming the task origin, metadata snapshots and stale runs,
sync-bash marker consumption, stopForInsert note plus the late notification that
must stay native, stopSession/stopAll, codex sub-tasks, turn-result suppression,
output snippets and redaction, unknown events and a non-array
`background_tasks_changed` TypeError), one named intentional-divergence scenario
for the numeric run-id fix, plus 8 seeded randomized interleavings of 60 steps
each. Every op compares return values, thrown error constructor names, the
broadcast / observation / injection / warning logs and the per-session liveness,
silence, active-list and snapshot state.
`tests/test-background-task-runtime.js` (39 tests, including a real-FS shadow
poll through the `readFile`/`realpath`/`tmpdir` ports, an exact
throttle-boundary assertion and a facade-level numeric run-id test) and
`tests/test-bg-completion-coalescer.js` (18 tests) keep their intent against the
facade and Rust owner; the old `spawn`/`tail` assertions were replaced with
polling-progress assertions.

Mutation faults (each failed a unit or differential test and was reverted, no
marker left behind): the coalescer re-anchored its deadline on every added item
instead of the first, `DEFAULT_WINDOW_MS` changed from 1500, the `due` boundary
became `>` instead of `>=`, the report cap multiplier changed from 8, the
heartbeat overwrote `at` instead of freezing it, the stale-run string comparison
was reversed, the completion fallback status became `completed` (caught by the
differential suite, which rebuilds the addon from the mutator); in the
re-audit, snippet head/tail extraction and the per-shadow progress throttle
(`<` to `<=`, now pinned by an exact-boundary assertion), the Monitor
`event_id` dedup, the reap-time `task_origins` consumption and the
`delivered` flag set by `stopForInsert` were each mutated and caught by the
runtime test or the differential suite before being reverted. In the batch-1
follow-up the Monitor `terminalQueued` mark and the sync-bash marker consumption
were each removed, rebuilt and caught by the differential suite, and the
empty-list watch-retirement fix was reverted to the old `ids`-guard to prove the
new differential scenario catches it; every mutation was reverted exactly (empty
`git diff` on the mutated span).

Rust workspace: 743 passed, 0 failed (26 new background unit tests); `rustfmt
--check` is clean on the changed files and clippy reports no warning in the new
modules.

Test tiers: 855 classified (core 410: deterministic 336 / isolated 43 /
flutter 31); plus the new differential suite the audited release counts in
`tests/test-release-version-consistency.js` move to 410 entries and 382
commands (379 Node entries).

Fingerprint `aa26b00f69b01f49fefb1a0b`; the artifact is
`data/rust-source/aa26b00f69b01f49fefb1a0b/darwin-arm64/multicc_core.node` in
the primary repository (sha256
`48374fbc0711784f4d0dd83f895ba9937a96ec8c2d3714b69386fe308501319f`). It was
built with `node scripts/ensure-source-rust.js` and the capability probe in
`scripts/rust-source-cache.js`, extended with the `RustBackgroundTasks` export,
its prototype methods and a fake-ports smoke check, passed.

The full `npm test` on this artifact finished with exit 0: 6,735 Node test
records, 6,732 passed, 0 failed, 2 skipped (desktop toolchain and pwsh, both
pre-existing) and 1 pre-existing S6 todo. The rustfmt, clippy (no warnings in
the new modules), `cargo test --workspace` (743 passed), tier, source
line-budget, architecture, repository-artifact and runtime-write governance
checks and `git diff --check` are all clean.

## Native background-hold owner and held-turn injection (2026-11-10)

User's rule, recorded in `data/plans/turn-includes-background-20261110.md`:
background work is part of the turn. A resident Claude turn whose main
`result` already arrived while its Agent / `run_in_background` Bash / Monitor is
still alive is therefore still the CURRENT turn, and the user's next typed
message belongs IN it. This section supersedes the older lease/admission plan
for this area; workspace admission, leases, the provider route fence and proxy
attribution were not touched.

Scope: the two resident Claude backends (`src/chat/chat-stream.js` legacy CLI
lane and `src/chat/claude-sdk-stream.js` SDK lane). `src/zcode-bridge.cjs` keeps
its own hold copy and is unchanged, and the codex/app-server lanes never hold a
finished turn open, so nothing changes for them (the spec's facts were checked
against the code first; this is the one place where only some backends could
take the change).

What moved into Rust: the whole hold lifecycle. `native/core/src/background_hold.rs`
(640 lines, 10 unit tests) owns `Hold::new/start/observe/tick/finish/
begin_injection/abort_injection/cap_reached/dispose`, the quiet-window release
(5 s default, 1 s tick), the self-wake bookkeeping (last self-wake wins; a
failure released as failure; a cancel leaves the held answer untouched), the
outstanding-injection counter, and the cap decision. `native/addon/src/
background_hold.rs` (210 lines) is the JS boundary: the `RustBackgroundHold`
class plus `backgroundHoldMaxMs`, `backgroundHoldMayInject` and
`backgroundHoldSpawnContract`. `src/chat/background-hold.js` shrank from the
134-line implementation to a 111-line facade (70 insertions / 93 deletions)
with the same surface for both backends; the frozen oracle is
`tests/helpers/legacy-background-hold.js` (140 lines, only require paths and a
FROZEN header changed). `scripts/rust-source-cache.js` gained the export,
prototype-method, getter and fake-ports smoke probes for the new class and free
functions in the same edit.

Behaviour change (a) — the cap no longer releases. The timeout
(`MULTICC_BACKGROUND_HOLD_MAX_MS`, default 60 min) now only calls the hold's
`cap_reached`, which is true exactly once and only while held with background
active; the facade forwards it to an `onCapReached` logging callback in both
backends. The turn stays open for as long as the background work is alive, and
the release still happens on the quiet window after that work ends. Tests that
pinned the old cap release were updated:
`tests/test-monitor-admission.js` (the two cap-release tests became "background
work outliving the hold cap keeps the turn open and the wake inside it" and
"real sdk turn held past the cap with a background agent mid-request keeps its
answer and the process"; the unit cap block now asserts no release and one
notice), `tests/test-claude-sdk-stream.js`, `tests/test-claude-sdk-stream-vault.js`
and `tests/test-chat-stream-idle-guard.js` (fixture/comment only). The
differential suite carries the named intentional-divergence scenario "the cap
warns instead of releasing", which asserts the legacy side releases and the
Rust side does not.

Behaviour change (b) — the delivery predicate is Rust. `may_inject` decides,
in this exact order, with these refusal reasons: `not_held` (no held turn),
`injection_in_flight` (an injected answer is still streaming),
`no_active_turn` (the turn engine does not consider this session to be
running), `not_user_typed` (not a direct human chat message — dispatch,
triggers, `originContinue` continuations and task-shell items are excluded),
`process_not_alive`, `spawn_contract_changed` (either digest missing or the
live process's digest differs from the persisted record's) and
`already_delivered` (this delivery identity was already written). Only then
does it answer `inject` with reason `held`. The spawn-contract digest is
sha256 over the stable-stringified, persisted-only facts `cli`, `provider`,
`providerSelection`, `model`, `effort`, `subagent`, `cliAccounts`,
`pendingConfiguration` and `nativeSessionId` (`cliSessionId ??
_streamSessionId`), so a route change staged or applied mid-turn makes the
digests differ and the message waits for the next turn. None of this logic
lives in Node: `src/chat/held-turn-injection.js` (167 lines, new) only
translates host objects into the predicate's facts, performs the write and
keeps the exactly-once memory.

Behaviour change (c) — thin wiring, exactly-once delivery. The outbox busy gate
in `src/orchestration/runtime.js` now consults a new sync port
`heldTurnInjectable` before it defers; without that the item could never reach
`deliver()`, because the gate runs before the claim. In `deliver()`,
`tryInjectHeldTurn` is called after lineage resolution and before the scheduler
claim / workspace lease / `beforeDeliver`; a delivered result acknowledges the
outbox item and returns, so a held turn takes the message with no scheduler
claim and no workspace lease. Any refusal is a no-op and the item keeps waiting
exactly as before. The write goes through the lane's `injectHeldTurn`: the
legacy backend writes the normal `userMessageLine` to the live stdin, the SDK
backend calls `run.lane.sendUser(...)` with the user message frame; both mark
`beginInjection()` first so the hold cannot release before that answer lands,
and abort on a write failure. After the live write the user row is appended
with `heldTurnInjected: true` (the exactly-once marker; the durable row with
the same client id is the second guard, and a row without the marker keeps its
normal meaning). The stream router falls back to `false`/`null` for lanes
without a live stdin, so those keep the waiting path. `server.js` wires
`heldTurnInjectable`, `tryInjectHeldTurn` and `heldForBackground`, and the
stuck-delivery notice now names the real owner ("本轮的后台任务…回合会一直保持到
它们结束") instead of claiming no turn is running. `src/chat/turn-engine.js`
passes the spawn-contract digest to `chatStream.ensure`, and both backends
store it with the child.

Tests: `tests/test-background-hold-differential.js` (523 lines, 7 tests: hold
lifecycle over 9 deterministic scenarios, 12 seeded randomized interleavings,
the cap divergence scenario, an injected message keeping the hold open, the
predicate table for both resident backends, 9 mutants all caught by a 5-scenario
plus 6-seed corpus, and the `holdMaxMs` environment table). The node:test mock
clock moves `Date.now()` once per `tick(ms)` jump, so the suite steps the clock
in 1 s increments (`advanceClock`) rather than jumping; that is documented in
the file header. `tests/test-held-turn-injection.js` (333 lines, 10 tests)
covers the spawn-contract facts, the direct-user-typed filter, the exact
appended row, every refusal reason writing nothing, write/row persistence
failure reporting for outbox retry, the no-claim/no-lease path, the
different-process wait with the background-work notice, a message typed while
the answer is still generating, the normal path after the turn ends, and the
waiting notice wording. `tests/test-monitor-admission.js` gained the two real
lane injection tests (a message typed during the held phase runs inside that
same turn on both sdk and legacy, and the wake still decides the final answer).

Mutation faults (each caught and reverted exactly; the differential rebuilds
the oracle variant from the mutated source): release on the background fact,
release while a wake answer streams, forget a failing self-wake, hide a failing
self-wake behind the held answer, hold a failing main result, leak a failing
self-wake, keep the held answer instead of the final wake answer, leak a
cancelled wake result, and merge a quiet release without the last wake. All 9
are caught.

Rust workspace: 753 passed, 0 failed (10 new background-hold unit tests);
`cargo fmt --check` is clean; `cargo clippy -p multicc-core -p multicc-addon
--all-targets` exits 0 with no warning in `background_hold` (the workspace-wide
clippy run still fails on the pre-existing `unused_io_amount` deny in
`native/cpr/src/transport.rs`, untouched by this batch).

Fingerprint `8cc19cc2fbe04a0bcf80b34b`; the artifact is
`data/rust-source/8cc19cc2fbe04a0bcf80b34b/darwin-arm64/multicc_core.node` in
the primary repository (sha256
`6bbba71419d1ad7dcb3cd9b9b0191458717819834a418a6d0b1fa92699c625b4`), built with
`node scripts/ensure-source-rust.js` and passing the extended capability probe.

Test tiers: 857 classified (core 412: deterministic 338 / isolated 43 /
flutter 31); the audited release counts in
`tests/test-release-version-consistency.js` moved to 412 entries, 338
deterministic and 384 commands (381 Node entries).

Not verified: no live end-to-end run against a real Claude upstream (no
service restart, no real account turn), so the injection frame was only proven
against the fake CLI fixtures in `tests/test-monitor-admission.js`; the zcode
resident lane keeps its own hold and was left unchanged.

The full `npm test` on this artifact finished with exit 0: 6,754 Node test
records, 6,751 passed, 0 failed, 2 skipped (desktop toolchain and pwsh, both
pre-existing) and 1 pre-existing S6 todo. `tests/test-source-line-budget.js`
now pins `server.js` in the declared debt set next to `public/run-config.js`;
line budget, test tiers, release consistency, architecture, repository-artifact
and runtime-write governance checks and `git diff --check` are all clean.

## Native turn-progress owner: heartbeat, timing, timeline and delivery probes (2026-11-10)

Batch 2 of the Node-to-Rust exit (spec
`data/plans/batch2-turn-progress-spec-20261110.md`). Four private-state chat
modules moved into one native owner: the silent-period progress heartbeat
(282 lines), per-turn spawn/send/first-byte timing (115), the model-request
timeline (172) and the delivery-handoff probe registry (60). All four are
deleted from `src/`; there is no dual path, no fallback and no environment
switch, and their legacy bodies exist only as frozen oracles under
`tests/helpers/legacy-{progress-heartbeat,turn-timing,turn-timeline,delivery-probe}.js`
(645 lines, only the require paths and a FROZEN header changed).

What moved into Rust: `native/core/src/turn_progress/{heartbeat,timing,
timeline,probe}.rs` (2,268 lines with 28 unit tests) are pure kernels over the
lossless `JsValue` transport. `native/addon/src/turn_progress.rs` (997 lines,
33 `#[napi]` methods) is the single `RustTurnProgress` class; per-call `Ports`
objects are read lazily so every throwing-clock and throwing-callback path
keeps its exact JS mutation order, and a throwing port is rethrown as the
original JS exception. The facade `src/chat/turn-progress.js` (404 lines) keeps
every caller's surface: `DEFAULT_INTERVAL_MS`, `MERGE_GAP_MS`,
`TurnProgressHeartbeat`, `createTurnTimingRecorder`, `createDeliveryProbeRegistry`,
`createTurnProgress` (one owner behind all four readers),
`createTurnTimelinePort`, `shouldReexecutePersistedDelivery`, `sanitizePhase`
and `sanitizeToolKind`. Callers unchanged in shape: `server.js` constructs the
one owner and wires the engine deps (`turnTiming`, `turnTimeline`,
`deliveryProbeRegistry`), `turn-engine.js`, `host-runtime.js`,
`finalize-host.js`, `src/codex/usage.js`, `src/liveness/runtime.js`, the six
`nativeChatEventPorts` entries in the reducer, and `sessions.js`
(`setForgetHook` fires on delete and clear).

Decisions recorded against the spec (the spec's line numbers were stale; the
code won): the addon constructor is positional `new RustTurnProgress(intervalMs,
maxIdentities)` rather than an options object with `maxTimingRecords`; the
ports object is the trailing argument of every method rather than the first;
`timelineStart(session, cs, at)` reads `cs.turnStartedAt` inside Rust instead of
the facade resolving an origin; `startTurn` returns the origin number (the
legacy timeline object was unused by callers); the timing record cap stays the
legacy constant 512 with no option; and the injected timer names stay
`setInterval`/`clearInterval` (the spec said `setTimer`/`clearTimer`). Timeline
state is keyed by session name inside Rust (decision 1), never on `cs`, and is
cleared together with the probe table by the session-delete forget hook. The
reducer ports stay ports in this batch (direct reducer-to-owner calls are a
batch-3 follow-up).

### Fixed bugs (each fix landed as a failing test first, then the Rust fix, then a named intentional-divergence scenario in `tests/test-turn-progress-differential.js`)

1. Prototype-table aliasing. `sanitizePhase('constructor')` and
   `sanitizePhase('__proto__')` returned `Object` / `Object.prototype` because
   the legacy used an object literal as a lookup table. Rust matches only the
   literal phase/tool-kind names, so both answer `running` / `other` and the
   snapshot's `phase` / `toolKind` are strings, never functions. Scenario:
   "intentional difference (bug 1): prototype members are not aliases".
2. Streaming retry lost the heartbeat. The turn engine stopped the heartbeat
   before deciding whether the failure schedules an owned retry, so a turn that
   retried in the same engine path lost its liveness signal. The stop now
   happens after the `retry-api` branch (the scheduled path keeps it; the early
   throw inside the scheduled start stops it, since that finalize is terminal).
   Asserted by the source-guard scenario "bug 2: the streaming finalize keeps
   the heartbeat alive across a scheduled retry".
3. A throwing heartbeat callback escaped as an uncaught interval exception.
   Legacy let the `onHeartbeat` throw out of `_tick`; Rust catches it and logs
   `progress_heartbeat_failed`. Scenario: "intentional difference (bug 3): a
   throwing callback is caught and logged" (the legacy side throws
   `Error: callback boom`, the Rust side logs twice with two active turns).
4. Nondeterministic due-time ticks. Legacy armed one `setInterval(intervalMs)`
   per active turn, so each turn drifted independently with the event loop.
   The facade owns exactly one unref'd timer, armed from `heartbeatNextDue()`
   with `max(0, due - now)`, and re-arms in a `finally` after every per-call
   tick. Scenario: "intentional difference (bug 4): one timer re-armed from
   nextDue" (three legacy timers vs one, same payloads).
5. Timing fields computed from null instants. The legacy `turnTimingsField`
   subtracted `null` as 0, so a record with `t1`/`t2` missing and `t3` present
   persisted nonsense (`spawnMs: -100`, `sendMs: 0`, `firstByteMs: 300`). Rust
   emits `null` for each delta whose endpoint is missing and keeps the field
   undefined until `t3`. Scenario: "intentional difference (bug 5): no null
   arithmetic in the persisted field" plus `Tims`-shaped unit tests.
6. Empty probe tables leaked and a non-positive cap could spin. Legacy created
   the per-session table before reading the clock and never pruned an emptied
   one; a negative `maxIdentities` even looped deleting from an empty map. Rust
   prunes empty tables and stops the trim loop at empty, so cap 0 or negative
   cannot spin. Scenario: "intentional difference (bug 6): empty probe sessions
   are pruned, no cap spin", plus `session_count` assertions.

Preserved, not changed (list-only in the spec, asserted by "intentional
preservation (bug 7)" and the probe scripted scenarios): zero-length request
spans are dropped at snapshot time, `MAX_SPANS` stays 4000 with the oldest-span
trim, same-kind spans merge at exactly `MERGE_GAP_MS` (1500, `<=`), an unknown
probe identity still deletes the oldest identity, and a later `handedOff:true`
record still overwrites the earlier `turnId` with `null`.

Tests: `tests/test-turn-progress-differential.js` (1,088 lines, 25 tests) is a
step-by-step differential: seeded ids, a fake clock, fake `setInterval`
schedules, ports resolved in the same order on both sides, and per-step
comparison of returns, thrown codes and port-call logs. It covers every public
method of all four readers, trimmed ids and object updates, throwing clocks and
throwing callbacks with exact mutation order, 4+4+3+4 seeds of randomized
interleavings with deterministic re-entrancy, the 512-record eviction, the
timeline's Claude frame list (30 frames) and adapter event list (19 events),
origin strictness, the 4000-span cap and zero-length request rule, the probe LRU
table, one-owner wiring, the chat-session forget hook, and source guards for
`server.js`/`turn-engine.js` plus the deleted-module/frozen-oracle set. The
rewritten source-guard tests (`tests/test-turn-timeline.js`,
`test-progress-heartbeat.js`, `test-turn-timing.js`, `test-liveness-runtime.js`,
`test-delivery-handoff-probe.js`) now exercise the facade/legacy oracles instead
of regexing the deleted files. `scripts/rust-source-cache.js` gained the export,
prototype-method and fake-ports smoke probe for `RustTurnProgress` in the same
edit.

Mutation faults (12, each failed a test and was reverted with a byte-compare
afterwards): heartbeat silence comparison `<` to `<=` (3 unit tests); fire
deadline drift `+1ms` (1); `touchVisible` not resetting the heartbeat period
(1); `touchActivity` not refreshing the activity age (2 differential tests);
`start` not dropping the session's predecessor (1); the first-byte logged
guard removed, logging twice (1); eviction picking an unlogged record (1);
`MERGE_GAP_MS` comparison `<=` to `<` (seeded timeline differential); keeping
zero-length request spans (1); `MAX_SPANS` `>=` to `>` (bug-7 differential);
probe record not refreshing LRU order (seeded probe differential); and empty
probe tables not pruned (1).

Rust workspace: all green after the sweep; `cargo fmt --check` clean and clippy
reports no diagnostics in `turn_progress`. Fingerprint
`46642830de94d58281a77275`; the artifact is
`data/rust-source/46642830de94d58281a77275/darwin-arm64/multicc_core.node` in
the primary repository (sha256
`d575cb46b9f0a269e53367a96b48acfc0c2ef79c6b544738a35025f79baaa846`), built with
`node scripts/ensure-source-rust.js` and passing the extended capability probe.

Test tiers: 858 classified (core 413: deterministic 339 / isolated 43 /
flutter 31); the audited release counts moved to 413 entries, 339 deterministic
and 385 commands (382 Node entries); `server.js` is registered at 3023 lines /
160674 bytes in the line-budget debt set (target 3000).

Not verified: no live service restart and no real-account end-to-end turn, so
the persisted `turnTimings`/`timeline` stamping is proven by the facade
differential, the rewritten guards and the source guard, not against a live
client. The spec asked for a section in `tests/test-chat-events-isolated.js`;
that suite cannot exercise the Claude lane at this base commit (chat runs only
on the resident Agent SDK lane, which spawns `MULTICC_CLAUDE_BIN`, while the
test still overrides only `CLAUDE_CMD`; pointing both at the fake makes turns
run but the task-shell scheduler never emits `session_queue completed` for the
second turn because classification has no aux provider in that isolated root).
That is a pre-existing red unrelated to this batch, so the file was left
untouched.

## Held-turn redesign: settlement is a uuid fact, not a counter (2026-11-10)

Spec `data/plans/held-turn-fixes-20261110.md`, review repros under
`data/plans/repros/` (`repro_hold.js` H1, `repro_dup.js` H2, `repro_c5.js` M2).
Base `abb72cf4`. The user's rule, from a live screenshot: while background work
a turn started is still alive, that turn is still the current turn; a message
typed into the chat box must be answered inside it, not queue behind it with
"workspace occupied and no turn is running". The previous batch kept the hold
but settled injections by decrementing a counter on *any* result, which lost
the answer, re-wrote messages on retry and let the injected answer become the
turn's outcome. This batch replaces counting with the attribution facts the CLI
actually reports, and moves the whole state machine into one Rust owner.

### Observed SDK facts (real bundled Claude Code binary, SDK 0.3.317; recorded before any code change)

Harness: a temp HOME/configDir fixture with a fake upstream, the real
`RustClaudeLane` (bundled binary), a background `run_in_background` Bash.
Output `/tmp/held-observe.out`; notes `/tmp/held-fix-notes.md`.

- The main turn result carries the opening prompt's uuid:
  `{"type":"result","subtype":"success","result":"sdk-answer-2","uuid":"4711d5ca-...","user_message_uuid":"bc31f8ad-...","user_message_uuids":["bc31f8ad-..."],"is_error":false}`
- A result answering ONE injected user message carries the uuid the injector
  stamped on the stdin line (`user_message_uuid` and `user_message_uuids`), and
  no `origin`:
  `{"type":"result",...,"result":"sdk-answer-3","user_message_uuid":"98973382-...","user_message_uuids":["98973382-..."],"is_error":false}`
- TWO messages written back-to-back while held are coalesced into ONE result:
  `{"type":"result",...,"result":"sdk-answer-5","user_message_uuid":"da77c62a-...","user_message_uuids":["663fac7d-...","da77c62a-..."],"is_error":false}`
  `user_message_uuid` is the LAST uuid; `user_message_uuids` lists BOTH, in
  order. Queued messages are therefore NOT answered one result each.
- A self-wake result (background job finished) carries no uuid fields and a
  task-notification origin:
  `{"type":"result",...,"result":"sdk-answer-6","origin":{"kind":"task-notification","producer":"session-task","runId":"..."},"origin_kind":"task-notification","is_error":false}`
- The only user-role events observed are tool_result echoes (uuid present); the
  injected prompt is not echoed back as a `user` message.

So the attribution fields ARE emitted and settlement is a membership test:
a result settles exactly those pending injections whose uuid appears in
`user_message_uuids` (falling back to `user_message_uuid`); a
`task-notification` self-wake never settles anything. The spec's "one result per
queued message" was an assumption; the binary coalesces, and the implementation
settles every covered injection from that one result, in order.

### State machine (owner: `native/core/src/background_hold.rs`, wrapper `native/addon/src/background_hold.rs`)

`Hold { quiet_ms, max_ms, held, latest, last_wake, busy, quiet_since, done,
pending, written, exchanges, cap_noted }`.

- `start(main_result, backgroundActive)` holds only when the event is the main
  result (`isMainResult` port) AND background work is alive. The cap timer is
  armed for visibility, never for release (`cap_reached` answers true once;
  `cap_noted` latches it).
- `observe(event)`: a self-wake (origin task-notification / the existing
  monitor-handoff classifier) becomes the turn's own latest outcome and never
  touches `pending`; an answer whose uuid list contains a pending uuid settles
  exactly those pending injections into `exchanges` (identity, uuid, result,
  usage, cost, is_error) and removes them from `pending`. Any result that
  carries an injected uuid is that message's answer and never the turn's own
  outcome; a duplicate of an already-settled uuid is swallowed without adding a
  second exchange.
- `tick(now, backgroundActive)`: releases only after `quiet_ms` with no
  background, no pending injection and no held event. The cap releases nothing.
- `begin_injection(identity, uuid)` registers BEFORE the stdin write and answers
  `write | append_only | refuse`; `abort_injection(identity)` releases a failed
  write. Written identities are remembered with their bound uuid
  (`REMEMBERED_LIMIT = 1024`, drop-oldest).
- Release event = the turn's own outcome (`latest`, else `last_wake`) plus
  `injected_exchanges[]`, `injected_usage` and `injected_cost_usd`. The usage
  recorder adds `injected_usage` to the durable usage
  (`usage_with_injected` in `native/addon/src/chat_events.rs`).
- `may_inject(InjectFacts)` is the single predicate over
  `{held, user_typed, attributable, turn_active, process_alive, process_stale,
  process_contract, wanted_contract, delivery_settled}`; refusal reasons in
  order: `not_held`, `no_active_turn`, `not_user_typed`, `unattributable_lane`,
  `process_not_alive`, `process_changed`, `spawn_contract_changed`,
  `already_delivered`.
- `process_stale(running, wanted)` is the ONE staleness comparison over
  `{routeUrl, routeToken, fingerprint, vaultDigest}`, returning
  `{routeChanged, configChanged, vaultStale, stale}`; the stream pump and the
  injectable predicate both call it (`M3`).

Node is wiring only: `src/chat/background-hold.js` (129 lines) constructs the
owner and forwards ports; `src/chat/held-turn-injection.js` (145 lines) projects
host objects into facts, registers the delivery, writes the stdin line and
appends the history row. The `remembered` Set, `MAX_REMEMBERED`,
`isDirectUserTyped`, `injectionInFlight` and the retry rule are deleted from
Node (47 added / 69 removed). The plain stream-json lanes (`src/chat/chat-stream.js`)
lose their injection attempt and `injectionInFlight` too: they write a user line
without a uuid and their results carry no `user_message_uuid(s)`, so an injected
message there could never be settled. Their `heldTurn()` reports
`attributable: false`, the Rust predicate refuses with `unattributable_lane`,
and the typed message stays on the normal waiting path until the turn ends
while the hold itself still keeps the turn open for its background work.

### Findings closed (each fix landed as a failing test first)

- H1 (any result decremented the counter): settlement is now uuid membership;
  a self-wake while an injection is pending does not release the turn.
  Tests: "an injected message is settled by its own answer, never by a
  self-wake" (`tests/test-background-hold-differential.js`), repro_hold now
  prints "not released (the typed answer is still pending) - FIXED".
- H2 (retry re-wrote the message): `beginInjection` registers the identity and
  uuid before the write; a retry gets `append_only` and only re-appends the
  row; a failed write calls `abortInjection`. Tests: "exactly-once: a retry
  appends the row only, an abort releases the identity",
  "a retry after write/row failure never writes stdin twice (H2)"
  (`tests/test-held-turn-injection.js`); repro_dup prints
  `attempt2 {"delivered":true,...} writes=1 appended=1`.
- M1 (availability read PATH `claude`): `server.js` now reports `claude`
  availability through `bundledClaudeCodeBinary() != null`, the same function
  spawn uses (`claudeLaneAvailable`); a machine without a global `claude` still
  reports available, a missing bundled binary reports unavailable.
- M2 (injected answer became the turn result/usage): the turn outcome is the
  main result / its self-wakes only; the injected answer is a separate
  `InjectedExchange`, its usage carried on the release event and folded into
  durable usage. Tests: "two queued messages are settled by one coalesced
  answer, in order" (differential), repro_c5 prints "turn result kept: true
  injected kept separate: true".
- M3 (spawn digest ignored route/credential changes): one Rust
  `process_stale` feeds both the pump and the predicate; `heldTurn()` reports
  `stale` from the latest desired config; a stale process waits for the next
  turn (`process_changed`). Tests: the predicate table and
  `live({stale:true}) -> 'process_changed'` in
  `tests/test-held-turn-injection.js`; the pump uses the same call.
- M4 (`_streamSessionId -> cliSessionId` was Node logic): the native session
  record owner normalizes at load (`normalize_claude_native_id` in
  `native/addon/src/session_records.rs`), `init` returns whether it changed
  anything, `records.loadMigrated` exposes it and `server.js` sets
  `_state.needsSave` so exactly one boot save follows. The Node block in
  `turn-engine.js` is deleted. Tests: "load-time normalisation migrates the
  retired claude -p identity once (M4)"
  (`tests/test-session-records-durable.js`); the adapter test that used to pin
  the Node rewrite now loads the record through the owner first
  (`tests/test-claude-adapter.js`, "a legacy claude -p session carries its
  streaming identity into the SDK lane").
- L2 (cap notice was console-only): `onCapReached` now writes one persisted
  system row and broadcasts one notice per held turn (`heldCapText` /
  `notifyHoldCap` in `src/chat/session-notices.js`, wired as `onHoldCap` in
  `turn-engine.js`). The cap never releases. Tests: "the cap warns instead of
  releasing" (differential), "the hold cap is one visible notice, never a
  release" (held-turn-injection).
- Screenshot case: a background Agent (`local_agent`) keeps the turn open and a
  typed message is answered inside it, with no queue notice. Test: "real sdk a
  typed message is answered inside the turn a background Agent holds open"
  (`tests/test-monitor-admission.js`, real bundled binary).

### Intentional divergences from the frozen oracle (named scenarios)

`tests/test-background-hold-differential.js` keeps the frozen interactive
oracle and pins the deliberate differences in its header plus four named
scenarios: (1) the cap warns instead of releasing; (2) an injected message is
settled by its own answer, never by a self-wake (the oracle's counter); (3) the
turn outcome is the main result / its self-wakes, and injected answers are
separate exchanges; (4) two queued messages are settled by one coalesced answer
in order (observed CLI behaviour; the spec assumed one result per message). The
oracle is unchanged; `mutations of the frozen oracle are all caught by the
differential` still runs.

### Files and size

Rust: `native/core/src/background_hold.rs` +560/-67 (1,133 lines, 16 unit
tests), `native/addon/src/background_hold.rs` +112/-20 (302 lines),
`native/addon/src/chat_events.rs` +36/-1,
`native/addon/src/session_records.rs` +31/-2.
Node: `src/chat/held-turn-injection.js` +47/-69 (the counter, `MAX_REMEMBERED`,
`isDirectUserTyped` and the retry rule removed; 145 lines),
`src/chat/claude-sdk-stream.js` +72/-19 (registration before write, one
staleness call for pump and predicate, `attributable: true`),
`src/chat/background-hold.js` +27/-9 (pass-through of the new owner calls),
`src/chat/chat-stream.js` +8/-23 (legacy injection attempt and
`injectionInFlight` deleted; `attributable: false`),
`src/chat/turn-engine.js` +16/-11 (M4 block deleted, `onHoldCap` added),
`src/chat/session-notices.js` +14/-1, `src/chat/stream-router.js` +2/-2,
`src/session/records.js` +8/-1, `server.js` +15/-1 (M1, M4 boot save).
Scripts: `scripts/rust-source-cache.js` +28/-6 (capability probe rewritten for
the new exports and the `attributable` refusal in the same edit),
`scripts/check-source-line-budget.js` +5/-2 (`server.js` registered at 3,037
lines / 161,434 bytes, ratcheted).
Tests: differential +114/-19, held-turn-injection +76/-17, monitor-admission
+35/-2, session-records-durable +28, claude-adapter +5/-0 (the deleted Node
rewrite's assertion now loads through the owner).

Artifact: fingerprint `047153b8db78edb677eac2ac`, file
`data/rust-source/047153b8db78edb677eac2ac/darwin-arm64/multicc_core.node`
(sha256 `b35ade6c74f2fd7f04880c2830cfdee8650c56fedbda47c6fc59dbf40e5b5484`),
built with `node scripts/ensure-source-rust.js` after the `attributable` fact,
the duplicate-answer rule and `cargo fmt` reflow.

### Verification

`cargo test --workspace` all green (577 core lib tests plus every other suite),
`cargo fmt --check` clean after formatting, clippy has no new diagnostics in the
three touched Rust files (the pre-existing warning classes elsewhere are
unchanged). Focused JS against the artifact: differential 9/9,
held-turn-injection 11/11, session-records-durable 12/12, claude-sdk-stream
15/15, claude-adapter 9/9, monitor-admission 12/12. Repro outputs after the fix:
`repro_hold.js` - `beginInjection(m1,uuid)` answers
`{"action":"write","uuid":"1111..."}`, a self-wake leaves `injections: 1` and
prints "not released (the typed answer is still pending) - FIXED", the answer
releases with `result:"WAKE"`, `injected_exchanges:[{identity:"m1",result:"USER
ANSWER",usage:{input_tokens:3},total_cost_usd:0.03}]` and
`injected_usage:{input_tokens:3}`; `repro_c5.js` - release keeps
`result:"TASK ANSWER"` with the injected exchange separate ("turn result kept:
true injected kept separate: true"); `repro_dup.js` - attempt 1
`{"delivered":false,"reason":"row_not_persisted"} writes=1 appended=0`,
attempt 2 `{"delivered":true,"identity":"cm-1"} writes=1 appended=1`,
"DUPLICATE WRITES (must be false): false".

Not verified: no service restart and no real-account end-to-end turn (the
coordinator restarts), so held-turn behaviour on the live service is proven by
the real-binary harness (`test-monitor-admission.js`) and the differential, not
against the user's account. The `_streamSessionId` normalisation was exercised
only on temp files, not on a copy of the production session store. Queued
messages were observed coalescing only in the fixture's fake upstream; whether
a real provider always coalesces back-to-back injections is not proven (the
settlement rule tolerates both shapes).

## 持有回合修复：独立复核后的最终协议（2026-11-10）

本节修订上方 `7407beef` 初版的状态机和验证结论。初版已有 UUID 归属，但独立复核确认仍有合并回答重复计量、写入尚未完成即视为成功、历史失败后提前释放、注入回答没有独立历史行等问题。本轮在既有实现上修复，未重做已完成的回合进度迁移。

### 回合何时结束

Rust `Hold` 分别记录注入预登记、stdin 写入确认、按 UUID 归属的回答、用户消息历史确认和回答历史确认。自然结束必须同时满足：后台工作结束、没有正在生成的查询、所有注入收到自己的回答、所有用户消息及回答已保存，且经过静默窗口。超时上限只提示，不强制释放。

- 预登记后、写入完成前，同身份重入返回 `injection_in_flight`，不写第二次，也不确认投递成功。
- 已确认写入的身份重试只补历史；即使目标配置已经改变，也允许补这条历史，不向旧线路写新消息。
- 历史读取失败不能充当保存成功。回答先于写回调到达可证明消息已收到，迟到的写失败不能撤销这一事实。
- `origin.kind=task-notification` 优先判为自唤醒，不结算注入；重复结果不清除另一条正在生成的查询状态。
- 取消或进程死亡仍可终止回合。这是存活回合内的去重和保存协议，不承诺跨进程崩溃的持久化“恰好执行一次”。持续写盘失败会保持等待并重试。

### 回答、用量与历史

SDK 的 `usage` 是每次查询的用量；`total_cost_usd`、`modelUsage` 是累计快照。一个结果覆盖多个用户 UUID 时仅计量一次。释放事件的 `held_usage` 汇总所有唯一查询，费用和模型用量取最新快照；移除不正确的 `injected_cost_usd` 累加。主回合结果仍取主回答或最后自唤醒，注入回答不能顶替它。

每个真实查询结束生成 `held_query_result`。Rust reducer 捕获该段文本与工具，生成独立历史行，ID 包含回合、runner 和查询序号；一个合并回答只保存一行，用 `heldIdentities` 关联多个提问。提问历史未确认或前一个回答尚未保存时，只捕获该段，不提前追加；重试使用同一行，不占用下一查询的输出缓冲。只有保存成功才 ACK 回合所有者。

Web 和 Flutter 的 `held_query_boundary` 只结束当前回答气泡，保持整轮运行。最终收尾恢复主回答/自唤醒的正文及错误状态，避免向 dispatch/gateway 返回空正文，也避免注入 API 错误污染主回合。历史去重通过 Rust 查询身份判断，防止相同文字的不同回答互相覆盖。

后端决策留在 Rust。Node 改动限于 SDK 写入确认、历史读写端口、ACK 回调及兼容门面；这些端口依赖现存 SDK/历史宿主，待相应宿主迁出后再移除，不增加 Node 业务状态机。

### 产物和验收

最终源码指纹：`46a42cacfe17093efea241eb`。
原生模块 SHA256：`df6e709daf0d64c1ff183ad55517887f783c374b0769fb204b280c585866648c`。
源码指纹、产物来源和接口探针均已独立核对。主仓证据目录：
`data/rust-source/46a42cacfe17093efea241eb/validation/held-turn-review/`。

已完成事件/历史专项 159/159、Web 专项 84/84、Flutter 22/22；源码预算、858 项测试分层、两项治理及格式检查通过。完整 npm 与 Rust 工作区最终结果已收取，详见以下验收收据。

初轮回归中 SDK 用例因只保留最近 5 帧而遗漏已流出的回答；测试现单独保存 assistant 事件，失败项已通过。Rust 并发工作区测试一项既有分享控制测试超时，串行复跑该项已通过。两次失败日志保留，不计为通过。历史 `/tmp/held-observe.out` 有清理失败，也不作为整组通过的证据；真实 SDK 的最终证据使用隔离假上游测试，不涉及真实账号或生产配置。

最终只读复审核对上述改动和原生产物短测，未发现剩余确认阻断项。本轮没有提交、合并、推送或重启生产服务；部署验收尚未执行。

### 最终验收收据

- `npm test` 完整进程退出 0；node:test 统计 6787 项，6784 通过、0 失败、2 跳过、1 待办。跳过及待办为既有测试；手写脚本与门禁均随完整命令通过。
- `cargo test --workspace -- --test-threads=1` 完整退出 0，27 组共 792 项通过、0 失败（core 580）。
- 架构依赖门禁已精确登记历史查询身份规则使用共享原生加载器，相关架构/历史测试 47/47；未放宽其他模块依赖。
- 只读复审无剩余确认阻断项；构建者和复审代理均已完成，全部本轮测试进程已结束。
- 五步修复计划已完成。本轮保留工作树改动，不提交、不合并、不推送、不重启；整体 Node 退出迁移和生产部署不在本次完成声明内。
- 机器可读收据：上述证据目录中的 `receipt.json`；完整日志 `npm-test-verified.log`、`rust-tests-serial.log`。初次失败日志同时保留。

## 迟到复审追加核对（2026-11-10，第 6 步）

收到的复审针对旧版7407beef，不能直接套用到上一轮46a42产物。逐项核对后，以下问题已被前轮覆盖：显式自唤醒origin优先于UUID、无后台但注入未答仍触发cap通知、自然结束等待用户与回答历史ACK、唯一查询用量累加及最新费用快照。旧报告关于合并结果“用量只计一次”的结论不适用于其原始代码，前轮已用双UUID复现并修正。

本轮补齐仍存在的失败出口：

- 注入失败仅带errors数组、或synthetic错误正文未进入缓冲时，Rust生成可读错误行；有部分输出时追加错误说明，取消也明确显示“这条消息的回答已取消”。原46a42产物上新增429错误数组用例确实失败（空正文），新产物通过。
- cancel/立刻插入终止持有回合前，Rust给所有未答注入生成独立取消结果，关联原identity/UUID，保留已生成的部分。取消事件不能冒充真实stdin写入确认；主回答保持原有完成结果。用户历史已保存且存储可写时取消回答随边界落盘，强制终止不因此承诺跨崩溃持久化。
- settings读取失败直接传播，不能把异常当作配置未变化而复用旧进程；SDK真实子进程测试确认后续请求未写入旧进程。
- 已确认写入且已有持久历史的注入，由Rust返回已投递结论，直接确认出站项，避免当前hold内重复claim/defer。仅历史存在而无当前hold写入证明的普通消息仍沿原有runner接管校验，不能错误确认未执行消息。

明确保留的边界：未重新ensure配置时，不保证即时发现凭据值轮换；provider/model/accounts/pendingConfiguration的记录摘要比较仍有效，不能把它描述为所有凭据的热变化检测。注入查询失败单独显示，不重跑已完成的主回合；独立查询自动重试未实现。显式取消、进程死亡及跨崩溃的持久化恰好一次仍不在本协议保证内。旧生命周期随机差分不覆盖新增注入协议；新协议由专门的归属、并发写、保存顺序、失败及取消用例验证，不声称与旧计数器行为等价。

最终指纹：`2b8946a0992a22fdd59b3465`；原生SHA256：`6818663a6652dfaf1f98c4d16a27b55a6144966ee2238024a6c07b5687c7527c`。源码/来源/接口探针全部匹配。最终定向回归175/175（0失败、0跳过），Rust持有回合专项20/20；覆盖真实SDK取消、错误历史、投递去重、配置异常、历史顺序、架构和源构建缓存。预算、858项测试分层、两项治理、格式及diff检查通过。

证据目录：`data/rust-source/2b8946a0992a22fdd59b3465/validation/held-late-review/`。本轮未重跑全量npm或Flutter；前节全量结果只适用于当时46a42产物，不冒充本轮验证。本轮没有新派发代理，全部测试/构建已结束；没有提交、合并、推送或生产重启。追加第6步核对与以上修补完成，已知边界如上。

## 聊天收尾执行迁移（2026-11-10）

本批接续“聊天历史与收尾执行”边界，完成 `finalize-host.js` 执行器的 Rust 接管。原有收尾规划器继续复用；历史服务和其文件存储尚未迁完，不将本批计为整个聊天历史迁移完成。

### 实际所有权

- `native/core/src/chat_finalize_execution.rs` 控制重试计划转收尾、写历史前后两阶段执行、写入后重新读取持久化事实，以及用量提交失败时阻断终态副作用。
- `native/addon/src/chat_finalize_execution.rs` 使用现存活对象桥接调用宿主端口，保留循环引用、runner 身份、回调接收者、结果/副作用对象引用及冻结行为。会话字段更新、错误提示、异常后的安全清理也在 Rust 内执行。错误正文用 UTF-16 字符串拼接，避免 Rust 的有损字符串转换改变旧文本。
- Node 门面由 293 行缩到 56 行，只保留端口验证、原生入口和 Promise 拒绝处理。原生能力探针增加 `chatExecuteTurnFinalization`，旧产物不能被误认为具备新接口。没有生产 Node 回退路径。
- 历史写入必须返回严格的 `true` 才确认 append 成功；写入后的实时 `turn.resultDurable` 再交给现有规划器。用量失败继续阻断完成、分类、冻结和成功通知；后处理端口仍被调用，以保留原有持久化守卫和日志行为。

Node 保留范围及原因：现存历史、调度、广播等服务仍持有宿主对象和回调，本批只通过端口调用；Promise 的异步拒绝监听保留为运行时适配。未新增 Node 业务状态机。待相应历史与宿主服务拥有者迁入 Rust 后，再移除这些端口；本批没有把文件扫描或批量计算加入同步原生回调，也不宣称性能提升。

### 兼容验证和失败记录

冻结对照 `tests/helpers/legacy-chat-finalize-host.js` 已核实与当前 HEAD 的迁移前执行器一致（仅注释和引用路径不同）。新增执行差分覆盖 260 组正常/错误/取消/重试组合、350 组随机计划、端口异常、Promise 拒绝、循环引用、对象身份和 UTF-16 文本；原规划器差分继续保留。

隔离网关测试改为在测试子进程中替换 SDK 二进制定位器。原因是 Claude 聊天统一到内置 SDK 后，旧 `CLAUDE_CMD` 假进程入口已不再控制聊天。取消断言等待取消事务的 `task_state` 快照，而非把更早到达的普通结束通知当成取消事务完成。仍使用真实网关、服务端及 Rust lane，覆盖正常结束、无结果异常/正常退出、排队续接、中途取消和取消后新消息；没有访问真实模型账号。

保留的失败日志包括：初次未完成代码的泛型类型声明编译错误；UTF-16 对照在修复前的真实失败；旧 SDK 测试入口失效；取消状态的即时断言竞态；源码守卫仍指向旧 Node 执行器；Cargo 开发缓存缺少 SQLite 生成文件；首次完整 npm 因只指定模块路径、未同步指定打包器的预编译目录而有 3 项桌面打包失败。仅清理 SQLite 依赖的开发构建缓存后重跑 Rust 全量；完整 npm 使用同一指纹的 `MULTICC_RUST_ADDON` 和 `MULTICC_RUST_PREBUILT_DIR` 重跑。上述失败不计为通过，也没有降低业务断言来绕过失败。

### 产物及范围

源码指纹：`cb2936acc8799461257bec7a`。
原生模块 SHA256：`4ddb8c46d400b6e3b033a6ee8b1ede3bda424cb16c61cfb44d34e41762914dd2`。
来源记录、当前源码指纹及接口探针一致。

最终产物已通过定向回归 174/174、更新后的生命周期/时间线守卫 61/61、隔离服务端流程；Rust 串行工作区 27 组共 796/796（core 584）。源码预算、858 项测试分层、两项治理、Rust 格式与 diff 检查通过。

完整 npm 第二轮执行到最终原生阶段：node:test 汇总 6795 项，6791 通过、1 失败、2 跳过、1 待办，整个命令退出 1。唯一失败为既有 `test-rust-cpr.js` 的“有效 SSE 帧续期空闲预算”测试；它在原生整组串行运行中也失败，不能简单认定为并行负载导致。旧产物 `2b8946a0992a22fdd59b3465` 与本批产物各自单独运行完整 CPR 文件均为 33/33 通过。本批没有修改 CPR 实现或放宽该计时断言，间歇失败的根因尚未确定。

随后使用同一最终产物执行完整 `npm run test:native`，退出 0，最终 Rust 接口测试组 256/256；前序 deterministic、contracts 等阶段在完整 npm 中已通过。由此各阶段都有通过证据，但没有把失败的单次 `npm test` 标成成功，也不声称已修复 SSE 测试的间歇问题。2 项跳过、1 项待办保留原有状态；没有运行 Flutter 或生产账号验收。

证据目录：主仓 `data/rust-source/cb2936acc8799461257bec7a/validation/chat-finalize-execution/`。`receipt.json` 保存最终产物、工作树文件哈希与逐项退出状态；所有初次失败及复跑日志同时保留。本批迁移、兼容验证与记录 3/3 完成，测试进程均已结束。

本批不提交、不合并、不推送、不重启生产服务。下一批继续迁移 `src/session/chat-history-service.js` 的历史规范化、去重、缓存与写入事务边界，以及相应宿主历史端口；它们仍在 Node，不在本批完成声明内。

## 收尾迁移合并与历史服务迁移（2026-11-10）

用户授权后，上一批 12 个已验收文件按收据哈希核对，提交为 `972abf4f26864ce408da11037439506ec6cdc667`，经会话 merge API 合入 main：`7ca016e4`。操作 `merge-back_mwafwkb2_a2205c3b8f36` 返回 `published`、`syncedBack: true`；已确认 main 包含功能提交、分支差距为 0/0、合并后的工作树干净。新增功能及合并提交的英文和作者/提交者身份检查通过，身份均来自根目录策略的 `lsjwzh <lsjwzh@gmail.com>`。没有推送或重启生产。

随后完成聊天历史服务的原生接入：`src/session/chat-history-service.js` 从 521 行缩到 84 行，`native/addon/src/chat_history.rs` 成为历史服务缓存、缺失编号标记及事务顺序的唯一所有者。

- Rust 执行读入规范化、空 thinking 清理、旧 Thinking 结果副本清理、前缀去重、interim 替换、分页和最新回答时间查询。查询身份规则与聊天事件处理共用同一函数，独立持有查询的相同正文不会被合并。
- Rust 保留任务引用保护与拒绝删除错误的任务详情；保留策略仍只控制读取窗口，不因窗口大小删除历史存档。
- 文件端口正常返回后才更新服务缓存并发布提交事件；端口抛错时不发布新缓存。提交后全局/局部回调错误不能撤销已成功写入，错误处理自身失败也被隔离。已有“文件端口通过抛错报告失败”的契约不变，未增加跨进程恰好一次保证。
- 消息保持共享只读对象身份，写操作只复制数组，`read()` 和结果访问才深复制。原生状态不跨宿主回调持有可变借用，允许同步重入；已返回视图及结果仍是各自时刻的快照。

Node 保留范围和原因：参数校验、公开方法转发、JSON/延迟 getter 的 ECMAScript 对象适配；延迟 getter 只缓存单个返回结果的副本，不持有历史服务缓存或决定业务流程。文件读写端口仍由现有 `chat-history-file-repository.js` 提供，未在兼容门面增加业务逻辑。待原生接口接管文件仓库及调用端的异步持久化边界后继续移除端口。此次不宣称性能提升，没有额外全量克隆历史；现有热路径对象身份测试继续验证这一点。

冻结对照 `tests/helpers/legacy-chat-history-service.js` 已与合并后 HEAD 的旧实现核实，仅修改引用路径。新增差分覆盖规范化、归属/任务保护、动态分页策略、写入及删除失败、持久投递查证绕过缓存、提交后回调错误、同步重入，以及 300 步固定种子混合操作；原结果、完整端口轨迹和持久状态逐步对照。新增文件已登记核心确定性测试层和 npm 架构测试入口。

产物指纹 `2023db9ebf8e0cd16e810c9c`，模块 SHA256 `e175ad3b695032de942a5a7238edadde3da1a922fefdb6d594e76a5690158b50`。来源记录与接口探针核对通过。历史专项 87/87、新增差分 6/6、真实隔离网关流程通过；Rust 串行工作区 27 组 796/796（core 584），退出 0。源码预算、859 项分层（核心 414）、两项治理、Rust 格式和 diff 检查通过。

完整 npm 初次在发布门禁停止：新增差分已登记核心层，门禁的审计计数仍为 413，实际为 414。补齐此内存/固定时钟测试的核心层审计说明和计数后，按原顺序从失败门禁继续执行 `test:governance`、`test:provider-router`、`test:desktop`、`test:standalone`、`test:contracts`、`test:native`，六个阶段均退出 0，最终原生组 256/256。前序核心、任务、安全、状态、Git、桥接和架构阶段在初次完整命令中已通过；各阶段覆盖完整，但不把第一次退出 1 的命令记成退出 0。此前 SSE 计时用例在本批通过，不据此宣称已修复其间歇失败根因。

证据在主仓 `data/rust-source/2023db9ebf8e0cd16e810c9c/validation/chat-history-service/`，包含 `receipt.json`、源码文件哈希、初次门禁失败和后续完整阶段日志。历史服务这批实现、验证、记录 3/3 完成，所有本轮测试进程均已结束；没有运行 Flutter 或生产账号验收。本批历史服务改动保留工作树未提交，未随上一批一并合入 main。

后续边界为文件仓库适配器及宿主历史端口，整体 Node 退出和生产部署仍未完成。上一批 SSE 计时测试的间歇失败记录保留，不将服务迁移当作该问题已修复的依据。

## 历史文件仓库协议迁移（2026-11-10）

继续推进前已核对上一批历史服务提交 `a1ec978e` 和 main 合并 `43d84913`：当前分支与 main 对齐，工作树干净。该事实替代上一节“历史服务改动保留工作树未提交”的交付状态；上一节测试结果仍只归属其原产物。

本批将 `chat-history-file-repository.js` 从 329 行缩到 35 行。`native/addon/src/chat_history_repository.rs` 拥有文件名净化、旧 JSON 数组/JSONL 读取规则、可见性状态校验、持久投递查证、按消息引用识别共享前缀、追加/替换尾部选择、行末字节偏移账本及失败清理；删除与重命名的操作顺序也在 Rust。写入端口成功之后才记录偏移，任何写入异常都会清除该文件的旧记录。

Node 例外明确限于文件系统与路径 API 绑定、已有私有目录/原子写入基础设施、调用转发及默认参数适配。宿主历史调用链仍要求同步写入确认，可注入文件系统也须保持异常对象和接收者身份；因此本批保留这些同步 IO 端口，未将同步端口包装成假异步，也未新增扫描范围。后续须连同宿主历史端口和所有调用者的等待/ACK 边界一起改为异步 Rust IO。本批是仓库状态与协议迁移完成，不表示历史存储全链路或 Node 退出完成，不宣称性能提升。

冻结旧仓库只位于测试 helper。差分逐步比较返回值、异常、文件调用顺序及持久字节，覆盖 400 步固定种子多会话操作、BOM/旧数组/JSONL、尾行损坏与非尾损坏、UTF-16、权限/读写/截断/关闭错误、fsync 容错、重命名部分失败、可见性侧文件及同步重入。追加热路径额外验证已写前缀不会重新序列化。原生复核去掉了序列化字符串在 Rust/引擎之间的多余复制，并补齐删除视图时路径转换异常所属的内层 catch。

既有边界按迁移约定保留：尺寸校验不能发现同尺寸外部覆盖；旧端口不校验成功返回的短写字节数；重命名历史与视图不是跨文件原子事务；缺失历史主文件时删除不会清理孤立视图。这些兼容差分不证明并发写安全或跨崩溃恰好一次，不以迁移名义顺带改变旧协议。

### 主线门禁缺口

首次治理检查发现 main 新增的 `test-run-config-preset-apply-cdp.js` 未登记分层，且 `run-config.js` 为 3179 行，超过已有 3171 行上限。补登记为 flow/cdp；将新加的 OpenCode 线路可用性判断归入已有 `chat-ai-config.js` 模型目录模块，保留冷缓存与别名规则。`run-config.js` 回到 3171 行，字节预算从 161873 收紧为 161847，没有提高上限。相关现有 UI/CDP 回归 73/73 通过，无跳过。

### 验证记录

原生源码指纹 `9a1e4e2df3d43a2c49410388`。最终定向回归 158/158 通过，其中仓库差分 12 项；初轮指纹 `e1c5f36970251c5b81a7e935` 的 139/139 记录单独保留，不冒充最终产物验证。861 项测试分层、源码预算、仓库产物治理、运行时写入治理及格式检查已通过。

证据目录：主仓 `data/rust-source/9a1e4e2df3d43a2c49410388/validation/history-repository/`。完整 `npm test` 本次退出 0；node:test 统计 6813 项、6810 通过、0 失败、2 项既有跳过和 1 项既有待办。最终原生接口组 256/256。真实隔离网关收尾流程、会话删除与历史保留 HTTP/WebSocket 流程均退出 0。Rust 串行工作区退出 0，27 组共 796/796（core 584），无失败或跳过。本轮不提交、不合并、不推送、不重启生产；下一批边界仍是宿主历史端口的异步确认与 Rust 文件 IO。

后续异步化必须同步处理 `src/routes/chat-history.js` 的 `appendMessage`、增量计时保存、批量隐藏/清空与提交后广播，以及 `turn-engine.js` 的直接持久投递查证和 `appendHeldAnswer` 回调。特别是持有回合的历史 ACK 与收尾规划器不能把未等待的 Promise 当作已保存；本批没有改变这些调用者的同步返回契约。

最终原生模块 SHA256：`bdba54c7c4801dad50dda711a880c360452d9f1d4a143bd674adf5c5deaab00a`。源码指纹、产物来源与能力探针一致；`receipt.json` 登记本批全部改动文件哈希及各验证结果。本批仓库协议迁移、兼容验证、记录 **3/3 完成**，所有构建与测试进程均已结束。此前 SSE 空闲计时用例本次通过，不据此宣布其间歇失败根因已修复；没有运行 Flutter 或生产账号验收。新改动保持未提交，下一步由本会话继续推进宿主历史端口与异步 Rust IO。

## 历史仓库文件 IO 归 Rust（2026-11-10）

本批把 `src/session/adapters/chat-history-file-repository.js` 从上一批的 35 行缩到 29 行（协议迁移前为 329 行）：历史文件的全部文件 IO 改由 `native/addon/src/chat_history_repository.rs` 用 `std::fs` 与 `multicc_core::state_file` 完成，Node 侧只剩数据根计算、原生所有者构造与同步转发。没有可注入文件系统、没有 `writeText`/`ensureDir`/`path` 端口，也没有 Node 回退路径。

Rust 现在唯一拥有：文件名净化调用顺序、JSON 数组/JSONL 读取、可见性状态校验、持久投递查证、按引用识别共享前缀、追加/替换尾部/全量重写选择、行末字节偏移账本与失败清理、原子写入步骤（mkdir/临时文件/fsync/rename/chmod/目录 fsync）、append 模式权限位、重命名与删除的顺序及可见性侧文件。解析规则仍调用宿主 `JSON.parse`/`JSON.stringify`/`String`/`replace`/`split`/`trim`/`slice`，因为调用方需要真实 JS 消息对象及其 getter 语义；这些是 ECMAScript 适配，不是文件 IO，也不构成第二条实现。冻结旧仓库只保留在 `tests/helpers/legacy-chat-history-file-repository.js`，生产代码不引用。

Node 兼容错误映射集中在新模块 `native/core/src/node_fs_error.rs`：`io::Error` → `{ code, errno（Node 的负 libuv 值）, description（uv_strerror 文本） }`。Unix 通用 errno 可移植匹配；Linux 与 macOS/BSD 的不可移植值（ENAMETOOLONG/ENOSYS/ENOTEMPTY/ELOOP/EOVERFLOW/EDQUOT）分别列值；未知错误按 `ErrorKind` 回退。Windows 表按 libuv `uv/errno.h` 的 `_WIN32` 回退值修正为 ENOENT -4058、EACCES -4092、EBADF -4083、EBUSY -4082、EEXIST -4075、EINVAL -4071、EINTR -4072、EAGAIN -4088、EPIPE -4047、ENOSPC -4055、ENOTEMPTY -4051、ENOTDIR -4052，以及回退用的 ETIMEDOUT -4039、UNKNOWN -4094。表本身是普通 `const` 数据、不按 `cfg(windows)` 裁剪，core 单元测试在所有平台逐行钉住原值与负 errno；本批仍未在 Windows 构建或运行，只固定常量与映射元数据。`native/addon/src/node_fs_error.rs` 负责构造 JS `Error`：消息为 `"${code}: ${description}, ${syscall} '${path}'"`，rename 为 `"${code}: ${description}, rename '${src}' -> '${dest}'"`，并设置可枚举的 `errno`/`code`/`syscall`/`path`/`dest`；syscall 名与 Node 一致（缺失文件打开为 `open`、目录读取为 `read` 且不带 path、`stat`/`open`/`write`/`fsync`/`unlink`/`rename`/`chmod`/`scandir`/`mkdir`）。`state_file` 增加带阶段信息的 traced/bytes 写入器，历史仓库据此复现 Node 对各步骤的 syscall 归属；既有调用方仍用原来的 `io::Result` 接口。

持久化失败上报保留为唯一的 Node 宿主端口：`server.js` 通过 `stateStore.setFailureReporter` 安装 `multicc_persistence_failures_total` 计数与 `persistence_failure` 日志。`src/state/store.js` 现导出 `reportFailure(error, meta)`，把当前上报器包在 try/catch 中（上报器自身抛错不得改变调用方看到的错误），`writeTextAtomic` 的两个内部调用点也统一走它，因此只有一条路径。适配器把该函数放进原生构造器的 `ports`；Rust 只在旧 `writeTextAtomic` 会上报的位置调用它——历史 transcript 与可见性文件的原子重写失败（`operation: 'atomic_write'`，mkdir 分支为 `'mkdir'` 并上报原始 fs 错误、抛出的仍是 `[state-store] mkdir ...` 包装错误），且传入即将抛出的同一个 JS 错误对象与归一化前的目标文件路径；append、`ensurePrivateDir`、unlink/rename/delete 不上报，与旧实现一致。移除条件：当 `server.js` 的持久化 metric/logger 迁入 Rust（或该指标改由 Rust 直接记录）时，删除此端口及 `store.js` 的 `reportFailure` 导出，Node 侧不再保留任何上报回调。

`state_file::WriteStage` 删除了从未构造、若保留会被误标为 `fsync` 的 `Close` 变体；文件句柄由 Rust `File` 析构关闭，close 错误被吞掉这一既有边界不变（Node `closeSync` 会传播）。其余阶段（Mkdir/ChmodDir/OpenTemporary/Write/Fsync/BeforeRename/Rename/ChmodTarget/OpenDirectory/FsyncDirectory）都有实际构造点或明确保留的 hook 映射。

差分测试改为真实文件系统：冻结 helper（真实 `fs` 与真实 `atomicWriteText`）与原生仓库各在两个 `fs.mkdtempSync` 临时根上执行同一操作，逐步比较返回值、异常（name/message/code/errno/syscall/path/dest，根路径与 `.tmp.<pid>.<n>` 归一化）、持久化失败上报记录（次数、`operation`、归一化 `target`、错误字段）以及整个磁盘状态（相对路径、字节十六进制、权限位）。覆盖旧数组、JSONL、BOM、空文件、尾行损坏、非尾损坏、非法 UTF-8、UTF-16/星号平面/孤立代理项、增量追加、尾部替换、全量重写、外部尺寸变化、同尺寸外部覆盖、`appendEnabled=false`、可见性读写与校验、重命名目标存在/源缺失/侧文件、删除缺失主文件与孤立视图、列举排序、投递证明、`allowEmpty`、400 步固定种子多会话序列，以及真实故障（只读文件 EACCES 读取/写/截断、只读目录 EACCES 删除、历史文件为目录 EISDIR、数据根为普通文件 EEXIST/ENOTDIR、写入失败后偏移账本失效再恢复）。故障用例同时断言“预期故障确实发生”（`expected code`），避免故障未注入时双方都返回成功却被判通过。上报端口另有专项断言：EISDIR rename 故障恰好一次 `atomic_write`、目标为 transcript、错误 code/errno/syscall/path/dest 与旧实现逐字段相同；只读文件追加的 EACCES 双方均为零次上报；上报器自身抛错时抛给调用方的 EISDIR 不变。可见性写入 `undefined` 状态仍按旧 `atomicWriteText` 的 `String(value)` 写成 `"undefined"`，读取随后是 JSON 语法错误；差分保留了这一字节结果。

发现并解决的行为差异两处：其一，Node 的 `mkdirSync(dir, { recursive: true, mode: 0o700 })` 会把 mode 应用到它新建的每一级父目录，而 Rust `create_dir_all` 只用默认权限建父目录。首次差分在“只写视图隐式创建历史根”时发现原生根为 0755、旧实现为 0700；现按创建前探测缺失祖先并对新建目录逐个 chmod 0700，差分通过。其二，`writeTextAtomic` 的 mkdir 分支吞掉 EEXIST 后由临时文件 open 暴露真实失败，`create_dir_all` 却会把“目标路径是普通文件”直接报成 EEXIST；`state_file` 现同样忽略 EEXIST 并继续，根为普通文件时与 Node 一致地在 open 处得到 ENOTDIR（历史仓库的 `ensureRoot` 在更早处仍按旧顺序报 EEXIST，差分保留该差异形状）。

保留的既有边界：尺寸校验发现不了同尺寸外部覆盖（双方都信任尺寸，差分显式固定该行为）；不校验成功返回的短写字节数（Rust `write_all` 与 Node `writeSync` 的差异在该路径上不可观测）；`File` 析构吞掉 close 错误而 Node 会传播 `closeSync` 错误；重命名 EACCES 不可在自有目录上产生（重命名前 `ensureRoot`/`ensurePrivateDir` 会恢复 0700）；`[state-store] mkdir` 包装分支经历史仓库实际不可达（写前已确保目录），仅为形状与上报语义一致而保留并由 `state_file` 单测钉住；历史与视图重命名不是跨文件原子事务；主文件缺失时删除不清理孤立视图；ENOSPC、fsync EIO、短写无法用真实文件系统经 `std::fs` 诱发，本批不为注入故障增加第二套 IO 抽象，因此这些分支只用 core 单元测试断言其错误映射元数据。Windows 常量表由跨平台单测钉住，但没有 Windows 运行时验证。

验证（均使用最终产物 `data/rust-source/b8092041a0b436a9b2acadfd/darwin-arm64/multicc_core.node`，SHA256 `c2cc695bea4a057fa619ef9b503cbf8a7946629197d06036cd59210b9abb9303`，17719744 字节）：

- `node --test tests/test-history-repository-differential.js`：17/17 通过（新增持久化上报一致性与上报器抛错两项）。
- `node --test tests/test-session-domain.js`：29/29 通过（原 `writeText`/`fsImpl` 注入改为 inode 观察：原子重写更换 inode、追加/截断保持 inode；权限用例改为真实 chmod 000 文件）。
- 要求的 11 文件 `node --test` 组合：158/158 通过。
- `npm run test:architecture`（带 Rust 环境变量）：node:test 108/108 通过，`test-detached` 全部通过。不带 `MULTICC_RUST_ADDON` 时会加载不到新原生模块而失败，属运行环境缺失，不作为回归结论。
- `node --test tests/test-desktop-shell.js`（带 `MULTICC_RUST_PREBUILT_DIR`）：39 通过、0 失败、1 项既有跳过。
- `node scripts/check-source-line-budget.js`、`check-runtime-write-inventory.js`、`check-repository-artifacts.js`：均退出 0（45 项写入治理、4 项既有产物基线；预算 `public/run-config.js` 3171→3000、`server.js` 3037→3000 为既有债务收紧记录）。
- `cargo fmt --manifest-path native/Cargo.toml --all --check` 退出 0；`cargo clippy -p multicc-core -p multicc-addon --all-targets` 退出 0，改动文件无诊断（其余为既有告警）。
- `cargo test --manifest-path native/Cargo.toml -p multicc-core`：588/588 通过（含新增的跨平台 Windows libuv 常量表用例）。上一轮记录的 `workspace_sharing::control::tests::create_reads_live_context_and_timed_out_context_never_mutates` 计时抖动本次未复现，未修改该测试，也不宣称已修复其根因。

独立对抗复核（只读，基于实现代码自行取证）提出六项：持久化失败上报失声、Windows 四个 libuv errno 常量错值、运行路径 `.expect()` 可能跨 napi 中止进程、`WriteStage::Close` 死分支、故障用例未断言故障确实发生，以及 close 错误被吞。前五项均已按上文修复并有用例固定；close 边界本地文件系统无法诱发，保留并记录。

完整 `npm test`（同时设置 `MULTICC_RUST_ADDON` 与 `MULTICC_RUST_PREBUILT_DIR` 指向上述最终产物）：node:test 合计 6818 项，6814 通过、1 失败、2 项既有跳过、1 项既有待办。唯一失败是 `tests/test-rust-cpr.js` 的「Rust 传输的有效 SSE 帧续期空闲预算而无需 Node 再解析」（`UND_ERR_SOCKET other side closed`），即前几批已登记的 SSE 空闲计时间歇失败；该文件不涉及历史仓库，随后单独连跑 5 次均 33/33 通过。不据此宣布其根因已修复。首轮全量缺少 `MULTICC_RUST_PREBUILT_DIR` 时桌面打包 3 项报“打包缺少 Rust 模块”，属测试环境变量缺失，补齐后 `tests/test-desktop-shell.js` 39 通过。日志在主仓 `data/rust-source/b8092041a0b436a9b2acadfd/validation/history-io/`。没有运行 Flutter 或生产账号验收，未重启生产服务。

合并前 main 前进 8 个提交（无人值守功能，含原生改动），本批 rebase 无冲突后按新指纹 `1722e12cac65c2f4404555ee` 重建（原生模块 SHA256 `a50e0f166c5cc4f8b623700babd057683c81d794138ae29da1f112d7bafc118e`）并复验：11 文件定向组合 158/158，三个治理脚本退出 0，本批 4 个 Rust 文件 rustfmt 检查通过（`cargo fmt --check` 唯一差异在 main 新增的 `native/core/src/unattended.rs`，非本批改动，未顺带修改）。完整 `npm test` 在 `test:core` 末段 `test:task-first` 停止，唯一失败为 main 新增 `chat-unattended.css` 的 `@keyframes unat-pulse` 动画 `box-shadow`，违反 `tests/test-air-paint-budget.js` 的“永续动画只碰 transform/opacity”门禁；本批未改动 `public/` 与该测试，与 main 字节相同。其余 14 个阶段（`test:task-board-auto` 至 `test:native`）逐个单独运行均退出 0。两段合计 node:test 6868 项，6864 通过、1 失败（上述 main 红项）、2 项既有跳过、1 项既有待办。日志在主仓 `data/rust-source/1722e12cac65c2f4404555ee/validation/history-io-rebased/`。

下一批边界（只读调研已完成）：把 `src/routes/chat-history.js` 宿主运行时的同步核心归 Rust 单一所有者——可见性缓存（删除 `chat-history-visibility.js`）、分页/重放/投影、`appendMessage` 打标与提交后广播顺序、增量保存计时表（Rust 经 `setTimeout`/`clearTimeout` 端口持有句柄，`clear` 同步生效）、被裁消息攒批蒸馏、`annotateTurn`、`hideMessages`；WS 广播、记忆蒸馏、CLI/git/handoff、`projectMessages`、`taskShortCode`、日志保留为宿主端口；删除从未调用的必需依赖 `saveBestEffort`、`trackPendingMemoryDistill`。所有调用方的同步返回契约不变；`clearHistory`/rotate 中 await git 快照的异步流程与 context-level 路由推迟。异步化必须同时改变 `turn-engine.js`、`appendHeldAnswer` 与收尾规划器的等待/ACK 契约，不能把未等待的 Promise 当作已保存。

## 历史宿主运行时同步核心归 Rust（2026-11-10）

本批把 `src/routes/chat-history.js` 从 837 行缩到 539 行，删除 `src/session/chat-history-visibility.js`（57 行），新增 `native/addon/src/chat_history_runtime.rs`（1522 行，napi 类 `RustChatHistoryRuntime` 加两个纯函数导出）。生产代码只剩一个所有者：`RustChatHistoryRuntime` 独占可见性缓存、蒸馏缓冲与增量保存定时器表；历史服务仍是同一个 `RustChatHistory` 实例（`createChatHistoryServiceWithOwner` 只暴露既有 owner 与 anchor，运行时通过 `owner.run(anchor, ...)` 派发），没有第二个服务或第二份缓存。

Rust 现在唯一拥有：可见性缓存与全部操作（filter/hide/clear/remove/removeMany/invalidate，`chat-history-visibility.js` 已删）；任务短码标注与投影；蒸馏批次缓冲与 `distillHistoryIntoMemory` 的同步抛错/异步拒绝日志；`handleCommittedHistoryEvent`（append/remove/delete 广播、去重消息攒批、`setImmediate` 复盘调度）；`load`/`viewHistory`/`projectedMessages`（含 `projectMessages` 抛错回退与 `chat_history_projection_failed`）/`paginate`（around/before/limit 边界、`Object.freeze` 与 JSON 克隆隔离）；`hideMessages`；`latestAssistantAt`；`lastActivity`；`appendMessage`（id 生成、活会话 taskId/turnId 打标、任务码、assistant `durationMs`、afterCommit 写 lastActivity、失败日志与同步布尔 ACK）；`annotateTurn`（turnId 选择、锚点回退、替换/广播失败日志）；增量保存定时器表（`setTimeout`/`clearTimeout`/`unref`、每会话一个、`stopped` 复检、文本 <20 与 tools/taskId 规则）与 `stop()`。`publicCommittedMessage`、`buildReplayMessages` 的规则也迁入 Rust，仍从 `src/routes/chat-history.js` 以同名导出，行为、冻结与字段顺序不变。

保留在 Node 的部分与移除条件：

- `clearHistoryUnsafe`/`clearHistory`：先 `run('clearVisibility')` 再 `paginate` 并广播 `chat_history_reset`，`await` 与 broadcast 顺序、`{...result, clearedNativeSessions: 0}` 与失败包装错误码都保持旧实现。移除以 `turn-engine.js`/`appendHeldAnswer` 的等待/ACK 边界改成异步 Rust IO 为前提。
- `rotateNativeContext`/`rotateNativeContextUnsafe`：等待 `cliSwitchGitSnapshot`、`sessionPersistence.mutate` 的 handoff 事务与 `chatStream.close` 顺序。移除条件同上（异步会话持久化进 Rust）。
- `mountRoutes`（Express 路由）与 context-level 路由：Express 仍在 Node；context-level 需要惰性 `opencodeContextReader`、`transcript-prune` 与 `cwdForSession`。移除条件是把路由归属迁到 Rust 前门时。
- 端口 `history`（原生仓库转发器）、`service`/`serviceAnchor`（既有原生服务）、`chatSessions`、`idFactory`、`clock`、`chatBroadcast`、`distillHistoryIntoMemory`、`maybeSchedulePeriodicMemoryReview`、`taskShortCode`、`retentionPolicy`、`projectMessages`、`logger`、`sanitizePublicText`、`setTimeout`/`clearTimeout`/`setImmediate`：宿主对象/ECMAScript 适配或唯一外部契约。`postPersist` 仍是 JS 端口，因为 `RustChatHistory::emit` 的外部契约就是调用 `ports.postPersist`（与 `afterCommit` 顺序固定），运行时直连会改变服务对外契约；移除条件是把 postPersist 回调注册也纳入服务构造的原生 API。
- 删除死依赖：`saveBestEffort`、`trackPendingMemoryDistill` 从 `assertChatHistoryDeps` 必需列表与 `server.js` 的本运行时注入移除（其他运行时仍用 `saveBestEffort`）。

发现并解决的行为差异（均由新差分测试捕获）：

1. around 分页的 `before` 取错下标：旧实现返回 `messages[start].id`，初版 Rust 返回 `messages[start-1].id`。已改成 `start`。
2. 蒸馏异步拒绝处理：Rust 用 `call_plain` 调 `Promise.resolve`，`this` 为 undefined，触发 `PromiseResolve called on non-object`，被服务的 postPersist 错误处理捕获成 `chat_history_post_persist_failed`，而不是 `chat_history_memory_distill_failed`。改为以 `Promise` 构造器为 receiver 调用。
3. 增量保存 tick 的 try 边界：旧实现把 interim 构造（含 `clock()`）、任务码标注与 `upsertInterim` 一起放在 try 内，初版 Rust 只捕获 `upsertInterim`。已按旧边界包住整个构造段。
4. `clearVisibility` 的 `retainedCount`（独立复核发现，用户可见回归）：旧实现是 `visible.length - removed.length`，其中 `visible` 含 `_interim` 流式尾；初版 Rust 用 `completed.length - removedCount`。3 条已完成 + 1 条 `_interim` 时旧实现返回 `retainedCount: 1`，初版返回 0，并直接进入 `chat_history_reset` 广播与 `clearHistory` 返回值（`public/chat-event-controller.js`、App `chat_provider.dart` 消费）。已改为按整个可见视图计数，并新增差分用例与显式数值断言（removedCount=3 / retainedCount=1）。

差分 harness 自身也暴露两点非运行时差异：`idFactory`/`taskShortCode` 都是构造时捕获的端口，测试改成通过端口内部模式注入失败，而不是替换 deps 属性；旧实现读取两者时同样是捕获引用。

独立复核与协调者全量分阶段跑共提出五项，处理如下：

1. `npm run test:security` 门禁红：`tests/test-chat-history-store.js` 断言旧源码文本 `visibility.clear(key, keep)`。该断言原本证明“持久可见性清除先于 reset 广播”。现改为匹配新调用形状 `run('clearVisibility', key, keep)`，并在同一 `clearHistoryUnsafe` 块内用索引比较显式断言“清除在广播之前”；同一顺序在差分测试里另有行为断言（`writeVisibility` 轨迹先于 `broadcast`），不是只改正则。全域 grep 确认没有其他测试读取 `src/routes/chat-history.js` 或已删除的 `chat-history-visibility.js` 源码文本。
2. `clearVisibility` 的 `retainedCount` 回归：见差异 4，已修复并有差分与显式数值断言。
3. 覆盖缺口：差分测试补上 `clearHistory` 与 `rotateNativeContext`（见下），删掉 `trace.length >= 0` 的同义反复断言，改为对可见性文件与投影结果的真实比较；并新增“`appendMessage` 原地写入调用者对象（id/taskId/turnId/taskShortCode/durationMs）、`load()[0]` 不是同一对象”的双端断言。
4. 已知差异（仅记录，不修）：非法参数的 `TypeError` 文案不同——`paginate(s, null)`、`annotateTurn(s, null, patch, null)`、对只读 `id` 的消息 `appendMessage`，两端都抛 `TypeError`，但消息文本不同。这些不是生产路径（调用方都传合法参数或对象字面量），本批不新增字符串映射。
5. 流程更正：此前报告的指纹 `da45f177…` 在最后一次构建后已被 `scripts/rust-source-cache.js` 的编辑超越（该脚本参与指纹）。本轮所有编辑完成后重新构建，指纹与产物见下。

测试证据（最终产物 `data/rust-source/b83e547741e4250a3dd1986d/darwin-arm64/multicc_core.node`，SHA256 `c1cc1a246759c8644e23293f05f1d47fb24f8a979904f8416c4820b4090625c1`，17951136 字节；所有测试均同时设置 `MULTICC_RUST_PREBUILT_DIR` 与该 `MULTICC_RUST_ADDON`）：

- `node --test tests/test-chat-history-runtime-differential.js`：15/15 通过。双端各自使用真实临时数据根、真实文件仓库、同一套假端口与固定种子；逐步比较返回值（含同步布尔、冻结状态、克隆隔离）、抛出错误、完整调用轨迹（广播载荷、蒸馏、复盘调度、定时器 create/clear/unref、日志、`chatSessions` 与 `persistedSessions` 活对象写入、git 快照/checkpoint/stream close 顺序）、持久记录与磁盘字节，覆盖追加、去重蒸馏攒批与 aux 排除、同步抛错/异步拒绝、复盘与 stop 复检、隐藏、分页、标注、增量保存、最近活动、重入、**`clearHistory`（keep 0/默认/2/超界/负数/非数字、interim 尾部、已隐藏、durable 失败抛错且不广播、返回形状与 `Object.freeze`、清除先于广播）**、**`rotateNativeContext`（未找到/非 chat/pending 复用/runState 三种忙/后台任务/成功 mutate+close+广播/快照失败/persist 失败/preserveHistory 委托与失败透传/缺 rotation 端口）**、追加原地写入与 clone 隔离，以及 320 步固定种子多会话序列。红证：把 `retainedCount` 临时改回旧表达式（`completed.length - removedCount`）重新构建后，新用例按预期失败（legacy `retainedCount: 1`、native `0`），恢复修复后重新构建得到同一指纹与同一 SHA256。`clearHistory` 用例不传带进行中内容的 `chatState`（`buildReplayMessages` 的 `ts` 默认取真实 `Date.now`），因此比较字段全部确定。
- `node --test tests/test-chat-history-store.js`：16/16 通过（含改写的 reset 顺序用例）；`npm run test:security` 退出 0：node:test 1138 项，1137 通过、0 失败、1 项既有待办，`test-ws-backpressure` 14/14。
- 要求回归的 8 文件 `node --test` 组合（routes、task-history-retention、chat-dto-golden、chat-history-ordering、chat-history-differential、history-repository-differential、session-domain、architecture-boundaries）：113/113 通过。既有测试只改了 `tests/test-chat-history-store.js` 的上述源码文本断言；没有其他既有测试引用被删除的 `chat-history-visibility.js`。
- `npm run test:architecture`：node:test 123/123 通过，`test-detached` 全部通过。
- `node --test tests/test-release-version-consistency.js`：5/5 通过。新测试登记为 `tests/test-tiers.json` 的 core/deterministic（owner/entrypoints = `npm:test:architecture`），复核计数更新为 419 entries、345 deterministic、391 commands（388 Node entries）；`node scripts/check-test-tiers.js` 报告 873 项已分类（core 419）。
- `node scripts/check-source-line-budget.js`、`check-runtime-write-inventory.js`、`check-repository-artifacts.js`：均退出 0（`server.js` 迁移债务按实测下调为 3038 行 / 162261 字节；45 项写入治理；4 项既有产物基线）。
- `rustfmt --edition 2021 --check native/addon/src/chat_history_runtime.rs native/addon/src/lib.rs`：退出 0；`cargo clippy -p multicc-core -p multicc-addon --all-targets` 对 `chat_history_runtime.rs` 无任何诊断（其余为既有告警）；`cargo test --manifest-path native/Cargo.toml -p multicc-core`：620/620 通过。
- `npm run test:core`：本轮按协调者指示未重跑。上一轮（修复前产物 `da45f177…`）观察到退出码 1，唯一失败为 main 既有红项 `tests/test-air-paint-budget.js`（`chat-unattended.css` 的 `@keyframes unat-pulse` 用 `box-shadow`）；node:test 三段合计 2914 项，2913 通过、1 失败。该数字不代表当前产物，当前产物由协调者全量复跑。

下一批边界：`clearHistory`/rotate 的异步流程、context-level 路由，然后才是 `turn-engine.js` 等历史调用者与异步 ACK（把 `appendMessage` 的同步布尔变成可等待的持久确认）。本批不提交、不合并、不推送、不重启生产。

## 异步持久投递证明迁移（2026-11-10）

本批把回合准入所依赖的 `hasPersistedDelivery` 读盘证明迁到 Rust 工作线程。历史文件仍沿用既有 JSON 数组与 JSONL 协议；Rust 读取字节、跳过 BOM、识别空文件与损坏行、检查 `deliveryId`/`clientMsgId`，并把 Node 兼容错误形状作为异步结果返回。`hasPersistedDeliveryAsync` 已登记进原生接口探针，文件仓库与历史服务仅保留 Promise 适配。

解析使用仓库已有的 `multicc_core::js::json_parse`，保持 JavaScript 的 `JSON.parse` 语义：溢出指数成为数字、任意合法大整数不因 `serde_json::Number` 范围被拒、孤立 UTF-16 代理项可进入字符串、重复键采用最后值且保留首位置。异步文件名净化也按 UTF-16 code unit 替换，因此非 BMP 会话名与旧 JavaScript 正则产生相同文件名。空行判定使用统一的 ECMAScript whitespace，而不是范围更宽的 Rust `char::is_whitespace`。

`turn-engine` 在应用待定配置前等待持久证明，并把同一次结论传给重放判断和 `reexecutePersistedDelivery`，避免准入阶段重复同步读盘。重放配置仍跳过；已确认持久且此前 runner 未接管的投递仍可重新执行而不重复追加用户消息。`appendMessage` 的写入本身仍走既有同步确认，本批只迁移只读投递证明，不宣称历史写入已异步化。

Node 保留范围及原因：`chat-history-file-repository.js` 负责把原生异步结果恢复为 Node `SyntaxError`、带 `code/syscall/errno` 的错误，以及 Promise 边界；`chat-history-service.js` 为现有同步测试端口保留同步兼容分支；`turn-engine.js` 只增加等待和单次结论传递。这些是现存 Node 宿主和历史调用链的迁移期适配，不承载 JSON、文件名或投递匹配业务规则；等写入确认与宿主历史端口也迁入 Rust 后可以移除。

最终源码指纹：`5fe511783598eec347e3d77a`。原生模块 SHA256：`ba3d8994f660b6139dc39edc0232403711cd9cf6fbf23ba6be98d117866d432e`，17951184 字节；源码来源记录与当前指纹一致。验证覆盖 8 个历史/回合相关测试文件 193/193，架构 124/124，安全 1138/1138（另 1 项既有 TODO），契约 131/131，原生接口 256/256。Rust 工作区串行测试 27 个目标中 832 项通过、0 失败（core 620）；源码预算、测试分层、写入治理、产物治理、addon 格式与 `cargo check` 均通过。

完整 `npm test` 的真实退出码为 1；唯一下降门禁是 main 既有的 `tests/test-air-paint-budget.js`，`chat-unattended.css` 的 `@keyframes unat-pulse` 使用 `box-shadow`。该文件不在本批修改范围；契约和原生接口已另行用同一产物补跑通过。当前仍未覆盖：`appendMessage` 的异步持久确认、`clearHistory`/context rotate 的异步文件与 git 顺序、进程取消或跨崩溃投递的恰好一次语义。

本批以英文提交合入本地 main，不推送、不重启生产服务；整条聊天历史与宿主端口迁出 Node 后才能声明 Node 后端退出完成。

## 聊天历史异步持久确认迁移（2026-11-10）

本批把 `appendMessage` 从同步布尔确认改成可等待的持久确认。Rust 在 `prepareAppend` 中完成消息打标、规范化、去重、interim 清理和完整快照构造；原生工作线程随后执行原子全量写或共享前缀增量追加，并在成功后由 `commitAppend` 一次性发布缓存、执行 `postPersist`/`afterCommit` 和广播。写盘失败不会发布缓存或回调，调用方得到 `false`，并可用同一逻辑消息重试。增量追加的 `fsync` 失败与本批新增的损坏/失败路径也保持失败关闭。

同一会话的普通 append 在 Node 门面中按 Promise 链 FIFO 串行，不同会话仍可并行；Rust 仍保有待提交快照和操作身份，缓存及通知只在对应写盘完成后前进。用户消息、Aux 历史、通知、取消 partial 保存和持有回合注入均已等待该确认。`task-context-host` 同时提供异步端口和显式同步端口，服务组合分别接线，避免同步 reducer 把 Promise 误当作持久 ACK。

Node 保留范围及原因：

- `src/routes/chat-history.js` 只保留 Promise 队列、HTTP/WS 宿主调用与同步兼容门；消息规则、快照、事务、缓存和通知顺序归 Rust。
- `src/session/adapters/chat-history-file-repository.js` 只把原生异步结果恢复为 Node 兼容错误和 Promise 边界；文件名、文件协议与实际 IO 归 Rust。
- `persistFinal`、错误正文、CLI switch、自动路由备注、无人值守 trace、通知兼容分支和关停 partial checkpoint 当时仍需要同步 verdict，暂时使用非枚举的 `appendMessageSync`。异步队列占用时该入口失败关闭，禁止旧写入覆盖新快照。**该兼容入口已在 2026-11-11 的「删除同步历史追加入口」批次整体删除，所有调用方改为等待异步持久确认，见文档末尾。**
- WS 广播、记忆蒸馏、`projectMessages`、HTTP 路由和 clear/rotate 中的 git 快照仍由 Node 宿主承担；这些是后续迁移边界。
- 当前保证覆盖进程内存中的存活会话。取消、进程死亡或跨崩溃的“恰好一次”投递仍未承诺；`clearHistory`/context rotate 的异步文件与 git 顺序也未并入本批事务。

提交前复核另外修正了任务分离的异步接线：`visibleHandoff` 现在等待每个目标历史 append 完成，只有返回非 `false` 的行才计入 `landedIds`；目标写入失败时不会提前隐藏源消息。新增行为测试验证所有目标消息落盘后才隐藏源消息，并验证目标写入返回 `false` 时源 transcript 保持不变。

验证使用最终 Rust 产物 `bb56db286986e3ebd7a9016a`，模块为 18,000,752 字节，SHA-256 为
`dd7a65297c19d389ccc2116fb7be6bbb403fa1662d24bd73b25157359e49ae7a`；源码指纹、来源记录和接口探针一致。
任务分离专项 28/28，历史、任务上下文和 Claude 接线专项 119/119；安全 1138 通过、0 失败、1 项既有 TODO；
架构 126/126；契约 131/131；原生接口 256/256。Rust workspace 串行测试 27 个测试目标共 832 项通过、0 失败（core 620/620）。
源码预算、874 项测试分层、格式、diff、来源/接口预检、治理 20/20 与产物治理均通过。

完整 `npm test` 的真实退出码为 1。其中 `test:core` 的 node:test 统计为 438 项，437 通过、1 失败；
唯一失败仍是 main 既有的 `tests/test-air-paint-budget.js`：`chat-unattended.css` 的永续 `unat-pulse` 动画修改
`box-shadow`。该 CSS 与相关功能由最近的 `7b83f852` 引入，不在本批改动范围。完整日志、最终 core/security 日志、
Rust 串行日志和机器可读收据保存在
`data/rust-source/bb56db286986e3ebd7a9016a/validation/async-history-append-final/`。本批合入本地 main 后不推送、
不重启生产服务；整体 Node 后端退出仍未完成。

## 无人值守轮次结束统一入口迁移（2026-11-10）

本批修复无人值守会话在宿主侧取消（process watchdog、stalled recovery、provider log watchdog、重启/关停、CLI switch）后仍保持 `active`、输入被锁住却没有任何进程在跑的死锁。根因不是取消本身，而是取消通知只走 `dispatchStateAction` 的 cancel 分支：该分支只对 `source === 'manual_cancel'` 调用旧的 `onManualCancel`，而 E 分支的 `onFault` 又被 `error && !cancel` 挡掉。宿主侧取消据此既没有故障续接、也没有暂停，调度器在 `frozen` 里一直等到 12 小时截止或新的用户消息。

迁移到 Rust 的决策：

- `native/core/src/unattended.rs` 新增 `decide_turn_end`。它接收 `{state, now, kind, settle, cancelSource, killReason, retryScheduled, backlogPending}` 这些事实，返回唯一动作 `evaluate | fault_continue | needs_human | pause | none`。D/W 结算评估；E 故障在 API 策略已排重试时不动；用户取消一律暂停（带新消息的取消标成 `pausedBy:'input'` 接管）；宿主侧取消按故障续接；无法识别的取消源保守暂停；非活跃会话不做任何事。故障上限、连续故障计数清零、暂停状态字段与消息文案都在 Rust。
- 原有 `decide_fault` 的主体抽成共享的 `fault_decision`，`decide_turn_end` 的 cancel/fault 两条路径复用同一策略，避免两份上限/文案。
- `native/addon/src/unattended.rs` 新增 `unattendedDecideTurnEnd` 导出，并登记进 `scripts/rust-source-cache.js` 的接口探针。
- 新增 Rust 单元测试 9 条：清结算清除故障计数、D 有积压时推迟、策略重试不重复注入、用户取消暂停、宿主取消故障续接、连续三次宿主取消转 `needs_human`、未知取消源暂停、真实用户消息接管、非活跃会话空操作。协调审查后再补 6 条：用户归因故障暂停、同轮重复报告空操作、后到用户取消只暂停、每轮记录轮次标识、判决重建保留宿主账本、`retryScheduled` 必须布尔。

Node 保留范围及原因：

- `src/unattended/kernel.js` 只做 JSON 编解码，没有 JS 决策回退；`decideFault` 的 JS 包装被删除。
- `src/unattended/host.js` 的 `onTurnEnd` 是唯一宿主入口：它取任务状态/调度器状态、读取 D 结算时是否有暂存 FIFO、调用内核、执行动作（写状态、注入 `UNATTENDED_TAG` 续接指令、应用 `needs_human`、释放被扣住的经典 push）。它只传递事实，不判断该继续还是暂停。每轮以持久化 `turnId`（内核 `lastTurnEndId`）去重：同轮重复报告为空操作，后到的用户归因只暂停不再注入。
- `reconcileStartup` 在 `orchestrationRuntime.start()` 之后回放“启动前已结算”的取消轮次；判定依赖持久化 `cancelSource`、`lastSettleAt` 水位、当前轮次 `startedAt` 和调度器是否已有活跃槽位，保证一次结算最多注入一次。逐个会话 try/catch 隔离，汇总并记录失败会话数；`server.js` 只增加三个事实端口和一次启动收尾调用。
- `src/classify/state-machine.js` 的 D/W/E/cancel 四个出口统一改成调用 `onTurnEnd`，取消归因（source/reason）原样传给内核。

验证（第一轮当时的产物 `data/rust-source/c8652b8b11667edddb6268c0/darwin-arm64/multicc_core.node`，SHA256 `d255bf72d87952677c56157a1471a76d02b9801782bb84adc4e5d0daa043e538`，17,984,304 字节；测试均设置 `MULTICC_RUST_PREBUILT_DIR` 与该 `MULTICC_RUST_ADDON`；`scripts/rust-source-cache.js` 对当时产物返回 `c8652b8b11667edddb6268c0 true`，`probeAddon` 为 true）：

- 三个改动测试文件：67/67 通过（`test-unattended-supervisor.js` 39、`test-classify-api-error-state.js` 24、`test-unattended-fifo-order.js` 4）。测试使用真实 native 内核与真实 classify 状态机，只有外部端口是替身。
- 红证（旧产物 `5bdc813368a7238d76de6170`，同一批测试 63 项中 7 项失败）：宿主 5 条——`a non-boolean retryScheduled is rejected instead of being coerced`、`a user-caused fault pauses for every user source, regardless of kind or retry`、`a second report for the same turn is a no-op`、`a D settle then a duplicate cancel report injects exactly once`、`a handled turn end is not replayed from task state after a restart`；classify 2 条——两个 observer 到达顺序测试。新测试先红后绿。
- 相关回归组合 17 个文件（api-error 策略与宿主、cancel-state-flow、processing-watchdog、provider-log-watchdog、session-delivery、session-work host/scheduler、stalled-turn-recovery、unattended-routes、wait-injector、orchestration-runtime、turn-state-rules、held-turn-injection、turn-error-veto）：343/343 通过。
- `npm run test:security`：node:test 1139 项，1138 通过、0 失败、1 项既有 TODO；`test-ws-backpressure` 14/14。`npm run test:architecture`：126/126。`npm run test:contracts`：134/134。
- `cargo test -p multicc-core`：635/635 通过（本批新增 6 条：用户故障暂停、同轮重复报告空操作、后到用户取消只暂停、每个动作轮次记录轮次标识、判决重建保留宿主账本、`retryScheduled` 必须布尔）。`rustfmt --check` 对本批新增代码干净；`native/core/src/unattended.rs` 仍有多处既有格式差异（未整文件重排）。`cargo clippy -p multicc-core -p multicc-addon --all-targets` 对本批代码无新诊断，仅剩既有告警（如 `build_state` 参数过多）。
- `node scripts/check-source-line-budget.js`、`check-runtime-write-inventory.js`（45 项）、`check-repository-artifacts.js`（4 项既有基线）均退出 0；`scripts/check-test-tiers.js` 退出 0（874/874）；`node --test tests/test-release-version-consistency.js` 5/5。本批未新增测试文件，因此没有改测试分层清单；`server.js` 因启动回放失败汇总新增 8 行，按棘轮登记为实测 3053 行 / 163405 字节（上一登记 3045/163172）。
- 按协调者要求未跑 `npm test`/`test:core`，也未跑会打活服务的 `tests/test-classify-api-errors*`。

### 第二轮审查修正（2026-11-10）

本批在第一轮统一入口上修四处审查项，最终产物为
`data/rust-source/37d770f9166a634029c0c543/darwin-arm64/multicc_core.node`，
SHA256 `80a7647110ab4569912ede3416e6882e19cd5b1dd513bc6af25829b313b6c023`，
17,984,304 字节；来源记录与接口探针均返回 `37d770f9166a634029c0c543 true true`。
本小节取代上面的第一轮回执，作为本功能的最终验收依据。

- 高：取消轮的轮次标识。`src/chat/turn-engine.js` 在回合开始、拉起提供方之前把
  `turnId` 持久化为 `activeTurnId`，`src/classify/state-machine.js` 的四个结算出口
  统一把它清空。`src/session-work/host.js` 的 `runCancel` 依次取内存
  `_activeTurn.turnId`、处理中状态的持久 `activeTurnId`，两者都没有时生成新的
  `turn_recovery_<uuid>`，**不再回退 `taskState.turnId`**（那是上一轮的结算标识）。
  旧写法会让看门狗取消命中 `lastTurnEndId` 变成 `duplicate_turn`：注入 0 次、会话保持
  `active`、输入锁死；取消迁移还会把旧 id 写回任务状态，令下次启动回放永久吞掉。
  `reconcileStartup` 新增 P 态回放：无取消记录但持久了 `activeTurnId` 的轮次按
  `restart_recovery` 回放一次，且只在调度器既无活跃也无排队项时执行。
- 中：核实 `shutdown`/`cli_switch`/`relocate`。CLI 切换在忙态（`configurationBusy`）
  只做暂存、下一轮边界应用，不会杀活回合；`forced` 分支无生产调用方。会话迁移默认
  拒绝活跃会话，任务板移动带 `force` 时才杀进程，杀进程后的进程退出收尾会以
  `killReason:relocate` 的 E 故障经同一入口上报；关停直接杀进程、不保证回合结束报告，
  由下次启动的 P 态回放兜底。三种主机中断事实（`shutdown`/`cli_switch`/`relocate`）
  都新增了经唯一入口续跑的用例。文档已按上述真实行为改写。
- 中：`policy_retry` 不再认领回合。`native/core/src/unattended.rs` 在
  `retryScheduled:true` 时只返回 `none/policy_retry`，不写 `nextState`，因此
  `lastTurnEndId`/`lastSettleAt` 都不变；API 重试复用同一个 turn 对象，其随后的
  D/W/E 结算仍正常评估。Rust 与宿主两层各有同 turnId 的后续 D 结算用例。
- 低：用户接管后的排队续跑撤回。监督器的 `inject` 改走 session delivery
  （`deliverSystem`），拿回调度器准入结果里的 `entry.id` 与 `queued`；任何离开
  `active` 的状态写入（暂停/达成/需人工/超时/错误）都会对仍处于排队的条目调用
  `sessionScheduler.cancelQueued(entryId)`。已被调度器领取的投递交给正常取消路径。
  撤回表在内存中，重启后不撤回（届时由持久回合结算负责）。调度器已有该能力，
  因此不新增 Node 调度逻辑，也没有遗留已知限制。

验证（全部使用上述最终产物，同时设置 `MULTICC_RUST_PREBUILT_DIR` 与
`MULTICC_RUST_ADDON`）：

- 改动测试文件 74/74 通过（`test-unattended-supervisor.js` 44、
  `test-classify-api-error-state.js` 24、`test-unattended-fifo-order.js` 6）。
- 红证：临时把 `runCancel` 恢复成旧的 `taskState.turnId` 回退、并关掉启动 P 态回放后，
  `test-unattended-fifo-order.js` 成功 4、失败 2——(d) 取到 `turn-prev` 而非
  `turn-current`，(e) 启动回放结算 0 次；恢复修复后同一用例全绿。
- 17 个相关回归文件 343/343 通过。
- `cargo test -p multicc-core`：635/635。`rustfmt --check` 对本批新增代码无差异
  （`native/core/src/unattended.rs` 仍有多处既有格式差异，未整文件重排）；
  `cargo clippy -p multicc-core -p multicc-addon --all-targets` 对本批代码无新诊断，
  只剩既有告警（`build_state` 参数过多等）。
- `npm run test:security`：1139 项，1138 通过、0 失败、1 项既有 TODO；
  `test-ws-backpressure` 14/14。`test:architecture` 126/126（`server.js` 按棘轮
  更新为 3057 行 / 163703 字节）。`test:contracts` 134/134。
- 治理：运行态写入清单 45 项、仓库产物 4 项既有基线、测试分层 874/874、
  `test-release-version-consistency` 5/5，源码预算检查退出 0。
- 按协调者要求未跑 `npm test`/`test:core`，也未跑会打活服务的
  `tests/test-classify-api-errors*`。完整套件已由主会话在 `c8652b8b` 上跑过
  （6916 项，6912 通过，唯一失败为既有 paint-budget）。

未覆盖/不确定：跨进程崩溃的“恰好一次”注入仍不承诺；本功能保证单进程内
`lastTurnEndId` 轮次去重、`lastSettleAt` 水位与启动回放不重复，且回放只接受当前轮次
`startedAt` 之后的事件（关停/强制拆除留下的 P 态轮次按 `activeTurnId` 回放）。排队撤回
只覆盖尚未被调度器领取的条目，已被领取的由正常取消路径处理；撤回表在内存中，重启后
不再撤回。宿主侧取消与真实用户取消的归因依赖 `cancelSource`/`killReason` 字符串集合，
新来源必须同时更新 Rust 与文档规则表。本批不提交、不合并、不推送、不重启生产。



### 第三轮审查修正（2026-11-11）

本批最终产物为
`data/rust-source/090eac7d114248e74a14e028/darwin-arm64/multicc_core.node`，
SHA256 `da07572125e1052abcc22a5a3ad78b3e66f229b53540f624a2dd0e842d0f2baa`，
17,984,304 字节；`scripts/rust-source-cache.js` 对本工作区源码算出的指纹与接口探针返回
`090eac7d114248e74a14e028 true true`。本节取代前两轮回执，作为本功能的最终验收依据。

- 门禁红：`src/unattended/host.js` 的启动扫描删除了 P 态回放分支，原先那处
  `=== 'P'` 字母比较随之消失；`tests/test-classify-vocab.js` 单独运行 23/23。
  门禁脚本对每个测试文件递归展开后组合运行，不再出现
  `inline classify-letter comparisons must go through the vocab predicates`。
- 孤儿回合恢复改为单一负责方。核实处理看门狗在两种持久 P 形态下都会处理：
  调度器 `recover` 留下的冻结 `legacy-active:<id>`（`frozen/classify_running`），
  以及完全没有调度项的空闲状态；两者都由同一检测路径以
  `cancelSource:process_watchdog` 走唯一结算入口。因此删除 `reconcileStartup`
  的 P 回放及其桩测试，启动只回放有取消记录（`cancelSource` + `cancelledAt`
  晚于 `lastSettleAt`）的轮次。新增真实调度器端到端用例：持久 P +
  `activeTurnId` + 运行中的调度项 → `outbox.recoverExpired` + `scheduler.recover`
  → 看门狗 → `fault_continue`；续跑可被领取，暂存的“内置任务已中断”类通知
  只在续跑那一轮 D 结算后被排空，全程恰好一次 `UNATTENDED_TAG` 注入（两种形态各一条，
  均不用桩）。不再依赖 `duplicate_turn` 兜底第二次结算。
- 回合准备失败会即时结算：`src/chat/turn-engine.js` 在 compose 失败、流式被拒、
  进程缺失和兜底异常四个出口调用同一个幂等 `settlePreparationFailure()`，
  经 `host.cancelActiveTurn`（唯一结算入口）清空 `activeTurnId` 与内存轮次标识；
  `native/core/src/unattended.rs` 的宿主取消来源表新增 `preparation_failed`
  （共 9 个），判定仍在 Rust（宿主故障 → `fault_continue`），Node 不新增业务规则。
  旧产物上该用例没有续跑、会话停在 P；新产物上用例 (h) 通过且只结算一次。
- `activeTurnId` 不再单独全量落盘：`src/classify/state-machine.js` 的
  `ensureCurrentTask` 在续跑分支和新建任务分支的同一份 P 补丁里写入
  `activeTurnId`，`turn-engine.js` 删除了随后那次单独的 `setTaskState(..., {save:true})`。
  `tests/test-cancel-state-flow.js` 记录 `save` 标志并断言每个分支恰好一次保存、
  补丁同时含 `classifyState:P` 与 `activeTurnId`，另有静态断言禁止旧的单独写入；
  每轮保存次数没有增加。
- 已知限制：监督器撤回表只在内存中，重启后已进入 FIFO 的监督器续跑无法撤回；
  已按“记录、不修”写入 `docs/unattended-mode.md`。
- 文档：`docs/unattended-mode.md` 的 “A shutdown or forced teardown…” 段落已按
  最终行为改写——孤儿恢复唯一归处理看门狗，启动只回放已记录的取消，并写明冻结项
  与无调度项两种形态的生效时间点、续跑 D 结算后清空暂存通知、以及撤回表的重启限制。

验证（全部使用上述最终产物，同时设置 `MULTICC_RUST_PREBUILT_DIR` 与
`MULTICC_RUST_ADDON`；`test:rust` 的 `MULTICC_RUST_PREBUILT_DIR` 指向指纹根目录，
因为 `tests/test-subagent-defaults.js` 会删除 `MULTICC_RUST_ADDON` 后自行拼接
`<目录>/<platform>-<arch>/multicc_core.node`）：

- `tests/test-classify-vocab.js` 单独运行 23/23。
- 本批改动的 5 个测试文件 `test-unattended-supervisor.js`、
  `test-unattended-fifo-order.js`、`test-cancel-state-flow.js`、
  `test-chat-turn-core.js`、`test-classify-api-error-state.js` 合计 159/159。
- 按 `package.json` 的 `test:core` 递归抽出的全部测试文件组合运行：266 个文件、
  3551 项全部通过，退出 0（按协调者允许跳过既有的
  `tests/test-air-paint-budget.js`）。
- `npm run test:security`：1139 项，1138 通过、0 失败、1 项既有 TODO；
  `test-ws-backpressure` 14/14。`test:architecture`：126/126。
  `test:contracts`：134/134。`test:governance`：分层 874/874、Node 用例 20/20、
  运行态写入清单 45 项、仓库产物 4 项既有基线。
  `npm run test:rust`：256/256。
- `cargo test -p multicc-core`：635/635。`rustfmt --check` 对本批新增代码无差异
  （`native/core/src/unattended.rs` 仍有 339 行既有格式差异，未整文件重排）；
  `cargo clippy -p multicc-core -p multicc-addon --all-targets` 仍只有 8 条既有告警，
  本批新增代码无新诊断。`node scripts/check-source-line-budget.js` 退出 0
  （`server.js` 3057 行、`public/run-config.js` 3171 行属既有迁移债登记）。
- 按协调者要求未跑 `npm test`、`npm run test:core`，也未跑会打活服务的
  `tests/test-classify-api-errors*`；未提交、未 stash、未重启服务、未向活服务写。

## 删除同步历史追加入口（2026-11-11）

根因：2026-11-10 的异步持久确认批次留下了同步兼容门 `appendMessageSync`。它无法加入同一会话的 Promise 写入队列，队列被占用时只能失败关闭返回 `false`。最终答复、错误行、CLI switch 通知、自动路由备注、无人值守 trace 和关停 partial checkpoint 都还在用它，而大多数调用方拿 `false` 只当“没写成”，不会重试也不会报错：一次在飞写入就能让这些行静默消失。Rust chat-event reducer 也只能拿到布尔值，无法表达“写入尚未确认”。

本批把全部调用方改成等待异步持久确认，然后整体删除同步入口，不留回退、不留开关。

### 两阶段最终答复持久化

- Claude reducer 在成功的 `result` 事件里不再同步调用 `persistFinal`。Rust 在 `native/addon/src/chat_events.rs` 里先取 `isMapped` 事实、构造带 usage/timings/contextTrace 的 assistant 消息，然后把 `runner.pendingFinalPersist = true`，调用 Node 端口 `requestFinalPersist(session, cs, turn, runner, message, options, forward, wasMapped, evt)` 后立即返回。端口只负责“开始写”，Rust 不把任何 Promise 或乐观值当持久 verdict。
- 重复的 `result` 事件在 `pendingFinalPersist` 仍为真时直接忽略，第一笔提交独占计数和 result 帧。
- Node 端口启动 `persistFinalAssistantResult`（`appendFinal` → `appendMessage`），等待 fsync 结果后调用新的 NAPI `chatCommitFinalPersist(cs, session, evt, message, forward, turn, runner, durable, wasMapped, ports)`。
- `chatCommitFinalPersist` 先清 `pendingFinalPersist`，再统一重查 `is_current` 和 `isMapped`；只有仍然当前才执行 `recordDurableUsage`、`chatTurnCount + 1`、`_resultSaved = true`、`clearIncrementalSave`，然后构造并转发 result 帧、调用 `onTurnComplete`、原样转发 `evt`。写入判定为 `false` 时与旧的同步 `false` 完全一致：不记用量、不增计数、不置 `_resultSaved`，但仍走后续 result 帧和完成回调。
- 写入期间回合被取消、runner 被替换、映射被移除：提交入口重查失败后只释放 pending 标记，不记用量、不转发帧；调用方的收尾逻辑看到的是“本轮没有持久结果”，不会被下游当成已持久。
- 宿主端口抛错或 Promise 拒绝：`requestFinalPersist` 记 `chat_final_persist_failed` 日志并以 `durable=false` 提交，异常不会逃逸成未处理拒绝。`agent`/`codex`/`finalize-host` 的宿主端口抛错仍交给 Rust 的失败收尾路径冻结本轮，并报告调用方原始 plan facts，与拆分前的同步抛错可见行为一致。

### 持有回合答复与回合收尾

- `appendHeldAnswer` 变成两阶段：Rust 先记录 `historyReady`、`pendingAck` 和 `saving`，启动 Node 写入后返回；新的 `chatCommitHeldAnswer(cs, turn, runner, rowKey, saved, ports)` 设置行 `saved`，只有前面的行都已保存、`historyReady` 为真且 runner 仍然当前时才消费 ACK。用户历史/答复顺序闸门与答复边界 ACK 语义保持不变。
- `finalize-host` 的回合收尾同样拆成两段：Rust `chatExecuteTurnFinalization` 返回 `{ pending, plan, append, sourcePlan }`，Node 等待 `persistAssistant` 后把 verdict 和原始异常交给 `chatCommitTurnFinalization(plan, context, ports, runtime, persisted, fault, sourcePlan)`。失败路径用调用方原始 plan 报告事实，冻结语义与同步端口抛错一致。
- `src/chat/turn-engine.js` 维护 `runner -> Promise<boolean>` 的 `pendingFinalPersists` 映射。`commitAdapterResult` 在任何读取 `resultDurable` / `_resultSaved`、执行 finalize、classify 或关闭流之前先 `await` 该映射；`close` 收尾允许拒绝并记录 `chat_close_handler_failed`，不会让未确认的写入被当成已持久，也不会产生未处理拒绝。
- 宿主关停的 partial checkpoint 仍等待在飞写入，但增加固定上限 `PARTIAL_FLUSH_TIMEOUT_MS`（默认 10 秒，测试可注入 `deps.chatFlushTimeoutMs`）；超时只记录告警，后续 checkpoint 和 closer 继续执行。

### 其余调用方逐项处理

- 必须确认后才继续的：最终答复（两阶段提交）、持有回合答复（两阶段 ACK）、`task-context-host.appendMessage`（只有 verdict 为真才投影到任务板）、Codex usage 的最终消息、`chat-host-coordinator.appendResult` / `finalize` / `host-runtime.persistFinalAssistantResult`（全部 async，等待 verdict）。
- 保持“直播不等待 fsync”但必须观察拒绝的：错误持久化行、自动路由备注、CLI switch 通知、gateway push、无人值守 trace、session notices。它们同步入队以维持同会话顺序，对 Promise 的 `false` 或拒绝只记日志，不会出现未处理拒绝。
- 关停 partial checkpoint：等待写入但受上限保护。
- `appendMessage` 之后立即读历史的调用方均改为先 await 再读（`turn-engine` 的 `commitAdapterResult` 是唯一集中等待点）。

### 删除清单

- `src/routes/chat-history.js`：删除 `appendMessageSync` 及非枚举属性；删除 `appendOne` 里 `deps.history.write` 的同步兼容分支，依赖校验改为要求 `history.writeAsync`。
- `src/task-context-host.js`：删除 `appendSync` 端口和 `appendMessageSync` 导出；只保留唯一的异步 `appendMessage`。
- `server.js`：删除 `appendChatMessageSync` 和 `appendSync` 接线，gateway host、CLI switch、task-context host、host runtime、错误持久化、无人值守、session notices、关停都直接使用 `appendChatMessage`；turn engine 不再接收 `appendChatMessageSync`。
- `native/addon/src/chat_history_runtime.rs`：删除同步 `append_message` 实现和 `"appendMessage"` dispatch；只保留 `prepareAppendMessage` / `commitAppendMessage` / `discardAppendMessage`。
- `scripts/rust-source-cache.js`：接口探针新增 `chatCommitFinalPersist`、`chatCommitHeldAnswer`、`chatCommitTurnFinalization`。
- 测试替身：所有 `createChatHistoryRuntime` 的假仓库都提供 `writeAsync`；服务端口仍需要同步 `write`，因此两个假仓库同时保留 `write`（生产文件仓库本来就两者都有）。旧的同步门测试替换为“并发 append 排队、绝不丢弃”和“未保存的 append 不投影到任务板”。
- `src`、`server.js`、`native`、`scripts`、`tests`、`public` 中已无 `appendMessageSync` / `appendChatMessageSync` / `appendSync` 引用。

### Node 保留范围及原因

- `src/routes/chat-history.js` 仍负责同会话 Promise FIFO、HTTP/WS 宿主调用和依赖校验；消息规则、快照、事务、缓存与通知顺序归 Rust。
- `src/session/adapters/chat-history-file-repository.js` 只把原生异步结果恢复为 Node 兼容错误和 Promise 边界；文件名、文件协议与实际 IO 归 Rust。
- `src/chat/turn-engine.js`、`src/chat/finalize-host.js`、`src/chat/host-runtime.js`、`src/chat/host-coordinator.js`、`src/codex/usage.js` 只保留 Promise 编排与端口接线，判定仍在 Rust。
- WS 广播、记忆蒸馏、`projectMessages`、HTTP 路由和 clear/rotate 的 git 快照仍由 Node 宿主承担，是后续迁移边界。
- `src/session/chat-history-service.js` 的同步 `service.append` 仍供其他所有者使用，不在最终答复路径上；本批没有改动它。

### 未覆盖范围

- 进程死亡、崩溃或跨进程的“恰好一次”投递仍未承诺；两阶段提交只保证进程内一轮不会把未确认写入当已持久。
- `clearHistory` / context rotate 的异步文件与 git 顺序没有并入本批。**已在 2026-11-11 的「历史变更串行化与上下文轮换迁移」批次并入：clear/hide/annotate/remove/interim 全部进入 Rust 的每会话 FIFO，轮换改为两阶段判定并在 git 快照后重判，见文档末尾。**
- `test:cdp` 与 `tests/test-classify-api-errors*` 按既有约定未运行。

### 验证与红证

最终 Rust 产物指纹 `480bb98fa08cc31bf04472e2`，`darwin-arm64/multicc_core.node` 为 18,017,408 字节，SHA-256 `89cbda96450b6fbda765193c43c87745a710937c1664bff356dbdd5e3b919815`；`probeAddon` 与 `builtFromSource` 均为 true。

红证（旧文件拷到 `/tmp` 对比，未污染工作树）：

- 新增的 3 条最终答复两阶段测试对旧 addon `090eac7d114248e74a14e028` 失败：`AssertionError: the result event starts exactly one write / 0 !== 1`、`TypeError: requested is not iterable`、计数 `0 !== 1`；旧 reducer 从不调用 `requestFinalPersist`。同一文件 18 条中 10 条失败（持有回合的 commit 入口也不存在）。
- 改写后的错误持久化测试对 HEAD 的 `src/chat/error-persistence.js` 失败：`AssertionError: The "string" argument must be of type string. Received type undefined`（旧实现异步失败时返回原始 payload，没有错误回放 id）。
- 新增的关停上限测试对 HEAD 的 `src/host-lifecycle.js` 失败：`AssertionError: the flush must actually be awaited`（旧实现不等待持久写入）。
- 旧同步门在队列被占用时返回 `false`；HEAD 里被删除的测试 `the synchronous compatibility door fails closed while the same session is writing` 正是用断言锁住了“返回 false 且该行不落盘”的丢弃语义。用旧二进制单独复现：`4234debe85c8885e817a7292` 上 `appendMessageSync` 抛 `unknown chat history runtime operation`；`090eac7d...` 上队列忙时返回 `false`。

验证命令与结果（均设置 `MULTICC_RUST_PREBUILT_DIR` 为该指纹根目录、`MULTICC_RUST_ADDON` 为其 `darwin-arm64/multicc_core.node`）：

- 改动/新增的 13 个测试文件：220/220 通过（`test-chat-error-persistence`、`test-chat-events-differential`、`test-chat-finalize-differential`、`test-chat-finalize-host`、`test-chat-history-routes`、`test-chat-host-coordinator`、`test-chat-turn-core`、`test-codex-usage`、`test-host-lifecycle-task-run-close`、`test-task-context-host`、`test-chat-history-runtime-differential`、`test-chat-dto-golden`、`test-chat-history-ordering`）。
- 回归批次：144/144 通过（`test-held-turn*`、`test-unattended-*`、`test-cancel-state-flow`、`test-chat-runtime-native`、`test-claude-sdk-host`、`test-background-hold-differential`、`test-auto-route-notes`、`test-server-graceful-shutdown`、`test-shutdown-http-errors`、`test-claude-sdk-stream`）。首次构建后的一次运行里 `test-chat-runtime-native` 的 snapshot 出现过一次 `GenericFailure`，随后同一命令和单独重复 3 次均通过，记为偶发。
- `tests/test-classify-vocab.js` 单独运行：23/23。
- `npm run test:security`：1139 项，1138 通过、0 失败（1 项既有 TODO）。
- `npm run test:architecture`：126/126。
- `npm run test:contracts`：134/134。
- `npm run test:native`：退出 0（node 4/4、Rust 256/256、sqlite/运行时/发布检查均通过）。
- `npm run test:governance`：退出 0（20/20、产物治理与运行态写入 45 项均通过）。
- `cargo test -p multicc-core`：635 通过、0 失败；`cargo test -p multicc-addon` 编译通过（无测试）。
- `rustfmt --check`：本批改动的两个 Rust 文件无 diff。整仓 `cargo fmt --all --check` 仍会在未改动的 `native/core/src/unattended.rs` 报告 diff；用工作树外的 HEAD 副本复验确认这是本机 Homebrew rustfmt 1.9.0 / rustc 1.98.0 与仓库既有格式的版本差异，不是本批引入。
- `node scripts/check-source-line-budget.js`：通过；`server.js` 因删除同步入口从 3057/163703 棘轮到 3054/163495。

第一轮按协调者要求未跑 `npm test`、`npm run test:core`，未跑会打活服务的 `tests/test-classify-api-errors*`；未提交、未 stash、未重启服务、未向活服务写。第二轮已按要求运行真实 `npm run test:core`，结果见下节。

### 第一轮回归修复与结构性收口（第二轮）

第一轮验证在指纹 `480bb98fa08cc31bf04472e2` 上报了 7 条 `test:core` 回归和 4 组结构性问题。本轮的判定原则不变：判定在 Rust，Node 只做接线、等待和传递事实；不保留回退或开关。

#### 7 条回归逐条判定

- `tests/test-claude-api-error-message.js` 6 条 + `tests/test-api-error-host.js` 1 条，逐条判定为“测试需要 await”，不是生产回归。原因是收尾链现在真的异步：`finalizeStreamingTurn` 要等最终答复的持久确认和两阶段提交，测试却在 Promise 落定前就断言。受影响的六条是 stale `_resultSaved`、429 自唤醒判决、重复合成投递、error-only 主查询、未识别合成消息、watchdog；`test-api-error-host.js` 是复用 handoff 的 finalize 用例。
- 修复只在测试侧：`release()` 改为 async 并在所有调用点 await；`applyClaudeChatEvent` 的 stale 回调用例等待一个 `setImmediate` 让异步提交落地；`test-api-error-host.js` 三处 `finalizeStreamingTurn` 改为 await。生产代码没有为这 7 条改回同步语义。
- 红证：把 HEAD 的两个测试文件拷到 `/tmp/sync-append-batch/red` 跑最终代码，36 条中 29 通过、7 失败，失败名与第一轮完全一致（例如 `the finalizer still reports the reset-target action`、`a successful result does not clear the structured error`）；换成 await 后两个文件全绿。

#### 关停总预算（一次 deadline）

- `src/shutdown.js` 不再让 “checkpoint 10s + drain 60s + flush 10s + closers” 各自计时相加。一次 `shutdown()` 只生成一个 deadline（`DEFAULT_TOTAL_BUDGET_MS = 70_000`），checkpoint、drain、post-drain flush、closers 都从同一条 deadline 扣：drain 预算 = 剩余 - 最终 flush 预留 10s - closers 预留 5s 且不超过调用方 grace；最终 flush 预算 = 剩余 - 5s；closers 用剩余。最坏总耗时 70s，小于 `ecosystem.config.js:29` 的 `kill_timeout: 75000`，留 5s 退出余量。超时只放弃该阶段（durable fsync 无法取消），后续 closer 和 exit 必跑。
- post-drain flush 从 `onDrain` 移到新的 `shutdownCoordinator.onFinalFlush`，接收同一个 deadline；`src/host-lifecycle.js` 的 `flushInFlightChats({ deadline, timeoutMs })` 取三个上限的最小值（自身 10s、协调器剩余、deadline 差），没有预算时直接跳过并告警。checkpoint 阶段的 partial 写入仍由自身 10s 上限约束，整段再受总 deadline 约束。
- 测试：`tests/test-shutdown-http-errors.js` 新增缩放预算用例（total 400ms、最终 flush/closer 预留各 100ms），让 checkpoint、drain、final flush、closer 全部永久挂起，断言顺序 `checkpoint→drain→final-flush→closer→exit`、退出仍发生、总耗时不超过 3 倍预算，并断言 drain grace 被压到 200ms；另有静态用例解析 `ecosystem.config.js`，断言 `DEFAULT_TOTAL_BUDGET_MS < kill_timeout - 3000`。旧 `src/shutdown.js` 没有 `totalBudgetMs`/预留/`onFinalFlush`，用 HEAD 文件直接跑挂起 checkpoint 的独立复现 1500ms 后仍未返回。
- 中途 SIGKILL 的追加半行：Rust 追加路径 `write_all(suffix)` 后 `sync_all()`；`parse_transcript` 只在“文件不以换行结尾、且已解析出至少一条消息”时把最后一行当 torn 丢弃，前面已落盘的行照常读出；新建/空文件走原子整写，所以被 kill 的半个后缀不会变成整个文件。下一轮启动读盘自愈，不把 torn 末行报成损坏；代价是这条被打断的末行本身不保留。

#### 未处理拒绝

- 根因在 `src/chat/session-notices.js` 的 `say()`：它总是返回 Promise，而 `orchestration/runtime.js` 用同步 try/catch 包住调用，捕获不到异步拒绝；`server.js` 也没有 `unhandledRejection` 兜底。现在在源头吸收：同步 throw、Promise reject、`false` 都只记 `chat_notice_persist_failed` 并返回已落定的 `false`；广播失败只记 `chat_notice_broadcast_failed`。turn-engine 的 hold 上限通知改走同一个 notices 实例。
- 其余非等待写入逐项审计并观察拒绝：error-persistence、auto-route-notes、CLI switch（`switch-runtime.js`）、gateway push（`gateway-host.js`）、无人值守 trace、held-answer append、task-context 投影、codex usage。剩余 `.catch(() => {})` 只在不属于本批的收尾/文件日志路径。
- 测试：`tests/test-chat-admit-error-feedback.js` 新增“rejected append 不产生 unhandledRejection”，用 `process.on('unhandledRejection')` 计数覆盖 reject、同步 throw、resolved false 三种。旧 `session-notices.js` 跑同一测试会触发异步 `Error: disk full` 的 unhandledRejection 并判失败。

#### 低优先项

1. dedupe 回滚：`error-persistence` 的 `recent` 先登记后写。异步 `false`/reject 和同步 throw 现在都按 entry 身份回滚，只有同一个 claim 才删除；`auto-route-notes` 同步失败不再广播 `noteClientMsgId`。测试覆盖异步失败重试、同步 throw 重试、并发仍去重。旧 `error-persistence.js` 在异步失败用例上既不回滚也把拒绝漏成 unhandledRejection。
2. `switch-runtime.js` / `gateway-host.js`：吞掉的 Promise 改为记录 warn，并对 `saved === false` 单独告警；同步 throw 也记录原因。
3. close facts 顺序：`hasTurnOutput`、`recoveredCodexDisconnect`、`kind` 原本在 `await commitAdapterResult` 之前计算；现在抽成纯函数 `deriveCloseTurnFacts`，在该 await 之后调用。测试包含纯函数 oracle 和源码顺序断言（call-site 下标必须先于 helper 调用），覆盖“Codex transport disconnect、无 text/tools、写入成功”。旧 `turn-engine.js` 没有该导出，测试红为 `TypeError: deriveCloseTurnFacts is not a function`。
4. 关停晚到写入：新增“30ms 后才落盘的 partial 写入”用例，断言 `recordPartialCheckpoint` 早于 `session-persistence-stopped`。旧 HEAD 的“永久挂起写入”用例红在 `the flush must actually be awaited`，证明旧实现根本不等待。
5. 写入窗口内取消/替换的用量：Rust 已经判定行是否落地，并产生 `(turnId, runnerId)` 身份；Node 的 `recordDurableTurnUsage(..., turn)` 走 `identityOnly`：不要求当前回合、不读也不写替换后的 `cs`，用 `usage:<turnId>:<runnerId>` 和 `runner.usageRecorded` 幂等提交。此前 `turn.resultDurable` 只在“仍当前”的 `recordResultEvent` 里设置，替换后永远缺失，这条路径会被 `result_not_durable` 拒绝而静默丢用量；本轮在 `commitUsage` 的 identity-only 分支用 `runner.turnId === turn.turnId` 做身份证明。测试覆盖“append 期间被替换 → verdict `{durable:false,persisted:true}` → 仍然只记一次用量、替换状态不变”；红证为旧 `host-coordinator.js`/`host-runtime.js` 上 `the row landed but the replacement owns the boundary` 与用量断言失败。归属信息优先取 producing runner/turn，`state` 只作既有只读兜底，不写替换状态。

#### 最终产物与验证

最终 Rust 源码指纹 `cb5a561b351bbcf6fc8cf9de`；`darwin-arm64/multicc_core.node` 为 18,017,424 字节，SHA-256 `c85703809e09a0d67c6f6e92a846f9aaae98c97cf74a8461a74661240c2c5fb8`；`probeAddon` 与 `builtFromSource` 均为 true。所有测试均设置 `MULTICC_RUST_ADDON` 为该文件的完整路径；`MULTICC_RUST_PREBUILT_DIR` 为指纹根目录 `data/rust-source/cb5a561b351bbcf6fc8cf9de`。

- 改动/新增的 16 个 node:test 测试文件：279/279（含 `test-host-lifecycle-task-run-close` 5/5、`test-chat-host-coordinator` 35/35、`test-chat-error-persistence` 6/6）；另 `tests/test-shutdown-http-errors.js` 是普通脚本，单独运行 24/24。
- 回归批次：144/144（held-turn、unattended、cancel-state-flow、chat-runtime-native、claude-sdk-host/stream、background-hold-differential、auto-route-notes、server-graceful-shutdown）。
- `npm run test:security`：1139 项，1138 通过、0 失败、1 项既有 TODO。
- `npm run test:architecture`：126/126；`npm run test:contracts`：134/134。
- `npm run test:native`：256/256，退出 0（node 4/4、Rust 256/256、sqlite/运行时/发布检查均通过）。第一次把 `MULTICC_RUST_PREBUILT_DIR` 指到 `darwin-arm64` 子目录时，`test-subagent-defaults` 在删除 `MULTICC_RUST_ADDON` 后按 `<dir>/darwin-arm64` 解析而失败；改回指纹根目录后 256/256，不是代码问题。
- `npm run test:governance`：退出 0（tier 清单 874/874、20/20、产物治理 4 项既有基线、运行态写入 45 项）。
- `node scripts/check-source-line-budget.js`：退出 0；`server.js` 按棘轮登记为 3054 行 / 163495 字节。
- `cargo test -p multicc-core`：635/635；`cargo test -p multicc-addon` 编译并通过（无测试）；`cargo clippy -p multicc-core -p multicc-addon --all-targets` 退出 0，只有既有的 too-many-arguments 类告警（`chat_commit_final_persist` 在本轮新增参数前就已超过阈值）。`cargo fmt --all --check` 对本批改动的 Rust 文件无差异，唯一差异仍是未改动的 `native/core/src/unattended.rs`（本机 rustfmt 版本差异，沿用既有说明）。
- 真实 `npm run test:core`（最终代码）：退出码 1；大 node:test 批次 2212/2212、`test:task-shells` 299/299、`test:task-first` 437/438。唯一失败是 main 既有红项 `tests/test-air-paint-budget.js`：`chat-unattended.css` 的 `@keyframes unat-pulse` 使用 `box-shadow`，与本批无关。由于命令链是 `&&`，能走到最后的 `test:task-first` 说明前面所有阶段均已退出 0。
- 按协调者要求未跑 `npm test`，未跑会打活服务的 `tests/test-classify-api-errors*` 和 `test:cdp`；未提交、未 stash、未重置、未重启服务、未向活服务写。

本轮没有新增未覆盖边界；既有边界保持不变：进程死亡/跨崩溃的“恰好一次”投递仍未承诺，`clearHistory`/rotate 的异步顺序仍未并入（已在下一节并入，见「历史变更串行化与上下文轮换迁移」），identity 用量提交的归属字段在 runner 缺失时仍按旧规则回退读取会话字段（只读、不写替换状态）。

## 历史变更串行化与上下文轮换迁移（2026-11-11）

根因：`RustChatHistoryRuntime` 的落盘/快照写入此前有七条路径，除 append 外都没有进入同一会话的顺序：

1. 追加（append）：队列内 prepare/append，服务内同步 `repository.write`；
2. 标注/精确替换（replace）：同一轮多条消息一次性重写；
3. 增量保存定时器（`incrementalSaveTick` → interim）：从会话实时状态写一条临时行；
4. 清空（clear）：按当前消息表算保留集，写 `.views/<session>.json`；
5. 隐藏/删除（hide/remove/removeMany）：写同一份 `.views` 快照；
6. `postPersist` 回调：写后投影、广播与缓存发布；
7. 原生上下文轮换：`await` git 快照之后用旧事实提交 pendingCliHandoff、清空原生 CLI 状态并广播。

逐条竞态结论（每条都有对 HEAD 的红证）：

- clear vs 在飞 append：旧 clear 在 append 落盘前算保留集，reset 页不含后落盘的消息，而 visibility 快照按旧集合写入，重启后该消息被错误隐藏/错误保留。现在 clear 排队，队列头在落盘后的 transcript 上算快照。红证 `the clear snapshot must include the message that landed before it`。
- hide/annotate vs 在飞 append：旧 hide 立即返回 `{operationId:1}`，调用方把未提交的计数/标注当结果。现在要等队列落盘并发布缓存后才返回计数与标注结果。红证 `hide counts the message it newly hid`。
- interim vs clear：旧 interim 定时器独立写 visibility，清空后仍可能把清空前的显示态写回去（复活旧行/旧计数）。现在 interim 也是队列 job，clear 排在其后并以其后的 generation 组装快照。红证 `the interim write owns the queue / 0 !== 1`。
- append vs append / remove vs append：同一会话严格 FIFO；不同会话互不阻塞（单飞 driver 按会话）。
- rotation vs 新一轮/新 handoff/会话删除：旧实现在 git 快照 `await` 之后直接提交，期间启动的新轮次被旧事实覆盖，会清掉原生状态并把 chatTurnCount 归零。现在 `await` 后重新取同一套事实再判一次，Rust `commit` 再判一次。红证：旧实现返回 `ok:true, checkpointId:'checkpoint_0011223344556677'`（新轮次与已删会话两种）。
- 关停 vs 队列：旧 `flushInFlightChats` 只等在飞 append，不管已排队但尚未执行的 interim/visibility；进程退出会丢掉这些排队变更。现在先清定时器，再在同一个 deadline 内 `settle()` 整个队列（partial append 全部落定之后）。红证 `the queue is drained once the durable append is confirmed / false !== true` 与 `the queue drain is actually awaited, up to the cap`。

### 串行化设计

- 唯一 FIFO 在 Rust：`RustChatHistoryRuntime.enqueueMutation(sessionId, kind, args)` 入队并返回 `operationId`；kind 为 append/interim/replace/clear/remove/removeMany/hide。入队时捕获 generation（interim 用父代的 generation），旧代结果不能发布。
- Node 只有单飞 driver：取一步 → 落盘 → 回报 → 执行副作用，没有第二层调度。`nextMutationStep(sessionId)` 在队头计算计划，返回 `{type:'write', operationId, method:'transcript'|'visibility', sessionId, payload}`；Node 调 `history.writeAsync` / `history.writeVisibilityAsync` 完成原子写；`completeMutationStep(sessionId, operationId, ok, error)` 发布缓存并返回 `{effects, finished, failed, result}`；driver 执行 `effects`（广播）后结算调用方的 waiter。不同操作返回的结构不同，driver 按 `write`/`done`/`idle` 分派。
- 阶段：Start 组装计划 → Transcript（转写整写）→ Visibility（`.views` 快照）；`replace` 失败按旧语义记 `chat_history_annotation_failed` 并返回 `[]`；`hide` 失败会重置 job（清 plan/payload/emit/op）后重新入队。
- 只有落盘成功且缓存已发布才广播；广播异常不回滚已落盘的写入，只按 Rust 附带的 logEvent 记日志；标注广播失败时返回 `[]`，与旧同步实现一致。
- 错误形状不变：清空失败 `CHAT_HISTORY_CLEAR_FAILED`，轮换失败 `NATIVE_CONTEXT_ROTATION_FAILED`，DELETE 404/500 与旧一致；失败不广播。
- 关停：`hasPendingMutations` 与 `pendingMutationSessions` 供 `settle({deadline})` 使用：每一轮先给仍有排队变更的会话补驱动器，再 `await` 各驱动器真实的 loop Promise；host-lifecycle 在清掉增量定时器后，用同一个 flush 预算换算出绝对 deadline 排空；预算耗尽返回 `false` 只告警并继续后续 closer。见下方对抗复核的 H1 修复。

### 上下文轮换两阶段

- Node 只收集事实：`exists`、`kind`、`pendingCliHandoff`（status/reason）、`rotationReady`（三个端口是否可用）、`runState`、`backgroundCount`。存在性、非 chat、待生效手递在这些端口之前短路，保持旧顺序。
- Rust `chatContextRotationRequest('decision', facts)` 按固定顺序判定：`session_not_found` → `not_chat_session` → 待生效手递（非 manual 为 `handoff_pending`，manual 为 reuse）→ busy 门（`rotationReady=false` 或 queued/running/assessing 为 `session_busy`；`background_tasks_running`）→ proceed。被拒时 Rust 同时给出 `native_context_rotation_rejected` 广播（旧行为）。
- 只有 proceed 才 `await cliSwitchGitSnapshot`；`await` 后用同一套端口重新取事实并再次 decision。第二次通过后才由 Node 组装 handoff checkpoint，再把 `facts + cli + checkpoint + randomHex` 交给 Rust `commit`；`commit` 内部再跑一次 decision，通过后装配 handoff 与副作用清单 `mutate → closeStream → zeroChatTurnCount → broadcast`。
- 中间态：`await` 期间开始新轮次 → 第二次 decision 返回 `session_busy`；期间出现新 handoff → `handoff_pending`/reuse；会话被删 → `session_not_found`。这些路径都不持久化、不清原生状态、不归零 chatTurnCount、不广播 `native_context_rotated`（只发 rejected）。
- `clearedNativeSessions` 是 Node 端口才知道的事实（`clearAllNativeCliStates` 的返回值）。Rust 在广播载荷里留 `null` 占位，Node 在 mutate 事务拿到真实计数后、广播之前填入；reuse 路径保持 0。
- git 快照本身仍在 Node：它是宿主进程/工作区副作用，不是会话状态判定；Rust 只判定“是否可以提交、提交什么”。

### 各调用方逐项处理

- `clearHistoryUnsafe`：`await mutate(key,'clear',[keep])` 之后才分页与广播 `chat_history_reset`；`preserveHistory` 仍走轮换。
- `hideMessages`（hide/quiet→removeMany）、`annotateTurn`（replace）、`appendMessage`（append）、DELETE 路由（remove）全部返回 mutation 的 promise；DELETE 路由改为 async 并 await。
- 增量保存定时器（Rust runtime）只入队 interim，不再直接写 visibility。
- `src/task-shell/chat-history.js` 的 `clearShellHistory` 与 `src/task-shell/host.js` 的 `clearChatHistory`：await 每个 hide 批次后再投影页面，广播的是已提交快照。
- `src/task-shell/separation.js`：源会话 hide 改为 await，失败只记日志（与旧 warn 一致）。
- `src/chat/turn-engine.js` 的 shell `clear_history`（非 preserveHistory）：await `clearTaskShellHistory` 后再广播。
- `src/classify/state-machine.js`：`applyTaskAttributionResult` 改为 async（内部标注必须等落盘），scan/aux 两个调用点 await；其余 4 处 `annotateChatTurn` 调用点（cancel、suggest、split、catch）全部 await；`server.js` 的 `annotateChatTurn` 接线改为 async/await。
- 轮换：`rotateNativeContext` 全程 await（facts、两次 decision、git 快照、commit），失败只抛 `NATIVE_CONTEXT_ROTATION_FAILED`。

### 删除清单

- `src/routes/chat-history.js`：原来围绕 `history.writeAsync` 的每会话 Promise 链、立即返回的 hide/remove 结果、以及 clear 里“先读缓存再写”的顺序全部删除，只保留单飞 driver/waiter；visibility 写入改走 `writeVisibilityAsync`。
- `src/host-lifecycle.js`：删除“没有 partial 写入就直接返回”的旁路，清定时器后必须把队列排空（同一预算）。
- `src/task-shell/*`、`src/classify/state-machine.js`、`src/chat/turn-engine.js`、`server.js` 的同步调用点全部改为 await（无回退分支、无开关）。
- `scripts/rust-source-cache.js` 探针新增 `writeVisibilityAsync` 与 `chatContextRotationRequest`。

### Node 保留范围及原因

- 文件名/路径、分页与 replay、WS 广播、git 快照、`clearAllNativeCliStates`/`rememberActiveCliState`、`buildHandoffCheckpoint`、persistedSessions 与 sessionPersistence 事务仍是宿主职责；Rust 只给判定和副作用清单。
- `src/session/adapters/chat-history-file-repository.js` 只是 Rust 原子写的错误边界（`writeVisibilityAsync` 把原生错误恢复成 Node 兼容错误并 invalidate 缓存）。

### 未覆盖范围

- 进程崩溃/跨进程的“恰好一次”仍不承诺；两个 decision 之间崩溃不会留下部分提交（快照本身无副作用），但 git 快照完成与 commit 之间崩溃会丢掉这次轮换，下次重试即可。
- `test:cdp`、`tests/test-classify-api-errors*` 未运行（既有约定）。
- 轮换的 git 快照仍是 Node 副作用，未迁入 Rust。

### 红证

用 HEAD（`9bd8e5bd`）的源码导出到 `/tmp/clear-rotate-batch/head-tree`（git archive + node_modules 软链 + 本批测试文件），对旧代码跑同一批测试：

- `a clear queued behind an in-flight append plans on the landed transcript`：`the clear snapshot must include the message that landed before it`（旧 clear 在迁移前算集）。
- `hide and annotate queued behind an in-flight append act on the landed message`：`hide counts the message it newly hid`，实际返回 `{operationId:1}`（未落盘）。
- `an incremental save straddling a clear never resurrects the pre-clear display state`：`the interim write owns the queue`，`0 !== 1`。
- 两条轮换重判：旧实现直接返回 `{ok:true, checkpointId:'checkpoint_0011223344556677', ...}`，没有重判。
- 两条关停：`the queue is drained once the durable append is confirmed`（`false !== true`）与 `the queue drain is actually awaited, up to the cap`。

### 验证与产物

最终 Rust 源码指纹 `99eb6688da8b03f7ff9b27e4`；`darwin-arm64/multicc_core.node` 为 18,067,072 字节，SHA-256 `9056c286ae1f36940ef1da2e12662055de169bc797201e8c0c8fe31f012d075c`；`probeAddon` 与 `builtFromSource` 均为 true。

- 改动/新增的 7 个 node:test 文件（`test-chat-history-routes` 39、`test-chat-history-store`、`test-chat-history-ordering`、`test-chat-dto-golden`、`test-chat-history-runtime-differential` 15、`test-shell-chat-continuity`、`test-host-lifecycle-task-run-close` 7）：100/100；在最终指纹上连同 `test-classify-live-runner` 复跑：134/134。
- 关联批次：`test-task-separation`、`test-chat-task-separation`、`test-chat-turn-core`、`test-task-context-host`、`test-held-turn-injection`、`test-unattended-*`、`test-cancel-state-flow`：207/207；`test-classify-vocab` 23/23；`test-classify-live-runner` 34/34（两处归因调用改为 async/await）。
- 说明：首次真实 `npm run test:core` 在 `test-classify-live-runner` 有 2 条红，原因是测试仍同步读取 `applyTaskAttributionResult` 的返回值（该函数现在 async）；只改测试为 await，生产语义未回退。红名为 `delayed attribution with a superseded anchor cannot overwrite the newer task` 与 `a still-D verdict is refined by the model goalState when attribution lands`。
- 真实 `npm run test:core`（最终代码）：退出码 1；大 node:test 批次 2217/2217、`test:task-shells` 299/299、`test:task-first` 437/438。唯一失败是 main 既有红项 `tests/test-air-paint-budget.js`：`chat-unattended.css` 的 `@keyframes unat-pulse` 使用 `box-shadow`，与本批无关。命令链是 `&&`，能走到 `test:task-first` 说明前面所有阶段均已退出 0。
- `npm run test:security`：1139 项，1138 通过、0 失败（1 项既有 TODO）；`npm run test:architecture`：126/126；`npm run test:contracts`：134/134；`npm run test:native`：256/256，退出 0；`npm run test:governance`：退出 0（20/20、运行态写入 45 项、产物治理均通过）。
- `cargo test -p multicc-core`：638/638；`cargo test -p multicc-addon` 编译并通过（无测试）；`rustfmt --check` 对本批改动的 5 个 Rust 文件（含两个新增 `chat_context_rotation.rs`）无 diff。
- `node scripts/check-source-line-budget.js`：通过；`server.js` 按棘轮登记为 3054 行 / 163528 字节（annotateChatTurn 接线 async 出口 +33 字节）。
- 按协调者要求未跑 `npm test` 整套、`test:cdp` 与会打活服务的 `tests/test-classify-api-errors*`；未提交、未 stash、未重置、未重启服务、未向活服务写。

### 对抗复核修复：关停等待与删除栅栏（2026-11-11）

#### H1（高）：`settle()` 等错了对象，关停可能在队列落盘前返回

- 根因：`drivers` Map 存的是 `{loop}` 包装对象（因为有同步的自删边界），旧 `settle()` 把 `entry` 本身放进 `Promise.allSettled`。非 Promise 值立即 fulfilled，随后用一个“最多 10000 轮”的同步轮数闸门兜底，既不等待真实写入，也无法约束永不返回的 fsync。旧代码在本批红证脚本上表现为 4ms 返回 `false`，而写入尚未落盘。
- 修复：`settle({deadline | timeoutMs})` 每轮重新读取 `drivers` 里真实的 `entry.loop`（driver 在 `finally` 里自删，所以不能缓存），用 `Promise.race([allSettled(loops), timer(remaining)])` 等待；删除轮数闸门，唯一上限是调用方给的绝对 deadline。每轮先向 Rust 要 `pendingMutationSessions()`，给只有定时器入队、没有活 driver 的会话补一个驱动器；没有 driver 但队列仍非空时让出一拍再查，避免自旋。默认 deadline 60s 只用于非关停调用。
- 预算来源：`src/host-lifecycle.js` 的 `flushInFlightChats` 已经按 `min(partialFlushTimeoutMs, timeoutMs, deadline-now)` 得到本次 flush 预算，现在把 `Date.now() + budget` 作为 `settleDeadline` 传给 `settle`；外层原有 `Promise.race` 仍兜底整个 flush，两者共用同一份预算。`src/shutdown.js` 的 70s 总预算 / 10s 最终 flush 预留未变。
- 红证（旧源码副本在 `/tmp/clear-rotate-batch/src/routes/chat-history.old.js`，未改动工作区）：gated `writeAsync` 下启动 append 后调用 `settle({deadline:+5000})`，输出
  `{"drained":false,"elapsedMs":4,"landedBeforeSettleReturned":false,"writes":1}`。
- 真实用例（不用 mock）在 `tests/test-chat-history-routes.js`：真 `createChatHistoryRuntime` + 延迟 `writeAsync`，断言 settle 在写落地后才 resolve；永不落定时在 60ms deadline 内返回 false；一个会话挂死时另一个会话仍被排空。`tests/test-host-lifecycle-task-run-close.js` 新增真运行时用例，断言协调者在真实 driver Promise 结束前不完成、释放后 partial 已落盘。审计同类代码：全仓只有 `settle()` 曾把 `{loop}` 当 Promise；其余 `Promise.allSettled` 等待的都是真 Promise。

#### M1（中）：删除/重命名与会话队列之间没有栅栏

- 根因：旧 `server.js` 的 `destroySessionCascade` 直接 `chatHistoryService.deleteSession(id)`，绕过会话 FIFO。若此时有 append 在飞，删除先落地、追加后落地，文件被重新写回。红证（旧代码副本）：
  `{"afterDelete":false,"recreatedAfterWrite":true,"messages":1}`。
- Rust 结构处理（`native/addon/src/chat_history_runtime.rs`）：
  - 新增 `removed: HashSet<JsString>` 墓碑。删除在入队时立即落墓碑；已排队但仍在 `Phase::Start` 的 job 全部丢弃（operationId 收集进 `cancelled`），正在执行的队首 job 保留；`Delete` 变更排在它后面，因此最终磁盘状态一定是“已删除”。
  - 删除后到达的入队一律抛 `chat_history_session_deleted`；`incremental_save_tick` 对墓碑会话直接返回，定时器不能再把文件写回来。
  - 重复删除幂等：墓碑已存在时返回 `{operationId: null, cancelled: []}`，Node 直接 resolve `true`。
  - 删除失败（例如任务历史仍被引用 `TASK_HISTORY_REFERENCED`）会撤销墓碑，允许后续写入与重试。
  - `ReplaceAll` 是新的整份替换变更，在队首通过 service `replace` 执行；`Delete` 在队首通过 service `deleteSession` 执行，并清增量定时器、失效可见性缓存、移除队列项。
  - 会话 id 由服务端分配且不复用，墓碑保持到进程重启是安全的。
- Node 接线：`chatHistoryRuntime.removeSession(id)` / `replaceHistory(id, messages, options)` 返回队列 Promise；被取消的排队 waiter 统一以 `CHAT_HISTORY_SESSION_DELETED` 拒绝；同一次删除触发的多个等待者各自结清。
- 绕过审计（逐项结论）：
  - `server.js` `destroySessionCascade`：改为 `await chatHistoryRuntime.removeSession(s.id)`，失败记 `chat_history_delete_failed`，无回退到同步 service。
  - `src/task-board/lifecycle-host.js` 的裁剪与整会话删除：分别 `await replaceHistory(record.id, kept, {reason:'task-delete'})` 与 `await deleteHistory(record.id)`；宿主注入从 `getHistoryService` 改为这两个函数。
  - `src/routes/session-bundle.js` 导入：`await replaceHistory(session.id, merged, {reason:'bundle-import-…'})`，与在线追加同一 FIFO；`getChatHistoryService` 仅保留只读的 `history.read`。
  - `src/routes/session-profile.js` fork：`await replaceHistory(newSid, newHistory, {reason:'fork'})`；该文件已不再需要 `getChatHistoryService`，接线一并删除。
  - `src/bootstrap/state.js` 的 `renameSession`：仅存在于旧 schema 启动迁移，严格早于 `createChatHistoryRuntime` 创建，此时不可能有排队或在飞写入，因此保持同步并加注释说明；生产代码没有其他 `renameSession` 调用点。
  - `src/session/chat-history-service.js` 仍导出 `append/replace/remove/deleteSession/upsertInterim/ensurePersistedIds`：它们是 Rust 队列在队首执行时调用的仓储分发面（`start_replace_all`/`start_delete` 等），不再是 Node 侧的旁路；Node 调用方没有直接使用它们。
- 竞态用例（`tests/test-chat-history-routes.js`）：删除等待在飞 append；排队中的追加被 `CHAT_HISTORY_SESSION_DELETED` 拒绝；释放后 `records.has('s1') === false`；删除后的追加继续被拒；重复删除幂等。`replaceHistory` 排在在飞 append 之后，最终记录为 `['kept']`。红证先于修复从旧源码副本跑出上文的 `recreatedAfterWrite:true`。

#### M2（中）：关停测试 mock 掉了被测对象

- `tests/test-host-lifecycle-task-run-close.js` 保留原有用例验证调用顺序，同时新增真实 `createChatHistoryRuntime` 用例（真实 driver、真实 waiter、gated `writeAsync`），断言协调者真的等到了写入落地。H1 的红证与真实用例共同覆盖此前被 mock 掉的结算路径。

#### M3（中/低）：差分测试的轮换 oracle 被改写成新行为

- 根因：`tests/helpers/legacy-chat-history-runtime.js` 曾加入 `rotationScreen()` 并复刻两阶段重判，导致差分测试实际是“Rust vs 被改写成新行为的 JS”，不再是“新 vs 旧”。
- 修复：oracle 恢复 HEAD 的单次判定语义（git 快照前判一次，快照后直接提交），并在文件里写明“Frozen oracle: HEAD 单次判定；新宿主会在快照后重判，该变化由差分套件的显式用例断言，不塞进 oracle”。轮换差分用 `rotationStep` 只过滤“快照后重新读取 run-state/background”的轨迹项，其余轨迹（rotate code、广播载荷、持久化、checkpoint）仍逐字节比较。
- 新增显式变更用例 `rotation re-decides after the snapshot: the HEAD oracle commits, the runtime rejects`：在快照回调里注入新的 pending handoff，断言 HEAD 提交并把 reason 改成 manual（旧行为）、新运行时返回 `{ok:false, code:'handoff_pending'}`、保留 `cp-late`、不持久化、只广播 rejected。哪些行为有意改变、哪些必须保持一致，都在用例与注释里写明。

#### L1/L2/L3

- L1：`src/routes/chat-history.js` 的轮换重判被拒路径原本仍会先发起一次 git 快照，注释却声称不会留下无用快照调用。现在快照只在首判通过后才发起，注释改为“若重判被拒，快照是唯一的既有开销；不会装配 checkpoint、不会提交 handoff、不会写盘或广播”。
- L2：`src/classify/state-machine.js` 归因失败处理链末尾的 `.catch(async e => { await annotateChatTurn(...) })` 返回的 Promise 无人处理。已在该链尾部追加 `.catch` 记录 `task_attribution_failure_handler_failed`；审计其余新增 async catch/then 尾部，没有其他悬空 Promise。
- L3：实现了 interim 合批——入队时若同会话已有 `Phase::Start` 的 Interim job，直接更新它的 `args/generation` 并复用同一 operationId，只有最新临时态会落盘。决策在 Rust；用例 `queued interim replaced by newest` 断言 append + 一次合批 interim 共两次写。

#### 本批验证与产物

- 最终 Rust 源码指纹 `d531210b08d2767298515562`；`darwin-arm64/multicc_core.node` 为 18,067,040 字节，SHA-256 `7aa2ef7f57695f3adee793969c68369a90f3a6be84e08c9323ba216c788f5e95`；`probeAddon=true`、`builtFromSource=true`。
- 定向套件：`test-chat-history-runtime-differential` 16/16；`test-chat-history-routes` 45/45；`test-host-lifecycle-task-run-close` 8/8；`test-chat-history-ordering` 9/9；`test-chat-dto-golden` 5/5；`test-chat-history-store` 16/16；`test-task-lifecycle` 26/26；`test-shell-chat-continuity` 9/9；`test-classify-live-runner` 34/34；`test-task-worktree` 14/14；`test-session-bundle-api` 集成通过；`test-session-rename-broadcast` 17/17（fixture 改为注入 `replaceHistory`）；`test-provider-reassign`、`test-cli-key-accounts`、`test-opencode-go-default-provider`、`test-gateway-dispatch-wakeup`、`test-voice-global-gateway`、`test-voice-global-lifecycle`、`test-session-hibernation-git` 全绿。
- `cargo test -p multicc-core` 638/638；`cargo test -p multicc-addon` 通过（0 测试）；`rustfmt --check` 对本批 3 个 Rust 文件无 diff（core 中既有的测试格式漂移不由本批重排）。
- `node scripts/check-source-line-budget.js`：通过；`server.js` 按棘轮登记为 3057 行 / 164007 字节。
- 完整 `npm run test:core`（退出码 1）：大头 node:test 批次 2223/2223、`test:task-shells` 299/299、`test:task-first` 437/438；唯一失败是 main 既有红项 `tests/test-air-paint-budget.js`（`chat-unattended.css` 的 `@keyframes unat-pulse` 使用 `box-shadow`），与本批无关。命令链是 `&&` 且一路走到 `test:task-first`，说明此前所有阶段均已退出 0。
- 其他门禁：`test:architecture` 通过；`test:state` 通过；`test:security` 1139 项、1138 通过、0 失败（1 项既有 TODO）；`test:contracts` 134/134；`test:native` 退出 0；`test:governance` 退出 0（含运行态写入 45 项与产物治理）。
- 诚实边界：`replaceAll` 的写入字节由 Node 在入队前组装，队列只保证执行顺序、不与在飞追加交错。因此上下文包“合并导入”若在读取底稿与入队之间恰有新追加落地，新消息不会进入这次整份替换（导入通常面向空闲会话；删除/裁剪不受影响，它们是队首服务调用）。未把合并语义搬进 Rust 是本批的已知取舍。
- 按协调者要求未跑 `npm test` 整套、`test:cdp` 与会打活服务的 `tests/test-classify-api-errors*`；未提交、未 stash、未重置、未重启服务、未向活服务写。

### 第二轮对抗复核：删除拒绝不丢写入、队首裁剪/合并与单一判据（2026-11-11）

上一节的 H1/M1 主路径已通过复核；本轮修掉复核新发现的一条删除拒绝数据丢失路径，并把任务裁剪/包导入的 read-then-write 窗口搬进队列。以下数字取代上一节同名条目。

#### 问题 1（中，已实测）：删除被拒时丢掉已接受的排队写入

- 根因：旧 `enqueue_mutation` 在 `Delete` 入队时就丢弃所有 `Phase::Start` 的 job 并立即落墓碑；删除是否被拒只有到队首执行 `deleteSession` 才知道。Node 随即把被取消 job 的 waiter 以 `CHAT_HISTORY_SESSION_DELETED` 结清。复现：`u1`（taskId）在内存中受保护 → append `a1` 在飞 → append `a2` 排队 → `removeSession`：`a2` 收到 `SESSION_DELETED`、删除返回 `TASK_HISTORY_REFERENCED`、会话存活、磁盘只剩 `[u1,a1]`，`a2` 永久丢失。旧的同步删除从不在入队时取消排队写入，因此这是本批引入的新行为。
- 修复（方案 b，延迟取消）：`Delete` 入队只做三件事——写 `deleting: session→operationId`、分配 operationId、把 `Delete` 插到“最后一个非 `Phase::Start` job 之后、未开始 job 之前”；不取消任何 job、不落墓碑。删除期间新入队的变更照常接受，排在 `Delete` 之后。队首执行成功时才收集队列里剩余 job 的 operationId（`cancelled`）、移除队列、撤销 `deleting`、落墓碑；被拒时只撤销 `deleting`，排队写入保持原位继续执行。同一会话的重复删除复用在途 operationId，所有 waiter 看到同一结果。`incremental_save_tick` 在 `deleting`/`removed` 期间直接返回，定时器不会把临时态写回。
- 三个时点：
  1. 入队瞬间已被拒绝：`destroySessionCascade` 的 `chatHistoryService.assertCanDeleteSession` 与任务板的 `canDeleteHistory`（Rust `canDeleteSession`）都在入队前判定；拒绝时根本没有 job、没有墓碑，也没有任何已接受写入被取消。
  2. 入队后在队头执行时被拒绝：所有已接受写入（在飞的 + 排队中的 + 删除待定期间新接受的）都留在队列里并成功落盘；删除 waiter 收到原错误（如 `TASK_HISTORY_REFERENCED`），其余调用方得到成功而不是 `SESSION_DELETED`；墓碑不存在，之后的 append 正常。
  3. 删除成功：队列里尚未开始的 job 全部取消，其 waiter 以 `CHAT_HISTORY_SESSION_DELETED` 结清；墓碑落下，之后的 append 被拒；重复删除幂等返回 `true`。
- 红证（修复前）：复核给的复现场景写成 `a refused delete leaves every accepted write intact and lifts the fence`，在旧产物（`d531210b`）上失败于 `Error: chat_history_session_deleted ... at sessionDeletedError (src/routes/chat-history.js)`；同一 fixture 在修复后断言 `a2` 落盘、`removeSession` 拒绝、再次 append 成功。
- 回归用例（`tests/test-chat-history-routes.js`）：
  - `a refused delete leaves every accepted write intact and lifts the fence`：拒绝后最终记录 `['u1','a1','a2']`，随后 `a3` 也能写入。
  - `mutations queued while a delete is pending follow the delete outcome`：拒绝分支断言删除期间接受的 `a2` 成功落盘；成功分支断言删除期间接受的 `a2` 收到 `SESSION_DELETED` 且磁盘为删除态。
  - 原有 `delete waits for an in-flight append, discards queued work and fences later appends` 改为断言“删除提交前排队项不结算、提交后才以 `SESSION_DELETED` 结清”，覆盖幂等重复删除。

#### 问题 2（中）：任务历史裁剪/包合并的 read-then-replace 覆盖窗口

- 根因：`src/task-board/lifecycle-host.js` 的裁剪先 `getHistory()` 读快照、再 `replaceHistory(kept)` 整份写；`src/routes/session-bundle.js` 的 merge 与 `src/routes/session-profile.js` 的 fork 也在 Node 组装 `[...read(), ...imported]`。只要在读取与队首执行之间有一条在飞 append 落盘，它就被旧底稿整份覆盖。
- 修复：新增两种队首变更。`DropMessages`（`dropMessages(sessionId, ids, options)`）在队首 `service("read")` 取最新 transcript，过滤掉给定 id 后 `service("replace")`；`MergeAll`（`mergeHistory(sessionId, messages, options)`）在队首读取底稿并追加导入消息后整份替换。判定“删哪些 id / 导入哪些消息”仍由 Node 提供，`DropMessages` 只保证底稿读取发生在队首。任务裁剪改用 `dropHistoryMessages`，包导入 merge 与 fork 改用 `mergeHistory`；整份覆盖语义的包导入仍用 `replaceHistory`（本来就是显式替换）。
- 红证（旧 Node 模式，临时用例已删除）：初始 `['u1']` → append `a1` 在飞 → Node 读快照（只有 `u1`）→ 队首 `replaceAll(snapshot)` → 释放 `a1`。结果 `records = ['u1']`，`a1` 被覆盖。新用例 `dropMessages runs on the queue-head transcript and keeps a concurrent append` 与 `mergeHistory appends on the queue-head transcript instead of overwriting it` 在同一时序下分别得到 `['u1','a1']` 与 `['u1','a1','m1']`。
- 残留边界：`dropMessages` 的 id 集合仍取自 Node 的裁剪快照；若在快照与队首之间恰好新落盘一条属于被删任务的消息，它不会被删。任务删除前置了 `assertTaskIdle`，正常路径不存在这种在飞消息；这条边界写入文档而不是假装关闭。`replaceAll`（非 merge 的包导入）仍是显式整份替换，覆盖是调用方要求的语义。

#### 问题 4（低）：Node 第二份“共享会话”判据不一致

- 根因：`lifecycle-host` 自己算 `shared`（不看 `routing.workerSessionId`），可能放行到删除，最后只有 Rust 拒绝——正好触发问题 1 的旧取消路径。
- 修复：删除 Node 的共享判据，`canDeleteHistory(record.id) === true` 直接问 Rust `canDeleteSession`；后者走 `assertCanDeleteSession`，与 `createTaskHistoryRetention.canDeleteSession` 同一口径（含 `routing.workerSessionId`、受保护消息与 `taskExecutionSlot`）。Node 不再维护第二份规则。

#### 问题 3（低）：墓碑对复用会话 id 的残留

- 生命周期：墓碑只在删除真正成功后落下；`registerSession(sessionId)` 同时清 `removed` 与 `deleting`。接线点：`server.js` 包装 `createSessionRecord` 的成功返回（含任务壳 `createExecution` 用显式 `task.sessionId` 重建、OAuth 登录会话的固定 id、包导入/fork 的新 id），以及启动时的 `__aux__` 定向会话初始化。
- 审计：固定/可复用 id 只有 `AUX_SESSION_ID`、`CLAUDE_AUTH_SESSION_ID`、`CODEX_LOGIN_SESSION_ID`、commandcode 登录会话 id，全部经 `createSessionRecord`；任务板恢复走 `createExecution` 的显式 `task.sessionId`，同样经过包装。普通会话 id 由 `randomUUID` 分配，删除后不会被复用；进程重启会清空内存墓碑。约束：将来若有代码绕过 `createSessionRecord` 直接 `persistedSessions.set` 复用已删除 id，必须调用 `registerSession`。
- 用例：`canDeleteSession asks the Rust retention rule and registerSession clears the tombstone`（删除 → 同 id 注册 → append 成功）。

#### 本轮验证与产物

- 最终 Rust 源码指纹 `a32ddb351f2a79dc47c61acb`；`darwin-arm64/multicc_core.node` 为 18,083,568 字节，SHA-256 `4617fe691e680da4ec921168b81bf519ece5c84543e6ca3822bd833b0c56efc4`；`probeAddon=true`、`builtFromSource=true`。
- 定向套件（最终产物）：`test-chat-history-routes` 50/50；`test-task-lifecycle` 26/26；`test-chat-history-runtime-differential`、`test-chat-history-differential`、`test-chat-history-ordering`、`test-chat-history-store` 与上述两组共 123/123；`test-host-lifecycle-task-run-close`、`test-shell-chat-continuity`、`test-session-create-routes`、`test-session-lifecycle-routes` 46/46；`test-session-rename-broadcast`、`test-cli-key-accounts`、`test-provider-reassign`、`test-opencode-go-default-provider`、`test-chat-dto-golden`、`test-session-bundle-api` 同批 138/139（唯一红为本节已修的裁剪 stub 缓存问题，修后 `test-task-lifecycle` 单独复跑 26/26）。
- `cargo test -p multicc-core -p multicc-addon`：638/638（addon 编译通过、0 测试）；`cargo fmt -p multicc-addon -- --check` 无 diff（core 既有测试格式漂移不由本批重排）。
- `node scripts/check-source-line-budget.js`：通过；`server.js` 按棘轮登记为 3068 行 / 164926 字节。
- `npm run test:architecture`：127/127；`npm run test:native`：256/256，退出 0。
- 完整 `npm run test:core`（最终产物，退出码 1）：大 node:test 批次 2228/2228、`test:task-shells` 299/299、`test:task-first` 437/438；唯一失败仍是 main 既有红项 `tests/test-air-paint-budget.js`（`chat-unattended.css` 的 `@keyframes unat-pulse` 使用 `box-shadow`），与本批无关。命令链是 `&&` 且一路走到 `test:task-first`，说明此前所有阶段均已退出 0。
- 诚实边界：延迟取消保证“删除被拒时已接受写入不丢”，但删除成功后队列尾部写入会被取消并告知 `SESSION_DELETED`（这是删除语义要求的）；任务裁剪的 id 集合仍由 Node 快照给出（见问题 2 残留边界）。
- 按协调者要求未跑 `npm test` 整套、`test:cdp` 与会打活服务的 `tests/test-classify-api-errors*`；未提交、未 stash、未重置、未重启服务、未向活服务写。

### 第三轮对抗复核：会话代次、结构化删除裁决与任务删除边界（2026-11-11）

上一轮已接受延迟取消、`DropMessages`/`MergeAll` 队首裁剪与单一判据；本轮处理复核新发现的两条必须修问题和两条记录项。以下数字取代前文同名条目。

#### 问题 1（中高，已实测）：删除待定期间重新注册会话，新代次写入被旧删除取消

- 根因：`registerSession` 当时只清 `removed/deleting`，队列里的 `Delete` 没有代次概念；删除成功按“取消删除之后所有未开始 job”结清 waiter。复现：`append a1` 在飞 → `removeSession` 排队 → `registerSession`（同 id 会话重建）→ `append n1`（新历史）→ 删除提交：`n1` 被当作旧历史的排队项取消，收到 `SESSION_DELETED`，磁盘没有 `n1`；墓碑还一直压到第二次 `registerSession`，后续写入继续被拒。
- 修复：每会话代次（epoch）。Rust 所有者新增 `epochs: session→u64`；`registerSession` 推进代次并清墓碑，不再清删除标记（标记由删除 job 自己结算）。每个入队 job 记录入队时的 `epoch`；`Delete` 记录自己的入队代次，成功时只取消 `epoch <= delete_epoch` 的剩余 job（waiter 以 `SESSION_DELETED` 结清），保留 `epoch > delete_epoch` 的新代次 job 在原位、删除后继续执行；只有当前代次仍等于删除代次时才落墓碑。`deleting` 标记带 `(epoch, operationId)`：同一代次内的重复删除才复用在途 operationId，新代次删除是独立 job。临时态合并、队首代次校验、`incrementalSaveTick` 的定时器都带代次：旧代次的定时保存不会在新代次复活，也不会改写新历史。删除插入规则仍是“最后一个非 `Phase::Start` job 之后、未开始 job 之前”，并额外越过已排队的 `Delete`，保证删除按入队顺序执行，后入队的删除不会插到先入队的删除之前。
- 边界：
  1. 删除排队/在飞时 `registerSession`：新代次写入保留并落盘；旧代次排队项取消；旧内容不会在删除后复活。
  2. 新代次的第二次 `removeSession` 是独立删除，不与旧代次合并；它按删除语义丢弃排在它之前的未开始 work（包括新代次的 append），最终磁盘为删除态。
  3. 删除被拒后 `registerSession`：标记已撤销，新代次直接在原有历史上继续写。
- 红证（旧产物 `a32ddb351f2a79dc47c61acb`）：`registering while a delete is pending keeps the new epoch and only settles the old history` 期望 `['fulfilled','fulfilled','rejected','fulfilled']`，旧产物实际 `['fulfilled','fulfilled','rejected','rejected']`——新代次 `n1` 被 `SESSION_DELETED`。第二条用例旧产物实际 `['fulfilled','rejected','rejected','fulfilled']`，删除结算顺序也与合并行为不符。最终产物同命令全绿。
- 回归用例（`tests/test-chat-history-routes.js`）：
  - `registering while a delete is pending keeps the new epoch and only settles the old history`：断言 `n1` 落盘（最终 `['n1']`）、随后 `n2` 仍可写、旧代次排队项收到 `SESSION_DELETED`。
  - `a removeSession in the new epoch is an independent delete, not a coalesced one`：断言两次删除都成功、重建后的历史被第二条删除移除、随后写入被墓碑拒绝。
  - `registering after a refused delete starts a clean epoch that keeps writing`。

#### 问题 3（中低，已修）：任务删除在会话被引用时静默跳过，留下孤儿会话

- 根因：上一轮把共享判据交给 Rust 布尔 `canDeleteSession`；`lifecycle-host` 只在 `canDeleteHistory(id) === true` 时删会话，其余一律跳过。布尔值无法区分旧行为的两条路径：`shared`（chatSessionId/refs，旧 purge 保持会话原样）与 `referenced`（`routing.workerSessionId` 或受保护消息，旧 `deleteSession` 抛 `TASK_HISTORY_REFERENCED` 并中止任务删除）。结果 referenced 会话被静默留下，任务卡却已删除。
- 修复：Rust 返回结构化裁决 `deletionVerdict(sessionId) -> {ok, reason?, tasks?, taskIds?}`。Node 只提供事实（`task-history-retention.sessionDeletionFacts`）：`executionSlot`（执行槽，旧 `canDeleteSession` 的短路）、`sessionLinks`（存活任务的 chatSessionId/refs）、`routingLinks`（`routing.workerSessionId`）、`messageLinks`（历史里带存活任务 taskId 的消息戳）和用于错误正文的 `references`。判定在 Rust：执行槽 → `ok`；有 sessionLinks → `{ok:false, reason:'shared'}`；有 routingLinks 或 messageLinks → `{ok:false, reason:'referenced', tasks, taskIds}`（id 由 Rust 从事实汇总去重）；否则 `ok`。没有事实端口的旧接线回退到布尔 `assertCanDeleteSession`，被引用一律按 referenced 处理。
- Node 行动：`ok` → 删历史并销毁会话；`shared`（以及旧布尔接线的 `false`）→ 保持会话原样，绝不删共享历史；`referenced` 或其他未知/失败裁决 → 抛 `TASK_HISTORY_REFERENCED`（带 `tasks/taskIds`）中止任务删除，卡片可见可重试。
- 与旧行为对账：
  - `prepareTaskDelete` 的 `task_session_shared` 判据（other task 的 chatSessionId/refs）保持原样；命中时在进入 `purgeTaskData` 之前就中止任务删除，和旧行为一致。结构化 `shared` 分支覆盖的是旧 purge 的“保持会话原样”路径（非 taskBound 记录或直接调用 `purgeTaskData` 的场景）。
  - `referenced` 与旧 `deleteSession` 的 `TASK_HISTORY_REFERENCED` 同一口径（routing 或受保护消息），仍然中止且不删历史；既有用例 `purging task history retains messages jointly owned by another task and leaves the source session` 继续通过。
  - `ok` 与旧“非 shared 且 `deleteSession` 成功”一致；执行槽短路与旧 `canDeleteSession` 相同。
  - 因此没有把 referenced 历史变得更易删，共享会话也仍然保留；布尔 `false` 回退保留旧接线语义（不删、不抛），不会把“不支持结构化裁决的宿主”误判成 referenced。
- 用例：
  - `tests/test-chat-history-routes.js` `deletionVerdict separates shared from referenced links and keeps the boolean rule`：四种事实组合 + 布尔投影（shared 优先于 routing；referenced 汇总去重 `taskIds`；执行槽短路）。
  - `tests/test-task-lifecycle.js` 三条：`a shared history verdict keeps the session and never deletes shared evidence`、`a referenced history verdict aborts the task deletion and stays retryable`（断言不删历史、会话仍在、错误码与 `tasks/taskIds` 透传）、`a deletable history verdict removes the session and its history`。
  - `tests/test-task-history-retention.js` 的 facts 断言：桶划分、引用清单与 `canDeleteSession` 布尔投影一致、执行槽短路。

#### 问题 2（记录，中）：删除/任务删除等待没有超时，挂死写入会楔住后续变更

- 结论：不加调用方超时，也不加看门狗。放弃在途写会重新引入“旧写覆盖新写”的竞态（正是本轮反复修掉的类别），也无法安全回滚已提交的文件事务。等待语义：同会话历史写按 FIFO 依次执行，一个永不落定的 `writeAsync` 会阻塞该会话之后的变更（包括删除与任务删除）；跨会话不受影响；HTTP 删除/任务删除请求会一直挂起。旧同步实现虽然没有 Promise 挂起，但整段阻塞事件循环，影响面更大；新实现至少不阻塞事件循环，且关停路径有既定 settle 预算。边界写入 `src/task-board/lifecycle-host.js` 注释与本文件。

#### 问题 4（记录，低）：任务裁剪的 id 集合仍来自 Node 快照

- 边界：`dropHistoryMessages` 的 id 由 Node 的裁剪快照给出；若在快照与队首执行之间新落盘一条带被删任务 taskId 的消息，它不会被裁剪。`assertTaskIdle` 使正常路径不可达（任务空闲时没有在飞追加）。没有改成“按 taskId 扫整份历史”，因为另一任务共享的消息可能带同一个 taskId（joint evidence），按 taskId 过滤会误删共享证据。边界写在 `src/task-board/lifecycle-host.js` 的 dropIds 注释。

#### 本轮验证与产物

- 最终 Rust 源码指纹 `083495f119383b532340fe20`；`darwin-arm64/multicc_core.node` 18,100,080 字节，SHA-256 `c53f50dfea9f57603727dc52fd6ce7914f31388308d3be52adf3d9f6bdcb2a54`；`probeAddon=true`、`builtFromSource=true`。
- 定向 9 文件套件（最终产物）：157/157（`test-chat-history-routes`、`test-task-lifecycle`、`test-task-history-retention`、`test-chat-history-runtime-differential`、`test-chat-history-differential`、`test-chat-history-ordering`、`test-chat-history-store`、`test-host-lifecycle-task-run-close`、`test-shell-chat-continuity`）。
- `cargo test -p multicc-core -p multicc-addon`：638/638；`cargo test -p multicc-gateway --test gateway`：32/32（首次全 workspace 并行跑时 `a_download_ticket_opens_one_file_for_a_remote_client` 偶发 `Connection reset by peer`，单独复跑 3/3、整套复跑 32/32，记为偶发）。`cargo fmt -p multicc-addon -- --check` 无 diff。
- `npm run test:architecture`：128/128（含 detached ALL PASS）；`npm run test:rust`：256/256。
- 真实 `npm run test:core`（最终产物）：退出码 1；大 node:test 批次 2232/2232、`test:task-shells` 299/299、`test:task-first` 440/441。唯一失败是 main 既有红项 `tests/test-air-paint-budget.js`（`chat-unattended.css` 的 `@keyframes unat-pulse` 使用 `box-shadow`），与本批无关；新加的 3 条 task-lifecycle 用例使 `test:task-first` 由上一轮的 437/438 变为 440/441。命令链是 `&&` 且一路走到 `test:task-first`，说明此前所有阶段均已退出 0。
- 诚实边界：代次只在进程内有效（队列本身也在内存，重启后自然清空），宿主必须对复用 id 调用 `registerSession`（审计范围同上一轮）；问题 2、问题 4 的限制如上；gateway 集成测试有一次与本批无关的偶发连接重置。
- 按协调者要求未跑 `npm test` 整套、`test:cdp` 与会打活服务的 `tests/test-classify-api-errors*`；未提交、未 stash、未重置、未重启服务、未向活服务写。

## Workspace lint gates and the Node-exit premise check (2026-11-11)

This entry records two things: the Rust workspace was brought to a clean lint/format/test state, and the "delete the Node backend" step of the exit plan was checked against the repository and **not executed**. No acceptance criterion in the table at the top changes state.

### CI gate state before the cleanup

`.github/workflows/rust-kernels.yml` runs `cargo fmt --all --check` and `cargo clippy --all-targets -- -D warnings`. Both were already red on main: clippy reported 48 warnings plus one deny-level error (`clippy::unused_io_amount` in a `multicc-cpr` test), and `cargo fmt --check` reported 25 hunks in `native/core/src/unattended.rs` and `native/addon/src/chat_history_runtime.rs`. `cargo build` and `cargo test` over the workspace were green.

### What changed (23 files under `native/`, no JavaScript, no dependency or `Cargo.lock` change)

- `multicc-cpr` test upstream: the stub now reads until the request head is complete (or EOF) instead of one unchecked `read`, so a split request cannot be misread; a `MutexGuard` that crossed an `.await` is scoped before the await.
- Twelve addon structs gained `Default` (delegating to `new()`); no napi signature changed.
- `build_state` (unattended) and `Runtime::remote` (workspace sharing) take parameter structs; every call site was migrated field by field and the JSON written/sent is unchanged.
- Float comparisons keep their NaN behaviour: `quota_guard::should_refresh` spells out `partial_cmp` (a plain `<` would let NaN through); the `positive_integer` range uses `RangeInclusive::contains`, which is the same predicate.
- `chunks_exact(2)` became `as_chunks::<2>().0` (both drop the trailing remainder), `map_or` became `is_none_or`/`is_some_and`, three redundant `return`s and two same-type conversions were removed.
- Nine `#[napi]` functions that clippy called unused are used from JavaScript (`src/session/*`, `src/workspace/runtime.js`, the probe list in `scripts/rust-source-cache.js`); napi registers them only in non-test builds, so they carry `#[cfg_attr(test, allow(dead_code))]` with the reason. Nothing was deleted.
- Eight item-level `#[allow]`s with a reason each: four napi exports whose argument list is the JavaScript call contract (`too_many_arguments`), three functions returning napi error objects (`result_large_err`), and `from_value(self, ..)` (`wrong_self_convention`, renaming touches about 393 call sites). There is no crate-level allow and no lint configuration change.
- `cargo fmt --all` was applied; for the two drifting files the byte stream with whitespace and commas removed is identical before and after.

### Final receipt (one sequential run on the final tree)

- Native source fingerprint `3cf5b9d4e3f12e17f64aefaf`, `darwin-arm64/multicc_core.node` 18,100,032 bytes, SHA-256 `09d17251a9def7a23d251ec567985419d3abfd2e107e916967ebec337f4507a8`; `builtFromSource=true`.
- `cargo fmt --all --check`, `cargo clippy --locked --all-targets -- -D warnings` and the `--workspace` form: exit 0 with zero warnings or errors. `cargo build --locked --workspace`: exit 0. `cargo test --locked --workspace`: 850 passed, 0 failed.
- All `npm` stages on this artifact (core, task-board-auto, cpu-hotpaths, security, state, git, worktree-reclamation, bridges, architecture, governance, provider-router, desktop, standalone, contracts, native): 6968 tests, 6964 passed, 1 failed, 2 skipped, 1 todo. The one failure is the existing `tests/test-air-paint-budget.js` (`chat-unattended.css` animates `box-shadow`); `test:core` ran through to `test:task-first`, so no earlier stage stopped it.
- The cargo and npm runs were sequential on purpose: a concurrent run once starved the timing-sensitive `workspace_sharing::control` test (5 s timeout); it passes serially and on the baseline.

### Node-exit premise check (not executed)

- Remaining Node backend: 132,677 lines under `src/` plus 3,067 in `server.js`. The generated inventories still list Node HTTP registrations: `docs/backend-runtime-inventory.md` (570 captured routes at the time it was generated, 500 table rows after later batches) and `docs/backend-route-inventory.md` (519 static candidates). The two counts use different methods and are not a fresh measurement.
- All four acceptance criteria in the table at the top remain Open; the Node production exit row says the gateway still supervises `server.js` and the Node path can be disabled only after the other three pass.
- Consequences: a Rust-only start command, a Node-free Dockerfile or CI, and Rust integration tests for "the main HTTP endpoints" have no Rust server to run or test; there is no product Dockerfile today (only the task-shell and command-code containers under `docker/`), and 6 of the 9 workflows install or call Node. Deleting `server.js`, `src/` and the Node dependencies would remove the product without a replacement, so it was not done. The README now documents the Rust build/test/lint commands and says so explicitly.
- Next dependency is unchanged: keep moving route domains together with their state owners (6c), then chat orchestration (6d) and the remaining writers (6e), and only then disable the Node path (6f).

No service was restarted and no live service or user data was written during this work.
