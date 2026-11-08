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

`src/observability.js` keeps only the anchor precheck and delegates the rest.
Rust exports each text rule's necessary anchors (`ROUTE_ANCHORS`,
`TEXT_ANCHORS`) and JS skips the native call for a string without one; a
native call per string made the stream-event scrub about 3.6 times slower. The
object walk behind `redactProviderRouteCapability` now lives in
`native/addon/src/provider_scrub.rs` as one native call per structure, and JS
still proves the common no-op case first: route redaction rewrites each string
on its own, so a structure with no route anchor anywhere cannot change (NaN,
shared and cyclic nodes always take the native walk, because they change by
identity without an anchor). A Rust test checks that every change contains an
anchor. With the prefilter, a typical stream event takes 2.5 µs (2.1 before), a
log record 2.6 µs (3.2), an 8 KB message 0.8 µs (4.4) and an event carrying a
capability 3.7 µs (2.5) on the local release build.

### Exact secrets

`native/core/src/exact_secret.rs` owns the two searches for an attempt's
known capability strings: `redactExactSecretFragments` (a capability spread
over several stored strings; every part that holds a piece gets its own
marker) and `createExactSecretStreamRedactor` (a per-stream transducer that
withholds only a suffix that could still become a secret). Positions are UTF-16
code units; search uses `js::UnitFinder`, a plain scan for short text and a
SIMD byte search (aligned hits only) once a haystack reaches 256 units.
`redact_route_capability` returns early when neither route anchor occurs.

Measured on the local release build: a token-sized stream delta costs 0.34 µs
(0.12 in JS: the native call itself), a 4 KB delta 2.7 µs (3.3), and a
four-part fragment call 1.6 µs (0.45). The fragment call keeps the last
compiled secret list per thread and returns unchanged strings as the caller's
own values.

### Semantic structure scrubbing

`native/addon/src/provider_scrub.rs` owns `scrubProviderSemanticStructure`:
the structured clone, the descriptor collection per provider event type
(`message.content` blocks for assistant/user, `input` for tool_start/update,
`content` for tool_result), the three exact-secret passes, the value
write-back, the key renames and the route-capability walk of the result. One
provider event now costs one native call, and the event object itself comes
back when nothing changed. `src/chat/provider-attempt-runtime.js` keeps the
one-line wrapper and, for event types with no model-controlled parts only, the
route-anchor precheck above; semantic event types always take the native call
because a secret can be split across descriptors, so no per-string anchor
check is a safe precondition.

The addon works on live JS handles rather than the lossless value bridge: the
result must preserve reference identity (unchanged sub-trees, shared nodes and
cycles), which a value copy cannot do. It reproduces `Object.entries` order,
`Array.isArray`, `WeakMap`/`WeakSet` identity, own data properties, strict
assignment, `Object.getOwnPropertyDescriptor` + delete + defineProperty
renames (including `#2` collision suffixes and the key-order change), the
`NaN` "changed" quirk, the fresh `WeakSet` per `collectModelControlled` call
and the `getOwnPropertyDescriptor` skip when an earlier rename already deleted
the key. `__proto__` and `constructor` are defined as own data properties, so
prototypes are never touched; UTF-16 code units keep lone surrogates intact.
Depth is capped at 1000 with a `RangeError` instead of overflowing the stack.
On the local release build, an assistant event without secrets takes 23.3 µs
(15.0 for the old JS walk), a 50 KB tool_result carrying a secret 77.0 µs
(62.0), and a token-sized stream delta 2.4 µs (6.3) because it is a
route-only event and the JS precheck proves the no-op. A semantic event cannot
use a per-string precheck: a capability can be split across descriptors (for
example `pr` / `1.AAAA.BBBB`), so only the native exact-secret matcher can
decide.

Separate redactors with their own rules remain: `scripts/multicc-turn-hook.js`
(runs without the addon), `src/doctor/tools.js` and the event envelope in
`native/core/src/events.rs`. They are not equivalent to these rules and were
not merged.

## The API error policy

`native/core/src/api_error_policy.rs` owns the decision logic that lived in
`src/chat/api-error-policy.js`: the category and code tables (network, timeout,
context, auth, billing, rate, provider-transient, config and tool codes), the
quota-exhaustion and model-entitlement wordings, the SDK-startup and host-stop
labels, the harmless-stderr list, the canonical API-error signature vocabulary
and every regex source, plus `normalizeCode`, `sourceMessage`,
`parseRetryAfter`, `parseReset`, `resetAfterFromText`, `httpStatusOf`,
`retryAfterOf`, the trailing-envelope scanner (`envelopeContentAllowed`,
`findTrailingEnvelopeUnit`, `peelTrailingEnvelopeChain`, `looksLikeJsonDocument`,
`splitTrailingErrorEnvelope`, `detectErrorEnvelope`, `claudeErrorEnvelope`,
`envelopeSourceFor`, `isErrorOnlyText`), `structuredCategory`,
`textFallbackCategory`, `userAction`, the route identity readers,
`normalizeApiError`, `withMaxAttempts`/`maxAttemptsFor`,
`decideApiErrorPolicy`, `metricToken`, `resetWaitLabel` and `retryNotice`.

Three host services stay in JS and travel into Rust as inputs:
`classifyProviderError` (`src/provider-error.js`, already Rust-backed),
`extractUpstreamError` and `normalizeRejection` (`api_error_text.rs`). That is
the `apiErrorPrepare` call: Rust reads `source`, `provider` and the rejection
chain (throwing the same TypeError for a nullish receiver), JS runs the
classifier and extractor, and the results are passed as `deps` to
`apiErrorNormalize` / `apiErrorDecide`. The stateful
`createApiErrorPolicyRuntime` (dedupe map, logging, metrics) stays in JS: it is
host state, not policy.

The policy keeps two host callbacks: `Date.parse` (engine-defined outside the
ISO grammar) and the random source, both called through `js_live`. `-0`, `null`
vs `undefined` and lone surrogates survive the lossless value bridge. The
exported `ERROR_ONLY_PREFIX_RE` and `TRAILING_ERROR_ENVELOPE_RE` are built once
from source strings carried by `apiErrorFacts()`, so the pattern text exists
only in Rust. `normalizeRejection` freezes what it returns, and the Node module
shared one frozen object for a synthesized text-entitlement rejection; the
bridge re-freezes the copied value and swaps in the shared object, with Rust
reporting that case through a flag beside the value. The decision's own `error`
object was frozen in Node as well (`withMaxAttempts` spread), so the bridge
freezes that copy too. An `Error` instance
(`message`/`code` on the prototype) and a `Headers`-like receiver are restored
after the eager read; a receiver whose `get` returns nothing still answers for
itself, because `headerValue` never consults the plain entries once `get`
exists.

`tests/test-api-error-policy-native.js` compares the bridge with the frozen
Node implementation on the 10 recorded fixture samples, 3,000 generated
normalize inputs, 3,000 generated decide inputs, 500 normalized-then-decided
pairs, 1,200 decisions for `retryNotice`, 4,000 envelope/text/header inputs,
exact 400-unit content-cap boundaries, sub-millisecond Retry-After values, CJK
punctuation seams, lone surrogates and a `Headers`-like receiver whose `get`
outranks its own entries; each comparison checks the full value with
`deepStrictEqual`, own-key order and top-level, error and rejection freezing.
Five deliberate faults (the content cap at 399, one billing code renamed,
`network` dropped from the retryable set, a case-sensitive prefix regex, and
floor instead of round for Retry-After) each fail it. A typical
`normalizeApiError` takes 26 µs against 5.1 µs in Node, a decision 30 µs
against 5.3 µs, and a text predicate 0.35 µs; all are called once per failed
request, so the crossings are not on a hot path.

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
and a missing anchor each fail it. The exact-secret searches are compared on
6,000 fragment sets and 4,000 stream traces (push, flush, discard, secret
changes and pending length, with surrogate halves and overlapping secrets);
six seeded faults each fail it.
The semantic scrub and the route object walk are compared with the frozen Node
implementation (`tests/helpers/legacy-provider-semantic-scrub.js`) on fixtures
and on 3,500 seeded events of every provider event type plus 1,500 route
structures: values, own-key order, property descriptor flags and per-node
identity (the event itself and every unchanged sub-tree), with secrets split
over values and keys, adjacent keys that only the keys-only pass joins,
colliding keys, shared and cyclic sub-objects, `__proto__`/`constructor`/
numeric-like keys, Dates, Buffers, NaN and lone surrogates. Five seeded faults
in the Rust code (dropping the keys-only pass, renaming before the value
write-back, a wrong collision start, losing the unchanged-event identity and
skipping the route redaction of keys) each fail it, as does removing the
own-property check that makes a rename skip a key an earlier rename deleted.
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
and the full `npm test` (6,375 tests: 6,372 passed, the same 2 skipped). After
the exact-secret move, source fingerprint `0cbc5a60dd1b5cb02164b44d` passed all
353 Rust core tests and the full `npm test` (6,377 tests: 6,374 passed, the
same 2 skipped). After the API error policy move, source fingerprint
`4043c4f2bda00a6772da43f3` passed all 361 Rust core tests and the full
`npm test` (6,393 tests: 6,390 passed, 0 failed, 2 skipped and 1 todo, both
skips being the unavailable Electron packaging toolchain and PowerShell). After
the semantic-structure move, source fingerprint `94799f44776debfdd178aea7`
passed all 361 Rust core tests and the full `npm test` (6,404 tests: 6,401
passed, 0 failed, the same 2 skipped and 1 todo). These are local isolated
checks, not production enablement or acceptance on every supported
architecture.

The remaining backend is substantial:

| Ownership still in Node | Current examples | Next boundary to transfer |
| --- | --- | --- |
| Attempt records, stream redaction and attempt start/finish/event admission | `src/chat/provider-attempt-runtime.js` | Record ownership (the record object, snapshots, generations and redactors) so the Rust policies stop reading it through the host |
| API error host wiring | `src/chat/api-error-host.js`, `src/provider-error.js`, `src/upstream-error.js` | Provider classification, upstream extraction and the attempt/turn routing around the policy, which now lives in Rust |
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

## Claude lane ownership

The resident Claude lane (`claude-exp` and the per-session `sdk` stream) no
longer runs the JavaScript `@anthropic-ai/claude-agent-sdk` transport. It
spawns the same native `claude` binary and speaks its stdio JSONL protocol
directly. Ownership is split in three:

- `native/core/src/claude_lane.rs` is the pure protocol kernel: argv order and
  flag spelling, the child environment rules (`CLAUDE_CODE_ENTRYPOINT`,
  `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_SDK_READS_SESSION_STATE`, deleting
  `NODE_OPTIONS`), the private `0700`/`0600` settings file and its
  `ANTHROPIC_*`/`CLAUDE_CODE_*` env merge, line framing, message
  classification (`keep_alive` and `transcript_mirror` are swallowed,
  `system/status` and `session_state_changed` pass through), request-id
  correlation/prefixing and the initialize/interrupt/set_model/task control
  line builders. It has no process or runtime dependency, so its 25 unit tests
  run in `cargo test -p multicc-core`.
- `native/addon/src/claude_lane.rs` is the process owner: it writes the
  settings file, spawns the child, pumps stdin, reads and frames stdout,
  keeps a 4,000-character stderr tail, resolves pending control requests by
  `request_id`, gates the first user line on a successful initialize response
  (fail-closed after the initialize timeout), forwards hook callbacks and
  cancels to JavaScript, and supervises exit, signals and `Drop` (SIGKILL).
  It delivers events to JavaScript as `(kind, a, b)` tuples, so the JS side
  parses each message line once. `RustClaudeLane` is registered in
  `probeAddon`, which invalidates cached artifacts that predate the lane.
- `src/chat/claude-sdk-stream.js` keeps only conversation-level state: the
  turn queue, monitor admission (`createMonitorAdmission` answers hook
  callbacks through `respondControl`/`respondControlError`, with a 25 s
  fallback before the CLI's 30 s deadline), background hold and deferral,
  idle recycle, route relay, vault digest and fingerprint restart. Its exported
  API and observable event stream are unchanged; only `status().backend`
  reports `native` instead of `sdk`.

The one-shot `claude-exp` bridge (`src/cli-adapters/claude-agent-sdk-bridge.mjs`)
drives the same native lane, so no Node SDK code runs on a production path. The
`@anthropic-ai/claude-agent-sdk` entry remains in `package.json` solely because
it is the per-platform distribution of the `claude` binary;
`src/cli/claude-bundled-binary.js` resolves that platform package (with a
`MULTICC_CLAUDE_BIN` override), and the `claude-exp` availability check in
`server.js` consults it.

Tests drive a real child process speaking the protocol
(`tests/helpers/fake-claude-lane.js`). `tests/test-claude-lane-differential.js`
runs the frozen SDK as a test-only oracle against the same fake CLI and asserts
identical argv, child environment, stdin JSONL sequence (ids normalized) and
delivered message sequence. `tests/test-claude-sdk-stream-vault.js` and
`tests/test-monitor-admission.js` keep the real binary in the loop through
`tests/helpers/claude-lane-wrapper.js`, an `execve` shim that preserves the PID
so "one resident child" assertions stay meaningful.

This move was verified against source fingerprint `5469e27bae7bf65f102093c3`
(artifact `data/rust-source/5469e27bae7bf65f102093c3/darwin-arm64/multicc_core.node`):
all 386 Rust core tests passed, 25 of them in `claude_lane`; `cargo fmt` and
`cargo clippy` reported no findings for the new modules; the differential test
passed against the frozen SDK oracle; and the full `npm test` command passed
(6,404 tests: 6,401 passed, 0 failed, 2 skipped for the unavailable Electron
packaging toolchain and PowerShell, 1 todo). A mutation pass confirmed the new
tests bite: changing `--include-partial-messages`, misclassifying `keep_alive`,
dropping the hook-callback response, and keeping `NODE_OPTIONS` each failed a
test, and every mutation was reverted. These are local isolated checks, not
production enablement or acceptance on every supported architecture.
