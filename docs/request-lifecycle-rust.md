# Request and chat lifecycle: Rust migration

Each admitted physical inference request owns one watchdog. The Rust
`RequestWatch` owns admission, progress, completion, idle budget and the
inherited/fresh deadline; `RustRequestTimer` owns the asynchronous connection,
idle and absolute timers. Cancellation drops the Rust task. A queued timeout is
also gated by the host after cancellation so a completed connection or response
cannot be retired by a stale callback. Timer callbacks are unreferenced and do
not keep the Node process alive.

The Rust `ModelStreamProgress` owns incremental UTF-8 decoding, SSE framing,
bounded pending input and the decision about which events renew the idle timer.
Rust CPR evaluates those bytes before returning a response chunk to the host,
so its successful stream does not cross back into the parser for a second pass.
Other Node-owned response paths invoke the same Rust parser through the addon.
The current Node adapter still detects HTTP/Undici diagnostic events, supplies
the socket and observation callbacks, and retires the response after the
watchdog fires. It settles the correlated error before
closing the socket. These interfaces remain in Node because the HTTP response
objects and host lifecycle still live there; remove them as that lifecycle moves
to Rust. The clock injection on the watchdog is
retained for deterministic tests; the production path uses Rust timers.

The Rust CPR transport uses reqwest rather than Node's diagnostic channels.
For admitted inference requests it applies that request's connection budget
inside the Rust connector and reports a connection timeout to the same
watchdog before socket teardown. Connection pools are keyed by both proxy and
connection budget, so concurrent sessions with different budgets cannot inherit
one another's timeout. Requests without an admitted budget retain the existing
30-second transport default.

After a successful response's headers arrive, the host transfers the remaining
idle and absolute budgets to the Rust exchange and cancels its own timers. Rust
then renews idle time from decoded model progress and can drop the upstream
response even when the Node event loop or downstream backpressure prevents a
read. The host still converts the timeout to the existing downstream response
and structured outcome. Before successful headers, and during error-body or
credential-repair paths, the existing host watchdog remains the timer owner;
the transfer uses the remaining budget so it does not reset the deadline.

Retries inherit the absolute deadline, but a request re-resolved to a different
provider isolates its budget to the fresh deadline. Progress resets only the
idle timer. A finished request ignores subsequent progress, timeouts and retry
isolation. Connection completion, request body sent, response headers, errors
and response close all cancel the corresponding connection timer.

Each provider attempt also owns a Rust lifecycle object for its replay fence,
carried request deadline, failure count, stalled state and final outcome. A
host-proven error envelope may clear a text-only fence, but never a tool intent
or side effect. A successful request clears its budget without reviving an
already-stalled route. Per-session attempt generations and the identity match
for late events also live in Rust, preserving JavaScript string and conversion
semantics. The host still owns the attempt records, audit/snapshot callbacks and
trusted error-envelope marker; those must move together with the chat runner
before the host adapter can be removed.

The main, background and subagent producer ledgers and their end-before-usage
receipts are also Rust-owned. Overlapping producers become ambiguous, and a
completed unambiguous producer can bind a later matching usage event. Main
receipts retain the original frozen host snapshot and are not subject to the
bounded non-main receipt eviction policy. The current attempt record, callbacks
and streaming redactors still live in the host.

The broader route, chat runner, provider-attempt records and HTTP response lifecycle
are not yet migrated by this change. The gateway must continue to preserve the
per-client upstream connection and PROXY v1 header until ownership of that
transport is transferred.

For chat turns created by the host, Rust now owns the result-durable flag,
result-runner identity and post-turn claim. It also evaluates the post-turn
guards for both these turns and legacy plain-object callers. The adapter keeps
the existing object properties, JavaScript object identity and unusual values
at the host boundary; it preserves the old ordering of writes and getter reads.
A runner's usage-once claim is also owned in Rust after the host confirms the
usage write. Rust reserves that runner while the host writes usage, rejecting
reentrant writes and releasing the reservation on failure for a later retry.
Stream and process finality decisions run in Rust and continue to
distinguish a stream result event from the process clean-exit fallback.
A confirmed final append is tracked separately from the current runner so a
replacement cannot borrow its result or append a second final. If the original
runner never regains ownership, recovery of that confirmed result remains open;
the receipt itself is in memory and does not survive a process restart.
A claim is only an in-process guard, not proof of external delivery. The chat
host still owns runner objects, history appends, usage writes and delivery
callbacks. Remove the adapter when those objects and effects move to Rust.

## Completion, replay and durable-result dependencies

The shared CLI completion tracker now owns its ended/failed/output/error state
in Rust. Native result frames, OpenCode/ZCode steps, Codex, Codex app-server,
DSH, ACP, Command Code, Kimi resume hints and Pi retry boundaries are interpreted
by Rust. A protocol success is still only a candidate until the process or
stream settles. An explicit terminal failure cannot be erased by exit zero;
Pi instead retains its own latest retry boundary until settlement. Proxy-error
reconciliation and the decision to persist completion share these native rules.

The Node completion facade temporarily retains the original evidence object,
callback closures, the decoded-event iterator and the Set of opaque tool IDs.
Those objects preserve Symbol keys, object identity, SameValueZero IDs and
iterator cleanup on exceptions. Native state never holds a strong reference
back into this closure, and no mutable Rust borrow spans a host getter or
callback. Remove this facade when the CLI runner and decoder interfaces move
to Rust together; it contains no fallback copy of the completion policies.

Event-to-replay-fence classification and trusted error-envelope recognition
also run in Rust. The module-private host Symbol remains the authority: an
upstream field or an identically named Symbol cannot grant it. Tool intent and
tool results retain their stronger fences. The native implementation calls the
host array methods, so sparse arrays, mutation during traversal, retained
callbacks and Proxy-wrapped arrays preserve JavaScript behavior. In particular,
N-API's array predicate cannot replace ECMAScript Array.isArray for a Proxy.

Runner ownership checks, kill-reason assignment, result/close durability
transitions, partial-checkpoint decisions and successful-turn error clearing
now execute in Rust against the existing live objects. These functions do not
copy the turn or runner, reorder property reads, or infer persistence from
output. Host writes use strict assignment semantics: a read-only property or a
Proxy setter rejecting a write still throws, and previous writes stay visible.
Actual history appends and delivery callbacks remain in Node until their
storage/effect ownership moves; the native transitions consume their receipts.

The shared live-value bridge handles lazy reads and host calls without
enumerating the event graph. The value bridge creates own data properties for
native object/array output, avoiding inherited setters and treating a
`__proto__` key as data rather than a request to mutate the output prototype.
No performance improvement is claimed for these migrations.

Provider identity validation, positive attempt numbers, optional timeout
budgets, frozen route fields, safe route revision hashes and proxy capability
encoding/decoding now run in Rust as well. The public ProviderAttemptError
constructor stays in the host so callers keep their existing error class and
codes. Alias values remain live until JSON serialization, preserving sorted
alias keys, getters, toJSON hooks and the exclusion of credentials from the
revision. Node retains random-ID generation through its existing injected host
port; it no longer implements these identity policies.

The shared Buffer decoder deliberately matches Node's permissive Base64URL
semantics, including the low byte of UTF-16 code units, ignored invalid bytes,
padding and malformed UTF-8 replacement. Decoded session/token values still
must satisfy the existing length and control-character checks. These rules
are independent of the host's capability ownership check. Rust also enforces
attempt transition priorities: replay fences before running/succeeded state,
unchanged concrete routes for continuation, and increasing attempt numbers.
The host still supplies admission configuration and effect callbacks.

## Proxy authorization and producer orchestration

`native/addon/src/provider_authorization.rs` now owns proxy admission: quota
checks before route checks, terminal capabilities, running/stalled attempts,
resident background admission, main/subagent/auxiliary routes, revision
validation and the order of poison/audit/snapshot effects. The public host
entry point delegates directly to Rust; the old policy exists only in tests.
Allowed results retain the original snapshot identity and remain frozen.

`native/addon/src/provider_producers.rs` also owns request/start/end handling,
overlap ambiguity, background/subagent tracking, cancellation release, stale
producer draining and binding an active producer to an attempt. It operates on
the existing Rust-owned ledgers. A captured producer remains the original
producer when a callback replaces its registry entry, so the old callback
cannot update the replacement through that captured reference. End receipts,
background isolation, partial updates before exceptions and the existing audit
ordering are preserved. This change does not redefine the legacy late-event
or draining policy.

The shared live bridge now has an explicit JavaScript try/catch boundary that
clears pending engine exceptions, including thrown primitives. Only the old
quota/revision catch blocks swallow errors; exceptions outside those blocks
still propagate. No mutable ledger borrow spans a host call, and no native
reference to the callback port is retained after evaluation. Node retains the
private context lookup, configuration normalization, attempt record, snapshots,
poison/finalization and audit effects. Those ports are necessary while their
live objects and effects belong to the host and can be removed when that
ownership moves.

## Usage attribution and proxy outcomes

`native/addon/src/provider_outcome.rs` owns the three decisions that bind a
physical proxy request to an attempt after admission:

- `attributeProxyUsage`: whether a request's token usage is exact (bound to the
  running attempt, or to the attempt whose main producer just ended with the
  same capability and provider) or ambiguous (non-main, resident background
  work after a clean finish, or no provable owner). The derived `uo_*` event id
  is dropped when the session is rewritten, and the late-ignored audit is
  emitted for unowned main usage.
- `observeProxyOutcome`: checks the full reported tuple against the current
  attempt; skips non-inference requests; marks a completed request and the
  diagnostic recovery of an earlier failure; for errors, records every failure
  in the audit log, keeps stronger evidence over a socket teardown, applies the
  watchdog budget (transient 5xx/408/429 do not consume it), normalizes a 429
  rejection, builds the frozen failure record and retires a stalled route.
- `proxyFailure`: returns a copy of the failure unless the runner's completed,
  durable, compatible result supersedes it.

The attempt record is still a host object, so the Rust code performs the same
reads, method calls and strict assignments on it in the original order,
including repeated reads, `now()` calls, key order and freezing; a method is
looked up before its arguments are evaluated. The live bridge gained an object
spread that follows CopyDataProperties (own keys, then descriptor, then get for
enumerable keys), so Proxy traps and symbol keys behave as before.
The error code is sanitized and a 429 rejection normalized by Rust directly
(next section).

## Text redaction and the rejection contract

`native/core/src/redaction.rs` owns the text rules that were spread over
`src/observability.js` and `src/chat/api-error-policy.js`: provider route
capabilities and tokens, bearer tokens, query-string secrets, `key=value`
secrets, the secret field-name test, and `sanitizeMessage`'s collapsing,
credential, id, path and account rules. `native/addon/src/api_error_text.rs`
reproduces how the JS functions took their arguments (`String(value || '')`,
the defaulted fallback, `slice(0, maxLength)` with JS integer conversion) and
`normalizeRejection`'s reads, including the second `window` read, the `resetMs`
rounding and the 80-unit text cap. `native/core/src/quota_rejection.rs`
normalizes a different contract and was not reused.

The JS regexes have no `u` flag, so `native/core/src/js/regex.rs` (shared with
`events.rs`) matches through a UTF-16 unit view and spells out JS's `\s`, `\w`,
`\b` and ASCII-only `/i`; a lone surrogate survives, quantifiers count code
units, and `ſ` or the Kelvin sign do not fold onto ASCII letters.

`src/observability.js` keeps the object walk and collision-safe keys and calls
Rust for text. A native call per string made the stream-event scrub about
3.6 times slower, so Rust also exports each rule's necessary anchors
(`ROUTE_ANCHORS`, `TEXT_ANCHORS`) and JS skips the call for a string without
one. A Rust test checks that every change contains an anchor. With the
prefilter, a typical stream event takes 2.5 µs (2.1 before), a log record
2.6 µs (3.2), an 8 KB message 0.8 µs (4.4) and an event carrying a capability
3.7 µs (2.5) on the local release build.

Separate redactors with their own rules remain: `scripts/multicc-turn-hook.js`
(runs without the addon), `src/doctor/tools.js` and the event envelope in
`native/core/src/events.rs`. They are not equivalent to these rules and were
not merged.

## Verification and remaining ownership

The migration tests keep the previous Node implementations as test-only
oracles. They compare 8,000 completion-policy inputs, 1,200 generic tracker
traces, 12,500 protocol cases, 800 Kimi/Pi traces, 6,000 replay events and 1,400
sets of turn mutations. Identity coverage adds 300 ordered revision inputs,
800 admission transitions and over 10,000 capability decoding comparisons.
Proxy coverage adds 2,880 authorization combinations and 4,000 producer-event
steps, plus invalid capabilities, grace boundaries, exceptional clocks,
callback reentry, receipt identity and propagated/caught host exceptions.
Usage and outcome coverage compares 9,600 generated steps against the frozen
Node functions (`tests/helpers/legacy-provider-outcome.js`) with every property
read, spread trap, host call, ordered result keys, freezing and ledger state,
plus 13 injected exception points, a read-only failure slot and a throwing
audit port. Five deliberate faults in the Rust code (argument evaluation order,
result key order, the 599 status boundary, the durable-result check and one
missing read) each fail the comparison. Redaction coverage
(`tests/test-redaction-native.js`) compares 4,000 generated strings with
adversarial fragments, 600 nested objects, 3,000 messages plus 1,920
value/fallback/length combinations and 5,000 rejections (half through a
tracing Proxy) with the frozen Node code; eight deliberate faults (one
whitespace unit, Unicode `\b`, Unicode case folding, a single `window` read,
naive rounding, the default fallback, the text cap and a capability bound)
and a missing anchor each fail it.
Additional cases cover lone UTF-16 surrogates,
read/short-circuit order, exception identity, strict assignment, reentry,
opaque tool IDs, repeated settlement and host-marker forgery.

The dependency regression command covers CLI completion, chat turn core, chat
host coordinator, provider attempts, the JavaScript value bridge and source
preflight. All 343 Rust core tests, all nine Rust CPR transport tests and all
15 isolated completion scenarios passed against source fingerprint
`96ba545aa6a979862bf4ba2c`. After the usage/outcome move, source fingerprint
`81b4781516bff9412dd7ad73` passed all 93 provider-attempt tests and the full
`npm test` command (6,370 tests: 6,367 passed, 2 skipped because the Electron
packaging toolchain and PowerShell were unavailable). After the redaction move,
source fingerprint `1fe24071b9aacdf623173aa6` passed all 348 Rust core tests
and the full `npm test` (6,375 tests: 6,372 passed, the same 2 skipped). These are local isolated
checks, not production enablement or acceptance on every supported
architecture.

The remaining backend is substantial:

| Ownership still in Node | Current examples | Next boundary to transfer |
| --- | --- | --- |
| Attempt records, stream redaction and attempt start/finish/event admission | `src/chat/provider-attempt-runtime.js` | Record ownership (the record object, snapshots, generations and redactors) so the Rust policies stop reading it through the host |
| API error policy | `src/chat/api-error-policy.js`, `src/chat/api-error-host.js` | Error classification, retry/notice text and envelope detection (rejection normalization and message sanitizing have moved) |
| CLI processes and resident runners | `src/chat/chat-stream.js`, `src/chat/resident-pool.js`, `src/cli-adapters/` | Process/protocol lifecycle, cancellation and recovery; keep SDK-specific ports where needed |
| History, usage writes and delivery effects | `src/chat/host-coordinator.js`, `src/session/chat-history-service.js`, `src/session/adapters/chat-history-file-repository.js` | Actual writes, append/rewrite receipts and restart recovery |
| Requests before successful headers and credential/error recovery | `src/providers/rust-cpr.js`, `src/claude-auth/account-credentials.js` | Transfer remaining lifecycle and credential coordination to Rust transport |
| Other application services and routes | `src/orchestration/runtime.js`, `src/docs-registry.js`, parts of `src/session/` and `src/routes/` | Check each remaining policy and shared state; these directories also contain migrated bridges |

Completion of this dependency batch does not mean Node has been removed. The
next work must continue along these ownership boundaries rather than leaving
duplicate policy implementations in both runtimes. Browser JavaScript,
Flutter clients and necessary test/build tooling are outside the backend
migration scope. No merge, restart or production configuration change is part of
this checkpoint.
