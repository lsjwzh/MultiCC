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

`native/core/src/provider_scrub.rs` owns the shared `scrubProviderSemanticStructure` traversal;
`native/addon/src/provider_scrub.rs` supplies its live JavaScript property adapter:
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

## 2026-11-08 接续检查：原生进程收尾

交接后的实际基线为 `923f7ca3`，其中 Claude 的生产调用已经改用
`RustClaudeLane`，协议规格与前一批测试也已落盘。本次没有重复实施该替换，
而是对新进程所有权做故障验证。新增用例先用旧模块执行，确认以下问题真实存在：

| 场景 | 旧实现的可复现结果 | 本次 Rust 修正 |
| --- | --- | --- |
| 主进程退出后，短命派生进程继续写同一输出管道 | 先报告退出，终局帧未交付 | 统一持有读写任务，先排空两条输出管道，再报告退出 |
| 同一输出块先出现畸形 JSON，再出现成功结果 | 错误后仍交付成功帧 | 原子标记唯一协议失败终态，停止后续帧并终止进程 |
| 初始化无应答，进程忽略软终止信号 | 发送已失败，但子进程仍存活 | 初始化超时进入同一失败终态，强制结束所持有的子进程 |
| 中文错误信息逐字节写入标准错误 | UTF-8 跨块被替换成乱码 | 共享增量 UTF-8 解码器保留不完整字节；SSE 进度解析复用同一实现 |

退出后管道最多排空 1 秒。派生进程一直占着管道时，取消并等待读取任务结束，
报告明确错误，随后才交付退出事件；不会无限等待，也不会在退出之后交付迟到成功。
进程退出时同时关闭写入端口并取消写入任务。初始化完成后，其等待任务立即释放，
不再额外持有车道到固定超时结束。

Windows 分支改为通过所持有的子进程句柄执行终止，并隔离 Unix 专属的退出信号
读取；本机没有 Windows 运行与交叉编译工具链，因此不能把代码修正说成 Windows
实机验收通过。

当前源码指纹为 `598988eff95d7b11b4d284e7`。本轮已有 100 项车道、控制协议、
保险箱、路由、源码预检等组合检查，以及 2 项补充收尾/宿主错误传播测试通过；
Rust core 387 项与 CPR 9 项通过。完整 npm 回归已通过，退出码为 0；
仅 Electron 打包工具链与 PowerShell 缺失导致各跳过 1 项。新增 6 项故障/边界
用例在完整回归中全部通过。

原迁移计划仍未全部完成：原始 JSON 行当前先在 Rust 分帧，再由宿主解析，
后续 `providerScrubSemanticStructure` 仍针对宿主对象工作。因而只能确认移除了
JS SDK 的生产传输实现，不能声称已经消除整条事件链的逐属性跨语言开销。
后续应将精确密钥、能力令牌及跨片段脱敏放到 Rust 原始事件流，并验证每轮路由
与常驻后台任务的归属，之后再去掉对应对象桥接。回合编排、历史写盘和交付恢复
仍由 Node 持有。本轮未提交、合并、重启或修改生产配置。


## 2026-11-08：原始 JSON 脱敏的共享内核（接线前检查点）

本批完成原第 2 步的内核拆分，尚未完成常驻车道的生产接线：

- `native/core/src/provider_scrub.rs` 是结构克隆、字段收集、三轮精确秘密匹配、键冲突处理和路由能力脱敏的唯一实现；现有对象桥也改用该内核。
- `native/core/src/provider_scrub_json.rs` 在 Rust 内解析和遍历原始 wire JSON；新入口 `providerScrubSemanticJson` 只接受原始行和秘密列表。未改用 `JSON.stringify` 搬运现有宿主对象。
- 共享解析器保留 UTF-16 孤立代理字符、重复键和整数键顺序。原始行没有变化时逐字返回；发生字符串修改时，wire 编码保留 `-0` 和溢出指数。现有 `JSON.stringify` 语义没有改变。
- 连续未转义文本按片段解码，避免为长文本中的每个字符重新检查 JSON 语法；非法控制字符及其错误字节位置保持一致。
- 原生预检已登记新入口，并用缺失导出模拟旧模块，避免启动时静默加载旧构建。

现有生产入口仍处理 live JS 对象。这是明确的过渡范围：宿主对象需要保留 getter、Proxy、循环、共享引用、属性写入顺序及非 JSON 值。此适配层只提供属性操作，不复制业务规则。后续原始流接线完成后，Claude wire 事件应退出该对象桥；非 JSON 宿主对象继续使用直接值接口。

剩余接线必须验证每回合凭据更新、常驻后台事件、迟到事件和增量分片，保留 attempt 归属校验，不能凭模型可伪造的“已脱敏”字段跳过检查。当前没有切换生产原始行入口，也没有宣称逐属性跨边界开销已从生产链路消除。

最终构建源码指纹为 `7ab7f73f28ac05e217254cf6`。本批已完成 142 项专项测试、391 项 Rust core 测试和 9 项 CPR 测试；原始 JSON 对拍包含 3,148 个生成事件以及每个 UTF-16 拆分位置、键冲突、数值边界、畸形输入和深度限制。原有 live 对象的 3,500 个事件、1,500 个路由结构对拍继续通过。格式、JS 语法、源码预算及差异检查通过。

本机接口探针包含三组输入：约 300 KB 中文文本、40 个工具调用组成的约 4 KB 结构、40 个含秘密文本块组成的约 2.8 KB 结构。原始行接口在结构化输入上减少了相对 live 对象接口的耗时，但长文本的 JS→Rust 文本往返仍较慢；这不是最终车道的端到端性能验收，也未证明优于同等优化的 Node 实现。后续应在 Rust stdout 原始行拥有者处直接调用核心，避免重新绕经 JS，再做完整的同输入对比。

最终构建上的完整 `npm test` 已通过；Electron 打包工具链和 PowerShell 缺失各跳过 1 项。本批不提交、不合并、不重启服务，也不修改生产配置。

## 2026-11-08：先合并内核，再迁请求入口

上述原始 JSON 内核已按用户指令提交为 `67b074c7`，并由 `694ab85c` 合入 main；
这更新了上一检查点的未提交状态。用户将后续顺序调整为优先请求入口，再分批迁移。
因此 Claude 原始流生产接线继续待办，没有将它标为已完成。

请求入口第一批已把通用准入策略、Cookie 响应头构造及请求 ID 策略交给 Rust，
删除 `src/routes/auth.js` 对应的 Node 决策实现。关闭、对端、服务共享、公开路径、
代理共享、限定范围授权和普通身份验证仍按原顺序执行；Token 和关闭状态按请求读取。
原始 Node 实现只留在 `tests/helpers/legacy-http-entry.js`，作为冻结对拍基准。
正式实现和 Node 例外边界详见 [gateway.md](gateway.md#10-通用请求准入迁移2026-11-08)。

最终原生构建指纹 `c5aaa8d8efa2b56f68904c72`。137 项入口专项、2,096 组准入对拍、
隔离 HTTP／WS 本地性验证、394 项 Rust core、9 项 CPR 单元与 27 项 CPR 集成、
24 项 gateway 单元与 32 项 gateway 集成均通过。原始行脱敏、回合编排、供应商尝试记录、
其他 CLI、历史写盘与交付恢复、会话／工作区编排、HTTP／WS 宿主仍未全部迁移。
下一批优先处理登录和 Cookie／WS 票据运行时，随后按依赖逐组迁路由；当前入口仍借用
Node 宿主状态和响应对象，不代表后端已经摆脱 Node。

入口这批的最终构建完整 `npm test` 已通过，退出码 0；Electron 打包工具链和
PowerShell 缺失各跳过 1 项。格式、语法、源码预算、治理与差异检查通过。
上述入口修改后来与认证运行时一并提交为 `287cbc74`，未合并；上批已合并记录不代表本批也已合并。
没有重启服务或修改生产配置。入口迁移与整体 Node 清理仍未完成。

## 2026-11-08：认证运行时与端点处理接续迁移

在上一批未提交改动上继续迁移，`HEAD...main` 核对为 `0/0`。
Cookie 签发／校验、Token 恒定时间比较、URL 跳转与 WS 路径策略、票据清理／签发／单次消费
已由 Rust 持有。网关和 addon 共享 `native/core/src/auth_security.rs`，
`src/auth-security.js` 从 148 行缩为 31 行兼容导出和引用回收适配。
Node 不再维护 WS 票据 Map；签发与消费仍通过同一实例，未建立第二套状态。

`native/addon/src/auth_routes.rs` 接管登录页面、登录、登出、凭据交换和 WS 票据端点处理。
`src/routes/auth.js` 只保留依赖检查、宿主端口和 Express 挂载，原 Node 算法只留在测试 oracle。
元数据的 Symbol、嵌套引用、浅复制及回调异常／重入顺序保留；通过 VM 可追踪锚点和原生弱引用，
避免反向引用造成 GC 环。认证方法和端点导出进入源码预检，并执行 Cookie／单次票据行为探针。

共享 Cookie 校验同步修复旧网关解析溢出 JSON 数字、UTF-16 低字节 Base64 的兼容差异。
内部构造选项有意收紧：TTL 仅接受有限数值，容量仅接受正整数且不超过 u32 上限；
旧零／负容量的无限清理循环改为构造时拒绝。默认时效、默认容量和外部 HTTP 参数不变。
Cookie 的异常附加字段受共享 JSON 解析器 2000 层上限保护，超深嵌套即拒绝，
这是相对旧 Node 的明确差异；正常签发的平坦 Cookie 不受影响。

本批仍运行在 Node 进程中的 Rust addon；HTTP 响应对象、请求体解析、动态 Token 和关闭状态、
限定范围授权、来源地址计算及 WS 升级宿主仍待迁移。因此这不是“前门独立完成认证请求”的验收，
也没有移除 Express。保留 Node 桥接的原因、范围和删除条件见 [gateway.md 第 11 节](gateway.md#11-登录cookie-与-websocket-票据运行时2026-11-08)。
后续应先统一动态状态／授权协议与 WS 连接所有权，再把认证端点放到 Rust 前门，继续逐组清理路由。
Claude 原始流生产接线仍排在请求入口之后。

最终源码指纹 `e18847e1f4392f048a26a306`，来源校验及启动行为探针通过。
认证专项 12 项、2,096 组入口对拍、96 组端点／故障对拍、30 组完整 HTTP 响应对拍，
以及隔离 HTTP／WS、本机来源识别和源码启动预检均通过。Rust 串行 core 394、CPR 9+27、
gateway 24+32 通过；一次并行供应商存储锁竞争的复验情况已记录在 gateway.md。
`npm test` 各阶段已覆盖：治理计数修正后从治理段续跑，打包环境补齐后从桌面段续跑至
原生测试结束，退出码 0；Electron 工具链与 PowerShell 缺失各跳过 1 项。
上述入口和认证运行时共 30 文件已提交为 `287cbc74`，未合并、未重启服务、未修改生产配置。Express 移除和整体 Node 清理仍是后续工作。


## 2026-11-08：认证 HTTP 端点进入前门

在 `287cbc74` 之后，Rust 前门直接处理登录页面、登录、登出、凭据交换和普通 WS 票据 HTTP
请求。生产模式已取消对应 Express 挂载，隔离测试断言这些请求不会进入 Node HTTP 宿主。
Rust `AuthRuntime` 同时持有动态 Token、关闭状态与唯一 WS 票据表；Node 保留同步调用桥，
网关通过按子进程代次建立的异步私有控制流读取状态和签发票据，删除 `.env` 推测状态。

控制流有双向 HMAC 握手、帧/并发/时限边界、启动后凭据环境清除，以及取消/重启代次隔离。
43 组 HTTP 对拍、共享票据消费及机器授权、轮换、关闭、重启测试已通过。
完整边界和后续验证见 [gateway.md 第 12 节](gateway.md#12-认证端点进入-rust-前门2026-11-08接续工作树)。

剩余依赖仍包括 service/fleet/provider 动态授权、来源地址适配、HTTP/WS 升级与连接宿主、
其他业务路由，以及 Claude 原始流生产接线、回合编排、历史写盘和交付恢复。这些不是本批
完成项；不会将“移入 native 模块”当作“Node 已清空”。本批代码保留工作树，未提交或合并，
未重启服务或修改生产配置。

最终构建为 `193a5212c452993712f2d96d`，来源摘要与启动探针通过；Rust core 396、CPR 9+27、
gateway 27+32 通过。真实隔离服务的前门票据到 WS 快照链路通过。
完整 `npm test` 最终退出码 0，Electron 工具链/PowerShell 各跳过 1 项；格式、语法、预算、
测试分层及 diff 检查通过。本机验证为 macOS ARM64。当前 `HEAD...main=1/0`，未合并。


## 2026-11-08：Service HTTP／WebSocket 宿主迁移

第 6 步继续推进：service 配置和 `/services/*` HTTP/WS 请求由 Rust gateway 完整处理，
对应 Node 模块及 server/voice 接线已删除。配置锁与文件操作在阻塞线程执行，网关持有唯一
service 配置快照；实时登录状态仍通过上一批私有控制流读取 Node addon 内的 Rust owner。
认证身份没有复制成另一张表。生产请求不再经过 Express 的 service handler。

流式传输、取消收尾、升级首段、敏感头与 Cookie/Location 改写、失败落盘和并发更新由独立的
真实网络测试覆盖；冻结 Node oracle 只用于测试对拍。TLS 使用系统证书库及额外 CA 文件，
并强制校验证书。完整边界与最终验证见 [gateway.md 第 13 节](gateway.md#13-service-路由的配置与连接宿主进入-rust2026-11-08)。

剩余工作仍是 fleet/provider 动态授权及生命周期、其它路由和 HTTP/WS 连接宿主、来源地址 JS
兼容接口，随后是 Claude 原始流生产接线、回合编排与历史/交付持久化。该批不代表整体清理完成，
工作树变更未提交、未合并，也没有重启生产服务。

最终构建指纹 `a2b2a7635a7c2ceb1ea549dc`，addon/gateway 来源摘要及启动探针通过。
52 项相关专项通过（含 80 组 service HTTP、1,980 组入口及 96 组端点/故障对拍），
真实隔离 `server.js` 的前门认证与 WS 快照链路通过。Rust 串行 core 399、CPR 9+27、
gateway 27+32 通过；最终 gateway 构建再次通过 27+32 回归。
完整 `npm test` 使用最新产物重跑退出 0；首轮仍引用重建前产物，新增重复头升级用例超时，
统一产物后完整重跑通过。Electron 工具链和 pwsh 缺失各跳过 1 项。
20 个变动 Rust 文件格式检查（保留基线模块顺序）、19 个 JS 语法检查、源码预算、测试分层和
`git diff --check` 通过。累计 48 个工作树文件含上一批未提交改动，`HEAD...main=1/0`，
本批未提交、未合并、未推送，未改变生产配置或重启服务。


## 2026-11-08：Provider 共享授权及来源规则接续

Provider 共享凭据校验、密封副本、计数/撤销和文件备份恢复已由 Rust core 接管。
HTTP 入口按 Rust 返回的等待点暂停，原生 worker 完成授权写盘后才继续；写盘失败不以
成功授权放行。Node 路由已适配异步接口，仍属于待删除的宿主桥接。
来源地址兼容接口与 Axum 共用 Rust 规则，删除 Node 的重复判定。

数据互读、失败写入、并发撤销与网络接线证据以及兼容边界见
[gateway.md 第 14 节](gateway.md#14-provider-共享授权与来源地址统一到-rust2026-11-08)。
总体目标与 6a–6f 验收台账见 [后端退出计划](backend-rust-exit-plan.md)。原计划前 5 步已落地，
第 6 步仍进行中；Express 接口、聊天编排、持久化和 Node 生产退出四项总验收仍未全部满足。
工作区分享动态授权（旧 `fleet` 协议名）、其余 HTTP/WS 宿主、聊天原始流接线/编排、历史/交付持久化继续由本任务推进。

## 2026-11-08：工作区分享状态接续

工作区分享的记录、scrypt/授权校验、访问计数、撤销、外部引用和原格式 JSON 写入已由
Rust 单一 owner 接管，Node 对应实现已删除。实时成员关系仍从宿主端口取得，授权时不缓存。
密码校验与异步写入之间的一次性内部凭证会在写入前重新检查撤销和额度，最终输出前重新
读取成员关系。60 项专项（含 1,233 组权限及 360 组数据对拍）与 404 项 Rust core 测试通过。
完整 `npm test` 退出 0（Electron/pwsh 缺失各跳过 1 项），CPR/gateway 回归及真实网关工作区 HTTP/WS 分享、重放/撤销校验通过。
边界、部署/回滚要求与最终验证收据见 [网关文档第 15 节](gateway.md#15-工作区分享状态和持久化迁入-rust2026-11-08)。

原计划第 6 步继续：此域的远端传输、Express 路由/限流和实时目录/会话状态源尚在 Node；
其余 HTTP/WS 宿主、聊天编排和历史持久化也仍待迁移。四项总目标验收均未宣布完成。

## 2026-11-08：工作区分享远端传输接续

远端 DNS、HTTP/HTTPS、请求/响应策略和错误映射进入 Rust；Node fetch/DNS 实现已删除。
真实上传流经有背压的 N-API 字节管道接入 Rust，响应体有解压后大小限制和全程截止时间。
Node 暂留 Express 流转接与实时上下文端口，移除条件是相关路由/状态宿主迁入 Axum。
详细兼容差异和验证收据见 [网关文档第 16 节](gateway.md#16-工作区分享远端传输迁入-rust2026-11-08)。

原计划完成 5/6，第 6 步继续；密码限流、其余 HTTP/WS 宿主、聊天编排与历史持久化仍待迁移。
本批未提交、合并、推送或重启生产服务。

本批最终源码指纹 `dab9493f8e0f81f548af5b03`，来源与接口预检一致。72 项专项、404 项
Rust core、CPR 9+27、gateway 27+32、真实网关分享/WS 接线及最终完整 `npm test` 通过；
Electron/pwsh 缺失各跳过 1 项。中断测试遗留的假浏览器进程已按测试身份清理，失败的两项
独立复验后从头完成 npm 回归。证据和明确行为差异均记录于第 16 节。


## Imported workspace HTTP and upload ownership

The Rust gateway now owns the complete `/api/external-fleets` route family and
`external-fleets.json`. The source-sharing addon opens only `fleet-shares.json`.
The store rejects operations outside its ownership domain. Imported state is
published after atomic save, and survives replacement of the supervised Node
child without introducing a second writer. External orchestration runs in the
shared Rust runtime; blocking file operations run on workers.

Non-JSON request bytes stream from Axum to reqwest with transport backpressure.
The Node upload pump and native upload channel have been removed. This deliberately
fixes the old non-JSON body selection; JSON still follows the 50 MiB parsed-body
contract and is reauthorized after buffering. Whole-request deadlines, upstream
response limits and no-replay rules remain in force. Disconnect during an upload
closes its upstream request. HTTP response bytes, error presentation, cache
projections and ETags are covered by the frozen Express oracle.

Source workspace routes, failure limiting, live member lookup and the source WS
host remain Node dependencies. The native external buffered library adapter is
used only by tests, not as a production fallback. See gateway.md section 17 for
compatibility boundaries, deployment/rollback and the final batch receipt.


## Source workspace password admission

Source password failure windows and FIFO admission now live in
`workspace_sharing/access.rs`. Reservations are ordered before async scheduling;
waiting does not occupy password workers. The same 10-failure, 15-minute rule,
strict expiry boundary, success reset and wrong-password-only accounting remain.
Dropping or explicitly releasing a reservation advances the queue exactly once.
Pending cancellation cannot release an active predecessor, and stale completion
cannot modify a successor's window.

The Node route no longer stores failure records or an access promise tail. Its
remaining adapter marshals the request and result around the live source port,
and releases the native reservation in finally. Source HTTP/WS hosting and live
directory/session ownership remain open dependencies. Windows remain in memory
with the same mounted-instance lifetime, not a new disk-backed policy. See
gateway.md section 18 for compatibility and validation evidence.

## Source share administration HTTP

The gateway directly handles source share listing (GET/HEAD), revocation (DELETE)
and their OPTIONS responses. Their Node HTTP handlers and mounts are removed.
A separate authenticated Rust stream addresses the existing source Store Arc in
the addon; it does not call JS, use Express objects, or reopen the share file.
Revocation publishes only after persistence and immediately affects remaining
HTTP/WS consumers of the same grant owner. Blocking writes cannot monopolize the
independent authentication/ticket connection.

Bulk list replies use bounded frames and an explicit terminator without imposing
a new list-size cap. Aggregate memory still scales with the list. Cancellation,
truncation and timeout discard the connection; mutations are never replayed.
An interrupted request may have committed and must be resolved by reading state.
Slow JSON requests recheck rotation/shutdown before dispatching a mutation.
Protocol 7 pairs the gateway, addon and host; the disk schema stays unchanged.
See gateway.md section 19 for limits, deployment/rollback and validation.

Creation, password import, state projection, shared WS tickets and the WS/socket
host still depend on fresh directory/session context in Node. The source owner
has not moved processes, and this batch does not complete source hosting or Node
exit. The only new JS adapter forwards bootstrap parameters once and retains no
request-processing policy or duplicate state.

Final administration receipt: `3803e14e0af6f74f69e9e5b5`; provenance and protocol-7
startup probes pass. The 62 focused tests, 40 source HTTP comparisons, bulk/gzip,
persistence failure, same-owner revocation, slow-body rotation, child/gateway
restart and real LAN/source WS integrations pass. Rust core 408, CPR 9 + 27,
gateway 30 + 32 and the full npm suite pass; Electron packaging and pwsh each
have one unavailable-tool skip. Overall migration remains 5/6.

## Source share creation HTTP

POST source-share creation and its OPTIONS response now terminate at the Rust
gateway. The Node handler/mount is deleted. The source control task reads current
directory existence through one asynchronous host port, then reuses the single
Rust Store for validation, scrypt and persistence. The port has no duplicate map
or creation policy and never receives Express objects. Missing directories keep
their 404 precedence; a failed/released port yields a sanitized internal error.
A timed-out lookup never initiates a later mutation.

The callback is built in a separate lexical scope and holds only a WeakRef to the
host reader; native callbacks cannot retain facade/owner cycles or keep the Node
event loop alive. Protocol 8 frames source requests as well as replies, preserving
large JSON bodies. Existing lossless wire encoding retains overflow numbers and
UTF-16 values; credentials/options are never logged. Auth uses a separate stream.

Directory/member lifecycle ownership and remaining source import/state/ticket/WS
hosts remain open dependencies. This is not a new directory-deletion transaction
or completed Node exit. See gateway.md section 20 for boundaries and verification.

Final creation receipt: `e9524d0928824811ad2a71e6`; addon/gateway provenance and
protocol-8 startup probes pass. All 64 focused tests pass, including 48 new HTTP
comparisons that bypass Express, live-directory changes, sanitized host failures,
large inputs, concurrent mutations, failed persistence and callback collection.
Native timeout coverage confirms no delayed creation after a failed host read.
Real gateway/server sharing HTTP/WS and LAN checks pass. Rust core 409, CPR
9 + 27, gateway 30 + 32 and full npm test pass, with 256/256 in the final group.
Electron packaging and pwsh each skip one unavailable-tool test. Static checks
pass. Overall progress remains 5/6, with no commit, merge or production change.

## Source state HTTP

The gateway now handles GET/HEAD source state and OPTIONS, with the Node handler
and mount removed. Entry scope checks use the same Rust Store and retain method,
path and capability precedence. After fresh directory/member context is read,
the owner rechecks grant validity and expiry before projecting the public DTO.
A revoke during the asynchronous read cannot release a stale authorized reply.

One synchronous host callback reads existing live maps and marshals their JSON;
it has no cached authority or HTTP objects. Weak ports preserve owner collection.
Malformed/failed host context is sanitized, and unavailable or timed-out control
streams fail closed. Protocol 9 pairs the gateway, addon and host, with schema 1
unchanged. Member ownership and import/ticket/landing/WS hosting remain open;
readSharedFleet is still used by the unmigrated import/library path. See gateway.md
section 21 for the contract boundaries and final validation receipt.

Final state receipt: `ef1796e0d7ee0483a8656b8f`; matching addon/gateway provenance
and protocol-9 startup probes pass. All 54 focused tests and 55 new state HTTP
comparisons pass, including bootstrap cookies, scope precedence, field order,
conditional requests, large member lists, live context changes and sanitized
failures. Native tests cover revoke during context reads and failed/timed-out
ports. Real gateway/server and LAN sharing HTTP/WS checks pass. Rust core 410,
CPR 9 + 27, gateway 30 + 32 and full npm test on the final artifacts pass, with
256/256 in the last group. Electron packaging and pwsh each skip one unavailable
tool test. Static checks pass. Overall migration remains 5/6; no commit, merge,
push, production restart or configuration change.

## Native source password import

The gateway owns POST source import and OPTIONS; the Express import handler and
mount are deleted. Verification, access consumption and state projection now run
as one Rust workflow. An owner-bound, non-Clone VerifiedAccess value is consumed
by value, replacing the nonce table and repeated JS/JSON proof round trips. The
old access N-API classes, JS admission adapter and readSharedFleet are removed.
The library adapter calls this workflow once; production HTTP calls it directly.

Directory existence is read before the durable access write; fresh members are
read afterwards. A pre-write failure consumes nothing; a post-write context
failure retains the committed access. The native failure window survives control
reconnects, resets with the owner, and releases reservations on cancellation.
Lost replies never trigger a replay. Import inherits the source channel's 64
concurrent admission bound and three-second connection/RPC deadlines; a timeout
can be ambiguous after a write. Protocol 10 requires matching gateway/addon/host,
with unchanged disk schema. The two weak live-context readers remain because
Node still owns directory/member lifecycle. Delete them and their JSON boundary
when that owner moves. See gateway.md section 22 for validation and rollback.

Final import receipt: `8b71c948abd41a3042575b4a`; addon/gateway provenance and
protocol-10 startup probes pass. All 53 focused tests, 71 new import HTTP
comparisons and real gateway/server/LAN sharing HTTP/WS checks pass. Native
coverage verifies failure ordering, cancellation, revoke during context reads,
window retention across reconnects and no replay after a lost response. Rust
core 413, CPR 9 + 27 and gateway 30 + 32 pass. Full npm test exits 0 on the final
artifacts, ending with 256/256; Electron packaging and pwsh each skip one test
for unavailable tools. Static checks pass. Overall progress remains 5/6, with
no commit, merge, push, production restart or configuration change.


## Native source WebSocket ticket issuance

The gateway now owns shared ticket POST/OPTIONS. The Express handler, mount,
error wrapper, requestOrigin and JS authorizeWebSocket method are deleted.
The native source workflow uses an Arc to the existing AuthRuntime; it builds
native metadata and inserts into the same single-use ticket table consumed by
the current WS host. No JS callback or JSON round trip is involved in issuance.

A short source snapshot read lock covers final authorization and synchronous
ticket insertion. Publication of revocation cannot interleave; the fixed lock
order is source snapshot then auth runtime, without host calls or awaits inside.
Authentication revision/shutdown changes refuse issuance. Live membership still
comes from the Node owner, using the existing weak read port with an ID-only
projection. This avoids traversing private/cyclic fields and keeps the original
unbounded membership and directory-existence semantics. This port and the WS
consume adapter must be removed when their state and connection owners move.

Protocol 11 requires the matching gateway/addon/host; disk schema is unchanged.
The three-second source RPC deadline can expire after insertion. Lost replies
are never replayed. Previously issued tickets keep the existing TTL/revocation
semantics; no new retroactive revocation contract is implied. See gateway.md
section 23 for scope, compatibility checks and the final verification receipt.
Final receipt: fingerprint `ecf3d68274e8dd96589b9dfa`, verified addon/gateway
provenance and protocol-11 startup probes. All 72 focused tests pass; the final
32 sharing tests pass after the ID-only projection/adapter cleanup, including
cyclic/private fields and shared auth callback collection. The 73 new ticket
HTTP comparisons bypass Express. Native tests cover revocation publication,
rotation/shutdown, failed/timed-out reads, unbounded members and UTF-16 metadata.
Real gateway/server and LAN sharing checks pass. Rust core 417, CPR 9 + 27 and
gateway 30 + 32 pass. Full npm test exits 0, ending at 256/256; Electron packaging
and pwsh each skip one unavailable-tool test. Syntax (43 JS), formatting (41 Rust,
existing module order preserved), 837 test tiers, budgets and diff checks pass.
Overall migration remains 5/6; no commit, merge, push or production change.


## Native source landing delivery (2026-11-09)

GET/HEAD/OPTIONS for /fleet-share/:token now terminate in the gateway. The entire
production src/routes/fleet-sharing.js module is deleted; server.js directly
wires the existing source owner and live read ports. The landing page uses the
canonical package public directory and the shared asynchronous 64 KiB file
sender, with no source-state read or added file cache. Public-route admission,
query-token cookie ordering, parameter/JSON errors, shutdown, conditionals,
ranges and file replacement preserve the legacy contract.

Shared file responses now preserve error code/message order, omit an injected
Content-Length on conditional HEAD 304, and restrict API JSON Vary headers to
API paths. Directory targets use the common 404. Node remains necessary for
live directory/member ownership, scoped authorization adaptation and WS hosting.
Move state, projection and subscription owners before the connection host; then
remove the read ports/serialization and relocate the addon owners. Protocol 12
requires matching gateway/addon/host deployment and rollback; schema remains 1.

Fingerprint fe62afc2e9d46e3521648717 has verified provenance and startup probes.
All 122 landing HTTP comparisons, 12 filesystem comparisons, 12 MiB hash/range
and disconnect checks pass. Real gateway/server and LAN checks pass (2/2).
Rust core 417, CPR 9 + 27 and gateway 30 + 32 pass. See gateway.md section 24 for
boundaries and the final full-suite receipt. Overall progress remains 5/6; no
commit, merge, push, production restart or configuration change.

Final full-suite receipt: npm test exits 0 on the final artifacts, ending with
256/256 native tests. Electron packaging and pwsh each skip one unavailable-tool
test. Syntax (42 JS), formatting (41 Rust, existing module order preserved),
837 test tiers, source budgets, governance and diff checks pass. HEAD remains
1 ahead and 0 behind main, with 86 uncommitted worktree entries including prior
batches. This landing batch is verified; overall Node exit remains open at 5/6.


## Native workspace queue state (2026-11-09)

The next WS prerequisite is one native owner for workspace queue records and
view timestamps. The Node queue Map, normalization, stale-update gate and view
clock are deleted. Physical execution clocks remain distinct from the monotonic
view clock, so selecting an older or empty execution clears the previous view
without rejecting subsequent valid execution updates. The classify-state table
is shared with the existing native vocabulary.

Queue/Store values pass directly inside Rust; projections no longer materialize
a JS queue merely to normalize it again. The temporary addon reads only relevant
fields, preserves coercion/getter order, and invokes all host callbacks outside
the lock. Reentrant updates are checked against the latest committed record.
Opaque stateSource metadata is attached without traversal or JSON conversion.
The Node compatibility view is read-only; there is no duplicate mutable table.
Each runtime owns its own queue and rehydrates from the existing scheduler.

Live records/membership, record eligibility, selected execution reads, status,
summary persistence, event routing and WS/subscriber effects remain Node-owned.
These are the remaining dependencies for removing the addon and hosting the
Store directly in the gateway. Protocol 12 and schema 1 remain unchanged; the
source/build probe checks the new addon capability without a JS fallback.

Fingerprint eb571715c533c41ad3c154ec has verified provenance/startup probes.
The 106 focused tests include 1000 lifecycle comparisons, 94 input comparisons
and real WS frame/reconnect/cleanup comparisons. Real gateway/server and LAN
checks pass (2/2). See gateway.md section 25 for the final full-suite receipt.
Overall remains 5/6; no commit, merge, push, production restart or configuration
change was performed.

Final receipt: Rust core 421, CPR 9 + 27 and gateway 30 + 32 pass. Full npm test
exits 0 on the final artifacts, ending with 256/256. Electron packaging and pwsh
each skip one unavailable-tool test; the existing duplicate-bubble S6 case
remains TODO, not a passing case. Syntax (45 JS), formatting (44 Rust), 837 test
tiers, source budgets, governance and diff checks pass. HEAD is 1 ahead and 0
behind main, with 92 uncommitted worktree entries including prior batches.
Validation is on macOS ARM64; other platform packages are not certified here.
The queue batch is verified; overall progress remains 5/6.


## Native workspace run state and summary ownership (2026-11-09)

The workspace status and summary tables and session run transitions now have a
single native owner. Node's Maps, hydration, transition implementation and
summary write orchestration are removed. Rust passes RunState/Status/Summary
values directly; no mirror state or internal JSON round trip is introduced.
The classify catalog exposes an in-memory value for native hydration.

The native adapter preserves getter/coercion order, run segments, pending-work
background status and the established commit boundaries. Summary effects remain
ordered as memory view, record.summary, setTaskState, saveBestEffort and delivery.
Later failures do not roll back earlier writes. No owner borrow crosses a host
callback. Shared opaque host-value storage retains payload identity without
traversing private fields, cycles or toJSON; JS-traced anchors and weak native
references allow replacement and runtime/payload cycles to be collected.
Status/summary wrapper reads are snapshots, not an alternate mutation surface.

The shared iterable adapter preserves record-loop cleanup and entry destructuring,
including early completion and next/return failures. The original exception wins
when cleanup also fails. The frozen differential baseline is independent of the
new transition implementation, and real WS comparisons check raw JSON frames.

Live records, directory/member state, setTaskState/saveBestEffort writers, cursor
selection, event routing and WS/observer delivery remain Node dependencies.
Continue with those state and persistence owners before subscriptions and sockets;
then remove temporary N-API/host-reference ports in favor of colocated native
owners. This batch does not complete task persistence, WS or the overall Node exit.
Protocol 12 and schema 1 are unchanged. Overall remains 5/6.

Fingerprint 75e0aa45fc7e721b840389df has verified provenance and startup probes.
All 116 focused tests pass, including 893 transition cases, 1200 status/summary
operations, existing queue comparisons and GC/WS tests. See gateway.md section 26
for the full regression receipt.

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
