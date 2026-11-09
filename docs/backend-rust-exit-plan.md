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

Selection now lives in `native/core/src/model_default.rs` (addon export
`sessionModelDefault`, probed by `scripts/rust-source-cache.js`); Node keeps a
thin bridge in `src/cli/model-default.js`. `src/cli/session-policy.js` only
resolves the lane facts and passes them in: the provider summary, the lane's
picker list, the last model the CLI reported and the explicit-selection history.

Rule (one implementation, no dual path):

1. An explicit `session.model` and a provider-pinned `provider.model` behave
   exactly as before (provider aliases still resolve through `aliasMap`).
2. Otherwise the model the user selected most often on that lane wins. History
   is the explicit `session.model` values in the persisted session records;
   `claude` and `claude-exp` share one lane, and official provider ids
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

Adapters always pass an explicit model: `claude`/`claude-exp` via
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
