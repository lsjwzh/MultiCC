# Terminal provider route migration

The terminal route implementation formerly in `src/providers/terminal-route.js`
is owned by `native/addon/src/provider_terminal_routes.rs`. The original file
is frozen at `tests/helpers/legacy-terminal-route.js` for differential tests;
its SHA-256 is `6b5210a56467ba424607b84e4fc6d8e596afe69695f4c149dab066e6d5b1cfc9`,
matching the pre-migration file in commit `3ce2d27c`.

Rust validates the session-store port, issues route tokens using the OS random
source, persists a newly issued token before encoding, and resolves the live
terminal and its permitted providers for each authorization. The Node host
retains the session objects, persistence and encoding callbacks, and a minimal
adapter in `server.js`: those interfaces still belong to the existing Node
session runtime. The fixed JavaScript property-read and strict-assignment
primitives in the addon preserve live JavaScript receiver, proxy and exception
behavior; they can be removed when session records are owned by Rust.

The focused test run passed 289 tests with both debug and optimized release
addons, including the frozen implementation
comparison, callback reentry, token persistence and revocation, patched
`Object.freeze`, inherited array setters, primitive getters, and execution with
string code generation disabled. Rust formatting and addon-library clippy
passed. A full workspace clippy run stopped on a pre-existing
`suspicious_open_options` warning in `restart-supervisor.rs`; the test-tier
check also reports the existing unclassified
`tests/test-restart-supervisor-isolated.js`. The architecture suite passed 148
of 149 tests; its remaining failure reports existing line-budget violations in
`public/run-config.js` and `src/chat/turn-engine.js`.

The Rust workspace was checked in segments: 2,344 tests passed before the
first run was stopped at a Unix-socket test blocked by the network sandbox;
the affected 17-test target and the six remaining targets (40 tests) passed
separately, as did workspace documentation tests. The `npm test` run is not
green: after supplying the locked SDK oracle, its 2,546-test core batch had
2,412 passes, 131 failures and three skips under the sandbox. The test process
was stopped after a process-management test hung. Many failures came from an
incorrectly staged temporary addon without its companion gateway and from
sandbox restrictions. A corrected staging and Unix-socket policy rechecked
six affected files: 93 of 95 tests passed; the two remaining failures are
existing scheduler ownership assertions in unchanged files. macOS also
refused to execute setuid `/bin/ps` in the sandbox. These runs do not establish
that the complete Node suite passes.

An earlier debug-build benchmark of the actual authorization path measured
median 16.3 µs with the frozen Node lookup and 25.9 µs with the Rust lookup
(five alternating rounds, 10,000 calls per round). A separate release-build
run measured 16.7 µs and 25.4 µs respectively (seven alternating rounds,
10,000 calls per round), while the machine was also compiling tests. This is
an approximately 8.7 µs, or 52%, regression in this microbenchmark; the N-API
boundary and JavaScript compatibility primitives add overhead. It does not
establish production latency or throughput.

The route capture described in `docs/backend-runtime-inventory.md` was not
fully isolated from the real home directory. Its possible side effects and
the discarded child logs are recorded there; do not repeat that startup as an
isolated test without addressing those paths.
